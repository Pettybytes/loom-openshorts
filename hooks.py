import os
import re
import textwrap
import subprocess
import urllib.request
import uuid
from PIL import Image, ImageDraw, ImageFont, ImageFilter

from ffmpeg_utils import video_encode_args, QUALITY, METADATA_SCRUB


def _truncate_bytes(text, max_bytes):
    """Trim to a byte budget without splitting a multi-byte character.

    Deliberately duplicated from main.truncate_bytes: this module stays free of
    main's heavy imports (cv2, mediapipe, torch) so it can be used standalone.
    """
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    return encoded[:max_bytes].decode("utf-8", "ignore")

FONT_URL = "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSerif/NotoSerif-Bold.ttf"
FONT_DIR = "fonts"
FONT_PATH = os.path.join(FONT_DIR, "NotoSerif-Bold.ttf")

# Codepoint ranges NotoSerif has no glyphs for (would render as tofu boxes).
_EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FAFF"  # emoticons, symbols, transport, supplemental
    "\U00002600-\U000027BF"  # misc symbols + dingbats
    "\U0001F1E6-\U0001F1FF"  # regional indicators (flags)
    "\U00002B00-\U00002BFF"  # arrows, stars
    "\U0000FE0E\U0000FE0F"   # variation selectors
    "\U0000200D"             # zero-width joiner
    "\U000020E3"             # combining keycap
    "]+"
)

# Emoji-capable fonts, probed at runtime (Windows, WSL, Linux/Docker, macOS).
_EMOJI_FONT_CANDIDATES = [
    "C:\\Windows\\Fonts\\seguiemj.ttf",
    "/mnt/c/Windows/Fonts/seguiemj.ttf",
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",
    "/usr/share/fonts/noto-emoji/NotoColorEmoji.ttf",
    "/System/Library/Fonts/Apple Color Emoji.ttc",
]


# Bitmap strike sizes color-emoji fonts ship with. NotoColorEmoji (the font
# the Docker image installs) ONLY loads at its strike size — asking for an
# arbitrary size raises "invalid pixel size" — so glyphs are rendered at the
# native size and rescaled at draw time.
_EMOJI_BITMAP_SIZES = [109, 128, 136, 160, 96, 72, 64, 32]


def _load_emoji_font(font_size):
    """Return (font, native_size) for an emoji-capable font, or None.

    native_size == font_size for scalable fonts (Segoe UI Emoji); for
    fixed-bitmap fonts (NotoColorEmoji) it is the strike size the font
    actually loaded at, and the renderer scales glyphs down from it."""
    for path in _EMOJI_FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        try:
            return ImageFont.truetype(path, font_size), font_size
        except Exception:
            pass
        for native in _EMOJI_BITMAP_SIZES:
            try:
                return ImageFont.truetype(path, native), native
            except Exception:
                continue
    return None


def _split_emoji_runs(text):
    """Split text into (is_emoji, chunk) runs."""
    runs = []
    pos = 0
    for m in _EMOJI_RE.finditer(text):
        if m.start() > pos:
            runs.append((False, text[pos:m.start()]))
        runs.append((True, m.group()))
        pos = m.end()
    if pos < len(text):
        runs.append((False, text[pos:]))
    return runs


def _emoji_scale(font, emoji_font):
    """Draw-time scale factor from the emoji font's native size to the text
    size. 1.0 for scalable emoji fonts; < 1 for fixed-bitmap strikes."""
    efont, native = emoji_font
    target = getattr(font, "size", native)
    return target / float(native) if native else 1.0


def _measure_width(draw, text, font, emoji_font):
    """Pixel width of a line, measuring emoji runs with the emoji font.

    emoji_font is the (font, native_size) pair from _load_emoji_font, or None."""
    width = 0.0
    for is_emoji, chunk in _split_emoji_runs(text):
        if is_emoji and emoji_font:
            width += (draw.textlength(chunk, font=emoji_font[0])
                      * _emoji_scale(font, emoji_font))
        else:
            width += draw.textlength(chunk, font=font)
    return width


def _render_emoji_chunk(chunk, emoji_font, scale, fill):
    """Rasterize an emoji run at the font's native size, scaled to the text
    size. Returns an RGBA image ready to alpha-composite, or None."""
    efont, native = emoji_font
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    w = int(probe.textlength(chunk, font=efont))
    if w <= 0:
        return None
    # Emoji glyphs can overshoot the em box slightly; 1.3x covers it.
    tmp = Image.new('RGBA', (w, int(native * 1.3)), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    try:
        d.text((0, 0), chunk, font=efont, embedded_color=True)
    except TypeError:
        d.text((0, 0), chunk, font=efont, fill=fill)
    if scale == 1.0:
        return tmp
    return tmp.resize((max(int(w * scale), 1), max(int(tmp.height * scale), 1)),
                      Image.LANCZOS)


def _draw_mixed(img, draw, xy, text, font, emoji_font, fill, outline=None):
    """Draw a line onto img, rendering emoji runs with the emoji font (in
    color if supported, rescaled when the font is a fixed-size bitmap).
    outline: optional (color, px) stroke drawn under the text."""
    x, y = xy
    stroke_w = outline[1] if outline else 0
    stroke_fill = outline[0] if outline else None
    for is_emoji, chunk in _split_emoji_runs(text):
        if is_emoji and emoji_font:
            scale = _emoji_scale(font, emoji_font)
            rendered = _render_emoji_chunk(chunk, emoji_font, scale, fill)
            if rendered is not None:
                img.alpha_composite(rendered, (int(x), int(y)))
                x += draw.textlength(chunk, font=emoji_font[0]) * scale
        else:
            if stroke_w:
                draw.text((x, y), chunk, font=font, fill=fill,
                          stroke_width=stroke_w, stroke_fill=stroke_fill)
            else:
                draw.text((x, y), chunk, font=font, fill=fill)
            x += draw.textlength(chunk, font=font)


def _break_long_word(draw, word, font, emoji_font, max_width):
    """Character-level hard wrap for a single word wider than max_width."""
    pieces = []
    current = ""
    for ch in word:
        if current and _measure_width(draw, current + ch, font, emoji_font) > max_width:
            pieces.append(current)
            current = ch
        else:
            current += ch
    if current:
        pieces.append(current)
    return pieces

def download_font_if_needed():
    """Downloads a serif font for the hook text if not present."""
    if not os.path.exists(FONT_DIR):
        os.makedirs(FONT_DIR)
    if not os.path.exists(FONT_PATH):
        print(f"⬇️ Downloading font from {FONT_URL}...")
        try:
            # Add user agent to avoid 403s slightly
            req = urllib.request.Request(
                FONT_URL, 
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with urllib.request.urlopen(req) as response, open(FONT_PATH, 'wb') as out_file:
                out_file.write(response.read())
            print("✅ Font downloaded.")
        except Exception as e:
            print(f"❌ Failed to download font: {e}")

# Hook visual styles. Each maps to box fill (RGBA, alpha 0 = no box), text
# color, and an optional text outline (color, px) for box-less looks.
HOOK_STYLES = {
    # White card, black serif text (original look).
    "classic": {"box": (255, 255, 255, 240), "text": (0, 0, 0), "outline": None, "shadow": True},
    # Dark card, white text.
    "dark":    {"box": (18, 18, 20, 235),    "text": (255, 255, 255), "outline": None, "shadow": True},
    # Bright yellow card, black text (high-contrast TikTok look).
    "yellow":  {"box": (255, 214, 0, 245),   "text": (0, 0, 0), "outline": None, "shadow": True},
    # Red "breaking" card, white text.
    "red":     {"box": (220, 38, 38, 245),   "text": (255, 255, 255), "outline": None, "shadow": True},
    # No box: white text with a thick black outline (caption/MrBeast style).
    "outline": {"box": (0, 0, 0, 0),         "text": (255, 255, 255), "outline": ((0, 0, 0), 8), "shadow": False},
    # No box: yellow text with black outline.
    "outline_yellow": {"box": (0, 0, 0, 0),  "text": (255, 214, 0),   "outline": ((0, 0, 0), 8), "shadow": False},
}


# --- Range styling (selective rich text) ------------------------------------
#
# A hook may carry per-range styling. `spans` are half-open [start, end)
# character ranges over the hook text, applied in array order so a LATER span
# wins on overlap — the identical rule to the editor's hookRichText.js. This is
# the server half of the preview/render parity contract: what the editor
# preview showed is what the burned frame shows.

_SIZE_SCALE = {"S": 0.8, "M": 1.0, "L": 1.3}
_STYLE_PROPERTIES = ("color", "font", "size")


def _size_multiplier(value):
    """Span size -> multiplier of the element's base font size.

    The editor sends a NUMBER (a range size is a multiplier, so the Header's px
    targets and the Hook's S/M/L vocabulary both survive). The legacy S/M/L
    tokens are still accepted so spans persisted by the earlier release keep
    working. Anything unusable falls back to 1.0 — a bad value can never resize
    text, and it can never silently no-op a real size either.
    """
    if value is None or value == "":
        return 1.0
    if isinstance(value, str):
        token = _SIZE_SCALE.get(value.upper())
        if token is not None:
            return token
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 1.0
    if not (n > 0):
        return 1.0
    return min(10.0, max(0.1, n))

# Font files probed per family. The shipped Noto Serif Bold is the documented
# fallback, and callers can learn which family was ACTUALLY used rather than
# silently pretending the requested one was honoured.
_FONT_FAMILY_CANDIDATES = {
    "Verdana": [
        "/System/Library/Fonts/Supplemental/Verdana.ttf",
        "/Library/Fonts/Verdana.ttf",
        "/mnt/c/Windows/Fonts/verdana.ttf",
        "C:\\Windows\\Fonts\\verdana.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/Verdana.ttf",
    ],
    "Arial": [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/mnt/c/Windows/Fonts/arial.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/Arial.ttf",
    ],
    "Helvetica": [
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/msttcorefonts/Helvetica.ttf",
    ],
    "Impact": [
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/Library/Fonts/Impact.ttf",
        "/mnt/c/Windows/Fonts/impact.ttf",
        "C:\\Windows\\Fonts\\impact.ttf",
    ],
    "Georgia": [
        "/System/Library/Fonts/Supplemental/Georgia.ttf",
        "/Library/Fonts/Georgia.ttf",
        "/mnt/c/Windows/Fonts/georgia.ttf",
        "C:\\Windows\\Fonts\\georgia.ttf",
    ],
    "Courier New": [
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/Library/Fonts/Courier New.ttf",
        "/mnt/c/Windows/Fonts/cour.ttf",
        "C:\\Windows\\Fonts\\cour.ttf",
    ],
}


def hex_to_rgb(value):
    """'#RRGGBB' or '#RGB' -> (r, g, b); None for anything unusable."""
    if not value or not isinstance(value, str):
        return None
    v = value.strip().lstrip('#')
    if len(v) == 3:
        v = ''.join(ch * 2 for ch in v)
    if len(v) != 6:
        return None
    try:
        return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


def normalize_span(span, text_length):
    """Clamp one span to the text. None when it cannot style anything."""
    if not isinstance(span, dict):
        return None
    try:
        start = max(0, min(text_length, int(span.get("start"))))
        end = max(0, min(text_length, int(span.get("end"))))
    except (TypeError, ValueError):
        return None
    if end <= start:
        return None
    override = {k: span[k] for k in _STYLE_PROPERTIES if span.get(k)}
    if not override:
        return None
    return {"start": start, "end": end, **override}


def build_style_map(text, spans, base_style=None):
    """Per-character accumulated style.

    Later spans win, exactly as in the editor — overlaps merge
    property-by-property instead of one span discarding another."""
    styles = [dict(base_style or {}) for _ in range(len(text))]
    normalized = [s for s in (normalize_span(sp, len(text)) for sp in (spans or [])) if s]
    normalized.sort(key=lambda s: (s["start"], s["end"]))
    for span in normalized:
        override = {k: span[k] for k in _STYLE_PROPERTIES if span.get(k)}
        for i in range(span["start"], span["end"]):
            styles[i] = {**styles[i], **override}
    return styles


def resolve_font(family, font_size, base_font):
    """Best-effort font for a user-chosen family.

    Returns (font, resolved_family). Falls back to the shipped Noto Serif face
    and SAYS SO, so the degradation is observable rather than silent.
    """
    if family and family != "Noto Serif":
        for path in _FONT_FAMILY_CANDIDATES.get(family, []):
            if os.path.exists(path):
                try:
                    return ImageFont.truetype(path, font_size), family
                except Exception:
                    continue
        print(f"⚠️ Hook range font '{family}' is unavailable — using Noto Serif.")
    return base_font, "Noto Serif"


def create_hook_image(text, target_width, output_image_path="hook_overlay.png", font_scale=1.0, style="classic", spans=None, base_style=None):
    """
    Generates a hook overlay image using pixel-based wrapping.
    target_width: The max width the box should occupy (e.g. 85% of video)
    style: one of HOOK_STYLES (classic/dark/yellow/red/outline/outline_yellow)
    """
    download_font_if_needed()

    look = HOOK_STYLES.get(style, HOOK_STYLES["classic"])

    # Range styling: with spans (or a base style) the hook is drawn per range so
    # the burned frame matches the editor preview. Without them, the original
    # single-font path below runs unchanged.
    normalized_spans = [
        s for s in (normalize_span(sp, len(text)) for sp in (spans or [])) if s
    ]
    if normalized_spans or base_style:
        return _create_hook_image_styled(
            text, target_width, output_image_path, font_scale, look,
            normalized_spans, base_style,
        )

    box_fill = look["box"]
    text_fill = look["text"]
    outline = look["outline"]
    has_box = box_fill[3] > 0
    draw_shadow = look["shadow"]
    
    # Configuration
    padding_x = 30 # Balanced padding
    padding_y = 25 
    line_spacing = 20 # Increased spacing
    cornerradius = 20
    shadow_offset = (5, 5) 
    shadow_blur = 10
    
    # Font Size Calculation (approx 5% of width - tuned to match Noto Serif Bold metrics in browser)
    base_font_size = int(target_width * 0.05)
    font_size = int(base_font_size * font_scale)
    
    try:
        font = ImageFont.truetype(FONT_PATH, font_size)
    except Exception as e:
        print(f"⚠️ Warning: Could not load font {FONT_PATH}, using default. Error: {e}")
        font = ImageFont.load_default()

    # Emoji handling: render with an emoji-capable font if one exists,
    # otherwise strip emoji instead of drawing tofu boxes.
    emoji_font = None
    if _EMOJI_RE.search(text):
        emoji_font = _load_emoji_font(font_size)
        if emoji_font is None:
            text = _EMOJI_RE.sub("", text)
            text = re.sub(r"[ \t]{2,}", " ", text).strip()

    # Wrap text logic (Pixel-based)
    dummy_img = Image.new('RGBA', (1, 1))
    draw = ImageDraw.Draw(dummy_img)

    max_text_width = target_width - (2 * padding_x)

    # Handle manual newlines first
    paragraphs = text.split('\n')
    lines = []

    for p in paragraphs:
        if not p.strip():
            lines.append("")
            continue

        words = p.split()
        current_line = []

        for word in words:
            # Test if adding word fits
            test_line = ' '.join(current_line + [word])
            w = _measure_width(draw, test_line, font, emoji_font)

            if w <= max_text_width:
                current_line.append(word)
                continue

            # Word doesn't fit on the current line
            if current_line:
                lines.append(' '.join(current_line))
                current_line = []

            if _measure_width(draw, word, font, emoji_font) <= max_text_width:
                current_line = [word]
            else:
                # Single word wider than the box: hard-wrap it character-wise
                # so it can't get cut off at the edges.
                pieces = _break_long_word(draw, word, font, emoji_font, max_text_width)
                lines.extend(pieces[:-1])
                current_line = [pieces[-1]] if pieces else []

        if current_line:
            lines.append(' '.join(current_line))

    # Recalculate true width/height
    max_line_width = 0
    text_heights = []

    for line in lines:
        if not line:
            text_heights.append(font_size) # Use font size for empty line height
            continue

        w = _measure_width(draw, line, font, emoji_font)
        bbox = draw.textbbox((0, 0), line, font=font)
        h = bbox[3] - bbox[1]
        max_line_width = max(max_line_width, int(w))
        text_heights.append(h)
    
    # Box dimensions
    # We want the box to fit the text exactly + padding
    # Ensure min width for aesthetic reasons if text is short (at least 30% of target)
    box_width = max(max_line_width + (2 * padding_x), int(target_width * 0.3))
    
    # Total Text Height: sum(heights) + spacing * (n-1)
    if not text_heights:
         total_text_height = font_size
    else:
         total_text_height = sum(text_heights) + (len(text_heights) - 1) * line_spacing
         
    box_height = total_text_height + (2 * padding_y)
    
    # Create Final Image with Rounded Corners and Shadow
    # 1. Canvas for Shadow (larger than box)
    canvas_w = box_width + 40
    canvas_h = box_height + 40
    
    img = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 2. Draw Shadow (only for boxed styles)
    if draw_shadow and has_box:
        shadow_box = [
            (20 + shadow_offset[0], 20 + shadow_offset[1]),
            (20 + box_width + shadow_offset[0], 20 + box_height + shadow_offset[1])
        ]
        draw.rounded_rectangle(shadow_box, radius=cornerradius, fill=(0, 0, 0, 100))
        # 3. Blur Shadow
        img = img.filter(ImageFilter.GaussianBlur(5))

    # 4. Draw Box (sharper, on top of blurred shadow)
    draw_final = ImageDraw.Draw(img)

    if has_box:
        main_box = [
            (20, 20),
            (20 + box_width, 20 + box_height)
        ]
        draw_final.rounded_rectangle(main_box, radius=cornerradius, fill=box_fill)

    # 5. Draw Text
    current_y = 20 + padding_y - 2 # Minor visual adjustment
    for i, line in enumerate(lines):
        if not line:
            current_y += font_size + line_spacing
            continue

        line_w = _measure_width(draw_final, line, font, emoji_font)
        bbox = draw_final.textbbox((0, 0), line, font=font)
        line_h = text_heights[i] if i < len(text_heights) else bbox[3] - bbox[1]

        # Center X
        x = 20 + int(box_width - line_w) // 2

        # Draw text in the style's color (emoji runs use the emoji font)
        _draw_mixed(img, draw_final, (x, current_y), line, font, emoji_font,
                    fill=text_fill, outline=outline)

        current_y += line_h + line_spacing
        
    img.save(output_image_path)
    return output_image_path, canvas_w, canvas_h

def _line_pieces(words):
    """Turn a wrapped list of (word, start, end) into drawable line pieces.

    The separator between two words is drawn as a single space and carries the
    range of the character immediately before the next word, so range styling
    still resolves to a real character."""
    pieces = []
    for i, (word, start, end) in enumerate(words):
        if i:
            pieces.append((' ', start - 1, start))
        pieces.append((word, start, end))
    return pieces


def _wrap_lines_with_offsets(text, draw, font, emoji_font, max_text_width):
    """Wrap `text` the same way the plain path does, keeping each word's
    character offsets so range styling lands on the right characters."""
    lines = []
    offset = 0
    for paragraph in text.split('\n'):
        words = [(m.group(0), offset + m.start(), offset + m.end())
                 for m in re.finditer(r'\S+', paragraph)]
        offset += len(paragraph) + 1  # +1 for the '\n' that split() removed

        if not words:
            lines.append([])
            continue

        current = []
        for word, wstart, wend in words:
            candidate = ' '.join([w[0] for w in current] + [word])
            if _measure_width(draw, candidate, font, emoji_font) <= max_text_width:
                current.append((word, wstart, wend))
                continue

            if current:
                lines.append(_line_pieces(current))
                current = []

            if _measure_width(draw, word, font, emoji_font) <= max_text_width:
                current = [(word, wstart, wend)]
            else:
                # A word wider than the box: hard-wrap character-wise, keeping
                # the ORIGINAL offsets so a styled range still maps correctly.
                pieces = _break_long_word(draw, word, font, emoji_font, max_text_width)
                cursor = wstart
                for piece in pieces[:-1]:
                    lines.append([(piece, cursor, cursor + len(piece))])
                    cursor += len(piece)
                if pieces:
                    current = [(pieces[-1], cursor, cursor + len(pieces[-1]))]

        if current:
            lines.append(_line_pieces(current))
    return lines


def _styled_piece_runs(pieces, style_map, text_length):
    """Split a line's pieces into (text, style) sub-runs of constant style."""
    runs = []
    for piece_text, pstart, _pend in pieces:
        i = 0
        while i < len(piece_text):
            idx = pstart + i
            style = style_map[idx] if 0 <= idx < text_length else {}
            key = tuple(style.get(k) for k in _STYLE_PROPERTIES)
            j = i + 1
            while j < len(piece_text):
                idx2 = pstart + j
                style2 = style_map[idx2] if 0 <= idx2 < text_length else {}
                if tuple(style2.get(k) for k in _STYLE_PROPERTIES) != key:
                    break
                j += 1
            runs.append((piece_text[i:j], style))
            i = j
    return runs


def _create_hook_image_styled(text, target_width, output_image_path, font_scale, look, spans, base_style):
    """Per-range renderer for a hook carrying rich text.

    Geometry (5% base font, 30/25 padding, 20 line spacing, 20 radius) mirrors
    the unstyled path exactly; only the glyph drawing differs, because each
    range can use its own colour, font and size.
    """
    box_fill = look["box"]
    text_fill = look["text"]
    outline = look["outline"]
    has_box = box_fill[3] > 0
    draw_shadow = look["shadow"]

    padding_x = 30
    padding_y = 25
    line_spacing = 20
    cornerradius = 20
    shadow_offset = (5, 5)

    base_font_size = int(target_width * 0.05)
    font_size = int(base_font_size * font_scale)

    try:
        base_font = ImageFont.truetype(FONT_PATH, font_size)
    except Exception:
        base_font = ImageFont.load_default()

    emoji_font = None
    if _EMOJI_RE.search(text):
        emoji_font = _load_emoji_font(font_size)
        if emoji_font is None:
            text = _EMOJI_RE.sub("", text)
            text = re.sub(r"[ \t]{2,}", " ", text).strip()

    style_map = build_style_map(text, spans, base_style)
    dummy = Image.new('RGBA', (1, 1))
    draw = ImageDraw.Draw(dummy)
    max_text_width = target_width - (2 * padding_x)

    lines = _wrap_lines_with_offsets(text, draw, base_font, emoji_font, max_text_width)

    font_cache = {}

    def font_for(style, size):
        family = style.get("font") or "Noto Serif"
        key = (family, size)
        if key not in font_cache:
            if size == font_size:
                face = base_font
            else:
                try:
                    face = ImageFont.truetype(FONT_PATH, size)
                except Exception:
                    face = base_font
            font_cache[key] = resolve_font(family, size, face)[0]
        return font_cache[key]

    line_runs = []
    line_widths = []
    line_heights = []
    for pieces in lines:
        resolved = []
        width = 0
        height = 0
        for run_text, style in _styled_piece_runs(pieces, style_map, len(text)):
            size = int(font_size * _size_multiplier(style.get("size")))
            face = font_for(style, size)
            run_w = _measure_width(draw, run_text, face, emoji_font)
            bbox = draw.textbbox((0, 0), run_text, font=face)
            width += run_w
            height = max(height, bbox[3] - bbox[1])
            resolved.append((run_text, style, face, run_w))
        line_runs.append(resolved)
        line_widths.append(width)
        line_heights.append(int(height) if height else font_size)

    max_line_width = max(line_widths) if line_widths else 0
    box_width = max(int(max_line_width) + (2 * padding_x), int(target_width * 0.3))
    if not line_heights:
        total_text_height = font_size
    else:
        total_text_height = sum(line_heights) + (len(line_heights) - 1) * line_spacing
    box_height = total_text_height + (2 * padding_y)

    canvas_w = box_width + 40
    canvas_h = box_height + 40
    img = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if draw_shadow and has_box:
        shadow_box = [
            (20 + shadow_offset[0], 20 + shadow_offset[1]),
            (20 + box_width + shadow_offset[0], 20 + box_height + shadow_offset[1]),
        ]
        draw.rounded_rectangle(shadow_box, radius=cornerradius, fill=(0, 0, 0, 100))
        img = img.filter(ImageFilter.GaussianBlur(5))

    draw_final = ImageDraw.Draw(img)
    if has_box:
        draw_final.rounded_rectangle(
            [(20, 20), (20 + box_width, 20 + box_height)],
            radius=cornerradius, fill=box_fill,
        )

    current_y = 20 + padding_y - 2
    for i, resolved in enumerate(line_runs):
        if not resolved:
            current_y += font_size + line_spacing
            continue

        x = 20 + int(box_width - line_widths[i]) // 2
        for run_text, style, face, run_w in resolved:
            fill = hex_to_rgb(style.get("color")) or text_fill
            _draw_mixed(img, draw_final, (x, current_y), run_text, face, emoji_font,
                        fill=fill, outline=outline)
            x += run_w

        current_y += line_heights[i] + line_spacing

    img.save(output_image_path)
    return output_image_path, canvas_w, canvas_h


def add_hook_to_video(video_path, text, output_path, position="top", font_scale=1.0, duration=None, style="classic", spans=None, base_style=None):
    """
    Overlays text hook onto video.
    position: 'top', 'center', 'bottom'
    font_scale: float multiplier (1.0 = default)
    style: hook look (see HOOK_STYLES)
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video {video_path} not found")

    # 1. Probe video width to scale text properly
    try:
        cmd = ['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', video_path]
        res = subprocess.check_output(cmd, timeout=60).decode().strip()
        # Takes first stream if multiple
        dims = res.split('\n')[0].split('x')
        video_width = int(dims[0])
        video_height = int(dims[1])
    except Exception as e:
        print(f"⚠️ FFprobe failed: {e}. Assuming 1080x1920")
        video_width = 1080
        video_height = 1920
        
    # 2. Generate Image
    # Box check: Don't let it be wider than 90% of screen
    target_box_width = int(video_width * 0.9)
    
    # Unique per invocation so parallel jobs can't overwrite each other's overlay.
    # The uuid alone guarantees that; the source name rides along only as a
    # debugging hint, so it is trimmed by BYTES (filesystems cap at 255 bytes,
    # and one Bengali or Arabic character costs three). Embedding it untrimmed
    # raised OSError 36 and killed the endpoint in prod on 26-jul-2026.
    stem = os.path.splitext(os.path.basename(video_path))[0]
    hook_filename = (f"temp_hook_{uuid.uuid4().hex[:8]}_"
                     f"{_truncate_bytes(stem, 80)}.png")
    
    try:
        img_path, box_w, box_h = create_hook_image(text, target_box_width, hook_filename, font_scale=font_scale, style=style, spans=spans, base_style=base_style)
        
        # 3. Calculate Overlay Position
        overlay_x = (video_width - box_w) // 2
        
        if position == "center":
            overlay_y = (video_height - box_h) // 2
        elif position == "bottom":
             # Bottom 20% mark (approx)
             overlay_y = int(video_height * 0.70)
        else:
             # Top 20% mark
             overlay_y = int(video_height * 0.20)
        
        # 4. FFmpeg Command
        print(f"🎬 Overlaying hook: '{text}' at {overlay_x},{overlay_y}")
        
        ffmpeg_cmd = [
            'ffmpeg', '-y',
            '-i', video_path,
            '-i', img_path,
            '-filter_complex', f"[0:v][1:v]overlay={overlay_x}:{overlay_y}"
                + (f":enable='between(t,0,{float(duration)})'" if duration else ""),
            '-c:a', 'copy',
            *video_encode_args(QUALITY),
            *METADATA_SCRUB,
            '-movflags', '+faststart',
            output_path
        ]
        
        subprocess.run(ffmpeg_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
        print(f"✅ Hook added to {output_path}")
        return True

    except subprocess.TimeoutExpired:
        print("❌ FFmpeg hook overlay timed out after 1800s.")
        raise RuntimeError("FFmpeg hook overlay timed out after 1800s.")
    except subprocess.CalledProcessError as e:
        print(f"❌ FFmpeg Error: {e.stderr.decode() if e.stderr else 'Unknown'}")
        raise e
    except Exception as e:
        print(f"❌ Hook Gen Error: {e}")
        raise e
    finally:
        # Cleanup temp image
        if os.path.exists(hook_filename):
            os.remove(hook_filename)

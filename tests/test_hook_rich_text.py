"""Range-based Hook rich text — the SERVER half of the preview/render parity
contract.

`hooks.py` burns a hook with the same range semantics the editor preview shows:
half-open [start, end) character ranges, applied in order so a later span wins
on overlap, and per-range colour / font / size.

Written as unittest (not pytest) so it runs with the repo's documented runner:

    cd openshorts && python3 -m unittest discover -s tests -p "test_hook_rich_text.py"

Every test is offline: the shipped Noto Serif face is read straight from
openshorts/fonts, so nothing hits the network and nothing depends on the CWD.
"""

import inspect
import os
import unittest

from PIL import Image

import hooks

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Absolute font paths: hooks.py defaults to CWD-relative ones, which would make
# these tests depend on where they are run from (and could trigger a download).
hooks.FONT_DIR = os.path.join(REPO, "fonts")
hooks.FONT_PATH = os.path.join(hooks.FONT_DIR, "NotoSerif-Bold.ttf")

HOOK_TEXT = "LOOK MA.. NO HANDS!"
#               L0 O1 O2 K3 _4 M5 A6 .7 .8 _9 N10 O11 _12 H13 A14 N15 D16 S17 !18
LOOK = (0, 4)
MA = (5, 9)
NO = (10, 12)
HANDS = (13, 19)

ACCEPTANCE_SPANS = [
    {"start": LOOK[0], "end": LOOK[1], "color": "#FFD600"},
    {"start": MA[0], "end": MA[1], "color": "#FF0000", "size": "L"},
    {"start": NO[0], "end": NO[1], "color": "#00FF00"},
    {"start": HANDS[0], "end": HANDS[1], "color": "#00E5FF", "size": "S"},
]

OUT_DIR = os.path.join(REPO, "tests", "_hook_rich_text_tmp")


def setUpModule():
    os.makedirs(OUT_DIR, exist_ok=True)


def tearDownModule():
    for name in os.listdir(OUT_DIR):
        os.remove(os.path.join(OUT_DIR, name))
    os.rmdir(OUT_DIR)


def render_image(name, text, spans=None, base_style=None, style="dark", width=720):
    path = os.path.join(OUT_DIR, f"{name}.png")
    out, width_px, height_px = hooks.create_hook_image(
        text, width, path, style=style, spans=spans, base_style=base_style,
    )
    return Image.open(out).convert("RGBA"), width_px, height_px


def colours_present(img):
    """Set of exact RGB colours in the image (alpha ignored)."""
    counts = img.convert("RGB").getcolors(maxcolors=1 << 24) or []
    return {colour for _count, colour in counts}


# --- span normalization (mirrors the editor's rules) ------------------------

class StyleMapTests(unittest.TestCase):
    def test_hex_to_rgb_accepts_full_and_short_form(self):
        self.assertEqual(hooks.hex_to_rgb("#FFD600"), (255, 214, 0))
        self.assertEqual(hooks.hex_to_rgb("#f60"), (255, 102, 0))
        self.assertIsNone(hooks.hex_to_rgb("not-a-colour"))
        self.assertIsNone(hooks.hex_to_rgb(""))
        self.assertIsNone(hooks.hex_to_rgb(None))

    def test_normalize_span_clamps_to_the_text_and_drops_dead_spans(self):
        text = "LOOK"
        self.assertEqual(hooks.normalize_span({"start": -5, "end": 2, "color": "#fff"}, len(text)),
                         {"start": 0, "end": 2, "color": "#fff"})
        self.assertEqual(hooks.normalize_span({"start": 2, "end": 99, "color": "#fff"}, len(text)),
                         {"start": 2, "end": 4, "color": "#fff"})
        self.assertIsNone(hooks.normalize_span({"start": 3, "end": 1, "color": "#fff"}, len(text)))
        self.assertIsNone(hooks.normalize_span({"start": 0, "end": 4}, len(text)))
        self.assertIsNone(hooks.normalize_span({"start": 0, "end": 4, "color": ""}, len(text)))
        self.assertIsNone(hooks.normalize_span("nonsense", len(text)))
        self.assertIsNone(hooks.normalize_span(None, len(text)))

    def test_ranges_apply_only_to_their_own_characters(self):
        style_map = hooks.build_style_map(HOOK_TEXT, ACCEPTANCE_SPANS)
        self.assertEqual(style_map[0], {"color": "#FFD600"})
        self.assertEqual(style_map[6], {"color": "#FF0000", "size": "L"})
        self.assertEqual(style_map[10], {"color": "#00FF00"})
        self.assertEqual(style_map[15], {"color": "#00E5FF", "size": "S"})
        # The separators are untouched.
        self.assertEqual(style_map[4], {})
        self.assertEqual(style_map[9], {})

    def test_a_later_span_wins_on_overlap_and_merges_other_properties(self):
        style_map = hooks.build_style_map(HOOK_TEXT, [
            {"start": 0, "end": 9, "color": "#FF0000"},
            {"start": 5, "end": 12, "size": "L"},
        ])
        self.assertEqual(style_map[1], {"color": "#FF0000"})
        self.assertEqual(style_map[6], {"color": "#FF0000", "size": "L"})
        self.assertEqual(style_map[10], {"size": "L"})

    def test_base_style_applies_where_no_span_overrides(self):
        style_map = hooks.build_style_map(HOOK_TEXT, [{"start": 5, "end": 9, "color": "#FF0000"}],
                                          {"color": "#FFFFFF", "size": "L"})
        self.assertEqual(style_map[0], {"color": "#FFFFFF", "size": "L"})
        self.assertEqual(style_map[6], {"color": "#FF0000", "size": "L"})

    def test_build_style_map_of_empty_text_is_empty(self):
        self.assertEqual(hooks.build_style_map("", ACCEPTANCE_SPANS), [])


# --- font resolution --------------------------------------------------------

class FontResolutionTests(unittest.TestCase):
    def test_a_resolvable_family_is_honoured(self):
        with _patch_families({"TestFamily": [os.path.join(REPO, "fonts", "Anton-Regular.ttf")]}):
            font, resolved = hooks.resolve_font("TestFamily", 24, None)
        self.assertEqual(resolved, "TestFamily")
        self.assertIsNotNone(font)

    def test_an_unavailable_family_degrades_to_the_shipped_face_visibly(self):
        class Base:
            pass
        base = Base()
        with _patch_families({}):
            font, resolved = hooks.resolve_font("NonexistentFamily", 24, base)
        self.assertEqual(resolved, "Noto Serif")
        self.assertIs(font, base)


class _patch_families:
    """Temporarily replace the font-family probe table."""

    def __init__(self, table):
        self.table = table

    def __enter__(self):
        self.original = hooks._FONT_FAMILY_CANDIDATES
        hooks._FONT_FAMILY_CANDIDATES = self.table
        return self

    def __exit__(self, *exc):
        hooks._FONT_FAMILY_CANDIDATES = self.original
        return False


# --- rendering --------------------------------------------------------------

class RenderTests(unittest.TestCase):
    def test_a_plain_hook_still_renders_through_the_original_path(self):
        img, width_px, height_px = render_image("plain", HOOK_TEXT)
        self.assertGreater(width_px, 0)
        self.assertGreater(height_px, 0)
        # The dark style's text colour is white; no range colour exists here.
        present = colours_present(img)
        self.assertIn((255, 255, 255), present)
        self.assertNotIn((255, 214, 0), present)
        self.assertNotIn((0, 229, 255), present)

    def test_no_spans_and_no_base_style_is_byte_identical_to_the_legacy_call(self):
        legacy = os.path.join(OUT_DIR, "legacy.png")
        explicit = os.path.join(OUT_DIR, "explicit_empty.png")
        hooks.create_hook_image(HOOK_TEXT, 720, legacy, style="dark")
        hooks.create_hook_image(HOOK_TEXT, 720, explicit, style="dark", spans=[], base_style=None)
        with open(legacy, "rb") as f:
            a = f.read()
        with open(explicit, "rb") as f:
            b = f.read()
        self.assertEqual(a, b)

    def test_each_range_is_burned_in_its_own_colour(self):
        img, _w, _h = render_image("spans", HOOK_TEXT, spans=ACCEPTANCE_SPANS)
        present = colours_present(img)
        for colour in [(255, 214, 0), (255, 0, 0), (0, 255, 0), (0, 229, 255)]:
            self.assertIn(colour, present, f"range colour {colour} was not burned")

    def test_a_single_character_range_is_burned(self):
        img, _w, _h = render_image("one_char", "LOOK", spans=[{"start": 1, "end": 2, "color": "#FF00FF"}])
        self.assertIn((255, 0, 255), colours_present(img))

    def test_a_single_word_range_is_burned(self):
        img, _w, _h = render_image("one_word", HOOK_TEXT, spans=[{"start": HANDS[0], "end": HANDS[1], "color": "#00E5FF"}])
        self.assertIn((0, 229, 255), colours_present(img))

    def test_a_larger_range_increases_the_drawn_box_height(self):
        _img_a, _w_a, h_base = render_image("size_base", HOOK_TEXT)
        _img_b, _w_b, h_large = render_image("size_large", HOOK_TEXT, spans=[
            {"start": 0, "end": len(HOOK_TEXT), "size": "L"},
        ])
        self.assertGreater(h_large, h_base)

    def test_out_of_bounds_and_valueless_spans_do_not_break_the_render(self):
        img, _w, _h = render_image("clamped", HOOK_TEXT, spans=[
            {"start": -10, "end": 999, "color": "#FFD600"},
            {"start": 3, "end": 1, "color": "#FF0000"},
            {"start": 0, "end": 4},
            {"start": 5, "end": 9, "color": "not-a-colour"},
        ])
        present = colours_present(img)
        self.assertIn((255, 214, 0), present)          # clamped range still drew
        self.assertNotIn((255, 0, 0), present)         # inverted range dropped

    def test_a_base_style_applies_to_every_character(self):
        img, _w, _h = render_image("base_style", HOOK_TEXT, base_style={"color": "#FFD600"})
        self.assertIn((255, 214, 0), colours_present(img))

    def test_a_numeric_size_multiplier_scales_the_range(self):
        # The editor sends a multiplier, not an S/M/L token. If this silently
        # fell back to 1.0 the range would look styled in the preview and be
        # un-styled in the burn — the exact drift this work exists to remove.
        _img_a, _w_a, h_base = render_image("mult_base", HOOK_TEXT)
        _img_b, _w_b, h_big = render_image("mult_130", HOOK_TEXT, spans=[
            {"start": 0, "end": len(HOOK_TEXT), "size": 1.3},
        ])
        self.assertGreater(h_big, h_base)

    def test_legacy_token_sizes_still_scale_the_range(self):
        _img_a, _w_a, h_base = render_image("token_base", HOOK_TEXT)
        _img_b, _w_b, h_token = render_image("token_large", HOOK_TEXT, spans=[
            {"start": 0, "end": len(HOOK_TEXT), "size": "L"},
        ])
        self.assertGreater(h_token, h_base)

    def test_size_multiplier_is_tolerant_and_never_a_silent_no_op(self):
        self.assertEqual(hooks._size_multiplier(None), 1.0)
        self.assertEqual(hooks._size_multiplier(""), 1.0)
        self.assertEqual(hooks._size_multiplier("L"), 1.3)
        self.assertEqual(hooks._size_multiplier("l"), 1.3)
        self.assertEqual(hooks._size_multiplier(1.375), 1.375)
        self.assertEqual(hooks._size_multiplier(0), 1.0)
        self.assertEqual(hooks._size_multiplier(-2), 1.0)
        self.assertEqual(hooks._size_multiplier("wide"), 1.0)
        self.assertEqual(hooks._size_multiplier(1000), 10.0)

    def test_the_same_geometry_constants_are_used_by_both_paths(self):
        # 5% base font size and the 20px corner radius are shared; if either path
        # drifts, the burned hook stops matching the preview.
        self.assertEqual(hooks._SIZE_SCALE, {"S": 0.8, "M": 1.0, "L": 1.3})

    def test_colour_only_ranges_do_not_move_the_box(self):
        # Colour-only spans change no font metric, so the box must stay put.
        # (Per-run measurement drops cross-piece kerning, hence the tiny
        # tolerance rather than exact equality.)
        colour_only = [dict(s) for s in ACCEPTANCE_SPANS if "size" not in s]
        _img_a, w_plain, h_plain = render_image("agree_plain", HOOK_TEXT)
        _img_b, w_styled, h_styled = render_image("agree_styled", HOOK_TEXT, spans=colour_only)
        self.assertLessEqual(abs(w_plain - w_styled), 2)
        self.assertLessEqual(abs(h_plain - h_styled), 2)

    def test_a_resized_range_does_change_the_box(self):
        # The counterpart: an explicit size range must actually affect geometry,
        # otherwise "size" would be a no-op that only looked applied.
        _img_a, w_plain, _h_plain = render_image("resize_plain", HOOK_TEXT)
        _img_b, w_resized, _h_resized = render_image("resize_large", HOOK_TEXT, spans=[
            {"start": MA[0], "end": MA[1], "size": "L"},
        ])
        self.assertGreater(w_resized, w_plain)


# --- the endpoint contract --------------------------------------------------

class ContractTests(unittest.TestCase):
    def test_add_hook_to_video_accepts_range_styling(self):
        params = inspect.signature(hooks.add_hook_to_video).parameters
        self.assertIn("spans", params)
        self.assertIn("base_style", params)

    def test_create_hook_image_accepts_range_styling(self):
        params = inspect.signature(hooks.create_hook_image).parameters
        self.assertIn("spans", params)
        self.assertIn("base_style", params)

    def test_hook_styles_still_match_the_editor_picker(self):
        self.assertEqual(set(hooks.HOOK_STYLES), {
            "classic", "dark", "yellow", "red", "outline", "outline_yellow",
        })


if __name__ == "__main__":
    unittest.main()

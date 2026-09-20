"""Header burn — the SERVER half of the preview/render geometry contract.

Both layout modes must render the SAME fixed 9:16 canvas (720x1280). The
dedicated black Header band is reserved INSIDE that canvas; the video is fitted
below it by HEIGHT, so it is narrower than the canvas and centred, with bars
either side -- never stretched and never scaled to full width.

These assertions read real bytes back out of the rendered MP4 (ffprobe for the
frame size, ffmpeg + PIL for the pixels) so a composition change that silently
produced a taller canvas or a stretched video fails here.

Written as unittest so the repo's documented runner collects it:

    cd openshorts && python3 -m unittest discover -s tests -p "test_header*.py"
"""

import os
import subprocess
import sys
import unittest

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(REPO)

import hooks  # noqa: E402

OUT_DIR = os.path.join(REPO, "tests", "_header_pixels_tmp")
SRC_W, SRC_H = 720, 1280
GREY = (100, 100, 100)

# Geometry the composition must obey, in canvas pixels.
BAND_H = int(round(SRC_H * 18 / 100))
FIT_H = SRC_H - BAND_H
FIT_W = int(round(SRC_W * (FIT_H / float(SRC_H))))
FIT_X = (SRC_W - FIT_W) // 2

HEADER_TEXT = "HEADER"
HOOK_TEXT = "HOOK"


def setUpModule():
    os.makedirs(OUT_DIR, exist_ok=True)
    hooks.FONT_DIR = os.path.join(REPO, "fonts")
    hooks.FONT_PATH = os.path.join(hooks.FONT_DIR, "NotoSerif-Bold.ttf")


def tearDownModule():
    for name in os.listdir(OUT_DIR):
        p = os.path.join(OUT_DIR, name)
        if os.path.isfile(p):
            os.remove(p)
    os.rmdir(OUT_DIR)


def _probe(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "stream=width,height",
        "-of", "csv=s=x:p=0", path,
    ], timeout=120).decode().strip()
    w, h = out.splitlines()[0].split("x")
    return int(w), int(h)


def _frame(video, name):
    png = os.path.join(OUT_DIR, name + ".png")
    subprocess.run(["ffmpeg", "-y", "-i", video, "-vframes", "1", png],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return Image.open(png).convert("RGB")


def _is_black(px):
    return all(c < 45 for c in px)


def _is_greyish(px):
    return max(px) - min(px) < 45 and 55 < px[0] < 165


def _is_colour(px, want, tol=90):
    return all(abs(px[i] - want[i]) <= tol for i in range(3))


def _pixels_like(img, want, tol=90):
    return [(x, y)
            for y in range(0, img.height, 2)
            for x in range(0, img.width, 2)
            if _is_colour(img.getpixel((x, y)), want, tol)]


class HeaderRenderPixels(unittest.TestCase):
    """One rendered pipeline per mode, asserted on real decoded pixels."""

    @classmethod
    def setUpClass(cls):
        # A flat grey source: every non-grey, non-black pixel in the output is
        # something the composition drew.
        cls.src = os.path.join(OUT_DIR, "src.mp4")
        jpg = os.path.join(OUT_DIR, "src.jpg")
        Image.new("RGB", (SRC_W, SRC_H), GREY).save(jpg)
        subprocess.run([
            "ffmpeg", "-y", "-loop", "1", "-i", jpg, "-t", "1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", cls.src,
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def _render(self, region):
        """Hook first, then the Header — the order the editor chain uses, so the
        Header composition is the LAST transform applied."""
        hook_path = os.path.join(OUT_DIR, "hooked_%s.mp4" % region)
        hooks.add_hook_to_video(
            self.src, HOOK_TEXT, hook_path, position="top", style="classic",
            spans=[{"start": 0, "end": len(HOOK_TEXT), "color": "#FF00FF"}],
        )
        final = os.path.join(OUT_DIR, "final_%s.mp4" % region)
        hooks.add_header_to_video(
            hook_path, HEADER_TEXT, final, position="top", region=region,
            background="none",
            spans=[{"start": 0, "end": len(HEADER_TEXT), "color": "#00FF00"}],
        )
        return final

    # -- the canvas rule, for BOTH modes ------------------------------------

    def test_both_modes_render_the_fixed_9x16_canvas(self):
        for region in ("overlay", "dedicated"):
            w, h = _probe(self._render(region))
            self.assertEqual((w, h), (SRC_W, SRC_H),
                             "%s must stay the fixed 9:16 canvas" % region)

    # -- overlay mode -------------------------------------------------------

    def test_overlay_mode_burns_the_header_and_fills_the_canvas(self):
        img = _frame(self._render("overlay"), "frame_overlay")
        greens = _pixels_like(img, (0, 255, 0))
        self.assertTrue(greens, "the Header was not burned in overlay mode")
        self.assertTrue(all(y < BAND_H for _x, y in greens),
                        "overlay Header must stay inside the top band")
        # No letterboxing: the video reaches the canvas edge.
        self.assertTrue(_is_greyish(img.getpixel((2, SRC_H // 2))),
                        "overlay mode must not letterbox the video")

    # -- dedicated mode -----------------------------------------------------

    def test_dedicated_mode_reserves_a_black_band_at_the_top(self):
        img = _frame(self._render("dedicated"), "frame_dedicated")
        # A row above the Header text (which sits lower in the band) is pure
        # black: the reserved band, not the video.
        for x in range(0, SRC_W, 40):
            self.assertTrue(_is_black(img.getpixel((x, 4))),
                            "row y=4 must be the reserved black band at x=%d" % x)

    def test_dedicated_mode_puts_the_header_inside_the_band(self):
        img = _frame(self._render("dedicated"), "frame_dedicated")
        greens = _pixels_like(img, (0, 255, 0))
        self.assertTrue(greens, "the Header was not burned in dedicated mode")
        self.assertTrue(all(y < BAND_H for _x, y in greens),
                        "the Header must stay inside the reserved band")

    def test_dedicated_mode_fits_the_video_below_the_band_centred(self):
        img = _frame(self._render("dedicated"), "frame_dedicated")
        mid = BAND_H + FIT_H // 2

        # The video starts BELOW the band...
        self.assertTrue(_is_black(img.getpixel((SRC_W // 2, BAND_H - 6))),
                        "the band must still be black just above the video")
        # ...is present below it, centred...
        self.assertTrue(_is_greyish(img.getpixel((SRC_W // 2, mid))),
                        "the video must be drawn below the band")
        # ...and is narrower than the canvas, so the side bars are black.
        self.assertTrue(_is_black(img.getpixel((2, mid))),
                        "a side bar must remain black (video is not full width)")
        self.assertTrue(_is_black(img.getpixel((SRC_W - 3, mid))),
                        "a side bar must remain black (video is not full width)")

    def test_dedicated_mode_never_scales_the_video_to_full_width(self):
        img = _frame(self._render("dedicated"), "frame_dedicated")
        mid = BAND_H + FIT_H // 2

        def grey_span(row):
            xs = [x for x in range(SRC_W) if _is_greyish(img.getpixel((x, row)))]
            return (min(xs), max(xs)) if xs else None

        span = grey_span(mid)
        self.assertIsNotNone(span, "no video pixels found below the band")
        left, right = span
        # Within a few pixels of the aspect-preserving fit for this geometry.
        self.assertLessEqual(abs(left - FIT_X), 8, "video not centred/not fitted")
        self.assertLessEqual(abs(right - (FIT_X + FIT_W)), 8,
                             "video not centred/not fitted")

    def test_dedicated_mode_keeps_the_hook_in_the_video_region(self):
        img = _frame(self._render("dedicated"), "frame_dedicated")
        magentas = _pixels_like(img, (255, 0, 255))
        self.assertTrue(magentas, "the Hook was not burned")
        self.assertTrue(all(y >= BAND_H for _x, y in magentas),
                        "the Hook must stay inside the video region")
        self.assertTrue(all(y < BAND_H for _x, y in _pixels_like(img, (0, 255, 0))),
                        "the Header must stay inside the band")

    def test_composition_geometry_constants(self):
        # The values the renderer composes with, asserted directly so a change
        # to the band share cannot silently drift the canvas rule.
        self.assertEqual(BAND_H, 230)
        self.assertEqual(FIT_H, 1050)
        self.assertEqual(FIT_W, 591)
        self.assertEqual(FIT_X, 64)


if __name__ == "__main__":
    unittest.main()

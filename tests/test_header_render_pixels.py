import unittest
import os
import sys
import subprocess
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(REPO)
import hooks

OUT_DIR = os.path.join(REPO, "tests", "_header_pixels_tmp")

def setUpModule():
    os.makedirs(OUT_DIR, exist_ok=True)
    hooks.FONT_DIR = os.path.join(REPO, "fonts")
    hooks.FONT_PATH = os.path.join(hooks.FONT_DIR, "NotoSerif-Bold.ttf")

def tearDownModule():
    for f in os.listdir(OUT_DIR):
        try:
            os.remove(os.path.join(OUT_DIR, f))
        except OSError:
            pass
    try:
        os.rmdir(OUT_DIR)
    except OSError:
        pass

class HeaderPixelTests(unittest.TestCase):
    def setUp(self):
        self.src_img = os.path.join(OUT_DIR, "test_src.jpg")
        self.src_vid = os.path.join(OUT_DIR, "test_src.mp4")
        img = Image.new('RGB', (720, 1280), (100, 100, 100))
        img.save(self.src_img)
        os.system(f"ffmpeg -y -loop 1 -i {self.src_img} -c:v libx264 -t 1 -pix_fmt yuv420p {self.src_vid} 2>/dev/null")

    def test_overlay_mode_pixels(self):
        out_vid = os.path.join(OUT_DIR, "test_overlay.mp4")
        hooks.add_header_to_video(
            self.src_vid, "RED TEXT", out_vid,
            position="top", region="overlay", spans=[{"start": 0, "end": 8, "color": "#FF0000"}]
        )
        
        out_frame = os.path.join(OUT_DIR, "test_overlay_frame.png")
        os.system(f"ffmpeg -y -i {out_vid} -vframes 1 {out_frame} 2>/dev/null")
        frame = Image.open(out_frame).convert("RGB")
        
        red_found = False
        for count, color in frame.getcolors(maxcolors=1<<24):
            if color[0] > 200 and color[1] < 50 and color[2] < 50:
                red_found = True
                break
                
        self.assertTrue(red_found, "Red text not found in overlay mode frame")

    def test_dedicated_mode_pixels_and_dimensions(self):
        out_vid = os.path.join(OUT_DIR, "test_dedicated.mp4")
        hooks.add_header_to_video(
            self.src_vid, "GREEN TEXT", out_vid,
            position="top", region="dedicated", spans=[{"start": 0, "end": 10, "color": "#00FF00"}]
        )
        
        out_frame = os.path.join(OUT_DIR, "test_dedicated_frame.png")
        os.system(f"ffmpeg -y -i {out_vid} -vframes 1 {out_frame} 2>/dev/null")
        frame = Image.open(out_frame).convert("RGB")
        
        green_found = False
        for count, color in frame.getcolors(maxcolors=1<<24):
            if color[0] < 50 and color[1] > 200 and color[2] < 50:
                green_found = True
                break
                
        self.assertTrue(green_found, "Green text not found in dedicated mode frame")
        self.assertEqual(frame.width, 720)
        self.assertEqual(frame.height, int(1280 * 100 / 82), "Dedicated canvas dimensions incorrect")

if __name__ == "__main__":
    unittest.main()

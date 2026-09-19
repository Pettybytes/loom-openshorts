import unittest
import os
import hooks

# Override fonts so offline test passes independently
REPO = os.path.dirname(os.path.abspath(__file__))
hooks.FONT_DIR = os.path.join(REPO, "fonts")
hooks.FONT_PATH = os.path.join(hooks.FONT_DIR, "NotoSerif-Bold.ttf")

OUT_DIR = os.path.join(REPO, "tests", "_header_rich_text_tmp")

def setUpModule():
    os.makedirs(OUT_DIR, exist_ok=True)

class HeaderRenderTests(unittest.TestCase):
    def test_header_image_generation(self):
        text = "TESTING HEADER"
        path = os.path.join(OUT_DIR, "header.png")
        spans = [{"start": 0, "end": 7, "color": "#FF0000"}]
        
        img_path, width, height = hooks.create_header_image(
            text, 1000, output_image_path=path,
            font_family="Verdana", font_size_px=40, text_color="#FFFFFF",
            background="box", background_color="#000000", alignment="center",
            spans=spans, base_style=None
        )
        
        self.assertTrue(os.path.exists(img_path))
        self.assertGreater(width, 0)
        self.assertGreater(height, 0)

if __name__ == "__main__":
    unittest.main()

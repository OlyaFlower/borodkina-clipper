"""Unit tests of motion/prepare/prepare.py that need no model: python -I tests/motion_prepare_test.py
(with the prepare venv's python, see scripts/motion-prepare.sh --setup)."""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "motion", "prepare"))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

import prepare  # noqa: E402


class FakeInput:
    name = "pixel_values"


class RampDepth:
    """Stands in for the depth model: depth rises from left to right."""

    def get_inputs(self):
        return [FakeInput()]

    def run(self, _outputs, feeds):
        _, _, h, w = feeds["pixel_values"].shape
        return [np.tile(np.linspace(0, 10, w, dtype=np.float32), (h, 1))[None]]


def test_faces_are_flat_in_depth():
    frame = Image.new("RGB", (prepare.W, prepare.H), (90, 90, 90))
    framing = {"mode": "crop", "coverBox": [0, 0, prepare.W, prepare.H]}
    face = {"x": 800, "y": 300, "w": 240, "h": 300, "score": 0.9}
    d = prepare.estimate_depth(RampDepth(), frame, framing, [face])
    sx, sy = prepare.DEPTH_OUT[0] / prepare.W, prepare.DEPTH_OUT[1] / prepare.H
    core = d[int(360 * sy) : int(560 * sy), int(860 * sx) : int(980 * sx)]
    assert core.std() < 1e-3, f"face depth is not flat: std {core.std()}"
    assert d[:, 10].mean() < 0.1 and d[:, -10].mean() > 0.9, "the ramp outside the face must stay"


def test_crop_keeps_faces_in_frame():
    img = Image.new("RGB", (1600, 1000), (40, 40, 40))  # 16:10, cropped to 16:9
    face = {"x": 20, "y": 20, "w": 120, "h": 150, "score": 0.9}
    frame, framing, faces, background = prepare.frame_cover(img, [face])
    assert frame.size == (1920, 1080) and framing["mode"] == "crop" and background is None
    assert framing["sourceBox"][1] == 0, "a face at the top must pull the crop window up"
    f = faces[0]
    assert f["x"] >= 0 and f["y"] >= 0 and f["x"] + f["w"] <= 1920 and f["y"] + f["h"] <= 1080


def test_portrait_is_extended_not_cropped():
    img = Image.new("RGB", (800, 1000), (200, 100, 50))
    frame, framing, _, background = prepare.frame_cover(img, [])
    assert framing["mode"] == "extend" and background is not None
    x0, y0, x1, y1 = framing["coverBox"]
    assert y1 - y0 == round(1080 * prepare.EXTEND_SCALE) and abs((x1 - x0) / (y1 - y0) - 0.8) < 0.01
    assert frame.getpixel(((x0 + x1) // 2, (y0 + y1) // 2)) == (200, 100, 50)


def test_letterbox_bars_are_trimmed_only_in_pairs():
    pic = np.full((1000, 1600, 3), 120, np.uint8)
    pic[:, ::7] = 200  # some texture
    boxed = pic.copy()
    boxed[:100] = 0
    boxed[-100:] = 0
    trimmed, box = prepare.trim_bars(Image.fromarray(boxed))
    assert box is not None and abs(box[1] - 100) <= 4 and abs(1000 - box[3] - 100) <= 4, box
    one_side = pic.copy()
    one_side[:150] = 0  # a black sky, not a letterbox
    _, box = prepare.trim_bars(Image.fromarray(one_side))
    assert box is None


def test_palette_is_deterministic():
    rng = np.random.default_rng(1)
    img = Image.fromarray(rng.integers(0, 255, (270, 480, 3), dtype=np.uint8)).resize((1920, 1080))
    a, b = prepare.palette(img), prepare.palette(img)
    assert a == b and len(a["colors"]) == 5
    assert abs(sum(c["share"] for c in a["colors"]) - 1) < 0.01


def test_non_image_is_source_invalid():
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as fh:
        fh.write(b"\xff\xd8\xff not really a jpeg")
    try:
        prepare.load_cover(fh.name)
    except prepare.SourceInvalid:
        pass
    else:
        raise AssertionError("a broken JPEG must be source_invalid")
    finally:
        os.unlink(fh.name)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok {t.__name__}")
    print(f"{len(tests)} prepare tests passed")

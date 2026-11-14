"""How much a motion render moves, independent of how much texture the cover has.

Usage: python -I motion-measure.py <frame0.png> <frame.png>...   prints JSON to stdout

For each frame: the mean absolute luminance difference to frame 0 (0..255), divided by the mean
luminance gradient of frame 0 plus a floor of 1.5. A rigid shift by d pixels of a textured picture
changes each pixel by about d times its gradient, so the score is roughly "pixels of apparent motion";
light that changes over a flat area counts in grey levels over the floor. A static render scores 0
whatever the cover, a flat cover with moving light scores above 0.3, and a textured cover does not
score high merely because it is textured.

Output: {"motion": max score, "scores": [...], "gradient": mean gradient, "meanAbsDiff": [...]}
Needs numpy and Pillow (the prepare venv).
"""

import json
import sys

import numpy as np
from PIL import Image

FLOOR = 1.5


def luma(path):
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    base = luma(argv[1])
    gy, gx = np.gradient(base)
    grad = float(np.hypot(gx, gy).mean())
    diffs, scores = [], []
    for path in argv[2:]:
        f = luma(path)
        if f.shape != base.shape:
            print(f"{path}: size {f.shape} differs from frame 0 {base.shape}", file=sys.stderr)
            return 1
        mad = float(np.abs(f - base).mean())
        diffs.append(round(mad, 3))
        scores.append(round(mad / (grad + FLOOR), 3))
    print(json.dumps({"motion": max(scores), "scores": scores, "gradient": round(grad, 3), "meanAbsDiff": diffs}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

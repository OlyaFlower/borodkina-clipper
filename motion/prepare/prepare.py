"""Prepares an event cover for the motion kit.

Usage: python -I prepare.py <cover> <out-dir> <depth-model.onnx> <face-model.onnx>

Writes into <out-dir>:
  cover.jpg     the 1920x1080 frame every video starts and ends on (JPEG q95, 4:4:4)
  background.jpg  extend mode only: the frame without the card, for moving the card over it
  depth.png     1920x1080 8-bit depth, 255 = nearest; edges snapped to the picture, flat inside faces
  faces.json    [{"x","y","w","h","score"}] face boxes in cover.jpg pixels, [] when none
  palette.json  {"colors":[{"hex","share"}] x5, "light","dark","accent"}
  focus.json    {"x","y" (0..1 of the frame), "depth" (0..1), "source": "faces"|"saliency"}
  meta.json     everything above in one object for the authoring step, plus framing and timings

Framing: a cover whose aspect is close to 16:9 (cropping it would lose at most 25 % of its area,
i.e. from 4:3 to 2.37:1) is cropped, with the crop window centred on the faces or, without faces,
on the salient area, so people and the subject stay in frame. A cover further from 16:9 (square,
portrait posters) is not cropped, because that would cut away most of a poster's design and text:
it is shown whole, as a card at 90 % of the frame height with a soft shadow, over a blurred, darkened
copy of itself (blurred extension).

Exit codes: 0 ok, 3 the cover is not a usable image (source_invalid), 4 anything else (render_failed).
Everything is deterministic: no randomness, fixed model inputs, CPU inference with one thread pool.
"""

import json
import os
import sys
import time

import numpy as np
from PIL import Image, ImageFilter, ImageOps

W, H = 1920, 1080
TARGET = W / H
MAX_CROP_LOSS = 0.25
EXTEND_SCALE = 0.9
DEPTH_IN = (798, 448)  # model input, multiples of 14 with a 16:9 aspect
DEPTH_OUT = (960, 540)
FACE_IN = 640
FACE_SCORE = 0.75
FACE_NMS = 0.3
MIN_FACE = 0.03  # faces narrower than 3 % of the cover width are ignored (crowds, posters)
KIT_PREPARE_VERSION = "prepare-1"


class SourceInvalid(Exception):
    pass


def log(msg):
    print(f"prepare: {msg}", file=sys.stderr, flush=True)


# ---------- image helpers


def load_cover(path):
    Image.MAX_IMAGE_PIXELS = 60_000_000
    try:
        img = Image.open(path, formats=["JPEG", "PNG", "WEBP"])
        img.load()
    except Exception as e:  # noqa: BLE001 - any decoder error means the cover is unusable
        raise SourceInvalid(f"The cover image could not be read ({type(e).__name__})") from e
    img = ImageOps.exif_transpose(img)
    if img.width < 64 or img.height < 64:
        raise SourceInvalid("The cover image is smaller than 64x64")
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
        img = Image.alpha_composite(bg, rgba)
    return img.convert("RGB")


def trim_bars(img):
    """Removes uniform bars (letterbox or pillarbox) baked into the cover, up to 25 % per side."""
    small_w = min(img.width, 480)
    scale = img.width / small_w
    small = np.asarray(img.resize((small_w, max(1, round(img.height / scale))), Image.BILINEAR), dtype=np.float32)
    h, w, _ = small.shape

    def bar(line):
        # A baked-in letterbox bar is flat and near black.
        return float(line.std(axis=0).max()) < 6.0 and float(line.mean(axis=0).max()) < 28.0

    def run(lines, limit):
        n = 0
        while n < limit and bar(lines(n)):
            n += 1
        return n

    def pair(a, b, side):
        # Bars come in symmetric pairs, at least 1 % of the side each; a dark sky or a black
        # backdrop on one edge only is part of the picture and stays.
        if min(a, b) < max(2, side // 100) or abs(a - b) > max(3, 0.25 * max(a, b)):
            return 0, 0
        return a, b

    top, bottom = pair(run(lambda i: small[i], h // 4), run(lambda i: small[h - 1 - i], h // 4), h)
    left, right = pair(run(lambda i: small[:, i], w // 4), run(lambda i: small[:, w - 1 - i], w // 4), w)
    if not (top or bottom or left or right):
        return img, None
    box = (
        round(left * scale),
        round(top * scale),
        img.width - round(right * scale),
        img.height - round(bottom * scale),
    )
    return img.crop(box), box


def gaussian(arr, sigma):
    """Separable Gaussian blur of a 2-D float array with edge padding."""
    if sigma <= 0:
        return arr
    r = max(1, int(3 * sigma))
    x = np.arange(-r, r + 1, dtype=np.float32)
    k = np.exp(-(x * x) / (2 * sigma * sigma))
    k /= k.sum()
    p = np.pad(arr, ((r, r), (0, 0)), mode="edge")
    arr = sum(k[i] * p[i : i + arr.shape[0]] for i in range(2 * r + 1))
    p = np.pad(arr, ((0, 0), (r, r)), mode="edge")
    return sum(k[i] * p[:, i : i + arr.shape[1]] for i in range(2 * r + 1))


def luminance(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


# ---------- faces (YuNet 2023mar)


def detect_faces(session, img):
    scale = FACE_IN / max(img.width, img.height)
    sw, sh = max(1, round(img.width * scale)), max(1, round(img.height * scale))
    canvas = np.zeros((FACE_IN, FACE_IN, 3), dtype=np.float32)
    canvas[:sh, :sw] = np.asarray(img.resize((sw, sh), Image.BILINEAR), dtype=np.float32)
    blob = canvas[..., ::-1].transpose(2, 0, 1)[None].copy()  # BGR, NCHW, 0..255
    names = [o.name for o in session.get_outputs()]
    out = dict(zip(names, session.run(None, {session.get_inputs()[0].name: blob})))
    boxes, scores = [], []
    for stride in (8, 16, 32):
        cols = FACE_IN // stride
        cls = np.clip(out[f"cls_{stride}"][0, :, 0], 0, 1)
        obj = np.clip(out[f"obj_{stride}"][0, :, 0], 0, 1)
        score = np.sqrt(cls * obj)
        bbox = out[f"bbox_{stride}"][0]
        idx = np.nonzero(score >= FACE_SCORE)[0]
        for i in idx:
            r, c = divmod(int(i), cols)
            cx = (c + bbox[i, 0]) * stride
            cy = (r + bbox[i, 1]) * stride
            w = float(np.exp(bbox[i, 2])) * stride
            h = float(np.exp(bbox[i, 3])) * stride
            boxes.append((cx - w / 2, cy - h / 2, w, h))
            scores.append(float(score[i]))
    order = np.argsort(-np.asarray(scores)) if scores else []
    keep = []
    for i in order:
        if all(iou(boxes[i], boxes[j]) <= FACE_NMS for j in keep):
            keep.append(i)
    faces = []
    for i in keep:
        x, y, w, h = (v / scale for v in boxes[i])
        x0, y0 = max(0.0, x), max(0.0, y)
        x1, y1 = min(float(img.width), x + w), min(float(img.height), y + h)
        if x1 - x0 < MIN_FACE * img.width or y1 <= y0:
            continue
        faces.append({"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "score": round(scores[i], 3)})
    return faces[:12]


def iou(a, b):
    ax1, ay1, bx1, by1 = a[0] + a[2], a[1] + a[3], b[0] + b[2], b[1] + b[3]
    iw = max(0.0, min(ax1, bx1) - max(a[0], b[0]))
    ih = max(0.0, min(ay1, by1) - max(a[1], b[1]))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


# ---------- saliency (spectral residual, Hou & Zhang 2007)


def saliency(img, size=(96, 64)):
    g = luminance(np.asarray(img.resize(size, Image.BILINEAR), dtype=np.float32) / 255.0)
    f = np.fft.fft2(g)
    log_amp = np.log(np.abs(f) + 1e-6)
    phase = np.angle(f)
    pad = np.pad(log_amp, 1, mode="wrap")
    avg = sum(pad[i : i + g.shape[0], j : j + g.shape[1]] for i in range(3) for j in range(3)) / 9.0
    s = np.abs(np.fft.ifft2(np.exp((log_amp - avg) + 1j * phase))) ** 2
    s = gaussian(s.astype(np.float32), 2.5)
    s -= s.min()
    return s / (s.max() + 1e-9)


def centroid(weight):
    h, w = weight.shape
    total = float(weight.sum())
    if total <= 1e-9:
        return 0.5, 0.5
    ys, xs = np.mgrid[0:h, 0:w]
    return float((xs * weight).sum() / total + 0.5) / w, float((ys * weight).sum() / total + 0.5) / h


# ---------- framing


def frame_cover(img, faces):
    """Returns (frame 1920x1080, framing dict, faces mapped into the frame, background or None).

    The background (extend mode only) is the frame without the card, for compositions that move the
    card over it."""
    aspect = img.width / img.height
    loss = 1 - min(aspect / TARGET, TARGET / aspect)
    if loss <= MAX_CROP_LOSS:
        if aspect >= TARGET:
            cw, ch = img.height * TARGET, float(img.height)
        else:
            cw, ch = float(img.width), img.width / TARGET
        if faces:
            x0 = min(f["x"] for f in faces)
            y0 = min(f["y"] for f in faces)
            x1 = max(f["x"] + f["w"] for f in faces)
            y1 = max(f["y"] + f["h"] for f in faces)
            # Faces sit in the upper part of a well-composed frame: aim at a point a little below them.
            fx, fy = (x0 + x1) / 2, (y0 + y1) / 2 + 0.1 * ch
            source = "faces"
        else:
            sx, sy = centroid(saliency(img) ** 2)
            # Pull the saliency guess halfway back to the centre: centred crops are rarely wrong.
            fx, fy = (0.5 + (sx - 0.5) * 0.5) * img.width, (0.5 + (sy - 0.5) * 0.5) * img.height
            source = "saliency"
        left = min(max(fx - cw / 2, 0.0), img.width - cw)
        top = min(max(fy - ch / 2, 0.0), img.height - ch)
        if faces:  # keep every face whole when the window can hold them
            if x1 - x0 <= cw:
                left = min(max(left, x1 - cw), x0)
            if y1 - y0 <= ch:
                top = min(max(top, y1 - ch), y0)
            left = min(max(left, 0.0), img.width - cw)
            top = min(max(top, 0.0), img.height - ch)
        box = (left, top, left + cw, top + ch)
        frame = img.resize((W, H), Image.LANCZOS, box=box)
        s = W / cw
        mapped = []
        for f in faces:
            x, y = (f["x"] - left) * s, (f["y"] - top) * s
            w, h = f["w"] * s, f["h"] * s
            x0c, y0c, x1c, y1c = max(0.0, x), max(0.0, y), min(float(W), x + w), min(float(H), y + h)
            if x1c - x0c > 4 and y1c - y0c > 4:
                mapped.append({"x": x0c, "y": y0c, "w": x1c - x0c, "h": y1c - y0c, "score": f["score"]})
        framing = {
            "mode": "crop",
            "cropLoss": round(loss, 3),
            "aim": source,
            "sourceBox": [round(v) for v in box],
            "coverBox": [0, 0, W, H],
        }
        return frame, framing, mapped, None

    # Blurred extension: the whole cover as a card at 90 % of the height (or of the width when it is
    # wider than 16:9), over a blurred, darkened copy of itself, with a soft shadow below the card.
    if aspect < TARGET:
        ih = round(H * EXTEND_SCALE)
        iw = max(1, round(ih * aspect))
    else:
        iw = round(W * EXTEND_SCALE)
        ih = max(1, round(iw / aspect))
    ix, iy = (W - iw) // 2, (H - ih) // 2
    inset = img.resize((iw, ih), Image.LANCZOS)
    bg_small = ImageOps.fit(img, (W // 4, H // 4), Image.BILINEAR)
    bg_small = bg_small.filter(ImageFilter.GaussianBlur(14))
    bg = np.asarray(bg_small.resize((W, H), Image.BICUBIC), dtype=np.float32)
    grey = luminance(bg)[..., None]
    bg = (grey + (bg - grey) * 0.75) * 0.5  # a little desaturated, half as bright
    mask = np.zeros((H // 4, W // 4), dtype=np.float32)
    mask[(iy + 12) // 4 : (iy + ih + 12) // 4, ix // 4 : (ix + iw) // 4] = 1.0
    shadow = gaussian(mask, 9.0)
    shadow = np.asarray(Image.fromarray(shadow).resize((W, H), Image.BILINEAR), dtype=np.float32)
    bg *= (1.0 - 0.6 * np.clip(shadow, 0, 1))[..., None]
    background = Image.fromarray(np.clip(bg + 0.5, 0, 255).astype(np.uint8))
    frame = background.copy()
    frame.paste(inset, (ix, iy))
    s = iw / img.width
    mapped = [
        {"x": ix + f["x"] * s, "y": iy + f["y"] * s, "w": f["w"] * s, "h": f["h"] * s, "score": f["score"]}
        for f in faces
    ]
    framing = {
        "mode": "extend",
        "cropLoss": round(loss, 3),
        "aim": "centre",
        "sourceBox": [0, 0, img.width, img.height],
        "coverBox": [ix, iy, ix + iw, iy + ih],
    }
    return frame, framing, mapped, background


# ---------- depth (Depth Anything V2 Small)


def estimate_depth(session, frame, framing, faces):
    # The model sees only the cover itself (in extend mode not the blurred surround, whose edges
    # it would read as near objects), at about 800x450 worth of 14-pixel patches.
    x0, y0, x1, y1 = framing["coverBox"]
    bw, bh = x1 - x0, y1 - y0
    k = (DEPTH_IN[0] * DEPTH_IN[1] / (bw * bh)) ** 0.5
    iw, ih = max(14, round(bw * k / 14) * 14), max(14, round(bh * k / 14) * 14)
    x = np.asarray(frame.crop((x0, y0, x1, y1)).resize((iw, ih), Image.BICUBIC), dtype=np.float32) / 255.0
    x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    blob = x.transpose(2, 0, 1)[None].astype(np.float32)
    raw = session.run(None, {session.get_inputs()[0].name: blob})[0][0].astype(np.float32)
    lo, hi = np.percentile(raw, [2, 98])
    rel = np.clip((raw - lo) / max(float(hi - lo), 1e-6), 0, 1)
    sx, sy = DEPTH_OUT[0] / W, DEPTH_OUT[1] / H
    rx0, ry0 = round(x0 * sx), round(y0 * sy)
    rw, rh = max(1, round(x1 * sx) - rx0), max(1, round(y1 * sy) - ry0)
    # The blurred surround of extend mode is a flat backdrop (depth 0) behind the cover.
    d = np.zeros((DEPTH_OUT[1], DEPTH_OUT[0]), dtype=np.float32)
    d[ry0 : ry0 + rh, rx0 : rx0 + rw] = np.asarray(Image.fromarray(rel).resize((rw, rh), Image.BILINEAR))
    d = gaussian(d, 1.0)  # slightly soft edges: no single-pixel tearing at depth steps

    # Faces are rigid: their depth is flattened to the face's median, feathered into the surround,
    # so the parallax moves a face as one piece and never warps it.
    ys, xs = np.mgrid[0 : d.shape[0], 0 : d.shape[1]].astype(np.float32)
    for f in faces:
        cx, cy = (f["x"] + f["w"] / 2) * sx, (f["y"] + f["h"] * 0.6) * sy
        rx, ry = f["w"] * 0.85 * sx, f["h"] * 1.0 * sy  # head, hair and neck
        x0, x1 = int(max(0, cx - f["w"] * 0.5 * sx)), int(min(d.shape[1], cx + f["w"] * 0.5 * sx + 1))
        y0, y1 = int(max(0, f["y"] * sy)), int(min(d.shape[0], (f["y"] + f["h"]) * sy + 1))
        if x1 <= x0 or y1 <= y0:
            continue
        level = float(np.median(d[y0:y1, x0:x1]))
        r = np.sqrt(((xs - cx) / rx) ** 2 + ((ys - cy) / ry) ** 2)
        w = np.clip((1.35 - r) / 0.35, 0, 1)  # 1 inside the ellipse, feathered to 0 at 1.35x
        w = w * w * (3 - 2 * w)
        d = d * (1 - w) + level * w
    return d


def box(arr, r):
    """Mean over a (2r+1)^2 window, edges handled by clamping the window (summed-area table)."""
    h, w = arr.shape
    c = np.pad(arr, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    y0 = np.clip(np.arange(h) - r, 0, h)
    y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - r, 0, w)
    x1 = np.clip(np.arange(w) + r + 1, 0, w)
    total = c[y1][:, x1] - c[y0][:, x1] - c[y1][:, x0] + c[y0][:, x0]
    return total / ((y1 - y0)[:, None] * (x1 - x0)[None, :])


def refine_depth(d, frame, r=6, eps=2e-3):
    """Upsamples depth to the frame and snaps its edges to the picture's edges (guided filter, He et al.),
    so the parallax separates a figure from what is behind it along the figure's real outline instead
    of along the blocky outline of the low-resolution depth. Flat depth (faces) stays flat."""
    p = np.asarray(Image.fromarray(d).resize((W, H), Image.BILINEAR), dtype=np.float32).astype(np.float64)
    g = luminance(np.asarray(frame, dtype=np.float32) / 255.0).astype(np.float64)
    mean_g, mean_p = box(g, r), box(p, r)
    a = (box(g * p, r) - mean_g * mean_p) / (box(g * g, r) - mean_g * mean_g + eps)
    b = mean_p - a * mean_g
    return np.clip(box(a, r) * g + box(b, r), 0, 1).astype(np.float32)


# ---------- palette (k-means, deterministic initialisation)


def hexcolor(c):
    return "#{:02x}{:02x}{:02x}".format(*[int(round(v)) for v in np.clip(c, 0, 255)])


def palette(frame, k=5):
    px = np.asarray(frame.resize((128, 72), Image.BILINEAR), dtype=np.float32).reshape(-1, 3)
    lum = luminance(px)
    order = np.argsort(lum, kind="stable")
    centres = np.stack([px[order[int((i + 0.5) / k * len(order))]] for i in range(k)])
    for _ in range(16):
        dist = ((px[:, None, :] - centres[None]) ** 2).sum(-1)
        label = dist.argmin(1)
        for i in range(k):
            sel = px[label == i]
            if len(sel):
                centres[i] = sel.mean(0)
    counts = np.bincount(label, minlength=k).astype(np.float64)
    idx = np.argsort(-counts, kind="stable")
    colors = [{"hex": hexcolor(centres[i]), "share": round(float(counts[i] / counts.sum()), 3)} for i in idx]
    lums = luminance(centres)
    sat = centres.max(1) - centres.min(1)
    return {
        "colors": colors,
        "light": hexcolor(centres[int(lums.argmax())]),
        "dark": hexcolor(centres[int(lums.argmin())]),
        "accent": hexcolor(centres[int(sat.argmax())]),
    }


# ---------- main


def write_json(path, value):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=2)
        fh.write("\n")


def main(argv):
    if len(argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    cover_path, out, depth_model, face_model = argv[1:]
    import onnxruntime as ort  # imported late so a usage error does not pay for it

    os.makedirs(out, exist_ok=True)
    timings = {}
    t0 = time.monotonic()

    def lap(name):
        nonlocal t0
        now = time.monotonic()
        timings[name] = round((now - t0) * 1000)
        t0 = now

    img = load_cover(cover_path)
    original = {"width": img.width, "height": img.height}
    img, bars = trim_bars(img)
    lap("decodeMs")

    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    providers = ["CPUExecutionProvider"]
    faces_src = detect_faces(ort.InferenceSession(face_model, opts, providers=providers), img)
    lap("facesMs")

    frame, framing, faces, background = frame_cover(img, faces_src)
    frame.save(os.path.join(out, "cover.jpg"), quality=95, subsampling=0, optimize=True)
    files = {"cover": "cover.jpg", "depth": "depth.png"}
    if background is not None:
        background.save(os.path.join(out, "background.jpg"), quality=95, subsampling=0, optimize=True)
        files["background"] = "background.jpg"
    lap("frameMs")

    depth = estimate_depth(ort.InferenceSession(depth_model, opts, providers=providers), frame, framing, faces)
    full = refine_depth(depth, frame)
    Image.fromarray(np.clip(full * 255 + 0.5, 0, 255).astype(np.uint8)).save(os.path.join(out, "depth.png"))
    lap("depthMs")

    sx, sy = DEPTH_OUT[0] / W, DEPTH_OUT[1] / H
    if faces:
        area = np.array([f["w"] * f["h"] for f in faces])
        fx = float(sum(a * (f["x"] + f["w"] / 2) for a, f in zip(area, faces)) / area.sum()) / W
        fy = float(sum(a * (f["y"] + f["h"] / 2) for a, f in zip(area, faces)) / area.sum()) / H
        fd = float(depth[min(DEPTH_OUT[1] - 1, int(fy * DEPTH_OUT[1])), min(DEPTH_OUT[0] - 1, int(fx * DEPTH_OUT[0]))])
        focus = {"x": round(fx, 4), "y": round(fy, 4), "depth": round(fd, 4), "source": "faces"}
    else:
        sal = np.asarray(
            Image.fromarray(saliency(frame)).resize(DEPTH_OUT, Image.BILINEAR), dtype=np.float32
        )
        weight = sal * (0.25 + depth) ** 2
        fx, fy = centroid(weight)
        fd = float((depth * weight).sum() / max(float(weight.sum()), 1e-9))
        focus = {"x": round(fx, 4), "y": round(fy, 4), "depth": round(fd, 4), "source": "saliency"}
    del sx, sy
    pal = palette(frame)
    lap("analysisMs")

    faces_out = [{k: (round(v) if k != "score" else v) for k, v in f.items()} for f in faces]
    write_json(os.path.join(out, "faces.json"), faces_out)
    write_json(os.path.join(out, "palette.json"), pal)
    write_json(os.path.join(out, "focus.json"), focus)
    meta = {
        "version": KIT_PREPARE_VERSION,
        "width": W,
        "height": H,
        "source": {**original, "trimmedBars": list(bars) if bars else None},
        "framing": framing,
        "files": files,
        "depth": {
            "size": [W, H],
            "nearIs": 255,
            "mean": round(float(depth.mean()), 4),
            "facesFlattened": len(faces_out),
        },
        "faces": faces_out,
        "focus": focus,
        "palette": pal,
        "models": {"depth": "depth-anything-v2-small", "faces": "yunet-2023mar"},
        "timings": timings,
    }
    write_json(os.path.join(out, "meta.json"), meta)
    log(
        f"{original['width']}x{original['height']} -> {framing['mode']} (loss {framing['cropLoss']}), "
        f"{len(faces_out)} face(s), focus {focus['source']} ({focus['x']}, {focus['y']}), timings {timings}"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except SourceInvalid as e:
        print(str(e), file=sys.stderr)
        sys.exit(3)
    except Exception as e:  # noqa: BLE001
        print(f"prepare failed: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(4)

# borodkina-clipper

Cuts 8-second silent carousel clips for borodkina admin.

The admin Worker (Cloudflare) cannot run ffmpeg or yt-dlp. It starts the `clip` workflow of this repo with
`workflow_dispatch`. The job makes a silent 16:9 clip from a YouTube video or from a source file already in R2,
encodes renditions, uploads them to R2 and then sends a signed callback to the admin.

## Protocol

Workflow `.github/workflows/clip.yml`, `workflow_dispatch` inputs (all strings):

| Input | Rule |
| --- | --- |
| `jobId`, `mediaId` | `^[A-Za-z0-9_-]{1,64}$` |
| `env` | `dev` or `prod` (also selects the GitHub Environment) |
| `youtubeVideoId` | optional, `^[A-Za-z0-9_-]{11}$` |
| `sourceKey` | optional, `^sources/[A-Za-z0-9_-]{1,64}$`; exactly one of `youtubeVideoId` and `sourceKey` |
| `startSec` | integer 0..86400 |
| `durationSec` | integer 5..10 |
| `callbackUrl` | must start with `https://dev-admin.borodkinamusic.com/api/v1/video-jobs/` (dev) or `https://admin.borodkinamusic.com/api/v1/video-jobs/` (prod) |

Output in R2, bucket `R2_BUCKET`, under `videos/<mediaId>/`, with `Cache-Control: public, max-age=31536000, immutable`:

- `1280.av1.webm` (1280x720, SVT-AV1 preset 6, crf 36, about 1000 kbps cap) and `640.av1.webm` (640x360, 400 kbps cap). Optional: dropped if they fail or exceed 4 MiB.
- `1280.h264.mp4` (High, level 3.2, crf 23, max 2 Mbps) and `640.h264.mp4` (level 3.0, max 800 kbps), `+faststart`. Required.
- `poster.webp`: first frame, 1280x720, quality 80, at most 512 KiB.

All videos are 30 fps, yuv420p, keyframe every 60 frames, no audio stream, duration within 0.15 s of `durationSec`, at most 4 MiB.

Callback: `POST callbackUrl`, JSON body, headers `content-type: application/json`, `x-clipper-timestamp` (unix seconds) and
`x-clipper-signature` = lowercase hex `HMAC-SHA256(CLIPPER_CALLBACK_SECRET, timestamp + "." + rawBody)`.
Retried 3 times with backoff on network errors and 5xx.

```json
{"status":"succeeded","renditions":[{"file":"1280.av1.webm","bytes":123}],"poster":{"bytes":456},"durationMs":8000}
{"status":"failed","error":"youtube_blocked","message":"..."}
```

Error codes: `youtube_blocked` (bot check or HTTP 429), `source_invalid` (private, removed, unreadable or too short source),
`encode_failed` (anything else, also publish errors); motion jobs can also send `render_failed`. Messages are fixed strings of at most 500 characters.
A cancelled or timed-out job (15 minutes) sends no callback; the admin should expire such jobs itself.

## Motion videos

Workflow `.github/workflows/motion.yml` turns an event cover into an 8-second silent, seamlessly looping preview video
with [HyperFrames](https://hyperframes.heygen.com/packages/cli) (HTML rendered to video by headless Chrome and FFmpeg).
It uses the same GitHub Environments, secrets, R2 layout, renditions and callback signing as `clip`.

`workflow_dispatch` inputs (all strings), checked by `scripts/validate-inputs.sh motion`:

| Input | Rule |
| --- | --- |
| `jobId`, `mediaId` | `^[A-Za-z0-9_-]{1,64}$` |
| `env` | `dev` or `prod` (also selects the GitHub Environment) |
| `sourceKey` | `^sources/[A-Za-z0-9_-]{1,64}$` |
| `callbackUrl` | same rule as `clip` |

Before dispatching, the admin uploads two objects to R2:

- `sources/<id>`: the cover, JPEG, PNG or WebP (recognised by its first bytes), at most 20 MiB, at least 64x64.
- `sources/<id>.json`: the brief, a JSON object of at most 64 KiB. Its fields are defined by the authoring step
  (a later package); today the job only checks that it exists and is an object.

Steps: validate, install the pinned ffmpeg, `motion/` (`npm ci`, HyperFrames and GSAP pinned exactly in
`motion/package-lock.json`) and Python 3.12, fetch the cover and brief (`scripts/fetch-cover.sh`), prepare the cover
(`scripts/motion-prepare.sh`), author the composition (for now always the kit's default, recorded as fallback authoring),
render with `scripts/motion-render.sh` (1920x1080, 30 fps, 240 frames, `--quality delivery`, 3 workers), encode and verify
with the same `encode.sh`/`verify.sh` as `clip` (start 0, duration 8), check the quality gates (`scripts/motion-gates.sh`),
publish to `videos/<mediaId>/` and call back. The job times out after 35 minutes.

### Prepare

`scripts/motion-prepare.sh <cover> <out>` runs `motion/prepare/prepare.py` (numpy, Pillow and onnxruntime, CPU) and must
finish within 2 minutes (about 1-2 s of analysis on the runner, plus the first download of the models). It writes:

| File | Content |
| --- | --- |
| `cover.jpg` | The 1920x1080 frame the video starts and ends on. |
| `background.jpg` | Extend mode only: the same frame without the card. |
| `depth.png` | 1920x1080 8-bit depth, 255 = nearest (Depth Anything V2 Small), edges snapped to the picture by a guided filter; flat inside every face. |
| `faces.json` | Face boxes in `cover.jpg` pixels, `[{"x","y","w","h","score"}]`, `[]` when none (YuNet). |
| `palette.json` | Five dominant colours with their share, plus `light`, `dark` and `accent`. |
| `focus.json` | Focal point `x`, `y` (0..1), its `depth` and `source`: `faces`, or else `saliency` weighted by nearness. |
| `meta.json` | All of the above for the authoring step, plus the framing, the source size and timings. |

Framing: baked-in letterbox bars (symmetric, near black) are trimmed first. A cover close to 16:9, whose crop would lose
at most 25 % of its area (4:3 up to about 2.37:1), is cropped, the window aimed at the faces (kept whole) or else at the
salient area, because a photo loses little and gains a full frame. Anything further away (square, portrait posters) is not
cropped, since that would cut away most of a poster's design and lettering: it is shown whole as a card at 90 % of the
frame height with a soft shadow, over a blurred, darkened copy of itself.

Pins: the Python wheels are listed with their sha256 in `motion/prepare/requirements.txt` (installed with
`--require-hashes --no-deps --only-binary :all:` into a venv), and the models in `motion/prepare/models.env`
(Hugging Face revision and sha256): `onnx-community/depth-anything-v2-small` `onnx/model.onnx` (Apache-2.0) and
`opencv/face_detection_yunet` `face_detection_yunet_2023mar.onnx` (MIT). Both live in `~/.cache/borodkina-motion`,
which the workflows cache with `actions/cache`. An unusable cover fails with `source_invalid`, anything else with
`render_failed`.

### Kit

`motion/kit/lib/` holds the reusable ES modules (kit version `kit-1`): `loop.js` (the 8 s clock, periodic envelopes, the
camera orbit, a seeded PRNG), `parallax.js` (one WebGL pass: depth parallax by parallax-occlusion marching, so near
things stay crisp; a card-over-background mode for extended covers; a soft light sweep; paper grain fixed to the picture;
a vignette), `particles.js` (palette-coloured dust and a few bokeh discs that keep clear of faces) and `scene.js` (the
prepared scene, image loading behind a HyperFrames build-ready promise, the GSAP/hf-seek clock).
`motion/kit/default/index.html` is the fallback composition built from them; its variables are `intensity` (default 1)
and `seed`. `motion-render.sh` renders a private copy with `kit/`, the pinned GSAP and the prepared files in `assets/`,
and `assets/scene.js` setting `window.__MOTION_SCENE` to `meta.json`.

The motion is calm on purpose: a tiny elliptical camera orbit (at most about 22 px between the nearest and the farthest
plane, no zoom) pivoting on the focal plane, so faces, which are flat in depth, move as one piece or not at all. Every
effect is a pure function of t built from whole periods of the loop and fades to exactly zero at t = 0, so frame 0 is the
cover pixel for pixel and the last frame runs into the first; every random choice is seeded.

### Quality gates

`scripts/motion-gates.sh` fails the job with `render_failed` unless the master and every rendition last 8 s within one
frame, frame 0 matches the prepared cover (SSIM >= 0.98), the last frame matches frame 0 (SSIM >= 0.98), the middle frame
differs (SSIM < 0.97), and three frames (0.5 s, 4 s, 6.5 s) snapshotted twice with HyperFrames on software WebGL are
pixel-identical (at least SSIM >= 0.999). It writes `$WORK_DIR/gates.json` and a table to the job summary.

Outputs: the same five files as `clip` (`1280.av1.webm`, `640.av1.webm`, `1280.h264.mp4`, `640.h264.mp4`, `poster.webp`),
duration 8 s, and the poster is frame 0, the cover itself.

The success callback carries one more field, read from `$WORK_DIR/motion.json` (refused unless it has exactly these keys):

```json
{"status":"succeeded","renditions":[{"file":"1280.av1.webm","bytes":123}],"poster":{"bytes":456},"durationMs":8000,
 "motion":{"authoring":"fallback","model":null,"kitVersion":"kit-1"}}
```

`authoring` is `fallback` (a fixed composition) or `claude` (written by Claude, `model` then names the model);
`kitVersion` names the composition kit. Error codes: `source_invalid` (cover or brief missing, unreadable or too large),
`render_failed` (the prepare step's setup or analysis, HyperFrames setup, the render itself, the master's 1920x1080 /
30 fps / 240-frame check, a composition whose WebGL context cannot be created, or a failed quality gate),
`encode_failed` (renditions or publishing).

## Setup

Create two GitHub Environments in the repo settings, `dev` and `prod`, each with these secrets:

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`: an R2 API token with object read and write on that bucket.
  The endpoint is `https://<account>.eu.r2.cloudflarestorage.com` (EU jurisdiction), region `auto`.
- `CLIPPER_CALLBACK_SECRET`: the same value the admin uses to verify callbacks for that environment.

The admin dispatches with a fine-grained token that has only `Actions: read and write` on this repository.

## Cutting a YouTube clip on your Mac

GitHub runners are often refused by YouTube; your home IP is not. The `image` workflow builds a linux/arm64 image with
yt-dlp, deno and ffmpeg and publishes it to `ghcr.io/olyaflower/borodkina-clipper` (tags: the full commit SHA and `latest`).

```sh
brew install container      # once
container system start      # once after each reboot, if it is not running
mkdir -p ~/Downloads/borodkina-clips
container run --rm -m 4G -v ~/Downloads/borodkina-clips:/out \
  ghcr.io/olyaflower/borodkina-clipper:<sha> clip --youtube <id> --start <s> --end <e>
```

`<id>` is the 11-character video id, `<s>` and `<e>` are whole seconds with `5 <= e - s <= 10`. The result is in
`~/Downloads/borodkina-clips/<id>-<s>-<e>/`: the renditions, `poster.webp` and `clip.json`. An existing folder of the same name is replaced.
The first run makes macOS ask whether `container` may access the Downloads folder; allow it. If YouTube refuses the download
(sign-in or bot check) the command prints a message and exits with code 3.

`-m 4G` matters: Apple `container` gives a VM 1 GB by default, and cutting a 1080p AV1 HLS stream (YouTube format 699)
exhausts it, so the VM freezes on `[download] Destination: …` and the `container` service stops answering until
`container system stop` / `start`. With 4 GB the same clip takes about half a minute.

`docker run` works the same way with the same arguments. For tests only, `clip --file <video> --start <s> --end <e>` encodes a local file instead of downloading.

## Security notes

- The repository is public, so Actions logs are public. Nothing secret is printed; secrets are only set on the steps that need them.
- The only inputs are IDs and numbers. Each is validated by `scripts/validate-inputs.sh` before use, and inputs reach scripts only through `env:`, never through `${{ }}` inside `run:`.
- `callback.mjs` refuses any URL outside the allowed admin prefix for the environment, so the signing secret cannot be sent elsewhere.
- Tools (yt-dlp, ffmpeg) are pinned by version and sha256 in `scripts/versions.env`, the motion prepare packages and models by sha256 in `motion/prepare/`; third-party actions are pinned by commit SHA.
- Only clip videos you have the rights to.

## Tests

`.github/workflows/ci.yml` runs shellcheck, input validation tests (including injection attempts), a real encode of a generated 1080p60 fixture
with all ffprobe assertions, and the publish and callback path against a local S3 stand-in (moto) and a local HMAC-verifying server.
The `motion-render` job runs `tests/motion-kit.test.sh` for three generated covers in `tests/fixtures/motion`
(`make-fixtures.py` draws them; no third-party images): `stage` (16:10 concert, cropped, no faces), `poster` (4:5 drawn
portrait with title bars, extended, its drawn face detected) and `landscape` (2.2:1 hills, cropped). Each runs the prepare
unit tests (`tests/motion_prepare_test.py`: flat faces in depth, crop keeps faces, extension, letterbox pairs, palette,
broken images), checks that a non-image cover is `source_invalid`, then prepare, the kit render, encode, verify and the
quality gates. Timings and gate values go to the job summary, and the three determinism snapshots of each fixture are kept
as the `motion-snapshots-<fixture>` artifact for 14 days (fixtures only, never real covers).
The `clip` and `motion` workflows are never triggered by CI.

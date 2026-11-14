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
- `sources/<id>.json`: the brief, a JSON object of at most 64 KiB, private (the workflow log is public, so the job
  never prints it): `version`, `title`, `summary`, `note` (this event's direction), `locale`, and optionally:
  - `model`: the Claude model of the author step, `claude-sonnet-5-5` (the default) or `claude-opus-5-5`; any other
    value means the default.
  - `authoring`: `claude` (the default; missing or any other value means `claude`) or `preset`: skip the Claude
    author step entirely (no Claude credential is used) and render the preset; `authoring` is then `fallback`
    with the reason `preset-only`.
  - `preset`: one of the six presets of [`motion/kit/presets`](motion/kit/presets) (`PRESETS` in
    `motion/kit/choose.mjs`). It replaces the chooser's pick for the fallback render (the log shows
    `choose: <name> (forced by the brief)`), and Claude starts from it and keeps its character. The safe scene
    still follows if it fails its gates. Any other value is ignored with a fixed warning.
  - `style`: the owner's standing direction for every video, a string of at most 1000 characters (otherwise it
    is left out of Claude's copy, with a fixed warning).

  `scripts/motion-brief.sh` reads `authoring` and `preset` and prints only those fixed words. Claude reads the
  rest from disk and treats `style` and `note` as intent to respect (`note` wins when they disagree), never as
  instructions that override the skill's contract or its tool limits.

Steps: validate, install the pinned ffmpeg, `motion/` (`npm ci`, HyperFrames and GSAP pinned exactly in
`motion/package-lock.json`) and Python 3.12, fetch the cover and brief (`scripts/fetch-cover.sh`), prepare the cover
(`scripts/motion-prepare.sh`), let Claude author the scene (see [Authoring](#authoring); skipped without a Claude
credential or with the brief's `authoring` `preset`), then `scripts/motion-decide.sh`: Claude's scene if it passes
every check and gate, else the brief's `preset` or the one `motion/kit/choose.mjs` picks, rendered with `scripts/motion-render.sh` (1920x1080, 30 fps, 240 frames,
`--quality delivery`, 3 workers), encoded and verified with the same `encode.sh`/`verify.sh` as `clip` (start 0,
duration 8) and checked by the quality gates (`scripts/motion-gates.sh`); publish to `videos/<mediaId>/` and call
back. The job times out after 40 minutes (the admin expires a motion job after 40 minutes without a callback):
about 3 for setup and prepare, at most 15 for the author step, at most 11 for Claude's render and gates (else about
5 for the fallback's), about 2 for encoding and publishing.

### Prepare

`scripts/motion-prepare.sh <cover> <out>` runs `motion/prepare/prepare.py` (numpy, Pillow and onnxruntime, CPU) and must
finish within 2 minutes (about 1-2 s of analysis on the runner, plus the first download of the models). It writes:

| File | Content |
| --- | --- |
| `cover.jpg` | The 1920x1080 frame the video starts and ends on. |
| `background.jpg` | Extend mode only: the same frame without the card. |
| `depth.png` | 1920x1080 8-bit depth, 255 = nearest (Depth Anything V2 Small), edges snapped to the picture by a guided filter, then near things grown 2 px past their outline (so a thin near thing keeps its own crisp edge in the parallax); flat inside every face. |
| `faces.json` | Face boxes in `cover.jpg` pixels, `[{"x","y","w","h","score"}]`, `[]` when none (YuNet). |
| `palette.json` | Five dominant colours with their share, plus `light`, `dark` and `accent`. |
| `focus.json` | Focal point `x`, `y` (0..1), its `depth` and `source`: `faces`, or else `saliency` weighted by nearness. |
| `plate.jpg`, `plate-depth.png` | Crop mode only: the cover and its depth with what near edges may hide (within 32 px of a step down in depth) repainted from farther surroundings (push-pull), shown where the parallax reveals it. |
| `edges.png` | 1920x1080 thin salient edges (luminance and depth silhouettes, one line per edge, above the noise floor), for the pencil block. |
| `glow.png` | 480x270 blurred highlights of the cover (of the card in extend mode), for the bloom block. |
| `meta.json` | All of the above for the authoring step (`prepare-2`), plus the framing (extend: the baked shadow), light sources (`lights`: bright spots, brightest first), `tone` (luma, contrast, saturation, warmth, highlights, key dark/mid/light), the depth range, the source size and timings. |

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

Motion kit 2.1 (`kit-2.1`, reference: [`motion/kit/API.md`](motion/kit/API.md)) composes a video from a **scene spec**: a
JSON list of **blocks** with intensity presets (`subtle`, `medium`), parameters and rhythms (`primary` beats,
`reactive` answers, `ambient`, `wave`), validated by `motion/kit/scene.schema.json` (generated from the blocks by
`motion/kit/schema.mjs`) and by `motion/kit/validate.mjs`. `motion/kit/compose/index.html` renders any spec: one WebGL
pass assembled from the base and pixel blocks, plus a 2D overlay. The blocks (`motion/kit/blocks/`, one module each):
`parallax` (2.5D depth parallax with an orbit, drift, tilt or dolly camera around the subject's depth; the occlusion
plate fills what near edges reveal instead of smearing them; on an extended cover a rigid card), `card-float` (the poster
card floats as a rigid, bicubic-sampled plane with its shadow), `light-sweep`, `god-rays` (only where nothing nearer
blocks the light), `stage-beams`, `bloom`, `grain` (anchored to the picture), `colour-breath`, `vignette`, `pencil`
(the brand's pencil drawing: the cover turns into broken contours and form-following hatching on warm paper and back),
`light-pulse` (the beats, or a face's breathing key light) and
`particles`. Six presets in `motion/kit/presets/` (`concert-glow`, `night-stage`, `intimate-portrait`, `poster-float`,
`pencil-reveal`, `sunlit-depth`); `motion/kit/choose.mjs` picks one deterministically from `meta.json` (framing, faces,
tone, lights) for the fallback.

`scripts/motion-assemble.sh <scene-dir> <prepare-dir> <out>` validates `<scene-dir>/scene.json` and builds the HyperFrames
project (the compose page, the kit, custom blocks from `<scene-dir>/blocks/`, the pinned GSAP, the prepared files,
`assets/scene.js` and `assets/spec.js`); `motion-render.sh <scene-dir> <prepare-dir>` assembles and renders it.

Every block is a pure function of t built from whole periods of the loop and multiplied by its rhythm's envelope, which
is exactly zero at t = 0 and t = 8 with zero slope, so frame 0 is the cover pixel for pixel and the last frame runs into
the first; every random choice is seeded. Faces are flat in depth and the camera pivots on the subject, so faces move
as one piece or not at all.

The authoring skill for Claude, [`motion/skills/borodkina-motion/SKILL.md`](motion/skills/borodkina-motion/SKILL.md),
teaches the contract, the work loop (assemble, `hyperframes check`, snapshots at 0/2/4/6/8 s, critique, at most four
iterations), the brand's motion direction and the outputs (`work/scene.json`, optional `work/blocks/*.js`,
`work/REVIEW.md`).

### Authoring

Only when the environment has a Claude credential (`CLAUDE_CODE_OAUTH_TOKEN`, or else `ANTHROPIC_API_KEY`) and the
brief's `authoring` is not `preset` (the step "Read the brief's settings" runs `scripts/motion-brief.sh` first); CI
and forks have none, so their jobs go straight to the fallback.

1. `scripts/motion-author-setup.sh` puts in the checkout `prepare/` (a copy of the prepared cover), `brief.json`, an
   empty `work/`, and `.claude/skills/` with `borodkina-motion` and the official `hyperframes` and `hyperframes-cli`
   skills from the pinned `hyperframes` package (it ships no GSAP skill; nothing is downloaded), and sets
   `CLAUDE_MODEL` from the brief's allow-listed `model`. The step also installs the pinned Bun
   (`scripts/versions.env`; the action's own `oven-sh/setup-bun` is not on this repository's allow-list) and the
   HyperFrames browser.
2. `anthropics/claude-code-action` (v1.0.276, pinned by commit) runs `/borodkina-motion` in automation mode. The
   prompt holds only paths. Limits: 15 minutes, 40 turns, `--permission-mode dontAsk` (every tool not allowed is
   denied) with only `Read(./**)`, `Edit`/`Write` in `work/`, `Skill`, and the exact commands of the skill:
   `node motion/kit/{choose,validate,check-blocks}.mjs`, `bash scripts/motion-assemble.sh work prepare work/project`,
   `npx --prefix motion hyperframes {lint,check,snapshot} work/project ...` and `bash scripts/motion-measure.sh`.
   No web tools, no subagents, no git or shell beyond that. Only this step gets the Claude credential, never R2 or
   callback secrets; `GITHUB_TOKEN` stays `contents: read` and is passed as `github_token`, so the action needs no
   OIDC `id-token` and no GitHub App, and in automation mode it starts none of its GitHub comment or CI tools.
   `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` keeps credentials out of the commands Claude runs. `show_full_output`
   and `display_report` are off, so the transcript never reaches the public log or job summary.
   `continue-on-error`: the step never fails the job.
3. `scripts/motion-decide.sh work <prepare>` decides deterministically. Claude's `work/scene.json` (with
   `work/blocks/*.js`) is used only if it validates against the schema and kit (`validate.mjs`), every custom block
   passes `motion/kit/check-blocks.mjs` (static: kit imports only; no time, randomness, network, page globals or
   code generation) and `hyperframes lint`, and its render passes every quality gate (motion included); then
   `authoring` is `claude` with the model. Anything else, or any change Claude made to the checkout outside
   `work/`, renders the fallback preset (`authoring` `fallback`): the brief's `preset` when valid, else the chooser's. If that preset fails its render or gates, the
   safe scene [`motion/kit/safe.json`](motion/kit/safe.json) is rendered instead (still `authoring` `fallback`): the
   picture stands still (no camera, no geometry change, frame 0 is the cover) while a soft light and the corners
   breathe, and a frame 0 a little under the gate (down to 0.95) only warns. Only a failing safe scene fails the job
   (`render_failed`). The refused composition's details stay in `$WORK_DIR/decide.log`; the log and job summary
   show only a fixed reason: `preset-only` (the brief's `authoring` is `preset`; Claude's step never ran), `no-scene`, `model-not-allowed`, `files`, `scene-invalid`, `blocks-refused`,
   `assemble-failed`, `lint-failed`, `render-failed`, `gates-failed` (or `passed`), and which scene shipped
   (`claude`, the preset's name or `safe-breath`; also in `$WORK_DIR/decision.json`).

### Quality gates

`scripts/motion-gates.sh` fails the job with `render_failed` unless the master and every rendition last 8 s within one
frame, frame 0 matches the prepared cover (SSIM >= 0.98, measured twice: the lossless HyperFrames snapshot at 0 s in
full colour, and frame 0 of the master in luma; HyperFrames captures 4:2:0 JPEG frames and encodes yuv420p, so on a
saturated poster with small coloured lettering the master's colour SSIM falls under 0.98 even when frame 0 was drawn
exactly, which is reported as `ssimFrame0CoverColour` but not gated), the last frame matches frame 0 (SSIM >= 0.98), and five frames
(0, 2, 4, 6, 8 s) snapshotted twice with HyperFrames on software WebGL are pixel-identical (at least SSIM >= 0.999).
It also checks that the composition moves: `scripts/motion-measure.py` scores the luminance change of the 2, 4 and 6 s
snapshots against frame 0 relative to the cover's own gradient (roughly pixels of apparent motion, so a flat cover is
judged as fairly as a textured one); below 0.25 a composition Claude wrote fails, while the fallback only warns, so a
calm fixed preset never fails a job. It writes `$WORK_DIR/gates.json` and a table to the job summary.

Outputs: the same five files as `clip` (`1280.av1.webm`, `640.av1.webm`, `1280.h264.mp4`, `640.h264.mp4`, `poster.webp`),
duration 8 s, and the poster is frame 0, the cover itself.

The success callback carries one more field, read from `$WORK_DIR/motion.json` (refused unless it has exactly these keys):

```json
{"status":"succeeded","renditions":[{"file":"1280.av1.webm","bytes":123}],"poster":{"bytes":456},"durationMs":8000,
 "motion":{"authoring":"fallback","model":null,"kitVersion":"kit-2.1"}}
```

`authoring` is `fallback` (the brief's preset or the one `choose.mjs` picked: no Claude credential, the brief's
`authoring` `preset`, no scene or a refused one) or
`claude` (Claude's scene passed every check and gate; `model` then names the model, `claude-sonnet-5-5` or
`claude-opus-5-5`); `kitVersion` names the composition kit. Error codes: `source_invalid` (cover or brief missing, unreadable or too large),
`render_failed` (the prepare step's setup or analysis, HyperFrames setup, the render itself, the master's 1920x1080 /
30 fps / 240-frame check, a composition whose WebGL context cannot be created, or a failed quality gate),
`encode_failed` (renditions or publishing).

## Setup

Create two GitHub Environments in the repo settings, `dev` and `prod`, each with these secrets:

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`: an R2 API token with object read and write on that bucket.
  The endpoint is `https://<account>.eu.r2.cloudflarestorage.com` (EU jurisdiction), region `auto`.
- `CLIPPER_CALLBACK_SECRET`: the same value the admin uses to verify callbacks for that environment.
- Optional, for the motion author step: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or
  `ANTHROPIC_API_KEY`. Without either, motion jobs render the fallback preset.

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
- The motion author step is the only one with the Claude credential; Claude may only write in `work/` and run
  the kit's own commands, its transcript is never printed, and its output is used only after deterministic checks
  (see [Authoring](#authoring)). Bun for the action is pinned by sha256 like the other tools.
- Only clip videos you have the rights to.

## Tests

`.github/workflows/ci.yml` runs shellcheck, input validation tests (including injection attempts), a real encode of a generated 1080p60 fixture
with all ffprobe assertions, and the publish and callback path against a local S3 stand-in (moto) and a local HMAC-verifying server.
The lint job also runs the motion kit's unit tests (`motion/kit/test/kit.test.mjs`: the schema is generated from the
blocks, every preset is valid, every block is at rest at 0 and 8 s for both intensities, rhythms and camera paths are
loop-safe, the validator refuses broken specs, the chooser) and validates every preset against the schema.
The `motion-render` job runs `tests/motion-kit.test.sh <fixture> <preset>` on six generated covers in
`tests/fixtures/motion` (`make-fixtures.py` draws them; no third-party images): `stage` (16:10 concert, cropped, no faces;
chooses `concert-glow`), `poster` (4:5 drawn portrait with title bars, extended, its drawn face detected; `poster-float`),
`landscape` (2.2:1 hills at dusk, cropped, the sun a light; `sunlit-depth`) and `flat` (an almost uniform dark wash, the
worst case for the motion gate; `night-stage`) and `portrait` (a painted, made-up face lit from the left in a dim room,
cropped, the face detected; `intimate-portrait`) and `vivid` (a 1122x1402 RGBA PNG graphic poster: saturated colour
fields covered in small coloured lettering, extended, no faces; `poster-float`; the frame-0 regression: its master's
colour SSIM must stay under 0.98 while the frame-0 gate passes), each with the chooser's preset, plus `night-stage` and `sunlit-depth`
on `stage` and `pencil-reveal` on `landscape`. With
the chooser it also runs the prepare unit tests (`tests/motion_prepare_test.py`: flat faces in depth, crop keeps faces,
extension, letterbox pairs, palette, near edges grown, occlusion plate, edges, lights and tone, broken images) and checks that a non-image
cover is `source_invalid`; then prepare, the render, encode, verify and the quality gates. The `motion-presets` job
(`tests/motion-presets.test.sh`) snapshots every preset and the safe scene on every fixture at 0, 2, 4, 6 and 8 s without a full render and
checks frame 0, the seam and motion. Timings and gate values go to the job summary; the snapshots are kept as the
`motion-snapshots-<fixture>-<preset>` and `motion-preset-snapshots` artifacts for 14 days (fixtures only, never real covers).
The `motion-decide` job (`tests/motion-decide.test.sh <case>`) tests the choice after the author step without
calling Claude: `fallback` (no `work/scene.json`), `claude` (a hand-written scene with a custom block,
`tests/fixtures/motion/claude-scene`, rendered and gated as Claude's; also `motion-author-setup.sh`) and `invalid`
(broken specs, unsafe blocks, symlinks and stray files refused with their reason, and a full run that renders the
fallback without printing the refused composition) and `safe` (the chosen preset is broken, so the safe scene is
rendered and gated and the job still gets its video). The kit unit tests also cover `check-blocks.mjs`.
The `clip` and `motion` workflows are never triggered by CI.

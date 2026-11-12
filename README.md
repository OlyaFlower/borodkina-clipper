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
`encode_failed` (anything else, also publish errors). Messages are fixed strings of at most 500 characters.
A cancelled or timed-out job (15 minutes) sends no callback; the admin should expire such jobs itself.

## Setup

Create two GitHub Environments in the repo settings, `dev` and `prod`, each with these secrets:

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`: an R2 API token with object read and write on that bucket.
  The endpoint is `https://<account>.eu.r2.cloudflarestorage.com` (EU jurisdiction), region `auto`.
- `CLIPPER_CALLBACK_SECRET`: the same value the admin uses to verify callbacks for that environment.

The admin dispatches with a fine-grained token that has only `Actions: read and write` on this repository.

## Security notes

- The repository is public, so Actions logs are public. Nothing secret is printed; secrets are only set on the steps that need them.
- The only inputs are IDs and numbers. Each is validated by `scripts/validate-inputs.sh` before use, and inputs reach scripts only through `env:`, never through `${{ }}` inside `run:`.
- `callback.mjs` refuses any URL outside the allowed admin prefix for the environment, so the signing secret cannot be sent elsewhere.
- Tools (yt-dlp, ffmpeg) are pinned by version and sha256 in `scripts/versions.env`; third-party actions are pinned by commit SHA.
- Only clip videos you have the rights to.

## Tests

`.github/workflows/ci.yml` runs shellcheck, input validation tests (including injection attempts), a real encode of a generated 1080p60 fixture
with all ffprobe assertions, and the publish and callback path against MinIO and a local HMAC-verifying server.
The `clip` workflow is never triggered by CI.

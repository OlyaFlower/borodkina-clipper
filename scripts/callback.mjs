#!/usr/bin/env node
// Usage: node callback.mjs success <outdir>   (merges $WORK_DIR/motion.json as "motion" if present)
//        node callback.mjs failed            (reads $WORK_DIR/error-code and error-message if present)
// Env: CALLBACK_URL CLIPPER_ENV CLIPPER_CALLBACK_SECRET DURATION_SEC [WORK_DIR]
// Posts a signed JSON callback to the admin. No dependencies. Never prints the secret or the signature.
import { createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PREFIXES = {
  dev: 'https://dev-admin.borodkinamusic.com/api/v1/video-jobs/',
  prod: 'https://admin.borodkinamusic.com/api/v1/video-jobs/',
};
const CODES = ['youtube_blocked', 'source_invalid', 'encode_failed', 'render_failed'];
const RENDITIONS = ['1280.av1.webm', '640.av1.webm', '1280.h264.mp4', '640.h264.mp4'];
const DEFAULT_MESSAGES = {
  youtube_blocked: 'YouTube blocked the download from this runner',
  source_invalid: 'The source video is not usable',
  encode_failed: 'Encoding or publishing the clip failed',
  render_failed: 'Rendering the motion video failed',
};
const AUTHORING = ['fallback', 'claude'];
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,99}$/;

function die(message) {
  console.error(`callback: ${message}`);
  process.exit(1);
}

function callbackUrl() {
  const url = process.env.CALLBACK_URL ?? '';
  const local = process.env.CLIPPER_ALLOW_LOCAL_CALLBACK === '1' && /^http:\/\/127\.0\.0\.1:\d+\//.test(url);
  if (local) return url; // tests only; the workflow never sets this
  const prefix = PREFIXES[process.env.CLIPPER_ENV ?? ''];
  if (!prefix || !url.startsWith(prefix)) die('callback URL is not allowed for this environment');
  if (!/^[A-Za-z0-9_./-]*$/.test(url.slice(prefix.length)) || url.includes('..')) die('callback URL is not allowed');
  return url;
}

function readOptional(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

// Motion jobs describe how the video was authored in $WORK_DIR/motion.json:
// {"authoring":"fallback"|"claude","model":string|null,"kitVersion":string}. Anything else is refused.
function readMotion() {
  const work = process.env.WORK_DIR ?? '';
  if (!work) return undefined;
  const raw = readOptional(join(work, 'motion.json'));
  if (!raw) return undefined;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    die('motion.json is not JSON');
  }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const valid =
    keys.join(',') === 'authoring,kitVersion,model' &&
    AUTHORING.includes(value.authoring) &&
    (value.model === null || (typeof value.model === 'string' && TOKEN.test(value.model))) &&
    typeof value.kitVersion === 'string' &&
    TOKEN.test(value.kitVersion);
  if (!valid) die('motion.json does not match the motion schema');
  return { authoring: value.authoring, model: value.model, kitVersion: value.kitVersion };
}

function buildBody(mode, arg) {
  if (mode === 'success') {
    const dir = arg ?? die('outdir required');
    const renditions = [];
    for (const file of RENDITIONS) {
      try {
        renditions.push({ file, bytes: statSync(join(dir, file)).size });
      } catch {
        /* optional AV1 files may be absent */
      }
    }
    let poster;
    try {
      poster = { bytes: statSync(join(dir, 'poster.webp')).size };
    } catch {
      die('poster.webp missing');
    }
    const seconds = Number(process.env.DURATION_SEC);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 10) die('bad DURATION_SEC');
    const body = { status: 'succeeded', renditions, poster, durationMs: seconds * 1000 };
    const motion = readMotion();
    if (motion) body.motion = motion;
    return body;
  }
  if (mode === 'failed') {
    const work = process.env.WORK_DIR ?? '';
    let error = work ? readOptional(join(work, 'error-code')) : '';
    if (!CODES.includes(error)) error = 'encode_failed';
    let message = work ? readOptional(join(work, 'error-message')) : '';
    if (!message) message = DEFAULT_MESSAGES[error];
    message = message.replace(/[^\x20-\x7e]/g, ' ').slice(0, 500);
    return { status: 'failed', error, message };
  }
  return die('mode must be success or failed');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const secret = process.env.CLIPPER_CALLBACK_SECRET;
  if (!secret) die('CLIPPER_CALLBACK_SECRET is not set');
  const url = callbackUrl();
  const rawBody = JSON.stringify(buildBody(process.argv[2], process.argv[3]));
  const baseDelay = Number(process.env.CLIPPER_RETRY_DELAY_MS ?? 2000);
  const attempts = 4; // first try plus 3 retries

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
    let retry = true;
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-clipper-timestamp': timestamp,
          'x-clipper-signature': signature,
        },
        body: rawBody,
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        console.log(`callback delivered (HTTP ${response.status})`);
        return;
      }
      console.error(`callback attempt ${attempt}: HTTP ${response.status}`);
      retry = response.status >= 500;
    } catch (error) {
      console.error(`callback attempt ${attempt}: network error (${error?.name ?? 'error'})`);
    }
    if (!retry || attempt === attempts) break;
    await sleep(baseDelay * 2 ** (attempt - 1));
  }
  die('callback was not delivered');
}

await main();

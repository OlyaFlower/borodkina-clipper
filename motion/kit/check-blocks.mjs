// Static checks of the custom blocks Claude may write (work/blocks/<name>.js, used as custom/<name>):
//   node motion/kit/check-blocks.mjs <blocks-dir>
// A missing directory is fine (no custom blocks). Every entry must be a plain file named
// [a-z][a-z0-9-]*.js of at most 64 KiB, at most 8 of them, and its source must keep the block contract
// (API.md) in a form a scan can see:
//   - imports only `import { ... } from '../kit/lib/<module>.js'` (or '../kit/blocks/<block>.js');
//   - a default export with stage 'pixel' or 'overlay';
//   - none of the words that bring time, randomness, the network, the page or code generation in:
//     Math.random, Date, performance, timers, fetch and friends, window/document/globalThis,
//     eval/Function/constructor, storage, process/require and so on. They are refused anywhere in the
//     file, comments and GLSL included, so a block can never depend on them by accident.
// This is a guard for determinism and containment, not a sandbox: the render runs in headless Chrome
// on a runner step that holds no secrets, and the gates check frame 0, the seam and determinism.
// Prints "ok <n> block(s)" or the problems, and exits 1 on any problem.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_BLOCKS = 8;
export const MAX_BYTES = 64 * 1024;
const NAME = /^[a-z][a-z0-9-]*\.js$/;
const IMPORT = /^import\s*\{[\w\s,]*\}\s*from\s*'\.\.\/kit\/(lib|blocks)\/[a-z][a-z0-9-]*\.js'\s*;?$/;

/** [regex, what it is] for every construct a block must not use. */
const FORBIDDEN = [
  [/\bMath\s*\.\s*random\b/, 'Math.random (use kit.random() at setup)'],
  [/\bMath\s*\[/, 'computed access on Math'],
  [/\bDate\b/, 'Date'],
  [/\bperformance\b/, 'performance'],
  [/\b(requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|setImmediate|queueMicrotask|requestIdleCallback)\b/, 'timers'],
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|WebTransport)\b/, 'the network'],
  [/\b(window|document|globalThis|self|navigator|location|opener)\b/, 'the page or browser globals'],
  [/\b(Worker|SharedWorker|ServiceWorker|importScripts|postMessage|BroadcastChannel|MessageChannel)\b/, 'workers and messaging'],
  [/\b(localStorage|sessionStorage|indexedDB|caches)\b/, 'storage'],
  [/\b(eval|Function|constructor|prototype|__proto__|Reflect|Proxy|WebAssembly|Atomics|SharedArrayBuffer|fromCharCode)\b/, 'code generation or reflection'],
  [/\b(crypto|Image|OffscreenCanvas|createElement|FontFace|atob|btoa|TextDecoder)\b/, 'other browser APIs'],
  [/\b(process|require|Buffer|Deno|Bun)\b/, 'runtime globals'],
  [/\bimport\s*\(/, 'dynamic import'],
  [/\bimport\s*\.\s*meta\b/, 'import.meta'],
  [/\bexport\s*\*|\bexport\s*\{[^}]*\}\s*from\b/, 're-exports'],
  [/\b(https?|wss?|data|blob|file):/, 'a URL'],
  [/[\w$)\]]\s*\[\s*['"`]/, 'computed property access with a string'],
];

/** Returns the problems of one block source (empty when it passes). */
export function checkBlockSource(name, source) {
  const problems = [];
  const say = (m) => problems.push(`${name}: ${m}`);
  if (!NAME.test(name)) say('the file name must be [a-z][a-z0-9-]*.js');
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) say('larger than 64 KiB');
  if (/[^\t\n\r\x20-\x7e]/.test(source)) say('only printable ASCII is allowed');
  // Imports: one per line, static, named, from the kit. The word import may appear nowhere else.
  const lines = source.split('\n');
  const rest = [];
  lines.forEach((line, i) => {
    const l = line.trim();
    if (/^import\b/.test(l)) {
      if (!IMPORT.test(l)) say(`line ${i + 1}: only "import { ... } from '../kit/lib/<module>.js'" on one line is allowed`);
    } else {
      rest.push(line);
    }
  });
  if (/\bimport\b/.test(rest.join('\n'))) say('the word import may only start a static import line');
  for (const [re, what] of FORBIDDEN) {
    const m = re.exec(source);
    if (m) {
      const line = source.slice(0, m.index).split('\n').length;
      say(`line ${line}: ${what} is not allowed ("${m[0]}")`);
    }
  }
  if (!/\bexport\s+default\b/.test(source)) say('no default export');
  if (!/\bstage\s*:\s*'(pixel|overlay)'/.test(source)) say("stage must be 'pixel' or 'overlay'");
  if (!/\bsetup\s*\(/.test(source)) say('no setup(kit, params)');
  return problems;
}

/** Returns the problems of a blocks directory (empty when it is missing or every block passes). */
export function checkBlocksDir(dir) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    return [`cannot read ${dir}: ${e.code ?? e.message}`];
  }
  const problems = [];
  if (names.length > MAX_BLOCKS) problems.push(`at most ${MAX_BLOCKS} custom blocks (found ${names.length})`);
  for (const name of names) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile()) {
      problems.push(`${name}: not a plain file`);
      continue;
    }
    if (st.size > MAX_BYTES) {
      problems.push(`${name}: larger than 64 KiB`);
      continue;
    }
    problems.push(...checkBlockSource(name, readFileSync(path, 'utf8')));
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node motion/kit/check-blocks.mjs <blocks-dir>');
    process.exit(2);
  }
  const problems = checkBlocksDir(dir);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  let n = 0;
  try {
    n = readdirSync(dir).length;
  } catch {
    /* no blocks */
  }
  console.log(`ok ${n} block(s)`);
}

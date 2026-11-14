// Unit tests of motion kit 2 that need no browser: node motion/kit/test/kit.test.mjs
// (with motion/node_modules installed, for ajv).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CAMERAS, DURATION, HEIGHT, RHYTHMS, WIDTH, beatsAreLoopSafe, cameraPath, envelope, mulberry32, stepped } from '../lib/loop.js';
import { blockUniforms, fragmentShader, prefixed } from '../lib/gl.js';
import { checkSpec, colour, lightColour } from '../lib/spec.js';
import { buildSchema, kitBlocks } from '../schema.mjs';
import { validate } from '../validate.mjs';
import { PRESETS, choose } from '../choose.mjs';
import { checkBlockSource } from '../check-blocks.mjs';

const kitDir = new URL('../', import.meta.url);
const blocks = await kitBlocks();
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const meta = (over = {}) => ({
  framing: { mode: 'crop', coverBox: [0, 0, WIDTH, HEIGHT] },
  faces: [],
  focus: { x: 0.5, y: 0.6, depth: 0.55, source: 'saliency' },
  palette: {
    colors: ['#301743', '#0c0914', '#9b4e7f', '#5b3b75', '#e181bc'].map((hex) => ({ hex, share: 0.2 })),
    light: '#e181bc',
    dark: '#0c0914',
    accent: '#e181bc',
  },
  lights: [{ x: 0.5, y: 0.6, r: 0.07, luma: 0.77, hex: '#fdf5fb' }],
  tone: { luma: 0.23, contrast: 0.18, saturation: 0.2, warmth: 0, highlights: 0.02, key: 'dark' },
  depth: { range: [0, 0.95] },
  ...over,
});
const extendMeta = () =>
  meta({
    framing: { mode: 'extend', coverBox: [571, 54, 1349, 1026], shadow: { dy: 12, sigma: 36, strength: 0.6 } },
    files: { background: 'background.jpg' },
  });

/** The kit object compose.js hands to setup(), without the browser. */
function fakeKit(m, timing, beats, base = null) {
  const mode = m.framing.mode;
  return {
    scene: m,
    spec: {},
    mode,
    width: WIDTH,
    height: HEIGHT,
    duration: DURATION,
    beats,
    seed: 7,
    random: mulberry32(7),
    envelope: (t) => envelope(t, timing, beats),
    rhythm: (t, rhythm) => envelope(t, { rhythm }, beats),
    colour: (v) => colour(v, m),
    light: (v) => lightColour(v, m),
    focus: m.focus,
    focusDepth: mode === 'extend' ? 0.4 : m.focus.depth,
    faces: m.faces,
    lights: m.lights,
    card: mode === 'extend' ? m.framing.coverBox : null,
    camera: (t) => base?.camera?.(t) ?? { x: 0, y: 0, z: 0 },
    cardRect: (t) => base?.cardRect?.(t) ?? m.framing.coverBox,
  };
}

const isZero = (v) => (typeof v === 'number' ? v === 0 : Array.from(v).every((x) => x === 0));

test('the committed schema is generated from the blocks', () => {
  const committed = JSON.parse(readFileSync(new URL('scene.schema.json', kitDir), 'utf8'));
  assert.deepEqual(committed, buildSchema(blocks), 'run: node motion/kit/schema.mjs > motion/kit/scene.schema.json');
});

test('every preset is valid and the chooser only names presets that exist', async () => {
  const files = readdirSync(new URL('presets/', kitDir)).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files.map((f) => f.replace(/\.json$/, '')).sort(), [...PRESETS].sort());
  for (const f of files) {
    const spec = JSON.parse(readFileSync(new URL(`presets/${f}`, kitDir), 'utf8'));
    assert.equal(spec.name, f.replace(/\.json$/, ''));
    const m = spec.blocks[0].block === 'card-float' ? extendMeta() : meta();
    assert.deepEqual(await validate(spec, m), [], f);
  }
});

test('crop presets also run on an extended cover (the parallax base becomes a rigid card)', async () => {
  for (const name of PRESETS.filter((p) => p !== 'poster-float')) {
    const spec = JSON.parse(readFileSync(new URL(`presets/${name}.json`, kitDir), 'utf8'));
    assert.deepEqual(await validate(spec, extendMeta()), [], name);
  }
});

test('the validator refuses broken specs', async () => {
  const ok = { kit: 'kit-2', name: 'x', blocks: [{ block: 'parallax' }, { block: 'grain' }] };
  assert.deepEqual(await validate(ok, meta()), []);
  const bad = async (spec, m = meta()) => assert.notDeepEqual(await validate(spec, m), [], JSON.stringify(spec));
  await bad({ ...ok, kit: 'kit-1' });
  await bad({ ...ok, blocks: [{ block: 'grain' }] }); // no base first
  await bad({ ...ok, blocks: [{ block: 'parallax' }, { block: 'parallax' }] }); // two bases
  await bad({ ...ok, blocks: [{ block: 'parallax', params: { amount: 99 } }] }); // out of range
  await bad({ ...ok, blocks: [{ block: 'parallax', params: { nope: 1 } }] }); // unknown param
  await bad({ ...ok, blocks: [{ block: 'parallax', preset: 'loud' }] });
  await bad({ ...ok, blocks: [{ block: 'card-float' }] }, meta()); // card on a crop cover
  await bad({ ...ok, beats: [0.2] }); // beat across the seam
  await bad({ ...ok, beats: [6.5] });
  await bad({ ...ok, blocks: [{ block: 'parallax' }, { block: 'light-pulse', timing: { rhythm: 'primary', delay: 1 } }], beats: [5.6] });
  await bad({ ...ok, blocks: [{ block: '../evil' }] });
  await bad({ ...ok, blocks: [{ block: 'custom/Evil' }] });
  assert.deepEqual(await validate({ ...ok, blocks: [{ block: 'parallax' }, { block: 'custom/ripple', params: { any: 1 } }] }, meta()), []);
});

test('the chooser is deterministic and covers the fixtures', () => {
  assert.equal(choose(extendMeta()).preset, 'poster-float');
  assert.equal(choose(meta({ faces: [{ x: 1, y: 1, w: 100, h: 100, score: 0.9 }] })).preset, 'intimate-portrait');
  assert.equal(choose(meta()).preset, 'concert-glow');
  assert.equal(choose(meta({ lights: [], tone: { luma: 0.15, key: 'dark', highlights: 0 } })).preset, 'night-stage');
  assert.equal(choose(meta({ lights: [{ x: 0.6, y: 0.5, luma: 0.98 }], tone: { luma: 0.35, key: 'mid' } })).preset, 'sunlit-depth');
  assert.equal(choose(meta({ lights: [], tone: { luma: 0.7, key: 'light' } })).preset, 'pencil-reveal');
  assert.deepEqual(choose(meta()), choose(meta()));
});

test('rhythms are zero with zero slope at both ends of the loop', () => {
  for (const beats of [[], [2, 5.6], [3.6]]) {
    for (const rhythm of RHYTHMS) {
      for (const delay of [0, 0.4]) {
        const e = (t) => envelope(t, { rhythm, delay }, beats);
        assert.equal(e(0), 0, `${rhythm} at 0`);
        assert.equal(e(DURATION), 0, `${rhythm} at 8`);
        assert.ok(e(1 / 30) < 0.01 && e(DURATION - 1 / 30) < 0.01, `${rhythm} ${beats} near the seam`);
      }
    }
  }
  assert.ok(beatsAreLoopSafe([2, 5.6]) && !beatsAreLoopSafe([0.4]) && !beatsAreLoopSafe([6.5]));
});

test('camera paths start at rest and loop with matching speed', () => {
  for (const kind of CAMERAS) {
    const a = cameraPath(kind, 0);
    const b = cameraPath(kind, DURATION);
    for (const k of ['x', 'y', 'z']) {
      assert.ok(Math.abs(a[k]) < 1e-12 && Math.abs(b[k]) < 1e-9, `${kind}.${k} at the ends`);
      const v0 = (cameraPath(kind, 0.01)[k] - a[k]) / 0.01;
      const v1 = (b[k] - cameraPath(kind, DURATION - 0.01)[k]) / 0.01;
      assert.ok(Math.abs(v0 - v1) < 0.02, `${kind}.${k} speed across the seam ${v0} vs ${v1}`);
    }
  }
  assert.equal(stepped(0), 0);
  assert.equal(stepped(DURATION), 0);
});

test('every block is identity at t = 0 and t = 8 for both intensities', () => {
  const beats = [2, 5.6];
  for (const [name, block] of Object.entries(blocks)) {
    for (const m of [meta(), extendMeta()]) {
      if (block.modes && !block.modes.includes(m.framing.mode)) continue;
      for (const preset of ['subtle', 'medium']) {
        const [{ params, timing }] = checkSpec(
          { kit: 'kit-2', blocks: block.stage === 'base' ? [{ block: name, preset }] : [{ block: 'parallax' }, { block: name, preset }] },
          blocks,
          m,
        ).slice(block.stage === 'base' ? 0 : 1);
        const baseInst = blocks.parallax.setup(fakeKit(m, { rhythm: 'ambient' }, beats), { camera: 'orbit', amount: 16, push: 0.01, pivot: 'subject' });
        const inst = block.setup(fakeKit(m, timing, beats, baseInst), params);
        for (const t of [0, DURATION]) {
          const env = envelope(t, timing, beats);
          if (block.stage === 'overlay') {
            let fills = 0;
            const ctx = new Proxy({}, { get: (_, k) => (k === 'fill' ? () => fills++ : () => ({ addColorStop() {} })) });
            inst.draw(ctx, t, env);
            assert.equal(fills, 0, `${name} draws at t=${t}`);
            continue;
          }
          const u = inst.uniforms(t, env);
          const declared = blockUniforms(block.glsl);
          for (const k of Object.keys(u)) assert.ok(k in declared, `${name} sets undeclared ${k}`);
          for (const k of block.rest ?? []) {
            if (k in u) assert.ok(isZero(u[k]), `${name} (${preset}, ${m.framing.mode}) ${k} = ${u[k]} at t=${t}`);
          }
        }
        // and something does change in the middle of the loop
        if (block.stage !== 'overlay') {
          const mid = inst.uniforms(4, envelope(4, timing, [4]));
          assert.ok((block.rest ?? []).some((k) => k in mid && !isZero(mid[k])), `${name} does nothing at 4 s`);
        }
      }
    }
  }
});

test('the shader assembles every block with its own prefix', () => {
  const gl = Object.entries(blocks).filter(([, b]) => b.stage !== 'overlay');
  const src = fragmentShader(gl.map(([name, b]) => ({ name, stage: b.stage, glsl: b.glsl })), { extend: false });
  assert.ok(!src.includes('$'), 'no $ left');
  assert.ok(src.includes('#define KIT_EXTEND 0'));
  assert.equal(prefixed('uniform float $a; $f($a)', 'b3_'), 'uniform float b3_a; b3_f(b3_a)');
  assert.deepEqual(blockUniforms('uniform vec4 $beam[4];\nuniform float $amount;'), {
    beam: { type: 'vec4', size: 4 },
    amount: { type: 'float', size: 0 },
  });
});

test('seeded randomness repeats', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('the custom block check passes kit-style blocks and refuses unsafe ones', () => {
  // Every kit pixel and overlay block, importing the kit the way a custom block does, passes.
  for (const f of readdirSync(new URL('blocks/', kitDir)).filter((f) => f.endsWith('.js'))) {
    const src = readFileSync(new URL(`blocks/${f}`, kitDir), 'utf8').replaceAll("'../lib/", "'../kit/lib/");
    if (/stage: 'base'/.test(src)) continue;
    assert.deepEqual(checkBlockSource(f, src), [], f);
  }
  const halo = readFileSync(new URL('../../tests/fixtures/motion/claude-scene/blocks/halo.js', kitDir), 'utf8');
  assert.deepEqual(checkBlockSource('halo.js', halo), []);
  const refused = (src, name = 'bad.js') => assert.notDeepEqual(checkBlockSource(name, src), [], src);
  const body = (code) => `export default { stage: 'pixel', setup(kit, params) { ${code} } };`;
  assert.deepEqual(checkBlockSource('ok.js', body('const a = [1]; return { uniforms: (t, env) => ({ a: a[0] * env }) };')), []);
  refused(halo, 'Halo.js');
  refused(body(''), 'bad.mjs');
  refused(body('return { uniforms: (t, env) => ({ a: Math.random() * env }) };'));
  refused(body('const now = Date.now();'));
  refused(body('const n = performance.now();'));
  refused(body("fetch('x');"));
  refused(body("new Image().src = 'x';"));
  refused(body('const g = globalThis;'));
  refused(body("const f = (() => 0)['constructor'];"));
  refused(body("const f = kit[`x${'y'}`];"));
  refused(body("const u = 'https://example.com/';"));
  refused(body("const m = await import('../kit/lib/loop.js');"));
  refused(body('setTimeout(() => 0, 1);'));
  refused(body('const s = String.fromCharCode(102);'));
  refused(`import { phase } from 'https://example.com/loop.js';\n${body('')}`);
  refused(`import * as loop from '../kit/lib/loop.js';\n${body('')}`);
  refused(`import {\n  phase,\n} from '../kit/lib/loop.js';\n${body('')}`);
  refused("export default { stage: 'base', setup() {} };");
  refused("export default { stage: 'pixel' };");
  refused(body('').replace('export default', 'const block ='));
  refused(body('const x = 1; // café'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} kit tests passed`);
process.exit(failed ? 1 : 0);

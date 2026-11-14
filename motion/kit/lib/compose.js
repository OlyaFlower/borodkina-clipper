// The scene-spec engine behind motion/kit/compose/index.html: loads the blocks a spec names, checks the
// spec, assembles one fragment shader from the GL blocks and draws the overlay blocks on a 2D canvas.
// Every frame is a pure function of t (see API.md for the block contract).

import { DURATION, HEIGHT, WIDTH, envelope, mulberry32 } from './loop.js';
import { TEXTURES, blockUniforms, fragmentShader, program, setUniform, texture } from './gl.js';
import { CUSTOM_PREFIX, KIT_BLOCKS, checkSpec, colour, lightColour } from './spec.js';
import { loadImage, run, scene as readScene } from './scene.js';

/** Imports every block a spec names: kit blocks from kit/blocks/, custom/<name> from blocks/<name>.js. */
export async function loadBlocks(spec) {
  const out = {};
  for (const name of new Set((spec?.blocks ?? []).map((b) => b?.block))) {
    let url;
    if (typeof name === 'string' && name.startsWith(CUSTOM_PREFIX) && /^[a-z][a-z0-9-]*$/.test(name.slice(CUSTOM_PREFIX.length))) {
      url = new URL(`../../blocks/${name.slice(CUSTOM_PREFIX.length)}.js`, import.meta.url);
    } else if (KIT_BLOCKS.includes(name)) {
      url = new URL(`../blocks/${name}.js`, import.meta.url);
    } else {
      throw new Error(`motion kit: unknown block ${name}`);
    }
    const mod = (await import(url.href)).default;
    if (!mod || typeof mod.setup !== 'function') throw new Error(`motion kit: block ${name} has no default export with setup()`);
    if (name.startsWith(CUSTOM_PREFIX) && mod.stage !== 'pixel' && mod.stage !== 'overlay')
      throw new Error(`motion kit: custom block ${name} must be a pixel or overlay block`);
    if ((mod.stage === 'pixel' || mod.stage === 'base') && typeof mod.glsl !== 'string')
      throw new Error(`motion kit: block ${name} has no glsl`);
    out[name] = { ...mod, name };
  }
  return out;
}

const seedOf = (spec, i) => ((spec.seed ?? 20261114) + Math.imul(i + 1, 0x9e3779b1)) | 0;
const at = (t) => Math.min(Math.max(t, 0), DURATION);

/** Builds the scene; resolves to the list of draw(t) functions run() calls every frame. */
async function build() {
  const meta = readScene();
  const spec = window.__MOTION_SPEC;
  const blocks = await loadBlocks(spec);
  const resolved = checkSpec(spec, blocks, meta);
  const beats = spec.beats ?? [];

  const files = meta.files ?? {};
  const wanted = {
    tCover: files.cover ?? 'cover.jpg',
    tDepth: files.depth ?? 'depth.png',
    tPlate: files.plate,
    tPlateDepth: files.plateDepth,
    tBackground: files.background,
    tEdges: files.edges,
    tGlow: files.glow,
  };
  const images = {};
  await Promise.all(
    Object.entries(wanted).map(async ([k, file]) => {
      images[k] = file ? await loadImage(`assets/${file}`) : null;
    }),
  );
  images.tPlate ??= images.tCover;
  images.tPlateDepth ??= images.tDepth;
  images.tBackground ??= images.tCover;

  const mode = meta.framing?.mode === 'extend' && files.background ? 'extend' : 'crop';
  const box = meta.framing?.coverBox ?? [0, 0, WIDTH, HEIGHT];
  let base = null;
  const instances = resolved.map((r, i) => {
    const kit = {
      scene: meta,
      spec,
      mode,
      width: WIDTH,
      height: HEIGHT,
      duration: DURATION,
      beats,
      seed: seedOf(spec, i),
      random: mulberry32(seedOf(spec, i)),
      envelope: (t) => envelope(at(t), r.timing, beats),
      rhythm: (t, rhythm) => envelope(at(t), { rhythm }, beats),
      colour: (value) => colour(value, meta),
      light: (value) => lightColour(value, meta),
      focus: meta.focus ?? { x: 0.5, y: 0.5, depth: 0.5 },
      focusDepth: mode === 'extend' ? 0.4 : (meta.focus?.depth ?? 0.5),
      faces: meta.faces ?? [],
      lights: meta.lights ?? [],
      card: mode === 'extend' ? box : null,
      // Set by the base block: the camera offset (px per unit of depth) and the card's rectangle at t.
      camera: (t) => base?.camera?.(t) ?? { x: 0, y: 0, z: 0 },
      cardRect: (t) => base?.cardRect?.(t) ?? (mode === 'extend' ? box : null),
    };
    const inst = r.block.setup(kit, r.params);
    if (r.block.stage === 'base') base = inst;
    return { ...r, inst };
  });

  // ---- one WebGL pass for the base and pixel blocks
  const canvas = document.getElementById('kit-image');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('motion kit: WebGL is unavailable');  const glBlocks = instances.filter((b) => b.block.stage === 'base' || b.block.stage === 'pixel');
  const prog = program(
    gl,
    fragmentShader(
      glBlocks.map((b) => ({ name: b.name, stage: b.block.stage, glsl: b.block.glsl })),
      { extend: mode === 'extend' },
    ),
  );
  Object.keys(TEXTURES).forEach((name, unit) => {
    const lum = name === 'tDepth' || name === 'tPlateDepth' || name === 'tEdges';
    texture(gl, unit, images[name], lum ? gl.LUMINANCE : gl.RGB);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  });
  gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), WIDTH, HEIGHT);
  const uTime = gl.getUniformLocation(prog, 'uTime');
  const bound = glBlocks.map((b, i) => {
    const decl = blockUniforms(b.block.glsl);
    const locs = {};
    for (const name of Object.keys(decl)) {
      const suffix = decl[name].size ? '[0]' : '';
      locs[name] = gl.getUniformLocation(prog, `b${i}_${name}${suffix}`);
    }
    return { ...b, decl, locs };
  });
  gl.viewport(0, 0, WIDTH, HEIGHT);

  // ---- overlay blocks on a 2D canvas, screen-blended over the picture (CSS)
  const overlay = document.getElementById('kit-overlay');
  overlay.width = WIDTH;
  overlay.height = HEIGHT;
  const ctx = overlay.getContext('2d');
  const overlays = instances.filter((b) => b.block.stage === 'overlay');

  window.__motionKit = {
    spec: spec.name ?? null,
    blocks: instances.map((b) => b.name),
    /** The envelope of every block at t: all 0 at t = 0 and t = 8. */
    envelopes: (t) => instances.map((b) => envelope(at(t), b.timing, beats)),
  };

  const drawGl = (t) => {
    const time = at(t);
    gl.uniform1f(uTime, time);
    for (const b of bound) {
      const values = b.inst.uniforms(time, envelope(time, b.timing, beats)) ?? {};
      for (const [name, value] of Object.entries(values)) {
        if (!(name in b.decl)) throw new Error(`motion kit: block ${b.name} sets undeclared uniform ${name}`);
        setUniform(gl, b.locs[name], b.decl[name], value);
      }
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const drawOverlay = (t) => {
    const time = at(t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    for (const b of overlays) {
      ctx.save();
      b.inst.draw(ctx, time, envelope(time, b.timing, beats));
      ctx.restore();
    }
  };
  return [drawGl, drawOverlay];
}

/** Registers the composition `compositionId` (see compose/index.html). */
export function compose(compositionId) {
  run(compositionId, build);
}

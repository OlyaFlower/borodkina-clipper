// Scene specs: resolving a block's parameters (defaults, then its intensity preset, then the spec's
// own params) and checking a spec against the blocks it names. Runs in the browser (compose.js) and in
// Node (choose.mjs, validate.mjs, tests): no DOM here.

import { KIT_VERSION, RHYTHMS, beatsAreLoopSafe, mix, rgb, tint } from './loop.js';

/** The blocks of the kit, by name (files in motion/kit/blocks/<name>.js). */
export const KIT_BLOCKS = [
  'parallax',
  'card-float',
  'light-sweep',
  'god-rays',
  'stage-beams',
  'bloom',
  'grain',
  'colour-breath',
  'vignette',
  'pencil',
  'light-pulse',
  'particles',
];

export const INTENSITIES = ['subtle', 'medium'];
export const CUSTOM_PREFIX = 'custom/';
export const CUSTOM_RE = /^custom\/[a-z][a-z0-9-]{0,39}$/;

/** Named colours a block parameter of type colour accepts, besides '#rrggbb'. */
export const NAMED_COLOURS = ['light', 'dark', 'accent', 'c0', 'c1', 'c2', 'c3', 'c4', 'warm', 'paper', 'graphite', 'white'];
const FIXED = { warm: '#ffe6c2', paper: '#f3eadb', graphite: '#38342f', white: '#ffffff' };

/** A named or hex colour as [r, g, b] 0..1, using the prepared palette. */
export function colour(value, scene) {
  const pal = scene?.palette ?? {};
  if (typeof value === 'string' && value.startsWith('#')) return rgb(value);
  if (FIXED[value]) return rgb(FIXED[value]);
  if (/^c[0-4]$/.test(value)) return rgb(pal.colors?.[Number(value[1])]?.hex ?? pal.light);
  if (value === 'light' || value === 'dark' || value === 'accent') {
    const c = rgb(pal[value]);
    // Light is lifted towards white so it reads as light, never as paint.
    return value === 'dark' ? c : mix(c, [1, 1, 1], value === 'light' ? 0.35 : 0.2);
  }
  return [1, 1, 1];
}

/**
 * The same colour as emitted light: its hue at full brightness (brightest channel 1), a fifth of the
 * way to white, so a dull brown palette still gives a warm lamp, never grey haze.
 */
export function lightColour(value, scene) {
  return mix(tint(colour(value, scene)), [1, 1, 1], 0.2);
}

function checkParam(block, key, decl, value, where) {
  const fail = (msg) => {
    throw new Error(`${where}: ${block}.${key} ${msg}`);
  };
  switch (decl.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('must be a number');
      if (value < decl.min || value > decl.max) fail(`must be within ${decl.min}..${decl.max} (got ${value})`);
      break;
    case 'enum':
      if (!decl.values.includes(value)) fail(`must be one of ${decl.values.join(', ')} (got ${value})`);
      break;
    case 'colour':
      if (typeof value !== 'string' || !(NAMED_COLOURS.includes(value) || /^#[0-9a-fA-F]{6}$/.test(value)))
        fail(`must be #rrggbb or one of ${NAMED_COLOURS.join(', ')}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('must be true or false');
      break;
    default:
      fail(`has an unknown parameter type ${decl.type}`);
  }
}

/** Defaults, then the intensity preset, then the spec's params; every value checked. */
export function resolveParams(block, entry, where = 'scene') {
  const out = {};
  for (const [k, d] of Object.entries(block.params)) out[k] = d.default;
  const preset = entry.preset ?? 'subtle';
  if (!block.presets?.[preset]) throw new Error(`${where}: ${block.name} has no intensity preset ${preset}`);
  Object.assign(out, block.presets[preset]);
  for (const [k, v] of Object.entries(entry.params ?? {})) {
    if (!(k in block.params)) throw new Error(`${where}: ${block.name} has no parameter ${k}`);
    out[k] = v;
  }
  for (const [k, v] of Object.entries(out)) checkParam(block.name, k, block.params[k], v, where);
  return out;
}

/**
 * Checks a spec against the loaded blocks ({ name: module }) and the prepared scene (meta.json).
 * Throws an Error naming the first problem. Returns the resolved blocks:
 *   [{ name, block, params, timing }]
 */
export function checkSpec(spec, blocks, scene) {
  const where = `scene ${spec?.name ?? '(unnamed)'}`;
  if (!spec || typeof spec !== 'object') throw new Error('scene: the spec is not an object');
  if (spec.kit !== KIT_VERSION) throw new Error(`${where}: kit must be ${KIT_VERSION}`);
  if (!Array.isArray(spec.blocks) || spec.blocks.length < 1 || spec.blocks.length > 12)
    throw new Error(`${where}: blocks must list 1 to 12 blocks`);
  const beats = spec.beats ?? [];
  if (!Array.isArray(beats) || beats.length > 3 || beats.some((b) => typeof b !== 'number'))
    throw new Error(`${where}: beats must be up to 3 times in seconds`);
  if (!beatsAreLoopSafe(beats)) throw new Error(`${where}: every beat must lie strictly within 0.5..6.4 s to stay loop-safe`);
  const mode = scene?.framing?.mode ?? 'crop';
  const out = spec.blocks.map((entry, i) => {
    const at = `${where} block ${i}`;
    const block = blocks[entry.block];
    if (!block) throw new Error(`${at}: unknown block ${entry.block}`);
    if (i === 0 && block.stage !== 'base') throw new Error(`${at}: the first block must be a base block (parallax, card-float)`);
    if (i > 0 && block.stage === 'base') throw new Error(`${at}: only the first block may be a base block`);
    if (block.modes && !block.modes.includes(mode))
      throw new Error(`${at}: ${entry.block} does not work on a ${mode} cover (only ${block.modes.join(', ')})`);
    const timing = { rhythm: block.rhythm ?? 'ambient', delay: 0, ...(entry.timing ?? {}) };
    if (!RHYTHMS.includes(timing.rhythm)) throw new Error(`${at}: rhythm must be one of ${RHYTHMS.join(', ')}`);
    if (typeof timing.delay !== 'number' || Math.abs(timing.delay) > 1) throw new Error(`${at}: delay must be within -1..1 s`);
    if ((timing.rhythm === 'primary' || timing.rhythm === 'reactive') && beats.length && !beatsAreLoopSafe(beats, timing.delay))
      throw new Error(`${at}: the delay pushes a beat across the loop seam`);
    return { name: entry.block, block, params: resolveParams(block, entry, at), timing };
  });
  return out;
}

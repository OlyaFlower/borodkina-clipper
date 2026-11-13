// Time helpers for 8-second seamless loops. Every function is pure in t (seconds): the frame at t is
// the same however the renderer seeks, and t = 0 and t = DURATION give the same picture.

export const KIT_VERSION = 'kit-1';
export const DURATION = 8;
export const WIDTH = 1920;
export const HEIGHT = 1080;

const TAU = Math.PI * 2;

/** Loop phase in radians, 0 at t = 0, one full turn at t = DURATION. */
export const phase = (t) => (TAU * t) / DURATION;

/** sin^2(pi t / D): 0 at both ends with zero slope, 1 in the middle. For one passing event per loop. */
export const swell = (t) => Math.sin((Math.PI * t) / DURATION) ** 2;

const smoothstep = (a, b, x) => {
  const k = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return k * k * (3 - 2 * k);
};

/** 0 at both ends (zero slope), 1 between `ramp` and D - ramp. For effects that stay on. */
export const plateau = (t, ramp = 1.2) => smoothstep(0, ramp, t) * smoothstep(0, ramp, DURATION - t);

/**
 * The camera offset of a tiny orbit, in units of the amplitudes: an ellipse that passes through
 * (0, 0) at t = 0, goes out to (2, 0) at mid-loop and comes back. Smooth and periodic, so the
 * motion has no jump and no change of speed at the loop seam.
 */
export const orbit = (t) => {
  const u = phase(t);
  return { x: 1 - Math.cos(u), y: -Math.sin(u) };
};

/** mulberry32: a small seeded PRNG, so every "random" choice is the same in every render. */
export const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
};

/** '#rrggbb' -> [r, g, b] in 0..1. */
export const rgb = (hex) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? [1, 2, 3].map((i) => parseInt(m[i], 16) / 255) : [1, 1, 1];
};

/** Mixes two [r, g, b] colours. */
export const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

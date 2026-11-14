// Time helpers for 8-second seamless loops. Every function is pure in t (seconds): the frame at t is
// the same however the renderer seeks, and t = 0 and t = DURATION give the same picture.

export const KIT_VERSION = 'kit-2';
export const DURATION = 8;
export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;

const TAU = Math.PI * 2;

export const clamp = (x, a = 0, b = 1) => Math.min(Math.max(x, a), b);

/** Hermite smoothstep: 0 below a, 1 above b, zero slope at both ends. */
export const smoothstep = (a, b, x) => {
  const k = clamp((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};

/** Loop phase in radians, 0 at t = 0, one full turn at t = DURATION. */
export const phase = (t) => (TAU * t) / DURATION;

/** sin^2(pi t / D): 0 at both ends with zero slope, 1 in the middle. One passing event per loop. */
export const swell = (t) => (t <= 0 || t >= DURATION ? 0 : Math.sin((Math.PI * t) / DURATION) ** 2);

/** 0 at both ends (zero slope), 1 between `ramp` and D - ramp. For effects that stay on. */
export const plateau = (t, ramp = 1.2) => smoothstep(0, ramp, t) * smoothstep(0, ramp, DURATION - t);

/**
 * A beat: rises over `attack` seconds to 1 at `at`, then falls back to 0 over `release` seconds.
 * Zero slope at the start, the peak and the end, and exactly 0 outside [at - attack, at + release].
 */
export const beat = (t, at, attack = 0.35, release = 1.4) => {
  if (t <= at - attack || t >= at + release) return 0;
  if (t < at) return smoothstep(at - attack, at, t);
  const x = (t - at) / release;
  return (1 - x) ** 3 * (1 + 3 * x);
};

/**
 * The rhythms of the kit. Each is 0 with zero slope at t = 0 and t = D, so frame 0 is the cover and
 * the loop has no jump:
 *   primary   the main event: a beat at every scene beat (or one slow swell without beats);
 *   reactive  answers the primary a little later, shorter and sharper;
 *   ambient   always on after a slow fade-in (and out before the loop ends);
 *   wave      one slow swell across the loop (sin^2), for breathing.
 * `delay` (seconds) shifts the beats of primary and reactive only; swells and ambient ignore it.
 */
export const RHYTHMS = ['primary', 'reactive', 'ambient', 'wave'];

export const PRIMARY_BEAT = { attack: 0.5, release: 1.6 };
export const REACTIVE_BEAT = { lag: 0.2, attack: 0.22, release: 1.1 };

export function envelope(t, timing = {}, beats = []) {
  const rhythm = timing.rhythm ?? 'ambient';
  const delay = timing.delay ?? 0;
  const time = clamp(t, 0, DURATION);
  switch (rhythm) {
    case 'primary':
      if (!beats.length) return swell(time);
      return clamp(beats.reduce((s, b) => s + beat(time, b + delay, PRIMARY_BEAT.attack, PRIMARY_BEAT.release), 0));
    case 'reactive': {
      if (!beats.length) return swell(time) ** 2;
      const { lag, attack, release } = REACTIVE_BEAT;
      return clamp(beats.reduce((s, b) => s + beat(time, b + lag + delay, attack, release), 0));
    }
    case 'wave':
      return swell(time);
    case 'ambient':
    default:
      return plateau(time, 1.6);
  }
}

/** Beats are loop-safe when every primary and reactive beat starts after 0 and ends before D. */
export const beatsAreLoopSafe = (beats, delay = 0) =>
  beats.every(
    (b) =>
      b + delay - PRIMARY_BEAT.attack > 0 &&
      b + delay + Math.max(PRIMARY_BEAT.release, REACTIVE_BEAT.lag + REACTIVE_BEAT.release) < DURATION,
  );

/**
 * Camera paths in units of the camera amplitude. Each passes through (0, 0, 0) at t = 0 and is
 * periodic in the loop, so position and speed match across the seam:
 *   orbit  a small ellipse (out to 2 units sideways at mid-loop);
 *   drift  a lazy figure-eight, mostly sideways;
 *   tilt   a crane: up and back, with a trace of sideways motion;
 *   dolly  a slow push towards the focal point and back (z), with a trace of orbit.
 * x, y move the camera; z pushes it in (the parallax block scales depth around the focal point).
 */
export const CAMERAS = ['orbit', 'drift', 'tilt', 'dolly'];

export function cameraPath(kind, t) {
  const time = clamp(t, 0, DURATION);
  const u = phase(time);
  switch (kind) {
    case 'drift':
      return { x: 1 - Math.cos(u), y: 0.45 * Math.sin(2 * u), z: 0 };
    case 'tilt':
      return { x: 0.25 * Math.sin(u), y: 1 - Math.cos(u), z: 0 };
    case 'dolly':
      return { x: 0.3 * (1 - Math.cos(u)), y: -0.2 * Math.sin(u), z: 2 * swell(time) };
    case 'orbit':
    default:
      return { x: 1 - Math.cos(u), y: -Math.sin(u), z: 0 };
  }
}

/** t stepped to `rate` phases per second (12 for hand-drawn redraw); an integer, periodic in the loop. */
export const stepped = (t, rate = 12) => Math.floor(clamp(t, 0, DURATION) * rate) % Math.round(DURATION * rate);

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

export const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Scales a colour so that its brightest channel is 1: a pure tint of the same hue. */
export const tint = (c) => {
  const m = Math.max(...c, 1e-3);
  return c.map((v) => v / m);
};

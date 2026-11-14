// light-pulse (pixel): the beat. At each beat of the scene a warm swell of exposure blooms around the
// focal point (or the cover's main light) and dies away: multiplicative, so blacks stay black. With
// beats [2, 6] the loop gets two calm accents that never touch the seam. With source "key" it sits on
// the lit side of the main face (the brightest spot on or beside it, else the side the cover's light
// comes from), and with breaths it swells and settles that many times per loop: a face breathing in
// its key light.

import { DURATION } from '../lib/loop.js';

export default {
  name: 'light-pulse',
  stage: 'pixel',
  about: 'A warm exposure swell around the focal point, the main light or the key-lit side of the face, at every beat or in slow breaths.',
  rhythm: 'primary',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 0.6, default: 0.18, about: 'exposure lift at the peak' },
    radius: { type: 'number', min: 0.15, max: 1.2, default: 0.45, about: 'size of the lit area, share of the frame height' },
    source: { type: 'enum', values: ['focus', 'light', 'key'], default: 'focus', about: 'centre: the focal point, the brightest light, or the key-lit side of the main face' },
    breaths: { type: 'number', min: 0, max: 3, default: 0, about: 'whole slow swells per loop (rounded; 0: follow the rhythm only); use with rhythm ambient' },
    colour: { type: 'colour', default: 'warm' },
  },
  presets: {
    subtle: { amount: 0.14 },
    medium: { amount: 0.26 },
  },
  glsl: `
uniform float $amount;
uniform vec2 $center;
uniform float $radius;
uniform vec3 $colour;

vec3 $apply(vec3 c, Px p) {
  vec2 d = (p.uv - $center) * vec2(1.7778, 1.0);
  float r = exp(-dot(d, d) / ($radius * $radius));
  return c + c * $colour * ($amount * r) + $colour * ($amount * r * 0.03);
}
`,
  setup(kit, params) {
    const light = kit.lights[0];
    let center = params.source === 'light' && light ? [light.x, light.y] : [kit.focus.x, kit.focus.y];
    if (params.source === 'key') center = keySide(kit) ?? center;
    const colour = kit.colour(params.colour);
    const n = Math.round(params.breaths);
    // n whole sin^2 swells: 0 with zero slope at 0 and at the end of the loop.
    const breath = (t) => (n > 0 ? Math.sin((Math.PI * n * Math.min(Math.max(t, 0), DURATION)) / DURATION) ** 2 : 1);
    return { uniforms: (t, env) => ({ amount: params.amount * env * breath(t), center, radius: params.radius, colour }) };
  },
};

/** The key-lit side of the largest face, 0..1 of the frame, or null without a face. */
function keySide(kit) {
  const face = [...kit.faces].sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (!face) return null;
  const [cx, cy] = [(face.x + face.w / 2) / kit.width, (face.y + face.h * 0.45) / kit.height];
  const fw = face.w / kit.width;
  const fh = face.h / kit.height;
  // A bright spot on or just beside the face is the key light falling on it.
  const lit = kit.lights.find((l) => Math.abs(l.x - cx) < fw * 0.8 && Math.abs(l.y - cy) < fh * 0.8);
  const side = lit ? Math.sign(lit.x - cx) : kit.lights[0] ? Math.sign(kit.lights[0].x - cx) : -1;
  return [cx + (side || -1) * fw * 0.3, cy];
}

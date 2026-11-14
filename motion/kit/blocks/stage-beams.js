// stage-beams (pixel): two to four volumetric stage-light beams from above the frame, in the cover's
// colours, swaying slowly (each with its own whole number of periods per loop, so they never move in
// step), with haze inside them fixed to the room, passing behind near things (the crowd, the singer).

import { phase } from '../lib/loop.js';

export default {
  name: 'stage-beams',
  stage: 'pixel',
  about: 'Swaying volumetric stage-light beams from above, coloured from the palette, behind near things.',
  rhythm: 'ambient',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 0.6, default: 0.2, about: 'peak strength of a beam' },
    count: { type: 'number', min: 2, max: 4, default: 3, about: 'number of beams' },
    sway: { type: 'number', min: 0, max: 0.35, default: 0.14, about: 'sway, radians' },
    spread: { type: 'number', min: 0.01, max: 0.12, default: 0.05, about: 'how fast a beam widens with distance' },
    colour: { type: 'colour', default: 'accent', about: 'colour of the first beam; the others take light and c1' },
  },
  presets: {
    subtle: { amount: 0.22, sway: 0.1 },
    medium: { amount: 0.36, sway: 0.16, spread: 0.07 },
  },
  glsl: `
uniform float $amount;
uniform vec4 $beam[4];   // origin x (0..1), angle from vertical, spread, strength
uniform vec3 $col0;
uniform vec3 $col1;
uniform vec3 $col2;
uniform vec3 $col3;
uniform vec2 $drift;
uniform float $near;

float $cone(vec2 uv, vec4 b) {
  vec2 o = vec2(b.x * 1.7778, -0.3);
  vec2 dir = vec2(sin(b.y), cos(b.y));
  vec2 q = vec2(uv.x * 1.7778, uv.y) - o;
  float along = dot(q, dir);
  float across = abs(dot(q, vec2(-dir.y, dir.x)));
  float w = 0.004 + b.z * max(along, 0.0);
  // A soft core inside a wider glow; brightest near the lamp, fading down the beam.
  float core = exp(-pow(across / w, 2.0));
  float halo = 0.35 * exp(-pow(across / (2.6 * w), 2.0));
  return (core + halo) * exp(-max(along - 0.3, 0.0) * 0.7) * b.w;
}

vec3 $apply(vec3 c, Px p) {
  float haze = 0.6 + 0.4 * fbm(p.uv * vec2(5.0, 2.5) + $drift);
  vec3 light = $col0 * $cone(p.uv, $beam[0]) + $col1 * $cone(p.uv, $beam[1])
             + $col2 * $cone(p.uv, $beam[2]) + $col3 * $cone(p.uv, $beam[3]);
  float behind = 1.0 - smoothstep($near, $near + 0.12, p.depth);
  return screen(c, light * ($amount * haze * behind));
}
`,
  setup(kit, params) {
    const n = Math.round(params.count);
    // Beams start above the cover's own lights near the top, else spread evenly.
    const top = kit.lights.filter((l) => l.y < 0.45).map((l) => l.x);
    const even = Array.from({ length: n }, (_, i) => (i + 0.5) / n);
    const xs = (top.length >= n ? top.slice(0, n) : even).sort((a, b) => a - b);
    const beams = xs.map((x, i) => {
      const lean = (0.5 - x) * 0.5; // beams lean towards the centre of the stage
      return {
        x,
        lean,
        freq: 1 + (i % 2),
        ph: kit.random() * Math.PI * 2,
        sway: params.sway * (0.7 + 0.6 * kit.random()) * (i % 2 ? -1 : 1),
        strength: 0.75 + 0.25 * kit.random(),
      };
    });
    // Lamps: the palette's hues at full brightness; a dull palette falls back to warm white.
    const sat = (c) => Math.max(...c) - Math.min(...c);
    const lamp = (name) => {
      const c = kit.colour(name);
      return sat(c) < 0.12 ? kit.light('warm') : kit.light(name);
    };
    const cols = [lamp(params.colour), lamp('light'), lamp('c1'), lamp('accent')];
    // Beams pass behind what is nearer than the subject. A featureless cover (almost no contrast) has
    // no meaningful depth (the model invents a ramp), so nothing occludes there.
    const featureless = (kit.scene.tone?.contrast ?? 1) < 0.05;
    const near = featureless ? 2 : Math.min(0.85, Math.max(0.3, kit.focusDepth + 0.05));
    return {
      uniforms: (t, env) => {
        const u = phase(t);
        const data = new Float32Array(16);
        beams.forEach((b, i) => {
          data.set([b.x, b.lean + b.sway * Math.sin(b.freq * u + b.ph), params.spread, b.strength], i * 4);
        });
        return {
          amount: params.amount * env,
          beam: data,
          col0: cols[0],
          col1: cols[1],
          col2: cols[2],
          col3: cols[3],
          drift: [0.35 * Math.sin(u), 0.25 * (1 - Math.cos(u))],
          near,
        };
      },
    };
  },
};

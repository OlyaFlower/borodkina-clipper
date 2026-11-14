// pencil (pixel): the brand's signature. The cover's salient edges (prepare: edges.png) are drawn in
// graphite (or in pale chalk on a dark cover) outward from the focal point, in clusters, like strokes
// laid down by hand; the picture washes a little towards warm paper while the drawing is up; then the
// lines lift off again before the loop closes. Lines are fixed to the picture, vary in pressure, are
// broken by the paper's tooth and redraw a fraction of a pixel 12 times per second.

import { smoothstep, stepped } from '../lib/loop.js';

export default {
  name: 'pencil',
  stage: 'pixel',
  about: 'Graphite (or chalk on dark covers) line drawing of the salient edges, drawn in from the focal point and lifted off before the loop ends, over a light paper wash.',
  rhythm: 'ambient',
  rest: ['fade', 'wash'],
  params: {
    amount: { type: 'number', min: 0, max: 1, default: 0.75, about: 'line opacity' },
    ink: { type: 'enum', values: ['auto', 'graphite', 'chalk'], default: 'auto', about: 'graphite on light covers, chalk on dark ones (auto)' },
    weight: { type: 'number', min: 0.3, max: 2.5, default: 1, about: 'line weight, px' },
    hatch: { type: 'number', min: 0, max: 1, default: 0.5, about: 'strength of the tonal hatching (shadows in graphite, lights in chalk)' },
    wash: { type: 'number', min: 0, max: 0.8, default: 0.3, about: 'how far the picture turns into a toned paper sketch while drawn' },
    start: { type: 'number', min: 0.2, max: 2.5, default: 0.5, about: 'when drawing starts, s' },
    drawFor: { type: 'number', min: 1, max: 4, default: 2.8, about: 'how long drawing takes, s' },
    liftAt: { type: 'number', min: 4, max: 6.6, default: 5.4, about: 'when the lines start to lift off (gone by 7.6 s), s' },
    boil: { type: 'number', min: 0, max: 1.5, default: 0.6, about: 'redraw wobble, px (12 phases per second)' },
  },
  presets: {
    subtle: { amount: 0.65, wash: 0.25, hatch: 0.35 },
    medium: { amount: 0.9, wash: 0.5, hatch: 0.6, weight: 1.4 },
  },
  glsl: `
uniform float $draw;
uniform float $fade;
uniform float $wash;
uniform float $boilPh;
uniform float $boil;
uniform vec2 $origin;
uniform vec3 $ink;
uniform float $chalk;
uniform float $weight;
uniform float $hatch;
uniform vec3 $paper;

float $edge(vec2 q) { return texture2D(tEdges, q / uRes).r; }

// Parallel strokes at an angle, about 2 px wide and spacing px apart, broken into dashes of
// varying length, all fixed to the picture.
float $strokes(vec2 q, float angle, float spacing) {
  vec2 d = vec2(cos(angle), sin(angle));
  vec2 n = vec2(-d.y, d.x);
  float across = dot(q, n) / spacing;
  across += 0.18 * (vnoise(q * 0.04 + angle * 7.0) - 0.5);
  float row = floor(across);
  float f = abs(fract(across) - 0.5) * spacing;
  float line = 1.0 - smoothstep(0.5, 1.4, f);
  float along = dot(q, d) / (26.0 + 30.0 * hash12(vec2(row, angle)));
  float dash = smoothstep(0.1, 0.3, fract(along + hash12(vec2(row, angle + 3.0))));
  return line * dash;
}

vec3 $apply(vec3 c, Px p) {
  vec2 q = p.src * uRes;
  // Redraw: strokes move a fraction of a pixel 12 times per second, in patches fixed to the picture.
  vec2 cell = floor(q / 18.0);
  vec2 j = (vec2(hash12(cell + $boilPh * 1.37), hash12(cell + $boilPh * 2.71 + 5.0)) - 0.5) * $boil;
  vec2 s = q + j;
  float w = $weight;
  float e = max($edge(s), max(max($edge(s + vec2(w, 0.0)), $edge(s - vec2(w, 0.0))),
                              max($edge(s + vec2(0.0, w)), $edge(s - vec2(0.0, w)))));
  // Pressure varies along a stroke and the paper's tooth breaks it up.
  float pressure = mix(0.5, 1.0, smoothstep(0.3, 0.75, fbm(q * 0.02 + 5.0)));
  float tooth = 0.65 + 0.35 * vnoise(q * 0.85 + 11.0);
  float contour = clamp(e * 2.0, 0.0, 1.0) * pressure;
  // Tonal hatching: shadows in graphite (lights in chalk), a second direction in the deepest tones.
  float tone = mix(1.0 - p.luma, p.luma, $chalk);
  float h1 = $strokes(s, 0.82, 9.0) * smoothstep(0.3, 0.6, tone);
  float h2 = $strokes(s, -0.74, 10.0) * smoothstep(0.55, 0.85, tone);
  float hatching = max(h1, 0.85 * h2) * $hatch * mix(0.6, 1.0, pressure);
  // Reveal outward from the origin, in clusters, like strokes laid down by hand.
  float dist = length((p.src - $origin) * vec2(1.7778, 1.0)) / 1.6;
  float order = clamp(dist + 0.22 * (fbm(q * 0.006 + 2.0) - 0.5), 0.0, 1.0);
  float shown = smoothstep(order, order + 0.08, $draw) * $fade;
  float mark = max(contour, hatching) * tooth * shown;
  // The picture turns towards a toned sketch on warm paper: values compressed into the paper's
  // range, colour mostly gone (graphite), or a dark toned ground (chalk).
  float l = p.luma;
  vec3 sketch = mix($paper * mix(0.62, 1.0, l), mix(vec3(0.09, 0.08, 0.08), $paper * 0.35, l), $chalk);
  vec3 washed = mix(c, mix(sketch, c, 0.3), $wash * smoothstep(order - 0.05, order + 0.2, $draw));
  vec3 graphite = mix(washed, $ink, mark * 0.85);
  vec3 chalk = screen(washed, $ink * mark * 0.8);
  return mix(graphite, chalk, $chalk);
}
`,
  setup(kit, params) {
    const tone = kit.scene.tone ?? {};
    const chalk = params.ink === 'chalk' || (params.ink === 'auto' && (tone.key === 'dark' || (tone.luma ?? 0.5) < 0.33));
    const ink = chalk ? kit.colour('paper') : kit.colour('graphite');
    const paper = kit.colour('paper');
    const origin = [kit.focus.x ?? 0.5, kit.focus.y ?? 0.5];
    const end = 7.6;
    return {
      uniforms: (t, env) => {
        const k = smoothstep(params.start, params.start + params.drawFor, t);
        const draw = 1.15 * (1 - (1 - k) ** 2); // fast at first, settling: a hand slowing down
        const fade = (1 - smoothstep(params.liftAt, end, t)) * env;
        return {
          draw,
          fade: params.amount * fade,
          wash: params.wash * fade * Math.min(1, draw),
          boilPh: stepped(t, 12),
          boil: params.boil,
          origin,
          ink,
          chalk: chalk ? 1 : 0,
          weight: params.weight,
          hatch: params.hatch,
          paper,
        };
      },
    };
  },
};

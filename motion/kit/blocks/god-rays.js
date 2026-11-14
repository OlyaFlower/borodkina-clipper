// god-rays (pixel): soft shafts of light fanning out from the cover's own light source (the sun, a
// lamp, a stage light), screen-blended, passing behind near things. The fan turns a few degrees and
// back over the loop; its strength follows the rhythm.

import { phase } from '../lib/loop.js';

export default {
  name: 'god-rays',
  stage: 'pixel',
  about: "Shafts of light from the cover's brightest light source (or the top, or the focal point), behind near things.",
  rhythm: 'wave',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 0.7, default: 0.22, about: 'peak strength' },
    source: { type: 'enum', values: ['light', 'top', 'focus'], default: 'light', about: 'where the rays start: the brightest light of the cover (else the top), the top centre, or the focal point' },
    reach: { type: 'number', min: 0.2, max: 1.5, default: 0.7, about: 'fall-off length, share of the frame height' },
    rays: { type: 'number', min: 4, max: 24, default: 7, about: 'angular frequency of the shafts' },
    turn: { type: 'number', min: 0, max: 0.2, default: 0.06, about: 'how far the fan turns and back, radians' },
    colour: { type: 'colour', default: 'light' },
  },
  presets: {
    subtle: { amount: 0.18, turn: 0.05 },
    medium: { amount: 0.26, turn: 0.08 },
  },
  glsl: `
uniform float $amount;
uniform vec2 $origin;
uniform float $reach;
uniform float $rays;
uniform float $spin;
uniform vec3 $colour;
uniform float $lightDepth;

vec3 $apply(vec3 c, Px p) {
  vec2 d = (p.uv - $origin) * vec2(1.7778, 1.0);
  float r = length(d);
  float a = atan(d.y, d.x) + $spin;
  vec2 ring = vec2(cos(a), sin(a)) * $rays * 0.5;
  float shafts = smoothstep(0.25, 0.95, fbm(ring + 3.1)) * (0.6 + 0.4 * vnoise(ring * 1.7 + 9.0));
  float fall = exp(-r / $reach) * smoothstep(0.0, 0.06, r);
  // Light reaches this pixel only if nothing nearer than the light stands between them: eight depth
  // samples on the way to the light (the pixel itself first), so shafts show in the air and through
  // gaps, never painted over the hill or the crowd in front.
  float open = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 s = mix(p.src, $origin, float(i) / 8.0);
    open += 1.0 - smoothstep($lightDepth + 0.06, $lightDepth + 0.16, texture2D(tDepth, s).r);
  }
  open = pow(open / 8.0, 2.0);
  return screen(c, $colour * ($amount * shafts * fall * open));
}
`,
  setup(kit, params) {
    let origin = [0.5, -0.05];
    if (params.source === 'light' && kit.lights.length) origin = [kit.lights[0].x, kit.lights[0].y];
    if (params.source === 'focus') origin = [kit.focus.x, kit.focus.y];
    // The light sits as deep as the picture at its place (prepare measures nothing there, so the
    // light's own brightness suggests the sky: the farthest plane). Top and focus use the far plane
    // and the focal plane.
    const lightDepth = params.source === 'focus' ? kit.focusDepth : (kit.scene.depth?.range?.[0] ?? 0) + 0.05;
    const colour = kit.light(params.colour);
    return {
      uniforms: (t, env) => ({
        amount: params.amount * env,
        origin,
        reach: params.reach,
        rays: params.rays,
        spin: params.turn * Math.sin(phase(t)),
        colour,
        lightDepth,
      }),
    };
  },
};

// vignette (pixel): the corners darken gently and breathe (a little deeper twice per loop), centred
// on the focal point, which pulls the eye to the subject.

import { phase } from '../lib/loop.js';

export default {
  name: 'vignette',
  stage: 'pixel',
  about: 'Gently darkened corners, centred between the frame centre and the focal point, breathing slowly.',
  rhythm: 'ambient',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 0.5, default: 0.16, about: 'darkening of the corners' },
    breath: { type: 'number', min: 0, max: 1, default: 0.3, about: 'share of the amount that breathes in and out' },
    follow: { type: 'number', min: 0, max: 1, default: 0.35, about: 'how far the centre leans towards the focal point' },
  },
  presets: {
    subtle: { amount: 0.14, breath: 0.3 },
    medium: { amount: 0.24, breath: 0.4 },
  },
  glsl: `
uniform float $amount;
uniform vec2 $center;

vec3 $apply(vec3 c, Px p) {
  vec2 v = (p.uv - $center) * vec2(1.0, 0.82);
  return c * (1.0 - $amount * smoothstep(0.3, 0.85, length(v)));
}
`,
  setup(kit, params) {
    const center = [0.5 + (kit.focus.x - 0.5) * params.follow, 0.5 + (kit.focus.y - 0.5) * params.follow];
    return {
      uniforms: (t, env) => {
        const breathe = 1 - params.breath * 0.5 * (1 + Math.cos(2 * phase(t)));
        return { amount: params.amount * env * breathe, center };
      },
    };
  },
};

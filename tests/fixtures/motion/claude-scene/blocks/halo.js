// halo (pixel): a soft warm halo around the focal point, anchored to the picture, that answers the
// beats. A hand-written custom block for tests/motion-decide.test.sh, kept to the block contract.

import { phase } from '../kit/lib/loop.js';

export default {
  name: 'halo',
  stage: 'pixel',
  about: 'A soft warm halo around the focal point, anchored to the picture.',
  rhythm: 'reactive',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 0.4, default: 0.16, about: 'brightness of the halo at its peak' },
    radius: { type: 'number', min: 0.1, max: 0.8, default: 0.32, about: 'radius as a share of the frame height' },
  },
  presets: {
    subtle: { amount: 0.14 },
    medium: { amount: 0.24 },
  },
  glsl: `
uniform float $amount;
uniform vec2 $center;
uniform float $radius;

vec3 $apply(vec3 c, Px p) {
  vec2 d = (p.src - $center) * vec2(uRes.x / uRes.y, 1.0);
  float h = exp(-dot(d, d) / ($radius * $radius));
  return c + vec3(1.0, 0.86, 0.7) * $amount * h * (0.35 + 0.65 * p.luma);
}
`,
  setup(kit, params) {
    const center = [kit.focus.x, kit.focus.y];
    return {
      uniforms: (t, env) => ({
        amount: params.amount * env * (0.8 + 0.2 * Math.cos(2 * phase(t))),
        center,
        radius: params.radius,
      }),
    };
  },
};

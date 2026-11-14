// grain (pixel): paper or film tooth fixed to the picture (sampled where the base block sampled the
// cover, so it moves with the surface, never as screen-space noise), strongest in the mid-tones.
// Off the poster card by default, so lettering stays clean.

export default {
  name: 'grain',
  stage: 'pixel',
  about: 'Paper/film grain anchored to the picture, strongest in mid-tones; spares the card by default.',
  rhythm: 'ambient',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 0.12, default: 0.04, about: 'grain strength' },
    size: { type: 'number', min: 0.6, max: 3, default: 1.2, about: 'grain size in px' },
    onCard: { type: 'boolean', default: false, about: 'extend mode: grain on the card too' },
  },
  presets: {
    subtle: { amount: 0.035 },
    medium: { amount: 0.06 },
  },
  glsl: `
uniform float $amount;
uniform float $size;
uniform float $onCard;

vec3 $apply(vec3 c, Px p) {
  vec2 q = p.src * uRes / $size;
  float g = vnoise(q * 0.7) * 0.6 + vnoise(q * 1.9 + 17.0) * 0.4 - 0.5;
  float mid = 0.35 + 0.65 * (1.0 - abs(p.luma * 2.0 - 1.0));
  float m = mix(1.0, $onCard, p.card);
  return c + g * ($amount * mid * m);
}
`,
  setup(kit, params) {
    return {
      uniforms: (t, env) => ({ amount: params.amount * env, size: params.size, onCard: params.onCard ? 1 : 0 }),
    };
  },
};

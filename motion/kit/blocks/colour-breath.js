// colour-breath (pixel): the white balance leans slowly towards one of the cover's colours and back,
// with a touch more saturation at the peak. Luminance is kept, so the picture breathes without
// getting brighter or darker.

export default {
  name: 'colour-breath',
  stage: 'pixel',
  about: "A slow white-balance lean towards a palette colour and back, keeping luminance.",
  rhythm: 'wave',
  rest: ['amount', 'sat'],
  params: {
    amount: { type: 'number', min: 0, max: 0.4, default: 0.12, about: 'how far the balance leans' },
    saturation: { type: 'number', min: -0.3, max: 0.3, default: 0.08, about: 'saturation change at the peak' },
    colour: { type: 'colour', default: 'accent', about: 'the colour it leans towards' },
  },
  presets: {
    subtle: { amount: 0.1, saturation: 0.06 },
    medium: { amount: 0.2, saturation: 0.12 },
  },
  glsl: `
uniform float $amount;
uniform float $sat;
uniform vec3 $gain;

vec3 $apply(vec3 c, Px p) {
  vec3 shifted = c * mix(vec3(1.0), $gain, $amount);
  shifted *= luma(c) / max(luma(shifted), 1e-4);
  float l = luma(shifted);
  return mix(vec3(l), shifted, 1.0 + $sat);
}
`,
  setup(kit, params) {
    const c = kit.colour(params.colour);
    const l = Math.max(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], 0.05);
    // Per-channel gain of the target colour at equal luminance, limited so the lean stays a tint.
    const gain = c.map((v) => Math.min(Math.max(v / l, 0.5), 1.8));
    return {
      uniforms: (t, env) => ({ amount: params.amount * env, sat: params.saturation * env, gain }),
    };
  },
};

// bloom (pixel): the cover's own highlights (prepare: glow.png) glow softly, fixed to the picture,
// swelling with the rhythm. Lights, candles and stage lamps breathe; nothing else changes.

export default {
  name: 'bloom',
  stage: 'pixel',
  about: "A soft glow around the cover's highlights, anchored to the picture, swelling with the rhythm.",
  rhythm: 'reactive',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 1.2, default: 0.45, about: 'peak glow strength' },
    floor: { type: 'number', min: 0, max: 1, default: 0.35, about: 'share of the glow that stays between beats' },
    colour: { type: 'colour', default: 'white', about: 'tint of the glow' },
  },
  presets: {
    subtle: { amount: 0.4, floor: 0.35 },
    medium: { amount: 0.7, floor: 0.3 },
  },
  glsl: `
uniform float $amount;
uniform vec3 $tint;

vec3 $apply(vec3 c, Px p) {
  vec3 g = texture2D(tGlow, p.src).rgb;
  return screen(c, g * $tint * $amount);
}
`,
  setup(kit, params) {
    const tint = kit.colour(params.colour);
    return {
      // Between beats the glow rests at `floor`; the floor itself fades in and out with the loop.
      uniforms: (t, env) => {
        const base = params.floor * kit.rhythm(t, 'ambient');
        return { amount: params.amount * Math.min(1, base + (1 - params.floor) * env), tint };
      },
    };
  },
};

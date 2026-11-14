// light-sweep (pixel): one soft band of light crosses the frame once per loop, screen-blended, so it
// catches light surfaces and near things and leaves blacks black. With target "card" it is a sheen
// that glides over the poster card only.

export default {
  name: 'light-sweep',
  stage: 'pixel',
  about: 'A soft band of light crossing the picture once per loop (or a sheen over the card).',
  rhythm: 'wave',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 0.6, default: 0.18, about: 'peak strength of the light' },
    width: { type: 'number', min: 0.04, max: 0.4, default: 0.16, about: 'band width, share of the diagonal' },
    angle: { type: 'number', min: -80, max: 80, default: 32, about: 'band direction in degrees from vertical' },
    colour: { type: 'colour', default: 'light', about: 'light colour (palette name or #rrggbb)' },
    target: { type: 'enum', values: ['all', 'card'], default: 'all', about: 'the whole picture, or only the card (extend mode)' },
  },
  presets: {
    subtle: { amount: 0.16, width: 0.16 },
    medium: { amount: 0.28, width: 0.2 },
  },
  glsl: `
uniform float $amount;
uniform float $pos;
uniform vec2 $dir;
uniform vec2 $range;
uniform float $width;
uniform vec3 $colour;
uniform float $cardOnly;

vec3 $apply(vec3 c, Px p) {
  float along = (dot(vec2(p.uv.x * 1.7778, p.uv.y), $dir) - $range.x) / ($range.y - $range.x);
  // Squares, not pow(x, 2.0): GLSL leaves pow undefined for x < 0 (NaN on some drivers), and a NaN
  // survives the zero amount at t = 0, so frame 0 would no longer be the cover.
  float b = (along - $pos) / $width;
  float g = (along - $pos + 0.6 * $width) / (0.25 * $width);
  float band = exp(-b * b);
  float glint = 0.35 * exp(-g * g);
  float mask = mix(1.0, p.card, $cardOnly);
  float lit = (band + glint * $cardOnly) * mask * (0.3 + 0.7 * p.luma) * (0.75 + 0.25 * p.depth);
  return screen(c, $colour * ($amount * lit));
}
`,
  setup(kit, params) {
    const a = (params.angle * Math.PI) / 180;
    const dir = [Math.sin(a), Math.cos(a)];
    const corners = [
      [0, 0],
      [1.7778, 0],
      [0, 1],
      [1.7778, 1],
    ].map(([x, y]) => x * dir[0] + y * dir[1]);
    const range = [Math.min(...corners), Math.max(...corners)];
    const colour = kit.colour(params.colour);
    const cardOnly = params.target === 'card' && kit.mode === 'extend' ? 1 : 0;
    return {
      // The band travels across the whole loop; the envelope only fades it in and out.
      uniforms: (t, env) => ({
        amount: params.amount * env,
        pos: -0.25 + 1.5 * (t / kit.duration),
        dir,
        range,
        width: params.width,
        colour,
        cardOnly,
      }),
    };
  },
};

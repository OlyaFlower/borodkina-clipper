// light-pulse (pixel): the beat. At each beat of the scene a warm swell of exposure blooms around the
// focal point (or the cover's main light) and dies away: multiplicative, so blacks stay black. With
// beats [2, 6] the loop gets two calm accents that never touch the seam.

export default {
  name: 'light-pulse',
  stage: 'pixel',
  about: 'A warm exposure swell around the focal point (or main light) at every beat.',
  rhythm: 'primary',
  rest: ['amount'],
  params: {
    amount: { type: 'number', min: 0, max: 0.6, default: 0.18, about: 'exposure lift at the peak' },
    radius: { type: 'number', min: 0.15, max: 1.2, default: 0.45, about: 'size of the lit area, share of the frame height' },
    source: { type: 'enum', values: ['focus', 'light'], default: 'focus', about: 'centre: the focal point or the brightest light' },
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
    const center = params.source === 'light' && light ? [light.x, light.y] : [kit.focus.x, kit.focus.y];
    const colour = kit.colour(params.colour);
    return { uniforms: (t, env) => ({ amount: params.amount * env, center, radius: params.radius, colour }) };
  },
};

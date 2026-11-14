// card-float (base, extend mode only): the poster card floats as a rigid plane above its blurred
// surround. It rises a few pixels and sways sideways while its shadow drops further and softens, and
// the surround moves a little the other way. The card is only translated (sharp bicubic sampling),
// never scaled, tilted, blurred or warped, so its lettering stays crisp in every frame.

import { phase } from '../lib/loop.js';
import { BASE_GLSL, cardRest } from './parallax.js';

export default {
  name: 'card-float',
  stage: 'base',
  modes: ['extend'],
  about: 'A rigid poster card floating over its blurred surround, its shadow following it. Extend covers only.',
  rhythm: 'wave',
  rest: ['cardOff', 'bgOff', 'lift'],
  params: {
    rise: { type: 'number', min: 0, max: 24, default: 8, about: 'how far the card rises at the top of the float, px' },
    sway: { type: 'number', min: 0, max: 24, default: 6, about: 'sideways sway, px (one slow period per loop)' },
    counter: { type: 'number', min: 0, max: 1, default: 0.4, about: 'the surround moves this share of the card offset the other way' },
  },
  presets: {
    subtle: { rise: 8, sway: 6, counter: 0.4 },
    medium: { rise: 14, sway: 10, counter: 0.5 },
  },
  glsl: BASE_GLSL,
  setup(kit, params) {
    const rest = cardRest(kit);
    // env (wave: sin^2 over the loop) lifts the card; the sway is one whole sine period, faded by
    // the same envelope's square root so it starts and ends at rest with matching speed.
    const offset = (t, env) => {
      const sway = params.sway * Math.sin(phase(t)) * Math.sqrt(env);
      return [sway, -params.rise * env];
    };
    return {
      camera: (t) => {
        const [x, y] = offset(t, kit.envelope(t));
        return { x: x / 0.4, y: y / 0.4, z: 0 };
      },
      cardRect: (t) => {
        const [x, y] = offset(t, kit.envelope(t));
        const [x0, y0, x1, y1] = rest.card;
        return [x0 + x, y0 + y, x1 + x, y1 + y];
      },
      uniforms(t, env) {
        const [x, y] = offset(t, env);
        return {
          card: rest.card,
          shadow: rest.shadow,
          cardOff: [x, y],
          bgOff: [-x * params.counter, -y * params.counter * 0.5],
          lift: [params.rise * env * 1.2, params.rise * env * 1.6],
        };
      },
    };
  },
};

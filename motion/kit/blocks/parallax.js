// parallax (base): the cover in depth. A crop cover is moved by depth (2.5D) with parallax-occlusion
// marching, so near things stay crisp in front of what moves behind them; where the camera reveals
// what a near edge hid, the occlusion plate (prepare: plate.jpg) is shown instead of smearing the edge.
// An extended cover (a poster card over its blurred surround) moves as a rigid card over the surround:
// the card is never warped, blurred or displaced inside, only translated, and sampled with a sharp
// bicubic filter so it stays crisp at sub-pixel offsets; its shadow follows it.

import { CAMERAS, cameraPath } from '../lib/loop.js';

export const BASE_GLSL = `
uniform vec2 $shift;    // crop: camera offset in px per unit of depth away from the pivot
uniform float $push;    // crop: dolly, relative scale per unit of depth away from the pivot
uniform vec2 $center;   // crop: dolly centre, 0..1
uniform float $pivot;   // crop: the depth that stays still
uniform vec4 $card;     // extend: card box at rest, px
uniform vec2 $cardOff;  // extend: card offset, px
uniform vec2 $bgOff;    // extend: background offset, px
uniform vec3 $shadow;   // extend: baked shadow dy, sigma, strength
uniform vec2 $lift;     // extend: extra shadow dy and sigma while the card floats up

vec2 $disp(vec2 uv, float h) {
  return (($shift + $push * (uv - $center) * uRes) * (h - $pivot)) / uRes;
}

vec3 $crop(inout Px p) {
  vec2 uv = p.uv;
  // Displacement fades out over the outer 6 % so the frame edge never samples outside the cover.
  vec2 e = smoothstep(vec2(0.0), vec2(0.06), uv) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - uv);
  float k = e.x * e.y;
  // March from the nearest height down; the first surface that covers this pixel wins.
  // No early exit: every pixel runs the same steps, so screen derivatives below stay defined.
  float hi = 1.0;
  float lo = 0.0;
  float found = 0.0;
  for (int i = 0; i <= 12; i++) {
    float h = 1.0 - float(i) / 12.0;
    float hit = step(h, texture2D(tDepth, uv - k * $disp(uv, h)).r) * (1.0 - found);
    lo = mix(lo, h, hit);
    hi = mix(h, hi, found + hit);
    found = max(found, hit);
  }
  for (int j = 0; j < 5; j++) {
    float h = 0.5 * (lo + hi);
    float hit = step(h, texture2D(tDepth, uv - k * $disp(uv, h)).r);
    lo = mix(lo, h, hit);
    hi = mix(h, hi, hit);
  }
  vec2 src = uv - k * $disp(uv, lo);
  float d = texture2D(tDepth, src).r;
  // Where the ray slides down the side of a near thing, many screen pixels map onto the few pixels of
  // its soft rim. Along the camera shift the screen-to-picture mapping is squeezed by 1 + g, where
  // g = (depth gradient at src, per px) . (shift, px per unit of depth). Squeezed twice or more, the
  // pixel sees what the near thing hid: show the occlusion plate there, moved by its own smooth depth.
  // At rest the shift is zero, so g = 0 and frame 0 is the cover.
  vec2 shPx = k * ($shift + $push * (uv - $center) * uRes);
  float shLen = length(shPx);
  vec2 dir = shPx / max(shLen, 1e-4) * (1.5 / uRes);
  float g = (texture2D(tDepth, src + dir).r - texture2D(tDepth, src - dir).r) / 3.0 * shLen;
  float wall = smoothstep(0.6, 1.4, g);
  float pd = texture2D(tPlateDepth, uv).r;
  vec2 ps = uv - k * $disp(uv, pd);
  pd = texture2D(tPlateDepth, ps).r;
  ps = uv - k * $disp(uv, pd);
  p.src = mix(src, ps, wall);
  p.depth = mix(d, pd, wall);
  return mix(texture2D(tCover, src).rgb, texture2D(tPlate, ps).rgb, wall);
}

vec3 $extendCard(inout Px p) {
  vec2 q = p.uv * uRes;
  vec2 bq = q - $bgOff;
  vec2 hp = 0.5 / uRes;
  vec3 bg = texture2D(tBackground, clamp(bq / uRes, hp, 1.0 - hp)).rgb;
  // The shadow baked into the background moved with it; move it with the card instead (ratio of the
  // two analytic shadows, exactly 1 at rest).
  vec4 s0box = $card + vec4($bgOff, $bgOff) + vec4(0.0, $shadow.x, 0.0, $shadow.x);
  float dy = $shadow.x + $lift.x;
  vec4 s1box = $card + vec4($cardOff, $cardOff) + vec4(0.0, dy, 0.0, dy);
  float s0 = softBox(q, s0box, $shadow.y);
  float s1 = softBox(q, s1box, $shadow.y + $lift.y);
  bg *= (1.0 - $shadow.z * s1) / max(1.0 - $shadow.z * s0, 0.05);
  vec2 cq = q - $cardOff;
  vec2 inside = min(cq - $card.xy, $card.zw - cq);
  float cover = clamp(min(inside.x, inside.y) + 0.5, 0.0, 1.0);
  vec2 cs = clamp(cq, $card.xy + 0.5, $card.zw - 0.5) / uRes;
  vec3 card = sampleSharp(tCover, cs);
  p.card = cover;
  p.src = mix(bq / uRes, cs, cover);
  p.depth = 0.8 * cover;
  return mix(bg, card, cover);
}

// KIT_EXTEND is defined by the composition from the cover's framing (compile time, no branch).
vec3 $base(inout Px p) {
#if KIT_EXTEND
  return $extendCard(p);
#else
  return $crop(p);
#endif
}
`;

/** Shared by parallax and card-float: the uniforms of the card branch at rest. */
export function cardRest(kit) {
  const shadow = kit.scene.framing?.shadow ?? { dy: 12, sigma: 36, strength: 0.6 };
  return { card: kit.card ?? [0, 0, kit.width, kit.height], shadow: [shadow.dy, shadow.sigma, shadow.strength] };
}

const PIVOTS = { subject: null, near: 0.85, far: 0.1 };

export default {
  name: 'parallax',
  stage: 'base',
  about:
    'Depth parallax of a crop cover with a calm camera (orbit, drift, tilt or dolly) around a pivot depth that stays still (the subject: faces stay rigid). On an extended cover, the card moves rigidly over the blurred surround.',
  rhythm: 'ambient',
  rest: ['shift', 'push', 'cardOff', 'bgOff', 'lift'],
  params: {
    camera: { type: 'enum', values: CAMERAS, default: 'orbit', about: 'camera path (see loop.js cameraPath)' },
    amount: { type: 'number', min: 0, max: 40, default: 16, about: 'largest shift in px between the nearest and the farthest plane' },
    push: { type: 'number', min: 0, max: 0.03, default: 0.012, about: 'dolly only: relative scale per unit of depth at the deepest push' },
    pivot: { type: 'enum', values: Object.keys(PIVOTS), default: 'subject', about: 'which depth stays still: the subject (faces or focal point), the near plane or the far plane' },
  },
  presets: {
    subtle: { amount: 14, push: 0.01 },
    medium: { amount: 24, push: 0.018 },
  },
  glsl: BASE_GLSL,
  setup(kit, params) {
    const pivot = PIVOTS[params.pivot] ?? kit.focusDepth;
    const ax = params.amount / 2;
    const ay = params.amount * 0.3;
    const rest = cardRest(kit);
    const shift = (t, env) => {
      const c = cameraPath(params.camera, t);
      return { x: ax * c.x * env, y: ay * c.y * env, z: c.z * env };
    };
    return {
      // In extend mode the card sits at depth 0.8 and the surround at 0, around a pivot of 0.4.
      camera: (t) => shift(t, kit.envelope(t)),
      cardRect: (t) => {
        const s = shift(t, kit.envelope(t));
        const [x0, y0, x1, y1] = rest.card;
        return [x0 + s.x * 0.45, y0 + s.y * 0.45, x1 + s.x * 0.45, y1 + s.y * 0.45];
      },
      uniforms(t, env) {
        const s = shift(t, env);
        if (kit.mode === 'extend') {
          return {
            card: rest.card,
            shadow: rest.shadow,
            cardOff: [s.x * 0.45, s.y * 0.45],
            bgOff: [-s.x * 0.35, -s.y * 0.35],
            lift: [0, 0],
          };
        }
        return {
          shift: [s.x, s.y],
          push: params.camera === 'dolly' ? params.push * s.z * 0.5 : 0,
          center: [kit.focus.x ?? 0.5, kit.focus.y ?? 0.5],
          pivot,
        };
      },
    };
  },
};

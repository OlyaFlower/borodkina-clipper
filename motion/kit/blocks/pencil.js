// pencil (pixel): the brand's signature. The cover turns into a pencil drawing on warm paper and back:
// from the focal point outward, broken contour lines are laid down first (edges.png), then hatching
// fills in the forms and the picture gives way to paper behind it; the drawing holds and boils; then the
// cover's colour floods back from the focal point outward and the lines lift, so the loop ends on the
// cover. Hatching only goes where there is form or shadow: its tone comes from the picture's value and
// from how the depth's slope turns away from the light; highlights and far, flat areas (a sky) stay
// clean paper. Strokes are laid in patches fixed to the picture, each patch following the local
// contour, with varied pressure, length and taper; the drawing redraws at 12 phases per second, where
// only the small imperfections of each stroke change (seeded), never its place.

import { smoothstep, stepped } from '../lib/loop.js';

export default {
  name: 'pencil',
  stage: 'pixel',
  about:
    'The cover becomes a pencil drawing on warm paper from the focal point outward (broken contours, hatching that follows the forms, clean paper in highlights and sky), holds and boils at 12 phases per second, then the colour floods back so the loop ends on the cover.',
  rhythm: 'ambient',
  rest: ['fade', 'wash'],
  params: {
    amount: { type: 'number', min: 0, max: 1, default: 0.8, about: 'opacity of the lines' },
    ink: { type: 'enum', values: ['auto', 'graphite', 'chalk'], default: 'auto', about: 'graphite on light covers, chalk on dark ones (auto)' },
    weight: { type: 'number', min: 0.3, max: 2.5, default: 1, about: 'line weight (about 1.5 px contours at 1)' },
    hatch: { type: 'number', min: 0, max: 1, default: 0.7, about: 'how much hatching the shadows get' },
    wash: { type: 'number', min: 0, max: 1, default: 0.7, about: 'how far the picture turns into paper behind the drawing' },
    start: { type: 'number', min: 0.2, max: 2.5, default: 0.4, about: 'when drawing starts, s' },
    drawFor: { type: 'number', min: 1, max: 4, default: 2.6, about: 'how long drawing takes, s' },
    liftAt: { type: 'number', min: 4, max: 6.6, default: 5, about: 'when the colour starts to flood back and the lines lift (all gone by 7.5 s), s' },
    boil: { type: 'number', min: 0, max: 1.5, default: 0.6, about: 'redraw wobble, px (12 phases per second)' },
  },
  presets: {
    subtle: { amount: 0.7, wash: 0.55, hatch: 0.55 },
    medium: { amount: 0.9, wash: 0.95, hatch: 0.8, weight: 1.2 },
  },
  glsl: `
uniform float $draw;
uniform float $back;
uniform float $fade;
uniform float $wash;
uniform float $boilPh;
uniform float $boil;
uniform float $seed;
uniform vec2 $origin;
uniform float $reach;
uniform vec2 $lightDir;
uniform float $farDepth;
uniform vec3 $ink;
uniform float $chalk;
uniform float $weight;
uniform float $hatch;
uniform vec3 $paper;
uniform float $cardOnly;

const float $CELL = 70.0;

float $edge(vec2 q) { return texture2D(tEdges, q / uRes).r; }

// When a place of the picture is reached by the drawing (0 at the origin, 1 at the farthest corner).
float $order(vec2 q) {
  float d = length((q / uRes - $origin) * vec2(1.7778, 1.0)) / $reach;
  return clamp(d + 0.1 * (vnoise(q * 0.006 + 2.0) - 0.5) + 0.06 * (fbm(q * 0.016 + 9.0) - 0.5), 0.0, 1.0);
}

// One layer of hatching in a patch: straight, slightly bowed strokes about spacing px apart along ang.
// A row is drawn where the tone (density) passes the row's own threshold, so strokes ease off where the
// form gets lighter. Each stroke has its own length, pressure and taper, and is drawn along its length
// once the drawing reaches it (reveal > 0). The boil moves it a fraction of a pixel and nudges its ends.
float $strokes(vec2 r, float ang, float spacing, float density, vec2 cell, float salt, float reveal) {
  vec2 d = vec2(cos(ang), sin(ang));
  vec2 n = vec2(-d.y, d.x);
  float along = dot(r, d);
  float bow = (hash12(cell + salt + 3.1) - 0.5) * 0.004;
  float across = (dot(r, n) + bow * along * along) / spacing;
  float row = floor(across + 0.5);
  vec2 id = vec2(row + salt * 13.0, cell.x * 7.0 + cell.y * 131.0 + $seed);
  float h = hash12(id);
  float hLen = hash12(id + 5.3);
  float hPos = hash12(id + 9.7);
  float jb = hash12(id + $boilPh * 1.618) - 0.5;
  float distPx = abs((across - row) * spacing - jb * $boil);
  float len = mix(0.8, 1.7, hLen);
  float u0 = -1.0 + (2.0 - len) * hPos + 0.05 * jb;
  float g = (along / ($CELL * 0.8) - u0) / len;
  float body = smoothstep(0.0, 0.1, g) * (1.0 - smoothstep(0.62, 1.0, g));
  float drawn = 1.0 - smoothstep(-0.05, 0.0, g - clamp((reveal - 0.1 * h) * 6.0, 0.0, 1.05));
  float pressure = mix(0.5, 1.0, hash12(id + 2.2)) * body;
  float width = mix(0.7, 1.35, pressure) * $weight;
  float line = 1.0 - smoothstep(width * 0.5 - 0.3, width * 0.5 + 0.55, distPx);
  float keep = clamp((density - h * 0.92) * 5.0, 0.0, 1.0);
  return line * pressure * keep * drawn;
}

// The strokes of the patch of one grid that holds q (jq: q with the patch outlines wobbled). Each patch
// runs along the local contour of the picture (luminance and depth around its centre), turned a little
// towards a hand's natural diagonal. w.x: how deep inside its patch q lies (1 at the centre).
float $patch(vec2 q, vec2 jq, float dens, float salt, out vec2 w) {
  vec2 cell = floor(jq / $CELL) + salt * 101.0;
  vec2 centre = (floor(jq / $CELL) + 0.5) * $CELL - salt * $CELL;
  vec2 cuv = centre / uRes;
  vec2 o = vec2(18.0) / uRes;
  float l1 = luma(texture2D(tCover, cuv - o).rgb);
  float l2 = luma(texture2D(tCover, cuv + vec2(o.x, -o.y)).rgb);
  float l3 = luma(texture2D(tCover, cuv + vec2(-o.x, o.y)).rgb);
  float l4 = luma(texture2D(tCover, cuv + o).rgb);
  float d1 = texture2D(tDepth, cuv - o).r;
  float d2 = texture2D(tDepth, cuv + vec2(o.x, -o.y)).r;
  float d3 = texture2D(tDepth, cuv + vec2(-o.x, o.y)).r;
  float d4 = texture2D(tDepth, cuv + o).r;
  vec2 grad = vec2(l2 + l4 - l1 - l3, l3 + l4 - l1 - l2) + 1.5 * vec2(d2 + d4 - d1 - d3, d3 + d4 - d1 - d2);
  float base = 0.8 + 0.3 * (hash12(cell + 0.37 + $seed) - 0.5);
  float fieldAng = atan(grad.y, grad.x) + 0.5 * PI + 0.25 * (hash12(cell + 7.1) - 0.5);
  float follow = 0.8 * smoothstep(0.03, 0.12, length(grad));
  vec2 dv = mix(vec2(cos(2.0 * base), sin(2.0 * base)), vec2(cos(2.0 * fieldAng), sin(2.0 * fieldAng)), follow);
  float ang = 0.5 * atan(dv.y, dv.x);
  float reveal = $draw - $order(centre) - 0.06;
  vec2 r = q - centre;
  vec2 rj = jq - salt * $CELL - centre;
  w = vec2(1.0 - smoothstep(0.2, 0.5, max(abs(rj.x), abs(rj.y)) / $CELL), 0.0);
  float h1 = $strokes(r, ang, 6.5, smoothstep(0.05, 0.45, dens), cell, 0.0, reveal);
  float h2 = $strokes(r, ang + 1.1, 7.5, smoothstep(0.45, 0.8, dens), cell, 1.0, reveal - 0.05);
  vec2 half1 = vec2(-sin(ang), cos(ang)) * 3.25;
  float h3 = $strokes(r + half1, ang, 6.5, smoothstep(0.8, 1.0, dens), cell, 2.0, reveal - 0.08);
  return max(max(h1, 0.85 * h2), 0.9 * h3);
}

vec3 $apply(vec3 c, Px p) {
  vec2 q = p.src * uRes;
  float tooth = 0.62 + 0.38 * vnoise(q * 0.9 + 11.0 + $seed);
  float ord = $order(q);

  // ---- tone: value (graphite darkens shadows; chalk lights the lights) plus the form's turn from the light
  float value = mix(1.0 - p.luma, p.luma, $chalk);
  vec2 e5 = vec2(5.0) / uRes;
  float dx = texture2D(tDepth, p.src + vec2(e5.x, 0.0)).r - texture2D(tDepth, p.src - vec2(e5.x, 0.0)).r;
  float dy = texture2D(tDepth, p.src + vec2(0.0, e5.y)).r - texture2D(tDepth, p.src - vec2(0.0, e5.y)).r;
  vec3 nrm = normalize(vec3(-dx * 9.0, -dy * 9.0, 1.0));
  vec3 L = normalize(vec3($lightDir, 0.75));
  float turn = clamp((L.z - dot(nrm, L)) * 1.6, -0.25, 0.5);
  // contact shadow: a nearer thing just beside this place darkens it (occlusion)
  vec2 e16 = vec2(16.0) / uRes;
  float near = max(max(texture2D(tDepth, p.src + vec2(e16.x, 0.0)).r, texture2D(tDepth, p.src - vec2(e16.x, 0.0)).r),
                   max(texture2D(tDepth, p.src + vec2(0.0, e16.y)).r, texture2D(tDepth, p.src - vec2(0.0, e16.y)).r));
  float occl = smoothstep(0.02, 0.12, near - p.depth);
  // nearer forms carry more weight, farther ones less (aerial perspective)
  float tone = clamp((value + 0.45 * turn) * mix(0.72, 1.0, smoothstep($farDepth, $farDepth + 0.5, p.depth)) + 0.35 * occl, 0.0, 1.0);
  // far and flat (a sky, a plain backdrop): left as paper
  float far = 1.0 - smoothstep($farDepth, $farDepth + 0.08, p.depth);
  float flat1 = 1.0 - smoothstep(0.01, 0.05, abs(dx) + abs(dy));
  float clean = far * flat1 * (1.0 - $chalk);
  float v = tone * (1.0 - clean);

  // ---- hatching in two overlapping grids of patches fixed to the picture (tonal groups: paper in the
  // lights, one direction in the half-tones, crossed in the shadows, a third pass in the deepest)
  float dens = smoothstep(0.32, 0.95, v) * mix(0.6, 1.15, $hatch);
  vec2 jq = q + 16.0 * (vec2(vnoise(q * 0.018 + $seed), vnoise(q * 0.018 + 31.0 + $seed)) - 0.5);
  vec2 wa;
  vec2 wb;
  float ha = $patch(q, jq, dens, 0.0, wa);
  float hb = $patch(q, jq + 0.5 * $CELL, dens, 0.5, wb);
  float sw = wa.x + wb.x + 1e-4;
  float hatching = max(ha * smoothstep(0.0, 0.6, wa.x / sw), hb * smoothstep(0.0, 0.6, wb.x / sw));

  // ---- contours: broken, irregular pressure, an occasional lighter second pass beside the first
  vec2 bc = floor(q / 18.0);
  vec2 j = (vec2(hash12(bc + $boilPh * 1.37 + $seed), hash12(bc + $boilPh * 2.71 + 5.0)) - 0.5) * $boil;
  vec2 s = q + j;
  float w = 0.9 * $weight;
  float e = max($edge(s), max(max($edge(s + vec2(w, 0.0)), $edge(s - vec2(w, 0.0))),
                              max($edge(s + vec2(0.0, w)), $edge(s - vec2(0.0, w)))));
  float pres = mix(0.4, 1.0, smoothstep(0.25, 0.8, fbm(q * 0.012 + 5.0 + $seed)));
  float gaps = smoothstep(0.22, 0.4, vnoise(q * 0.03 + 3.0 + $seed));
  float contour = smoothstep(0.05, 0.3, e) * pres * gaps;
  float a2 = 6.2832 * vnoise(q * 0.008 + 19.0);
  float e2 = $edge(s + 1.6 * $weight * vec2(cos(a2), sin(a2)));
  contour = max(contour, 0.4 * smoothstep(0.08, 0.35, e2) * smoothstep(0.55, 0.7, vnoise(q * 0.025 + 41.0 + $seed)));
  float lineIn = smoothstep(ord, ord + 0.03, $draw);

  // ---- reveal and return: the paper spreads behind the drawing; the colour floods back from the origin
  float home = smoothstep(ord, ord + 0.09, $back);
  float marks = max(contour * lineIn, hatching) * tooth * (1.0 - smoothstep(ord + 0.04, ord + 0.3, $back));
  // on an extended cover only the card turns into the drawing; its blurred surround stays as it is
  float paperIn = smoothstep(ord + 0.02, ord + 0.09, $draw) * (1.0 - home) * mix(1.0, p.card, $cardOnly);

  // the sketch: warm paper with a soft graphite tone in the forms (or a dark ground with chalk)
  float grainP = vnoise(q * 0.55 + 7.0 + $seed);
  vec3 sheet = $paper * (0.955 + 0.06 * grainP);
  // graphite rubbed in unevenly where the forms are dark; a breath of it in the clean areas
  float rub = mix(0.55, 1.0, fbm(q * 0.01 + 23.0 + $seed));
  float smudge = (0.32 * smoothstep(0.5, 1.05, dens) + 0.14 * clean * smoothstep(0.2, 0.9, tone)) * rub * mix(0.75, 1.0, tooth);
  // chalk: a dark toned paper that keeps the picture's values faintly, so lit faces stay lit
  vec3 toned = $paper * (0.07 + 0.3 * p.luma) * mix(0.85, 1.0, grainP);
  vec3 ground = mix(sheet * (1.0 - smudge), toned, $chalk);
  // the paper keeps a breath of the colour of each place (its hue, not its darkness)
  vec3 hue = c / max(max(c.r, c.g), max(c.b, 0.03));
  vec3 sketch = ground * mix(vec3(1.0), hue, 0.14);
  // the colour flooding back leaves a slightly darker tide line, like a wash drying
  float bk = $back - ord;
  float tide = smoothstep(0.0, 0.03, bk) * (1.0 - smoothstep(0.03, 0.1, bk)) * step(bk, 0.5);
  vec3 under = mix(c, sketch, $wash * paperIn) * (1.0 - 0.1 * tide * $wash * mix(1.0, p.card, $cardOnly));
  float k = clamp(marks * $fade, 0.0, 1.0);
  vec3 graphite = mix(under, $ink, k * 0.92);
  vec3 chalk = screen(under, $ink * k * 0.85);
  return mix(graphite, chalk, $chalk);
}
`,
  setup(kit, params) {
    const tone = kit.scene.tone ?? {};
    const chalk = params.ink === 'chalk' || (params.ink === 'auto' && (tone.key === 'dark' || (tone.luma ?? 0.5) < 0.33));
    const ink = chalk ? kit.colour('paper') : kit.colour('graphite');
    const paper = kit.colour('paper');
    const origin = [kit.focus.x ?? 0.5, kit.focus.y ?? 0.5];
    const reach = Math.max(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => Math.hypot((x - origin[0]) * 1.7778, y - origin[1])));
    // The light comes from the brightest light of the cover, else from the upper left.
    const light = kit.lights[0];
    let lightDir = light ? [light.x - origin[0], light.y - origin[1]] : [-0.6, -0.8];
    const len = Math.hypot(...lightDir);
    lightDir = len > 0.05 ? lightDir.map((v) => v / len) : [-0.6, -0.8];
    // Far, flat areas stay paper; a cover without real depth range has no such areas.
    const [lo, hi] = kit.scene.depth?.range ?? [0, 1];
    const farDepth = hi - lo > 0.15 ? lo + 0.1 * (hi - lo) : -1;
    const seed = Math.floor(kit.random() * 1000);
    const done = 7.5;
    return {
      uniforms: (t, env) => {
        // The drawing moves in 12 phases per second, like a hand-drawn animation.
        const tq = stepped(t, 12) / 12;
        const k = smoothstep(params.start, params.start + params.drawFor, tq);
        const draw = 1.45 * (1 - (1 - k) ** 2); // fast at first, settling: a hand slowing down
        const back = 1.35 * smoothstep(params.liftAt, done, tq);
        return {
          draw,
          back,
          fade: params.amount * env,
          wash: params.wash * env,
          boilPh: stepped(t, 12),
          boil: params.boil,
          seed,
          origin,
          reach,
          lightDir,
          farDepth,
          ink,
          chalk: chalk ? 1 : 0,
          weight: params.weight,
          hatch: params.hatch,
          paper,
          cardOnly: kit.mode === 'extend' ? 1 : 0,
        };
      },
    };
  },
};

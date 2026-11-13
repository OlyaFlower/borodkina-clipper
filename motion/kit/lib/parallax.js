// Depth parallax (2.5D) of the cover in one WebGL pass, with a soft light sweep, paper grain anchored to
// the image and a light vignette. At t = 0 every effect is exactly zero and the cover is sampled at
// its own texel centres, so frame 0 is the cover unchanged.

import { DURATION, HEIGHT, WIDTH, mix, orbit, plateau, rgb, swell } from './loop.js';

const VERTEX = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
uniform sampler2D uCover;
uniform sampler2D uDepth;
uniform sampler2D uBackground; // extend mode: the blurred surround without the card
uniform vec2 uRes;
uniform float uExtend;     // 0: the cover fills the frame (depth parallax); 1: a card over a background
uniform vec4 uCard;        // extend mode: card rectangle x0, y0, x1, y1 in 0..1 of the frame
uniform vec2 uOffset;      // camera offset in pixels per unit of depth away from the focal plane
uniform float uFocusDepth; // depth that stays still (the faces, or the subject)
uniform float uSweep;      // light sweep strength, 0 at the loop ends
uniform float uSweepPos;   // sweep centre along the diagonal, -0.3..1.3
uniform vec3 uSweepColor;
uniform float uGrain;      // grain strength, 0 at the loop ends
uniform float uVignette;   // vignette strength, 0 at the loop ends

float hash(vec2 q) {
  q = fract(q * vec2(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

float valueNoise(vec2 q) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Parallax occlusion: march from the nearest depth to the farthest and take the first surface that
// covers this pixel, so near things (people, crowds) stay crisp in front of what moves behind them.
// With a zero offset every step samples uv itself: frame 0 is the cover texel for texel.
vec2 parallax(vec2 uv, vec2 shift, out float depth) {
  const int STEPS = 14;
  float hi = 1.0;          // last height that missed
  float lo = 0.0;          // first height that hit
  bool found = false;
  for (int i = 0; i <= STEPS; i++) {
    float h = 1.0 - float(i) / float(STEPS);
    if (texture2D(uDepth, uv - shift * (h - uFocusDepth)).r >= h) {
      lo = h;
      found = true;
      break;
    }
    hi = h;
  }
  if (!found) lo = 0.0;
  for (int j = 0; j < 5; j++) {
    float h = 0.5 * (lo + hi);
    if (texture2D(uDepth, uv - shift * (h - uFocusDepth)).r >= h) lo = h; else hi = h;
  }
  vec2 src = uv - shift * (lo - uFocusDepth);
  depth = texture2D(uDepth, src).r;
  return src;
}

void main() {
  // Image space: (0, 0) is the top-left texel of the cover, like the textures.
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = px / uRes;
  vec2 src;
  float depth;
  vec3 color;

  if (uExtend > 0.5) {
    // The card moves with the camera, the blurred surround moves the other way; the card is flat,
    // so a poster's lettering never bends.
    vec2 cardShift = uOffset * (0.6 - uFocusDepth) / uRes;
    vec2 backShift = uOffset * (0.0 - uFocusDepth) / uRes;
    vec2 cuv = uv - cardShift;
    vec2 inside = min(cuv - uCard.xy, uCard.zw - cuv) * uRes;
    float cover = clamp(min(inside.x, inside.y) + 0.5, 0.0, 1.0);
    vec2 hp = 0.5 / uRes;
    vec2 cardSrc = clamp(cuv, uCard.xy + hp, uCard.zw - hp);
    vec2 backSrc = clamp(uv - backShift, hp, 1.0 - hp);
    color = mix(texture2D(uBackground, backSrc).rgb, texture2D(uCover, cardSrc).rgb, cover);
    src = mix(backSrc, cardSrc, cover);
    depth = 0.6 * cover;
  } else {
    // Parallax fades out over the outer 5 % so the frame edges never sample outside the cover.
    vec2 edge = smoothstep(vec2(0.0), vec2(0.05), uv) * smoothstep(vec2(0.0), vec2(0.05), 1.0 - uv);
    src = parallax(uv, uOffset / uRes * edge.x * edge.y, depth);
    color = texture2D(uCover, src).rgb;
  }

  // Soft light sweep along the diagonal, screen-blended; it catches light surfaces and near things,
  // and leaves blacks black.
  float along = (uv.x * 1.7778 + (1.0 - uv.y)) / 2.7778;
  float band = exp(-pow((along - uSweepPos) / 0.16, 2.0));
  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 light = uSweepColor * (uSweep * band * (0.25 + 0.75 * luma) * (0.7 + 0.3 * depth));
  color = 1.0 - (1.0 - color) * (1.0 - light);

  // Paper grain, fixed to the picture (sampled at the source point), strongest in the mid-tones.
  vec2 gp = src * uRes;
  float g = valueNoise(gp * 0.7) * 0.65 + valueNoise(gp * 1.9 + 17.0) * 0.35 - 0.5;
  color += g * uGrain * (0.35 + 0.65 * (1.0 - abs(luma * 2.0 - 1.0)));

  // Vignette.
  vec2 v = (uv - 0.5) * vec2(1.0, 0.82);
  color *= 1.0 - uVignette * smoothstep(0.32, 0.78, length(v));

  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`motion kit: shader: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function texture(gl, unit, image, format) {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, format, format, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * createParallax(canvas, { cover, depth, background, scene, intensity }) -> draw(t)
 *   cover, depth: loaded HTMLImageElements (cover 1920x1080, depth any size, 255 = near)
 *   background: the blurred surround (scene.framing.mode "extend" only), else null
 *   scene: the prepared meta.json (focus, palette)
 *   intensity: scales every effect, 1 = the calm default
 * Throws if WebGL is unavailable, so a render fails loudly instead of shipping a still picture.
 */
export function createParallax(canvas, { cover, depth, background = null, scene, intensity = 1 }) {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('motion kit: WebGL is unavailable');

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`motion kit: link: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const extend = scene.framing?.mode === 'extend' && background !== null;
  texture(gl, 0, cover, gl.RGB);
  texture(gl, 1, depth, gl.LUMINANCE);
  texture(gl, 2, extend ? background : cover, gl.RGB);
  const u = (name) => gl.getUniformLocation(program, name);
  gl.uniform1i(u('uCover'), 0);
  gl.uniform1i(u('uDepth'), 1);
  gl.uniform1i(u('uBackground'), 2);
  gl.uniform2f(u('uRes'), WIDTH, HEIGHT);
  gl.uniform1f(u('uExtend'), extend ? 1 : 0);
  const box = scene.framing?.coverBox ?? [0, 0, WIDTH, HEIGHT];
  gl.uniform4f(u('uCard'), box[0] / WIDTH, box[1] / HEIGHT, box[2] / WIDTH, box[3] / HEIGHT);
  // Extend mode: the card (depth 0.6) and the surround (depth 0) move in opposite directions.
  gl.uniform1f(u('uFocusDepth'), extend ? 0.3 : (scene.focus?.depth ?? 0.5));
  // The sweep is a warm white tinted a quarter of the way towards the cover's lightest colour.
  gl.uniform3fv(u('uSweepColor'), mix([1, 0.95, 0.86], rgb(scene.palette?.light), 0.25));
  const uOffset = u('uOffset');
  const uSweep = u('uSweep');
  const uSweepPos = u('uSweepPos');
  const uGrain = u('uGrain');
  const uVignette = u('uVignette');
  gl.viewport(0, 0, WIDTH, HEIGHT);

  // Camera amplitudes in pixels per unit of depth: a calm orbit, about 1 % of the width at the most.
  const ax = 9 * intensity;
  const ay = 5 * intensity;

  return (t) => {
    const time = Math.min(Math.max(t, 0), DURATION);
    const o = orbit(time);
    const s = swell(time);
    const p = plateau(time);
    gl.uniform2f(uOffset, ax * o.x, ay * o.y);
    gl.uniform1f(uSweep, 0.22 * intensity * s);
    gl.uniform1f(uSweepPos, -0.3 + 1.6 * (time / DURATION));
    gl.uniform1f(uGrain, 0.035 * intensity * p);
    gl.uniform1f(uVignette, 0.14 * intensity * p);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}

// WebGL plumbing of the kit: one full-screen pass per frame whose fragment shader is assembled from the
// blocks of a scene spec (see compose.js and API.md). No frame-to-frame state: the picture at t depends
// only on t, so HyperFrames can seek anywhere.

export const VERTEX = `
attribute vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }
`;

/** The textures every block may sample (all 0..1, image space: (0, 0) is the top-left of the cover). */
export const TEXTURES = {
  tCover: 'the prepared cover (1920x1080)',
  tDepth: 'depth, r = 1 nearest (guided to the picture, flat inside faces)',
  tPlate: 'crop mode: the cover with what near edges hide repainted; else the cover',
  tPlateDepth: 'crop mode: depth of the plate; else depth',
  tBackground: 'extend mode: the blurred surround without the card; else the cover',
  tEdges: 'thin salient edges, r = strength (pencil lines)',
  tGlow: "the cover's highlights, blurred (bloom)",
};

/**
 * Shared GLSL available to every block: the Px struct the base block fills, uRes and uTime, the
 * textures above, and small helpers. Everything here is a pure function of its arguments.
 */
export const COMMON = `
precision highp float;
uniform vec2 uRes;    // 1920, 1080
uniform float uTime;  // seconds, 0..8
${Object.keys(TEXTURES)
  .map((name) => `uniform sampler2D ${name};`)
  .join('\n')}

struct Px {
  vec2 uv;      // this pixel in the frame, 0..1, (0, 0) top-left
  vec2 src;     // where the base block sampled the cover: anchors textures to the picture
  float depth;  // depth of what this pixel shows, 1 = nearest
  float card;   // extend mode: 1 on the card, 0 on the surround (anti-aliased)
  float luma;   // luminance of the base colour
};

const float PI = 3.14159265;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 screen(vec3 a, vec3 b) { return 1.0 - (1.0 - a) * (1.0 - b); }

float hash12(vec2 q) {
  vec3 p3 = fract(vec3(q.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 q) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 q) {
  return 0.55 * vnoise(q) + 0.3 * vnoise(q * 2.03 + 17.1) + 0.15 * vnoise(q * 4.01 + 41.7);
}

// A Gaussian-blurred box (x0, y0, x1, y1 in pixels) at pixel q: 1 deep inside, 0 far outside.
float erfApprox(float x) {
  float s = sign(x);
  float a = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * a);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
  return s * y;
}
float softBox(vec2 q, vec4 box, float sigma) {
  float k = 1.0 / (sqrt(2.0) * max(sigma, 0.001));
  float x = 0.5 * (erfApprox((q.x - box.x) * k) - erfApprox((q.x - box.z) * k));
  float y = 0.5 * (erfApprox((q.y - box.y) * k) - erfApprox((q.y - box.w) * k));
  return x * y;
}

// Catmull-Rom bicubic sample in 9 bilinear taps: sharp at sub-pixel offsets, exact at texel centres.
vec3 sampleSharp(sampler2D tex, vec2 uv) {
  vec2 pos = uv * uRes;
  vec2 c1 = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 t0 = (c1 - 1.0) / uRes;
  vec2 t3 = (c1 + 2.0) / uRes;
  vec2 t12 = (c1 + o12) / uRes;
  vec3 r = vec3(0.0);
  r += texture2D(tex, vec2(t0.x, t0.y)).rgb * w0.x * w0.y;
  r += texture2D(tex, vec2(t12.x, t0.y)).rgb * w12.x * w0.y;
  r += texture2D(tex, vec2(t3.x, t0.y)).rgb * w3.x * w0.y;
  r += texture2D(tex, vec2(t0.x, t12.y)).rgb * w0.x * w12.y;
  r += texture2D(tex, vec2(t12.x, t12.y)).rgb * w12.x * w12.y;
  r += texture2D(tex, vec2(t3.x, t12.y)).rgb * w3.x * w12.y;
  r += texture2D(tex, vec2(t0.x, t3.y)).rgb * w0.x * w3.y;
  r += texture2D(tex, vec2(t12.x, t3.y)).rgb * w12.x * w3.y;
  r += texture2D(tex, vec2(t3.x, t3.y)).rgb * w3.x * w3.y;
  return r;
}
`;

const UNIFORM_RE = /uniform\s+(float|int|vec2|vec3|vec4)\s+\$([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;

/** The uniforms a block declares with the $ prefix: { name: { type, size } }. */
export function blockUniforms(glsl) {
  const out = {};
  for (const m of glsl.matchAll(UNIFORM_RE)) out[m[2]] = { type: m[1], size: m[3] ? Number(m[3]) : 0 };
  return out;
}

/** Replaces the block-local $ prefix with a unique one, so a block can appear twice in a scene. */
export const prefixed = (glsl, prefix) => glsl.replace(/\$(?=[A-Za-z_])/g, prefix);

/**
 * The fragment shader of a scene: COMMON, then each block's code with its own prefix, then main(),
 * which runs the base block and then every pixel block in spec order.
 */
export function fragmentShader(glBlocks, { extend = false } = {}) {
  const parts = [COMMON.replace('\nprecision', `\n#define KIT_EXTEND ${extend ? 1 : 0}\nprecision`)];
  const calls = [];
  glBlocks.forEach((b, i) => {
    const pre = `b${i}_`;
    parts.push(`// ---- block ${i}: ${b.name}\n${prefixed(b.glsl, pre)}`);
    calls.push(b.stage === 'base' ? `  vec3 c = ${pre}base(p);\n  p.luma = luma(c);` : `  c = ${pre}apply(c, p);`);
  });
  parts.push(`
void main() {
  Px p;
  p.uv = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uRes;
  p.src = p.uv;
  p.depth = 0.0;
  p.card = 0.0;
  p.luma = 0.0;
${calls.join('\n')}
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`);
  return parts.join('\n');
}

function compile(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)} ${l}`)
      .join('\n');
    console.error(numbered);
    throw new Error(`motion kit: ${label} shader: ${log}`);
  }
  return shader;
}

export function program(gl, fragment) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX, 'vertex'));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragment, 'fragment'));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`motion kit: link: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.useProgram(prog);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return prog;
}

export function texture(gl, unit, image, format) {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (image) {
    gl.texImage2D(gl.TEXTURE_2D, 0, format, format, gl.UNSIGNED_BYTE, image);
  } else {
    const n = format === gl.RGB ? 3 : 1;
    gl.texImage2D(gl.TEXTURE_2D, 0, format, 1, 1, 0, format, gl.UNSIGNED_BYTE, new Uint8Array(n));
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Sets a uniform from a JS value according to its declared type. */
export function setUniform(gl, loc, { type, size }, value) {
  if (loc === null || value === undefined) return;
  if (type === 'int') return gl.uniform1i(loc, value);
  if (type === 'float') return size ? gl.uniform1fv(loc, value) : gl.uniform1f(loc, value);
  const fn = { vec2: gl.uniform2fv, vec3: gl.uniform3fv, vec4: gl.uniform4fv }[type];
  fn.call(gl, loc, value instanceof Float32Array ? value : new Float32Array(value));
}

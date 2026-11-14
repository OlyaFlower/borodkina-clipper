// Gentle dust motes and a few soft bokeh discs on a Canvas 2D layer (screen-blended over the cover),
// coloured from the cover's palette. Positions come from a seeded PRNG, motion is periodic in the loop
// (whole cycles only) and follows the camera orbit by each particle's depth, and everything fades to
// zero at the loop ends, so frame 0 shows no particle at all.

import { DURATION, HEIGHT, WIDTH, mix, mulberry32, orbit, phase, plateau, rgb } from './loop.js';

const css = (c, a) =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a.toFixed(4)})`;

/**
 * createParticles(canvas, { scene, seed, intensity }) -> draw(t)
 *   scene: the prepared meta.json (palette, faces, focus); particles keep clear of faces.
 */
export function createParticles(canvas, { scene, seed = 20261114, intensity = 1 }) {
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  const random = mulberry32(seed);
  const faces = (scene.faces || []).map((f) => ({
    x0: f.x - f.w * 0.4,
    y0: f.y - f.h * 0.4,
    x1: f.x + f.w * 1.4,
    y1: f.y + f.h * 1.6,
  }));
  const clear = (x, y) => faces.every((f) => x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1);
  const place = () => {
    for (let i = 0; i < 20; i++) {
      const x = random() * WIDTH;
      const y = random() * HEIGHT;
      if (clear(x, y)) return [x, y];
    }
    return [random() * WIDTH, random() * HEIGHT];
  };

  const white = [1, 1, 1];
  const colors = (scene.palette?.colors || []).map((c) => rgb(c.hex));
  const light = rgb(scene.palette?.light);
  const focusDepth = scene.framing?.mode === 'extend' ? 0.4 : (scene.focus?.depth ?? 0.5);
  // Bokeh takes the palette's colours, lifted towards white so it reads as light, never as paint.
  const bokehColor = (i) => mix(colors.length ? colors[i % colors.length] : light, white, 0.55);
  const moteColor = mix(light, white, 0.6);

  const motes = Array.from({ length: 64 }, () => {
    const [x, y] = place();
    const z = 0.35 + random() * 0.65; // nearer motes are bigger, brighter and move more
    return {
      x,
      y,
      z,
      r: 0.9 + 1.9 * z,
      a: (0.22 + random() * 0.38) * z,
      ax: 14 + random() * 40,
      ay: 10 + random() * 34,
      cx: 1 + Math.floor(random() * 2),
      cy: 1 + Math.floor(random() * 2),
      tw: 1 + Math.floor(random() * 3),
      p1: random() * Math.PI * 2,
      p2: random() * Math.PI * 2,
      p3: random() * Math.PI * 2,
    };
  });
  const bokeh = Array.from({ length: 9 }, (_, i) => {
    const [x, y] = place();
    return {
      x,
      y,
      z: 1.1 + random() * 0.6, // in front of everything: out of focus
      r: 34 + random() * 70,
      a: 0.05 + random() * 0.06,
      ax: 30 + random() * 60,
      ay: 18 + random() * 36,
      p1: random() * Math.PI * 2,
      p2: random() * Math.PI * 2,
      color: bokehColor(i),
    };
  });

  // Camera amplitudes match the parallax layer (parallax.js) so particles sit in the same space.
  const ax = 11 * intensity;
  const ay = 6 * intensity;

  return (t) => {
    const time = Math.min(Math.max(t, 0), DURATION);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    const k = plateau(time) * intensity;
    if (k <= 0) return;
    const w = phase(time);
    const o = orbit(time);
    ctx.globalCompositeOperation = 'lighter';

    for (const b of bokeh) {
      const x = b.x + b.ax * Math.sin(w + b.p1) - b.ax * Math.sin(b.p1) + ax * o.x * (b.z - focusDepth) * 3;
      const y = b.y + b.ay * Math.sin(w + b.p2) - b.ay * Math.sin(b.p2) + ay * o.y * (b.z - focusDepth) * 3;
      const g = ctx.createRadialGradient(x, y, 0, x, y, b.r);
      g.addColorStop(0, css(b.color, b.a * k * 0.8));
      g.addColorStop(0.72, css(b.color, b.a * k));
      g.addColorStop(0.86, css(b.color, b.a * k * 0.55));
      g.addColorStop(1, css(b.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const m of motes) {
      const x = m.x + m.ax * (Math.sin(w * m.cx + m.p1) - Math.sin(m.p1)) + ax * o.x * (m.z - focusDepth);
      const y = m.y + m.ay * (Math.sin(w * m.cy + m.p2) - Math.sin(m.p2)) + ay * o.y * (m.z - focusDepth);
      const twinkle = 0.55 + 0.45 * Math.sin(w * m.tw + m.p3);
      const a = m.a * twinkle * k;
      const g = ctx.createRadialGradient(x, y, 0, x, y, m.r * 2.2);
      g.addColorStop(0, css(moteColor, a));
      g.addColorStop(0.45, css(moteColor, a * 0.6));
      g.addColorStop(1, css(moteColor, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, m.r * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  };
}

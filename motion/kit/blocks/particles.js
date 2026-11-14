// particles (overlay): dust motes and a few soft out-of-focus bokeh discs on the 2D overlay (screen-
// blended over the picture), coloured from the palette. Positions are seeded; every motion is periodic
// in the loop (whole cycles only) and follows the camera by each particle's depth; motes twinkle a
// little brighter on the beats. Particles keep clear of faces and, on an extended cover, stay behind
// the card so the poster is never covered.

import { mix, phase } from '../lib/loop.js';

const css = (c, a) =>
  `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${Math.max(0, a).toFixed(4)})`;

export default {
  name: 'particles',
  stage: 'overlay',
  about: 'Seeded dust motes and soft bokeh discs in palette colours, moving with the camera by depth, clear of faces and the card.',
  rhythm: 'ambient',
  params: {
    dust: { type: 'number', min: 0, max: 200, default: 60, about: 'number of dust motes' },
    bokeh: { type: 'number', min: 0, max: 16, default: 8, about: 'number of bokeh discs' },
    amount: { type: 'number', min: 0, max: 1.5, default: 1, about: 'overall opacity' },
    drift: { type: 'number', min: 0, max: 2, default: 1, about: 'how far motes wander' },
    colour: { type: 'colour', default: 'light', about: 'colour of the motes; bokeh take the palette' },
    region: { type: 'enum', values: ['all', 'upper', 'lower'], default: 'all', about: 'where the motes float' },
  },
  presets: {
    subtle: { dust: 50, bokeh: 6, amount: 0.85 },
    medium: { dust: 90, bokeh: 10, amount: 1.1 },
  },
  setup(kit, params) {
    const { width: W, height: H } = kit;
    const random = kit.random;
    const faces = kit.faces.map((f) => ({ x0: f.x - f.w * 0.4, y0: f.y - f.h * 0.4, x1: f.x + f.w * 1.4, y1: f.y + f.h * 1.6 }));
    const card = kit.card;
    const yRange = params.region === 'upper' ? [0, 0.6] : params.region === 'lower' ? [0.4, 1] : [0, 1];
    const clear = (x, y) =>
      faces.every((f) => x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) &&
      (!card || x < card[0] - 20 || x > card[2] + 20 || y < card[1] - 20 || y > card[3] + 20);
    const place = () => {
      for (let i = 0; i < 30; i++) {
        const x = random() * W;
        const y = (yRange[0] + random() * (yRange[1] - yRange[0])) * H;
        if (clear(x, y)) return [x, y];
      }
      return [random() * W, (yRange[0] + random() * (yRange[1] - yRange[0])) * H];
    };
    // Particles are lit specks: palette hues at full brightness (kit.light), never grey.
    const white = [1, 1, 1];
    const pal = (kit.scene.palette?.colors ?? []).map((c) => kit.light(c.hex));
    const moteColour = mix(kit.light(params.colour), white, 0.3);
    const bokehColour = (i) => mix(pal.length ? pal[i % pal.length] : moteColour, white, 0.25);
    const pivot = kit.focusDepth;
    const motes = Array.from({ length: Math.round(params.dust) }, () => {
      const [x, y] = place();
      const z = 0.35 + random() * 0.65; // nearer motes are bigger, brighter and move more
      return {
        x, y, z,
        r: 0.9 + 1.9 * z,
        a: (0.22 + random() * 0.38) * z,
        ax: (14 + random() * 40) * params.drift,
        ay: (10 + random() * 34) * params.drift,
        cx: 1 + Math.floor(random() * 2),
        cy: 1 + Math.floor(random() * 2),
        tw: 1 + Math.floor(random() * 3),
        p1: random() * Math.PI * 2,
        p2: random() * Math.PI * 2,
        p3: random() * Math.PI * 2,
      };
    });
    const bokeh = Array.from({ length: Math.round(params.bokeh) }, (_, i) => {
      const [x, y] = place();
      return {
        x, y,
        z: card ? 0.2 + random() * 0.15 : 1.1 + random() * 0.6, // behind the card, or in front of everything
        r: 34 + random() * 70,
        a: 0.05 + random() * 0.06,
        ax: 30 + random() * 60,
        ay: 18 + random() * 36,
        p1: random() * Math.PI * 2,
        p2: random() * Math.PI * 2,
        colour: bokehColour(i),
      };
    });

    return {
      draw(ctx, t, env) {
        const k = env * params.amount;
        if (k <= 0) return;
        const w = phase(t);
        const cam = kit.camera(t);
        const pulse = kit.rhythm(t, 'reactive');
        if (card) {
          // Stay behind the card: clip it out at its current place.
          const [x0, y0, x1, y1] = kit.cardRect(t);
          ctx.beginPath();
          ctx.rect(0, 0, W, H);
          ctx.rect(x0, y0, x1 - x0, y1 - y0);
          ctx.clip('evenodd');
        }
        ctx.globalCompositeOperation = 'lighter';
        for (const b of bokeh) {
          const x = b.x + b.ax * (Math.sin(w + b.p1) - Math.sin(b.p1)) + cam.x * (b.z - pivot) * 2;
          const y = b.y + b.ay * (Math.sin(w + b.p2) - Math.sin(b.p2)) + cam.y * (b.z - pivot) * 2;
          const g = ctx.createRadialGradient(x, y, 0, x, y, b.r);
          g.addColorStop(0, css(b.colour, b.a * k * 0.8));
          g.addColorStop(0.72, css(b.colour, b.a * k));
          g.addColorStop(0.86, css(b.colour, b.a * k * 0.55));
          g.addColorStop(1, css(b.colour, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, b.r, 0, Math.PI * 2);
          ctx.fill();
        }
        for (const m of motes) {
          const x = m.x + m.ax * (Math.sin(w * m.cx + m.p1) - Math.sin(m.p1)) + cam.x * (m.z - pivot);
          const y = m.y + m.ay * (Math.sin(w * m.cy + m.p2) - Math.sin(m.p2)) + cam.y * (m.z - pivot);
          const twinkle = 0.55 + 0.45 * Math.sin(w * m.tw + m.p3);
          const a = m.a * twinkle * k * (1 + 0.6 * pulse * m.z);
          const g = ctx.createRadialGradient(x, y, 0, x, y, m.r * 2.2);
          g.addColorStop(0, css(moteColour, a));
          g.addColorStop(0.45, css(moteColour, a * 0.6));
          g.addColorStop(1, css(moteColour, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, m.r * 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      },
    };
  },
};

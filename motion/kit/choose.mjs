// Picks the preset scene for a prepared cover, deterministically, from its meta.json alone:
//   node motion/kit/choose.mjs <meta.json>      prints the preset name (motion/kit/presets/<name>.json)
// The fallback authoring uses it; Claude may start from its choice. The rules, first match wins:
//   1. an extended cover (a poster shown whole as a card)       -> poster-float
//   2. a face                                                    -> intimate-portrait
//   3. dark, with several highlights (stage lights, a lit room)  -> concert-glow
//   4. dark otherwise (a dim room, night, an almost empty frame) -> night-stage
//   5. a strong light in the picture (the sun, a lamp), not light overall -> sunlit-depth
//   6. anything else (light, pale, graphic covers)               -> pencil-reveal

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PRESETS = ['concert-glow', 'night-stage', 'intimate-portrait', 'poster-float', 'pencil-reveal', 'sunlit-depth'];

/** Returns { preset, reason } for a prepared meta.json object. */
export function choose(meta) {
  const tone = meta.tone ?? {};
  const lights = meta.lights ?? [];
  const luma = tone.luma ?? 0.5;
  const dark = tone.key === 'dark' || luma < 0.3;
  if (meta.framing?.mode === 'extend') return { preset: 'poster-float', reason: 'extended cover: the poster floats as a card' };
  if ((meta.faces ?? []).length > 0) return { preset: 'intimate-portrait', reason: `${meta.faces.length} face(s): calm, faces rigid` };
  if (dark && (lights.length >= 2 || (tone.highlights ?? 0) > 0.01))
    return { preset: 'concert-glow', reason: `dark (luma ${luma}) with ${lights.length} light(s)` };
  if (dark) return { preset: 'night-stage', reason: `dark (luma ${luma}) without strong lights: beams bring the light` };
  if (lights.length && lights[0].luma > 0.8 && tone.key !== 'light')
    return { preset: 'sunlit-depth', reason: `a strong light at (${lights[0].x}, ${lights[0].y})` };
  return { preset: 'pencil-reveal', reason: `${tone.key ?? 'mid'} cover: the brand's pencil drawing` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node motion/kit/choose.mjs <meta.json>');
    process.exit(2);
  }
  const { preset, reason } = choose(JSON.parse(readFileSync(path, 'utf8')));
  console.error(`choose: ${preset} (${reason})`);
  console.log(preset);
}

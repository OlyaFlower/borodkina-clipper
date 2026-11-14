# Motion kit 2.1 (`kit-2.1`)

An 8-second, 30 fps, 1920x1080, silent, seamlessly looping video made from an event cover. A **scene spec**
(JSON) lists **blocks**; `compose/index.html` renders it with HyperFrames. Frame 0 is the cover, pixel for
pixel, and the last frame runs into the first.

```
motion/kit/
  compose/index.html   the only composition: renders window.__MOTION_SPEC over window.__MOTION_SCENE
  lib/loop.js          time: DURATION, rhythms (envelope), beats, camera paths, seeded PRNG, colours
  lib/gl.js            the shared GLSL (Px, helpers, textures) and shader assembly
  lib/spec.js          parameter resolution, named colours, checkSpec()
  lib/compose.js       the engine: loads blocks, checks the spec, one WebGL pass + one 2D overlay
  lib/scene.js         HyperFrames wiring (build-ready promise, paused GSAP timeline, hf-seek)
  blocks/*.js          one module per block
  presets/*.json       curated scene specs
  scene.schema.json    JSON schema of a scene spec (generated: node motion/kit/schema.mjs)
  choose.mjs           picks a preset from meta.json (the fallback)
  validate.mjs         schema + kit checks of a spec: node motion/kit/validate.mjs scene.json [meta.json]
```

## Scene spec

```json
{
  "kit": "kit-2.1",
  "name": "concert-glow",
  "seed": 20261114,
  "beats": [2, 5.6],
  "blocks": [
    { "block": "parallax", "preset": "subtle", "params": { "camera": "orbit", "amount": 18 } },
    { "block": "light-pulse", "preset": "subtle", "params": { "source": "light" } },
    { "block": "bloom", "preset": "medium", "timing": { "rhythm": "reactive" } },
    { "block": "particles" }
  ]
}
```

- `blocks[0]` is the **base** (`parallax` or `card-float`); every other block is a **pixel** block (applied in
  order inside one shader) or an **overlay** block (drawn on a 2D canvas, screen-blended on top). At most 12.
- `preset`: the block's intensity, `subtle` (default) or `medium`. `params` override single values; the
  schema lists every parameter with its range and meaning.
- `timing.rhythm` (default: the block's own): `primary` (a beat at each scene beat; one slow swell without
  beats), `reactive` (answers each beat 0.2 s later, shorter), `ambient` (fades in over 1.6 s, stays, fades
  out), `wave` (one sin² swell over the loop). `timing.delay` (−1..1 s) shifts the beats of that block only.
- `beats`: up to 3 times strictly inside 0.5..6.4 s, so no beat crosses the loop seam. Two beats (for
  example 2 and 5.6) give a calm rhythm; none is fine.
- `seed`: every random choice (particles, beam phases) comes from it.
- Colours (`colour` params): `light`, `dark`, `accent`, `c0`..`c4` (the palette, most common first), `warm`,
  `paper`, `graphite`, `white`, or `#rrggbb`.

## Blocks

| Block | Stage | Does | Default rhythm |
| --- | --- | --- | --- |
| `parallax` | base | Crop cover: 2.5D depth parallax, camera `orbit` / `drift` / `tilt` / `dolly`, a pivot depth that stays still (the subject; faces are flat in depth so they move rigidly). Occlusion marching keeps near things crisp (prepare grows near things 2 px past their outline in depth, so thin near things keep their own crisp edge instead of a toothed fringe); where the camera reveals what a near edge hid, the occlusion plate is shown. Extend cover: the card moves rigidly over the surround. | ambient |
| `card-float` | base | Extend cover only: the poster card rises and sways as a rigid plane (only translated, bicubic-sampled: crisp in every frame), its shadow drops and softens, the surround counter-moves. | wave |
| `light-sweep` | pixel | One soft band of light crosses once per loop; `target: card` makes it a sheen on the card only. | wave |
| `god-rays` | pixel | Shafts from the cover's brightest light (or top / focal point), only where nothing nearer blocks the light. | wave |
| `stage-beams` | pixel | 2–4 swaying volumetric beams from above, haze fixed to the room, behind near things. Lamps take the palette's hues with a saturation floor (`saturation`), so a dull palette still gives coloured light, never beige. | ambient |
| `bloom` | pixel | The cover's own highlights glow (prepare: `glow.png`), anchored to the picture; a floor stays between beats. | reactive |
| `grain` | pixel | Paper/film tooth anchored to the picture (never screen-space), mid-tones only; off the card by default. | ambient |
| `colour-breath` | pixel | White balance leans towards a palette colour and back at equal luminance. | wave |
| `vignette` | pixel | Corners darken gently, breathing twice per loop, centred towards the focal point. | ambient |
| `pencil` | pixel | Brand signature: the cover becomes a pencil drawing on warm paper from the focal point outward and back. Broken, irregular contours (prepare: `edges.png`) first, then hatching in patches fixed to the picture that follow the local contour, only where there is form or shadow (value, the depth's turn from the light, contact shadows); highlights and far flat areas (sky) stay clean paper. Holds and boils at 12 phases per second (seeded stroke imperfections only); from `liftAt` the colour floods back from the focal point and the lines lift, all gone by 7.5 s. For light and mid-key covers: on dark ones (chalk) it reads murky, so the chooser never picks it there. | ambient |
| `light-pulse` | pixel | The beat: a warm exposure swell around the focal point, the main light or (`source: key`) the key-lit side of the main face, at each beat; with `breaths: n` and rhythm `ambient`, n slow breaths per loop instead. | primary |
| `particles` | overlay | Seeded dust motes and bokeh in palette hues, moving with the camera by depth, clear of faces and behind the card. | ambient |

## Block API (for a custom block in `work/blocks/<name>.js`, used as `custom/<name>`)

A block is an ES module whose default export is:

```js
export default {
  name: 'ripple',                 // informative; the spec names it custom/ripple
  stage: 'pixel',                 // 'pixel' or 'overlay' (custom blocks cannot be the base)
  about: 'one sentence',
  rhythm: 'wave',                 // default rhythm
  rest: ['amount'],               // uniforms that must be 0 at t = 0 and t = 8 (tests check kit blocks)
  params: { amount: { type: 'number', min: 0, max: 0.3, default: 0.1, about: '...' } },
  presets: { subtle: { amount: 0.08 }, medium: { amount: 0.15 } },
  glsl: `
uniform float $amount;
vec3 $apply(vec3 c, Px p) { return c + c * $amount * 0.1; }
`,
  setup(kit, params) {            // once, at build time; may precompute with kit.random()
    return { uniforms: (t, env) => ({ amount: params.amount * env }) };
  },
};
```

- Parameter types: `number` (`min`, `max`), `enum` (`values`), `colour`, `boolean`; every one needs a `default`,
  and both `subtle` and `medium` presets must exist.
- **GLSL** (WebGL 1, GLSL ES 1.00): `$` prefixes the block's own uniforms and functions (each block instance
  gets a unique prefix). A pixel block defines `vec3 $apply(vec3 c, Px p)`: `c` is the colour so far, `p`:
  `uv` (0..1, top-left origin), `src` (where the base sampled the cover: anchor every texture to it, never to
  `uv`, or it slides like screen-space noise), `depth` (1 = nearest), `card` (1 on the card), `luma`.
  Available: `uRes`, `uTime`, textures `tCover`, `tDepth`, `tPlate`, `tPlateDepth`, `tBackground`, `tEdges`,
  `tGlow`, and `luma`, `screen`, `hash12`, `vnoise`, `fbm`, `softBox`, `sampleSharp`, `PI`.
- **Overlay** blocks return `{ draw(ctx, t, env) }` and draw on a cleared 1920x1080 2D context (state is saved
  and restored around each block).
- `uniforms(t, env)` / `draw(ctx, t, env)` must be **pure functions of t**: no Date, no Math.random, no
  state carried between calls (HyperFrames seeks frames in any order, in parallel workers). `env` is the
  block's rhythm envelope, 0 at t = 0 and t = 8: multiply every effect by it so frame 0 is the cover.
  Anything periodic must complete whole cycles in 8 s (`phase(t)` from `lib/loop.js`).
- `kit`: `scene` (meta.json), `mode` (`crop` / `extend`), `width`, `height`, `duration`, `beats`, `seed`,
  `random()` (seeded), `envelope(t)` (this block's), `rhythm(t, name)`, `colour(name)`, `light(name)` (the
  hue at full brightness, for emitted light), `focus` (`x`, `y`, `depth`), `focusDepth`, `faces` (px),
  `lights`, `card` (box px or null), `camera(t)` (`x`, `y` px per unit of depth from the pivot, `z` dolly),
  `cardRect(t)` (the card's box now).
- Imports: kit modules by relative path from the assembled project, `../kit/lib/loop.js`.

## The prepared scene (`meta.json`, prepare-2)

`framing` (`mode` crop/extend, `coverBox`, extend: `shadow`), `faces` (px boxes), `focus` (`x`, `y` 0..1,
`depth`, `source`), `palette` (`colors` x5 with `share`, `light`, `dark`, `accent`), `lights` (bright spots,
brightest first: `x`, `y`, `r`, `luma`, `hex`), `tone` (`luma`, `contrast`, `saturation`, `warmth`,
`highlights`, `key` dark/mid/light), `depth` (`mean`, `range` [p5, p95], `plateShare`), `files`. The images:
`cover.jpg`, `depth.png`, `edges.png`, `glow.png`, crop: `plate.jpg` + `plate-depth.png`, extend: `background.jpg`.

## Rendering and checks

```sh
bash scripts/motion-assemble.sh <scene-dir> <prepare-dir> <project-dir>   # validate + build the project
npx --prefix motion hyperframes snapshot <project-dir> --at 0,2,4,6,8 --no-end --no-browser-gpu --keep -o <dir>
bash scripts/motion-render.sh <scene-dir> <prepare-dir>                   # WORK_DIR: render, encode, verify
bash scripts/motion-gates.sh                                              # WORK_DIR: the quality gates
```

Gates: 8 s within a frame; frame 0 vs cover SSIM >= 0.98; last vs first >= 0.98; five snapshots identical
twice (>= 0.999); motion score >= 0.25 (`scripts/motion-measure.py`: luminance change relative to the cover's
own gradient; a warning only for fallback authoring).

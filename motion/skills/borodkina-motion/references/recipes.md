# Recipes: from the cover to a scene

Start from the preset `node motion/kit/choose.mjs prepare/meta.json` names, then adjust. Presets live in
`motion/kit/presets/`.

| Cover | Preset | Focal action | Typical changes |
| --- | --- | --- | --- |
| Poster shown whole (`framing.mode` extend) | `poster-float` | the card lifts off its surround; one sheen | `rise` 8–14, `sway` 6–10; never grain or pencil wash on a busy typographic poster |
| A face (`faces` not empty) | `intimate-portrait` | a slow warm light passes; the camera drifts around the face | `pivot: subject` keeps the face still; small `amount` (10–14); no beams, no bokeh near the face |
| Dark stage, many lights (`tone.key` dark, `lights` >= 2) | `concert-glow` | the lights swell and bloom on two beats | `light-pulse` `source: light`; `bloom` reactive; dust in the upper half |
| Dark, few lights (club, night, empty frame) | `night-stage` | stage beams sway through haze from above | `stage-beams` 2–3 beams; one beat; keep beams behind the subject |
| Strong light in the picture (sun, lamp) | `sunlit-depth` | shafts fan out from the light while the camera pushes in | `god-rays` `source: light`; `camera: dolly`; rays never over near things |
| Light, pale, graphic or drawn covers | `pencil-reveal` | the cover is drawn in pencil from the focal point, then the lines lift | `pencil` `medium`; `wash` 0.3–0.5; chalk is automatic on dark covers |

## Adjusting

- Too busy: drop a block before lowering every amount. One focal action.
- Too static: raise the focal block one step (`subtle` -> `medium`) or add a beat; do not add particles.
- Faces drift or deform: lower `parallax.amount`, set `pivot: subject`, remove effects near faces.
- Smear at depth edges: lower `parallax.amount` (the occlusion plate hides most of it up to ~20 px).
- Muddy light on a dull palette: set the light colour to `warm` or `white`.
- Pencil invisible at 640 px: raise `weight` (1.4–2) and `hatch`; lines too busy: lower `hatch`.
- Two blocks of the same kind are allowed (for example a slow `light-sweep` and a `light-pulse`) if they
  serve the same focal action at different moments.

## Beats

`beats: [2, 5.6]` gives two calm accents. `primary` blocks hit on the beat, `reactive` blocks follow
0.2 s later and shorter. With no beats, `primary` is one slow swell peaking at 4 s.

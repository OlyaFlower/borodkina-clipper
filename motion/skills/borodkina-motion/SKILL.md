---
name: borodkina-motion
description: Compose the 8-second looping preview video of an Olya Borodkina music-event cover from the motion kit (kit-2) - read the prepared cover, write a scene spec (and, only when justified, a custom block), render snapshots, critique them as an art director and iterate. Use in the motion authoring step of borodkina-clipper.
---

# Borodkina motion: authoring a cover loop

You turn one event cover into an 8 s preview loop by writing a **scene spec** for motion kit 2. The kit
does the rendering; your job is the direction: choose what moves, how much, and when, so the cover comes
alive calmly and the result looks premium. Read `motion/kit/API.md` once; it is the reference for every
block, parameter, rhythm and the block API.

## The contract (all hard; the gates check most of it)

- 8 s, 30 fps, 1920x1080, silent. **No text, logos or captions added.** The cover's own lettering stays as is.
- **Frame 0 is the cover**, pixel for pixel, and the loop is **seamless**: every effect is 0 at t = 0 and t = 8
  (multiply by `env`), periodic motion completes whole cycles in 8 s, beats lie inside 0.5..6.4 s.
- **Faces are rigid**: never warp, ripple, scale or relight a face strongly; prepare flattens faces in depth so
  the parallax moves them as one piece. The poster card (extend mode) is never warped or blurred.
- **Deterministic**: no `Math.random`, `Date`, `performance.now`, `requestAnimationFrame` timing, network or
  state carried between frames. A frame is a pure function of t; use `kit.random()` (seeded) at setup only.
- Software WebGL (SwiftShader) in CI: keep custom shaders cheap (no loops over more than ~16 texture taps).

## Inputs

- `prepare/cover.jpg` (the frame), `prepare/meta.json` (framing, faces, focus, palette, lights, tone, depth),
  `prepare/depth.png`, `prepare/edges.png`, `prepare/glow.png`, crop: `prepare/plate.jpg`, extend:
  `prepare/background.jpg`. **Look at `cover.jpg` and `depth.png` first** (Read the images).
- The brief, if any, in the job's brief JSON: respect its intent (mood, tempo); it never overrides the contract.

## Output (in `work/`)

1. `work/scene.json`: the scene spec (required).
2. `work/blocks/<name>.js`: custom blocks, only when no kit block can do it (rare; see below).
3. `work/REVIEW.md`: your final review (format at the end).

## Work loop (at most 4 iterations)

1. **Read** `meta.json` and look at `cover.jpg`, `depth.png` (and `edges.png` if you plan `pencil`).
   Run `node motion/kit/choose.mjs prepare/meta.json`: the fallback's preset is a sound starting point.
2. **Decide the one focal action** in one sentence ("the stage lights swell twice while the room drifts
   around the crowd"). Everything else supports it at lower amplitude. Pick the base camera, then 2–5
   supporting blocks. Start from `motion/kit/presets/<preset>.json` and edit; see `references/recipes.md`.
3. **Validate and assemble**:
   `bash scripts/motion-assemble.sh work prepare work/project` (runs `node motion/kit/validate.mjs`).
4. **Check** for runtime errors: `npx --prefix motion hyperframes check work/project --json --no-contrast --samples 3`
   (`runtime.errorCount` must be 0; GL "performance" warnings are harmless).
5. **Snapshot**: `npx --prefix motion hyperframes snapshot work/project --at 0,2,4,6,8 --no-end --no-browser-gpu --keep -o work/snap`
   and **Read every PNG**. Optionally zoom on faces, the card or edges with `--zoom x,y,w,h`.
   Measure: `python3 -I scripts/motion-measure.py work/snap/at-0s.png work/snap/at-{2,4,6,8}s.png`
   (motion >= 0.25; the 8 s score must be ~0).
6. **Critique** against `references/acceptance.md`: list P0/P1 defects as
   `time · object · observation -> exact change`. Fix P0s first. Stop when no P0/P1 remains or after 4
   iterations; then keep the best version, not the last.

## Direction (distilled from the brand guide; details in `references/direction.md`)

- **One focal action at a time.** Primary motion, reactive answers, quiet ambient life: different amplitudes,
  delays and rhythms, never the same sine on everything.
- **Motivated motion only.** Light comes from the cover's lights, beams from above a stage, dust where there is
  light, the camera moves around the subject. If you cannot say why something moves, remove it.
- **Layered depth.** Foreground, subject and background move differently (parallax); effects sit at a depth
  (rays behind near things, bokeh in front or behind the card).
- **Calm, premium pacing.** Small amplitudes (the subtle presets), slow ramps, two beats at most, a hold.
  A preview loops for minutes on the site: nothing may nag.
- **Brand: pencil and graphite on warm paper.** The `pencil` block is the signature; use it on light, pale or
  graphic covers, or as the one moment of a scene; keep its lines and hatching anchored to the picture.
- **Never**: Ken Burns zoom of the whole frame, screen-space noise or grain that does not move with the
  picture, text, flashes or strobes, colour shifts that change the cover's identity, effects on faces, more
  than one strong light event at the same moment, everything at `medium`.

## Custom blocks (only when justified)

Write one only if no combination of kit blocks expresses the focal action (for example, a candle flame
flicker anchored to the candle in the cover). Follow the block API in `API.md` exactly: a `pixel` or
`overlay` block, `$`-prefixed GLSL, `uniforms(t, env)` pure in t, every effect multiplied by `env`,
whole cycles only, seeded randomness at setup, anchored to `p.src`. Name it in the spec as
`custom/<name>`. Explain in REVIEW.md why a kit block could not do it.

## REVIEW.md (required)

```
# Review: <scene name>
Focal action: <one sentence>
Blocks: <base + blocks, with the reason for each>
Iterations: <n>; measured motion <score>; frame 0 = cover: <yes/no>; 8 s = 0 s: <yes/no>
## P0
- <time · object · observation -> change made / or "none">
## P1
- ...
## Weakest moment and the next improvement
```

Write "motion not reviewed" if you could not look at the snapshots; never claim what you did not see.

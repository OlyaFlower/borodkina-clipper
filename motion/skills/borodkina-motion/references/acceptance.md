# Acceptance list for a cover loop

Check each item on the five snapshots (0, 2, 4, 6, 8 s), at full size and imagined at 640x360 (the card
size on the site). Record defects as `time · object · observation -> exact change`.

## P0: breaks the loop or the cover (must fix)

- Frame 0 differs from the cover, or 8 s differs from 0 s (`motion-measure.py`: the 8 s score is not ~0).
- A face warped, stretched, smeared, relit strongly, or covered by particles or beams.
- The poster card (extend mode) soft, bent, cut or covered; its lettering changed.
- Text, logos or shapes added that are not in the cover.
- A visible tear, smear or "rubber" stretch at depth edges, a hole, a black or white border at the frame edge.
- A strobe, a flash or a jump between snapshots that a viewer would read as a glitch.
- Runtime errors in `hyperframes check`, or the render is not deterministic.
- It does not move (motion < 0.25), or it moves so much that the cover is no longer recognisable at 4 s.

## P1: weak or cheap (fix within the iteration budget)

- No clear focal action, or two strong events at the same time.
- Motion that has no cause in the picture (rays from nowhere, beams on a landscape, snow in a club).
- Everything moves the same way at the same rate (one sine for all), or everything is `medium`.
- Grey or muddy light: beams, bokeh or glow that read as fog instead of light (use `kit.light` hues).
- Screen-space texture: grain, hatching or haze that slides over the picture instead of moving with it.
- Colour identity lost: the palette shifted so the cover looks like a different poster.
- Particles cluttering the subject, uniform confetti, bokeh larger than the subject's head.
- Pencil lines that do not follow real edges, hatching on faces, a wash so strong the photo is lost for long.
- A beat that lands at the very start or end (it makes the loop seam noticeable).

## P2: polish (only after the above)

Amplitudes a little high or low, the order of reveal, a slightly better beat time, the vignette centre.

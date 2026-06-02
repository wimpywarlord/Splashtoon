# Splashtoon Agent Instructions

These instructions apply to the whole repository.

## Engineering Rules

- Keep gameplay authority on the server. Clients send input and render; `server.js` owns positions, power-up timing, scoring, round state, and effects that change game state.
- Keep renderer behavior deterministic and small. Sprite sheets should encode poses; canvas code may choose a row or mirror a sprite, but must not rotate brush sprites to fake direction.
- Keep authoritative score-grid data separate from visual paint history. Refresh/spectator views should replay server-recorded visual paint events; the coarse score grid is only a fallback and should never be the normal source for smooth trails.
- Prefer named constants for balance and timing. Do not bury durations, radii, speeds, or animation timings inside loops or render code.
- Keep unrelated refactors out of gameplay changes. If a request touches sprites, power-ups, or timing, scope the edit to that surface unless a small cleanup directly reduces risk.
- Do not add fallback placeholder art that differs from final art. If an asset has not loaded, skip drawing it instead of drawing temporary circles, boxes, or vector substitutes.

## Asset Rules

- Runtime art lives in `public/assets/`.
- Brush sprite atlas geometry is `8 x 9` cells, `192 x 208` each. Keep the final atlas `1536 x 1872`.
- Power-up sheet geometry is `4 x 3` cells, `362 x 362` each. Runtime currently uses the active row only.
- For generated brush sprites, use the same hatch-pet/imagegen workflow that produced the accepted old atlas. Do not replace expressive generated rows with deterministic transforms unless explicitly requested.
- Before committing/reusing raster assets, validate dimensions and alpha. Transparent pixels should not contain visible RGB residue.
- Preserve accepted assets while iterating. Write candidates to temp or a new file first; replace runtime assets only after visual comparison.

## Verification

Run these after relevant changes:

```bash
node --check public/client.js
node --check server.js
sips -g pixelWidth -g pixelHeight public/assets/brush-spirit.png public/assets/powerups.png
```

If server behavior changes, restart the dev server and smoke test `http://localhost:3015`.

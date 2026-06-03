# Battle Painter Claude Instructions

Follow the repository rules in `AGENTS.md`. The same constraints apply when working through Claude.

## Project Priorities

- Preserve the Battle Painter inspired feel: bold paint ribbons, expressive generated brush sprites, and clean readable power-up icons.
- Keep the code maintainable by separating server authority from client rendering.
- Treat sprite pose and animation as asset responsibilities. Runtime canvas code should select states and mirror when needed, not rotate brush sprites for movement.
- Keep spectator/join-in-progress paint visually identical to live play by replaying server-recorded visual paint events. Do not reconstruct normal refreshed views from the coarse score grid.
- Avoid temporary placeholder visuals on refresh. Missing assets should be invisible until loaded.
- Keep pickup feedback restrained: collected power-up icons fade out in place; no expanding splash or secondary burst sprite.

## Before Finishing

- Check syntax for changed JavaScript files.
- Verify raster dimensions when assets change.
- Restart the local server when `server.js` changes.
- Report any generated candidate assets that were not adopted so they are not mistaken for runtime art.

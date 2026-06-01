# Splashtoon

A browser multiplayer paint **.io** game. Brushes roam a shared canvas; whoever
has painted the most area when the **90-second** timer runs out wins. No signup,
no names — just open the page and play.

## Mechanics (v1)

- **Movement:** WASD (or arrow keys), 8-directional (**diagonals supported**). Brushes
  have **momentum** — they accelerate, coast when you release, and arc when you turn.
- **Painting:** every brush can paint over *anyone's* territory ("steal freely"),
  so the lead swings until the buzzer.
- **Joining:** new players **spectate the live board** and auto-spawn into a color
  slot at the start of the next round. Up to **8** players per round.
- **Server is authoritative:** it owns the grid, positions, and scores. Clients only
  send input and render; your own brush is client-side predicted for responsiveness.

## Run

```bash
npm install      # installs the one dependency: ws
npm start        # or: node server.js
```

Then open **http://localhost:3015** in one or more browser windows/tabs.
Open a second window to play multiplayer against yourself.

Change the port with `PORT=4000 npm start`.

## Tuning

All balance knobs live at the top of `server.js`: grid size, tick rate, speed,
acceleration, damping (drift), brush radius, round/intermission length, and the
color palette. Client physics constants in `public/client.js` must mirror the
server's movement constants for clean prediction.

## Files

- `server.js` — static file server + WebSocket + 30Hz authoritative game loop.
- `public/index.html` / `style.css` / `client.js` — canvas renderer, HUD, input.

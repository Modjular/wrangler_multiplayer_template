# Multiplayer Game — MVP

Browser multiplayer for friends: host starts a session, shares a link, everyone
picks a username and drops into a shared three.js room.

## Requirements
- Node (via `nvm`) — this project was set up against Node 25, but anything
  reasonably recent should work
- That's it. `wrangler` is a devDependency in `package.json`, not a global
  install — `npm install` pulls it in, and `npm run dev` runs the local copy
  (`npx wrangler dev` under the hood). No Cloudflare account needed for local
  dev (only for deploying).

## Setup

```bash
npm install
```

## Run locally

```bash
npm run dev
```

This starts `wrangler dev`, which runs the Worker + Durable Object + static
assets locally (via Miniflare) at **http://localhost:8787**.

## Try it out

1. Open http://localhost:8787 in a browser tab → click **Start New Session**
2. Copy the generated link (or just note the session code in the URL)
3. Open that link in one or more *other* tabs (or another browser/incognito
   window, to simulate different friends)
4. Pick a username in each tab and click **Join**
5. In the tab that joined first (the host), click **Start Game**
6. All tabs should drop into the three.js scene — move with WASD / arrow keys
   (or touch-drag on mobile emulation)

Two tabs on the same session share a single Durable Object instance, so the
player list and positions sync between them in real time.

## Notes for local testing
- Sessions auto-close after 5 minutes of no messages (join/input/ping all
  reset the timer) — you'll see a `session_closed` alert and get redirected
  back to the homepage.
- State is in-memory only — restarting `wrangler dev` wipes all sessions.
- No auth/anti-cheat: positions are trusted as sent by each client (fine for
  friends, see spec's "Known MVP Tradeoffs").

## Deploying (when ready)

```bash
npx wrangler login   # one-time Cloudflare auth
npm run deploy
```

**Use `npm run deploy`, not `npx wrangler deploy` directly** — the former
auto-bumps the patch version (`scripts/bump-version.mjs`, wired via a
`predeploy` hook) and writes it to `public/version.json`, which shows up as a
small `vX.Y.Z` badge in the bottom-right corner of every page
(`public/js/version-badge.js`). It's a quick sanity check that a deploy
actually landed. Running `wrangler deploy` on its own skips the bump, so the
badge will look stale even though the deploy succeeded.

## Project layout

```
src/worker.js       Worker entry: routes + WS upgrade forwarding to the DO
src/GameRoom.js      Durable Object: session state, lobby/game logic, idle alarm
public/index.html    Landing page — create a session
public/join.html     Lobby + game canvas host page
public/js/lobby.js   WebSocket join flow, player list UI
public/js/game.js    three.js scene, input, render loop
public/css/style.css Shared styling
```

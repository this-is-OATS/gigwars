# GIG WARS

TI-85 REIMAGINED — DrugWars x rave/touring world.

**Live:** https://gigwars.vercel.app

Self-contained offline-bundler app. The deployable artifact is `index.html` (everything inlined). Static assets: icons, manifest, service worker, `og.png`.

Part of the OATS Apps Series · Fook'n Oats Enterprises.


## Deploys

This repo is connected to the Vercel project `gigwars` (production: https://gigwars.vercel.app).
Every push to `main` deploys. Before 2026-09-17 the project was CLI-only and unlinked, so `main`
ran ahead of production for months. Bump `CACHE` in `sw.js` on any push that changes the shell,
or returning visitors keep the cached old build.

## DISPATCH — the shared community feed

`api/dispatch.js` (a Vercel function) makes DISPATCH shared: players submit cursed road
moments, everyone votes, and at 5 votes a submission goes LIVE as a random event on every
player's tour (its cash effect is rolled once, server-side). It stores to the shared Firebase
project (`gigwarsDispatch`, `gigwarsLimits`) through the Admin SDK, so the browser never talks to
Firebase and the project's rules (MGMT, CrewFam) are untouched.

- Needs `FIREBASE_SERVICE_ACCOUNT` (the service-account JSON) on the Vercel project. Without
  it, GET answers `enabled:false` and the game runs DISPATCH in its old local mode.
- `lib/filter.js`: slurs rejected, strong profanity masked (f***), mild crew language kept.
  Links and phone numbers rejected. Tune the word lists there.
- Rate limit: 3 submissions / 10 min and 12 / day per connection. One vote per device and
  per connection. Stored identities are salted hashes (`DISPATCH_SALT` optional), never raw IPs.
- The game source lives inside `index.html`'s bundler manifest (gzip + base64 per file):
  `gw-store.jsx` (the store) and `gw-ios-dispatch.jsx` (the screen). Decode, edit, re-encode.
- `sw.js` never caches `/api/` — the feed is live data.

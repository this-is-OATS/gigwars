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

## Story mode (forks)

Some road stops are forks: WHAT DO YOU DO? with two choices. Each choice has endings — the
starter forks (`FORKS` in gw-data.jsx, mirrored as `STARTER_FORKS` in api/dispatch.js; keep the
two in step) ship with one each, and players write more. A written ending ("beat") goes to the
VOTE queue and becomes canon at 3 votes; a player who takes that road gets one of its endings
at random, so every road's story grows as people play. If nobody has written an ending for a
road yet, the player is told they're first and can write it.

A dispatch can also be a fork (FEED → + MAKE IT A FORK): once voted live it fires with its two
choices, and all of its endings are player-written.

Pack space grows with the tour: 40 slots at the first stop, +10 per city (`packFor`).

## Tour names (sign-in without Google)

TOUR → SIGN IN · CLAIM YOUR TOUR NAME. `action:"claim"` reserves the name (3–16 of a-z 0-9 _,
filtered, a few reserved) in `gigwarsNames` and returns a token (kept in the browser as
`gigwars.id`) and a one-time recovery code. Posts and story endings carry the name only when the
token checks out; otherwise they post as @roadie. `action:"restore"` (name + code) issues a new
token and signs the old browser out — one name, one browser. Only SHA-256 hashes of the token
and code are stored. Claims and restores have their own rate limit (8 / 10 min, 30 / day).

Recovery QR: claim (and `action:"recode"`, signed in) also return a QR drawn server-side from
the fresh code. It encodes `https://<game host>/#restore=<name>.<CODE>`; the game reads that on
open, wipes it from the address bar and history, and offers the restore. The code sits after
the `#`, so it never reaches a server or a log. The link host is pinned to the game's own
domains. "new recovery QR" on TOUR issues a new code and kills the old one.

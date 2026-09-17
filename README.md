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

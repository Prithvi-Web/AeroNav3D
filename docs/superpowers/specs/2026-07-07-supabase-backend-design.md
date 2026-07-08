# AeroNav3D — Supabase Backend + Vercel Hosting Design

**Date:** 2026-07-07
**Status:** Approved by user (chat, 2026-07-07)

## Goal

Turn the existing single-page AeroNav3D globe (index.html, unchanged in look and
feel) into a fully deployed website: Supabase provides the backend (flight
feed, trails, favorites), Vercel hosts the static site on a free
`*.vercel.app` domain. Bar is "flawless": every feature verified by running
the real site.

## What exists today

- `index.html` — complete Cesium 3D globe UI. Polls `/flights?circle=lat,lon,250`
  every 6 s, dead-reckons positions between polls, click a plane → detail panel.
  Falls back to a Cloudflare Worker (`aeronav3d.blazedude12.workers.dev`) when
  no local proxy answers.
- `server.py` — local dev proxy (kept for local development).
- `worker.js` — Cloudflare Worker proxying 3 public ADS-B aggregators with an
  8 s cache. Its logic is the blueprint for the new Supabase Edge Function.

## Architecture

```
Browser (index.html on Vercel)
   │  GET /functions/v1/flights?circle=lat,lon,250   (every 6 s)
   ▼
Supabase Edge Function "flights"  (Deno)
   │  1. in-memory cache (~8 s TTL, keyed on rounded lat/lon)
   │  2. upstream failover: api.adsb.lol → opendata.adsb.fi → api.airplanes.live
   │  3. fire-and-forget: sampled position snapshot → Postgres (max 1/30 s per area)
   ▼
Supabase Postgres
   ├─ flight_positions (hex, ts, lat, lon, alt_ft, callsign) — 60 min retention via pg_cron
   └─ favorites (user_id, hex, callsign, label, created_at) — RLS: owner-only
```

### Part 1 — Flight feed (Edge Function `flights`)

- Port of worker.js: same `?circle=lat,lon,radius` API, same 3 upstreams with
  failover, CORS `*`, radius clamped to 250 nm, coords rounded to ¼° so nearby
  viewers share a cache entry.
- Cache: module-scope Map (persists while the isolate is warm). Serve cached
  body if < 8 s old; on total upstream failure serve stale cache if present,
  else JSON error (the frontend already shows a retry notice).
- Deployed with `verify_jwt=false`: it serves public data, does its own
  caching/rate limiting, and the page fetches it with plain `fetch()`.
- Frontend change: `FLIGHT_DATA_URL` points at the Supabase function URL when
  not on localhost; localhost keeps using `server.py`'s `/flights`.

### Part 2 — Flight trails (Postgres + globe polyline)

- Collection: inside the `flights` function, after a successful upstream fetch,
  batch-insert `(hex, ts, lat, lon, alt_ft, callsign)` for all aircraft in the
  response — but at most once per 30 s per cache key (module-scope timestamp),
  using the service-role key. Insert failures are logged, never break the feed.
- Retention: pg_cron job deletes rows older than 60 minutes (runs every 10 min).
  Keeps the free tier's 500 MB comfortably safe.
- Display: clicking a plane fetches its last hour of positions via supabase-js
  (anon key, read-only RLS policy on flight_positions), draws a glowing
  accent-blue polyline (Cesium polyline, sorted by ts, gaps > 5 min break the
  line). While selected, new poll positions extend the trail live. Deselect
  removes it.

### Part 3 — Favorites (Supabase Auth + RLS)

- Sign-in: email + password (email confirmation OFF — Supabase free tier only
  sends ~2 emails/hour, magic links would break for a public site).
- UI, styled to match existing dark-glass panels:
  - ★ button in the flight detail panel header. Signed out → sign-in card
    (email, password, one Create-account/Sign-in toggle). Signed in → toggles
    the favorite (saves hex + callsign).
  - "My Flights" panel (toggle button near the brand badge): lists starred
    flights; ones currently in the live data show a LIVE dot and clicking
    flies the camera to the plane. Signed-out state shows a sign-in prompt.
- Data: `favorites` table, RLS owner-only for select/insert/delete.
- supabase-js v2 loaded from CDN (single script tag; the page already uses CDN
  for Cesium).

### Part 4 — Hosting (Vercel)

- Static deploy of the repo (index.html + assets) via Vercel CLI; target name
  `aeronav3d` → free domain `aeronav3d.vercel.app` (or nearest available).
- `.vercelignore` excludes server.py, worker.js, docs, test.
- One-time interactive `vercel login` by the user (guided).
- server.py stays for local dev; Cloudflare Worker fallback constant is
  replaced by the Supabase function URL (single code path + localhost dev path).

### Part 5 — Google Maps key lockdown (user instructions)

The Map Tiles API key in index.html is public in the GitHub repo. Deliver
click-by-click instructions to restrict it (HTTP referrer restriction to the
Vercel domain + localhost) in the final handoff. No code change.

## Error handling

- Feed: upstream failover → stale cache → JSON error → existing frontend
  notice ("Live flights unavailable… retrying"). Transient failures after
  first success are silent (existing behavior, kept).
- Trails: DB write/read failures never affect the feed or the map; trail
  simply doesn't render and a console warning is logged.
- Favorites: auth errors surface as inline messages in the sign-in card;
  RLS guarantees users only ever see their own rows.

## Testing / verification

- Edge Function: curl the deployed URL with a real `?circle=` query → valid
  aircraft JSON; kill-switch test by requesting with a bogus circle → 400.
- Trails: after ~2 min of collection, click a plane → polyline renders;
  verify rows in flight_positions and that pg_cron job exists.
- Favorites: create account, star a flight, reload → still starred; second
  browser/incognito sees nothing (RLS check).
- Site: preview locally, then verify the live Vercel URL end-to-end
  (globe loads, planes move, trail draws, favorites work) before handoff.

## Out of scope

- Custom domain names (user said free Vercel domain).
- Flight search, filters, historical playback beyond the 60-min trail.
- Mobile app. (The page is already responsive; that stays.)

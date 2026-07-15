# AeroNav3D

**Live site:(https://aeronav3d.blazedude12.workers.dev/)**

An interactive 3D globe showing live air traffic worldwide. Click any plane to
see its altitude, speed, and a glowing trail of where it's been. Sign in to
save flights to your **My Flights** panel and spot them live on the globe.

## How it works

- **The page** (`index.html`) — a single self-contained page: CesiumJS globe,
  Google satellite imagery, NASA night-lights on the dark side of the Earth,
  and all the flight/trail/favorites logic. Hosted on Vercel.
- **The backend** (Supabase project `aeronav3d`, region us-west-1):
  - `flights` Edge Function (`supabase/functions/flights/index.ts`) — serves
    live aircraft for the area you're looking at. It queries three public
    ADS-B networks with automatic failover (airplanes.live → adsb.fi →
    adsb.lol), caches responses for 8 s in the `feed_cache` table, and
    records position snapshots every 30 s for trails.
  - Global feed (`?global=1` on the same function) — every aircraft on earth
    (~13k) from OpenSky, for when you zoom out past the aggregators' 250 nm
    circle limit. The page switches to it above ~1,200 km of camera height
    and back below ~900 km. OpenSky carries no aircraft type or
    registration, so those planes use the generic jet icon — which is why
    the switch only happens when you're too far out to tell models apart.
    Cached 90 s in `feed_cache` and shared by every viewer, because OpenSky
    bills 4 credits per call against a 4000/day budget.
  - `flight_positions` table — the last hour of recorded plane positions
    (older rows auto-deleted every 10 minutes by pg_cron). Read-only to
    browsers.
  - `favorites` table — starred flights per account, protected by row-level
    security so each user only ever sees their own.
  - Auth — email + password ("confirm email" should be OFF in the dashboard;
    the free tier can't send enough confirmation emails for a public site).
  - OpenSky credentials — set `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`
    as Edge Function secrets (create an API client under Account on
    opensky-network.org). Without them the global feed still works, but
    anonymously: 400 credits/day instead of 4000, so roughly 2.5 h of
    refreshes before it falls back to serving stale positions.
- **Fallbacks** — if the Supabase function is ever unreachable, the page
  automatically switches to the original Cloudflare Worker proxy
  (`worker.js`); if Google imagery ever stops working, it automatically
  switches to keyless Esri World Imagery. Visitors never see an outage.

## Working on the site

- Run locally: `python3 server.py`, then open http://localhost:8321
  (the circle feed still comes from the real Supabase backend; the global
  feed is served by `server.py` so you can zoom out without deploying).
- Deploy: `npx vercel deploy --prod --yes` from this folder
  (or push to GitHub and use Vercel's Git integration).
- Design/plan documents live in `docs/superpowers/`.

## Data credits

Flight data: [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi),
[airplanes.live](https://airplanes.live),
[OpenSky Network](https://opensky-network.org) (global feed).
Imagery: Google Maps Platform, Cesium, NASA GIBS (VIIRS Black Marble).

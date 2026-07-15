// AeroNav3D flight feed.
//
// GET /flights?circle=lat,lon,radiusNm
// Proxies public ADS-B aggregators with failover, and snapshots aircraft
// positions to Postgres so the frontend can draw flight trails.
//
// GET /flights?global=1
// Every aircraft on earth (~13k), from OpenSky, normalised to the same
// shape the aggregators return. The aggregators cap their circle query at
// 250 nm, so they can't answer "what's flying right now" at world zoom;
// OpenSky can, but carries no aircraft type or registration, which is why
// this is only used when zoomed too far out to tell the models apart.
//
// Caching and snapshot throttling live in the feed_cache table, not in
// memory: Supabase may run every request on a fresh isolate, so module
// state cannot be trusted to persist (verified empirically — 12 sequential
// requests never reused the in-memory cache).

import { createClient } from "npm:@supabase/supabase-js@2";

// Ordered fastest-first (measured 2026-07-07: airplanes.live 0.9 s,
// adsb.fi 1.0 s, adsb.lol 15 s).
const UPSTREAMS = [
  (lat: number, lon: number, rad: number) =>
    `https://api.airplanes.live/v2/point/${lat}/${lon}/${rad}`,
  (lat: number, lon: number, rad: number) =>
    `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${rad}`,
  (lat: number, lon: number, rad: number) =>
    `https://api.adsb.lol/v2/point/${lat}/${lon}/${rad}`,
];

const FRESH_MS = 8_000; // serve cached responses this fresh without refetching
const SNAPSHOT_MS = 30_000; // min gap between trail snapshots per area
const UPSTREAM_TIMEOUT_MS = 5_000;

const OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all";
const OPENSKY_TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const GLOBAL_KEY = "global";
const GLOBAL_TIMEOUT_MS = 20_000; // ~1.7 MB upstream response
// OpenSky bills /states/all at 4 credits against a daily budget: 4000 with
// an account, 400 anonymous. One cached fetch serves every viewer, so this
// gap alone decides the spend — 90 s is ~3840 credits/day, just inside the
// account budget. Lower it only if the budget grows.
const GLOBAL_FRESH_MS = 90_000;

// OpenSky returns each aircraft as a positional array, not an object.
// https://openskynetwork.github.io/opensky-api/rest.html#response
const OS_ICAO = 0, OS_CALLSIGN = 1, OS_LON = 5, OS_LAT = 6, OS_BARO_ALT = 7,
  OS_ON_GROUND = 8, OS_VELOCITY = 9, OS_TRACK = 10, OS_VERT_RATE = 11,
  OS_SQUAWK = 14;
const M_TO_FT = 3.28084;
const MS_TO_KNOTS = 1.94384;
const MS_TO_FT_MIN = 196.85;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...extra },
  });
}

function waitUntil(p: Promise<unknown>) {
  try {
    // Supabase edge runtime: lets async work finish after the response.
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime.waitUntil(p);
  } catch {
    /* runtime without waitUntil: work continues best-effort */
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const params = new URL(req.url).searchParams;
  if (params.get("global")) return globalHandler();

  const circle = params.get("circle");
  if (!circle) return json(JSON.stringify({ error: "missing circle" }), 400);
  let [lat, lon, rad] = circle.split(",").map(Number);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json(JSON.stringify({ error: "bad circle" }), 400);
  }
  // Round the query so nearby viewers share one cache entry
  lat = Math.round(lat * 4) / 4;
  lon = Math.round(lon * 4) / 4;
  rad = Math.min(Math.round(rad) || 250, 250);
  const key = `${lat},${lon},${rad}`;

  // Shared cache lookup — best-effort, never blocks the feed on failure.
  let row: { body: string; fetched_at: string; snapshot_at: string | null } | null = null;
  try {
    const { data } = await supabase
      .from("feed_cache")
      .select("body,fetched_at,snapshot_at")
      .eq("key", key)
      .maybeSingle();
    row = data;
  } catch (err) {
    console.error("cache read failed:", err?.message ?? err);
  }
  if (row && Date.now() - Date.parse(row.fetched_at) < FRESH_MS) {
    return json(row.body, 200, { "X-Cache": "hit" });
  }

  for (const buildUrl of UPSTREAMS) {
    try {
      const r = await fetch(buildUrl(lat, lon, rad), {
        headers: { "User-Agent": "AeroNav3D (github.com/Prithvi-Web/AeroNav3D)" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!r.ok) continue; // rate-limited or down — try the next aggregator
      const body = await r.text();
      let parsed: { aircraft?: unknown[]; ac?: unknown[] };
      try {
        parsed = JSON.parse(body);
      } catch {
        continue; // garbage response — try the next aggregator
      }

      const snapAge = row?.snapshot_at ? Date.now() - Date.parse(row.snapshot_at) : Infinity;
      const takeSnapshot = snapAge >= SNAPSHOT_MS;
      const snapshotAt = takeSnapshot ? new Date().toISOString() : row?.snapshot_at ?? null;

      waitUntil((async () => {
        if (takeSnapshot) await insertPositions(parsed);
        const { error } = await supabase.from("feed_cache").upsert({
          key,
          body,
          fetched_at: new Date().toISOString(),
          snapshot_at: snapshotAt,
        });
        if (error) console.error("cache write failed:", error.message);
      })().catch((err) => console.error("persist failed:", err?.message ?? err)));

      return json(body, 200, { "X-Cache": "miss" });
    } catch {
      // network error / timeout — try the next aggregator
    }
  }

  if (row) return json(row.body, 200, { "X-Cache": "stale" }); // stale beats nothing
  return json(JSON.stringify({ error: "flight data upstreams unavailable" }), 502);
});

/* ----- Global feed (OpenSky) -----------------------------------------
 * Deliberately does NOT snapshot to flight_positions: trails are drawn for
 * one selected aircraft at a time, and 13k rows every refresh would swamp
 * the table for data nobody reads.
 */
async function globalHandler() {
  let row: { body: string; fetched_at: string } | null = null;
  try {
    const { data } = await supabase
      .from("feed_cache")
      .select("body,fetched_at")
      .eq("key", GLOBAL_KEY)
      .maybeSingle();
    row = data;
  } catch (err) {
    console.error("global cache read failed:", err?.message ?? err);
  }
  if (row && Date.now() - Date.parse(row.fetched_at) < GLOBAL_FRESH_MS) {
    return json(row.body, 200, { "X-Cache": "hit" });
  }

  try {
    const token = await openSkyToken();
    const r = await fetch(OPENSKY_STATES_URL, {
      headers: {
        "User-Agent": "AeroNav3D (github.com/BlazEDude12/AeroNav3D)",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(GLOBAL_TIMEOUT_MS),
    });
    // 429 = daily credit budget spent. Stale positions still beat an empty
    // globe, and the frontend dead-reckons between refreshes anyway.
    if (!r.ok) throw new Error("HTTP " + r.status);
    const parsed = JSON.parse(await r.text());
    if (!Array.isArray(parsed?.states)) throw new Error("no states array");
    const body = JSON.stringify({ ac: normalizeOpenSky(parsed.states), global: true });

    waitUntil((async () => {
      const { error } = await supabase.from("feed_cache").upsert({
        key: GLOBAL_KEY,
        body,
        fetched_at: new Date().toISOString(),
      });
      if (error) console.error("global cache write failed:", error.message);
    })().catch((err) => console.error("global persist failed:", err?.message ?? err)));

    return json(body, 200, { "X-Cache": "miss" });
  } catch (err) {
    console.error("global feed failed:", err?.message ?? err);
    if (row) return json(row.body, 200, { "X-Cache": "stale" });
    return json(JSON.stringify({ error: "global feed unavailable" }), 502);
  }
}

// Client-credentials token, or null to fall back to anonymous access (which
// works, but on a 400/day budget — roughly 2.5 h of refreshes).
async function openSkyToken(): Promise<string | null> {
  const id = Deno.env.get("OPENSKY_CLIENT_ID");
  const secret = Deno.env.get("OPENSKY_CLIENT_SECRET");
  if (!id || !secret) return null;
  try {
    const r = await fetch(OPENSKY_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: id,
        client_secret: secret,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return (await r.json()).access_token ?? null;
  } catch (err) {
    console.error("opensky auth failed:", err?.message ?? err);
    return null; // expired or misconfigured creds — anonymous still works
  }
}

// OpenSky state vectors → the aggregators' field names and units, so the
// frontend renders both feeds through one code path. Type, registration and
// emitter category have no OpenSky equivalent, so aircraft fall back to the
// generic jet icon.
function normalizeOpenSky(states: unknown[][]) {
  const out = [];
  for (const s of states) {
    const lat = s[OS_LAT], lon = s[OS_LON];
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const alt = s[OS_BARO_ALT];
    const vel = s[OS_VELOCITY];
    const vr = s[OS_VERT_RATE];
    out.push({
      hex: s[OS_ICAO],
      flight: typeof s[OS_CALLSIGN] === "string" ? s[OS_CALLSIGN].trim() : "",
      // 4 dp ≈ 11 m: finer than a pixel at world zoom, and trims the payload
      lat: Math.round(lat * 1e4) / 1e4,
      lon: Math.round(lon * 1e4) / 1e4,
      alt_baro: s[OS_ON_GROUND] ? "ground"
        : typeof alt === "number" ? Math.round(alt * M_TO_FT) : null,
      gs: typeof vel === "number" ? Math.round(vel * MS_TO_KNOTS) : null,
      track: typeof s[OS_TRACK] === "number" ? Math.round(s[OS_TRACK]) : null,
      baro_rate: typeof vr === "number" ? Math.round(vr * MS_TO_FT_MIN) : null,
      squawk: typeof s[OS_SQUAWK] === "string" ? s[OS_SQUAWK] : null,
    });
  }
  return out;
}

// Store one position per aircraft for the trails feature.
async function insertPositions(parsed: { aircraft?: unknown[]; ac?: unknown[] }) {
  const list = (parsed.aircraft ?? parsed.ac ?? []) as Record<string, unknown>[];
  const rows = list
    .filter((a) =>
      typeof a.lat === "number" && typeof a.lon === "number" &&
      typeof a.hex === "string"
    )
    .map((a) => ({
      hex: a.hex as string,
      lat: a.lat as number,
      lon: a.lon as number,
      alt_ft: typeof a.alt_baro === "number" ? Math.round(a.alt_baro) : null,
      callsign: typeof a.flight === "string" ? (a.flight as string).trim() || null : null,
    }));
  if (!rows.length) return;
  const { error } = await supabase.from("flight_positions").insert(rows);
  if (error) console.error("snapshot insert failed:", error.message);
}

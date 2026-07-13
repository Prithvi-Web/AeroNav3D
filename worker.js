// Cloudflare Worker for AeroNav3D.
//
// The static site is served from this repo via Workers assets (see
// wrangler.jsonc); this script handles /flights and /routes, proxying
// public ADS-B aggregators with a short-lived cache. The cache plus the
// extra upstreams work around aggressive rate limiting of Cloudflare's
// shared egress IPs by the aggregators.

const UPSTREAMS = [
  (lat, lon, rad) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${rad}`,
  (lat, lon, rad) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${rad}`,
  (lat, lon, rad) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${rad}`
];
// Callsign → departure/arrival airport lookup (community-maintained
// standing data, so entries change rarely — cache for a long time).
// adsb.im first: api.adsb.lol currently answers 201 with an empty body.
const ROUTE_UPSTREAMS = [
  "https://adsb.im/api/0/routeset",
  "https://api.adsb.lol/api/0/routeset"
];
const FRESH_MS = 8000; // serve cached data this fresh without hitting upstreams
const ROUTE_FRESH_MS = 30 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/routes") {
      if (request.method === "OPTIONS") {
        // CORS preflight for the cross-origin JSON POST
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400"
          }
        });
      }
      if (request.method !== "POST") return json({ error: "POST required" }, 405);
      return routesHandler(request, ctx);
    }
    if (url.pathname !== "/flights") {
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "not found" }, 404);
    }

    const circle = url.searchParams.get("circle");
    if (!circle) return json({ error: "missing circle" }, 400);
    let [lat, lon, rad] = circle.split(",").map(Number);
    if (!isFinite(lat) || !isFinite(lon)) return json({ error: "bad circle" }, 400);
    // Round the query so nearby viewers share one cache entry
    lat = Math.round(lat * 4) / 4;
    lon = Math.round(lon * 4) / 4;
    rad = Math.min(Math.round(rad) || 250, 250);

    const cache = caches.default;
    const cacheKey = new Request(`https://flights.cache/${lat},${lon},${rad}`);
    const cached = await cache.match(cacheKey);
    if (cached && Date.now() - Number(cached.headers.get("X-Fetched-At")) < FRESH_MS) {
      return cors(cached);
    }

    for (const buildUrl of UPSTREAMS) {
      try {
        const r = await fetch(buildUrl(lat, lon, rad), {
          headers: { "User-Agent": "AeroNav3D (github.com/BlazEDude12/AeroNav3D)" }
        });
        if (!r.ok) continue; // rate-limited or down — try the next aggregator
        const body = await r.text();
        const resp = new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=30",
            "X-Fetched-At": String(Date.now())
          }
        });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return cors(resp);
      } catch (e) {
        // network error — try the next aggregator
      }
    }

    if (cached) return cors(cached); // stale data beats no data while throttled
    return json({ error: "flight data upstreams unavailable" }, 502);
  }
};

// POST {planes:[{callsign, lat, lng}]} → same body as the routeset APIs.
// The lat/lng let the upstream sanity-check that the aircraft is plausibly
// flying the route on file for that callsign.
async function routesHandler(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad json" }, 400);
  }
  const planes = Array.isArray(body && body.planes) ? body.planes.slice(0, 100) : [];
  const clean = planes
    .map((p) => ({
      callsign: String((p && p.callsign) || "").trim().toUpperCase(),
      lat: Number(p && p.lat) || 0,
      lng: Number(p && p.lng) || 0
    }))
    .filter((p) => /^[A-Z0-9]{2,8}$/.test(p.callsign));
  if (!clean.length) return json({ error: "missing planes" }, 400);

  // Cache API keys must be GET requests — synthesize one from the callsigns
  const cache = caches.default;
  const cacheKey = new Request(
    "https://routes.cache/" + clean.map((p) => p.callsign).sort().join(",")
  );
  const cached = await cache.match(cacheKey);
  if (cached && Date.now() - Number(cached.headers.get("X-Fetched-At")) < ROUTE_FRESH_MS) {
    return cors(cached);
  }

  for (const upstream of ROUTE_UPSTREAMS) {
    try {
      const r = await fetch(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "AeroNav3D (github.com/BlazEDude12/AeroNav3D)"
        },
        body: JSON.stringify({ planes: clean })
      });
      if (!r.ok) continue; // rate-limited or down — try the next route DB
      const bodyText = await r.text();
      // An empty [] is a valid "callsign unknown" answer worth caching;
      // anything that isn't a JSON array is a broken upstream — move on.
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch (e) { continue; }
      if (!Array.isArray(parsed)) continue;
      const resp = new Response(bodyText, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=1800",
          "X-Fetched-At": String(Date.now())
        }
      });
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return cors(resp);
    } catch (e) {
      // network error — try the next route DB
    }
  }

  if (cached) return cors(cached);
  return json({ error: "route upstreams unavailable" }, 502);
}

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set("Access-Control-Allow-Origin", "*");
  return new Response(resp.body, { status: resp.status, headers: h });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

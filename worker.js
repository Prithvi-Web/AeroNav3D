// Cloudflare Worker for AeroNav3D.
//
// The static site is served from this repo via Workers assets (see
// wrangler.jsonc); this script only handles /flights, proxying public
// ADS-B aggregators with a short-lived cache. The cache plus the second
// upstream work around aggressive rate limiting of Cloudflare's shared
// egress IPs by the aggregators.

const UPSTREAMS = [
  (lat, lon, rad) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${rad}`,
  (lat, lon, rad) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${rad}`,
  (lat, lon, rad) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${rad}`
];
const FRESH_MS = 8000; // serve cached data this fresh without hitting upstreams

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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

"""AeroNav3D local server.

Serves the static site and proxies /flights to the adsb.lol re-api
(https://www.adsb.lol/docs/feeders-only/re-api/). The proxy is required
because re-api is IP-restricted to ADS-B feeder stations and sends no
CORS headers, so the browser cannot call it directly.

/flights?global=1 mirrors the Supabase function's global feed: every
aircraft on earth from OpenSky, normalised to the aggregators' field names.
Anonymous OpenSky access is enough for local dev (400 credits/day, 4 per
call); production uses an account. Deliberately uncached — local dev makes
far fewer calls than a public site, and staleness here just confuses.

Also proxies POST /routes to the routeset APIs (callsign → departure and
arrival airports), keeping the site same-origin in local dev.

Usage: python server.py  (serves on http://localhost:8321)
"""
import json
import ssl
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 8321
UPSTREAM = "https://re-api.adsb.lol/"
OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all"
# Indices into OpenSky's positional state vector, and the unit conversions
# that bring it in line with the aggregators. Keep in sync with
# normalizeOpenSky() in supabase/functions/flights/index.ts.
OS_ICAO, OS_CALLSIGN, OS_LON, OS_LAT, OS_BARO_ALT = 0, 1, 5, 6, 7
OS_ON_GROUND, OS_VELOCITY, OS_TRACK, OS_VERT_RATE, OS_SQUAWK = 8, 9, 10, 11, 14
M_TO_FT = 3.28084
MS_TO_KNOTS = 1.94384
MS_TO_FT_MIN = 196.85
# Callsign → departure/arrival airports (community route databases).
# adsb.im first: api.adsb.lol currently answers 201 with an empty body.
ROUTE_UPSTREAMS = [
    "https://adsb.im/api/0/routeset",
    "https://api.adsb.lol/api/0/routeset",
]


def _urlopen(req, timeout=10):
    """urlopen that tolerates macOS Pythons missing their CA bundle."""
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as exc:
        if "CERTIFICATE_VERIFY_FAILED" not in str(exc):
            raise
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return urllib.request.urlopen(req, timeout=timeout, context=ctx)


def _normalize_opensky(states):
    """OpenSky state vectors -> the aggregators' field names and units.

    Type, registration and emitter category have no OpenSky equivalent, so
    aircraft fall back to the generic jet icon on the globe.
    """
    out = []
    for s in states:
        lat, lon = s[OS_LAT], s[OS_LON]
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        alt, vel, trk, vr = s[OS_BARO_ALT], s[OS_VELOCITY], s[OS_TRACK], s[OS_VERT_RATE]
        out.append({
            "hex": s[OS_ICAO],
            "flight": (s[OS_CALLSIGN] or "").strip(),
            # 4 dp ~ 11 m: finer than a pixel at world zoom, and trims the payload
            "lat": round(lat, 4),
            "lon": round(lon, 4),
            "alt_baro": "ground" if s[OS_ON_GROUND]
                        else (round(alt * M_TO_FT) if isinstance(alt, (int, float)) else None),
            "gs": round(vel * MS_TO_KNOTS) if isinstance(vel, (int, float)) else None,
            "track": round(trk) if isinstance(trk, (int, float)) else None,
            "baro_rate": round(vr * MS_TO_FT_MIN) if isinstance(vr, (int, float)) else None,
            "squawk": s[OS_SQUAWK] if isinstance(s[OS_SQUAWK], str) else None,
        })
    return out


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/flights":
            return super().do_GET()
        if parse_qs(url.query).get("global"):
            return self._proxy_global()
        try:
            req = urllib.request.Request(
                UPSTREAM + ("?" + url.query if url.query else ""),
                headers={"User-Agent": "AeroNav3D/1.0 (local proxy)"},
            )
            with _urlopen(req) as resp:
                body = resp.read()
            self._send_json(200, body)
        except Exception as exc:  # upstream down, timeout, non-feeder IP, ...
            self._send_json(502, json.dumps({"error": str(exc)}).encode())

    def _proxy_global(self):
        try:
            req = urllib.request.Request(
                OPENSKY_STATES_URL,
                headers={"User-Agent": "AeroNav3D/1.0 (local proxy)"},
            )
            with _urlopen(req, timeout=30) as resp:
                states = json.loads(resp.read()).get("states") or []
            body = json.dumps({"ac": _normalize_opensky(states), "global": True})
            self._send_json(200, body.encode())
        except Exception as exc:  # rate-limited, down, timeout, ...
            self._send_json(502, json.dumps({"error": str(exc)}).encode())

    def do_POST(self):
        if urlparse(self.path).path == "/routes":
            return self._proxy_routes()
        self.send_error(404)

    def _proxy_routes(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if not 0 < length <= 65536:
            return self._send_json(400, b'{"error": "missing body"}')
        body = self.rfile.read(length)
        last_err = "no upstream"
        for upstream in ROUTE_UPSTREAMS:
            try:
                req = urllib.request.Request(
                    upstream,
                    data=body,
                    headers={
                        "User-Agent": "AeroNav3D/1.0 (local proxy)",
                        "Content-Type": "application/json",
                    },
                )
                with _urlopen(req) as resp:
                    rbody = resp.read()
                # e.g. api.adsb.lol answers 201 with an empty body — a
                # response that isn't a JSON array means a broken upstream
                if not isinstance(json.loads(rbody), list):
                    raise ValueError("bad upstream response")
                return self._send_json(200, rbody)
            except Exception as exc:  # throttled, down, broken response, ...
                last_err = str(exc)
        self._send_json(502, json.dumps({"error": last_err}).encode())

    def _send_json(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


if __name__ == "__main__":
    print(f"AeroNav3D serving on http://localhost:{PORT} (flights proxied to re-api.adsb.lol)")
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()

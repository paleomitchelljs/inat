#!/usr/bin/env python3
"""Pull every observation for an iNaturalist user into a compact JSON file
that the static field-guide site consumes.

No third-party dependencies — stdlib urllib only, so the GitHub Action needs
nothing but a Python runtime.

Usage:
    python3 fetch.py [username] [output_path]

Defaults: username=mitchelljs, output=docs/data/observations.json
"""
from __future__ import annotations

import json
import ssl
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.inaturalist.org/v1/observations"
PER_PAGE = 200
USER_AGENT = "inat-field-guide/1.0 (static guide builder; stdlib urllib)"

# Some Python installs (notably python.org builds on macOS) ship without a
# usable CA bundle. Prefer certifi's bundle when present; fall back to system.
try:
    import certifi
    _SSL_CTX: ssl.SSLContext | None = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _SSL_CTX = ssl.create_default_context()


def fetch_page(user: str, id_above: int) -> dict:
    params = {
        "user_login": user,
        "per_page": PER_PAGE,
        "order_by": "id",
        "order": "asc",
        "id_above": id_above,
    }
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60, context=_SSL_CTX) as resp:
                return json.load(resp)
        except Exception as e:  # noqa: BLE001
            wait = 2 ** attempt
            print(f"  ! request failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"Failed to fetch page after retries (id_above={id_above})")


def compact(o: dict) -> dict:
    """Reduce a full API observation to the few fields the site needs."""
    geo = o.get("geojson") or {}
    coords = geo.get("coordinates") or []
    lng, lat = (coords[0], coords[1]) if len(coords) == 2 else (None, None)
    taxon = o.get("taxon") or {}
    photos = o.get("photos") or []
    photo = photos[0].get("url") if photos else None
    return {
        "id": o.get("id"),
        "d": o.get("observed_on"),            # date string YYYY-MM-DD
        "lat": round(lat, 5) if lat is not None else None,
        "lng": round(lng, 5) if lng is not None else None,
        "ic": taxon.get("iconic_taxon_name") or "Unknown",
        "ti": taxon.get("id"),                # taxon id (for gallery grouping + links)
        "n": taxon.get("name"),               # scientific name
        "c": taxon.get("preferred_common_name"),
        "r": taxon.get("rank"),
        "q": o.get("quality_grade"),
        "p": photo,                           # square-size URL; client swaps the size token
        "pl": o.get("place_guess"),
    }


def main() -> None:
    user = sys.argv[1] if len(sys.argv) > 1 else "mitchelljs"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("docs/data/observations.json")

    print(f"Fetching observations for '{user}' ...")
    records: list[dict] = []
    id_above = 0
    page = 0
    while True:
        page += 1
        data = fetch_page(user, id_above)
        results = data.get("results", [])
        if not results:
            break
        records.extend(compact(o) for o in results)
        id_above = results[-1]["id"]
        total = data.get("total_results")
        print(f"  page {page}: +{len(results)} (have {len(records)}/{total})")
        if len(results) < PER_PAGE:
            break
        time.sleep(1.0)  # be polite to the API

    # stable, time-ordered for playback
    records.sort(key=lambda r: (r["d"] or "0000-00-00", r["id"]))

    groups: dict[str, int] = {}
    for r in records:
        groups[r["ic"]] = groups.get(r["ic"], 0) + 1
    dated = [r["d"] for r in records if r["d"]]

    payload = {
        "meta": {
            "user": user,
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "total": len(records),
            "groups": dict(sorted(groups.items(), key=lambda kv: -kv[1])),
            "date_min": min(dated) if dated else None,
            "date_max": max(dated) if dated else None,
        },
        "observations": records,
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    print(f"Wrote {len(records)} observations to {out} ({out.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    main()

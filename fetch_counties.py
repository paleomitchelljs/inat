#!/usr/bin/env python3
"""Pull mob-rule.com county-visit data for one or more users into a compact
JSON file the site consumes for its County Map view.

mob-rule exposes each user's data at /aux/ucolors/<user> as JSON:
    {"counties": {"County/ST/REGION": <code>, ...},
     "legend":   {<code>: {"color","description","count"}, ..., "meta": {...}}}
It sends **no CORS headers**, so this must run server-side (here / the daily
Action) — the browser can't fetch it directly like it does the iNat API.

We resolve each US county name to its 5-digit FIPS code using the us-atlas
county boundaries (the same TopoJSON the client renders), so the browser only
ever matches FIPS→FIPS. Output: docs/data/counties.json.

No third-party deps — stdlib urllib only.

Usage:
    python3 fetch_counties.py [--boundaries PATH_OR_URL] [--out PATH] [user ...]
Defaults: users = mitchelljs smilingcyclops ; boundaries = us-atlas@3 on unpkg.
"""
from __future__ import annotations

import json
import re
import ssl
import sys
import time
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UCOLORS = "https://www.mob-rule.com/aux/ucolors/"
BOUNDARIES_DEFAULT = "https://unpkg.com/us-atlas@3/counties-10m.json"
DEFAULT_USERS = ["mitchelljs", "smilingcyclops"]
USER_AGENT = "inat-field-guide/1.0 (county map builder; stdlib urllib)"

# 2-digit state FIPS → USPS abbreviation (incl. DC + territories mob-rule uses).
STATE_FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
    "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI",
    "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
    "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
    "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
    "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
    "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP",
    "72": "PR", "78": "VI",
}

# Connecticut replaced its 8 counties with 9 planning regions as county
# equivalents (2022); us-atlas@3 still ships the old counties, so we map each
# region to the traditional county holding its principal area. Approximate, and
# some regions share a county (union of visits) — logged as such.
CT_REGION_FIPS = {
    "capitol": "09003",                        # Hartford
    "naugatuck valley": "09009",               # New Haven (Waterbury)
    "northeastern": "09015",                   # Windham
    "northwest hills": "09005",                # Litchfield
    "south central": "09009",                  # New Haven
    "southeastern": "09011",                   # New London
    "greater bridgeport": "09001",             # Fairfield
    "lower connecticut river valley": "09007", # Middlesex
    "western": "09001",                        # Fairfield
    "western connecticut": "09001",            # Fairfield
}

_SUFFIX = re.compile(
    r"\b(county|parish|borough|census area|municipality|city and borough|municipio)\b")

try:
    import certifi
    _SSL_CTX: ssl.SSLContext | None = ssl.create_default_context(cafile=certifi.where())
except Exception:  # noqa: BLE001
    _SSL_CTX = ssl.create_default_context()


def norm(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = s.lower().strip()
    s = _SUFFIX.sub("", s)
    s = s.replace("st.", "st").replace("ste.", "ste")
    s = re.sub(r"[.'\-]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=90, context=_SSL_CTX) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            wait = 2 ** attempt
            print(f"  ! {url} failed ({e}); retry in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"Failed to fetch {url} after retries")


def load_crosswalk(src: str) -> dict[tuple[str, str], list[str]]:
    """(norm_name, ST) → [FIPS…] from us-atlas counties (list handles the
    county/independent-city name collisions, e.g. Baltimore, St. Louis)."""
    topo = get_json(src) if src.startswith("http") else json.loads(Path(src).read_text())
    xwalk: dict[tuple[str, str], list[str]] = {}
    for g in topo["objects"]["counties"]["geometries"]:
        fips = g["id"]
        st = STATE_FIPS.get(fips[:2])
        if not st:
            continue
        xwalk.setdefault((norm(g["properties"]["name"]), st), []).append(fips)
    return xwalk


def resolve(name: str, st: str, xwalk: dict) -> str | None:
    """mob-rule 'Name/ST' → FIPS, or None if unmappable."""
    if st == "DC":
        return "11001"
    is_city = name.lower().startswith("city of ")
    base = name[8:] if is_city else name
    cands = xwalk.get((norm(base), st))
    if cands:
        if len(cands) == 1:
            return cands[0]
        # collision: independent cities use last-3 ≥ 500; counties use < 500.
        for f in cands:
            if (int(f[-3:]) >= 500) == is_city:
                return f
        return cands[0]
    if st == "CT":  # planning-region fallback
        return CT_REGION_FIPS.get(norm(base))
    return None


def build_user(user: str, xwalk: dict) -> tuple[dict, list[str]]:
    print(f"Fetching mob-rule counties for '{user}' …")
    data = get_json(UCOLORS + user)
    raw = data.get("counties", {})
    legend = data.get("legend", {})
    meta = legend.get("meta", {})

    counties: dict[str, str] = {}     # FIPS → legend code
    unmapped: list[str] = []
    for key, code in raw.items():
        if not key.endswith("/USA"):
            continue                  # US-only for now (us-atlas is US counties)
        name, st = key.split("/")[0], key.split("/")[1]
        fips = resolve(name, st, xwalk)
        if fips:
            counties[fips] = code     # CT collisions: last write wins (union)
        else:
            unmapped.append(f"{name}/{st}")

    # Keep only real legend entries (drop the "meta" pseudo-key), preserve order.
    clean_legend = {k: {"color": v.get("color"), "description": v.get("description", "")}
                    for k, v in legend.items() if k != "meta"}
    order = meta.get("order") or list(clean_legend.keys())

    print(f"  {len(counties)} counties mapped · {len(unmapped)} unmapped"
          + (f" ({', '.join(unmapped)})" if unmapped else ""))
    return {
        "fullname": meta.get("fullname") or user,
        "total_us": len(counties),
        "order": order,
        "legend": clean_legend,
        "counties": counties,
    }, unmapped


def main() -> None:
    args = sys.argv[1:]
    boundaries = BOUNDARIES_DEFAULT
    out = Path("docs/data/counties.json")
    users: list[str] = []
    i = 0
    while i < len(args):
        if args[i] == "--boundaries":
            boundaries = args[i + 1]; i += 2
        elif args[i] == "--out":
            out = Path(args[i + 1]); i += 2
        else:
            users.append(args[i]); i += 1
    if not users:
        users = DEFAULT_USERS

    print(f"Boundaries: {boundaries}")
    xwalk = load_crosswalk(boundaries)
    print(f"Crosswalk: {len(xwalk)} county name/state keys")

    out_users: dict[str, dict] = {}
    unmapped_all: dict[str, list[str]] = {}
    for u in users:
        rec, unmapped = build_user(u, xwalk)
        out_users[u] = rec
        if unmapped:
            unmapped_all[u] = unmapped

    payload = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "https://www.mob-rule.com/aux/ucolors",
            "boundaries": "us-atlas@3 counties-10m (5-digit county FIPS)",
            "users": users,
        },
        "users": out_users,
        "unmapped": unmapped_all,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    print(f"Wrote {out} ({out.stat().st_size/1024:.0f} KB) for {len(users)} users")


if __name__ == "__main__":
    main()

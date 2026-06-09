# IMPLEMENTATION.md

Architecture, file reference, and feature internals for the iNaturalist Field
Guide. See [CLAUDE.md](CLAUDE.md) for goals and [TODO.md](TODO.md) for the
backlog + change log.

---

## 1. Architecture at a glance

```
                    iNaturalist public API (no auth, CORS-enabled)
                              │  GET /v1/observations?user_login=…
                              ▼
   ┌──────────┐  writes   ┌──────────────────────────────┐
   │ fetch.py │ ────────▶ │ docs/data/observations.json  │   (compact, committed)
   └──────────┘           └──────────────────────────────┘
        ▲                              │ fetch()
        │ runs daily                   ▼
   ┌───────────────────────┐    ┌──────────────────────────────────────┐
   │ .github/workflows/    │    │ docs/index.html + css/style.css +     │
   │   update.yml (cron)   │    │ js/app.js  (Leaflet map + gallery)    │
   └───────────────────────┘    └──────────────────────────────────────┘
                                            │ served by
                                            ▼
                                  GitHub Pages  (branch main, folder /docs)
```

**Key properties**

- **No build step, no backend.** The page is static; data is a flat JSON file.
- **Data is baked, not live-fetched.** The page reads a committed JSON snapshot
  for instant load and resilience to API downtime. Freshness comes from the
  daily Action re-running `fetch.py` and committing the diff.
- **Single source of identity.** The username lives in the data file's `meta`;
  the UI reads it from there, so the page re-themes automatically for any user.

---

## 2. Data flow

1. `fetch.py` paginates the iNat API (`id_above` cursor, 200/page), reduces each
   observation to a small set of fields, sorts by date, and writes
   `docs/data/observations.json` with a `meta` header.
2. On page load, `app.js` `fetch()`es that file once and builds everything from
   it — map markers, group filters, the timeline range, and the species gallery.
3. The GitHub Action re-runs step 1 daily; if the JSON changed, it commits and
   pushes, which republishes Pages.

---

## 3. File-by-file reference

### `fetch.py` — data builder
- **Deps:** Python standard library only. Optionally uses `certifi` for its CA
  bundle if importable (works around python.org macOS builds that ship without
  a usable trust store); Ubuntu CI needs neither.
- **Usage:** `python3 fetch.py [username] [output_path]`
  (defaults: `mitchelljs`, `docs/data/observations.json`).
- **Pagination:** `order_by=id&order=asc` with `id_above=<last id>`, `per_page=200`.
  This cursor style sidesteps the API's 10,000-result offset ceiling, so it
  scales to large accounts. 1 s pause between pages to be polite. 5 retries with
  exponential backoff per page.
- **`compact(o)`** maps a full API observation to the stored record (see schema
  in §4). Photo stored as the `square` thumbnail URL; the client swaps the size
  token at render time. **Reptilia is split into its order** (Squamata /
  Testudines / Crocodylia / Rhynchocephalia) by scanning `taxon.ancestor_ids`
  against `REPTILE_ORDERS`; records identified only to class stay `"Reptilia"`.
- **Output:** `{ meta, observations }`, written minified (`separators=(",",":")`,
  `ensure_ascii=False`). Records sorted by `(observed_on, id)` for stable
  playback.

### `docs/index.html` — page shell
- Loads Leaflet **1.9.4** CSS/JS from `unpkg` (pinned; **no SRI** — see §8).
- **Top bar:** title, `#subtitle` (filled at runtime with counts/range/user),
  and two `.tab` buttons (`data-view="map"` / `"guide"`).
- **Map view (`#view-map`):** `#map`, the `#filters` panel (group chips +
  all/none), and the `#timeline` panel (play button, scrub slider, date label,
  mode toggle, window-size slider, speed slider, live count).
- **Guide view (`#view-guide`):** search box, sort `<select>`, count, group
  chips, and the `#gallery` grid.

### `docs/css/style.css` — styling
- Dark theme via CSS custom properties (`:root`). Control panels float over the
  map with `position:absolute` + blur.
- **Specificity note:** `.view { display:none }` / `.view.active { display:block }`
  govern tab visibility. `#view-guide` (an ID) must **not** set `display`
  unconditionally or it overrides the hide rule — only `#view-guide.active` sets
  `display:flex`. (This was a bug; see TODO log.)
- Gallery is a responsive grid: `repeat(auto-fill, minmax(170px, 1fr))`.

### `docs/js/app.js` — application
All logic lives here. Major sections:

| Section | Responsibility |
|---|---|
| `COLORS` / `ORDER` | Per-group dot colors and display order. Keyed by major group, including the split-out reptile orders (Squamata/Testudines/Crocodylia). |
| `StarMarker` | `L.CircleMarker` subclass that draws a 5-pointed star on the canvas (overrides `_updatePath`). Used for observations after `STAR_AFTER`; see §5. |
| state vars | `OBS`, `MARKERS`, `MAP_ACTIVE`/`GUIDE_ACTIVE` (independent per tab), `SPECIES`, `dayMin/dayMax/curDay`, `mode`, `windowDays`, `speed`, `playing`. |
| helpers | `dayOf` (date→epoch-day int), `labelOf`, `esc` (HTML-escape), `photoAt` (swap `square`→`small`/etc. in a photo URL). |
| boot | `fetch()` the JSON → `init()`; failures render a `#fatal` overlay with recovery hints. |
| `buildGroups` | Builds filter chips for both tabs from `meta.groups`. |
| `initMap` / `buildMarkers` | Leaflet map (`preferCanvas:true`, CARTO `dark_all` tiles); one canvas marker per geolocated obs — `StarMarker` if observed after `STAR_AFTER`, else `circleMarker` — lazy-bound popup, `fitBounds`. |
| `render` | The hot path — see §5. |
| playback | `stepSize`, `tick`, `play`, `pause` (`setInterval` @ 50 ms). |
| `aggregateSpecies` / `buildGallery` | Group obs into taxa; filter/sort/render cards. |
| `wireEvents` | Tabs (with `MAP.invalidateSize()` on show), playback, mode, window, chips, gallery controls. |

### `.github/workflows/update.yml` — automation
- Triggers: `schedule` (cron `17 9 * * *`, ~09:17 UTC daily) and
  `workflow_dispatch` (manual button).
- `permissions: contents: write` + a `concurrency` group so runs don't overlap.
- Steps: checkout → `setup-python` → `python3 fetch.py mitchelljs
  docs/data/observations.json` → commit **only if** the file changed → push.

### `docs/.nojekyll`
- Empty marker that disables Jekyll processing on Pages (serves files as-is).

---

## 4. Data schema — `docs/data/observations.json`

```jsonc
{
  "meta": {
    "user": "mitchelljs",
    "generated_at": "2026-06-08T12:00:00Z",  // UTC ISO-8601
    "total": 1258,
    "groups": { "Aves": 307, "Plantae": 302, ... },  // name→count, desc
    "date_min": "2016-04-16",
    "date_max": "2026-06-02"
  },
  "observations": [
    {
      "id": 28576354,          // iNat observation id
      "d":  "2019-07-10",      // observed_on (YYYY-MM-DD; may be null)
      "lat": 44.90084,         // rounded to 5 dp (null if no geo)
      "lng": -93.14225,
      "ic": "Plantae",         // major group: iconic_taxon_name, but Reptilia is
                               //   stored as its order (Squamata/Testudines/
                               //   Crocodylia/…); "Unknown" fallback
      "ti": 125489,            // taxon id (for gallery grouping + iNat links)
      "n":  "Rubus occidentalis",       // scientific name
      "c":  "black raspberry",          // preferred common name (may be null)
      "r":  "species",         // taxon rank
      "q":  "research",        // quality_grade
      "p":  "https://…/photos/44555781/square.jpg",  // square thumb URL (may be null)
      "pl": "Big Rivers Regional Trl, Lilydale, MN, US"  // place_guess (may be null)
    }
  ]
}
```

Short keys keep the file small (~353 KB for 1,258 records). **Any change to
these keys must update both `fetch.py` (`compact`) and `app.js`, plus this
section.**

### Current dataset snapshot (`mitchelljs`)
- 1,258 observations, 2016-04-16 → 2026-06-02 (~10.1 yr); all geolocated, 1,255
  with photos; **597 distinct taxa**.
- Groups: Aves 307 · Plantae 302 · Amphibia 239 · Insecta 135 · Mammalia 63 ·
  Squamata 49 · Fungi 38 · Testudines 30 · Arachnida 28 · Animalia 26 ·
  Mollusca 23 · Actinopterygii 16 · Crocodylia 2. (Reptilia 81 = Squamata 49 +
  Testudines 30 + Crocodylia 2.)
- Marker shapes: 583 observations on/before 2019-04-18 render as circles; 675
  after as stars.

---

## 5. Feature internals

### Time-lapse map
- **Time model:** dates are converted to integer epoch-days (`dayOf`). The
  timeline spans `dayMin…dayMax`; `curDay` is the current playhead.
- **`render()`** iterates every marker once and sets its style from `curDay`,
  `mode`, and the active group set. It memoizes the last opacity/radius per
  marker (`m._op`/`m._rad`) so unchanged markers don't trigger canvas redraws.
- **Cumulative mode:** show all obs with `day ≤ curDay`. Observations within
  `HIGHLIGHT_DAYS` (21) of the playhead render larger/brighter — a visible
  "growth front."
- **Window mode:** show obs in `[curDay − windowDays, curDay]`; opacity/radius
  fade with recency. `windowDays` is user-set (7–365).
- **Playback:** `setInterval` @ 50 ms; `stepSize()` advances ~`span/600` days per
  tick scaled by `speed`, so a full play is ~30 s at the default speed
  regardless of date range. Scrubbing pauses and jumps `curDay`.
- **Rendering tech:** Leaflet with `preferCanvas:true` and an `L.canvas`
  renderer — one canvas redraw per frame handles ~1,300 points smoothly. Popups
  are lazily built via `bindPopup(fn)`.
- **Marker shapes:** observations *after* `STAR_AFTER` (2019-04-18, strict)
  render as 5-pointed **stars**; on/before, as **circles**. `StarMarker`
  subclasses `L.CircleMarker` and overrides `_updatePath` to stroke a star on the
  shared canvas, so it inherits `setStyle`/`setRadius` (the time-lapse radius and
  opacity animation work identically) and circle-based click hit-testing (popups
  still open). To change the date, edit the `STAR_AFTER` constant in `app.js`.
- **Filters:** group chips toggle membership in `MAP_ACTIVE`; `render()` reflects
  it immediately. all/none bulk-toggle.

### Field guide gallery
- **`aggregateSpecies()`** groups observations by `ti` (taxon id; falls back to
  name when missing) into `{ ti, n, c, ic, r, count, photo, last }`, picking the
  first available photo and the most recent date.
- **`buildGallery()`** filters by `GUIDE_ACTIVE` (independent of the map tab) and
  the search term (common or scientific name), sorts by count / recency / common
  / scientific, and renders cards. Each card links to the user's observations of
  that taxon on iNaturalist. Thumbnails use the `small` size and `loading="lazy"`.

---

## 6. Deployment

GitHub Pages, **branch `main`, folder `/docs`**. The data file is committed, so
the site works as soon as Pages builds; the Action only keeps it fresh. The
Action needs **Settings → Actions → Workflow permissions → Read and write** to
commit. Full steps: see `README.md`.

---

## 7. Local development

```bash
python3 fetch.py                    # refresh docs/data/observations.json
cd docs && python3 -m http.server   # http://localhost:8000  (NOT file://)
```

`file://` is blocked by browser CORS for `fetch()` of the JSON — always serve
over HTTP.

---

## 8. Known limitations & design decisions

- **No SRI on the Leaflet CDN tags.** Pinned to 1.9.4. A wrong Subresource
  Integrity hash silently breaks the whole page, and the hashes couldn't be
  verified reliably in the build sandbox, so they were omitted deliberately.
  (Backlog item to add verified hashes.)
- **Gallery renders all taxa at once.** Fine at 597; very large accounts
  (thousands of taxa) may want virtualization/pagination.
- **Observations without `observed_on` are excluded from the time-lapse**
  (they have no position on the timeline) but still appear in the gallery.
- **Geoprivacy:** obscured/private coordinates come back coarse or absent from
  the public API; such records simply won't plot precisely. `mitchelljs`'s
  current data is fully open.
- **Single dataset.** One user per deployment; comparing users isn't supported.

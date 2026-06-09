# TODO

Backlog of feature ideas plus the development log. See
[CLAUDE.md](CLAUDE.md) for goals and [IMPLEMENTATION.md](IMPLEMENTATION.md) for
how things currently work.

> **Logging rule:** every code/config/data-shape change gets a dated entry in
> the *Development Log* below. Completed backlog items move into the log.

---

## Ideas / backlog

Roughly ordered by value-to-effort. Not commitments — a menu.

### Map & time-lapse
- [ ] **Deep-linkable state** — encode active groups, mode, window, and playhead
      in the URL query string so a view can be shared/bookmarked.
- [ ] **Heatmap / clustering toggle** for dense areas (e.g. home patch) — Leaflet
      `markercluster` or a heat layer as an alternate render mode.
- [ ] **Date-range brush** — restrict the whole map to a sub-range (e.g. one
      year or one season) independent of the playhead.
- [ ] **Per-species trace** — click a gallery card to fly the map to that taxon
      and animate just its observations over time.
- [ ] **Basemap switcher** — light/dark/satellite toggle (currently hardcoded
      CARTO `dark_all`).
- [ ] **Trail/connector lines** in window mode to show movement between sightings.
- [ ] **Show count of non-geolocated records** somewhere so they aren't silently
      dropped from the map.

### Field guide
- [ ] **Photo lightbox** — click a card thumbnail for a larger image + all photos
      for that taxon.
- [ ] **Taxonomic browse** — group beyond the 11 iconic taxa (order/family tree),
      not just the flat species grid.
- [ ] **Virtualize the gallery** for accounts with thousands of taxa.
- [ ] **Per-taxon stats** — first/last seen, observation frequency sparkline.

### Insights / stats
- [ ] **Stats panel** — life-list size, new-taxa-per-year, most-observed places,
      phenology (observations by month) charts.
- [ ] **Milestones** — annotate the timeline with "100th species", "first
      amphibian", etc.

### Data / pipeline
- [ ] **Add verified SRI hashes** to the Leaflet CDN tags (see IMPLEMENTATION §8).
- [ ] **Richer fetch fields** — pull all photos (not just the first), license,
      and observation fields; weigh against file size.
- [ ] **Incremental fetch** — only pull observations newer than the last run to
      cut API calls on the daily job.
- [ ] **Gzip / split data** if the JSON grows large (lazy-load by group or year).
- [ ] **Configurable username** via a small `config.json` instead of editing the
      workflow + regenerating.

### Polish / robustness
- [ ] **Accessibility pass** — keyboard control of the timeline, ARIA on chips,
      focus states, color-contrast check of the group palette.
- [ ] **PWA / offline** — cache the shell + data for offline viewing.
- [ ] **Loading indicator** while the JSON is fetched on slow connections.
- [ ] **Mobile layout** refinements for the floating panels on small screens.

---

## Development log

Newest first. Format: `## YYYY-MM-DD — summary`, then what changed and why.

### 2026-06-08 — Fix: hidden markers were still clickable
**Reported:** at Oct 11 2021, Cedar Rapids showed no markers, yet clicking the
area opened observation popups.

**Diagnosis (not a paint bug):** all 168 Cedar Rapids observations are dated
*after* Oct 11 2021 — none existed by that date, so cumulative mode correctly drew
nothing. But hidden markers were set to `fillOpacity:0` *without* clearing
interactivity, and Leaflet's canvas hit-test reads `options.interactive` live
(`L.Canvas._onClick`). So those 168 future dots were invisible but clickable,
creating the illusion that markers should be there.

- **`app.js`** — `render()` now sets `marker.options.interactive = false` for
  hidden markers and `true` for visible ones, so clickability tracks what's drawn.
- **Verified:** simulated render at 2021-10-11 (cumulative) — CR clickable went
  168 → 0, matching 0 drawn; global 800 shown. `node --check` OK. Applies to both
  modes (future dates in cumulative; outside-window in window mode).

### 2026-06-08 — Stacked year/month/day timeline ticker
Replaced the single right-aligned date string (which jittered as month/day widths
changed) with three fixed-position slots stacked vertically.

- **`index.html`** — `#datelabel` is now a column of `#dl-year` / `#dl-month` /
  `#dl-day` spans (role=group, aria-label "Current date").
- **`style.css`** — `.datelabel` is a fixed-width (56px) centered flex column;
  year (ink), month (uppercase, muted, letter-spaced), day (large, accent). All
  `tabular-nums` so digits don't shift. Mobile width 50px.
- **`app.js`** — dropped `labelOf`; added `MONTHS` + `setDateTicker(day)` writing
  the three slots from UTC fields; `render()` calls it.
- **Why:** during playback the centered fixed slots stay put, so the eye can read
  the changing day/month/year without the text reflowing.
- **Verified:** syntax; no dangling `labelOf`; HTML/JS ids match; date math
  (e.g. 2026-06-02 → 2026 / Jun / 2). Visual confirmation in-browser still pending.

### 2026-06-08 — Fix: stars rendered nothing after the cutoff date
**Bug:** observations after 2019-04-18 didn't plot at all. `StarMarker._updatePath`
wrote `r._drawnLayers[this._leaflet_id] = this`, but `_drawnLayers` doesn't exist
in Leaflet 1.9.4 (verified against `leaflet-src.js` — the real
`L.Canvas._updateCircle` never references it). That threw a `TypeError` inside the
canvas `_draw` loop; because markers are added in date order, every circle drew
first, then the first star threw and aborted the loop, leaving all stars unpainted.

- **`app.js`** — removed the `_drawnLayers` line; `_updatePath` now mirrors
  `_updateCircle` exactly (beginPath → star path → `_fillStroke`). Rounded `outer`
  and floored `inner` at 1px to match circle crispness.
- **Lesson:** `node --check` only catches syntax; this was a runtime throw. Added
  a headless simulation of `_updatePath` against a mock canvas (no throw; 1 moveTo
  + 9 lineTo + closePath; top point straight up; `_fillStroke` once, incl. the
  opacity-0 hidden case). Still want a real-browser confirmation.

### 2026-06-08 — Split Reptilia into orders
Per request, the "Reptilia" major group is now broken into its taxonomic orders.

- **`fetch.py`** — added `REPTILE_ORDERS` (Squamata 26172, Testudines 39532,
  Crocodylia 26039, Rhynchocephalia 26162). `compact()` reassigns a reptile's
  `ic` to its order by scanning `taxon.ancestor_ids`; class-only records stay
  `"Reptilia"`. Regenerated `observations.json`.
- **`app.js`** — added `COLORS` for Squamata (#8172B3), Testudines (#2AA198),
  Crocodylia (#E040FB), plus a muted `Reptilia` fallback (#9E8BA8); inserted the
  orders into `ORDER` in place of Reptilia. Chips/legend/gallery pick these up
  automatically.
- **Result:** Reptilia 81 → Squamata 49 + Testudines 30 + Crocodylia 2. No
  class-only reptiles in the current data. Verified group counts.
- **Why:** lizards/snakes, turtles, and crocodilians are ecologically distinct;
  one "Reptilia" bucket obscured that.

### 2026-06-08 — Star markers for observations after 2019-04-18
- **`app.js`** — added `STAR_AFTER = '2019-04-18'` and a `StarMarker`
  (`L.CircleMarker` subclass) that draws a 5-pointed star on the canvas via an
  overridden `_updatePath`. `buildMarkers()` picks `StarMarker` for obs strictly
  after the cutoff, else `circleMarker`.
- **Why this approach:** keeping a `CircleMarker` subclass on the canvas renderer
  preserves the time-lapse `setStyle({radius,fillOpacity})` animation and
  click-to-popup hit-testing for free, and stays fast (no DOM markers).
- **Split:** 583 circles (on/before 2019-04-18) · 675 stars (after). "After" is
  strict — points on 2019-04-18 stay circles. Verified counts; `node --check` OK.
  Visual check in a browser still pending (sandbox can't render).

### 2026-06-08 — Initial build
Scaffolded the whole project from scratch.

- **`fetch.py`** — stdlib-only iNat API puller. Cursor pagination via `id_above`
  (avoids the 10k offset cap), reduces each observation to a compact record,
  sorts by date, writes `docs/data/observations.json` with a `meta` header.
  Added a `certifi` SSL-context fallback after the local macOS Python build
  failed cert verification (`CERTIFICATE_VERIFY_FAILED`); Ubuntu CI is unaffected.
- **`docs/index.html` + `css/style.css` + `js/app.js`** — static site: Leaflet
  canvas time-lapse map (cumulative + moving-window modes, group filters, scrub,
  speed, lazy popups) and a searchable/sortable species gallery. Dark theme.
- **`.github/workflows/update.yml`** — daily cron (+ manual dispatch) that
  re-runs `fetch.py` and commits the diff; Pages serves `/docs`.
- **`README.md`** — setup/deploy/local-dev docs.
- **Generated data:** 1,258 observations for `mitchelljs` (2016–2026), all
  geolocated, 597 taxa, ~353 KB.
- **Decisions:** baked JSON + daily refresh (over live in-browser fetch);
  toggle between cumulative/window; map + gallery scope. Shipped Leaflet 1.9.4
  **without SRI** (hashes unverifiable in the sandbox; wrong hash = broken page).
- **Fixed:** CSS specificity bug where `#view-guide { display:flex }` overrode
  `.view { display:none }`, leaving the guide tab always visible — scoped the
  `display` to `#view-guide.active`.
- **Verified:** `fetch.py` end-to-end (1,258 records); `node --check` on
  `app.js`; data integrity + sort order; all asset paths resolve; simulated the
  time-lapse visibility math against real data (cumulative@end = 1,258,
  Aves = 307, ~31 s full play). Not verified in a real browser — sandbox blocks
  browsers and socket binding; visual/interaction check still pending locally.

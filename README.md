# iNaturalist Field Guide

An automated, interactive guide to a single iNaturalist user's observations,
hosted as a static site on GitHub Pages.

- **Time-lapse map** — watch observations appear over time, coloured and
  filterable by major group (birds, plants, amphibians, …). Toggle between
  **cumulative** growth (your life list filling in) and a **moving window**
  (seasonal/migratory patterns).
- **Field guide** — a searchable, sortable gallery of every taxon you've
  recorded, with photos, counts, and links back to iNaturalist.
- **Auto-refresh** — a GitHub Action re-pulls your observations daily and
  commits the update; no server required.

Default user is **`mitchelljs`** (1,258 observations, 2016–2026).

## How it works

```
fetch.py  ──pulls──▶  docs/data/observations.json  ──read by──▶  docs/index.html
   ▲                                                                 (Leaflet map
   └── GitHub Action (.github/workflows/update.yml) runs it daily      + gallery)
```

`fetch.py` calls the public iNaturalist API (no auth needed) and writes a
compact JSON file. The page is plain HTML/CSS/JS + [Leaflet](https://leafletjs.com)
loaded from a CDN — nothing to build.

## One-time setup

1. **Create a GitHub repo** and push this folder to it.
2. **Settings → Pages →** set *Source* to **Deploy from a branch**, branch
   `main`, folder **`/docs`**. Save.
3. **Settings → Actions → General →** under *Workflow permissions* select
   **Read and write permissions** (lets the daily job commit refreshed data).
4. Your site goes live at `https://<your-username>.github.io/<repo>/`.

The data file is already committed, so the site works the moment Pages builds —
the Action just keeps it current.

## Using a different iNaturalist account

Change the username in two places:

- `.github/workflows/update.yml` → the `python3 fetch.py mitchelljs …` line
- regenerate locally: `python3 fetch.py <username>`

The page reads the username from the data file, so the UI updates automatically.

## Local development

```bash
python3 fetch.py                    # refresh docs/data/observations.json
cd docs && python3 -m http.server   # then open http://localhost:8000
```

Serve over HTTP (not `file://`) — browsers block `fetch()` of local files
otherwise.

> `fetch.py` uses only the Python standard library. On some macOS Python builds
> the system CA bundle is missing; if installed, [`certifi`](https://pypi.org/project/certifi/)
> is used automatically. CI on Ubuntu needs neither.

# CLAUDE.md

## Goal

A static, auto-updating website that turns one iNaturalist user's observations
(default account: **`mitchelljs`**) into an interactive guide:

1. A **time-lapse map** of every observation — colored and filterable by major
   group (birds, plants, amphibians, …), playable as either *cumulative* growth
   (life list filling in over time) or a *moving window* (seasonal/migratory
   patterns).
2. A **field guide** gallery of every taxon recorded — searchable, sortable,
   each entry linking back to iNaturalist.

It is plain HTML/CSS/JS served from GitHub Pages. A Python script plus a daily
GitHub Action keep the data current with no server to run.

## Where things are

- **[IMPLEMENTATION.md](IMPLEMENTATION.md)** — architecture, file-by-file
  reference, data schema, and how each feature works. **Read this before
  changing code.**
- **[TODO.md](TODO.md)** — backlog of feature ideas and the development log.

## Working agreement

- **Log every change.** After any code, config, or data-shape change, append a
  dated entry to the *Development Log* in `TODO.md` — what changed and why. When
  you finish a backlog item, move it from *Ideas* into the log.
- Keep `IMPLEMENTATION.md` in sync whenever you add, remove, or restructure
  files, features, or the data schema.

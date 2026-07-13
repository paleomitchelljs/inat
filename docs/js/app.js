/* iNaturalist Field Guide — time-lapse map + species gallery.
   Consumes docs/data/observations.json produced by fetch.py. */
'use strict';

// Canonical major-group colours + a sensible display order.
const COLORS = {
  Aves: '#4C72B0', Plantae: '#55A868', Amphibia: '#C44E52', Insecta: '#DD8452',
  // Reptilia is split into its orders; "Reptilia" remains a fallback for
  // records identified only to class.
  Squamata: '#8172B3', Testudines: '#2AA198', Crocodylia: '#E040FB', Reptilia: '#9E8BA8',
  Mammalia: '#937860', Fungi: '#DA8BC3', Arachnida: '#CCB974',
  Mollusca: '#64B5CD', Actinopterygii: '#519DE9', Animalia: '#8C8C8C',
  Protozoa: '#A0522D', Chromista: '#1FA1A1', Unknown: '#7A7A7A',
};
const ORDER = ['Aves', 'Plantae', 'Amphibia', 'Insecta',
  'Squamata', 'Testudines', 'Crocodylia', 'Reptilia', 'Mammalia',
  'Fungi', 'Arachnida', 'Mollusca', 'Actinopterygii', 'Animalia',
  'Protozoa', 'Chromista', 'Unknown'];

const MS_PER_DAY = 86400000;
const HIGHLIGHT_DAYS = 21;   // recent observations pulse larger in cumulative mode
const STAR_AFTER = '2019-04-18';  // observations strictly after this date render as stars
// Mirror of fetch.py's REPTILE_ORDERS: Reptilia is split into its orders when a
// live-refreshed observation's taxon ancestry identifies one. Keep in sync.
const REPTILE_ORDERS = { 26172: 'Squamata', 39532: 'Testudines', 26039: 'Crocodylia', 26162: 'Rhynchocephalia' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- state ----
let META, OBS = [], MAP, CANVAS, TRAIL, USER = 'mitchelljs';
let MARKERS = [];                 // one canvas circleMarker per geolocated obs
const MAP_ACTIVE = new Set();     // active groups on the map tab
const GUIDE_ACTIVE = new Set();   // active groups on the guide tab
let SPECIES = [];                 // aggregated taxa for the gallery
let dayMin = 0, dayMax = 0, curDay = 0;
let mode = 'cumulative', windowDays = 30, speed = 5;
let playing = false, timer = null;

const $ = (id) => document.getElementById(id);

// ---- helpers ----
const dayOf = (dateStr) => Math.floor(Date.parse(dateStr + 'T00:00:00Z') / MS_PER_DAY);

// Write the stacked year/month/day ticker (fixed slots; see .datelabel CSS).
function setDateTicker(day) {
  const dt = new Date(day * MS_PER_DAY);
  $('dl-year').textContent = dt.getUTCFullYear();
  $('dl-month').textContent = MONTHS[dt.getUTCMonth()];
  $('dl-day').textContent = dt.getUTCDate();
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const photoAt = (url, size) => (url ? url.replace(/\/square\.(jpe?g|png|gif)/i, '/' + size + '.$1') : null);

// =====================================================================
// boot
// =====================================================================
fetch('data/observations.json', { cache: 'no-cache' })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(init)
  .catch(fatal);

function fatal(err) {
  const div = document.createElement('div');
  div.id = 'fatal';
  div.innerHTML = `<div><p>Couldn't load observation data.</p>
    <p style="font-size:12px">Run <code>python3 fetch.py</code> to generate
    <code>docs/data/observations.json</code>, then serve over http
    (<code>cd docs &amp;&amp; python3 -m http.server</code>).</p>
    <p style="font-size:11px;opacity:.7">${esc(err.message || err)}</p></div>`;
  document.body.appendChild(div);
}

// First boot: create the map + wire event handlers once, then load the data.
function init(data) {
  initMap();
  wireEvents();
  applyData(data, { fit: true });
}

// (Re)build everything that depends on the observation data. Called on first
// load and again by the force-update button with freshly fetched records.
// `opts.fit` fits the map to all points (first load only; a refresh keeps the
// user's current pan/zoom).
function applyData(data, opts = {}) {
  META = data.meta || {};
  OBS = data.observations || [];
  USER = META.user || USER;

  const total = (META.total || OBS.length).toLocaleString();
  $('subtitle').textContent =
    `${total} observations · ${META.date_min} → ${META.date_max} · @${USER}`;
  document.title = `@${USER} · iNaturalist Field Guide`;

  dayMin = dayOf(META.date_min);
  dayMax = dayOf(META.date_max);
  curDay = dayMax;
  $('scrub').max = String(dayMax - dayMin);
  $('scrub').value = String(dayMax - dayMin);

  buildGroups();
  clearMarkers();
  buildMarkers(opts.fit);
  aggregateSpecies();
  buildGallery();
  render();
}

// =====================================================================
// group chips (shared shape, separate active-sets per tab)
// =====================================================================
function presentGroups() {
  const g = META.groups || {};
  return ORDER.filter((k) => g[k]).concat(Object.keys(g).filter((k) => !ORDER.includes(k)));
}

function buildGroups() {
  const groups = presentGroups();
  // Reset to all-on (a refresh may add/remove groups); chips are rebuilt active.
  MAP_ACTIVE.clear(); GUIDE_ACTIVE.clear();
  groups.forEach((g) => { MAP_ACTIVE.add(g); GUIDE_ACTIVE.add(g); });

  const mk = (container, activeSet, onToggle) => {
    container.innerHTML = '';
    groups.forEach((g) => {
      const c = COLORS[g] || COLORS.Unknown;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip active';
      chip.style.setProperty('--c', c);
      chip.dataset.g = g;
      chip.innerHTML = `<span class="dot"></span>${esc(g)} <em>${META.groups[g]}</em>`;
      chip.addEventListener('click', () => {
        const on = chip.classList.toggle('active');
        if (on) activeSet.add(g); else activeSet.delete(g);
        onToggle();
      });
      container.appendChild(chip);
    });
  };

  mk($('group-chips'), MAP_ACTIVE, render);
  mk($('guide-chips'), GUIDE_ACTIVE, buildGallery);
}

function setAllChips(container, activeSet, on, after) {
  container.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', on);
    if (on) activeSet.add(chip.dataset.g); else activeSet.delete(chip.dataset.g);
  });
  after();
}

// =====================================================================
// map + markers
// =====================================================================
function initMap() {
  MAP = L.map('map', { preferCanvas: true, worldCopyJump: true, zoomControl: true });
  // Move the +/- zoom control to the top-right so it doesn't sit under (or poke
  // through) the top-left filters panel — visible when the panel is minimized.
  MAP.zoomControl.setPosition('topright');
  CANVAS = L.canvas({ padding: 0.5 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(MAP);
  // Added before buildMarkers() so the trail canvas sits below the marker canvas.
  TRAIL = new TrailLayer().addTo(MAP);
}

// Trail overlay: its own canvas in the overlay pane (below the marker canvas,
// which is appended later by buildMarkers). In window mode, render() feeds it
// the visible observations in chronological order and it strokes a segment
// between each consecutive pair, colored by the newer observation's group and
// faded by its recency — so movement over time reads as a path.
const TrailLayer = L.Layer.extend({
  onAdd: function (map) {
    this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-hide');
    this._canvas.style.position = 'absolute';
    this._canvas.style.pointerEvents = 'none';
    map.getPane('overlayPane').appendChild(this._canvas);
    map.on('move viewreset zoomend resize', this._reset, this);
    this._pts = [];
    this._reset();
    return this;
  },
  onRemove: function (map) {
    map.off('move viewreset zoomend resize', this._reset, this);
    L.DomUtil.remove(this._canvas);
  },
  // pts: [{ ll: L.LatLng, color: css, f: 0..1 recency }] in chronological order
  setData: function (pts) { this._pts = pts; this._draw(); },
  _reset: function () {
    const size = this._map.getSize();
    if (this._canvas.width !== size.x) this._canvas.width = size.x;
    if (this._canvas.height !== size.y) this._canvas.height = size.y;
    // Keep the canvas pinned to the viewport as the map pans.
    L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
    this._draw();
  },
  _draw: function () {
    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    const pts = this._pts;
    if (pts.length < 2) return;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    let prev = this._map.latLngToContainerPoint(pts[0].ll);
    for (let i = 1; i < pts.length; i++) {
      const cur = this._map.latLngToContainerPoint(pts[i].ll);
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(cur.x, cur.y);
      ctx.strokeStyle = pts[i].color;
      ctx.globalAlpha = 0.12 + 0.55 * pts[i].f;
      ctx.stroke();
      prev = cur;
    }
    ctx.globalAlpha = 1;
  },
});

// Canvas star marker: a CircleMarker subclass that draws a 5-pointed star
// instead of a circle. It still works with setStyle()/setRadius() and the canvas
// renderer, so the time-lapse animation (radius/opacity) and click-to-popup
// (inherited circle-based hit test) keep working unchanged.
const StarMarker = L.CircleMarker.extend({
  _updatePath: function () {
    const r = this._renderer;
    if (!r._drawing || this._empty()) return;
    const ctx = r._ctx;
    const p = this._point;
    const outer = Math.max(Math.round(this._radius), 1);
    const inner = Math.max(outer * 0.45, 1);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? outer : inner;
      const ang = (Math.PI / 5) * i - Math.PI / 2;  // first point straight up
      const x = p.x + Math.cos(ang) * rad;
      const y = p.y + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    r._fillStroke(ctx, this);  // mirrors L.Canvas._updateCircle; no _drawnLayers (absent in 1.9.4)
  },
});

// Remove all markers from the map (before a refresh rebuilds them).
function clearMarkers() {
  for (const m of MARKERS) MAP.removeLayer(m);
  MARKERS = [];
}

function buildMarkers(fit) {
  const starAfter = dayOf(STAR_AFTER);
  const pts = [];
  OBS.forEach((o) => {
    if (o.lat == null || o.lng == null || !o.d) return;
    const day = dayOf(o.d);
    const opts = {
      renderer: CANVAS, radius: 4, stroke: false,
      fillColor: COLORS[o.ic] || COLORS.Unknown, fillOpacity: 0,
    };
    const m = day > starAfter
      ? new StarMarker([o.lat, o.lng], opts)
      : new L.CircleMarker([o.lat, o.lng], opts);
    m._o = o;
    m._day = day;
    m.bindPopup(() => popupHtml(o), { minWidth: 220, maxWidth: 220, closeButton: true });
    m.addTo(MAP);
    MARKERS.push(m);
    pts.push([o.lat, o.lng]);
  });
  if (fit) {
    if (pts.length) MAP.fitBounds(pts, { padding: [40, 40] });
    else MAP.setView([20, 0], 2);
  }
}

function popupHtml(o) {
  const img = photoAt(o.p, 'small');
  const common = o.c || o.n || 'Unknown';
  const sci = o.n && o.c ? `<div class="pop-sci">${esc(o.n)}</div>` : '';
  return `<div class="pop">
    ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}
    <div class="pop-body">
      <div class="pop-name">${esc(common)}</div>
      ${sci}
      <div class="pop-meta">${esc(o.d)}${o.pl ? ' · ' + esc(o.pl) : ''}</div>
      <a href="https://www.inaturalist.org/observations/${o.id}" target="_blank" rel="noopener">View on iNaturalist ↗</a>
    </div></div>`;
}

// core render: set per-marker style from current day / mode / filters
function render() {
  const hiThreshold = curDay - HIGHLIGHT_DAYS;
  const lo = curDay - windowDays;
  let shown = 0;
  // MARKERS is chronological (OBS is sorted by (observed_on, id)), so pushing
  // visible window-mode markers in loop order yields the trail in time order.
  const trailPts = [];

  for (const m of MARKERS) {
    const o = m._o;
    const day = m._day;
    let visible = MAP_ACTIVE.has(o.ic);
    if (visible) {
      visible = mode === 'cumulative' ? day <= curDay : (day <= curDay && day >= lo);
    }

    if (!visible) {
      if (m._op !== 0) { m.setStyle({ fillOpacity: 0, radius: 4 }); m._op = 0; m._rad = 4; }
      // A hidden marker (future date in cumulative, or outside the window) must
      // not be clickable — otherwise it opens a popup for a dot you can't see.
      if (m.options.interactive) m.options.interactive = false;
      continue;
    }
    shown++;
    if (!m.options.interactive) m.options.interactive = true;

    let op, rad;
    if (mode === 'cumulative') {
      const recent = day > hiThreshold;
      op = recent ? 0.98 : 0.5;
      rad = recent ? 6.5 : 3.8;
    } else {
      const f = Math.max(0, 1 - (curDay - day) / windowDays);
      op = 0.25 + 0.72 * f;
      rad = 3.8 + 3 * f;
      trailPts.push({ ll: m.getLatLng(), color: m.options.fillColor, f });
    }
    if (m._op !== op || m._rad !== rad) { m.setStyle({ fillOpacity: op, radius: rad }); m._op = op; m._rad = rad; }
  }

  if (TRAIL) TRAIL.setData(trailPts);   // empty outside window mode → cleared
  setDateTicker(curDay);
  $('count').textContent = shown.toLocaleString() + ' shown';
  $('scrub').value = String(curDay - dayMin);
}

// =====================================================================
// time-lapse playback
// =====================================================================
function stepSize() {
  const span = Math.max(1, dayMax - dayMin);
  // full play ≈ 600 ticks at speed 5; speed scales linearly
  return Math.max(1, Math.round((span / 600) * (speed / 5)));
}

function tick() {
  curDay += stepSize();
  if (curDay >= dayMax) { curDay = dayMax; render(); pause(); return; }
  render();
}

function play() {
  if (playing) return;
  if (curDay >= dayMax) curDay = dayMin;   // replay from start
  playing = true;
  $('play').textContent = '⏸';
  $('play').setAttribute('aria-label', 'Pause');
  timer = setInterval(tick, 50);
}

function pause() {
  playing = false;
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play');
  if (timer) { clearInterval(timer); timer = null; }
}

// =====================================================================
// force-update: pull fresh observations live from the iNat API
// =====================================================================
// The site normally reads the baked JSON that fetch.py commits daily. This
// button re-fetches straight from the CORS-enabled iNat API in the browser and
// rebuilds the view in memory (it does NOT write the committed file — that's
// still the daily Action's job). Mirrors fetch.py so results match.
const INAT_API = 'https://api.inaturalist.org/v1/observations';

function compactLive(o) {
  const coords = (o.geojson && o.geojson.coordinates) || [];
  const [lng, lat] = coords.length === 2 ? coords : [null, null];
  const taxon = o.taxon || {};
  let ic = taxon.iconic_taxon_name || 'Unknown';
  if (ic === 'Reptilia') {
    for (const tid of taxon.ancestor_ids || []) {
      if (REPTILE_ORDERS[tid]) { ic = REPTILE_ORDERS[tid]; break; }
    }
  }
  const photos = o.photos || [];
  const r5 = (v) => (v == null ? null : Math.round(v * 1e5) / 1e5);
  return {
    id: o.id, d: o.observed_on || null,
    lat: r5(lat), lng: r5(lng), ic,
    ti: taxon.id != null ? taxon.id : null,
    n: taxon.name || null, c: taxon.preferred_common_name || null,
    r: taxon.rank || null, q: o.quality_grade || null,
    p: photos.length ? photos[0].url : null, pl: o.place_guess || null,
  };
}

// Cursor pagination via id_above (same as fetch.py) — avoids the 10k offset cap.
async function fetchLive(user, onProgress) {
  const records = [];
  let idAbove = 0;
  for (;;) {
    const url = `${INAT_API}?user_login=${encodeURIComponent(user)}`
      + `&per_page=200&order_by=id&order=asc&id_above=${idAbove}`;
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error('iNaturalist API HTTP ' + resp.status);
    const data = await resp.json();
    const results = data.results || [];
    if (!results.length) break;
    for (const o of results) records.push(compactLive(o));
    idAbove = results[results.length - 1].id;
    if (onProgress) onProgress(records.length, data.total_results);
    if (results.length < 200) break;
  }
  records.sort((a, b) =>
    (a.d || '0000-00-00').localeCompare(b.d || '0000-00-00') || a.id - b.id);
  return records;
}

function buildPayload(user, records) {
  const groups = {};
  for (const r of records) groups[r.ic] = (groups[r.ic] || 0) + 1;
  const sorted = {};
  Object.keys(groups).sort((a, b) => groups[b] - groups[a])
    .forEach((k) => { sorted[k] = groups[k]; });
  const dated = records.filter((r) => r.d).map((r) => r.d);
  const min = (arr) => arr.reduce((a, b) => (a < b ? a : b));
  const max = (arr) => arr.reduce((a, b) => (a > b ? a : b));
  return {
    meta: {
      user, total: records.length, groups: sorted,
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      date_min: dated.length ? min(dated) : null,
      date_max: dated.length ? max(dated) : null,
    },
    observations: records,
  };
}

let refreshing = false;
async function doRefresh() {
  if (refreshing) return;
  refreshing = true;
  pause();
  const btn = $('refresh');
  const label = btn.querySelector('.refresh-label');
  const original = label ? label.textContent : '';
  const say = (t) => { if (label) label.textContent = t; };
  btn.disabled = true;
  btn.classList.add('busy');
  try {
    say('Updating…');
    const records = await fetchLive(USER, (n, total) =>
      say(`Updating… ${n.toLocaleString()}${total ? '/' + total.toLocaleString() : ''}`));
    if (!records.length) throw new Error('no observations returned');
    applyData(buildPayload(USER, records), { fit: false });
    say('Updated ✓');
    setTimeout(() => say(original || 'Update'), 2500);
  } catch (e) {
    say('Update failed');
    if (typeof console !== 'undefined') console.error('Force-update failed:', e);
    setTimeout(() => say(original || 'Update'), 3500);
  } finally {
    btn.disabled = false;
    btn.classList.remove('busy');
    refreshing = false;
  }
}

// =====================================================================
// species gallery
// =====================================================================
function aggregateSpecies() {
  const map = new Map();
  for (const o of OBS) {
    const key = o.ti != null ? 't' + o.ti : 'n' + (o.n || o.c || o.id);
    let s = map.get(key);
    if (!s) {
      s = { ti: o.ti, n: o.n, c: o.c, ic: o.ic, r: o.r, count: 0, photo: null, last: '' };
      map.set(key, s);
    }
    s.count++;
    if (!s.photo && o.p) s.photo = o.p;
    if (o.d && o.d > s.last) s.last = o.d;
    if (!s.c && o.c) s.c = o.c;
    if (!s.n && o.n) s.n = o.n;
  }
  SPECIES = [...map.values()];
}

function buildGallery() {
  const term = ($('guide-search').value || '').trim().toLowerCase();
  const sort = $('guide-sort').value;

  let rows = SPECIES.filter((s) => GUIDE_ACTIVE.has(s.ic));
  if (term) {
    rows = rows.filter((s) =>
      (s.c && s.c.toLowerCase().includes(term)) ||
      (s.n && s.n.toLowerCase().includes(term)));
  }
  const cmp = {
    count: (a, b) => b.count - a.count || (a.c || a.n || '').localeCompare(b.c || b.n || ''),
    recent: (a, b) => (b.last || '').localeCompare(a.last || ''),
    name: (a, b) => (a.c || a.n || '~').localeCompare(b.c || b.n || '~'),
    sci: (a, b) => (a.n || '~').localeCompare(b.n || '~'),
  }[sort];
  rows.sort(cmp);

  $('guide-count').textContent = `${rows.length} taxa`;

  const gallery = $('gallery');
  if (!rows.length) { gallery.innerHTML = '<div class="empty">No species match.</div>'; return; }

  const frag = document.createDocumentFragment();
  for (const s of rows) {
    const a = document.createElement('a');
    a.className = 'card';
    a.target = '_blank';
    a.rel = 'noopener';
    a.href = s.ti != null
      ? `https://www.inaturalist.org/observations?user_id=${encodeURIComponent(USER)}&taxon_id=${s.ti}`
      : `https://www.inaturalist.org/observations?user_id=${encodeURIComponent(USER)}`;
    const img = photoAt(s.photo, 'small');
    const common = s.c || s.n || 'Unknown';
    const sci = s.n && s.c ? `<div class="cs">${esc(s.n)}</div>` : '';
    a.innerHTML = `
      ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy">`
            : '<div class="thumb"></div>'}
      <div class="card-body">
        <span class="badge" style="background:${COLORS[s.ic] || COLORS.Unknown}"></span>
        <div class="cc">${esc(common)}</div>
        ${sci}
        <div class="cn">${s.count} observation${s.count === 1 ? '' : 's'}</div>
      </div>`;
    frag.appendChild(a);
  }
  gallery.innerHTML = '';
  gallery.appendChild(frag);
}

// =====================================================================
// county map (mob-rule.com data) — lazy-loaded on first tab open
// =====================================================================
// Boundaries: us-atlas county TopoJSON (5-digit FIPS ids), same source the
// builder used to resolve mob-rule county names → FIPS, so we match FIPS→FIPS.
const COUNTY_TOPO_URL = 'https://unpkg.com/us-atlas@3/counties-10m.json';
// Diff colors for compare mode.
const CMP = { both: '#8172B3', aOnly: '#55A868', bOnly: '#DD8452' };
const UNVISITED = { fillColor: '#3a4551', fillOpacity: 0.12, color: 'rgba(255,255,255,0.10)', weight: 0.4 };
// 2-digit state FIPS → USPS (for county popups).
const STATE_ABBR = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO',
  '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI',
  '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY',
  '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN',
  '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH',
  '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD',
  '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA',
  '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP',
  '72': 'PR', '78': 'VI',
};

let COUNTY = null, CMAP = null, COUNTY_LAYER = null, countyInited = false;
const FIPS_NAME = {};   // fips → "County, ST"

async function initCounty() {
  if (countyInited) return;
  countyInited = true;
  const status = $('county-status');
  try {
    status.textContent = 'Loading county data…';
    const [cData, topo] = await Promise.all([
      fetch('data/counties.json', { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error('counties.json HTTP ' + r.status); return r.json();
      }),
      fetch(COUNTY_TOPO_URL).then((r) => {
        if (!r.ok) throw new Error('boundaries HTTP ' + r.status); return r.json();
      }),
    ]);
    COUNTY = cData;
    if (typeof topojson === 'undefined') throw new Error('topojson-client not loaded');
    const fc = topojson.feature(topo, topo.objects.counties);
    for (const f of fc.features) {
      const fips = String(f.id);
      FIPS_NAME[fips] = (f.properties.name || fips) + ', ' + (STATE_ABBR[fips.slice(0, 2)] || '??');
    }

    CMAP = L.map('cmap', { preferCanvas: true, zoomControl: true, minZoom: 3, maxZoom: 8 });
    CMAP.zoomControl.setPosition('topright');
    CMAP.setView([39, -98], 4);
    const renderer = L.canvas({ padding: 0.3 });

    COUNTY_LAYER = L.geoJSON(fc, {
      renderer,
      style: styleCounty,
      onEachFeature: (feature, layer) => {
        layer.bindPopup(() => countyPopup(String(feature.id)),
          { minWidth: 180, maxWidth: 240, closeButton: true });
      },
    }).addTo(CMAP);

    // States outline on top for geographic reference (no fill).
    L.geoJSON(topojson.feature(topo, topo.objects.states), {
      renderer, interactive: false,
      style: { fill: false, color: 'rgba(255,255,255,0.28)', weight: 0.8 },
    }).addTo(CMAP);

    buildCountyControls();
    renderCounties();
    status.classList.add('hidden');
  } catch (e) {
    countyInited = false;   // allow a retry on next tab open
    status.classList.remove('hidden');
    status.textContent = 'Could not load county map: ' + (e.message || e);
    if (typeof console !== 'undefined') console.error('County map init failed:', e);
  }
}

function buildCountyControls() {
  const users = COUNTY.meta.users;
  const userSel = $('county-user');
  const cmpSel = $('county-compare');
  userSel.innerHTML = '';
  cmpSel.innerHTML = '<option value="">— none —</option>';
  users.forEach((u) => {
    const name = (COUNTY.users[u] && COUNTY.users[u].fullname) || u;
    userSel.appendChild(new Option(name, u));
    cmpSel.appendChild(new Option(name, u));
  });
  userSel.value = users[0];
  userSel.addEventListener('change', () => {
    // Don't let primary == compare.
    if (cmpSel.value === userSel.value) cmpSel.value = '';
    renderCounties();
  });
  cmpSel.addEventListener('change', () => {
    if (cmpSel.value === userSel.value) userSel.value =
      COUNTY.meta.users.find((u) => u !== cmpSel.value) || userSel.value;
    renderCounties();
  });
}

// Which legend code (or null) a user has for a FIPS. "" and "." mean the same.
function countyCode(user, fips) {
  const c = COUNTY.users[user] && COUNTY.users[user].counties;
  return c && fips in c ? c[fips] : null;
}

function styleCounty(feature) {
  const fips = String(feature.id);
  const primary = $('county-user').value;
  const compare = $('county-compare').value;
  const base = { color: 'rgba(255,255,255,0.10)', weight: 0.4 };

  if (compare) {
    const a = countyCode(primary, fips) != null;
    const b = countyCode(compare, fips) != null;
    if (a && b) return { ...base, fillColor: CMP.both, fillOpacity: 0.85 };
    if (a) return { ...base, fillColor: CMP.aOnly, fillOpacity: 0.8 };
    if (b) return { ...base, fillColor: CMP.bOnly, fillOpacity: 0.8 };
    return UNVISITED;
  }
  const code = countyCode(primary, fips);
  if (code == null) return UNVISITED;
  const leg = COUNTY.users[primary].legend;
  const color = (leg[code] && leg[code].color) || (leg[''] && leg[''].color) || '#00FFFF';
  return { ...base, fillColor: color, fillOpacity: 0.85 };
}

function renderCounties() {
  if (COUNTY_LAYER) COUNTY_LAYER.setStyle(styleCounty);
  renderCountyLegend();
}

function renderCountyLegend() {
  const primary = $('county-user').value;
  const compare = $('county-compare').value;
  const stats = $('county-stats');
  const legend = $('county-legend');
  const nameOf = (u) => (COUNTY.users[u] && COUNTY.users[u].fullname) || u;
  const sw = (c) => `<span class="csw" style="background:${esc(c)}"></span>`;

  if (compare) {
    const A = new Set(Object.keys(COUNTY.users[primary].counties));
    const B = new Set(Object.keys(COUNTY.users[compare].counties));
    let both = 0, aOnly = 0, bOnly = 0;
    A.forEach((f) => (B.has(f) ? both++ : aOnly++));
    B.forEach((f) => { if (!A.has(f)) bOnly++; });
    stats.innerHTML =
      `<div class="cstat-row">${sw(CMP.aOnly)}<span><b>${(aOnly).toLocaleString()}</b> only ${esc(nameOf(primary))}</span></div>` +
      `<div class="cstat-row">${sw(CMP.bOnly)}<span><b>${(bOnly).toLocaleString()}</b> only ${esc(nameOf(compare))}</span></div>` +
      `<div class="cstat-row">${sw(CMP.both)}<span><b>${both.toLocaleString()}</b> both</span></div>`;
    legend.innerHTML =
      `<div class="crow"><span>${esc(nameOf(primary))}</span><span class="ccount">${A.size.toLocaleString()}</span></div>` +
      `<div class="crow"><span>${esc(nameOf(compare))}</span><span class="ccount">${B.size.toLocaleString()}</span></div>` +
      `<div class="crow"><span>Combined</span><span class="ccount">${(new Set([...A, ...B])).size.toLocaleString()}</span></div>`;
    return;
  }

  // Solo: one row per legend category the user actually uses, in mob-rule order.
  const rec = COUNTY.users[primary];
  const counts = {};
  for (const code of Object.values(rec.counties)) counts[code] = (counts[code] || 0) + 1;
  const order = rec.order || [];
  const idx = (c) => { const i = order.indexOf(c); return i < 0 ? 999 : i; };
  const codes = Object.keys(counts).sort((a, b) => idx(a) - idx(b) || a.localeCompare(b));
  stats.innerHTML = `<div class="cstat-row"><span><b>${rec.total_us.toLocaleString()}</b> counties visited</span></div>`;
  legend.innerHTML = codes.map((code) => {
    const l = rec.legend[code] || rec.legend[''] || {};
    const desc = (l.description && l.description.trim()) || 'visited';
    const color = l.color || '#00FFFF';
    return `<div class="crow">${sw(color)}<span>${esc(desc)}</span><span class="ccount">${counts[code].toLocaleString()}</span></div>`;
  }).join('');
}

function countyPopup(fips) {
  const primary = $('county-user').value;
  const compare = $('county-compare').value;
  const name = FIPS_NAME[fips] || fips;
  const sw = (c) => `<span class="csw" style="background:${esc(c)}"></span>`;
  const line = (u) => {
    const code = countyCode(u, fips);
    const nm = (COUNTY.users[u] && COUNTY.users[u].fullname) || u;
    if (code == null) return `<div class="cpop-row">${esc(nm)}: not visited</div>`;
    const l = (COUNTY.users[u].legend[code] || COUNTY.users[u].legend[''] || {});
    const desc = (l.description && l.description.trim()) || 'visited';
    return `<div class="cpop-row">${sw(l.color || '#00FFFF')}${esc(nm)}: ${esc(desc)}</div>`;
  };
  const rows = compare ? line(primary) + line(compare) : line(primary);
  return `<div class="cpop"><div class="cpop-name">${esc(name)}</div>${rows}</div>`;
}

// =====================================================================
// events / tabs
// =====================================================================
function wireEvents() {
  // tabs
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
      $('view-map').classList.toggle('active', view === 'map');
      $('view-guide').classList.toggle('active', view === 'guide');
      $('view-county').classList.toggle('active', view === 'county');
      if (view === 'map') setTimeout(() => MAP.invalidateSize(), 0);
      if (view === 'county') { initCounty().then(() => setTimeout(() => CMAP && CMAP.invalidateSize(), 0)); }
    });
  });

  // playback
  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('scrub').addEventListener('input', (e) => {
    pause();
    curDay = dayMin + Number(e.target.value);
    render();
  });
  $('speed').addEventListener('input', (e) => { speed = Number(e.target.value); });

  // mode
  const setMode = (m) => {
    mode = m;
    $('mode-cumulative').classList.toggle('active', m === 'cumulative');
    $('mode-window').classList.toggle('active', m === 'window');
    $('window-ctl').classList.toggle('hidden', m !== 'window');
    render();
  };
  $('mode-cumulative').addEventListener('click', () => setMode('cumulative'));
  $('mode-window').addEventListener('click', () => setMode('window'));
  $('window-size').addEventListener('input', (e) => {
    windowDays = Number(e.target.value);
    $('window-val').textContent = windowDays;
    if (mode === 'window') render();
  });

  // map group bulk toggles
  $('chips-all').addEventListener('click', () => setAllChips($('group-chips'), MAP_ACTIVE, true, render));
  $('chips-none').addEventListener('click', () => setAllChips($('group-chips'), MAP_ACTIVE, false, render));

  // filters panel minimize/expand
  $('filters-min').addEventListener('click', () => {
    const min = $('filters').classList.toggle('min');
    const btn = $('filters-min');
    btn.textContent = min ? '+' : '–';
    btn.setAttribute('aria-label', min ? 'Expand panel' : 'Minimize panel');
    btn.setAttribute('aria-expanded', String(!min));
  });

  // gallery controls
  $('guide-search').addEventListener('input', buildGallery);
  $('guide-sort').addEventListener('change', buildGallery);

  // force-update: live re-fetch from the iNat API
  $('refresh').addEventListener('click', doRefresh);
}

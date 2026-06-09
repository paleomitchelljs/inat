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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- state ----
let META, OBS = [], MAP, CANVAS, USER = 'mitchelljs';
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

function init(data) {
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
  initMap();
  buildMarkers();
  aggregateSpecies();
  buildGallery();
  wireEvents();
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
  CANVAS = L.canvas({ padding: 0.5 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(MAP);
}

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

function buildMarkers() {
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
  if (pts.length) MAP.fitBounds(pts, { padding: [40, 40] });
  else MAP.setView([20, 0], 2);
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
    }
    if (m._op !== op || m._rad !== rad) { m.setStyle({ fillOpacity: op, radius: rad }); m._op = op; m._rad = rad; }
  }

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
      if (view === 'map') setTimeout(() => MAP.invalidateSize(), 0);
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

  // gallery controls
  $('guide-search').addEventListener('input', buildGallery);
  $('guide-sort').addEventListener('change', buildGallery);
}

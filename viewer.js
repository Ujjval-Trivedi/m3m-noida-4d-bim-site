
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import {
  C, decode, sliceStructureAt, dominantStatus, isNotStarted, statusAt, earnedFraction, pctOf, rampFraction,
  dominantPlanState, PLAN_STATE_LABEL, buildCurves, curveAt,
  fmtCr, fmtPct, fmtInt, fmtDate, fmtDateLong, dayToISO, isoToDay,
} from './engine/model.js';
import * as P from './engine/palette.js';
import { unlockSite, openSealed } from './engine/lock.js';
import {
  groupBelongs, buildStoreyMap, makeTradeCategories, defaultStoreyRank,
  CATEGORY_LABEL,
} from './engine/mapping.js';

const $ = (id) => document.getElementById(id);


const CONFIG_URL = new URLSearchParams(location.search).get('config')
  || document.querySelector('meta[name="viewer-config"]')?.content
  || '/viewer.config.js';

async function loadConfig() {
  try {
    const mod = await import(new URL(CONFIG_URL, location.href).href);
    const cfg = mod.default;
    if (!cfg || typeof cfg !== 'object') throw new Error('it has no default export');
    if (!Array.isArray(cfg.towers) || !cfg.towers.length) throw new Error('it lists no towers');
    return cfg;
  } catch (err) {
    return { __error: err };
  }
}

const LOADED = await loadConfig();
const CONFIG = LOADED.__error ? {} : LOADED;

const TOWERS = CONFIG.towers ?? [];
const STOREY_OFFSET = CONFIG.storeyOffset ?? 0;
const STOREY_RANK = CONFIG.storeyRank ?? defaultStoreyRank;
const MODEL_URL = CONFIG.modelUrl ?? '/api/model';
const PACKS_BASE = String(CONFIG.packsBase ?? '/models').replace(/[/]+$/, '');
const REFRESH_URL = CONFIG.refreshUrl ?? null;
const ENCRYPTED = CONFIG.encrypted ?? null;
let siteKey = null;
const THEME_KEY = CONFIG.themeKey ?? 'viewer-theme';
const SPEED_KEY = CONFIG.speedKey ?? 'viewer-play-speed';
const SIDEBAR_KEY = CONFIG.sidebarKey ?? 'viewer-sidebar';
const TIMELINE_DOCK = CONFIG.timeline === 'dock';

const { categoriesForTrade, categoriesForSelection } = makeTradeCategories(CONFIG.tradeCategories);

const state = {
  model: null,
  towers: new Set(CONFIG.initialTowers?.length ? CONFIG.initialTowers : [TOWERS[0]?.id].filter(Boolean)),
  groups: new Set([CONFIG.initialGroup ?? 'RCC'].filter((g) => g !== 'ALL')), trades: new Set(),
  compare: null,
  view: 'progress',
  levels: null,
  pick: null,
  actsSort: { key: 'default', dir: 1 },
  actsQuery: '',
  actsOverdue: false,
  actsView: 'tree',
  actsToggled: new Set(),
  actsAll: null,
  actsScope: 'project',
  cut: 1, explode: 0, ghost: true, edges: false,
  day: null,
  compareStyle: CONFIG.compareLayer?.style ?? 'lines',
};
let actRows = [];
const COMPARE_ON = Boolean(CONFIG.compareLayer);
let bandInfo = null;
const STYLE_NAMES = { lines: 'Lines', band: 'Bands', both: 'Lines + bands' };
const COMPARE_STYLES = (CONFIG.compareLayer?.styles ?? ['lines', 'band']).filter((s) => STYLE_NAMES[s]);
const cmpLines = () => state.compareStyle !== 'band';
const cmpBands = () => state.compareStyle !== 'lines';

let playTimer = null;
let curves = null;
let curveKey = '';

const packs = new Map();

const MODEL_ONLY = CONFIG.actsModelOnly === true;
const modelFloors = new Map();
async function loadModelFloors() {
  await Promise.all(TOWERS.map(async (def) => {
    try {
      const manifest = packs.get(def.pack)?.manifest
        ?? await readJson(`${PACKS_BASE}/${def.pack}.json`);
      const rows = buildStoreyMap(manifest.storeys, STOREY_OFFSET, STOREY_RANK);
      const ranks = new Set();
      manifest.storeys.forEach((s, i) => {
        if (rows[i]?.rank != null && s.groups.some((g) => groupBelongs(def, g))) ranks.add(rows[i].rank);
      });
      modelFloors.set(def.id, ranks);
    } catch {  }
  }));
}
const towers = [];
let sceneRanks = null, sceneRanksKey = '';
let scene, camera, renderer, controls, root;
let labelLayer = null, labels = [];
let needsRender = true, pickDirty = false, pointerClient = null, hovered = null;
let cameraTouched = false;
const siteOrigin = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

if (LOADED.__error) needsConfig(LOADED.__error); else init();


function needsConfig(err) {
  applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  $('loaderText').textContent = 'No viewer configuration';
  const sub = $('loaderSub');
  sub.replaceChildren();
  const code = (t) => { const e = document.createElement('code'); e.textContent = t; return e; };
  const text = (t) => document.createTextNode(t);
  sub.append(
    text('Could not load '), code(CONFIG_URL), text(` - ${err.message}.`),
    document.createElement('br'), document.createElement('br'),
    text('Copy '), code('viewer-kit/web/viewer.config.example.js'),
    text(' into your project, fill it in, and serve it at '), code('/viewer.config.js'),
    text(' (or point the viewer at it with '), code('?config=<url>'), text(').'),
  );
  $('loaderSub').style.color = 'var(--text-muted)';
  $('loaderBar').style.width = '100%';
  $('loaderBar').style.background = 'var(--text-muted)';
}

function applyChrome() {
  const set = (id, text) => { const el = $(id); if (el && text) { el.textContent = text; el.hidden = false; } };
  const tab = [CONFIG.title, CONFIG.eyebrow].filter(Boolean).join(' · ');
  if (tab) document.title = tab;
  if (CONFIG.favicon) {
    const icon = document.querySelector('link[rel="icon"]') ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
    icon.href = CONFIG.favicon;
  }
  set('brandEyebrow', CONFIG.eyebrow);
  set('brandTitle', CONFIG.title);
  set('brandSub', CONFIG.subtitle);
  set('pillTag', CONFIG.tag);
  set('loaderText', CONFIG.loadingText);
  set('loaderSub', CONFIG.loadingSub);
  if (CONFIG.stageHeading === false) $('stageHead').hidden = true;
  if (TIMELINE_DOCK) {
    $('timeline').classList.add('dock');
    $('stageWrap').append($('timeline'));
  }

  const logos = (CONFIG.logos ?? []).filter((l) => l?.light);
  if (logos.length) {
    const box = $('brandLogos');
    logos.forEach((l, i) => {
      if (i) box.append(Object.assign(document.createElement('div'), { className: 'sep' }));
      for (const [variant, src] of [['lt', l.light], ['dk', l.dark ?? l.light]]) {
        const img = document.createElement('img');
        img.className = `logo ${variant}`;
        img.src = src;
        img.alt = variant === 'lt' ? (l.alt ?? '') : '';
        if (variant === 'dk') img.setAttribute('aria-hidden', 'true');
        if (l.height) img.style.setProperty('--logo-h', `${l.height}px`);
        box.append(img);
      }
    });
    box.hidden = false;
    $('brandRule').hidden = false;
    $('brandMark').hidden = true;
  }

  const back = CONFIG.backLink;
  if (back?.href) {
    const a = $('linkBack');
    a.href = back.href;
    a.textContent = back.label ?? '← Back';
    a.hidden = false;
  }
}

async function init() {
  applyChrome();
  if (!TOWERS?.length) { failLoad(new Error('viewer.config.js lists no towers')); return; }
  applyTheme(localStorage.getItem(THEME_KEY) || defaultTheme());
  try {
    setLoad('Loading schedule data…', 0.08);
    if (ENCRYPTED) {
      setLoad('Protected', 0);
      const dark = document.documentElement.dataset.theme === 'dark';
      siteKey = await unlockSite(ENCRYPTED, {
        mount: $('loaderLock'), eyebrow: CONFIG.eyebrow, title: CONFIG.title, note: ENCRYPTED.note,
        logos: (CONFIG.logos ?? []).filter((l) => l?.light).map((l) => ({ src: dark ? l.dark ?? l.light : l.light, alt: l.alt ?? '', height: l.height })),
      });
      $('loaderLock').replaceChildren();
      setLoad('Loading schedule data…', 0.08);
    }
    const raw = await readJson(MODEL_URL);
    state.model = alignTerraces(decode(raw));
    state.day = state.model.asOfDay;
    if (state.groups.size && ![...state.groups].some((g) => state.model.groupById.has(g))) {
      state.groups = new Set([state.model.groups[0]?.id].filter(Boolean));
    }
    if (MODEL_ONLY) await loadModelFloors();
  } catch (err) {
    failLoad(err);
    return;
  }

  setupScene();
  buildSidebar();
  bindChrome();
  bindRefresh();
  buildTimeline();
  $('loader').hidden = true;
  $('app').hidden = false;
  resize();

  try {
    await ensureTowers();
  } catch (err) {
    console.error(err);
  }
  requestAnimationFrame(tick);
}

function setLoad(text, frac) {
  $('loaderText').textContent = text;
  $('loaderBar').style.width = `${Math.round(frac * 100)}%`;
}
function failLoad(err) {
  $('loaderText').textContent = 'Could not load';
  $('loaderSub').textContent = err.message;
  $('loaderSub').style.color = 'var(--bad-ink)';
}


async function loadPack(def, onProgress) {
  const cached = packs.get(def.pack);
  if (cached) return cached;
  const p = (async () => {
    const manifest = await readJson(`${PACKS_BASE}/${def.pack}.json`);
    const buffer = await readData(`${PACKS_BASE}/${manifest.bin}`, onProgress, manifest.binBytes);
    return { manifest, buffer };
  })();
  packs.set(def.pack, p);
  p.catch(() => packs.delete(def.pack));
  return p;
}

async function readWithProgress(res, total, onProgress) {
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  let out = new Uint8Array(total || 1 << 20), at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > out.length) { const o = new Uint8Array(Math.max(out.length * 2, at + value.length)); o.set(out.subarray(0, at)); out = o; }
    out.set(value, at);
    at += value.length;
    if (total) onProgress?.(Math.min(1, at / total));
  }
  return out.buffer.slice(0, at);
}



async function readData(url, onProgress, total) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url.split('/').pop()} returned ${res.status}`);
  const size = ENCRYPTED ? (ENCRYPTED.sizes?.[url] ?? Number(res.headers.get('content-length'))) : total;
  const buf = await readWithProgress(res, size || total, onProgress);
  if (!ENCRYPTED) return buf;
  const plain = await openSealed(siteKey, buf);
  return plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength);
}
async function readJson(url) { return JSON.parse(new TextDecoder().decode(await readData(url))); }

let towerGen = 0;

async function ensureTowers() {
  const gen = ++towerGen;
  const wanted = TOWERS.filter((d) => state.towers.has(d.id));

  for (let i = towers.length - 1; i >= 0; i--) {
    if (!wanted.includes(towers[i].def)) {
      root.remove(towers[i].group);
      towers.splice(i, 1);
    }
  }

  $('stageEmpty').hidden = wanted.length > 0;
  $('resetView').hidden = !wanted.length;
  if (!wanted.length) {
    labelLayer.replaceChildren();
    labels = [];
    $('strip').replaceChildren();
    $('mapTable').innerHTML = '';
    $('tlRead').replaceChildren();
    $('legend').replaceChildren();
    clearActivities();
    curveKey = '';
    needsRender = true;
    return;
  }

  const missing = wanted.filter((d) => !towers.some((t) => t.def === d));
  $('busy').hidden = !missing.length;
  if (missing.length) {
    for (let k = 0; k < missing.length; k++) {
      const def = missing[k];
      $('busyText').textContent = `Loading ${def.name}…`;
      const { manifest, buffer } = await loadPack(def, (f) => {
        if (gen === towerGen) $('busyBar').style.width = `${Math.round(((k + f) / missing.length) * 100)}%`;
      });
      if (gen !== towerGen) return;
      if (!towers.some((t) => t.def === def)) addTower(def, manifest, buffer);
    }
    $('busy').hidden = true;
    $('busyBar').style.width = '0%';
  }

  towers.sort((a, b) => TOWERS.indexOf(a.def) - TOWERS.indexOf(b.def));
  curveKey = '';
  renderer.setPixelRatio(Math.min(devicePixelRatio, towers.length > 2 ? 1.25 : 1.75));
  placeSite();
  apply();
  frameCamera();
}

function addTower(def, manifest, buffer) {
  const view = (range, Ctor) => new Ctor(buffer, range[0], range[1] / Ctor.BYTES_PER_ELEMENT);
  const group = new THREE.Group();
  const storeys = [];

  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const [mi, storey] of manifest.storeys.entries()) {
    const sg = new THREE.Group();
    const meshes = [];
    for (const grp of storey.groups) {
      if (!groupBelongs(def, grp)) continue;
      for (let a = 0; a < 3; a++) {
        box.min[a] = Math.min(box.min[a], grp.box.min[a]);
        box.max[a] = Math.max(box.max[a], grp.box.max[a]);
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(view(grp.pos, Int16Array), 3));
      geom.setAttribute('normal', new THREE.BufferAttribute(view(grp.nor, Int8Array), 3, true));
      geom.setIndex(new THREE.BufferAttribute(view(grp.idx, grp.wide ? Uint32Array : Uint16Array), 1));
      const mat = new THREE.MeshLambertMaterial({ color: 0xcccccc });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.scale.setScalar(grp.step);
      mesh.position.set(grp.origin[0], grp.origin[1], grp.origin[2]);
      mesh.userData = { tower: def.id, storeyName: storey.name, cat: grp.cat, elements: grp.elements };
      sg.add(mesh);
      meshes.push({ mesh, mat, cat: grp.cat, elements: grp.elements });
    }
    if (!meshes.length) continue;
    group.add(sg);
    storeys.push({ storey, group: sg, meshes, mi });
  }
  root.add(group);
  const bbox = Number.isFinite(box.min[0]) ? box : manifest.bbox;
  towers.push({ def, manifest, group, storeys, bbox });
}

function placeSite() {
  if (!towers.length) return;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const t of towers) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], t.bbox.min[a]);
      hi[a] = Math.max(hi[a], t.bbox.max[a]);
    }
  }
  siteOrigin.set((lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2);
  root.position.set(-siteOrigin.x, -siteOrigin.y, -siteOrigin.z);

  state.height = hi[1] - lo[1];
  state.spanX = hi[0] - lo[0];
  state.spanZ = hi[2] - lo[2];
  state.siteLo = lo;
  state.siteHi = hi;
}


function setupScene() {
  const canvas = $('stage');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 8000);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.497;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.4;
  controls.addEventListener('change', () => { needsRender = true; });
  controls.addEventListener('start', () => { cameraTouched = true; });

  scene.add(new THREE.HemisphereLight(0xffffff, 0x848c94, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(80, 160, 110);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.55);
  fill.position.set(-90, 60, -80);
  scene.add(fill);

  root = new THREE.Group();
  scene.add(root);

  labelLayer = document.createElement('div');
  Object.assign(labelLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '4' });
  $('stageWrap').appendChild(labelLayer);

  new ResizeObserver(resize).observe($('stageWrap'));
  bindPointer(canvas);
  $('resetView').onclick = () => frameCamera();
}

function resize() {
  const host = $('stageWrap');
  const w = host.clientWidth || 1, h = host.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (!cameraTouched) frameCamera();
  needsRender = true;
  tidyAxis();
}

const VIEW = {
  bearing: CONFIG.view?.bearing ?? 180,
  elevation: CONFIG.view?.elevation ?? 30,
  sweep: CONFIG.view?.sweep ?? 30,
};
const VIEW_STEP = 5;
const VIEW_TOLERANCE = 0.15;
const VIEW_MARGIN_X = CONFIG.stageHeading === false ? 0.94 : 0.88;
const VIEW_MARGIN_Y = CONFIG.stageHeading === false ? 0.8 : 0.72;
const VIEW_LIFT = CONFIG.stageHeading === false ? -0.09 : -0.12;

function frameCamera() {
  if (!towers.length || !Number.isFinite(state.height)) return;
  const host = $('stageWrap');
  if (!host.clientWidth || !host.clientHeight) return;

  const boxes = towers.map((t) => {
    const lo = new THREE.Vector3(...t.bbox.min).sub(siteOrigin);
    const hi = new THREE.Vector3(...t.bbox.max).sub(siteOrigin);
    return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.Vector3(
      i & 1 ? hi.x : lo.x, i & 2 ? hi.y : lo.y, i & 4 ? hi.z : lo.z));
  });
  const all = boxes.flat();
  const vHalf = (camera.fov * Math.PI) / 360;
  const tl = $('timeline');
  const inset = TIMELINE_DOCK && tl.offsetHeight
    ? Math.min(0.4, (host.getBoundingClientRect().bottom - tl.getBoundingClientRect().top + 8) / host.clientHeight)
    : 0;
  const marginY = VIEW_MARGIN_Y * (1 - inset), lift = inset + VIEW_LIFT * (1 - inset);
  const v = new THREE.Vector3();

  const place = (target, dir, dist) => {
    camera.position.copy(dir).multiplyScalar(dist).add(target);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  };
  const rectOf = (pts) => {
    const r = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const p of pts) {
      v.copy(p).project(camera);
      r.x0 = Math.min(r.x0, v.x); r.x1 = Math.max(r.x1, v.x);
      r.y0 = Math.min(r.y0, v.y); r.y1 = Math.max(r.y1, v.y);
    }
    return r;
  };

  const fit = (dir) => {
    const target = new THREE.Vector3(0, state.height / 2, 0);
    let dist = Math.hypot(state.height, state.spanX, state.spanZ) * 1.5;
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    for (let k = 0; k < 6; k++) {
      place(target, dir, dist);
      const r = rectOf(all);
      const halfH = Math.tan(vHalf) * dist, halfW = halfH * camera.aspect;
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      target.addScaledVector(right, ((r.x0 + r.x1) / 2) * halfW);
      target.addScaledVector(up, ((r.y0 + r.y1) / 2 - lift) * halfH);
      dist *= Math.max((r.x1 - r.x0) / 2 / VIEW_MARGIN_X, (r.y1 - r.y0) / 2 / marginY);
    }
    place(target, dir, dist);
    return { target, dist };
  };

  const hidden = () => {
    const rs = boxes.map(rectOf);
    let score = 0;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (w <= 0 || h <= 0) continue;
      const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
      score += (w * h) / small;
    }
    return score;
  };

  const offsets = [0];
  for (let o = VIEW_STEP; o <= VIEW.sweep; o += VIEW_STEP) offsets.push(-o, o);
  const e = (VIEW.elevation * Math.PI) / 180;
  const tried = offsets.map((o) => {
    const b = ((VIEW.bearing + o) * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e));
    const f = fit(dir);
    return { dir, ...f, score: hidden() };
  });
  const best = Math.min(...tried.map((t) => t.score));
  const pick = tried.find((t) => t.score <= best + VIEW_TOLERANCE);
  if (!pick) return;

  place(pick.target, pick.dir, pick.dist);
  controls.target.copy(pick.target);
  const dist = pick.dist;
  controls.maxDistance = dist * 5;
  controls._sphericalDelta?.set(0, 0, 0);
  controls._panOffset?.set(0, 0, 0);
  controls.update();
  cameraTouched = false;
  needsRender = true;
}


function buildSidebar() {
  const m = state.model;

  const tc = $('towerChips');
  tc.replaceChildren();
  for (const def of TOWERS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = def.short;
    b.title = def.name;
    b.dataset.tower = def.id;
    b.title = `${def.name} - Ctrl + click to select more than one`;
    b.onclick = (e) => {
      if (CONFIG.towerSelect === 'single' && !(e.ctrlKey || e.metaKey)) {
        if (state.towers.size === 1 && state.towers.has(def.id)) return;
        state.towers = new Set([def.id]);
        afterTowerChange();
        return;
      }
      if (CONFIG.towerSelect === 'single') {
        if (state.towers.has(def.id)) state.towers.delete(def.id); else state.towers.add(def.id);
        if (!state.towers.size) state.towers = new Set(TOWERS.map((d) => d.id));
        afterTowerChange();
        return;
      }
      if (state.towers.has(def.id)) state.towers.delete(def.id);
      else state.towers.add(def.id);
      afterTowerChange();
    };
    tc.append(b);
  }

  const gc = $('groupChips');
  gc.replaceChildren();
  const all = document.createElement('button');
  all.className = 'chip chip-group';
  all.textContent = 'Overall';
  all.dataset.group = 'ALL';
  all.onclick = () => pickGroup('ALL');
  gc.append(all);
  const hidden = new Set(CONFIG.hiddenGroups ?? []);
  for (const g of m.groups) {
    if (hidden.has(g.id)) continue;
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.group = g.id;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `var(--g-${g.id})`;
    b.append(dot, document.createTextNode(g.name));
    b.title = `${g.name} - Ctrl + click to select more than one`;
    b.onclick = (e) => pickGroup(g.id, e.ctrlKey || e.metaKey);
    gc.append(b);
  }

  syncTradesToGroup();
  syncChips();
  refreshTradeList();

  document.querySelectorAll('[data-sel]').forEach((btn) => {
    btn.onclick = () => {
      const a = btn.dataset.sel;
      if (a === 'towers-all') { state.towers = new Set(TOWERS.map((d) => d.id)); afterTowerChange(); return; }
      if (a === 'towers-none') { state.towers = new Set(TOWERS.map((d) => d.id)); afterTowerChange(); return; }
      state.trades = new Set(tradesInGroup().map((t) => t.idx));
      refreshTradeList();
      apply();
    };
  });

  document.querySelectorAll('#viewChips [data-view], #paSwitch [data-view]').forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
  });
  syncViewButtons();

  refreshLevelList();
  document.querySelectorAll('[data-lvl]').forEach((btn) => {
    btn.onclick = () => {
      state.levels = null;
      refreshLevelList();
      apply();
    };
  });

  bindActivities();
}

function setView(v) {
  state.view = v;
  syncViewButtons();
  apply();
}
function syncViewButtons() {
  document.querySelectorAll('#viewChips [data-view], #paSwitch [data-view]')
    .forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.view === state.view)));
}


const cleanLevel = (name) => String(name).replace(/\s*\(.*\)\s*$/, '').replace(/\s+RS$/i, '').trim();

function levelsInView() {
  const byRank = new Map();
  for (const def of TOWERS) {
    if (!state.towers.has(def.id)) continue;
    const st = state.model.structureById.get(scheduleIdFor(def));
    if (!st) continue;
    for (const f of st.floors) {
      if (!f.isFloor) continue;
      const nm = cleanLevel(f.name);
      const cur = byRank.get(f.rank);
      if (!cur || nm.length < cur.name.length) byRank.set(f.rank, { name: nm, full: f.name.trim() });
    }
  }
  const out = [...byRank].sort((a, b) => a[0] - b[0]).map(([rank, v]) => ({ rank, ...v }));
  const seen = new Map();
  for (const lv of out) seen.set(lv.name, (seen.get(lv.name) || 0) + 1);
  for (const lv of out) if (seen.get(lv.name) > 1 && lv.full !== lv.name) lv.name = lv.full;
  return out.map(({ rank, name }) => ({ rank, name }));
}

const inLevel = (rank) => !state.levels || state.levels.has(rank);

const LEVEL_GROUPS = Array.isArray(CONFIG.levelGroups) ? CONFIG.levelGroups : null;
const levelGroupsOpen = new Set();
function groupLevels(items) {
  const groups = new Map();
  for (const lv of items) {
    const g = LEVEL_GROUPS.find((x) => x.match.test(lv.name))?.name ?? 'Other levels';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(lv);
  }
  return groups;
}

function pickLevels(ranks, items, add) {
  if (CONFIG.levelSelect === 'single' && !multiPick) {
    const same = state.levels && state.levels.size === ranks.length && ranks.every((r) => state.levels.has(r));
    if (same) return false;
    state.levels = ranks.length === items.length ? null : new Set(ranks);
  } else {
    if (!state.levels) state.levels = new Set(items.map((x) => x.rank));
    for (const r of ranks) { if (add) state.levels.add(r); else state.levels.delete(r); }
    if (state.levels.size === items.length || !state.levels.size) state.levels = null;
  }
  return true;
}

function refreshLevelList() {
  if (LEVEL_GROUPS) { refreshLevelGroups(); return; }
  const list = $('levelList');
  const items = levelsInView();
  list.replaceChildren();
  for (const lv of items) {
    const lab = document.createElement('label');
    lab.className = 'opt' + (inLevel(lv.rank) ? ' is-on' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = inLevel(lv.rank);
    cb.onchange = () => {
      if (CONFIG.levelSelect === 'single' && !multiPick) {
        if (state.levels?.size === 1 && state.levels.has(lv.rank)) { cb.checked = true; return; }
        state.levels = items.length === 1 ? null : new Set([lv.rank]);
        refreshLevelList();
        apply();
        return;
      }
      if (!state.levels) state.levels = new Set(items.map((x) => x.rank));
      if (cb.checked) state.levels.add(lv.rank); else state.levels.delete(lv.rank);
      if (state.levels.size === items.length || !state.levels.size) state.levels = null;
      refreshLevelList();
      apply();
    };
    const nm = document.createElement('span');
    nm.textContent = lv.name;
    lab.append(cb, nm);
    offModelTag(lab, lv.rank);
    list.append(lab);
  }
  noteLevels(items);
}
function offModelTag(lab, rank) {
  if (!sceneRanks?.size || (rank != null && sceneRanks.has(rank))) return;
  const tag = document.createElement('span');
  tag.className = 'cat';
  tag.textContent = 'not in model';
  tag.title = 'The 3D model has no geometry on this level. Its work still counts in the tiles and legend.';
  lab.classList.add('is-off-model');
  lab.append(tag);
}

function refreshLevelGroups() {
  const list = $('levelList');
  const items = levelsInView();
  list.replaceChildren();
  for (const [name, lvs] of groupLevels(items)) {
    const ranks = lvs.map((x) => x.rank);
    const on = ranks.filter(inLevel).length;
    const grp = document.createElement('div');
    grp.className = 'lvl-grp';
    grp.dataset.group = name;
    const open = levelGroupsOpen.has(name);

    const head = document.createElement('div');
    head.className = 'lvl-head';
    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'lvl-caret';
    caret.setAttribute('aria-expanded', String(open));
    caret.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${name}`);
    caret.textContent = '▾';
    caret.onclick = () => {
      if (levelGroupsOpen.has(name)) levelGroupsOpen.delete(name); else levelGroupsOpen.add(name);
      refreshLevelGroups();
    };
    const lab = document.createElement('label');
    lab.className = 'opt lvl-grp-opt' + (on ? ' is-on' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on === ranks.length;
    cb.indeterminate = on > 0 && on < ranks.length;
    cb.onchange = () => {
      if (!pickLevels(ranks, items, on < ranks.length)) { cb.checked = true; return; }
      refreshLevelGroups();
      apply();
    };
    const nm = document.createElement('span');
    nm.textContent = name;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = on === ranks.length ? String(ranks.length) : `${on}/${ranks.length}`;
    lab.append(cb, nm, cnt);
    if (sceneRanks?.size && !ranks.some((r) => sceneRanks.has(r))) offModelTag(lab, null);
    head.append(caret, lab);

    const body = document.createElement('div');
    body.className = 'lvl-body';
    body.hidden = !open;
    for (const lv of lvs) {
      const l = document.createElement('label');
      l.className = 'opt' + (inLevel(lv.rank) ? ' is-on' : '');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = inLevel(lv.rank);
      c.onchange = () => {
        if (!pickLevels([lv.rank], items, c.checked)) { c.checked = true; return; }
        refreshLevelGroups();
        apply();
      };
      const s = document.createElement('span');
      s.textContent = lv.name;
      l.append(c, s);
      offModelTag(l, lv.rank);
      body.append(l);
    }
    grp.append(head, body);
    list.append(grp);
  }
  noteLevels(items);
}

function noteLevels(items) {
  const on = state.levels ? items.filter((x) => state.levels.has(x.rank)).length : items.length;
  $('levelNote').textContent = `${on} of ${items.length}`;
  let picked = items.filter((x) => inLevel(x.rank)).map((x) => x.name);
  if (LEVEL_GROUPS && state.levels) {
    for (const [name, lvs] of groupLevels(items)) {
      if (lvs.length === state.levels.size && lvs.every((x) => state.levels.has(x.rank))) { picked = [name]; break; }
    }
  }
  ddSummary('level', picked, items.length, 'levels', items.map((x) => x.name));
  const clear = document.querySelector('[data-lvl="none"]');
  if (clear) clear.disabled = on === items.length;
}

function noteTrades(items) {
  const on = items.filter((t) => state.trades.has(t.idx)).length;
  $('tradeNote').textContent = `${on} of ${items.length}`;
  ddSummary('trade', items.filter((t) => state.trades.has(t.idx)).map((t) => t.name), items.length, 'activities', items.map((t) => t.name));
  const clear = document.querySelector('[data-sel="trades-none"]');
  if (clear) clear.disabled = on === items.length;
}

const scheduleIdFor = (def) => def.id;
function scheduleTop(t, structure) {
  if (!structure) return null;
  if (t.topFor === state.model) return t.top;
  let best = null;
  for (const c of structure.cells) {
    const fl = structure.floors[c[C.F]];
    if (!fl.isFloor || !categoriesForTrade(state.model.trades[c[C.T]].name)) continue;
    if (!best || fl.rank > best.rank) best = fl;
  }
  const terrace = best && structure.floors.find((f) => f.isFloor && /terrace/i.test(f.name) && f.rank > best.rank);
  t.top = best ? { rank: best.rank, name: best.name.trim(), terraceRank: terrace?.rank ?? null } : null;
  t.topFor = state.model;
  return t.top;
}

function storeyNames(node) {
  const sched = node?.data?.name;
  if (!sched) return { main: titleIfc(node?.storey?.name ?? ''), sub: '' };
  return {
    main: sched.replace(/\s*\(.*\)\s*$/, '').replace(/\s+RS$/i, '').trim(),
    sub: (sched.match(/\(([^)]*)\)\s*$/) || [, ''])[1].trim(),
  };
}

function axisShort(name) {
  return String(name)
    .replace(/^(\d+)(?:st|nd|rd|th)\s+Floor$/i, '$1F')
    .replace(/^Service\s+Floor$/i, 'Svc')
    .replace(/^Ground\s+Floor$/i, 'GF')
    .replace(/^Lower\s+Ground.*$/i, 'LGF')
    .replace(/^Terrace.*$/i, 'Terr')
    .replace(/^Basement\s*(\d+)$/i, 'B$1')
    .replace(/^(\d+)(?:st|nd|rd|th)\s+Podium$/i, 'P$1');
}

function titleIfc(n) {
  return String(n).toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/(\d+)(St|Nd|Rd|Th)\b/g, (_, d, o) => d + o.toLowerCase());
}

const towerLabel = (def) => def.name;

function tradesInGroup() {
  return tradesPresent().filter((t) => !state.groups.size || state.groups.has(t.group));
}

function tradesPresent() {
  const ids = new Set(TOWERS.filter((d) => state.towers.has(d.id)).map(scheduleIdFor));
  const present = new Set();
  for (const id of ids) {
    const st = state.model.structureById.get(id);
    if (st) for (const t of st.tradeIdxs) present.add(t);
  }
  return state.model.trades.filter((t) => present.has(t.idx));
}

function compareTrades() {
  const c = state.compare;
  if (!COMPARE_ON || !c) return [];
  const present = tradesPresent();
  return c.group ? present.filter((t) => t.group === c.group) : present.filter((t) => t.key === c.key);
}

function refreshCompareList() {
  const field = $('compareField'), sel = $('compareSel');
  if (!field || !sel || !COMPARE_ON) return;
  field.hidden = false;
  if (!COMPARE_STYLES.includes(state.compareStyle)) state.compareStyle = COMPARE_STYLES[0] ?? 'lines';
  $('compareNote').textContent = 'second activity';
  const sw = $('compareStyle');
  if (sw) {
    sw.hidden = !state.compare || COMPARE_STYLES.length < 2;
    if (sw.childElementCount !== COMPARE_STYLES.length) {
      sw.replaceChildren(...COMPARE_STYLES.map((st) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.style = st;
        b.textContent = STYLE_NAMES[st];
        b.onclick = () => { state.compareStyle = st; refreshCompareList(); apply(); };
        return b;
      }));
    }
    for (const b of sw.children) b.setAttribute('aria-pressed', String(b.dataset.style === state.compareStyle));
  }
  const hidden = new Set(CONFIG.hiddenGroups ?? []);
  const present = tradesPresent();
  const cur = !state.compare ? '' : state.compare.group ? `g:${state.compare.group}` : `t:${state.compare.key}`;
  sel.replaceChildren(new Option('None', ''));
  for (const g of state.model.groups) {
    if (hidden.has(g.id)) continue;
    const ts = present.filter((t) => t.group === g.id);
    if (!ts.length) continue;
    const og = document.createElement('optgroup');
    og.label = g.name;
    og.append(new Option(`All ${g.name}`, `g:${g.id}`));
    for (const t of ts) og.append(new Option(t.name, `t:${t.key}`));
    sel.append(og);
  }
  sel.value = cur;
  if (sel.value !== cur) { state.compare = null; sel.value = ''; }
  sel.onchange = () => {
    const v = sel.value;
    state.compare = !v ? null : v.startsWith('g:') ? { group: v.slice(2) } : { key: v.slice(2) };
    refreshCompareList();
    apply();
  };
}

function syncTradesToGroup() { state.trades = new Set(tradesInGroup().map((t) => t.idx)); }
function pickGroup(g, add = false) {
  if (g === 'ALL') state.groups = new Set();
  else if (!add) {
    if (state.groups.size === 1 && state.groups.has(g)) return;
    state.groups = new Set([g]);
  } else if (state.groups.has(g)) state.groups.delete(g);
  else state.groups.add(g);
  state.pick = null; syncTradesToGroup(); syncChips(); refreshTradeList(); apply();
}

function alignTerraces(m) {
  const isTerrace = (f) => f.isFloor && /^terrace\b/i.test(f.name);
  const ranks = TOWERS.map((d) => m.structureById.get(scheduleIdFor(d))?.floors.find(isTerrace)?.rank).filter((r) => r != null);
  if (!ranks.length) return m;
  const top = Math.max(...ranks);
  for (const d of TOWERS) {
    const st = m.structureById.get(scheduleIdFor(d));
    const t = st?.floors.find(isTerrace);
    if (t && t.rank !== top && !st.floors.some((f) => f !== t && f.rank === top)) t.rank = top;
  }
  return m;
}

async function afterTowerChange() {
  refreshLevelList();
  if (state.levels) {
    const have = new Set(levelsInView().map((x) => x.rank));
    const kept = [...state.levels].filter((r) => have.has(r));
    state.levels = kept.length && kept.length < have.size ? new Set(kept) : null;
    refreshLevelList();
  }
  state.pick = null;
  const valid = new Set(tradesInGroup().map((t) => t.idx));
  const wasAll = listedTrades.length > 0 && listedTrades.every((t) => state.trades.has(t));
  const kept = [...state.trades].filter((t) => valid.has(t));
  state.trades = new Set(wasAll || !kept.length ? valid : kept);
  syncChips();
  refreshTradeList();
  await ensureTowers();
}

function syncChips() {
  document.querySelectorAll('[data-tower]').forEach((b) => b.setAttribute('aria-pressed', String(state.towers.has(b.dataset.tower))));
  document.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === 'ALL' ? !state.groups.size : state.groups.has(b.dataset.group))));
  $('towerNote').textContent = `${state.towers.size} of ${TOWERS.length}`;
  const clear = document.querySelector('[data-sel="towers-none"]');
  if (clear) clear.disabled = state.towers.size === TOWERS.length;
}

let listedTrades = [];
function refreshTradeList() {
  refreshCompareList();
  const list = $('tradeList');
  const items = tradesInGroup();
  listedTrades = items.map((t) => t.idx);
  list.replaceChildren();
  for (const t of items) {
    const cats = categoriesForTrade(t.name);
    const lab = document.createElement('label');
    lab.className = 'opt' + (state.trades.has(t.idx) ? ' is-on' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.trades.has(t.idx);
    cb.onchange = () => {
      if (CONFIG.tradeSelect === 'single' && !multiPick) {
        if (state.trades.size === 1 && state.trades.has(t.idx)) { cb.checked = true; return; }
        state.trades = new Set([t.idx]);
        refreshTradeList();
        apply();
        return;
      }
      if (cb.checked) state.trades.add(t.idx); else state.trades.delete(t.idx);
      if (!items.some((x) => state.trades.has(x.idx))) state.trades = new Set(items.map((x) => x.idx));
      refreshTradeList();
      apply();
    };
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = `var(--g-${t.group})`;
    const nm = document.createElement('span');
    nm.textContent = t.name;
    nm.title = t.key;
    const cat = document.createElement('span');
    cat.className = 'cat';
    cat.textContent = cats ? cats.join('+') : '—';
    cat.title = cats ? `Modelled as ${cats.map((c) => CATEGORY_LABEL[c] || c).join(', ')}` : 'Not present in a structural model';
    lab.append(cb, sw, nm, cat);
    list.append(lab);
  }
  noteTrades(items);
}


const DD_KEYS = ['level', 'trade'];

let multiPick = false;

function ddSummary(key, names, total, noun, allNames) {
  const el = $(`${key}Summary`);
  if (!el) return;
  const left = allNames ? allNames.filter((n) => !names.includes(n)) : [];
  el.textContent = names.length === total ? `All ${noun}`
    : !names.length ? `No ${noun} selected`
    : names.length <= 2 ? names.join(', ')
    : left.length && left.length <= 2 ? `All except ${left.join(', ')}`
    : `${names.length} of ${total} ${noun}`;
  $(`${key}Btn`).title = names.length === total || !names.length ? '' : names.join(', ');
  ddFilter(key);
}

function ddFilter(key) {
  const panel = $(`${key}Panel`);
  if (!panel) return;
  const q = panel.querySelector('.dd-search').value.trim().toLowerCase();
  panel.querySelectorAll('.opt').forEach((o) => { o.hidden = Boolean(q) && !o.textContent.toLowerCase().includes(q); });
  panel.querySelectorAll('.lvl-grp').forEach((g) => {
    const body = g.querySelector('.lvl-body');
    const head = g.querySelector('.lvl-grp-opt');
    if (!q) { g.hidden = false; head.hidden = false; body.hidden = !levelGroupsOpen.has(g.dataset.group); return; }
    const nameHit = g.dataset.group.toLowerCase().includes(q);
    if (nameHit) body.querySelectorAll('.opt').forEach((o) => { o.hidden = false; });
    const any = nameHit || [...body.querySelectorAll('.opt')].some((o) => !o.hidden);
    head.hidden = false;
    g.hidden = !any;
    body.hidden = !any;
  });
}

function ddPlace(key) {
  const btn = $(`${key}Btn`), panel = $(`${key}Panel`);
  const r = btn.getBoundingClientRect();
  const width = Math.max(r.width, 260);
  const below = innerHeight - r.bottom - 12, above = r.top - 12;
  panel.style.width = `${width}px`;
  panel.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  if (below >= 260 || below >= above) {
    panel.style.top = `${r.bottom + 6}px`; panel.style.bottom = '';
    panel.style.maxHeight = `${Math.min(420, below)}px`;
  } else {
    panel.style.bottom = `${innerHeight - r.top + 6}px`; panel.style.top = '';
    panel.style.maxHeight = `${Math.min(420, above)}px`;
  }
}

function ddClose() {
  for (const key of DD_KEYS) {
    const panel = $(`${key}Panel`);
    if (!panel || panel.hidden) continue;
    panel.hidden = true;
    $(`${key}Btn`).setAttribute('aria-expanded', 'false');
  }
}

function bindDropdowns() {
  for (const key of DD_KEYS) {
    const btn = $(`${key}Btn`), panel = $(`${key}Panel`);
    if (!btn || !panel) continue;
    document.body.append(panel);
    const list = panel.querySelector('.listbox');
    const note = (e) => { multiPick = e.ctrlKey || e.metaKey; };
    list.addEventListener('pointerdown', note, true);
    list.addEventListener('keydown', note, true);
    const search = panel.querySelector('.dd-search');
    search.oninput = () => ddFilter(key);
    btn.onclick = () => {
      const open = panel.hidden;
      ddClose();
      if (!open) return;
      search.value = '';
      ddFilter(key);
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      ddPlace(key);
      search.focus({ preventScroll: true });
    };
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('.dd-panel, .dd-btn')) ddClose();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = DD_KEYS.find((k) => $(`${k}Panel`) && !$(`${k}Panel`).hidden);
    if (!open) return;
    ddClose();
    $(`${open}Btn`).focus();
  });
  addEventListener('resize', () => {
    for (const k of DD_KEYS) if ($(`${k}Panel`) && !$(`${k}Panel`).hidden) ddPlace(k);
  });
  $('sidebar').addEventListener('scroll', ddClose, { passive: true });
}

function bindSidebarToggle() {
  const btns = [$('sidebarToggle'), $('sidebarEdge')];
  const narrow = matchMedia('(max-width: 900px)');
  const sync = () => {
    const shown = narrow.matches ? $('sidebar').classList.contains('open') : !$('app').classList.contains('side-closed');
    const label = shown ? 'Hide filters' : 'Show filters';
    for (const btn of btns) {
      btn.setAttribute('aria-expanded', String(shown));
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  };
  try { if (localStorage.getItem(SIDEBAR_KEY) === 'closed') $('app').classList.add('side-closed'); } catch {  }
  const toggle = () => {
    ddClose();
    if (narrow.matches) {
      $('sidebar').classList.toggle('open');
    } else {
      const closed = $('app').classList.toggle('side-closed');
      try { localStorage.setItem(SIDEBAR_KEY, closed ? 'closed' : 'open'); } catch {  }
    }
    sync();
  };
  for (const btn of btns) btn.onclick = toggle;
  narrow.addEventListener('change', sync);
  sync();
}

function bindChrome() {
  bindDropdowns();
  $('themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
    apply();
  };
  bindSidebarToggle();
  $('cut').oninput = (e) => { state.cut = Number(e.target.value) / 100; apply(); };
  $('explode').oninput = (e) => { state.explode = Number(e.target.value); apply(); };
  $('ghost').onchange = (e) => {
    state.ghost = e.target.checked;
    $('ghostKey').hidden = !state.ghost;
    $('ghostNote').textContent = state.ghost
      ? 'Grey parts are built by trades you have not selected, kept faint so the building stays whole. Untick to hide them.'
      : 'Parts built by trades you have not selected are hidden, so only your selection shows. Tick to see them faintly in grey.';
    apply();
  };
}

function defaultTheme() {
  if (CONFIG.defaultTheme === 'light' || CONFIG.defaultTheme === 'dark') return CONFIG.defaultTheme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  P.setMode(t);
  if (renderer) renderer.setClearColor(new THREE.Color(P.surface()), 1);
}


const ago = (sec) => sec < 90 ? 'just now'
  : sec < 3600 ? `${Math.round(sec / 60)} min ago`
  : sec < 86400 ? `${Math.round(sec / 3600)} h ago`
  : `${Math.round(sec / 86400)} d ago`;

let refreshing = false;
let refreshNote = null;

const AUTO_UPDATE = !REFRESH_URL ? CONFIG.autoUpdate ?? null : null;

function paintRefresh() {
  const b = $('refreshBtn');
  if ((!REFRESH_URL && !AUTO_UPDATE) || refreshing) return;
  if (refreshNote && Date.now() < refreshNote.until) return;
  refreshNote = null;
  delete b.dataset.tone;
  const t = Date.parse(state.model?.generatedAt ?? '');
  $('refreshLabel').textContent = Number.isFinite(t)
    ? `Updated ${ago(Math.max(0, (Date.now() - t) / 1000))}` : 'Refresh';
  b.title = AUTO_UPDATE
    ? `Data as of ${Number.isFinite(t) ? new Date(t).toLocaleString() : 'the last refresh'}. ${AUTO_UPDATE}.`
    : Number.isFinite(t)
      ? `Data as of ${new Date(t).toLocaleString()}. Click to fetch the latest progress.`
      : 'Fetch the latest progress from the schedule';
}

function noteRefresh(label, title, tone) {
  const b = $('refreshBtn');
  refreshNote = { until: Date.now() + 6000 };
  $('refreshLabel').textContent = label;
  b.title = title;
  if (tone) b.dataset.tone = tone; else delete b.dataset.tone;
  setTimeout(paintRefresh, 6100);
}

function bindRefresh() {
  if (!REFRESH_URL && !AUTO_UPDATE) return;
  const b = $('refreshBtn');
  b.hidden = false;
  paintRefresh();
  setInterval(paintRefresh, 60000);
  if (AUTO_UPDATE) {
    b.onclick = () => noteRefresh('Updates automatically', `${AUTO_UPDATE}.`);
    return;
  }
  b.onclick = async () => {
    if (refreshing) return;
    refreshing = true;
    b.dataset.busy = '1';
    b.disabled = true;
    $('refreshLabel').textContent = 'Refreshing…';
    let note = null;
    try {
      const res = await fetch(REFRESH_URL, { method: 'POST', headers: { accept: 'application/json' } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.error || `refresh returned ${res.status}`);
      if (j.skipped) {
        const m = Math.max(1, Math.ceil((j.remainingSeconds ?? 0) / 60));
        note = ['Up to date', `Refreshed recently. The next refresh is available in ${m} min.`];
      } else {
        const r = await fetch(MODEL_URL, { cache: 'reload', headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(`schedule API returned ${r.status}`);
        adoptModel(await r.json());
      }
    } catch (err) {
      console.error('[refresh]', err);
      note = ['Refresh failed', `Could not refresh (${err.message}). Showing the last good data.`, 'bad'];
    } finally {
      refreshing = false;
      delete b.dataset.busy;
      b.disabled = false;
    }
    if (note) noteRefresh(...note); else paintRefresh();
  };
}

function adoptModel(raw) {
  stopPlay();
  const prev = state.model;
  const onToday = state.day === prev.asOfDay;
  const keys = new Set(prev.trades.filter((t) => state.trades.has(t.idx)).map((t) => t.key));
  state.model = alignTerraces(decode(raw));
  state.pick = null;
  for (const g of [...state.groups]) if (!state.model.groupById.has(g)) state.groups.delete(g);
  buildSidebar();
  const kept = tradesInGroup().filter((t) => keys.has(t.key));
  if (kept.length) state.trades = new Set(kept.map((t) => t.idx));
  refreshTradeList();
  curves = null;
  curveKey = '';
  state.day = onToday ? state.model.asOfDay : clampDay(state.day);
  buildTimeline();
  setDay(state.day);
}


function apply() {
  document.querySelectorAll('input[type=range]').forEach(syncRange);
  if (!towers.length || !state.siteLo) return;
  const m = state.model;
  renderer.setClearColor(new THREE.Color(P.surface()), 1);

  const allTrades = m.trades.filter((t) => state.trades.has(t.idx));
  const bandTrades = compareTrades();
  const bandSet = new Set(bandTrades.map((t) => t.idx));
  const rest = allTrades.filter((t) => !bandSet.has(t.idx));
  const selTrades = bandTrades.length && rest.length ? rest : allTrades;
  bandInfo = bandTrades.length && rest.length ? {
    name: tradeSetName(bandTrades), color: cssVar('--cmp-b', '#c2338f'),
    baseName: state.groups.size ? tradeSetName(selTrades) : 'All trades',
    baseColor: cssVar('--cmp-a', '#2a78d6'),
  } : null;
  const { modelled } = categoriesForSelection(selTrades);

  const ck = `${[...state.towers].sort().join()}|${[...state.trades].sort((a, b) => a - b).join()}`;
  if (ck !== curveKey) {
    const structs = towers.map((t) => m.structureById.get(scheduleIdFor(t.def))).filter(Boolean);
    curves = buildCurves(structs, state.trades, m.dayMin, m.dayMax, m.asOfDay);
    curveKey = ck;
  }
  const catTrades = new Map();
  for (const t of selTrades) {
    for (const c of categoriesForTrade(t.name) || []) {
      if (!catTrades.has(c)) catTrades.set(c, []);
      catTrades.get(c).push(t);
    }
  }

  const cutY = state.siteLo[1] + state.height * state.cut;
  const explodeStep = (state.explode / 100) * 7;

  const totals = { budget: 0, earned: 0, pv: 0, n: 0, done: 0, active: 0 };
  let totalStoreys = 0;
  const perTower = [];

  for (const t of towers) {
    if (!state.towers.has(t.def.id)) continue;
    const structure = m.structureById.get(scheduleIdFor(t.def));
    const slice = structure
      ? sliceStructureAt(structure, state.trades, state.day, m.asOfDay, m.aopHorizon)
      : null;
    const byRank = new Map((slice?.rows ?? []).filter((r) => r.n > 0).map((r) => [r.rank, r]));
    const bandSlice = bandInfo && structure ? sliceStructureAt(structure, bandSet, state.day, m.asOfDay, m.aopHorizon) : null;
    const bandByRank = new Map((bandSlice?.rows ?? []).filter((r) => r.n > 0).map((r) => [r.rank, r]));
    const mapRows = buildStoreyMap(t.manifest.storeys, STOREY_OFFSET, STOREY_RANK);
    const label = towerLabel(t.def);
    const top = scheduleTop(t, structure);

    let tMatched = 0;
    t.storeys.forEach((node, i) => {
      let rank = mapRows[node.mi ?? i]?.rank;
      const beyond = Boolean(top) && (rank == null || rank > top.rank);
      if (beyond) rank = i === t.storeys.length - 1 && top.terraceRank != null ? top.terraceRank : null;
      if (beyond && rank != null) modelFloors.get(t.def.id)?.add(rank);
      node.beyond = beyond && rank == null;
      const data = rank == null ? null : byRank.get(rank);
      node.rank = rank;
      node.data = data;
      if (data) tMatched++;

      const names = storeyNames(node);
      node.names = names;
      node.group.visible = node.storey.elevation <= cutY + 0.01;
      node.group.position.y = explodeStep * i;
      const levelOn = !state.levels || (rank != null && state.levels.has(rank));
      if (data && !data.planned) data.planned = plannedMix(structure, data.trades.values(), state.day);

      for (const mp of node.meshes) {
        const catTr = catTrades.get(mp.cat);
        const inTrade = (!modelled || Boolean(catTr)) && levelOn;
        const catData = !data ? null : (catTr ? aggregateTrades(data, catTr, structure) : (modelled ? null : data));
        mp.data = catData;
        const u = mp.mesh.userData;
        u.catData = catData;
        u.floorData = data;
        u.tradeNames = catData?.used ?? (catTr || []).map((x) => x.name);
        u.floorMain = names.main;
        u.floorSub = names.sub;
        u.towerName = label;
        u.towerId = t.def.id;
        u.rank = rank;
        u.tradeIdxs = catTr ? catTr.map((x) => x.idx) : modelled ? [] : [...state.trades];
        u.scheduleTop = top?.name ?? '';
        u.why = node.beyond ? 'beyond' : !levelOn ? 'level-off' : catTr ? null : modelled ? 'none-selected' : 'not-modelled';

        const { color, opacity } = colorFor(catData, mp.cat, inTrade);
        mp.mat.color.set(color);
        if (mp.mat.opacity !== opacity) {
          mp.mat.opacity = opacity;
          mp.mat.transparent = opacity < 1;
          mp.mat.depthWrite = opacity > 0.75;
          mp.mat.needsUpdate = true;
        }
        mp.mesh.visible = state.ghost ? true : inTrade;
        toggleEdges(mp);
      }
      const bandRow = bandInfo && levelOn && rank != null ? bandByRank.get(rank) : null;
      setBand(node, cmpBands() && bandRow ? aggregateTrades(bandRow, bandTrades, structure) : null);
    });

    totalStoreys += t.storeys.length;
    if (slice) {
      const tt = state.levels ? levelTotals(slice) : slice.totals;
      totals.budget += tt.budget; totals.earned += tt.earned; totals.pv += tt.pv;
      totals.n += tt.n; totals.done += tt.done; totals.active += tt.active;
      const fronts = bandInfo ? {
        base: { name: bandInfo.baseName, ...frontOf(slice, selTrades, structure) },
        band: { name: bandInfo.name, ...frontOf(bandSlice, bandTrades, structure) },
      } : null;
      placeFrontLines(t, fronts);
      perTower.push({ def: t.def, label, slice, tot: tt, matched: tMatched, storeys: t.storeys.length, bbox: t.bbox, fronts });
    }
  }

  actRows = buildActivities();
  buildLabels(perTower);
  const ranksNow = new Set();
  for (const t of towers) {
    if (!state.towers.has(t.def.id)) continue;
    for (const node of t.storeys) if (node.rank != null && !node.beyond) ranksNow.add(node.rank);
  }
  const rk = [...ranksNow].sort((a, b) => a - b).join();
  if (rk !== sceneRanksKey) { sceneRanks = ranksNow; sceneRanksKey = rk; refreshLevelList(); }
  const offOnly = Boolean(state.levels?.size) && sceneRanks.size > 0 && ![...state.levels].some((r) => sceneRanks.has(r));
  $('stageNote').hidden = !offOnly;

  renderLegend(modelled);
  renderStrip(totals);
  renderTimelineRead(totals);
  renderTowerTable(perTower);
  if (!playTimer) renderActivities();

  const where = perTower.length === 1 ? `${perTower[0].label} — structural model` : `${perTower.length} towers on the real site`;
  $('stageTitle').textContent = state.view === 'planned' ? 'Planned progress'
    : state.view === 'actual' ? 'Actual progress' : where;
  const gname = !state.groups.size ? 'all trades' : m.groups.filter((g) => state.groups.has(g.id)).map((g) => g.name).join(' + ');
  const when = state.day === m.asOfDay ? ''
    : isForecast() ? ` · projected to ${fmtDateLong(state.day)}`
    : ` · as at ${fmtDateLong(state.day)}`;
  const towersPart = state.view === 'planned' || state.view === 'actual'
    ? `${perTower.length === 1 ? perTower[0].label : `${perTower.length} towers`} · ` : '';
  $('stageSub').textContent =
    `${towersPart}${fmtInt(totalStoreys)} storeys · ${state.trades.size} activit${state.trades.size === 1 ? 'y' : 'ies'} of ${gname}${when} · ` +
    (modelled ? `coloured by ${VIEW_LABEL[state.view] ?? 'progress'}` : 'no geometry for this trade — the structure is the floor canvas');
  $('cutVal').textContent = state.cut >= 1 ? 'full height' : `${cutY.toFixed(0)} m`;
  $('explodeVal').textContent = state.explode ? `${state.explode}%` : 'off';

  needsRender = true;
}


function tradeSetName(trades) {
  const clean = (n) => n.split(',')[0].replace(/\s+works?$/i, '').trim();
  if (trades.length <= 2) return trades.map((t) => clean(t.name)).join(' + ');
  const ids = [...new Set(trades.map((t) => t.group))];
  return ids.map((id) => state.model.groupById.get(id)?.name ?? id).join(' + ');
}

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function frontOf(slice, trades, structure) {
  let done = null, started = null;
  const rows = [...(slice?.storeys ?? [])].sort((a, b) => a.rank - b.rank);
  for (const r of rows) {
    const a = aggregateTrades(r, trades, structure);
    if (!a.n) continue;
    if (a.done === a.n) done = r;
    if (a.done > 0 || a.active > 0) started = r;
  }
  const nm = (r) => (r ? axisShort(String(r.name).replace(/\s*\(.*\)\s*$/, '').replace(/\s+RS$/i, '').trim()) : null);
  return {
    done: nm(done), started: started && started !== done && (!done || started.rank > done.rank) ? nm(started) : null,
    doneRank: done?.rank ?? null, startedRank: started?.rank ?? null,
  };
}

function setBand(node, agg) {
  let state_ = !agg || !agg.n ? null : agg.done === agg.n ? 'done' : agg.done > 0 || agg.active > 0 ? 'started' : null;
  const light = state.compareStyle === 'both';
  if (light && state_ === 'started') state_ = null;
  if (!state_) { if (node.band) node.band.visible = false; return; }
  if (!node.band) node.band = buildBand(node);
  if (!node.band) return;
  const b = node.band;
  b.visible = true;
  b.userData.skin.material.color.set(bandInfo.color);
  b.userData.skin.material.opacity = light ? 0.26 : state_ === 'done' ? 0.5 : 0.16;
  b.userData.rim.material.color.set(bandInfo.color);
  b.userData.rim.material.opacity = light ? 0.6 : state_ === 'done' ? 0.95 : 0.45;
}

function floorShape(node) {
  if (node.shape !== undefined) return node.shape;
  const seen = new Set(), pts = [];
  let y0 = Infinity, y1 = -Infinity;
  for (const { mesh } of node.meshes) {
    const pos = mesh.geometry.attributes.position, s = mesh.scale.x, o = mesh.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) * s + o.x, y = pos.getY(i) * s + o.y, z = pos.getZ(i) * s + o.z;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const k = `${Math.round(x * 2)},${Math.round(z * 2)}`;
      if (!seen.has(k)) { seen.add(k); pts.push([x, z]); }
    }
  }
  const hull = pts.length >= 3 && y1 > y0 ? convexHull(pts) : [];
  if (hull.length < 3) { node.shape = null; return null; }
  const cx = hull.reduce((a, p) => a + p[0], 0) / hull.length, cz = hull.reduce((a, p) => a + p[1], 0) / hull.length;
  const grow = (out) => hull.map(([x, z]) => { const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz) || 1; return [x + (dx / d) * out, z + (dz / d) * out]; });
  node.shape = { grow, y0, y1 };
  return node.shape;
}

function ringStrip(ring, lo, hi) {
  const tri = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    tri.push(ax, lo, az, bx, lo, bz, bx, hi, bz, ax, lo, az, bx, hi, bz, ax, hi, az);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
  return g;
}

function placeFrontLines(t, fronts) {
  for (const b of t.frontBelts ?? []) { b.parent?.remove(b); b.geometry.dispose(); b.material.dispose(); }
  t.frontBelts = [];
  t.frontTags = [];
  if (!fronts || !cmpLines()) return;
  const nodes = t.storeys.filter((n) => n.rank != null && !n.beyond).sort((a, b) => a.rank - b.rank);
  if (!nodes.length) return;
  const put = (f, color) => {
    const rank = f.doneRank ?? f.startedRank;
    const below = rank == null || rank < nodes[0].rank;
    const above = !below && rank > nodes.at(-1).rank;
    const node = below ? nodes[0] : above ? nodes.at(-1) : nodes.filter((n) => n.rank <= rank).at(-1);
    const shape = floorShape(node);
    if (!shape) return;
    const y = below ? shape.y0 : shape.y1;
    const ring = shape.grow(1.0);
    if (!below) {
      const belt = new THREE.Mesh(ringStrip(ring, y - 0.7, y + 0.7), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      node.group.add(belt);
      t.frontBelts.push(belt);
    }
    const where = f.done ?? (f.started ? `${f.started} started` : 'not begun');
    t.frontTags.push({ text: `${t.def.short} · ${f.name} ${where}${below && rank != null ? ' ↓' : ''}`, color, node, ring, y });
  };
  put(fronts.base, bandInfo.baseColor);
  put(fronts.band, bandInfo.color);
}

function buildBand(node) {
  const shape = floorShape(node);
  if (!shape) return null;
  const { y0, y1 } = shape;
  const ring = shape.grow(0.6);
  const lo = y0 + 0.25, hi = Math.max(lo + 0.5, y1 - 0.25);
  const g = ringStrip(ring, lo, hi);
  const skin = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  const line = [];
  for (const y of [lo, hi]) for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    line.push(ax, y, az, bx, y, bz);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
  const rim = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
  const band = new THREE.Group();
  band.add(skin, rim);
  band.renderOrder = 2;
  band.userData = { skin, rim };
  node.group.add(band);
  return band;
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function aggregateTrades(row, trades, structure) {
  let n = 0, done = 0, active = 0, budget = 0, earned = 0, pv = 0, pctSum = 0;
  const used = [];
  const status = new Map();
  const planState = new Map();
  const baseState = new Map();
  const merge = (into, from) => { if (from) for (const [k, v] of from) into.set(k, (into.get(k) || 0) + v); };
  const cells = [];
  for (const t of trades) {
    const c = row.trades.get(t.idx);
    if (!c) continue;
    used.push(t.name);
    cells.push(c);
    merge(status, c.status);
    merge(planState, c.planState);
    merge(baseState, c.baseState);
    n += c[C.N]; done += c[C.DONE]; active += c[C.ACT];
    budget += c[C.BC]; earned += c[C.EV]; pv += c[C.PV]; pctSum += c[C.PS];
  }
  return {
    name: row.name, short: row.short, rank: row.rank, used, status, planState, baseState,
    planned: structure ? plannedMix(structure, cells, state.day) : new Map(),
    n, done, active, budget, earned, pv,
    pct: budget > 0 ? (earned / budget) * 100 : n > 0 ? pctSum / n : 0,
    planPct: budget > 0 ? (pv / budget) * 100 : null,
  };
}


const NO_PLAN = 'No planned dates';

function plannedStatusAt(ps, pe, day) {
  if (pe >= 0 && day > pe) return 'Complete';
  if (ps >= 0 && pe >= 0 && day >= ps) return 'Started';
  if (ps >= 0 && day < ps) return 'Not Ready';
  return NO_PLAN;
}

function plannedMix(structure, cells, day) {
  const T = structure.tasks, mix = new Map();
  if (!T) return mix;
  for (const c of cells) {
    for (let k = c[C.TOFF], end = c[C.TOFF] + c[C.TN]; k < end; k++) {
      const s = plannedStatusAt(T.ps[k], T.pe[k], day);
      mix.set(s, (mix.get(s) || 0) + 1);
    }
  }
  return mix;
}

const PLANNED_ORDER = ['Not Ready', 'Started', 'Complete', NO_PLAN];
function dominantPlanned(mix) {
  let best = null, n = 0;
  for (const k of PLANNED_ORDER) { const v = mix?.get(k) || 0; if (k !== NO_PLAN && v > n) { best = k; n = v; } }
  return best;
}

function levelTotals(slice) {
  const a = { budget: 0, earned: 0, pv: 0, n: 0, done: 0, active: 0, pctSum: 0 };
  for (const r of slice.rows) {
    if (!state.levels?.has(r.rank)) continue;
    a.budget += r.budget; a.earned += r.earned; a.pv += r.pv;
    a.n += r.n; a.done += r.done; a.active += r.active; a.pctSum += r.pctSum;
  }
  return { ...a, pct: pctOf(a) };
}

const VIEW_LABEL = {
  progress: 'work done',
  status: 'work done',
  actual: 'VisiLean status',
  planned: 'planned status (from planned dates)',
  plan: 'plan vs actual',
  baseline: 'baseline vs actual',
};

function isForecast() { return state.day > state.model.asOfDay; }

function isStatusView() { return state.view === 'progress' || state.view === 'status'; }

function colorFor(data, cat, inTrade) {
  const ghosted = P.getMode() === 'dark' ? '#2b333b' : '#d5dbe0';
  if (!inTrade) return { color: ghosted, opacity: state.ghost ? 0.14 : 1 };
  if (!data) return { color: ghosted, opacity: 1 };
  if (state.view === 'plan' || state.view === 'baseline') {
    const st = dominantPlanState(state.view === 'plan' ? data.planState : data.baseState);
    return { color: st ? P.planStateColor(st) : ghosted, opacity: 1 };
  }
  if (state.view === 'planned') {
    const st = dominantPlanned(data.planned);
    return { color: st ? P.taskStatusColor(st) : ghosted, opacity: 1 };
  }
  if (state.view === 'actual') {
    const st = dominantStatus(data.status);
    return { color: st ? P.taskStatusColor(st) : ghosted, opacity: 1 };
  }
  const st = dominantStatus(data.status);
  if (!st || isNotStarted(st)) return { color: P.statusColor('none'), opacity: 1 };
  return { color: P.taskStatusColor(st), opacity: 1 };
}

function toggleEdges(mp) {
  if (state.edges && !mp.edge) {
    const e = new THREE.LineSegments(
      new THREE.EdgesGeometry(mp.mesh.geometry, 45),
      new THREE.LineBasicMaterial({ color: new THREE.Color(P.gridInk()), transparent: true, opacity: 0.35 }),
    );
    e.scale.copy(mp.mesh.scale);
    e.position.copy(mp.mesh.position);
    mp.mesh.parent.add(e);
    mp.edge = e;
  }
  if (mp.edge) {
    mp.edge.visible = state.edges && mp.mesh.visible;
    if (state.edges) mp.edge.material.color.set(P.gridInk());
  }
}


function buildLabels(perTower) {
  labelLayer.replaceChildren();
  labels = [];
  if (!towers.length) return;

  const ref = towers.reduce((a, t) => (t.storeys.length > a.storeys.length ? t : a), towers[0]);
  const n = ref.storeys.length;
  const step = Math.max(1, Math.round(n / 11));
  ref.storeys.forEach((node, i) => {
    if (i !== 0 && i !== n - 1 && i % step !== 0) return;
    const el = document.createElement('div');
    el.className = 'l3d l3d-axis';
    el.innerHTML = `<b>${esc(axisShort((node.names?.main) || titleIfc(node.storey.name)))}</b>`;
    labelLayer.appendChild(el);
    labels.push({ el, kind: 'axis', node });
  });

  for (const t of towers) {
    if (!state.towers.has(t.def.id)) continue;
    for (const tag of t.frontTags ?? []) {
      const el = document.createElement('div');
      el.className = 'l3d l3d-front';
      el.style.setProperty('--c', tag.color);
      el.textContent = tag.text;
      labelLayer.appendChild(el);
      labels.push({ el, kind: 'front', ...tag });
    }
  }

  for (const p of perTower) {
    const el = document.createElement('div');
    el.className = 'l3d l3d-caption';
    const tot = p.tot ?? p.slice.totals;
    el.innerHTML = `<b>${esc(p.label)}</b><i>${fmtPct(tot.pct)}<span class="cr"> · ₹${fmtCr(tot.earned)}/${fmtCr(tot.budget)} Cr</span></i>`
      + (p.fronts && state.compareStyle === 'band' ? `<span class="l3d-fronts">${frontHTML(p.fronts.base)}<em>·</em>${frontHTML(p.fronts.band, true)}</span>` : '');
    el.title = `${p.label}: ${fmtPct(tot.pct)} · ₹${fmtCr(tot.earned)} of ₹${fmtCr(tot.budget)} Cr`;
    if (p.fronts && state.compareStyle === 'band') {
      el.classList.add('with-fronts');
      el.title += `\n${frontText(p.fronts.base)}\n${frontText(p.fronts.band)}`;
    }
    labelLayer.appendChild(el);
    labels.push({
      el, kind: 'caption',
      x: (p.bbox.min[0] + p.bbox.max[0]) / 2,
      z: (p.bbox.min[2] + p.bbox.max[2]) / 2,
      y: p.bbox.max[1],
    });
  }
}

function frontHTML(f, band = false) {
  const sw = band ? `<i class="l3d-band" style="background:${bandInfo?.color}"></i>` : '';
  const where = f.done ?? (f.started ? `${f.started} started` : 'not begun');
  return `${sw}${esc(f.name)} <b>${esc(where)}</b>`;
}
function frontText(f) {
  if (f.done) return `${f.name} complete up to ${f.done}${f.started ? `, started up to ${f.started}` : ''}`;
  return f.started ? `${f.name} started up to ${f.started}, no floor complete yet` : `${f.name} not begun`;
}

function projectLabels() {
  if (!labelLayer || !towers.length) return;
  const w = $('stageWrap').clientWidth, h = $('stageWrap').clientHeight;
  labelLayer.classList.toggle('compact', h < 520);
  const v = new THREE.Vector3();
  const project = (x, y, z) => {
    v.set(x, y, z).add(root.position).project(camera);
    return { x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, front: v.z <= 1 };
  };

  const corners = towers.flatMap((t) => [
    [t.bbox.min[0], t.bbox.min[2]], [t.bbox.max[0], t.bbox.min[2]],
    [t.bbox.min[0], t.bbox.max[2]], [t.bbox.max[0], t.bbox.max[2]],
  ]);
  const RAIL_GAP = 10;
  const HINT_BAND = 28;
  const railAt = (y, hw) => {
    let left = null, right = null;
    for (const [x, z] of corners) {
      const p = project(x, y, z);
      if (!p.front) continue;
      if (!left || p.x < left.x) left = p;
      if (!right || p.x > right.x) right = p;
    }
    if (!left) return { x: 0, y: 0, front: false };
    return left.x - RAIL_GAP - hw * 2 > 4
      ? { x: left.x - RAIL_GAP - hw, y: left.y, front: true }
      : { x: right.x + RAIL_GAP + hw, y: right.y, front: true };
  };

  const GAP = 9;
  const placed = [];
  const hits = (x, y, hw, hh) => placed.some((p) => Math.abs(p.x - x) < p.hw + hw + 6 && Math.abs(p.y - y) < p.hh + hh + 3);
  const ORDER = { caption: 0, front: 1, axis: 2 };
  for (const l of [...labels].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])) {
    if (l.kind === 'front') {
      const yy = l.y + l.node.group.position.y;
      let best = null;
      for (const [x, z] of l.ring) { const p = project(x, yy, z); if (p.front && (!best || p.x > best.x)) best = p; }
      if (!best || !l.node.group.visible) { l.el.style.visibility = 'hidden'; continue; }
      const fw = l.el.offsetWidth / 2 || 50, fh = l.el.offsetHeight / 2 || 9;
      const fx = Math.min(w - fw - 4, best.x + 8 + fw);
      let fy = best.y;
      for (const k of [0, 1, -1, 2, -2, 3, -3]) { const yk = best.y + k * (fh * 2 + 3); if (!hits(fx, yk, fw, fh)) { fy = yk; break; } }
      placed.push({ x: fx, y: fy, hw: fw, hh: fh });
      l.el.style.visibility = 'visible';
      l.el.style.transform = `translate(-50%,-50%) translate(${fx.toFixed(1)}px,${fy.toFixed(1)}px)`;
      continue;
    }
    const hw = l.el.offsetWidth / 2 || 60;
    const hh = l.el.offsetHeight / 2 || 8;
    const isAxis = l.kind === 'axis';
    const anchor = isAxis
      ? railAt(l.node.storey.elevation + l.node.group.position.y, hw)
      : project(l.x, l.y, l.z);
    const sx = anchor.x;
    const off = !anchor.front || sx < -110 || sx > w + 110 || anchor.y < -60 || anchor.y > h + 30
      || (isAxis && (!l.node.group.visible || anchor.y + hh > h - HINT_BAND || sx - hw < 2 || sx + hw > w - 2));
    const sy0 = l.kind === 'caption' ? anchor.y - GAP - hh : anchor.y;
    let sy = sy0, dx = 0;
    let clash = !off && hits(sx, sy, hw, hh);
    if (clash && l.kind === 'caption') {
      const step = hw * 0.55;
      const short = h < 520 || l.el.classList.contains('with-fronts');
      const lifts = short ? [0, 1, 2, 3, 4, 5, 6, -1, -2] : [0, 1, 2, 3, 4, 5, 6];
      const sides = short ? [0, -1, 1, -2, 2, -3, 3, -4, 4] : [0, -1, 1, -2, 2];
      search:
      for (const lift of lifts) {
        for (const k of sides) {
          if (lift === 0 && k === 0) continue;
          const y = sy0 - lift * (hh * 2 + 4), x = sx + k * step;
          if (y - hh < 2 || x - hw < 2 || x + hw > w - 2) continue;
          if (!hits(x, y, hw, hh)) { sy = y; dx = k * step; clash = false; break search; }
        }
      }
    }
    l.el.style.visibility = off || clash ? 'hidden' : 'visible';
    if (off || clash) continue;
    placed.push({ x: sx + dx, y: sy, hw, hh });
    l.el.style.transform = `translate(-50%,-50%) translate(${(sx + dx).toFixed(1)}px,${sy.toFixed(1)}px)`;
    if (l.kind === 'caption') {
      l.el.style.setProperty('--leader', `${Math.max(0, anchor.y - (sy + hh)).toFixed(1)}px`);
      l.el.style.setProperty('--leader-x', `${(-dx).toFixed(1)}px`);
    }
  }
}


function renderTowerTable(perTower) {
  const t = $('mapTable');
  if (!perTower.length) { t.innerHTML = ''; return; }
  const rows = perTower.map((p) => {
    const tot = p.tot ?? p.slice.totals;
    return `<tr>
      <td><b>${esc(p.label)}</b></td>
      <td style="text-align:right">${fmtPct(tot.pct)}</td>
      <td style="text-align:right">₹${fmtCr(tot.earned)}</td>
      <td style="text-align:right;color:var(--text-muted)">of ${fmtCr(tot.budget)}</td>
    </tr>`;
  });
  t.innerHTML = '<thead><tr><th>Tower</th><th style="text-align:right">%</th>'
    + '<th style="text-align:right">Earned Cr</th><th style="text-align:right">Scope</th></tr></thead>'
    + `<tbody>${rows.join('')}</tbody>`;
}

function levelMix(sl, key) {
  if (!state.levels) return sl.totals[key];
  const mix = new Map();
  for (const r of sl.rows) {
    if (!state.levels.has(r.rank)) continue;
    for (const [k, v] of r[key]) mix.set(k, (mix.get(k) || 0) + v);
  }
  return mix;
}

const COUNT_NOTE = 'Counts every task in view, on or off the 3D model. Activity details lists only the tasks on the model.';

function renderLegend(modelled) {
  const box = $('legend');
  box.replaceChildren();
  const add = (html) => { const d = document.createElement('div'); d.className = 'legend-item'; d.innerHTML = html; box.append(d); };
  if (bandInfo && cmpLines()) {
    const line = (c) => `<span class="legend-swatch" style="background:${c};height:4px;border-radius:2px"></span>`;
    add(`${line(bandInfo.baseColor)}${esc(bandInfo.baseName)} line`);
    add(`${line(bandInfo.color)}${esc(bandInfo.name)} line`);
    if (cmpBands()) add(`<span class="legend-swatch" style="background:${bandInfo.color};opacity:.45"></span>${esc(bandInfo.name)} complete on the floor`);
    add('<span style="color:var(--text-muted);font-size:11px;line-height:1.4">Each line is the highest floor where that work is complete. The gap between the two lines is how far behind the second one is. ↓ means it has only reached floors below the model so far.</span>');
  } else if (bandInfo) {
    add(`<span class="legend-swatch" style="background:${bandInfo.color};opacity:.85"></span>Band: ${esc(bandInfo.name)} complete`);
    add(`<span class="legend-swatch" style="background:${bandInfo.color};opacity:.3"></span>Band: ${esc(bandInfo.name)} started`);
    add('<span style="color:var(--text-muted);font-size:11px;line-height:1.4">The concrete shows the trade picked above; the band around each floor shows the one under Compare with. The tower labels give how far each has reached.</span>');
  }
  const count = (n) => `<span style="margin-left:auto;color:var(--text-muted);font-variant-numeric:tabular-nums">${fmtInt(n)}</span>`;
  const note = (html, ink = 'var(--text-muted)') => add(`<span style="color:${ink};font-size:11px;line-height:1.4">${html}</span>`);

  if (state.view === 'planned' || state.view === 'actual') {
    const planned = state.view === 'planned';
    $('legendTitle').textContent = planned ? 'Legend · planned status' : 'Legend · actual status';
    const seen = new Map();
    for (const r of actRows) { const k = planned ? r.planned : r.actual; seen.set(k, (seen.get(k) || 0) + 1); }
    const order = planned ? PLANNED_ORDER
      : [...seen.keys()].sort((a, b) => (P.STATUS_ORDER.get(a.toLowerCase()) ?? 99) - (P.STATUS_ORDER.get(b.toLowerCase()) ?? 99));
    for (const k of order) {
      if (!seen.get(k)) continue;
      const sw = k === NO_PLAN ? (P.getMode() === 'dark' ? '#2b333b' : '#d5dbe0') : P.taskStatusColor(k);
      add(`<span class="legend-swatch" style="background:${sw}"></span>${esc(k)}${count(seen.get(k))}`);
    }
    if (!actRows.length) note('No tasks in this selection.');
    note(planned
      ? 'Where the plan puts each task on this date: past its planned end is Complete, inside its planned dates is Started, before its planned start is Not Ready. It says nothing about what happened on site.'
      : 'The status each task holds in VisiLean on this date.');
    if (!planned && isForecast()) note('Projected. Past the capture date nothing is recorded, so work is carried along its planned window.', 'var(--warn-ink)');
    if (!modelled) note('This trade has no geometry in a structural model — whole storeys are coloured instead.');
    return;
  }

  if (isStatusView()) {
    $('legendTitle').textContent = 'Legend · task status';
    const seen = new Map();
    for (const t of towers) {
      if (!state.towers.has(t.def.id)) continue;
      const st = state.model.structureById.get(scheduleIdFor(t.def));
      if (!st) continue;
      const sl = sliceStructureAt(st, state.trades, state.day, state.model.asOfDay, state.model.aopHorizon);
      for (const [k, v] of levelMix(sl, 'status')) seen.set(k, (seen.get(k) || 0) + v);
    }
    const order = [...seen.keys()]
      .filter((k) => !isNotStarted(k))
      .sort((a, b) => (P.STATUS_ORDER.get(a.toLowerCase()) ?? 99) - (P.STATUS_ORDER.get(b.toLowerCase()) ?? 99));
    for (const k of order) {
      add(`<span class="legend-swatch" style="background:${P.taskStatusColor(k)}"></span>${esc(k)}`
        + `<span style="margin-left:auto;color:var(--text-muted);font-variant-numeric:tabular-nums">${fmtInt(seen.get(k))}</span>`);
    }
    const waiting = [...seen].filter(([k]) => isNotStarted(k)).reduce((a, [, v]) => a + v, 0);
    if (waiting) {
      add(`<span class="legend-swatch" style="background:${P.statusColor('none')}"></span>Not started`
        + `<span style="margin-left:auto;color:var(--text-muted);font-variant-numeric:tabular-nums">${fmtInt(waiting)}</span>`);
    }
    if (isForecast()) {
      add('<span style="color:var(--warn-ink);font-size:11px;line-height:1.4">Projected. Past the capture date nothing is recorded, so work is carried along its planned window — and anything already overdue is assumed to start now and still take as long as it was meant to.</span>');
    }
    if (!modelled) add('<span style="color:var(--text-muted);font-size:11px;line-height:1.4">This trade has no geometry in a structural model — whole storeys are coloured by its progress instead.</span>');
    if (MODEL_ONLY) note(COUNT_NOTE);
    return;
  }
  if (state.view === 'plan' || state.view === 'baseline') {
    const against = state.view === 'plan' ? 'plan' : 'baseline';
    $('legendTitle').textContent = `Legend · ${against} vs actual`;
    const seen = new Map();
    for (const t of towers) {
      if (!state.towers.has(t.def.id)) continue;
      const st = state.model.structureById.get(scheduleIdFor(t.def));
      if (!st) continue;
      const sl = sliceStructureAt(st, state.trades, state.day, state.model.asOfDay, state.model.aopHorizon);
      for (const [k, v] of levelMix(sl, state.view === 'plan' ? 'planState' : 'baseState')) {
        seen.set(k, (seen.get(k) || 0) + v);
      }
    }
    for (const k of P.PLAN_STATE_ORDER) {
      if (!seen.has(k)) continue;
      add(`<span class="legend-swatch" style="background:${P.planStateColor(k)}"></span>${esc(PLAN_STATE_LABEL[k])}`
        + `<span style="margin-left:auto;color:var(--text-muted);font-variant-numeric:tabular-nums">${fmtInt(seen.get(k))}</span>`);
    }
    add(`<span style="color:var(--text-muted);font-size:11px;line-height:1.4">"Planned, not started" is work the ${against} had starting by this date that has not begun. It carries Not Ready's colour.</span>`);
    if (MODEL_ONLY) note(COUNT_NOTE);
    return;
  }
  if (!modelled) add(`<span style="color:var(--text-muted);font-size:11px;line-height:1.4">This trade has no geometry in a structural model — whole storeys are coloured by its progress instead.</span>`);
}

function selectionBaseline(day) { return selectionValue(day, 'baseline'); }

function selectionValue(day, kind) {
  let budget = 0, value = 0;
  const m = state.model;
  for (const t of towers) {
    if (!state.towers.has(t.def.id)) continue;
    const st = m.structureById.get(scheduleIdFor(t.def));
    const T = st?.tasks;
    if (!T) continue;
    for (const ti of state.trades) {
      for (const c of st.byTrade.get(ti) ?? []) {
        if (state.levels && !state.levels.has(st.floors[c[C.F]].rank)) continue;
        for (let k = c[C.TOFF], end = c[C.TOFF] + c[C.TN]; k < end; k++) {
          budget += T.bc[k];
          value += T.bc[k] * (kind === 'plan'
            ? rampFraction(T.ps[k], T.pe[k], day)
            : rampFraction(T.bs[k], T.be[k], day));
        }
      }
    }
  }
  return { budget, value, pct: budget > 0 ? (value / budget) * 100 : null };
}

const isOverdue = (pe, statusOnDay, day) => pe >= 0 && pe < day && statusOnDay !== 'Complete';

function selectionOverdue(day) {
  let n = 0, budget = 0;
  const m = state.model;
  for (const t of towers) {
    if (!state.towers.has(t.def.id)) continue;
    const st = m.structureById.get(scheduleIdFor(t.def));
    const T = st?.tasks;
    if (!T) continue;
    for (const ti of state.trades) {
      for (const c of st.byTrade.get(ti) ?? []) {
        if (state.levels && !state.levels.has(st.floors[c[C.F]].rank)) continue;
        for (let k = c[C.TOFF], end = c[C.TOFF] + c[C.TN]; k < end; k++) {
          const s = statusAt(st.statuses, T.st[k], T.as[k], T.ae[k], day, m.asOfDay, T.ps[k], T.pe[k]);
          if (isOverdue(T.pe[k], s, day)) { n++; budget += T.bc[k]; }
        }
      }
    }
  }
  return { n, budget };
}

function showOverdue() {
  state.actsOverdue = true;
  state.pick = null;
  if (state.actsScope !== 'selection') {
    state.actsScope = 'selection';
    state.actsAll = null;
    state.actsToggled?.clear();
    actRows = buildActivities();
  }
  openActivities();
  renderActivities();
  $('acts').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function daysAgainst(kind, earned, day) {
  const m = state.model;
  if (!(earned > 0)) return null;
  let lo = m.dayMin, hi = m.dayMax;
  if (selectionValue(hi, kind).value < earned) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (selectionValue(mid, kind).value >= earned) hi = mid; else lo = mid + 1;
  }
  return lo - day;
}

function renderStrip(totals) {
  const strip = $('strip');
  strip.replaceChildren();
  const pct = totals.budget > 0 ? (totals.earned / totals.budget) * 100 : 0;
  const vsPlan = state.view === 'plan';
  const ref = vsPlan ? 'plan' : 'baseline';
  const refPct = vsPlan ? (totals.budget > 0 ? (totals.pv / totals.budget) * 100 : null) : selectionBaseline(state.day).pct;
  const delta = refPct == null ? null : Math.round((pct - refPct) * 10) / 10 || 0;
  const when = state.day === state.model.asOfDay ? 'by today' : `by ${fmtDate(state.day)}`;

  strip.append(cell('Progress', fmtPct(pct), '',
    refPct == null ? `${fmtInt(totals.done)} of ${fmtInt(totals.n)} tasks` : `${ref} ${fmtPct(refPct)} ${when}`,
    meter([[pct, 'var(--brand)']]), null, 'brand', 'progress'));
  strip.append(cell(isForecast() ? 'Forecast value' : 'Earned value', `₹${fmtCr(totals.earned)}`, 'Cr', `of ₹${fmtCr(totals.budget)} Cr in scope`,
    meter([[pct, 'var(--ok-ink)']]), null, 'ok', 'rupee'));
  let vsSub = `no ${ref} value`, vsMeter = null, vsTitle = '';
  if (delta != null) {
    const due = (refPct / 100) * totals.budget;
    const gap = totals.earned - due;
    const days = daysAgainst(ref, totals.earned, state.day);
    const agree = days != null && Math.abs(days) >= 1 && (days < 0) === (gap < 0) && Math.abs(delta) >= 0.05;
    const dayTxt = agree ? ` · about ${fmtInt(Math.abs(days))} day${Math.abs(days) === 1 ? '' : 's'}` : '';
    vsSub = Math.abs(delta) < 0.05 ? `on ${ref}` : `₹${fmtCr(Math.abs(gap))} Cr ${gap >= 0 ? 'ahead' : 'behind'}${dayTxt}`;
    vsMeter = meter(delta >= 0 ? [[pct, 'var(--tone)']] : [[pct, 'var(--tone)'], [refPct - pct, 'var(--tone-soft)']]);
    vsTitle = `Earned ₹${fmtCr(totals.earned)} Cr against ₹${fmtCr(due)} Cr the ${ref} had due ${when}: `
      + `₹${fmtCr(Math.abs(gap))} Cr ${gap >= 0 ? 'ahead' : 'behind'} (${Math.abs(delta).toFixed(1)} points of ₹${fmtCr(totals.budget)} Cr).`
      + (!agree ? '' : days < 0
        ? ` The ${ref} had this much work due by ${fmtDateLong(state.day + days)}, about ${fmtInt(-days)} days earlier.`
        : ` The ${ref} reaches this much work only on ${fmtDateLong(state.day + days)}, about ${fmtInt(days)} days later.`);
  }
  const vsCell = cell(vsPlan ? 'vs Plan' : 'vs Baseline', delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`,
    delta == null ? '' : 'pts', vsSub, vsMeter, null, delta == null ? 'neutral' : delta >= 0 ? 'ok' : 'bad', 'target');
  vsCell.title = vsTitle;
  strip.append(vsCell);
  const od = selectionOverdue(state.day);
  const odCell = cell('Overdue', fmtInt(od.n), od.n === 1 ? 'task' : 'tasks',
    !od.n ? 'nothing past its planned finish'
      : od.budget > 0 ? `₹${fmtCr(od.budget)} Cr past planned finish` : 'past planned finish, no budget on them',
    null, null, od.n ? 'bad' : 'ok', 'clock');
  if (od.n) {
    odCell.classList.add('is-link');
    odCell.setAttribute('role', 'button');
    odCell.tabIndex = 0;
    odCell.title = 'List these tasks in Activity details';
    odCell.onclick = showOverdue;
    odCell.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showOverdue(); } };
  }
  strip.append(odCell);
}

const TILE_ICONS = {
  progress: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  rupee: '<path d="M6 4h12M6 9h12M9 4c3.5 0 6 1.6 6 5s-2.5 5-6 5H7l7 6"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6" fill="currentColor"/>',
  towers: '<path d="M4 21V8l6-4v17M10 21V10l10 3v8M3 21h18"/><path d="M13 16h1M17 16h1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

function cell(label, value, unit, sub, meterEl, color, tone = 'neutral', icon) {
  const d = document.createElement('div');
  d.className = `strip-cell tone-${tone}`;
  if (icon && TILE_ICONS[icon]) {
    const ic = document.createElement('div'); ic.className = 'strip-icon';
    ic.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TILE_ICONS[icon]}</svg>`;
    d.append(ic);
  }
  const l = document.createElement('div'); l.className = 'strip-label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'strip-value'; v.textContent = value;
  if (color) v.style.color = color;
  if (unit) { const u = document.createElement('small'); u.textContent = unit; v.append(u); }
  d.append(v, l);
  if (sub) { const s = document.createElement('div'); s.className = 'strip-sub'; s.textContent = sub; d.append(s); }
  if (meterEl) d.append(meterEl);
  return d;
}
function meter(parts) {
  const m = document.createElement('div'); m.className = 'meter';
  for (const [w, c] of parts) {
    if (w <= 0) continue;
    const i = document.createElement('i'); i.style.width = `${Math.min(100, w)}%`; i.style.background = c; m.append(i);
  }
  return m;
}


const ACT_TAIL = [
  ['activity', 'Activities'],
  ['baseline', 'Baseline status'], ['planned', 'Planned status'], ['actual', 'Actual status'], ['pct', '% Complete'],
  ['bs', 'Baseline start'], ['be', 'Baseline end'], ['ps', 'Planned start'], ['pe', 'Planned end'],
  ['as', 'Actual start'], ['ae', 'Actual end'], ['slip', 'vs Baseline'],
];
const NO_BASE = 'No baseline dates';
const ACT_TITLE = {
  baseline: 'The planned-status rule applied to the baseline dates, on the selected date',
  slip: 'Days the finish is later (+) or earlier (−) than the baseline end. Finish = actual end if done by the selected date, otherwise the planned end.',
};
const ACT_COLS_DETAIL = [['id', 'Task ID'], ['loc', 'Location'], ...ACT_TAIL];
const ACT_COLS_WBS = [['id', 'Task ID'], ['loc', 'Location'], ['wbs', 'WBS'], ...ACT_TAIL];

const wbsViews = new WeakMap();
function wbsView(st) {
  let v = wbsViews.get(st);
  if (v) return v;
  const parts = (st.wbs || []).map((w) => (w ? w.split(' › ') : []));
  const ref = parts.find((p) => p.length);
  let cut = ref ? ref.length : 0;
  for (const p of parts) {
    if (!p.length) continue;
    let i = 0;
    while (i < cut && i < p.length && p[i] === ref[i]) i++;
    cut = i;
  }
  v = parts.map((p) => p.slice(Math.min(cut, Math.max(0, p.length - 1))).join(' › '));
  wbsViews.set(st, v);
  return v;
}
const ACT_COLS_PLAIN = [['tower', 'Tower'], ['level', 'Level'], ...ACT_TAIL];
const ACT_LIMIT = 400;
const ACTS_OPEN_KEY = `${THEME_KEY}-acts-open`;

function buildActivities() {
  const m = state.model, out = [];
  if (!m) return out;
  const day = state.day;
  const project = state.actsScope === 'project';

  const push = (st, towerId, towerName, order, ti, cells, full) => {
    const T = st.tasks;
    const detail = Boolean(T.id && st.locs);
    const view = full ? st.wbs : (st.wbs && wbsView(st));
    const trade = m.trades[ti];
    const floorsOnModel = MODEL_ONLY ? modelFloors.get(towerId) : null;
    if (MODEL_ONLY && (!floorsOnModel || !categoriesForTrade(trade.name))) return;
    for (const c of cells) {
      const fl = st.floors[c[C.F]];
      if (floorsOnModel && !floorsOnModel.has(fl.rank)) continue;
      if (!project && state.levels && !state.levels.has(fl.rank)) continue;
      const level = cleanLevel(fl.name);
      for (let k = c[C.TOFF], end = c[C.TOFF] + c[C.TN]; k < end; k++) {
        const as = T.as[k], ae = T.ae[k], ps = T.ps[k], pe = T.pe[k];
        const bs = T.bs?.[k] ?? -1, be = T.be?.[k] ?? -1;
        const baseline = plannedStatusAt(bs, be, day);
        const finish = ae >= 0 && ae <= day ? ae : pe;
        out.push({
          towerId, tower: towerName, order, rank: fl.rank, level,
          id: detail ? T.id[k] : null,
          loc: detail ? (st.locs[T.lo[k]] || `${towerName} - ${level}`) : null,
          wbs: detail && view && T.wb ? (view[T.wb[k]] || '') : '',
          wbsFull: detail && st.wbs && T.wb ? (st.wbs[T.wb[k]] || '') : '',
          trade: ti, activity: trade.name, seq: trade.seq ?? 0,
          planned: plannedStatusAt(ps, pe, day),
          baseline: baseline === NO_PLAN ? NO_BASE : baseline,
          actual: statusAt(st.statuses, T.st[k], as, ae, day, m.asOfDay, ps, pe),
          pct: earnedFraction(as, ae, T.pc[k], day, m.asOfDay, ps, pe) * 100,
          bc: T.bc[k] || 0,
          ps, pe, bs, be, as: as > day ? -1 : as, ae: ae > day ? -1 : ae,
          slip: finish >= 0 && be >= 0 ? finish - be : null,
        });
      }
    }
  };

  if (project) {
    m.structures.forEach((st, order) => {
      if (!st.tasks) return;
      const def = TOWERS.find((d) => scheduleIdFor(d) === st.id);
      for (const [ti, cells] of st.byTrade) push(st, def?.id ?? st.id, def?.name ?? st.name, order, ti, cells, true);
    });
    return out;
  }
  for (const t of towers) {
    if (!state.towers.has(t.def.id)) continue;
    const st = m.structureById.get(scheduleIdFor(t.def));
    if (!st?.tasks) continue;
    const order = TOWERS.indexOf(t.def);
    for (const ti of state.trades) {
      const cells = st.byTrade.get(ti);
      if (cells) push(st, t.def.id, t.def.name, order, ti, cells, false);
    }
  }
  return out;
}

function clearActivities() {
  actRows = state.actsScope === 'project' ? buildActivities() : [];
  renderActivities();
}

const statusRank = (s) => P.STATUS_ORDER.get(String(s).toLowerCase()) ?? (s === NO_PLAN || s === NO_BASE ? 100 : 99);
const plannedRank = (s) => (s === NO_BASE ? PLANNED_ORDER.length : PLANNED_ORDER.indexOf(s));

function sortActivities(rows) {
  const { key, dir } = state.actsSort;
  const byDefault = (a, b) => a.order - b.order || a.rank - b.rank || a.seq - b.seq || a.ps - b.ps;
  if (key === 'default') return rows.sort(byDefault);
  const cmp = {
    tower: (a, b) => a.order - b.order,
    id: (a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }),
    loc: (a, b) => a.order - b.order || a.rank - b.rank || String(a.loc).localeCompare(String(b.loc), undefined, { numeric: true }),
    wbs: (a, b) => (!a.wbs) - (!b.wbs) || a.wbs.localeCompare(b.wbs, undefined, { numeric: true }),
    level: (a, b) => a.rank - b.rank,
    activity: (a, b) => a.activity.localeCompare(b.activity),
    tree: (a, b) => a.activity.localeCompare(b.activity),
    planned: (a, b) => plannedRank(a.planned) - plannedRank(b.planned),
    baseline: (a, b) => plannedRank(a.baseline) - plannedRank(b.baseline),
    actual: (a, b) => statusRank(a.actual) - statusRank(b.actual),
    pct: (a, b) => a.pct - b.pct,
  }[key];
  if (key === 'slip') {
    return rows.sort((a, b) => (a.slip == null) - (b.slip == null) || dir * ((a.slip ?? 0) - (b.slip ?? 0)) || byDefault(a, b));
  }
  const dates = (a, b) => (a[key] < 0) - (b[key] < 0) || dir * (a[key] - b[key]);
  return rows.sort((a, b) => (cmp ? dir * cmp(a, b) : dates(a, b)) || byDefault(a, b));
}


const TREE_COLS = [['tree', 'WBS / Activity'], ['id', 'Task ID'], ['loc', 'Location'],
  ...ACT_TAIL.filter(([k]) => k !== 'activity')];
const TREE_LIMIT = 700;

function buildTree(rows) {
  const root = { key: '', depth: -1, children: new Map(), tasks: [] };
  const project = state.actsScope === 'project';
  const multi = !project && new Set(rows.map((r) => r.towerId)).size > 1;
  const top = project ? [CONFIG.eyebrow || CONFIG.title || 'Whole project'] : [];
  for (const r of rows) {
    const segs = [...top, ...(multi ? [r.tower] : []), ...(r.wbs ? r.wbs.split(' › ') : ['(No WBS)'])];
    let node = root;
    segs.forEach((s, i) => {
      let c = node.children.get(s);
      if (!c) {
        node.children.set(s, (c = { name: s, key: `${node.key}/${encodeURIComponent(s)}`, depth: i, children: new Map(), tasks: [] }));
        if (multi && i === 0) c.order = r.order;
      }
      node = c;
    });
    node.tasks.push(r);
  }
  rollup(root);
  return root;
}

function rollup(node) {
  const a = { n: 0, pct: 0, bc: 0, ev: 0, bs: -1, be: -1, ps: -1, pe: -1, as: -1, ae: -1, finish: -1, open: 0, first: Infinity };
  const lo = (x, v) => (v < 0 ? x : x < 0 ? v : Math.min(x, v));
  const hi = (x, v) => (v < 0 ? x : Math.max(x, v));
  const add = (r) => {
    a.n++; a.pct += r.pct;
    a.bc += r.bc; a.ev += (r.bc * r.pct) / 100;
    a.bs = lo(a.bs, r.bs); a.be = hi(a.be, r.be); a.ps = lo(a.ps, r.ps); a.pe = hi(a.pe, r.pe);
    a.as = lo(a.as, r.as); a.ae = hi(a.ae, r.ae);
    if (r.ae < 0) a.open++;
    const f = r.ae >= 0 ? r.ae : r.pe;
    a.finish = hi(a.finish, f);
    const s = r.ps >= 0 ? r.ps : r.bs;
    if (s >= 0) a.first = Math.min(a.first, s);
  };
  for (const r of node.tasks) add(r);
  for (const c of node.children.values()) {
    const ca = rollup(c);
    a.n += ca.n; a.pct += ca.pct; a.open += ca.open;
    a.bc += ca.bc; a.ev += ca.ev;
    a.bs = lo(a.bs, ca.bs); a.be = hi(a.be, ca.be); a.ps = lo(a.ps, ca.ps); a.pe = hi(a.pe, ca.pe);
    a.as = lo(a.as, ca.as); a.ae = hi(a.ae, ca.ae); a.finish = hi(a.finish, ca.finish);
    a.first = Math.min(a.first, ca.first);
  }
  a.aeShown = a.open ? -1 : a.ae;
  a.pctShown = a.bc > 0 ? (a.ev / a.bc) * 100 : a.n ? a.pct / a.n : 0;
  a.slip = a.finish >= 0 && a.be >= 0 ? a.finish - a.be : null;
  node.agg = a;
  return a;
}

function treeIsOpen(node, force) {
  if (force) return true;
  const deep = state.actsScope === 'project' ? 1 : 0;
  const base = state.actsAll === 'open' ? true : state.actsAll === 'closed' ? false : node.depth <= deep;
  return base !== state.actsToggled.has(node.key);
}

function renderActivities() {
  let rows = actRows;
  const p = state.pick;
  if (p) rows = rows.filter((r) => r.towerId === p.towerId && r.rank === p.rank && p.trades.has(r.trade));
  if (state.actsOverdue) {
    rows = rows.filter((r) => isOverdue(r.pe, r.actual, state.day));
    const all = selectionOverdue(state.day).n;
    $('actsOverdueText').textContent = rows.length === all ? `Overdue · ${fmtInt(all)}`
      : `Overdue · ${fmtInt(rows.length)} of ${fmtInt(all)} on the model`;
    $('actsOverdueChip').title = rows.length === all ? ''
      : `${fmtInt(all - rows.length)} overdue tasks are in trades or on floors the structural model does not show`;
  }
  $('actsOverdueChip').hidden = !state.actsOverdue;
  const q = state.actsQuery.trim().toLowerCase();
  if (q) rows = rows.filter((r) => `${r.activity} ${r.level} ${r.tower} ${r.id ?? ''} ${r.loc ?? ''} ${r.wbsFull ?? ''}`.toLowerCase().includes(q));

  $('actsPick').hidden = !p;
  $('actsPickText').textContent = p?.label ?? '';
  document.querySelectorAll('#actsScope [data-scope]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.scope === state.actsScope)));
  const wbsAvailable = actRows.some((r) => r.wbs);
  const treeMode = wbsAvailable && state.actsView === 'tree';
  $('actsView').hidden = !wbsAvailable;
  $('actsTreeTools').hidden = !treeMode;
  document.querySelectorAll('#actsView [data-view]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.view === (treeMode ? 'tree' : 'list'))));
  const m = state.model;
  $('actsCount').textContent = `${fmtInt(rows.length)} task${rows.length === 1 ? '' : 's'}`
    + (m && state.day !== m.asOfDay ? ` · ${isForecast() ? 'projected to' : 'as at'} ${fmtDateLong(state.day)}` : '');
  if ($('acts').classList.contains('closed')) return;

  const table = $('actsTable');
  if (!rows.length) {
    table.innerHTML = '';
    $('actsMore').hidden = false;
    $('actsMore').textContent = p ? 'No selected activities on this floor.' : 'No tasks in this selection.';
    return;
  }
  const pill = (s) => {
    const c = s === NO_PLAN || s === NO_BASE ? (P.getMode() === 'dark' ? '#2b333b' : '#d5dbe0') : P.taskStatusColor(s);
    return `<span class="st-pill"><i style="background:${c}"></i>${esc(s)}</span>`;
  };
  const slip = (d) => (d == null ? '—'
    : d > 0 ? `<span class="slip late">+${fmtInt(d)} d</span>`
    : d < 0 ? `<span class="slip early">−${fmtInt(-d)} d</span>`
    : '<span class="slip">0 d</span>');
  const { key, dir } = state.actsSort;
  const headOf = (cols) => cols.map(([k, label]) =>
    `<th data-k="${k}"${k === key ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : ''}`
    + `${k === 'pct' || k === 'slip' ? ' style="text-align:right"' : ''}${ACT_TITLE[k] ? ` title="${ACT_TITLE[k]}"` : ''}>${label}</th>`).join('');
  if (treeMode) { renderTree(rows, headOf(TREE_COLS), pill, slip); return; }

  const shown = sortActivities(rows.slice()).slice(0, ACT_LIMIT);
  const detail = rows[0].id != null;
  const hasWbs = detail && rows.some((r) => r.wbs);
  const cols = hasWbs ? ACT_COLS_WBS : detail ? ACT_COLS_DETAIL : ACT_COLS_PLAIN;
  const head = headOf(cols);
  const lead = (r) => (detail
    ? `<td>${esc(r.id || '—')}</td><td>${esc(r.loc)}</td>`
      + (hasWbs ? `<td class="wbs" title="${esc(r.wbsFull)}">${esc(r.wbs || '—')}</td>` : '')
    : `<td>${esc(r.tower)}</td><td>${esc(r.level)}</td>`);
  const body = shown.map((r) => `<tr>
    ${lead(r)}<td class="act">${esc(r.activity)}</td>
    <td>${pill(r.baseline)}</td><td>${pill(r.planned)}</td><td>${pill(r.actual)}</td><td class="num">${fmtPct(r.pct)}</td>
    <td>${fmtDate(r.bs)}</td><td>${fmtDate(r.be)}</td><td>${fmtDate(r.ps)}</td><td>${fmtDate(r.pe)}</td>
    <td>${fmtDate(r.as)}</td><td>${fmtDate(r.ae)}</td><td class="num">${slip(r.slip)}</td>
  </tr>`).join('');
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  $('actsMore').hidden = rows.length <= ACT_LIMIT;
  $('actsMore').textContent = `Showing the first ${fmtInt(ACT_LIMIT)} of ${fmtInt(rows.length)}. Narrow it with the filters, the search box, or by clicking a floor in the model.`;
}

function renderTree(rows, head, pill, slip) {
  const force = Boolean(state.pick || state.actsQuery.trim());
  const root = buildTree(rows);
  const out = [];
  let drawn = 0, cut = false;
  const kids = (n) => [...n.children.values()]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.agg.first - b.agg.first
      || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const taskRow = (r, d) => `<tr class="task" style="--d:${d}">
    <td class="tree">${esc(r.activity)}</td><td>${esc(r.id || '—')}</td><td>${esc(r.loc)}</td>
    <td>${pill(r.baseline)}</td><td>${pill(r.planned)}</td><td>${pill(r.actual)}</td><td class="num">${fmtPct(r.pct)}</td>
    <td>${fmtDate(r.bs)}</td><td>${fmtDate(r.be)}</td><td>${fmtDate(r.ps)}</td><td>${fmtDate(r.pe)}</td>
    <td>${fmtDate(r.as)}</td><td>${fmtDate(r.ae)}</td><td class="num">${slip(r.slip)}</td></tr>`;
  const walk = (node) => {
    for (const c of kids(node)) {
      if (drawn >= TREE_LIMIT) { cut = true; return; }
      const open = treeIsOpen(c, force);
      const g = c.agg;
      out.push(`<tr class="grp" data-key="${esc(c.key)}" aria-expanded="${open}" style="--d:${c.depth}">
        <td class="tree"><div class="grp-cell"><span class="caret">▾</span><span>${esc(c.name)}</span><span class="grp-n">${fmtInt(g.n)}</span></div></td>
        <td></td><td></td><td></td><td></td><td></td>
        <td class="num" title="Cost-weighted: earned value ÷ budget of its tasks (₹${fmtCr(g.ev)} of ₹${fmtCr(g.bc)} Cr)">${fmtPct(g.pctShown)}</td>
        <td>${fmtDate(g.bs)}</td><td>${fmtDate(g.be)}</td><td>${fmtDate(g.ps)}</td><td>${fmtDate(g.pe)}</td>
        <td>${fmtDate(g.as)}</td><td>${fmtDate(g.aeShown)}</td><td class="num">${slip(g.slip)}</td></tr>`);
      drawn++;
      if (!open) continue;
      for (const r of sortActivities(c.tasks.slice())) {
        if (drawn >= TREE_LIMIT) { cut = true; return; }
        out.push(taskRow(r, c.depth + 1));
        drawn++;
      }
      walk(c);
      if (cut) return;
    }
  };
  walk(root);
  $('actsTable').innerHTML = `<thead><tr>${head}</tr></thead><tbody>${out.join('')}</tbody>`;
  $('actsMore').hidden = !cut;
  $('actsMore').textContent = `Showing the first ${fmtInt(TREE_LIMIT)} rows. Collapse some groups, or narrow it with the filters, the search box, or by clicking a floor in the model.`;
}

function setActivitiesOpen(open) {
  $('acts').classList.toggle('closed', !open);
  $('actsToggle').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem(ACTS_OPEN_KEY, open ? '1' : '0'); } catch {  }
  resize();
  renderActivities();
}
function openActivities() { if ($('acts').classList.contains('closed')) setActivitiesOpen(true); }

function bindActivities() {
  let open = false;
  try { open = localStorage.getItem(ACTS_OPEN_KEY) === '1'; } catch {  }
  $('acts').classList.toggle('closed', !open);
  $('actsToggle').setAttribute('aria-expanded', String(open));
  $('actsToggle').onclick = () => setActivitiesOpen($('acts').classList.contains('closed'));
  $('actsSearch').oninput = (e) => { state.actsQuery = e.target.value; renderActivities(); };
  $('actsPickClear').onclick = () => { state.pick = null; renderActivities(); };
  $('actsOverdueClear').onclick = () => { state.actsOverdue = false; renderActivities(); };

  const VIEW_KEY = `${THEME_KEY}-acts-view`;
  try { if (localStorage.getItem(VIEW_KEY) === 'list') state.actsView = 'list'; } catch {  }
  document.querySelectorAll('#actsView [data-view]').forEach((b) => {
    b.onclick = () => {
      state.actsView = b.dataset.view;
      try { localStorage.setItem(VIEW_KEY, state.actsView); } catch {  }
      renderActivities();
    };
  });
  if (MODEL_ONLY) {
    const b = document.querySelector('#actsScope [data-scope="project"]');
    b.textContent = 'Whole model';
    b.title = 'Every task the model shows, under its WBS: modelled towers, activities with geometry, floors the models contain';
  }
  const SCOPE_KEY = `${THEME_KEY}-acts-scope`;
  try { if (localStorage.getItem(SCOPE_KEY) === 'selection') state.actsScope = 'selection'; } catch {  }
  document.querySelectorAll('#actsScope [data-scope]').forEach((b) => {
    b.onclick = () => {
      if (state.actsScope === b.dataset.scope) return;
      state.actsScope = b.dataset.scope;
      state.actsOverdue = false;
      try { localStorage.setItem(SCOPE_KEY, state.actsScope); } catch {  }
      state.actsAll = null;
      state.actsToggled.clear();
      actRows = buildActivities();
      renderActivities();
    };
  });
  $('actsExpand').onclick = () => { state.actsAll = 'open'; state.actsToggled.clear(); renderActivities(); };
  $('actsCollapse').onclick = () => { state.actsAll = 'closed'; state.actsToggled.clear(); renderActivities(); };

  $('actsTable').onclick = (e) => {
    const grp = e.target.closest('tr.grp');
    if (grp) {
      const k = grp.dataset.key;
      if (state.actsToggled.has(k)) state.actsToggled.delete(k); else state.actsToggled.add(k);
      renderActivities();
      return;
    }
    const th = e.target.closest('th[data-k]');
    if (!th) return;
    const k = th.dataset.k;
    state.actsSort = state.actsSort.key === k ? { key: k, dir: -state.actsSort.dir } : { key: k, dir: 1 };
    renderActivities();
  };
}


function bindPointer(canvas) {
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    pointerClient = { x: e.clientX, y: e.clientY };
    pickDirty = true;
    needsRender = true;
  });
  canvas.addEventListener('pointerleave', () => { pointerClient = null; setHover(null); showTip(null); });

  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, button: e.button }; });
  canvas.addEventListener('pointerup', (e) => {
    const click = down && down.button === 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
    down = null;
    if (!click) return;
    const r = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    const u = raycast()?.object?.userData;
    if (!u || u.rank == null || u.why === 'level-off' || !u.tradeIdxs?.length) return;
    state.pick = {
      towerId: u.towerId, rank: u.rank, trades: new Set(u.tradeIdxs),
      label: `${u.towerName} · ${u.floorMain}${u.cat ? ` · ${CATEGORY_LABEL[u.cat] || u.cat}` : ''}`,
    };
    openActivities();
    renderActivities();
  });

  canvas.addEventListener('dblclick', () => {
    const hit = raycast();
    if (!hit) return;
    cameraTouched = true;
    const from = camera.position.clone().sub(controls.target);
    controls.target.copy(hit.point);
    camera.position.copy(hit.point).add(from.setLength(Math.min(from.length(), 30)));
    controls.update();
    needsRender = true;
  });
}

function visibleMeshes() {
  const out = [];
  for (const t of towers) for (const s of t.storeys) {
    if (!s.group.visible) continue;
    for (const m of s.meshes) if (m.mesh.visible) out.push(m.mesh);
  }
  return out;
}

function raycast() {
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(visibleMeshes(), false)[0] || null;
}

function pick() {
  if (!pointerClient) return;
  const hit = raycast();
  setHover(hit?.object ?? null);
  showTip(hit ? { html: tipHTML(hit.object), x: pointerClient.x, y: pointerClient.y } : null);
}

function setHover(mesh) {
  if (hovered === mesh) return;
  if (hovered) hovered.material.emissive?.setHex(0x000000);
  hovered = mesh;
  if (mesh) mesh.material.emissive?.setHex(P.getMode() === 'dark' ? 0x333333 : 0x222222);
  $('stage').style.cursor = mesh ? 'pointer' : 'grab';
  needsRender = true;
}

function tipHTML(mesh) {
  const u = mesh.userData;
  const d = u.catData;
  const floor = u.floorData;
  const head = `<div class="tip-h">${esc(u.towerName)} · ${esc(u.floorMain)}</div>
    <div style="color:var(--text-muted);margin:-3px 0 7px;font-size:11px">
      ${esc(CATEGORY_LABEL[u.cat] || u.cat)}${u.floorSub ? ` · ${esc(u.floorSub)}` : ''}
    </div>`;

  if (d && d.n === 0 && u.why !== 'level-off') {
    return head + `<div style="color:var(--text-muted)">None of the selected activities for this element is scheduled on this level.</div>`;
  }
  if (!d || u.why === 'level-off') {
    const msg = u.why === 'beyond'
      ? `Not in ${esc(u.towerName)}'s schedule: its structure ends at ${esc(u.scheduleTop)}. This storey is in the model only.`
      : !floor
      ? 'No schedule level mapped to this storey'
      : u.why === 'level-off'
        ? 'This level is not selected in the Level filter.'
        : u.why === 'none-selected'
        ? 'No selected trade builds this element type. It is not scheduled separately for this tower.'
        : 'No schedule data for this element';
    return head + `<div style="color:var(--text-muted)">${msg}</div>`;
  }

  const lines = [['Complete', fmtPct(d.pct)], ['Tasks', `${fmtInt(d.done)} / ${fmtInt(d.n)} done`]];
  if (state.view === 'plan' || state.view === 'baseline') {
    const ps = dominantPlanState(state.view === 'plan' ? d.planState : d.baseState);
    if (ps) {
      lines.push([state.view === 'plan' ? 'vs plan' : 'vs baseline',
        `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${P.planStateColor(ps)};margin-right:5px;vertical-align:middle"></span>${esc(PLAN_STATE_LABEL[ps])}`]);
    }
  }
  const sq = (c) => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${c};margin-right:5px;vertical-align:middle"></span>`;
  const plannedSt = dominantPlanned(d.planned);
  if (plannedSt) lines.push(['Planned status', `${sq(P.taskStatusColor(plannedSt))}${esc(plannedSt)}`]);
  const domSt = dominantStatus(d.status);
  if (domSt && (state.view === 'planned' || state.view === 'actual')) {
    lines.push(['Actual status', `${sq(P.taskStatusColor(domSt))}${esc(domSt)}`]);
  } else if (domSt) {
    lines.push(['Actual status', `${sq(P.taskStatusColor(domSt))}${esc(domSt)}`]);
  }
  if (d.budget > 0) lines.push(['Value', `₹${fmtCr(d.earned)} of ₹${fmtCr(d.budget)} Cr`]);

  const tradeList = u.tradeNames?.length
    ? `<div style="margin-top:7px"><span style="color:var(--text-muted);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase">Activities on this element</span>
       <div style="color:var(--text-secondary);margin-top:2px">${u.tradeNames.slice(0, 5).map(esc).join(' · ')}${u.tradeNames.length > 5 ? ` +${u.tradeNames.length - 5}` : ''}</div></div>`
    : '';
  const live = d.active > 0
    ? `<div class="tip-sep"></div><div style="color:var(--warn-ink);font-weight:600">● ${fmtInt(d.active)} task${d.active > 1 ? 's' : ''} in progress here</div>` : '';

  return head
    + lines.map(([k, v]) => `<div class="tip-r"><span>${k}</span><b>${/^(Actual status|Planned status|vs plan|vs baseline)$/.test(k) ? v : esc(v)}</b></div>`).join('')
    + tradeList + live
    + '<div class="tip-sep"></div><div style="color:var(--text-muted);font-size:11px">Click to list these activities below</div>';
}

const tipEl = $('tip');
function showTip(t) {
  if (!t) { tipEl.classList.remove('on'); tipEl.setAttribute('aria-hidden', 'true'); return; }
  tipEl.innerHTML = t.html;
  tipEl.classList.add('on');
  tipEl.setAttribute('aria-hidden', 'false');
  const r = tipEl.getBoundingClientRect(), pad = 14;
  let x = t.x + pad, y = t.y + pad;
  if (x + r.width > innerWidth - 8) x = t.x - r.width - pad;
  if (y + r.height > innerHeight - 8) y = t.y - r.height - pad;
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${Math.max(8, y)}px`;
}


function clampDay(d) {
  const m = state.model;
  return Math.max(m.dayMin, Math.min(m.dayMax, Math.round(d)));
}

function buildTimeline() {
  const m = state.model;
  const r = $('dayRange');
  r.min = String(m.dayMin); r.max = String(m.dayMax); r.step = '1';
  r.value = String(state.day);
  r.oninput = () => { stopPlay(); setDay(Number(r.value)); };

  const di = $('dateInput');
  di.min = dayToISO(m.dayMin); di.max = dayToISO(m.dayMax);
  di.value = dayToISO(state.day);
  di.onchange = () => {
    const d = isoToDay(di.value);
    if (Number.isFinite(d)) { stopPlay(); setDay(clampDay(d)); }
  };

  $('todayBtn').onclick = () => { stopPlay(); setDay(m.asOfDay); };
  $('playBtn').onclick = () => (playTimer ? stopPlay() : startPlay());
  buildSpeed();

  const axis = $('tlAxis');
  axis.replaceChildren();
  const span = m.dayMax - m.dayMin;
  const pos = (d) => `${((d - m.dayMin) / span) * 100}%`;
  const y0 = new Date(m.dayMin * 86400000).getUTCFullYear();
  const y1 = new Date(m.dayMax * 86400000).getUTCFullYear();
  for (let y = y0 + 1; y <= y1; y++) {
    const d = Math.round(Date.UTC(y, 0, 1) / 86400000);
    if (d < m.dayMin || d > m.dayMax) continue;
    const el = document.createElement('span');
    el.textContent = String(y);
    el.style.left = pos(d);
    axis.append(el);
  }
  const now = document.createElement('span');
  now.className = 'now';
  now.textContent = 'today';
  now.style.left = pos(m.asOfDay);
  axis.append(now);
  tidyAxis();
}

function tidyAxis() {
  const now = $('tlAxis').querySelector('.now');
  if (!now) return;
  const n = now.getBoundingClientRect();
  for (const el of $('tlAxis').children) {
    if (el === now) continue;
    const r = el.getBoundingClientRect();
    el.style.visibility = r.right + 6 > n.left && r.left - 6 < n.right ? 'hidden' : '';
  }
}

function syncRange(r) {
  const min = Number(r.min) || 0, max = Number(r.max) || 100;
  r.style.setProperty('--p', `${((Number(r.value) - min) / (max - min || 1)) * 100}%`);
}
addEventListener('input', (e) => { if (e.target.matches?.('input[type=range]')) syncRange(e.target); });

function setDay(d) {
  state.day = clampDay(d);
  $('dayRange').value = String(state.day);
  $('dateInput').value = dayToISO(state.day);
  const fc = isForecast();
  $('timeline').classList.toggle('forecast', fc);
  $('fcFlag').hidden = !fc;
  apply();
}

const PLAY_TICK_MS = 100;

function buildSpeed() {
  const sel = $('speedSel');
  try {
    const saved = localStorage.getItem(SPEED_KEY);
    if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
  } catch {  }
  sel.onchange = () => {
    try { localStorage.setItem(SPEED_KEY, sel.value); } catch {  }
  };
}

function startPlay() {
  const m = state.model;
  if (state.day >= m.dayMax) state.day = m.dayMin;
  $('playBtn').classList.add('on');
  $('playIcon').innerHTML = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
  let pos = state.day;
  playTimer = setInterval(() => {
    if (state.day >= m.dayMax) { stopPlay(); return; }
    pos += (Number($('speedSel').value) * PLAY_TICK_MS) / 1000;
    setDay(pos);
  }, PLAY_TICK_MS);
}

function stopPlay() {
  const wasPlaying = Boolean(playTimer);
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
  if (wasPlaying) renderActivities();
  $('playBtn').classList.remove('on');
  $('playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>';
}

function renderTimelineRead(totals) {
  const box = $('tlRead');
  box.replaceChildren();
  if (!curves) return;
  const fc = isForecast();
  for (const [k, c, v] of [
    ['Baseline', 'var(--s-baseline)', selectionBaseline(state.day).value],
    ['Plan', 'var(--s-plan)', selectionValue(state.day, 'plan').value],
    [fc ? 'Forecast' : 'Earned', 'var(--s-earned)', totals ? totals.earned : curveAt(curves, fc ? curves.forecast : curves.earned, state.day)],
  ]) {
    const d = document.createElement('div');
    d.innerHTML = `<div class="k"><i style="background:${c}"></i>${k}</div>`
      + `<div class="v">₹${fmtCr(v)}<small>Cr</small></div>`;
    box.append(d);
  }
}


function tick() {
  requestAnimationFrame(tick);
  const moved = controls.update();
  if (pickDirty) { pickDirty = false; pick(); }
  if (!moved && !needsRender) return;
  needsRender = false;
  renderer.render(scene, camera);
  projectLabels();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

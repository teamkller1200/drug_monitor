import { expandDoses, simulate, valueAt, phaseAt, ethanolMg } from './pk.js';
import { evaluate, pkMods } from './interactions.js';
import { createStore, emptyData, validateData } from './store.js';
import * as op from './oplock.js';
import { Spring, dragY, project, reducedMotion, rubberband } from './motion.js';

const H = 3600e3;
const MIN = 60e3;
const RESIMULATE_MS = 10 * MIN;
const WINDOW_H = 12;
const VERIFIED_ONLY = !new URLSearchParams(location.search).has('dev');

const SEVERITY = { caution: '注意', danger: '危険', fatal: '命に関わる' };
const PHASE = { none: '-', onset: '立ち上がり', peak: 'ピーク域', comedown: 'コムダウン', gone: 'ほぼ消失' };
const ROUTE = { oral: '経口', sublingual: '舌下', nasal: '鼻腔', inhaled: '吸入', iv: '静注' };
const COLORS = ['#6fb5f5', '#d79bea', '#5bccd0', '#dbb47c', '#f08a7a', '#a8d672'];
const DASHES = [[], [8, 4], [1.5, 4.5], [10, 4, 2, 4]];
const SWATCH = ['solid', 'dashed', 'dotted', 'dashed'];
const TABS = { home: 'ホーム', history: '履歴', profile: 'プロフィール', settings: '設定' };
const ICON = {
  plus: 'M12 5v14M5 12h14',
  lock: 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3',
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'm9 6 6 6-6 6',
};
const CONTACTS = [
  ['救急車', '119', '意識がない、呼吸がおかしい、けいれんがあるときはすぐに'],
  ['大阪中毒110番(一般向け)', '072-727-2499', '中毒の相談'],
  ['つくば中毒110番(一般向け)', '029-852-9999', '中毒の相談'],
  ['よりそいホットライン', '0120-279-338', 'つらい気持ちの相談。毎日24時間'],
  ['こころの健康相談統一ダイヤル', '0570-064-556', 'お住まいの地域の窓口につながります'],
];

const store = createStore(localStorage);
const $ = (id) => document.getElementById(id);
let db = { drugs: [], products: [], rules: [], limits: [] };
let data = null;
let results = {};
let doses = [];
let lastSim = 0;
let tab = 'home';
let editing = null;
let lockState = store.readOpLock() ?? op.unlocked();
let lockKey = '';
let alertsKey = null;
let solo = null;
let current = { alerts: [], unknown: [] };

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return el;
}

function icon(name, size = 20) {
  const el = h('span', { className: 'ic', 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="${ICON[name]}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return el;
}

function toast(message) {
  $('toast').textContent = message;
  setTimeout(() => { if ($('toast').textContent === message) $('toast').textContent = ''; }, 4000);
}

const usable = (e) => !VERIFIED_ONLY || e.status !== 'draft';
const drugById = (id) => db.drugs.find((d) => d.id === id);
const nameOf = (id) => drugById(id)?.name ?? db.products.find((p) => p.id === id)?.name ?? id;

async function loadDb() {
  const get = async (f) => (await (await fetch(`data/${f}.json`)).json()).filter(usable);
  const [drugs, products, rules, limits] = await Promise.all(['drugs', 'products', 'interactions', 'limits'].map(get));
  db = {
    drugs,
    // A product is shown only when every ingredient is available, otherwise its curves would be incomplete.
    products: products.filter((p) => p.ingredients.every((i) => drugs.some((d) => d.id === i.drug))),
    rules,
    limits,
  };
}

function recompute() {
  const now = Date.now();
  doses = expandDoses(data.doses, db.products).filter((d) => drugById(d.drugId)?.routes[d.route]);
  const base = simulate(doses, db.drugs, data.profile, { now });
  results = db.rules.some((r) => r.kind === 'pk')
    ? simulate(doses, db.drugs, data.profile, { now, pkMods: pkMods(db.rules, base, db.drugs) })
    : base;
  lastSim = now;
}

function dispatch(action, fn) {
  if (!op.allowed(action, lockState, Date.now(), data?.settings)) {
    toast('操作ロック中です');
    return;
  }
  return fn();
}

async function commit(action, mutate) {
  await dispatch(action, async () => {
    mutate();
    try {
      await store.save(data);
    } catch {
      toast('保存に失敗しました。エクスポートでバックアップを取ってください');
    }
    recompute();
    render();
  });
}

function setLock(state) {
  lockState = state;
  store.writeOpLock(state);
  renderLock();
  render();
}

// ---- lock bar ----
function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}時間${mm}分` : `${mm}分${String(ss).padStart(2, '0')}秒`;
}

function renderLock() {
  const now = Date.now();
  const locked = op.isLocked(lockState, now);
  const key = !data ? 'closed' : !locked ? 'open' : op.waitOver(lockState, now) ? 'ready' : lockState.unlockAt ? 'wait' : 'locked';
  if (key === lockKey) {
    const t = $('lockTime');
    if (t) t.textContent = clock((key === 'wait' ? lockState.unlockAt : lockState.until) - now);
    return;
  }
  const wasLocked = !['open', 'closed', ''].includes(lockKey);
  lockKey = key;
  const box = $('lock');
  box.replaceChildren();
  if (key === 'closed' || key === 'open') {
    if (wasLocked && key === 'open') render();
    return;
  }
  const time = h('span', { id: 'lockTime' }, clock((key === 'wait' ? lockState.unlockAt : lockState.until) - now));
  const extend = h('button', { onclick: () => dispatch('lock:extend', () => { setLock(op.extend(lockState, Date.now(), 1)); lockKey = ''; renderLock(); }) }, '1時間延長');
  if (key === 'locked') {
    box.append(h('div', { className: 'lockbar row' },
      h('b', { className: 'grow' }, '操作ロック中 残り ', time),
      extend,
      h('button', { onclick: () => dispatch('unlock:request', () => {
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
        setLock(op.requestUnlock(lockState, Date.now(), code));
      }) }, '早期解除')));
  } else if (key === 'wait') {
    box.append(h('div', { className: 'lockbar row' },
      h('span', { className: 'grow' }, '解除まで待機中 ', time),
      h('button', { onclick: () => dispatch('unlock:cancel', () => setLock(op.cancelUnlock(lockState))) }, '取り消す')));
  } else {
    const input = h('input', { inputMode: 'numeric', autocomplete: 'off', 'aria-label': '数字を逆順に入力' });
    box.append(h('div', { className: 'lockbar' },
      h('div', {}, `${lockState.code} を逆から入力してください`),
      h('div', { className: 'row' },
        h('div', { className: 'grow' }, input),
        h('button', { onclick: () => dispatch('unlock:finish', () => {
          const next = op.finishUnlock(lockState, Date.now(), input.value.trim());
          if (op.isLocked(next, Date.now())) toast('一致しませんでした。もう一度待機が必要です');
          setLock(next);
        }) }, '解除'))));
  }
}

// ---- alerts ----
function currentAlerts() {
  return evaluate({ doses, results, drugs: db.drugs, rules: db.rules, limits: db.limits, now: Date.now() });
}

const alertText = (a) => h('p', {}, h('b', {}, a.items.map(nameOf).join(' + ')), `: ${a.mechanism ?? ''}`);

function renderAlerts() {
  const { alerts, unknown } = currentAlerts();
  const key = JSON.stringify([alerts, unknown]);
  if (key === alertsKey) return;
  alertsKey = key;
  current = { alerts, unknown };
  renderBell();
  if (sheetOpen && sheetKind === 'warn') fillSheet();
}

function renderBell() {
  const { alerts } = current;
  const badge = $('badge');
  badge.hidden = !alerts.length;
  if (alerts.length) {
    badge.className = alerts[0].severity;
    badge.textContent = `${SEVERITY[alerts[0].severity][0]}${alerts.length}`;
  }
  $('bell').setAttribute('aria-label', alerts.length ? `警告 ${alerts.length}件(最も重い: ${SEVERITY[alerts[0].severity]})。一覧を開く` : '警告一覧を開く');
}

// ---- sheets: warnings (bell, 緊急) and per-substance detail ----
let sheetOpen = false;
let sheetKind = null;
let sheetFocus = null;
let sheetFrom = null;

const sheetP = new Spring(0, (p) => {
  const el = $('sheet');
  $('scrim').style.opacity = Math.min(1, Math.max(0, p));
  if (reducedMotion.matches) {
    el.style.transform = 'none';
    el.style.opacity = p > 0 ? 1 : 0;
  } else if (sheetKind === 'detail') {
    el.style.transform = `translate3d(0,${(1 - p) * el.offsetHeight}px,0)`;
    el.style.opacity = 1;
  } else {
    el.style.transform = `scale(${0.86 + 0.14 * p})`;
    el.style.opacity = p;
  }
}, 0.002);

function sheetHead(title, grab) {
  return h('div', { className: `sheethead${grab ? ' grab' : ''}` },
    grab ? h('span', { className: 'handle' }) : null,
    h('div', { className: 'sheettitle' },
      h('h2', {}, title),
      h('button', { className: 'close', type: 'button', 'aria-label': '閉じる', onclick: () => closeSheet() }, icon('close', 18))));
}

function warnSheet() {
  const { alerts, unknown } = current;
  return [
    sheetHead(alerts.length ? `警告 ${alerts.length}件` : '警告'),
    h('div', { className: 'sheetbody' },
      h('div', { className: 'calls' },
        h('a', { className: 'call', href: 'tel:119' }, '119に電話'),
        h('a', { className: 'call', href: 'tel:072-727-2499' }, '大阪中毒110番')),
      h('button', { className: 'more', type: 'button', onclick: () => go('help') }, 'ほかの相談先'),
      alerts.length ? alerts.map((a) => h('section', { className: `alert ${a.severity}` },
        h('b', {}, SEVERITY[a.severity]), h('small', {}, `出典 ${a.source}`), alertText(a)))
        : h('p', { className: 'muted' }, '現在、検知された警告はありません。'),
      unknown.length ? h('details', { className: 'nodata' },
        h('summary', {}, `データなしの組み合わせ ${unknown.length}件(安全という意味ではありません)`),
        h('p', {}, '情報が見つかっていないだけで、影響がないことを示すものではありません。'),
        unknown.map(([a, b]) => h('div', {}, `${nameOf(a)} + ${nameOf(b)}`))) : null),
  ];
}

function detailSheet() {
  return [
    sheetHead('成分の詳細', true),
    h('div', { className: 'sheetbody' },
      h('p', { className: 'muted' }, '推定値です。ピーク比は、各物質の推定ピークを100%とした値です。'),
      Object.keys(results).map(drugCard)),
  ];
}

function fillSheet() {
  const scroll = $('sheet').querySelector('.sheetbody')?.scrollTop ?? 0;
  $('sheet').replaceChildren(...(sheetKind === 'warn' ? warnSheet() : detailSheet()));
  const body = $('sheet').querySelector('.sheetbody');
  if (body) body.scrollTop = scroll;
  if (tab === 'home') tickHome();
}

function setBackdropInert(on) {
  for (const id of ['top', 'lock', 'view', 'nav']) $(id).inert = on;
}

function openSheet(kind, from, focus = null) {
  sheetKind = kind;
  sheetFocus = focus;
  sheetFrom = from;
  sheetOpen = true;
  const el = $('sheet');
  el.className = kind;
  el.setAttribute('aria-label', kind === 'warn' ? '警告一覧' : '成分の詳細');
  el.hidden = false;
  $('scrim').hidden = false;
  el.replaceChildren();
  fillSheet();
  if (focus) $(`d-${focus}`)?.scrollIntoView({ block: 'center' });
  setBackdropInert(true);
  sheetP.to(1);
  el.querySelector('.close').focus({ preventScroll: true });
}

function closeSheet(v = 0, z = 1) {
  if (!sheetOpen) return;
  sheetOpen = false;
  setBackdropInert(false);
  sheetP.to(0, { v, z, cb: () => {
    if (sheetOpen) return;
    $('sheet').hidden = true;
    $('scrim').hidden = true;
  } });
  if (sheetFrom?.isConnected) sheetFrom.focus({ preventScroll: true });
}

function resetSheet() {
  sheetOpen = false;
  sheetP.set(0);
  setBackdropInert(false);
  $('sheet').hidden = true;
  $('scrim').hidden = true;
}

// ---- home ----
function drugCard(id) {
  const drug = drugById(id);
  return h('article', { className: `drow${id === sheetFocus ? ' on' : ''}`, id: `d-${id}` },
    h('div', { className: 'dhead' },
      h('h3', {}, drug.name),
      drug.status === 'estimated' ? h('span', { className: 'badge' }, '概算') : null,
      h('span', { className: 'phase', id: `p-${id}` })),
    h('div', { className: 'dval' },
      h('span', { className: 'value', id: `v-${id}` }),
      h('span', { className: 'muted', id: `r-${id}` })),
    h('div', { className: 'muted', id: `m-${id}` }),
    drug.ref ? h('div', { className: 'muted full' }, `体感の目安: 発現 ${drug.ref.onset} / 持続 ${drug.ref.duration} / 余韻 ${drug.ref.after}`) : null,
    h('details', { className: 'full' },
      h('summary', {}, '詳細と出典'),
      h('div', {}, `半減期 ${drug.central.halfLifeH ?? '非線形'} h / 個人差の幅 ±${Math.round((drug.cv ?? 0) * 100)}%`),
      h('div', {}, `補正に使える項目: ${(drug.covariates ?? []).map((c) => c.on).join(', ') || 'なし'}`),
      drug.note ? h('div', {}, drug.note) : null,
      h('div', {}, `出典: ${drug.source}`),
      drug.ref ? h('div', {}, '体感の目安の出典: TripSit') : null,
      h('div', {}, '線形モデルの推定です。実際の値から大きく外れることがあります。')));
}

function renderHome() {
  const ids = Object.keys(results);
  const blocked = !op.allowed('dose:add', lockState, Date.now(), data.settings);
  if (!ids.includes(solo)) solo = null;
  const chips = ids.map((id, i) => h('button', { className: 'chip', type: 'button', 'data-id': id, 'aria-pressed': String(id === solo), 'aria-label': `${nameOf(id)}のグラフだけを表示`, onclick: () => toggleSolo(id) },
    h('span', { className: 'swatch', style: `border-top-color:${COLORS[i % COLORS.length]};border-top-style:${SWATCH[i % SWATCH.length]}` }), nameOf(id)));
  return [h('div', { className: 'home' },
    ids.length
      ? h('section', { className: 'glass chartcard', 'aria-label': '濃度タイムライン' },
        h('div', { className: 'hero', id: 'hero' },
          h('div', { className: 'heroName', id: 'heroName' },
            h('span', { className: 'heroDot', id: 'heroDot' }), h('span', { id: 'heroLabel' })),
          h('div', { className: 'heroVal' }, h('span', { id: 'heroPct' }), h('span', { className: 'heroUnit' }, '%')),
          h('div', { className: 'heroSub', id: 'heroSub' })),
        h('div', { className: 'plot' },
          h('canvas', { id: 'chart', role: 'img', 'aria-label': `過去${WINDOW_H}時間から未来${WINDOW_H}時間の濃度の推移。縦軸は各物質のピークを100%とした割合。横にスクロールできます。` })),
        h('div', { className: 'chips' }, chips,
          h('button', { className: 'detailrow', type: 'button', onclick: (e) => openSheet('detail', e.currentTarget) }, h('span', {}, '成分ごとの詳細'), icon('chevron', 18))))
      : h('div', { className: 'glass chartcard empty muted' }, db.drugs.length
        ? '記録はまだありません。'
        : '検証済みの物質がまだありません。出典を確認したデータから順に表示されます。'),
    h('button', { className: 'rec', type: 'button', disabled: blocked, onclick: () => dispatch('nav', () => go('log')) },
      icon(blocked ? 'lock' : 'plus', 24), blocked ? '記録(操作ロック中は停止)' : '記録'))];
}

// Updates in place: a full render would rebuild the chips and drop keyboard focus.
function toggleSolo(id) {
  solo = solo === id ? null : id;
  for (const chip of document.querySelectorAll('.chip')) chip.setAttribute('aria-pressed', String(chip.dataset.id === solo));
  tickHome();
}

// The headline above the graph: same peak-ratio scale as the chart, so substances are comparable.
function updateHero(now) {
  if (!$('heroLabel')) return;
  const pctOf = (r, values) => (r.peak ? (valueAt(r.t, values, now) / r.peak) * 100 : 0);
  let best = null;
  Object.entries(results).forEach(([id, r], i) => {
    if (solo && id !== solo) return;
    const pct = pctOf(r, r.ce);
    if (!best || pct > best.pct) best = { id, r, i, pct };
  });
  if (!best) return;
  const drug = drugById(best.id);
  $('heroLabel').textContent = drug?.name ?? best.id;
  $('heroPct').textContent = best.pct.toFixed(1);
  $('heroDot').style.background = COLORS[best.i % COLORS.length];
  const blood = valueAt(best.r.t, best.r.c, now);
  const band = `${pctOf(best.r, best.r.low).toFixed(0)}-${pctOf(best.r, best.r.high).toFixed(0)}%`;
  $('heroSub').textContent = `${drug?.status === 'estimated' ? '概算 ・ ' : ''}ピーク比 ・ 幅 ${band} ・ 血中 約${blood.toFixed(2)} mg/L ・ ${PHASE[phaseAt(best.r, now)]}`;
}

function tickHome() {
  const now = Date.now();
  for (const [id, r] of Object.entries(results)) {
    const v = $(`v-${id}`);
    if (!v) continue;
    const pct = (arr) => (r.peak ? (valueAt(r.t, arr, now) / r.peak) * 100 : 0);
    v.textContent = `${pct(r.ce).toFixed(1)}%`;
    $(`p-${id}`).textContent = PHASE[phaseAt(r, now)];
    $(`r-${id}`).textContent = `範囲 ${pct(r.low).toFixed(0)}-${pct(r.high).toFixed(0)}%`;
    $(`m-${id}`).textContent = `血中 約${valueAt(r.t, r.c, now).toFixed(2)} mg/L`;
  }
  updateHero(now);
  drawChart(now);
}

function drawChart(now) {
  const canvas = $('chart');
  if (!canvas) return;
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, ht = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(ht * dpr)) canvas.height = Math.round(ht * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, ht);
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue('--muted');
  // Start at the first recorded dose (at most 12h back) so no empty history is drawn.
  const firstData = Math.min(...Object.values(results).map((r) => r.t[0]));
  const from = Math.min(now, Math.max(now - WINDOW_H * H, Number.isFinite(firstData) ? firstData : now));
  const to = from + 2 * WINDOW_H * H;
  // Colors stay tied to the full list so a substance keeps its color when shown alone.
  const entries = Object.entries(results).map(([id, r], i) => ({ id, r, i })).filter((e) => !solo || e.id === solo);
  const yMax = Math.max(1.1, ...entries.map(({ r }) => Math.max(...r.high) / (r.peak || 1)));
  const [L, R, T, B] = [34, 10, 22, 24];
  const x = (t) => L + ((t - from) / (to - from)) * (w - L - R);
  // The canvas is twice the visible width. Open with the "now" line at the right edge,
  // and keep the % axis pinned to the left edge of whatever part of the timeline is shown.
  const scroller = canvas.parentElement;
  if (scroller && !canvas.dataset.scrollBound) {
    canvas.dataset.scrollBound = '1';
    scroller.addEventListener('scroll', () => drawChart(Date.now()), { passive: true });
    scroller.scrollLeft = x(now) - (scroller.clientWidth - R);
  }
  const sx = scroller ? scroller.scrollLeft : 0;
  const y = (v) => ht - B - (v / yMax) * (ht - T - B);
  const label = (text, px, py, align = 'left') => {
    c.textAlign = align;
    c.fillText(text, px, py);
  };

  c.fillStyle = 'rgba(255,255,255,.05)';
  c.fillRect(x(now), T, w - R - x(now), ht - T - B);
  c.fillStyle = muted;
  c.font = '11.5px system-ui';
  c.strokeStyle = style.getPropertyValue('--line');
  c.lineWidth = 1;
  for (const v of [0, 0.5, 1]) {
    c.beginPath();
    c.moveTo(L, y(v));
    c.lineTo(w - R, y(v));
    c.stroke();
  }
  const stepH = 3;
  for (let k = Math.ceil((from - now) / (stepH * H)); k * stepH <= (to - now) / H; k++) {
    const t = k * stepH;
    if (!t) continue;
    const px = x(now + t * H);
    label(`${t > 0 ? '+' : '−'}${Math.abs(t)}h`, px, ht - 6, px > w - R - 16 ? 'right' : px < L + 16 ? 'left' : 'center');
  }
  entries.forEach(({ r, i }) => {
    const color = COLORS[i % COLORS.length];
    const idx = r.t.flatMap((t, k) => (t >= from && t <= to ? [k] : []));
    if (!idx.length) return;
    c.fillStyle = color;
    c.globalAlpha = 0.16;
    c.beginPath();
    idx.forEach((k) => c.lineTo(x(r.t[k]), y(r.high[k] / r.peak)));
    [...idx].reverse().forEach((k) => c.lineTo(x(r.t[k]), y(r.low[k] / r.peak)));
    c.closePath();
    c.fill();
    c.globalAlpha = 1;
    c.strokeStyle = color;
    c.lineWidth = 2.6;
    c.setLineDash(DASHES[i % DASHES.length]);
    c.beginPath();
    idx.forEach((k) => c.lineTo(x(r.t[k]), y(r.ce[k] / r.peak)));
    c.stroke();
    c.setLineDash([]);
  });

  c.strokeStyle = style.getPropertyValue('--text');
  c.lineWidth = 1.8;
  c.beginPath();
  c.moveTo(x(now), T - 6);
  c.lineTo(x(now), ht - B);
  c.stroke();
  c.fillStyle = style.getPropertyValue('--text');
  c.font = '700 13px system-ui';
  label('今', Math.max(x(now), L + 14), ht - 6, 'center');
  entries.forEach(({ r, i }) => {
    c.beginPath();
    c.arc(x(now), y(valueAt(r.t, r.ce, now) / (r.peak || 1)), 4.5, 0, 2 * Math.PI);
    c.fillStyle = style.getPropertyValue('--bg');
    c.fill();
    c.strokeStyle = COLORS[i % COLORS.length];
    c.lineWidth = 2.4;
    c.stroke();
  });

  // Redraw the axis in a gutter at the current scroll offset so the % scale stays readable.
  c.clearRect(sx, T, L, ht - T - B);
  c.fillStyle = muted;
  c.font = '11.5px system-ui';
  for (const v of [0, 0.5, 1]) label(`${v * 100}%`, sx + L - 5, y(v) + 4, 'right');
  label('ピーク比 %', sx + 2, 11);
}

// ---- log ----
const localInput = (d) => {
  const t = new Date(d);
  return new Date(t.getTime() - t.getTimezoneOffset() * MIN).toISOString().slice(0, 16);
};

function routesFor(itemId) {
  const p = db.products.find((x) => x.id === itemId);
  const sets = (p ? p.ingredients.map((i) => i.drug) : [itemId]).map((id) => Object.keys(drugById(id)?.routes ?? {}));
  return sets.length ? sets[0].filter((r) => sets.every((s) => s.includes(r))) : [];
}

function addDose(entry) {
  return commit('dose:add', () => data.doses.push({ id: crypto.randomUUID(), ...entry }));
}

function renderLog() {
  const items = [...db.products, ...db.drugs];
  if (!items.length) return [h('div', { className: 'card muted' }, '記録できる物質がまだありません。')];
  const blocked = !op.allowed(editing ? 'dose:edit' : 'dose:add', lockState, Date.now(), data.settings);
  const src = editing ?? { itemId: data.doses.at(-1)?.itemId ?? items[0].id, route: data.doses.at(-1)?.route, amount: {} };
  const item = h('select', { id: 'item' },
    db.products.length ? h('optgroup', { label: '製品' }, db.products.map((p) => h('option', { value: p.id }, p.name))) : null,
    h('optgroup', { label: '物質' }, db.drugs.map((d) => h('option', { value: d.id }, d.name))));
  item.value = src.itemId;
  const route = h('select', { id: 'route' });
  const fillRoutes = () => {
    route.replaceChildren(...routesFor(item.value).map((r) => h('option', { value: r }, ROUTE[r] ?? r)));
    if (routesFor(item.value).includes(src.route)) route.value = src.route;
  };
  item.addEventListener('change', fillRoutes);
  fillRoutes();
  const sv = src.serving;
  const min = h('input', { id: 'min', type: 'number', min: '0', step: 'any', inputMode: 'decimal', value: sv ? sv.mlMin : src.itemId === 'alcohol' ? '' : src.amount.min ?? '' });
  const max = h('input', { id: 'max', type: 'number', min: '0', step: 'any', inputMode: 'decimal', value: sv ? (sv.mlMax !== sv.mlMin ? sv.mlMax : '') : src.itemId === 'alcohol' ? '' : src.amount.max !== src.amount.min ? src.amount.max ?? '' : '' });
  const abv = h('input', { id: 'abv', type: 'number', min: '0', max: '100', step: 'any', inputMode: 'decimal', value: sv?.abv ?? '' });
  const abvLabel = h('label', { className: 'grow' }, '度数(%)', abv);
  const minText = document.createTextNode('');
  const minLabel = h('label', { className: 'grow' }, minText, min);
  const isAlcohol = () => item.value === 'alcohol';
  const syncUnit = () => {
    abvLabel.hidden = !isAlcohol();
    minText.textContent = isAlcohol() ? '量(ml)' : '量(mg、製品は個数)';
  };
  item.addEventListener('change', syncUnit);
  syncUnit();
  const when = h('input', { id: 'when', type: 'datetime-local', value: localInput(src.takenAt ?? Date.now()) });
  const submit = async (e) => {
    e.preventDefault();
    let lo = Number(min.value), hi = max.value === '' ? lo : Number(max.value);
    const takenAt = new Date(when.value);
    const pct = Number(abv.value);
    if (!(lo > 0) || !(hi >= lo) || Number.isNaN(takenAt.getTime()) || !route.value || (isAlcohol() && !(pct > 0 && pct <= 100))) {
      toast(isAlcohol() ? '度数・量・時刻を確認してください(度数は0〜100%、最大は最小以上)' : '量と時刻を確認してください(最大は最小以上)');
      return;
    }
    const serving = isAlcohol() ? { abv: pct, mlMin: lo, mlMax: hi } : undefined;
    if (serving) { lo = ethanolMg(lo, pct); hi = ethanolMg(hi, pct); }
    const entry = { itemId: item.value, route: route.value, takenAt: takenAt.toISOString(), amount: { min: lo, max: hi }, serving };
    const back = editing ? 'history' : 'home';
    if (editing) {
      const id = editing.id;
      await commit('dose:edit', () => { Object.assign(data.doses.find((d) => d.id === id), entry); editing = null; });
    } else {
      await addDose(entry);
    }
    toast('記録しました');
    go(back);
  };
  const last = data.doses.at(-1);
  return [
    h('form', { className: 'card', onsubmit: submit },
      h('fieldset', { disabled: blocked },
        h('label', {}, '製品・物質', item),
        h('label', {}, '投与経路', route),
        h('div', { className: 'row' },
          abvLabel, minLabel,
          h('label', { className: 'grow' }, '最大(不確かなとき)', max)),
        h('label', {}, '時刻', when),
        h('button', { className: 'primary', type: 'submit' }, editing ? '更新' : '記録する'))),
    last && !editing ? h('button', { disabled: blocked, onclick: () => addDose({ ...last, id: undefined, takenAt: new Date().toISOString() }).then(() => { toast('記録しました'); go('home'); }) },
      `直前と同じ内容を今記録(${doseText(last)})`) : null,
  ];
}

const doseText = (d) => d.serving
  ? `${nameOf(d.itemId)} ${d.serving.abv}% ${d.serving.mlMin}${d.serving.mlMax !== d.serving.mlMin ? `-${d.serving.mlMax}` : ''}ml`
  : `${nameOf(d.itemId)} ${d.amount.min}${d.amount.max !== d.amount.min ? `-${d.amount.max}` : ''}`;

// ---- history ----
function renderHistory() {
  if (!data.doses.length) return [h('div', { className: 'card muted' }, '履歴はありません。')];
  const blocked = !op.allowed('dose:edit', lockState, Date.now(), data.settings);
  return [...data.doses].sort((a, b) => new Date(b.takenAt) - new Date(a.takenAt)).map((d) =>
    h('div', { className: 'card row' },
      h('div', { className: 'grow' },
        h('div', {}, doseText(d)),
        h('div', { className: 'muted' }, `${new Date(d.takenAt).toLocaleString('ja-JP')} / ${ROUTE[d.route] ?? d.route}`)),
      h('button', { disabled: blocked, onclick: () => { editing = d; go('log'); } }, '編集'),
      h('button', { disabled: blocked, onclick: () => {
        if (confirm('この記録を削除しますか?')) commit('dose:delete', () => { data.doses = data.doses.filter((x) => x.id !== d.id); });
      } }, '削除')));
}

// ---- profile ----
function renderProfile() {
  const p = data.profile;
  const num = (id, value) => h('input', { id, type: 'number', min: '0', step: 'any', inputMode: 'decimal', value: value ?? '' });
  const sel = (id, value, opts) => {
    const s = h('select', { id }, Object.entries(opts).map(([v, t]) => h('option', { value: v }, t)));
    s.value = value ?? '';
    return s;
  };
  const wt = num('wt', p.weightKg), age = num('age', p.age), egfr = num('egfr', p.egfr);
  const sex = sel('sex', p.sex, { '': '未入力', male: '男性', female: '女性' });
  const cyp = sel('cyp', p.cyp2d6, { '': '不明', normal: '通常', low: '低下', poor: '欠損' });
  const smoker = h('input', { id: 'smoker', type: 'checkbox', checked: !!p.smoker });
  const submit = (e) => {
    e.preventDefault();
    const weightKg = Number(wt.value);
    if (!(weightKg > 0)) { toast('体重を入力してください'); return; }
    const opt = (v) => (v === '' ? undefined : Number(v));
    commit('settings:update', () => {
      data.profile = { weightKg, age: opt(age.value), egfr: opt(egfr.value), sex: sex.value || undefined, cyp2d6: cyp.value || undefined, smoker: smoker.checked };
    }).then(() => toast('保存しました'));
  };
  return [h('form', { className: 'card', onsubmit: submit },
    h('fieldset', { disabled: !op.allowed('settings:update', lockState, Date.now()) },
      h('label', {}, '体重 (kg)', wt),
      h('label', {}, '年齢', age),
      h('label', {}, '性別', sex),
      h('label', { className: 'check' }, smoker, '喫煙する'),
      h('label', {}, '腎機能 eGFR(任意)', egfr),
      h('label', {}, 'CYP2D6 型(任意)', cyp),
      h('button', { className: 'primary', type: 'submit' }, '保存')))];
}

// ---- first-run tour: the profile comes before anything else ----
let tourStep = 0;
let tourDraft = null;
let tourSpec = null;

const tourOpt = (v) => {
  const n = Number(v);
  return v === '' || v === undefined || v === null || !Number.isFinite(n) ? undefined : n;
};

function tourSteps() {
  const p = tourDraft;
  const num = (key) => h('input', {
    type: 'number', inputMode: 'decimal', min: '0', step: 'any', value: p[key] ?? '',
    oninput: (e) => { p[key] = e.target.value; tourValidity(); },
  });
  const sel = (key, opts) => {
    const s = h('select', { onchange: (e) => { p[key] = e.target.value; } },
      Object.entries(opts).map(([v, t]) => h('option', { value: v }, t)));
    s.value = p[key] ?? '';
    return s;
  };
  const has = (v) => v !== '' && v !== undefined && v !== null;
  const rows = [
    ['体重', Number(p.weightKg) > 0 ? `${Number(p.weightKg)} kg` : '未入力'],
    ['年齢', has(p.age) ? `${p.age} 歳` : '未入力'],
    ['性別', { male: '男性', female: '女性' }[p.sex] ?? '未入力'],
    ['喫煙', p.smoker ? 'する' : 'しない'],
    ['腎機能 eGFR', has(p.egfr) ? String(p.egfr) : '未入力'],
    ['CYP2D6 型', { normal: '通常', low: '低下', poor: '欠損' }[p.cyp2d6] ?? '不明'],
  ];
  return [
    {
      title: 'はじめに',
      body: () => [
        h('p', {}, '飲んだ薬や物質の、予想される血中濃度と作用の段階を表示します。'),
        h('p', { className: 'muted' }, '表示は母集団平均に基づく推定で、実際の血中濃度とは大きく異なることがあります。服薬・用量の判断には使わないでください。'),
        h('p', {}, '計算に使うプロフィールを先に入力します。データは端末内にのみ保存されます。'),
      ],
      label: 'はじめる',
      valid: () => true,
    },
    {
      title: '体重',
      body: () => [
        h('p', { className: 'muted' }, '血中濃度の計算に使います。'),
        h('label', {}, '体重 (kg)', num('weightKg')),
      ],
      valid: () => Number(p.weightKg) > 0,
      error: '体重を入力してください',
    },
    {
      title: '年齢と性別',
      body: () => [
        h('p', { className: 'muted' }, 'わからなければ未入力のままで構いません。'),
        h('label', {}, '年齢', num('age')),
        h('label', {}, '性別', sel('sex', { '': '未入力', male: '男性', female: '女性' })),
      ],
      valid: () => true,
    },
    {
      title: '喫煙',
      body: () => [
        h('p', { className: 'muted' }, '喫煙は一部の薬の代謝を速めます。'),
        h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: !!p.smoker, onchange: (e) => { p.smoker = e.target.checked; } }), '喫煙する'),
      ],
      valid: () => true,
    },
    {
      title: '腎機能と体質',
      body: () => [
        h('p', { className: 'muted' }, '検査結果や遺伝子型がわかる場合だけ入力してください。未入力でも推定します。'),
        h('label', {}, '腎機能 eGFR(任意)', num('egfr')),
        h('label', {}, 'CYP2D6 型(任意)', sel('cyp2d6', { '': '不明', normal: '通常', low: '低下', poor: '欠損' })),
      ],
      valid: () => true,
    },
    {
      title: '確認',
      body: () => [
        ...rows.map(([k, v]) => h('div', { className: 'kv' }, h('span', { className: 'muted' }, k), h('b', {}, v))),
        h('p', { className: 'muted note' }, 'あとからプロフィール画面で変更できます。'),
      ],
      label: '保存してはじめる',
      valid: () => Number(p.weightKg) > 0,
      error: '体重を入力してください',
    },
  ];
}

function tourValidity() {
  const btn = $('tour').querySelector('.foot .primary');
  if (btn && tourSpec) btn.disabled = !tourSpec.valid();
}

function renderTour() {
  const steps = tourSteps();
  tourSpec = steps[tourStep];
  const title = h('h2', { tabindex: '-1' }, tourSpec.title);
  const next = h('button', { className: 'primary', type: 'button', disabled: !tourSpec.valid() }, tourSpec.label ?? '次へ');
  next.addEventListener('click', () => tourNext(steps));
  $('tour').replaceChildren(h('div', { className: 'glass tourcard' },
    h('div', { className: 'tourtop' },
      h('span', { className: 'step' }, `${tourStep + 1} / ${steps.length}`),
      h('span', { className: 'dots', 'aria-hidden': 'true' }, steps.map((_, i) => h('i', { className: i <= tourStep ? 'on' : '' }))),
      h('button', { className: 'skip', type: 'button', onclick: skipTour }, 'スキップ')),
    h('div', { className: 'tourbody' }, title, ...tourSpec.body()),
    h('div', { className: 'foot' },
      tourStep ? h('button', { type: 'button', onclick: () => { tourStep -= 1; renderTour(); } }, '戻る') : null,
      next)));
  title.focus({ preventScroll: true });
}

function tourNext(steps) {
  if (!tourSpec.valid()) { toast(tourSpec.error ?? '入力してください'); return; }
  if (tourStep < steps.length - 1) { tourStep += 1; renderTour(); return; }
  const p = tourDraft;
  commit('settings:update', () => {
    data.profile = {
      weightKg: Number(p.weightKg), age: tourOpt(p.age), egfr: tourOpt(p.egfr),
      sex: p.sex || undefined, cyp2d6: p.cyp2d6 || undefined, smoker: !!p.smoker,
    };
    data.settings.tourDone = true;
  }).then(() => { closeTour(); go('home'); toast('プロフィールを保存しました'); });
}

function skipTour() {
  // Skipping still counts as done; the profile falls back to its defaults until it is edited.
  commit('settings:update', () => { data.settings.tourDone = true; })
    .then(() => { closeTour(); go('home'); toast('あとからプロフィールで入力できます'); });
}

function showTour(prefill = true) {
  tourStep = 0;
  tourDraft = prefill ? { ...(data.profile ?? {}) } : {};
  $('tour').hidden = false;
  setBackdropInert(true);
  renderTour();
}

function closeTour() {
  tourStep = 0;
  tourDraft = null;
  tourSpec = null;
  $('tour').replaceChildren();
  $('tour').hidden = true;
  setBackdropInert(false);
}

// ---- settings ----
function exportData() {
  dispatch('data:export', () => {
    if (!confirm('エクスポートしたファイルは平文です。保管場所に注意してください。続けますか?')) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: `drug-monitor-${new Date().toISOString().slice(0, 10)}.json` }).click();
    URL.revokeObjectURL(url);
  });
}

async function importData(file) {
  try {
    const next = validateData(JSON.parse(await file.text()));
    if (!confirm('現在のデータを読み込んだ内容で置き換えますか?')) return;
    await commit('data:import', () => { data = next; });
    toast('読み込みました');
  } catch (e) {
    toast(e.message);
  }
}

function wipe() {
  dispatch('data:wipe', () => {
    if (prompt('全データを削除します。元に戻せません。実行するには「削除」と入力してください') !== '削除') return;
    store.wipe();
    data = emptyData();
    store.save(data);
    lockState = op.unlocked();
    store.writeOpLock(lockState);
    tab = 'profile';
    render();
    renderLock();
    showTour(false);
  });
}

function renderSettings() {
  const now = Date.now();
  const locked = op.isLocked(lockState, now);
  const allowAdd = h('input', { type: 'checkbox', checked: !!data.settings.allowAddWhileLocked,
    onchange: (e) => commit('settings:update', () => { data.settings.allowAddWhileLocked = e.target.checked; }) });
  return [
    h('h2', {}, '操作ロック'),
    h('div', { className: 'card' },
      h('p', { className: 'muted' }, '表示はそのままで、記録や削除などの操作を止めます。誤操作を減らす歯止めで、意図的な回避までは防げません。'),
      h('div', { className: 'row' }, op.LOCK_HOURS.map((n) => h('button', { disabled: locked, onclick: () => setLock(op.start(lockState, Date.now(), n)) }, `${n}時間`)))),
    h('h2', {}, 'データ'),
    h('fieldset', { className: 'card', disabled: locked },
      h('label', { className: 'check' }, allowAdd, 'ロック中も記録の追加を許可'),
      h('div', { className: 'row' },
        h('button', { onclick: exportData }, 'エクスポート'),
        h('label', {}, 'インポート', h('input', { type: 'file', accept: 'application/json', onchange: (e) => e.target.files[0] && importData(e.target.files[0]) }))),
      h('button', { onclick: wipe }, '全データを削除')),
  ];
}

function renderHelp() {
  return [h('div', { className: 'card' },
    CONTACTS.map(([name, tel, note]) => h('div', {},
      h('a', { className: 'tel', href: `tel:${tel}` }, `${name} ${tel}`),
      h('div', { className: 'muted' }, note))),
    h('p', { className: 'muted' }, '受付時間は変わることがあります。'))];
}

// ---- shell ----
const VIEWS = { home: renderHome, log: renderLog, history: renderHistory, profile: renderProfile, settings: renderSettings, help: renderHelp };

function go(next) {
  closeSheet();
  if (next !== 'log') editing = null;
  tab = next;
  render();
}

function render() {
  if (!data) return;
  $('nav').replaceChildren(...Object.entries(TABS).map(([id, label]) =>
    h('button', { 'aria-current': id === tab ? 'page' : 'false', onclick: () => dispatch('nav', () => go(id)) }, label)));
  $('actions').hidden = false;
  $('view').replaceChildren(...VIEWS[tab]().flat());
  renderAlerts();
  if (sheetOpen) fillSheet();
  if (tab === 'home') tickHome();
}

function boot() {
  if (store.hasLegacyVault()) {
    showMigration();
    return;
  }
  const fresh = !store.hasVault();
  data = fresh ? emptyData() : validateData(store.read());
  if (fresh) store.save(data);
  recompute();
  tab = fresh ? 'profile' : 'home';
  render();
  renderLock();
  if (!data.settings?.tourDone) showTour(!fresh);
}

// Older versions encrypted the vault with a password. Read it once, then keep it plain.
function showMigration() {
  alertsKey = null;
  current = { alerts: [], unknown: [] };
  resetSheet();
  lockKey = '';
  $('actions').hidden = true;
  $('lock').replaceChildren();
  $('nav').replaceChildren();
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      data = validateData(await store.unlockLegacy(pw.value));
      // Migrated installs already have a profile, so the first-run tour stays away.
      if (!data.settings.tourDone) { data.settings.tourDone = true; store.save(data); }
    } catch {
      toast('パスワードが違います');
      return;
    }
    recompute();
    tab = 'home';
    render();
    renderLock();
  };
  $('view').replaceChildren(
    h('form', { className: 'card', onsubmit: submit },
      h('p', { className: 'muted' }, 'パスワードロックを解除して、保存形式を移行します。次回からはパスワードなしで開きます。'),
      h('label', {}, '現在のパスワード', pw),
      h('button', { className: 'primary', type: 'submit' }, '解除して移行')),
    ...renderHelp(),
    h('button', { onclick: wipe }, 'パスワードを忘れた(全データを削除)'),
  );
}

function tick() {
  if (!data || document.hidden) return;
  const now = Date.now();
  if (now - lastSim > RESIMULATE_MS) recompute();
  renderLock();
  renderAlerts();
  if (tab === 'home') tickHome();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && data) { recompute(); tick(); }
});

let dragFrom = 1;
dragY($('sheet'), '.grab', {
  onStart: () => { sheetP.stop(); dragFrom = sheetP.x; },
  onMove: (dy) => {
    const span = $('sheet').offsetHeight, p = dragFrom - dy / span;
    sheetP.set(p > 1 ? 1 + rubberband((p - 1) * span, span) / span : p);
  },
  onEnd: (v, cancel) => {
    const span = $('sheet').offsetHeight, vp = -v / span, z = Math.abs(v) > 300 ? 0.8 : 1;
    if (!cancel && sheetP.x + project(vp) < 0.5) closeSheet(vp, z);
    else sheetP.to(1, { v: vp, z });
  },
});

$('bell').addEventListener('click', (e) => openSheet('warn', e.currentTarget));
$('sos').addEventListener('click', (e) => openSheet('warn', e.currentTarget));
$('scrim').addEventListener('click', () => closeSheet());
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

await loadDb();
boot();
setInterval(tick, 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

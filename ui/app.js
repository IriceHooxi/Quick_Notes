/* 笺 · 周日程 + 便签 TODO
 * 纯原生 JS，无框架。渲染采用“按 key 复用 DOM”的轻量对账，
 * 只在数据变化或每分钟一次时更新，空闲时不占用 CPU。 */
'use strict';
(() => {

// ───────────────────────── 工具 ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const EASE = 'cubic-bezier(.22,.9,.25,1)';
const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const composing = e => e.isComposing || e.keyCode === 229;   // 中文输入法组字中

const native = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge);
const send = (type, payload = {}) => { if (native) window.webkit.messageHandlers.bridge.postMessage(JSON.stringify({ type, ...payload })); };
if (!native) document.body.classList.add('preview');

// 日期：统一用本地日期字符串 YYYY-MM-DD，时间用“当天第几分钟”
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const shift = (s, n) => ymd(addDays(parse(s), n));
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const hm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
// 现在几点：默认跟随系统，也可以在设置里指定时区（日程记的是“几点几分”，跟着所选时区的钟走）
const SYS_TZ = (() => { try { return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
const zfmts = new Map();
function zfmt(tz) {   // 每个时区缓存一个格式器：创建它比使用它贵得多
  let f = zfmts.get(tz);
  if (!f) zfmts.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }));
  return f;
}
const validTz = tz => { try { return typeof tz === 'string' && !!zfmt(tz); } catch { return false; } };
const realTz = id => id === 'system' ? SYS_TZ : id;
function wallIn(tz, t) {   // 某时区在 t 时刻的钟面：{ ds: 'YYYY-MM-DD', min: 当天第几分钟 }
  const p = {};
  for (const x of zfmt(tz).formatToParts(t)) p[x.type] = x.value;
  return { ds: `${p.year}-${pad(p.month)}-${pad(p.day)}`, min: (+p.hour % 24) * 60 + +p.minute };
}
let clk = {};
function clock() {   // 现在（按设置的时区）；同一秒内复用结果，渲染时可以放心多次调用
  const t = Date.now(), sec = Math.floor(t / 1000), tz = data.settings.tz;
  if (clk.sec === sec && clk.tz === tz) return clk;
  const n = new Date(t);
  return (clk = { sec, tz, ...(tz === 'system' ? { ds: ymd(n), min: n.getHours() * 60 + n.getMinutes() } : wallIn(tz, t)) });
}
const nowMin = () => clock().min;
const today = () => clock().ds;
const thisMonday = () => mondayOf(parse(today()));
const md = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const WD = '日一二三四五六';
const CNM = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const dur = m => m < 60 ? `${m} 分钟` : m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m / 60} 小时`;
const isoWeek = d => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
};
function parseTime(s) {
  const m = String(s).trim().replace('：', ':').match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const h = +m[1], mi = m[2] ? +m[2] : 0;
  if (h === 24 && mi === 0) return 1440;
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}

// ───────────────────────── 图标（细线手绘风） ─────────────────────────
const I = {
  left: '<svg viewBox="0 0 24 24"><path d="M14.5 6 8.5 12l6 6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M9.5 4.5h5l-.8 5 3.3 3.2v1.6H7v-1.6l3.3-3.2z"/><path d="M12 14.3v5.4"/></svg>',
  mini: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><rect x="12.2" y="11.2" width="5.6" height="4.8" rx="1"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M14 4.8h5.2V10M10 19.2H4.8V14M19 5l-5.6 5.6M5 19l5.6-5.6"/></svg>',
  min: '<svg viewBox="0 0 24 24"><path d="M6.5 12.5h11"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  set: '<svg viewBox="0 0 24 24"><path d="M4 7.5h9.5M17.5 7.5H20M4 16.5h2.5M10.5 16.5H20"/><circle cx="15.5" cy="7.5" r="2"/><circle cx="8.5" cy="16.5" r="2"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6.8 16.2V11a5.2 5.2 0 0 1 10.4 0v5.2l1.6 1.8H5.2z"/><path d="M10.2 20.2a2 2 0 0 0 3.6 0"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7.2h14M10 7V5.2h4V7M7.2 7.2l.8 11.6a1.6 1.6 0 0 0 1.6 1.4h4.8a1.6 1.6 0 0 0 1.6-1.4l.8-11.6"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12.3 5.6c-.4 4.3-.3 8.6.1 12.9M5.7 12.2c4.2.3 8.5.2 12.7-.3"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12.2h13M13.5 7.5l4.8 4.7-4.8 4.8"/></svg>',
};
const BOX = '<svg viewBox="0 0 22 22"><path class="box" d="M4.3 5.2c3.9-.7 9.4-.6 13.3-.2.5 3.9.4 8.3-.1 12.3-4 .5-9 .4-13 .1-.5-4-.5-8.2-.2-12.2z"/><path class="tick" d="M6.4 11.4c1.4 1.1 2.5 2.5 3.5 4 2.2-4.3 5.4-8.2 9.8-11.8"/></svg>';
const RING = '<svg class="ring" viewBox="0 0 50 40"><path d="M27 5.2c-9.8-.9-20.3 4.4-21.4 13.1-1.1 9 8.3 16.3 19.6 16.4 10.9.1 19.9-5.7 19.8-14.2-.1-8.6-9.3-15-20.4-15-3.5.1-6.5.8-9.1 2.2"/></svg>';
const UNDER = '<svg class="under" viewBox="0 0 44 8"><path d="M3 5.2c9.6-2 24.9-3 38-1.2"/></svg>';
const HILLS = '<svg viewBox="0 0 64 44"><path d="M7 33c5-1 9-5 13-10 3-4 6-9 10-9 5 0 6 6 11 7 4 1 7-2 11-5"/><path d="M5 38.5c15-1.2 37-1.4 54-.6"/><path d="M46 9.5a3.2 3.2 0 1 0 .1 0"/></svg>';

// ───────────────────────── 数据 ─────────────────────────
const COLORS = [['dai', '黛'], ['zhu', '朱'], ['tai', '苔'], ['zhe', '赭'], ['zi', '紫'], ['qing', '青'], ['mo', '墨']];
const REPEATS = [['none', '不重复'], ['daily', '每天'], ['workdays', '工作日'], ['weekly', '每周']];
const THEMES = [['xuan', '宣纸', '#f5efe3'], ['kraft', '牛皮', '#e6d4b4'], ['moon', '月白', '#f1f2ee'], ['ink', '夜墨', '#2a2723']];
const DEF = { remind: 10, dayStart: 7, dayEnd: 23, theme: 'xuan', tz: 'system' };
const BOOT = window.__BOOT__ || {};
const tzOK = BOOT.zones !== false;   // 原生层（Python）能不能按时区提醒；不能就只跟随系统

function normalize(d) {
  d = d && typeof d === 'object' ? d : {};
  const events = (Array.isArray(d.events) ? d.events : [])
    .filter(e => e && e.id && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    .map(e => {
      const s = clamp(e.start | 0, 0, 1425);
      return { title: '', color: 'dai', repeat: 'none', exdates: [], remind: true, note: '', until: null, ...e, start: s, end: clamp(e.end | 0, s + 15, 1440) };
    });
  const tasks = (Array.isArray(d.tasks) ? d.tasks : [])
    .filter(t => t && t.id && typeof t.text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date))
    .map(t => ({ eventId: null, done: false, order: 0, ...t }));
  const settings = { ...DEF, ...(d.settings || {}) };
  if (settings.tz !== 'system' && !(tzOK && validTz(settings.tz))) settings.tz = 'system';
  return { version: 1, settings, events, tasks, memo: typeof d.memo === 'string' ? d.memo : '', colorIdx: d.colorIdx | 0 };
}
function loadLocal() { try { return JSON.parse(localStorage.getItem('jian-data')); } catch { return null; } }
let data = normalize(BOOT.data || (native ? null : loadLocal()));

const ui = {
  week: thisMonday(),
  sel: today(),
  day: today(),
  hourH: 44,
  mini: !!BOOT.mini, pinned: !!BOOT.pinned, max: false, autostart: !!BOOT.autostart,
  tab: 'todo',
};

// 保存（防抖）与撤销（整份快照，数据很小）
let saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(flush, 350); }
function flush() {
  clearTimeout(saveT); saveT = 0;
  if (native) send('save', { data });
  else try { localStorage.setItem('jian-data', JSON.stringify(data)); } catch {}
}
const undoStack = [];
function snap() { undoStack.push(JSON.stringify(data)); if (undoStack.length > 80) undoStack.shift(); }
function commit(fn, undoable = true) { if (undoable) snap(); fn(); save(); renderAll(); }
function undo() {
  closePop();
  const s = undoStack.pop();
  if (!s) return toast('没有可以撤销的操作了');
  // 设置（纸色、时区……）和随记不走撤销：保留当前的，免得撤销一次日程把它们也带回旧版本
  const keep = { settings: data.settings, memo: data.memo };
  data = normalize(JSON.parse(s)); Object.assign(data, keep); save(); renderAll(); toast('已撤销');
}

// ───────────────────────── 日程展开 ─────────────────────────
function occursOn(ev, ds, dow) {
  if (ds < ev.date || (ev.until && ds > ev.until)) return false;
  switch (ev.repeat) {
    case 'daily': break;
    case 'workdays': if (dow === 0 || dow === 6) return false; break;
    case 'weekly': if (parse(ev.date).getDay() !== dow) return false; break;
    default: if (ds !== ev.date) return false;
  }
  return !(ev.exdates && ev.exdates.includes(ds));
}
function occsOn(ds) {
  const dow = parse(ds).getDay(), out = [];
  for (const ev of data.events) if (occursOn(ev, ds, dow)) out.push({ ev, date: ds, key: ev.id + '@' + ds, start: ev.start, end: ev.end });
  return out.sort((a, b) => a.start - b.start || b.end - a.end || (a.ev.id < b.ev.id ? -1 : 1));
}
// 重叠日程并排：同一簇内贪心分列
function layoutCols(occs) {
  let group = [], cols = [], end = -1;
  const done = () => { for (const o of group) o.ncol = cols.length; group = []; cols = []; };
  for (const o of occs) {
    if (o.start >= end) { done(); end = -1; }
    let c = cols.findIndex(e => e <= o.start);
    if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = o.end; o.col = c; group.push(o); end = Math.max(end, o.end);
  }
  done();
  return occs;
}
const findEv = id => data.events.find(e => e.id === id);
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
const tasksOf = (evId, ds) => data.tasks.filter(t => t.eventId === evId && t.date === ds).sort(byOrder);
function tasksByDate() { const m = new Map(); for (const t of data.tasks) { let a = m.get(t.date); if (!a) m.set(t.date, a = []); a.push(t); } return m; }
const nextColor = () => COLORS[(data.colorIdx || 0) % COLORS.length][0];

// ───────────────────────── 通用：列表对账 + 进出场动画 ─────────────────────────
function reconcile(box, items, keyOf, make, fill, instant) {
  const old = new Map();
  for (const c of box.children) if (c.dataset.k && !c._leaving) old.set(c.dataset.k, c);
  const keep = new Set(); let prev = null;
  for (const it of items) {
    const k = keyOf(it); keep.add(k);
    let n = old.get(k), fresh = false;
    if (!n) { n = make(it); n.dataset.k = k; fresh = true; }
    fill(n, it, fresh || instant);
    const ref = prev ? prev.nextSibling : box.firstChild;
    if (n !== ref) box.insertBefore(n, ref);
    if (fresh && !instant && motion) enter(n);
    prev = n;
  }
  for (const [k, n] of old) if (!keep.has(k)) { if (instant || !motion) n.remove(); else leave(n); }
}
function enter(n) {
  const h = n.offsetHeight; n.style.overflow = 'hidden';
  n.animate([{ height: '0px', opacity: 0, transform: 'translateY(-4px)' }, { height: h + 'px', opacity: 1, transform: 'none' }],
    { duration: 260, easing: EASE }).onfinish = () => { n.style.overflow = ''; };
}
function leave(n) {
  n._leaving = true; n.style.pointerEvents = 'none'; n.style.overflow = 'hidden';
  const h = n.offsetHeight;
  n.animate([{ height: h + 'px', opacity: 1 }, { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' }],
    { duration: 220, easing: EASE }).onfinish = () => n.remove();
}

// ───────────────────────── 顶栏 ─────────────────────────
function renderHeader() {
  const a = ui.week, b = addDays(a, 6);
  $('#monthLabel').textContent = a.getMonth() === b.getMonth() ? CNM[a.getMonth()] : `${CNM[a.getMonth()]} – ${CNM[b.getMonth()]}`;
  $('#weekLabel').textContent = `${b.getFullYear()} · 第 ${isoWeek(a)} 周`;
  $('#todayBtn').classList.toggle('here', ymd(a) === ymd(thisMonday()) && ui.sel === today());
  let tot = 0, dn = 0; const s = ymd(a), e = ymd(b);
  for (const t of data.tasks) if (t.date >= s && t.date <= e) { tot++; if (t.done) dn++; }
  const ws = $('#weekStat');
  if (!ws.firstChild) ws.innerHTML = '<span>本周待办</span><span class="wbar"><i></i></span><span class="n"></span>';
  ws.style.visibility = tot ? '' : 'hidden';
  ws.querySelector('i').style.setProperty('--p', tot ? (dn / tot * 100) + '%' : '0%');
  ws.querySelector('.n').textContent = `${dn}/${tot}`;
}

// ───────────────────────── 周视图 ─────────────────────────
const headEls = [], colEls = [];
const colsEl = $('#cols'), scroller = $('#scroller');
function buildGrid() {
  const dh = $('#daysHead');
  for (let i = 0; i < 7; i++) {
    const h = el(`<div class="dh"><span class="wd"></span><span class="dn">${RING}<span class="num"></span></span><span class="mo"></span><span class="cnt"></span>${UNDER}</div>`);
    dh.appendChild(h); headEls.push(h);
    const c = el('<div class="col"></div>'); colsEl.appendChild(c); colEls.push(c);
  }
  $('#gutter').innerHTML = Array.from({ length: 24 }, (_, i) => i ? `<span class="hl" style="--h:${i}">${pad(i)}:00</span>` : '').join('');
}
function fitHours(keep) {
  const H = scroller.clientHeight; if (!H) return;
  const span = Math.max(4, data.settings.dayEnd - data.settings.dayStart);
  const hh = clamp((H - 10) / span, 26, 140), top = scroller.scrollTop / ui.hourH;
  ui.hourH = hh;
  $('#week').style.setProperty('--hour-h', hh + 'px');
  scroller.scrollTop = keep ? top * hh : data.settings.dayStart * hh - 10;
}
function renderDays() {
  const td = today(), byDate = tasksByDate();
  for (let i = 0; i < 7; i++) {
    const d = addDays(ui.week, i), ds = ymd(d), h = headEls[i], c = colEls[i];
    const open = (byDate.get(ds) || []).filter(t => !t.done).length;
    h.querySelector('.wd').textContent = '周' + WD[d.getDay()];
    h.querySelector('.num').textContent = d.getDate();
    h.querySelector('.mo').textContent = d.getDate() === 1 || i === 0 ? `${d.getMonth() + 1}月` : '';
    const cnt = h.querySelector('.cnt'); cnt.textContent = open || ''; cnt.title = open ? `${open} 项未完成` : '';
    h.dataset.date = c.dataset.date = ds;
    h.title = `${d.getMonth() + 1}月${d.getDate()}日 · 点击查看当天待办`;
    for (const [k, v] of [['today', ds === td], ['sel', ds === ui.sel], ['weekend', i >= 5]]) { h.classList.toggle(k, v); c.classList.toggle(k, v); }
  }
  renderZone();
}
// 时间轴左上角：用的不是系统时区时，标出是哪里的时间（点一下可以改）
function renderZone() {
  const b = $('#tzCorner'), id = data.settings.tz, on = id !== 'system';
  b.hidden = !on; if (!on) return;
  const nm = zoneName(id), off = fmtOff(zoneOffset(id));
  const html = `<span class="c">${esc(nm.split(' · ')[0])}</span><span class="o">${off}</span>`;
  if (b._html !== html) { b.innerHTML = html; b._html = html; b.title = `按${nm}时间显示和提醒（${id}，${off}）\n点击更改时区`; }
}

const blocks = new Map();   // key -> 日程块元素（跨渲染复用，位置变化自带过渡）
function renderGrid(instant = false) {
  const td = today(), nm = nowMin(), byDate = tasksByDate(), seen = new Set();
  ui.colW = colsEl.getBoundingClientRect().width / 7 || 120;
  for (let i = 0; i < 7; i++) {
    const ds = ymd(addDays(ui.week, i)), col = colEls[i], dayTasks = byDate.get(ds) || [];
    for (const o of layoutCols(occsOn(ds))) {
      seen.add(o.key);
      let b = blocks.get(o.key); const fresh = !b;
      if (fresh) { b = document.createElement('div'); b.className = 'ev'; blocks.set(o.key, b); }
      if (b.parentNode !== col) col.appendChild(b);
      fillBlock(b, o, dayTasks, td, nm);
      if (fresh && !instant && motion) b.animate([{ opacity: 0, transform: 'scaleY(.4)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE });
    }
  }
  for (const [k, b] of blocks) {
    if (seen.has(k)) continue;
    blocks.delete(k);
    if (instant || !motion) b.remove();
    else { b.style.pointerEvents = 'none'; b.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(.95)' }], { duration: 200, easing: EASE }).onfinish = () => b.remove(); }
  }
  if (pop && pop.kind === 'ev') blocks.get(pop.key)?.classList.add('active');
  updateNow();
}
function fillBlock(b, o, dayTasks, td, nm) {
  const ev = o.ev, ts = dayTasks.filter(t => t.eventId === ev.id), dn = ts.filter(t => t.done).length;
  const px = (o.end - o.start) * ui.hourH / 60;
  b.dataset.key = o.key; b.dataset.id = ev.id; b.dataset.date = o.date;
  const st = b.style;
  st.setProperty('--s', o.start); st.setProperty('--e', o.end);
  st.setProperty('--l', o.col / o.ncol); st.setProperty('--w', 1 / o.ncol);
  st.setProperty('--c', `var(--c-${ev.color || 'dai'})`);
  b.classList.toggle('past', o.date < td || (o.date === td && o.end <= nm));
  b.classList.toggle('live', o.date === td && o.start <= nm && nm < o.end);
  b.classList.toggle('short', px < 38);
  b.classList.toggle('tiny', px < 22);
  // 标题最多占几行：给时间留出位置（窄块里时间可能折成两行）
  const timeLines = ui.colW / o.ncol < 82 ? 2 : 1;
  st.setProperty('--lines', clamp(Math.floor((px - 7 - 15 * timeLines) / 16.5), 1, 4));
  const rep = ev.repeat && ev.repeat !== 'none';
  const html = `<div class="ev-t">${ev.title ? esc(ev.title) : '<span class="ph">未命名</span>'}</div>`
    + `<div class="ev-tm">${hm(o.start)}–${hm(o.end)}${rep ? ' <i class="rep">↻</i>' : ''}</div>`
    + (ts.length ? `<div class="ev-badge${dn === ts.length ? ' all' : ''}">${dn === ts.length ? '✓ ' : ''}${dn}/${ts.length}</div>` : '')
    + '<div class="ev-grip"></div>';
  if (b._html !== html) { b.innerHTML = html; b._html = html; }
  b.title = `${ev.title || '未命名'}  ${hm(o.start)}–${hm(o.end)}${rep ? '（重复）' : ''}${ev.note ? '\n' + ev.note : ''}`;
}
function updateNow() {
  const idx = diffDays(ymd(ui.week), today()), nl = $('#nowLine');
  if (idx < 0 || idx > 6) { nl.hidden = true; return; }
  const m = nowMin();
  nl.hidden = false; nl.style.setProperty('--s', m); nl.style.setProperty('--i', idx);
  $('#nowLbl').textContent = hm(m);
  for (const l of $$('#gutter .hl')) l.classList.toggle('near', Math.abs(+l.style.getPropertyValue('--h') * 60 - m) < 16);
}

// ───────────────────────── 周视图：拖拽创建 / 移动 / 拉伸 ─────────────────────────
let drag = null, downClosedPop = false, closedKind = null;
const minAt = y => (y - $('#gridBody').getBoundingClientRect().top) / ui.hourH * 60;
const colW = () => colsEl.getBoundingClientRect().width / 7;
const dayAt = x => clamp(Math.floor((x - colsEl.getBoundingClientRect().left) / colW()), 0, 6);
const snap15 = m => Math.round(m / 15) * 15;
const floorTo = (m, s) => Math.floor(m / s) * s;

colsEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 || drag) return;
  const b = e.target.closest('.ev');
  if (downClosedPop && !b) return;              // 这次点击只是为了关掉浮层
  e.preventDefault();
  const m = minAt(e.clientY);
  if (b) {
    const ev = findEv(b.dataset.id); if (!ev) return;
    const day = diffDays(ymd(ui.week), b.dataset.date);
    drag = { kind: e.target.closest('.ev-grip') ? 'resize' : 'move', b, ev, occDate: b.dataset.date, key: b.dataset.key,
      grab: m - ev.start, day0: day, day, start: ev.start, end: ev.end };
  } else {
    const a = clamp(floorTo(m, 15), 0, 1425);
    drag = { kind: 'create', a, day: dayAt(e.clientX), start: a, end: a + 15 };
  }
  Object.assign(drag, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, pid: e.pointerId });
  try { colsEl.setPointerCapture(e.pointerId); } catch {}
});
colsEl.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  drag.x = e.clientX; drag.y = e.clientY; dragMove(); autoScroll(e.clientY);
});
colsEl.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pid) dragEnd(); });
colsEl.addEventListener('pointercancel', () => { if (drag) dragCancel(); });

function dragMove() {
  const d = drag;
  if (!d.moved) {
    if (Math.hypot(d.x - d.x0, d.y - d.y0) < 4) return;
    d.moved = true;
    if (d.kind === 'create') {
      d.g = el(`<div class="ev ghost" style="--c:var(--c-${nextColor()});--l:0;--w:1"><div class="ev-tm"></div></div>`);
      colEls[d.day].appendChild(d.g);
    } else {
      d.b.classList.add('dragging'); d.b.style.setProperty('--l', 0); d.b.style.setProperty('--w', 1);
      if (pop && pop.kind === 'ev' && pop.evId === d.ev.id) pop.el.classList.add('dim');   // 拖动时让浮层淡出让路
      else closePop();
    }
  }
  const m = minAt(d.y);
  if (d.kind === 'create') {
    const b = clamp(floorTo(m, 15), 0, 1425);
    d.start = Math.min(d.a, b); d.end = Math.max(d.a, b) + 15;
    d.g.style.setProperty('--s', d.start); d.g.style.setProperty('--e', d.end);
    d.g.firstChild.textContent = `${hm(d.start)} – ${hm(d.end)}`;
    return;
  }
  if (d.kind === 'move') {
    const len = d.ev.end - d.ev.start;
    d.start = clamp(snap15(m - d.grab), 0, 1440 - len); d.end = d.start + len;
    d.day = dayAt(d.x);
    d.b.style.setProperty('--dx', `${(d.day - d.day0) * colW()}px`);
  } else {
    d.end = clamp(snap15(m), d.start + 15, 1440);
  }
  d.b.style.setProperty('--s', d.start); d.b.style.setProperty('--e', d.end);
  const tm = d.b.querySelector('.ev-tm');
  if (tm) tm.textContent = (d.day !== d.day0 ? `周${WD[addDays(ui.week, d.day).getDay()]} ` : '') + `${hm(d.start)}–${hm(d.end)}`;
  d.b._html = null;
}
let asV = 0, asRAF = 0;
function autoScroll(y) {
  const r = scroller.getBoundingClientRect(), z = 34;
  asV = y < r.top + z ? -Math.ceil((r.top + z - y) / 3) : y > r.bottom - z ? Math.ceil((y - r.bottom + z) / 3) : 0;
  if (asV && !asRAF) {
    const step = () => { if (!asV || !drag) { asRAF = 0; return; } scroller.scrollTop += asV; dragMove(); asRAF = requestAnimationFrame(step); };
    asRAF = requestAnimationFrame(step);
  }
}
function dragEnd() {
  const d = drag; drag = null; asV = 0;
  try { colsEl.releasePointerCapture(d.pid); } catch {}
  if (d.kind === 'create') {
    if (d.g) d.g.remove();
    let s = d.start, en = d.end;
    if (!d.moved) { s = clamp(floorTo(minAt(d.y0), 30), 0, 1380); en = s + 60; }
    createEvent(ymd(addDays(ui.week, d.day)), s, en);
    return;
  }
  if (!d.moved) {
    if (pop && pop.kind === 'ev' && pop.key === d.key) { pop.el.querySelector('.pop-title').focus(); return; }
    openEvPop(d.ev.id, d.occDate, d.b); return;
  }
  const newDate = ymd(addDays(ui.week, d.day));
  if (newDate === d.occDate && d.start === d.ev.start && d.end === d.ev.end) return dragRevert(d);
  if (d.ev.repeat && d.ev.repeat !== 'none') {
    openChoice(d.b, '这是重复日程，这次调整要应用到？', [
      ['仅这一次', 'btn', () => applyMove(d, newDate, 'one')],
      ['整个系列', 'btn solid', () => applyMove(d, newDate, 'all')],
    ], () => dragRevert(d));
  } else applyMove(d, newDate, 'single');
}
function dragCancel() { const d = drag; drag = null; asV = 0; if (d.g) d.g.remove(); if (d.b) dragRevert(d); }
function dragRevert(d) {
  d.b.classList.remove('dragging'); d.b.style.removeProperty('--dx'); d.b._html = null; renderGrid(true);
  if (pop) pop.el.classList.remove('dim');
}
function settle(b) {   // 拖放落定：取消变换且本帧不做过渡，避免“弹回再飞过去”
  b.classList.add('noanim'); b.classList.remove('dragging'); b.style.removeProperty('--dx'); b._html = null;
  requestAnimationFrame(() => requestAnimationFrame(() => b.classList.remove('noanim')));
}
function applyMove(d, newDate, scope) {
  const ev = d.ev, delta = diffDays(d.occDate, newDate);
  const own = pop && pop.kind === 'ev' && pop.evId === ev.id ? pop : null;   // 这个日程的编辑浮层正开着
  commit(() => {
    let newKey;
    if (scope === 'single') {
      ev.date = newDate; ev.start = d.start; ev.end = d.end;
      for (const t of data.tasks) if (t.eventId === ev.id && t.date === d.occDate) t.date = newDate;
      newKey = ev.id + '@' + newDate;
    } else if (scope === 'one') {            // 从系列中拆出这一次
      const ne = { ...ev, id: uid(), date: newDate, start: d.start, end: d.end, repeat: 'none', exdates: [], until: null };
      ev.exdates = [...(ev.exdates || []), d.occDate];
      data.events.push(ne);
      for (const t of data.tasks) if (t.eventId === ev.id && t.date === d.occDate) { t.eventId = ne.id; t.date = newDate; }
      newKey = ne.id + '@' + newDate;
    } else {                                   // 整个系列
      ev.start = d.start; ev.end = d.end;
      if (delta && ev.repeat === 'weekly') {
        ev.date = shift(ev.date, delta);
        ev.exdates = (ev.exdates || []).map(x => shift(x, delta));
        if (ev.until) ev.until = shift(ev.until, delta);
        for (const t of data.tasks) if (t.eventId === ev.id) t.date = shift(t.date, delta);
        newKey = ev.id + '@' + newDate;
      } else newKey = d.key;
    }
    blocks.delete(d.key); blocks.set(newKey, d.b);
    if (newKey === d.key) { d.b.classList.remove('dragging'); d.b.style.removeProperty('--dx'); d.b._html = null; }
    else settle(d.b);
    if (ui.sel === d.occDate) ui.sel = newDate;
    if (own) { own.key = newKey; own.date = newKey.split('@')[1]; }
  }, !(own && own.isNew));   // 新建草稿的调整不单独记撤销：一次撤销就撤掉整个新日程
  if (own && pop === own) {  // 浮层跟到日程块的新位置
    own.el.classList.remove('dim');
    const b = blocks.get(own.key);
    if (b) { b.classList.add('active'); own.rect = b.getBoundingClientRect(); placePop(own.el, own.rect, 'right'); }
    if (own.isNew) own.el.querySelector('.pop-title').focus();
  }
}
function createEvent(date, start, end) {
  snap();
  const ev = { id: uid(), title: '', date, start, end, color: nextColor(), repeat: 'none', exdates: [], remind: true, note: '', until: null };
  data.events.push(ev);
  data.colorIdx = ((data.colorIdx || 0) + 1) % COLORS.length;
  ui.sel = date;
  renderAll();
  openEvPop(ev.id, date, blocks.get(ev.id + '@' + date), true);
}

// ───────────────────────── TODO 面板 ─────────────────────────
const groupsBox = el('<div class="groups"></div>');
const emptyEl = el('<div class="empty" hidden></div>');
$('#todoBody').append(groupsBox, emptyEl);
let lastSel = null, lastComplete = null;

function renderTodo() {
  const ds = ui.sel, td = today(), d = parse(ds), dayChanged = lastSel !== ds;
  const rel = { '-1': '昨天', 0: '今天', 1: '明天' }[diffDays(td, ds)] || '';
  const dateHtml = `<span class="big">${d.getDate()}</span><div><div class="wd">周${WD[d.getDay()]}${rel ? `<span class="tag">${rel}</span>` : ''}</div><div class="md">${CNM[d.getMonth()]} · ${d.getFullYear()}</div></div>`;
  const dateEl = $('#todoDate'); if (dateEl._html !== dateHtml) { dateEl.innerHTML = dateHtml; dateEl._html = dateHtml; }

  const occs = occsOn(ds), dayTasks = data.tasks.filter(t => t.date === ds).sort(byOrder);
  const ids = new Set(occs.map(o => o.ev.id));
  const groups = occs.map(o => ({ key: o.key, kind: 'ev', occ: o, evId: o.ev.id, date: ds, tasks: dayTasks.filter(t => t.eventId === o.ev.id) }));
  groups.push({ key: 'any@' + ds, kind: 'any', evId: null, date: ds, tasks: dayTasks.filter(t => !t.eventId || !ids.has(t.eventId)) });
  if (ds === td) {
    const carry = data.tasks.filter(t => !t.done && t.date < td).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : byOrder(a, b));
    if (carry.length) groups.push({ key: 'carry', kind: 'carry', evId: null, date: td, tasks: carry });
  }
  reconcile(groupsBox, groups, g => g.key, makeGroup, fillGroup, dayChanged || !motion);

  const isEmpty = !occs.length && !dayTasks.length && groups.length === 1;
  emptyEl.hidden = !isEmpty;
  if (isEmpty) emptyEl.innerHTML = `${HILLS}<div>${ds === td ? '今天还是一张白纸' : '这一天还空着'}</div><div>${ui.mini ? '点上面的 + 记下要做的小事' : '在左边周视图里拖一拖安排日程<br>或者点上面的 + 记下随手的小事'}</div>`;

  const tot = dayTasks.length, dn = dayTasks.filter(t => t.done).length, complete = tot > 0 && dn === tot;
  const pg = $('#progress');
  pg.querySelector('i').style.setProperty('--p', tot ? (dn / tot * 100) + '%' : '0%');
  pg.querySelector('span').textContent = tot ? `${dn} / ${tot}` : '';
  pg.classList.toggle('full', complete);
  const seal = $('#sealDone');
  if (complete !== lastComplete || dayChanged) {
    seal.classList.remove('show');
    if (complete) { void seal.offsetWidth; seal.classList.add('show'); }
  }
  seal.title = complete ? '这一天的待办全部完成' : '';
  lastComplete = complete;
  if (dayChanged && lastSel !== null && motion)
    $('#todoBody').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
  lastSel = ds;
  renderNowNext();
}
function renderNowNext() {
  const box = $('#nownext'), td = today(), occs = occsOn(ui.sel);
  let html = '';
  if (ui.sel === td) {
    const nm = nowMin(), cur = occs.find(o => o.start <= nm && nm < o.end), nxt = occs.find(o => o.start > nm);
    if (cur) html = `<b>进行中</b><span class="t">${esc(cur.ev.title || '未命名')}</span><span>· 还剩 ${dur(cur.end - nm)}</span>`;
    else if (nxt) html = `<b>下一项</b><span>${hm(nxt.start)}</span><span class="t">${esc(nxt.ev.title || '未命名')}</span><span>· ${dur(nxt.start - nm)}后</span>`;
    else if (occs.length) html = '<span>今天的日程都结束了，辛苦啦</span>';
  } else if (occs.length) {
    html = `<span>${occs.length} 个日程 · 共 ${dur(occs.reduce((s, o) => s + o.end - o.start, 0))}</span>`;
  }
  if (box._html !== html) { box.innerHTML = html; box._html = html; }
}

function makeGroup(g) {
  const head = g.inPop ? '' : '<header class="grp-h"></header>';
  const add = g.kind === 'carry' ? '' : `<div class="add"><button class="add-btn" title="添加小任务">${I.plus}</button><span class="add-hint">添加小任务</span><input class="add-in" maxlength="200" placeholder="写下小任务，回车添加" spellcheck="false"></div>`;
  return el(`<section class="grp${g.kind === 'carry' ? ' carry' : ''}">${head}<ul class="tl"></ul>${add}</section>`);
}
function fillGroup(n, g, instant) {
  n._g = g;
  const head = n.querySelector('.grp-h');
  if (head) {
    let html;
    if (g.kind === 'ev') {
      const o = g.occ, ev = o.ev, td = today(), nm = nowMin(), dn = g.tasks.filter(t => t.done).length;
      n.style.setProperty('--c', `var(--c-${ev.color || 'dai'})`);
      n.classList.toggle('past', o.date < td || (o.date === td && o.end <= nm));
      const live = o.date === td && o.start <= nm && nm < o.end;
      html = `<i class="dot"></i><span class="tm">${hm(o.start)}–${hm(o.end)}</span><span class="ttl">${ev.title ? esc(ev.title) : '未命名'}</span>${live ? '<span class="live">进行中</span>' : ''}${g.tasks.length ? `<span class="cnt">${dn}/${g.tasks.length}</span>` : ''}`;
      head.classList.add('ev-link');
      head.title = ui.mini ? '' : '点击编辑这个日程';
    } else if (g.kind === 'any') {
      const dn = g.tasks.filter(t => t.done).length;
      html = `<i class="star">✦</i><span class="ttl">随时</span>${g.tasks.length ? `<span class="cnt">${dn}/${g.tasks.length}</span>` : ''}`;
    } else {
      html = `<span class="ttl">之前没做完的 · ${g.tasks.length}</span><button class="act" data-act="carry-all">全部挪到今天</button>`;
    }
    if (head._html !== html) { head.innerHTML = html; head._html = html; }
  }
  reconcile(n.querySelector('.tl'), g.tasks, t => t.id, () => makeTask(), (li, t) => fillTask(li, t, g), instant);
}
function makeTask() {
  return el(`<li class="task"><button class="chk" title="完成 / 取消完成">${BOX}</button><span class="tx"><span class="tx-in"></span></span><span class="t-meta"></span></li>`);
}
function fillTask(li, t, g) {
  li.dataset.id = t.id;
  li.classList.toggle('done', !!t.done);
  const tx = li.querySelector('.tx-in');
  if (!tx.isContentEditable && tx.textContent !== t.text) tx.textContent = t.text;
  tx.title = '双击修改';
  const meta = g.kind === 'carry'
    ? `<span class="t-date">${md(t.date)}</span><button class="t-btn mv" title="挪到今天">${I.arrow}</button><button class="t-btn del" title="删除">${I.x}</button>`
    : `<button class="t-btn del" title="删除">${I.x}</button>`;
  const m = li.querySelector('.t-meta'); if (m._html !== meta) { m.innerHTML = meta; m._html = meta; }
}

// 任务交互（TODO 面板与日程浮层共用）
function addTask(G, text) {
  commit(() => data.tasks.push({ id: uid(), text, done: false, eventId: G.evId || null, date: G.date, order: Date.now() }));
}
function toggleTask(id, li, G) {
  const t = data.tasks.find(x => x.id === id); if (!t) return;
  if (G.kind === 'carry' && !t.done) {          // 先让勾选动画播完，再从“没做完”里移走
    li.classList.add('done');
    setTimeout(() => commit(() => { t.done = true; t.doneAt = Date.now(); }), 650);
    return;
  }
  commit(() => { t.done = !t.done; t.doneAt = t.done ? Date.now() : null; });
}
function deleteTask(id) {
  const t = data.tasks.find(x => x.id === id); if (!t) return;
  commit(() => { data.tasks = data.tasks.filter(x => x.id !== id); });
  toast(`已删除「${t.text.length > 14 ? t.text.slice(0, 14) + '…' : t.text}」`, '撤销', undo);
}
function moveToToday(ids) {
  const td = today(); let i = 0;
  commit(() => { for (const t of data.tasks) if (ids.includes(t.id)) { t.date = td; t.eventId = null; t.order = Date.now() + i++; } });
  toast(`已挪到今天 · ${ids.length} 项`);
}
function openAdd(add) { add.classList.add('adding'); const inp = add.querySelector('.add-in'); inp.focus(); }
function closeAdd(add) { add.classList.remove('adding'); const inp = add.querySelector('.add-in'); inp.value = ''; inp.blur(); }

document.addEventListener('click', e => {
  const t = e.target, g = t.closest('.grp');
  if (!g || !g._g) return;
  const G = g._g;
  if (t.closest('.chk')) { const li = t.closest('.task'); toggleTask(li.dataset.id, li, G); }
  else if (t.closest('.t-btn.del')) deleteTask(t.closest('.task').dataset.id);
  else if (t.closest('.t-btn.mv')) moveToToday([t.closest('.task').dataset.id]);
  else if (t.closest('[data-act="carry-all"]')) moveToToday(G.tasks.map(x => x.id));
  else if (t.closest('.add') && !t.closest('.add-in')) { const add = t.closest('.add'); add.classList.contains('adding') ? closeAdd(add) : openAdd(add); }
  else if (t.closest('.grp-h.ev-link') && G.kind === 'ev' && !ui.mini) {
    const b = blocks.get(G.key);
    if (b) { revealBlock(b, G.occ.start); openEvPop(G.evId, G.date, b); }
  }
});
document.addEventListener('keydown', e => {
  const t = e.target;
  if (!t.classList || !t.classList.contains('add-in')) return;
  if (e.key === 'Enter' && !composing(e)) {
    e.preventDefault();
    const v = t.value.trim(), g = t.closest('.grp');
    if (v) { addTask(g._g, v); t.value = ''; } else closeAdd(t.closest('.add'));
  } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAdd(t.closest('.add')); }
}, true);
document.addEventListener('focusout', e => {
  const t = e.target;
  if (t.classList && t.classList.contains('add-in') && !t.value.trim())
    setTimeout(() => { if (document.activeElement !== t) t.closest('.add')?.classList.remove('adding'); }, 150);
});
document.addEventListener('dblclick', e => {   // 双击修改任务文字
  const tx = e.target.closest('.tx-in'); if (!tx || tx.isContentEditable) return;
  const id = tx.closest('.task').dataset.id, orig = tx.textContent;
  tx.contentEditable = 'plaintext-only'; tx.focus();
  getSelection().selectAllChildren(tx);
  let done = false;
  const finish = ok => {
    if (done) return; done = true;
    tx.removeEventListener('keydown', onKey); tx.removeEventListener('blur', onBlur);
    tx.removeAttribute('contenteditable');
    const v = tx.textContent.replace(/\s+/g, ' ').trim();
    if (!ok || v === orig) { tx.textContent = orig; return; }
    if (!v) { tx.textContent = orig; deleteTask(id); return; }
    commit(() => { const t = data.tasks.find(x => x.id === id); if (t) t.text = v; });
  };
  const onKey = ev => {
    if (ev.key === 'Enter' && !composing(ev)) { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  };
  const onBlur = () => finish(true);
  tx.addEventListener('keydown', onKey); tx.addEventListener('blur', onBlur);
});

// ───────────────────────── 浮层 ─────────────────────────
let pop = null;
const layer = $('#layer');
function placePop(p, r, prefer) {
  const W = innerWidth, H = innerHeight, m = 16, w = p.offsetWidth, h = p.offsetHeight;
  let x, y;
  if (prefer === 'below') {
    x = clamp(r.right - w, m, W - w - m); y = r.bottom + 8;
    if (y + h > H - m) y = Math.max(m, r.top - h - 8);
  } else {
    x = r.right + 10;
    if (x + w > W - m) x = r.left - w - 10;
    if (x < m) x = clamp(r.left + 24, m, W - w - m);
    y = clamp(r.top - 12, m, H - h - m);
  }
  p.style.left = x + 'px'; p.style.top = y + 'px';
  p.style.setProperty('--ox', clamp(r.left + r.width / 2 - x, 0, w) + 'px');
  p.style.setProperty('--oy', clamp(r.top + 12 - y, 0, h) + 'px');
}
function openPop(p, rect, prefer, extra) {
  closePop();
  layer.appendChild(p);
  placePop(p, rect, prefer);
  return (pop = { el: p, rect, prefer, ...extra });
}
function closePop() {
  if (!pop) return;
  const p = pop; pop = null;
  if (p.onClose) p.onClose(p);
  p.el.classList.add('out');
  setTimeout(() => p.el.remove(), 170);
  for (const b of $$('.ev.active')) b.classList.remove('active');
}
document.addEventListener('pointerdown', e => {
  downClosedPop = false; closedKind = null;
  if (!pop || pop.el.contains(e.target)) return;
  // 按在正在编辑的那个日程块上（比如要拉长 / 挪动它）：保留浮层，也保留还没起名的草稿
  if (pop.kind === 'ev' && e.target.closest && e.target.closest('.ev') === blocks.get(pop.key)) return;
  downClosedPop = true; closedKind = pop.kind; closePop();
}, true);

// 日程编辑浮层
function evPopHTML(ev, date) {
  const d = parse(date), rep = ev.repeat || 'none';
  return `<div class="pop pop-ev" role="dialog">
    <div class="pop-top">
      <div class="swatches">${COLORS.map(([c, n]) => `<button class="sw${ev.color === c ? ' on' : ''}" data-c="${c}" style="--c:var(--c-${c})" title="${n}"></button>`).join('')}</div>
      <div class="pop-acts">
        <button class="ib bell${ev.remind !== false ? ' on' : ''}" title="开始前提醒">${I.bell}</button>
        <button class="ib del" title="删除日程">${I.trash}</button>
        <button class="ib x" title="关闭 (Esc)">${I.close}</button>
      </div>
    </div>
    <input class="pop-title" value="${esc(ev.title)}" placeholder="这段时间要做什么？" maxlength="80" spellcheck="false">
    <div class="pop-when">
      <span class="pop-date">周${WD[d.getDay()]} · ${d.getMonth() + 1}月${d.getDate()}日</span>
      <input class="tm-in" data-f="start" value="${hm(ev.start)}" maxlength="5" title="可直接输入，或滚轮 / ↑↓ 微调"><span>–</span><input class="tm-in" data-f="end" value="${hm(ev.end)}" maxlength="5" title="可直接输入，或滚轮 / ↑↓ 微调">
      <span class="pop-dur">${dur(ev.end - ev.start)}</span>
    </div>
    <div class="seg rep-seg">${REPEATS.map(([r, n]) => `<button data-r="${r}" class="${rep === r ? 'on' : ''}">${n}</button>`).join('')}</div>
    <div class="pop-sec"><span>小任务</span><i></i></div>
    <div class="pop-tasks"></div>
    <textarea class="pop-note" placeholder="备注……" rows="1" spellcheck="false">${esc(ev.note || '')}</textarea>
  </div>`;
}
function openEvPop(evId, date, anchor, isNew = false) {
  const ev = findEv(evId); if (!ev) return;
  const p = el(evPopHTML(ev, date));
  const gEl = makeGroup({ kind: 'ev', inPop: true });
  p.querySelector('.pop-tasks').appendChild(gEl);
  const rect = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2 - 150, right: innerWidth / 2 - 150, top: 120, bottom: 120, width: 0, height: 0 };
  const st = openPop(p, rect, 'right', { kind: 'ev', evId, date, key: evId + '@' + date, isNew, dirty: false, gEl, onClose: onEvPopClose });
  refreshPop(true);
  placePop(p, rect, 'right');
  if (anchor) anchor.classList.add('active');
  if (ui.sel !== date) { ui.sel = date; renderDays(); renderTodo(); renderHeader(); }
  flashGroup(st.key);
  bindEvPop(p);
  const note = p.querySelector('.pop-note'); autoGrow(note);
  if (isNew) setTimeout(() => p.querySelector('.pop-title').focus(), 30);
}
function onEvPopClose(p) {
  const ev = findEv(p.evId); if (!ev) return;
  const title = ev.title.trim();
  if (p.isNew && !title && !tasksOf(ev.id, p.date).length && !ev.note) {   // 空白草稿直接丢弃
    data.events = data.events.filter(e => e !== ev);
    undoStack.pop();
    save(); renderAll();
  } else if (title !== ev.title) { ev.title = title; save(); renderAll(); }
}
function editEv(fn) {
  if (!pop || pop.kind !== 'ev') return;
  const ev = findEv(pop.evId); if (!ev) return;
  if (!pop.dirty && !pop.isNew) { snap(); pop.dirty = true; }
  fn(ev); save();
  renderHeader(); renderDays(); renderGrid(); renderTodo();
}
function refreshPop(instant = false) {
  if (!pop || pop.kind !== 'ev') return;
  if (!findEv(pop.evId)) return closePop();
  const tasks = tasksOf(pop.evId, pop.date);
  fillGroup(pop.gEl, { kind: 'pop', inPop: true, evId: pop.evId, date: pop.date, tasks }, instant);
  const dn = tasks.filter(t => t.done).length;
  pop.el.querySelector('.pop-sec span').textContent = tasks.length ? `小任务 · ${dn}/${tasks.length}` : '小任务';
  // 拖动 / 拉伸之后同步日期和时间（正在输入的框不动）
  const ev = findEv(pop.evId), d = parse(pop.date), p = pop.el;
  p.querySelector('.pop-date').textContent = `周${WD[d.getDay()]} · ${d.getMonth() + 1}月${d.getDate()}日`;
  for (const inp of $$('.tm-in', p)) if (inp !== document.activeElement) inp.value = hm(inp.dataset.f === 'start' ? ev.start : ev.end);
  p.querySelector('.pop-dur').textContent = dur(ev.end - ev.start);
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(120, t.scrollHeight + 2) + 'px'; }
function bindEvPop(p) {
  const st = pop;
  p.querySelector('.swatches').addEventListener('click', e => {
    const b = e.target.closest('.sw'); if (!b) return;
    editEv(ev => { ev.color = b.dataset.c; });
    for (const s of $$('.sw', p)) s.classList.toggle('on', s === b);
  });
  const title = p.querySelector('.pop-title');
  title.addEventListener('input', () => editEv(ev => { ev.title = title.value; }));
  title.addEventListener('keydown', e => { if (e.key === 'Enter' && !composing(e)) { e.preventDefault(); closePop(); } });
  p.querySelector('.bell').addEventListener('click', e => {
    editEv(ev => { ev.remind = ev.remind === false; });
    e.currentTarget.classList.toggle('on', findEv(st.evId).remind !== false);
    toast(findEv(st.evId).remind !== false ? `将在开始前 ${data.settings.remind || 10} 分钟提醒` : '已关闭这个日程的提醒');
  });
  p.querySelector('.x').addEventListener('click', () => closePop());
  p.querySelector('.del').addEventListener('click', e => {
    const ev = findEv(st.evId);
    if (ev.repeat && ev.repeat !== 'none') {
      openChoice(e.currentTarget, '删除这个重复日程：', [
        ['仅这一次', 'btn warn', () => deleteEvent(st.evId, 'one', st.date)],
        ['整个系列', 'btn warn', () => deleteEvent(st.evId, 'all')],
      ]);
    } else deleteEvent(st.evId, 'all');
  });
  p.querySelector('.rep-seg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const r = b.dataset.r;
    editEv(ev => {
      if (r === 'none' && ev.repeat !== 'none') { ev.date = st.date; ev.exdates = []; ev.until = null; }
      ev.repeat = r;
    });
    for (const x of $$('.rep-seg button', p)) x.classList.toggle('on', x === b);
    if (r !== 'none') toast('重复日程：在浮层里改标题 / 时间会作用于整个系列');
  });
  const note = p.querySelector('.pop-note');
  note.addEventListener('input', () => { autoGrow(note); editEv(ev => { ev.note = note.value; }); });
  for (const inp of $$('.tm-in', p)) {
    const f = inp.dataset.f;
    const sync = () => { const ev = findEv(st.evId); if (!ev) return; $('[data-f=start]', p).value = hm(ev.start); $('[data-f=end]', p).value = hm(ev.end); $('.pop-dur', p).textContent = dur(ev.end - ev.start); };
    const bad = () => { inp.classList.remove('bad'); void inp.offsetWidth; inp.classList.add('bad'); sync(); };
    const apply = val => {
      const ev = findEv(st.evId); if (!ev) return;
      if (val == null || val < 0 || val > 1440) return bad();
      let s = ev.start, en = ev.end;
      if (f === 'start') { if (val > 1425) return bad(); const len = en - s; s = val; if (s >= en) en = Math.min(1440, s + len); }
      else { if (val <= s) return bad(); en = val; }
      inp.classList.remove('bad');
      editEv(ev => { ev.start = s; ev.end = en; });
      sync();
    };
    inp.addEventListener('change', () => apply(parseTime(inp.value)));
    inp.addEventListener('focus', () => inp.select());
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); const ev = findEv(st.evId);
        apply((f === 'start' ? ev.start : ev.end) + (e.key === 'ArrowUp' ? 15 : -15));
      }
    });
    inp.addEventListener('wheel', e => {
      e.preventDefault(); const ev = findEv(st.evId);
      apply((f === 'start' ? ev.start : ev.end) + (e.deltaY < 0 ? 15 : -15));
    }, { passive: false });
  }
}
function deleteEvent(evId, scope, date) {
  const ev = findEv(evId); if (!ev) return;
  if (pop) pop.isNew = false;
  closePop();
  commit(() => {
    if (scope === 'one') {
      ev.exdates = [...(ev.exdates || []), date];
      data.tasks = data.tasks.filter(t => !(t.eventId === ev.id && t.date === date));
    } else {
      data.events = data.events.filter(e => e.id !== ev.id);
      data.tasks = data.tasks.filter(t => t.eventId !== ev.id);
    }
  });
  toast(`已删除「${ev.title || '未命名'}」${scope === 'one' ? '（仅这一次）' : ''}`, '撤销', undo);
}
function openChoice(anchor, text, buttons, onCancel) {
  const p = el(`<div class="pop pop-choice"><p>${esc(text)}</p><div class="row"></div></div>`);
  let chosen = false;
  for (const [label, cls, fn] of buttons) {
    const b = el(`<button class="${cls}">${esc(label)}</button>`);
    b.onclick = () => { chosen = true; closePop(); fn(); };
    p.querySelector('.row').appendChild(b);
  }
  const rect = anchor.getBoundingClientRect();
  openPop(p, rect, 'right', { kind: 'choice', onClose: () => { if (!chosen && onCancel) onCancel(); } });
}

// 时区：常用城市（中文名 + 搜索关键词），按此刻的偏移从西到东排；搜索时还会查遍系统支持的全部时区
const ZONES = [
  ['Pacific/Honolulu', '檀香山', '夏威夷 美国'], ['America/Anchorage', '安克雷奇', '阿拉斯加 美国'],
  ['America/Los_Angeles', '洛杉矶 · 旧金山', '美国 西雅图 太平洋 pacific'], ['America/Vancouver', '温哥华', '加拿大'],
  ['America/Denver', '丹佛', '美国 山地 mountain'], ['America/Phoenix', '凤凰城', '美国 亚利桑那'],
  ['America/Chicago', '芝加哥', '美国 中部 central 休斯顿 达拉斯'], ['America/Mexico_City', '墨西哥城', '墨西哥'],
  ['America/New_York', '纽约', '美国 东部 eastern 波士顿 华盛顿'], ['America/Toronto', '多伦多', '加拿大 蒙特利尔'],
  ['America/Halifax', '哈利法克斯', '加拿大 大西洋'], ['America/Sao_Paulo', '圣保罗', '巴西 里约'],
  ['America/Argentina/Buenos_Aires', '布宜诺斯艾利斯', '阿根廷'],
  ['Europe/London', '伦敦', '英国 gmt'], ['UTC', '协调世界时', 'utc gmt 格林尼治'],
  ['Europe/Paris', '巴黎', '法国'], ['Europe/Berlin', '柏林', '德国 慕尼黑'], ['Europe/Madrid', '马德里', '西班牙'],
  ['Europe/Rome', '罗马', '意大利'], ['Europe/Amsterdam', '阿姆斯特丹', '荷兰'],
  ['Europe/Athens', '雅典', '希腊'], ['Europe/Kyiv', '基辅', '乌克兰'], ['Africa/Cairo', '开罗', '埃及'],
  ['Africa/Johannesburg', '约翰内斯堡', '南非'], ['Europe/Istanbul', '伊斯坦布尔', '土耳其'], ['Europe/Moscow', '莫斯科', '俄罗斯'],
  ['Asia/Dubai', '迪拜', '阿联酋'], ['Asia/Tehran', '德黑兰', '伊朗'], ['Asia/Karachi', '卡拉奇', '巴基斯坦'],
  ['Asia/Kolkata', '新德里 · 孟买', '印度'], ['Asia/Kathmandu', '加德满都', '尼泊尔'], ['Asia/Dhaka', '达卡', '孟加拉'],
  ['Asia/Urumqi', '乌鲁木齐', '新疆 中国'], ['Asia/Bangkok', '曼谷', '泰国'], ['Asia/Ho_Chi_Minh', '胡志明市', '越南 河内'],
  ['Asia/Jakarta', '雅加达', '印度尼西亚 印尼'],
  ['Asia/Shanghai', '北京 · 上海', '中国 北京时间 china beijing'], ['Asia/Hong_Kong', '香港', ''], ['Asia/Macau', '澳门', 'macao'],
  ['Asia/Taipei', '台北', '台湾'], ['Asia/Singapore', '新加坡', ''], ['Asia/Kuala_Lumpur', '吉隆坡', '马来西亚'],
  ['Asia/Manila', '马尼拉', '菲律宾'], ['Australia/Perth', '珀斯', '澳大利亚 澳洲'],
  ['Asia/Seoul', '首尔', '韩国'], ['Asia/Tokyo', '东京', '日本 大阪'],
  ['Australia/Adelaide', '阿德莱德', '澳大利亚 澳洲'], ['Australia/Brisbane', '布里斯班', '澳大利亚 澳洲 昆士兰'],
  ['Australia/Sydney', '悉尼 · 墨尔本', '澳大利亚 澳洲'], ['Pacific/Auckland', '奥克兰', '新西兰'],
];
const ZMAP = new Map(ZONES.map(z => [z[0], z]));
// WebKit 的时区列表里还用着这几座城市的旧名，换成现名，免得同一个地方出现两次
const TZ_ALIAS = { 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Europe/Kiev': 'Europe/Kyiv' };
const zmeta = id => ZMAP.get(TZ_ALIAS[id] || id);
const zoneName = id => zmeta(id)?.[1] || id.split('/').pop().replace(/_/g, ' ');
function zoneOffset(id, t = Date.now()) {   // 此刻比 UTC 快多少分钟（各地偏移都是整分钟，先对齐到整分）
  const t0 = Math.floor(t / 60000) * 60000, w = wallIn(realTz(id), t0), [y, m, d] = w.ds.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) + w.min * 60000 - t0) / 60000);
}
const fmtOff = o => `UTC${o < 0 ? '−' : '+'}${Math.floor(Math.abs(o) / 60)}${Math.abs(o) % 60 ? ':' + pad(Math.abs(o) % 60) : ''}`;
let allZones = null;
function zoneItems(query) {   // 空查询：跟随系统 + 常用；否则按城市 / 国家 / 英文名搜，或按“+8”“UTC-5”这样的偏移找
  const t = Date.now(), q = query.trim().toLowerCase().replace(/[_\s]+/g, ' ');
  const common = ZONES.map(z => [z[0], zoneOffset(z[0], t)]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  if (!q) return ['system', ...common];
  const om = q.replace(/[−–]/g, '-').match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?:[:：]?(\d{2}))?$/);
  const want = om && (om[1] === '-' ? -1 : 1) * (+om[2] * 60 + (+om[3] || 0));
  const text = id => `${id} ${(zmeta(id) || []).slice(1).join(' ')}`.toLowerCase().replace(/_/g, ' ');
  const sysText = `跟随系统 系统 本地 system local ${text(SYS_TZ)} ${zoneName(SYS_TZ)}`;
  if (om) return [...(zoneOffset('system', t) === want ? ['system'] : []), ...common.filter(id => zoneOffset(id, t) === want)];
  if (!allZones) {
    let ids = []; try { ids = Intl.supportedValuesOf('timeZone'); } catch {}
    allZones = [...new Set(ids.map(id => TZ_ALIAS[id] || id))].filter(id => !ZMAP.has(id)).sort();
  }
  return [...(sysText.includes(q) ? ['system'] : []), ...common.filter(id => text(id).includes(q)), ...allZones.filter(id => text(id).includes(q))].slice(0, 60);
}
function zoneRow(id, cur, t) {
  const m = zmeta(id), nm = id === 'system' ? `跟随系统<small>${esc(zoneName(SYS_TZ))}</small>`
    : m ? esc(m[1]) : `${esc(zoneName(id))}<small>${esc(id.split('/').slice(0, -1).join(' / '))}</small>`;
  return `<button class="tz-it${id === cur ? ' on' : ''}" data-tz="${esc(id)}" title="${esc(realTz(id))}"><span class="nm">${nm}</span>`
    + `<span class="off">${fmtOff(zoneOffset(id, t))}</span><span class="tm">${hm(wallIn(realTz(id), t).min)}</span></button>`;
}
function setTz(id) {
  if (id === data.settings.tz || !(id === 'system' || (tzOK && validTz(id)))) return;
  data.settings.tz = id; save();
  tick(); renderHeader();   // “今天”可能跟着变：tick 负责换日，并刷新时间线和过去 / 进行中的日程
  if (!ui.mini) scrollToNow();
}

// 设置浮层（page = 'tz' 时直接打开时区页）
function openSettings(page, anchor = $('#settingsBtn')) {
  const s = data.settings;
  const p = el(`<div class="pop pop-set">
    <div class="set-main">
    <h4>设置</h4>
    <div class="set-row th-row"><span class="lab">纸色</span><div class="themes">${THEMES.map(([k, n, c]) => `<button class="th${s.theme === k ? ' on' : ''}" data-th="${k}" style="background:${c}"><span>${n}</span></button>`).join('')}</div></div>
    <div class="set-row"><span class="lab">提前提醒</span><div class="seg rem-seg">${[0, 5, 10, 15, 30].map(v => `<button data-rem="${v}" class="${s.remind === v ? 'on' : ''}">${v ? v + ' 分' : '关'}</button>`).join('')}</div></div>
    <div class="set-row"><span class="lab">一屏显示</span><div class="stepper"><button data-st="ds-1">−</button><b class="dsv">${pad(s.dayStart)}:00</b><button data-st="ds1">+</button><span style="color:var(--ink-3);margin:0 2px">至</span><button data-st="de-1">−</button><b class="dev">${pad(s.dayEnd)}:00</b><button data-st="de1">+</button></div></div>
    ${tzOK ? '<div class="set-row"><span class="lab">时区</span><button class="tz-cur" title="笺按哪里的时间显示日程、发出提醒"></button></div>' : ''}
    <div class="set-row"><span class="lab">开机后在后台待命</span><button class="switch${ui.autostart ? ' on' : ''}" title="登录后自动在后台启动，以便准时提醒"></button></div>
    <div class="set-row"><span class="lab">数据</span><button class="link open-data">打开数据文件夹</button></div>
    <div class="keys"><kbd>←</kbd><kbd>→</kbd>翻周　<kbd>T</kbd>回到今天　<kbd>N</kbd>新待办<br><kbd>M</kbd>迷你卡片　<kbd>P</kbd>置顶　<kbd>Ctrl</kbd>+<kbd>Z</kbd>撤销<br><kbd>Esc</kbd>隐藏到后台　<kbd>Ctrl</kbd>+<kbd>Q</kbd>彻底退出</div>
    <div class="ver">笺 v${esc(BOOT.version || 'dev')}</div>
    </div>
    <div class="set-tz" hidden>
      <div class="tz-top"><button class="ib tz-back" title="返回设置">${I.left}</button><h4>时区</h4></div>
      <input class="tz-q" placeholder="搜索城市、国家，或输入 +8" spellcheck="false" autocomplete="off">
      <div class="tz-list"></div>
      <p class="tz-note">日程和提醒都按所选时区的钟点走；切换时区不会改动已经排好的时间。</p>
    </div>
  </div>`);
  const main = $('.set-main', p), tzp = $('.set-tz', p), q = $('.tz-q', p), list = $('.tz-list', p);
  let hi = -1;   // 键盘 ↑↓ 选中的那一行
  const paintCur = () => {
    const b = $('.tz-cur', p);
    if (b) b.innerHTML = `<span class="nm">${s.tz === 'system' ? '跟随系统' : esc(zoneName(s.tz))}</span><em>${fmtOff(zoneOffset(s.tz))}</em>${I.right}`;
  };
  const fillTz = () => {
    const t = Date.now(), ids = zoneItems(q.value);
    list.innerHTML = ids.length ? ids.map(id => zoneRow(id, s.tz, t)).join('') : '<div class="tz-empty">没有找到，换个城市或国家试试</div>';
    hi = -1; list.scrollTop = 0;
  };
  const retime = () => {   // 列表开着时每分钟更新各地的钟点
    const t = Date.now();
    for (const b of $$('.tz-it', list)) {
      b.querySelector('.off').textContent = fmtOff(zoneOffset(b.dataset.tz, t));
      b.querySelector('.tm').textContent = hm(wallIn(realTz(b.dataset.tz), t).min);
    }
  };
  const reveal = n => {
    if (n.offsetTop < list.scrollTop) list.scrollTop = n.offsetTop;
    else if (n.offsetTop + n.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = n.offsetTop + n.offsetHeight - list.clientHeight;
  };
  const showPage = (tz, anim = true) => {
    if (tz) { tzp.style.height = main.offsetHeight + 'px'; q.value = ''; }   // 两页一样高，卡片不会跳
    main.hidden = tz; tzp.hidden = !tz;
    if (tz) {
      fillTz();
      const on = $('.tz-it.on', list); if (on) list.scrollTop = on.offsetTop - (list.clientHeight - on.offsetHeight) / 2;
      q.focus();
    } else paintCur();
    if (anim && motion) (tz ? tzp : main).animate([{ opacity: 0, transform: `translateX(${tz ? 18 : -18}px)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: EASE });
  };
  paintCur();
  q.addEventListener('input', fillTz);
  q.addEventListener('keydown', e => {
    if (composing(e)) return;
    const its = $$('.tz-it', list);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!its.length) return;
      hi = clamp(hi + (e.key === 'ArrowDown' ? 1 : -1), 0, its.length - 1);
      its.forEach((x, i) => x.classList.toggle('hi', i === hi)); reveal(its[hi]);
    } else if (e.key === 'Enter') { e.preventDefault(); (its[hi] || its[0])?.click(); }
  });
  p.addEventListener('click', e => {
    const t = e.target;
    if (t.closest('.tz-cur')) return showPage(true);
    if (t.closest('.tz-back')) return showPage(false);
    const z = t.closest('[data-tz]');
    if (z) { setTz(z.dataset.tz); showPage(false); return; }
    const th = t.closest('[data-th]');
    if (th) { s.theme = th.dataset.th; applyTheme(); save(); for (const x of $$('.th', p)) x.classList.toggle('on', x === th); return; }
    const rem = t.closest('[data-rem]');
    if (rem) { s.remind = +rem.dataset.rem; save(); for (const x of $$('[data-rem]', p)) x.classList.toggle('on', x === rem); return; }
    const stp = t.closest('[data-st]');
    if (stp) {
      const k = stp.dataset.st, v = +k.slice(2);
      if (k.startsWith('ds')) s.dayStart = clamp(s.dayStart + v, 0, s.dayEnd - 4);
      else s.dayEnd = clamp(s.dayEnd + v, s.dayStart + 4, 24);
      $('.dsv', p).textContent = `${pad(s.dayStart)}:00`; $('.dev', p).textContent = `${pad(s.dayEnd)}:00`;
      save(); fitHours(false); renderGrid(true);
      return;
    }
    if (t.closest('.switch')) { ui.autostart = !ui.autostart; t.closest('.switch').classList.toggle('on', ui.autostart); send('setAutostart', { on: ui.autostart }); return; }
    if (t.closest('.open-data')) { send('openDataDir'); if (!native) toast('预览模式下数据保存在浏览器里'); }
  });
  openPop(p, anchor.getBoundingClientRect(), 'below', { kind: 'settings', tick: () => { paintCur(); if (!tzp.hidden) retime(); } });
  if (page === 'tz') showPage(true, false);
}
function applyTheme() { document.documentElement.dataset.theme = data.settings.theme || 'xuan'; }

// 提示条
function toast(msg, action, fn) {
  const box = $('#toasts');
  const t = el(`<div class="toast${action ? '' : ' plain'}"><span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ''}</div>`);
  box.appendChild(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  if (motion) t.animate([{ opacity: 0, transform: 'translateY(10px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
  let timer = 0;
  const kill = () => {
    clearTimeout(timer); if (!t.isConnected || t._dying) return; t._dying = true;
    const a = t.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 180, easing: EASE });
    a.onfinish = () => t.remove();
  };
  if (action) t.querySelector('button').onclick = () => { kill(); fn(); };
  timer = setTimeout(kill, action ? 5000 : 2200);
}

// ───────────────────────── 导航 ─────────────────────────
function inWeek(ds, mon = ui.week) { const k = diffDays(ymd(mon), ds); return k >= 0 && k <= 6; }
function gotoWeek(mon, slide = true) {
  if (ymd(mon) === ymd(ui.week)) return;
  const dir = mon > ui.week ? 1 : -1;
  ui.week = mon;
  if (!inWeek(ui.sel)) { const td = today(); ui.sel = inWeek(td) ? td : shift(ymd(mon), (parse(ui.sel).getDay() + 6) % 7); }
  closePop();
  renderHeader(); renderDays(); renderGrid(true); renderTodo();
  if (slide && motion) for (const n of [colsEl, $('#daysHead')])
    n.animate([{ opacity: 0, transform: `translateX(${dir * 26}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
}
function selectDay(ds) {
  if (!inWeek(ds)) { ui.sel = ds; gotoWeek(mondayOf(parse(ds))); return; }
  if (ui.sel === ds) return;
  ui.sel = ds; renderHeader(); renderDays(); renderTodo();
}
function goToday() { const td = today(); if (!inWeek(td)) { ui.sel = td; gotoWeek(thisMonday()); } else selectDay(td); scrollToNow(); }
function scrollToNow() {
  const top = nowMin() / 60 * ui.hourH;
  if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 30)
    scroller.scrollTo({ top: top - scroller.clientHeight / 3, behavior: 'smooth' });
}
function revealBlock(b, start) {
  const top = start / 60 * ui.hourH;
  if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - 40) scroller.scrollTop = top - 40;
  b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
}
function flashGroup(key) {
  const g = $$('.grp', groupsBox).find(n => n.dataset.k === key); if (!g) return;
  g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  g.classList.remove('flash'); void g.offsetWidth; g.classList.add('flash');
}
function newAnytime() {
  setTab('todo');
  const g = $$('.grp', groupsBox).find(n => n.dataset.k === 'any@' + ui.sel); if (!g) return;
  g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  openAdd(g.querySelector('.add'));
}
function setTab(tab) {
  ui.tab = tab;
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  $('#todoBody').classList.toggle('off', tab !== 'todo');
  $('#memoPane').classList.toggle('off', tab !== 'memo');
  moveInd();
  if (tab === 'memo') setTimeout(() => $('#memo').focus(), 60);
}
function moveInd() {
  const b = $(`#tabs button[data-tab="${ui.tab}"]`), ind = $('#tabs .ind');
  ind.style.width = b.offsetWidth + 'px'; ind.style.transform = `translateX(${b.offsetLeft}px)`;
}

// ───────────────────────── 窗口模式（原生层回调） ─────────────────────────
function updatePinBtns() {
  for (const b of [$('#pinBtn'), $('#pinBtn2')]) { b.classList.toggle('on', ui.pinned); b.title = ui.pinned ? '取消置顶 (P)' : '置顶 (P)'; }
}
function togglePin() { ui.pinned = !ui.pinned; updatePinBtns(); send('setPinned', { pinned: ui.pinned }); if (!native) toast('预览模式不支持置顶'); }
function toggleMini() {
  closePop();
  if (!native) return onMode({ mini: !ui.mini, pinned: ui.pinned });
  document.body.classList.add('switching');
  setTimeout(() => send('setMode', { mini: !ui.mini }), 160);
}
function onMode(st) {
  ui.mini = !!st.mini; ui.pinned = !!st.pinned;
  document.body.classList.toggle('mini', ui.mini);
  $('#todoHead').toggleAttribute('data-drag', ui.mini);
  updatePinBtns(); renderAll();
  requestAnimationFrame(() => {
    document.body.classList.remove('switching');
    fitHours(false); renderGrid(true); moveInd(); reportDragSoon();
  });
}
function onWindowState(st) {
  if ('maximized' in st) { ui.max = !!st.maximized; document.body.classList.toggle('max', ui.max); }
  if ('pinned' in st) { ui.pinned = !!st.pinned; updatePinBtns(); }
  reportDragSoon();
}
// 把可拖动区域（顶栏空白处）告诉原生层，由它同步判定并发起窗口拖动
let dragRepT = 0;
function reportDragSoon() { if (!native) return; clearTimeout(dragRepT); dragRepT = setTimeout(reportDrag, 40); }
function reportDrag() {
  const regions = [], holes = [];
  for (const r of $$('[data-drag]')) {
    const b = r.getBoundingClientRect(); if (!b.width || !b.height) continue;
    regions.push([b.left, b.top, b.width, b.height]);
    for (const c of $$('button, input, textarea, a, [data-nodrag]', r)) {
      const q = c.getBoundingClientRect(); if (q.width && q.height) holes.push([q.left, q.top, q.width, q.height]);
    }
  }
  send('dragRegions', { regions, holes });
}

// ───────────────────────── 时钟（每分钟一次） ─────────────────────────
function tick() {
  if (pop && pop.tick) pop.tick();
  const td = today();
  if (td !== ui.day) {   // 跨过了零点（或换了时区）
    const old = ui.day; ui.day = td;
    if (ui.sel === old) ui.sel = td;
    if (inWeek(old)) ui.week = thisMonday();
    renderAll(); return;
  }
  renderDays(); renderGrid(true); renderTodo();
}

// ───────────────────────── 键盘 ─────────────────────────
document.addEventListener('keydown', e => {
  const t = e.target, typing = !!(t.closest && t.closest('input, textarea, [contenteditable]'));
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'Escape') {
    e.preventDefault();
    if (pop) closePop(); else if (typing) t.blur(); else send('hide');
    return;
  }
  if (e.ctrlKey && k === 'q') { e.preventDefault(); send('quit'); return; }
  if (e.ctrlKey && k === 'w') { e.preventDefault(); send('hide'); return; }
  if (e.ctrlKey && !e.shiftKey && k === 'z' && !typing) { e.preventDefault(); undo(); return; }
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
  switch (k) {
    case 'ArrowLeft': ui.mini ? selectDay(shift(ui.sel, -1)) : gotoWeek(addDays(ui.week, -7)); break;
    case 'ArrowRight': ui.mini ? selectDay(shift(ui.sel, 1)) : gotoWeek(addDays(ui.week, 7)); break;
    case 'ArrowUp': selectDay(shift(ui.sel, -1)); break;
    case 'ArrowDown': selectDay(shift(ui.sel, 1)); break;
    case 't': goToday(); break;
    case 'n': newAnytime(); break;
    case 'm': toggleMini(); break;
    case 'p': togglePin(); break;
    default: return;
  }
  e.preventDefault();
});

// ───────────────────────── 启动 ─────────────────────────
function renderAll() { renderHeader(); renderDays(); renderGrid(); renderTodo(); refreshPop(); }

function init() {
  const icons = { prevWeek: I.left, nextWeek: I.right, settingsBtn: I.set, pinBtn: I.pin, miniBtn: I.mini, minBtn: I.min, closeBtn: I.close,
    prevDay: I.left, nextDay: I.right, pinBtn2: I.pin, expandBtn: I.expand, closeBtn2: I.close };
  for (const [id, svg] of Object.entries(icons)) $('#' + id).innerHTML = svg;
  applyTheme(); buildGrid();
  if (BOOT.opaque) document.body.classList.add('opaque');
  document.body.classList.toggle('mini', ui.mini);
  $('#todoHead').toggleAttribute('data-drag', ui.mini);
  updatePinBtns();
  $('#memo').value = data.memo;

  $('#prevWeek').onclick = () => gotoWeek(addDays(ui.week, -7));
  $('#nextWeek').onclick = () => gotoWeek(addDays(ui.week, 7));
  $('#todayBtn').onclick = goToday;
  $('#settingsBtn').onclick = () => { if (closedKind !== 'settings') openSettings(); };
  $('#tzCorner').onclick = e => { if (closedKind !== 'settings') openSettings('tz', e.currentTarget); };
  $('#pinBtn').onclick = $('#pinBtn2').onclick = togglePin;
  $('#miniBtn').onclick = $('#expandBtn').onclick = toggleMini;
  $('#minBtn').onclick = () => send('minimize');
  $('#closeBtn').onclick = $('#closeBtn2').onclick = () => send('hide');
  $('#prevDay').onclick = () => selectDay(shift(ui.sel, -1));
  $('#nextDay').onclick = () => selectDay(shift(ui.sel, 1));
  $('#daysHead').addEventListener('click', e => { const h = e.target.closest('.dh'); if (h && h.dataset.date) selectDay(h.dataset.date); });
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('#memo').addEventListener('input', e => { data.memo = e.target.value; save(); });

  renderAll();
  new ResizeObserver(() => { fitHours(true); renderGrid(true); }).observe(scroller);
  addEventListener('resize', () => { moveInd(); reportDragSoon(); if (pop) placePop(pop.el, pop.rect, pop.prefer); });
  requestAnimationFrame(() => { fitHours(false); renderGrid(true); moveInd(); reportDragSoon(); });
  document.fonts && document.fonts.ready.then(() => { moveInd(); reportDragSoon(); });
  setTimeout(() => { tick(); setInterval(tick, 60000); }, 60300 - Date.now() % 60000);
  if (motion) $('#frame').animate([{ opacity: 0, transform: 'translateY(10px) scale(.99)' }, { opacity: 1, transform: 'none' }], { duration: 460, easing: EASE });
  send('ready');
}

window.App = {
  dump() { clearTimeout(saveT); saveT = 0; return JSON.stringify(data); },
  onMode, onWindowState,
  onShow() { tick(); reportDragSoon(); },
  setAutostart(on) { ui.autostart = !!on; },
  focus(date, evId) {
    selectDay(date);
    const key = evId + '@' + date, b = blocks.get(key);
    if (b && !ui.mini) revealBlock(b, findEv(evId)?.start || 0);
    flashGroup(key);
  },
  // 供测试脚本使用
  _debug: { get data() { return data; }, set data(v) { data = normalize(v); renderAll(); }, ui, renderAll, createEvent, openEvPop, openSettings, toast, gotoWeek, selectDay, closePop, toggleMini, onMode,
    today, nowMin, setTz, zoneOffset, zoneItems, undo },
};

init();
})();

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
const web = !native && !!window.__WEB__;   // 手机网页版（由同步服务器提供，见 server/）
if (!native) document.body.classList.add(web ? 'web' : 'preview');

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
  day: '<svg viewBox="0 0 24 24"><path d="M5 4.5v15M5 8h1.8M5 12h1.8M5 16h1.8"/><rect x="9.3" y="5.3" width="10" height="5.4" rx="1.6"/><rect x="9.3" y="13.1" width="10" height="6" rx="1.6"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7.4 18.3h9.8a3.6 3.6 0 0 0 .4-7.2 5.3 5.3 0 0 0-10.2-1.3 4.3 4.3 0 0 0 0 8.5z"/><path class="ck" d="M9.6 13.6l1.8 1.7 3.2-3.4"/></svg>',
};
const BOX = '<svg viewBox="0 0 22 22"><path class="box" d="M4.3 5.2c3.9-.7 9.4-.6 13.3-.2.5 3.9.4 8.3-.1 12.3-4 .5-9 .4-13 .1-.5-4-.5-8.2-.2-12.2z"/><path class="tick" d="M6.4 11.4c1.4 1.1 2.5 2.5 3.5 4 2.2-4.3 5.4-8.2 9.8-11.8"/></svg>';
const RING = '<svg class="ring" viewBox="0 0 50 40"><path d="M27 5.2c-9.8-.9-20.3 4.4-21.4 13.1-1.1 9 8.3 16.3 19.6 16.4 10.9.1 19.9-5.7 19.8-14.2-.1-8.6-9.3-15-20.4-15-3.5.1-6.5.8-9.1 2.2"/></svg>';
const UNDER = '<svg class="under" viewBox="0 0 44 8"><path d="M3 5.2c9.6-2 24.9-3 38-1.2"/></svg>';
const HILLS = '<svg viewBox="0 0 64 44"><path d="M7 33c5-1 9-5 13-10 3-4 6-9 10-9 5 0 6 6 11 7 4 1 7-2 11-5"/><path d="M5 38.5c15-1.2 37-1.4 54-.6"/><path d="M46 9.5a3.2 3.2 0 1 0 .1 0"/></svg>';

// ───────────────────────── 数据 ─────────────────────────
const COLORS = [['dai', '黛'], ['zhu', '朱'], ['tai', '苔'], ['zhe', '赭'], ['zi', '紫'], ['qing', '青'], ['mo', '墨']];
const REPEATS = [['none', '不重复'], ['daily', '每天'], ['workdays', '工作日'], ['weekly', '每周']];
const THEMES = [['xuan', '宣纸', '#f5efe3'], ['kraft', '牛皮', '#e6d4b4'], ['moon', '月白', '#f1f2ee'], ['ink', '夜墨', '#2a2723']];
const DEF = { remind: 10, dayStart: 7, dayEnd: 23, theme: 'xuan', tz: 'system', miniView: 'list', days: 7 };   // miniView：迷你卡片看待办列表还是日程方块；days：周视图一屏显示几天
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
  if (settings.miniView !== 'day') settings.miniView = 'list';
  settings.days = clamp(Math.round(+settings.days) || 7, 1, 7);
  settings.pdays = clamp(Math.round(+settings.pdays) || 3, 1, 7);   // 手机上的周视图一屏几天（手机屏幕窄，默认 3 天）
  if (settings.pview !== 'week') settings.pview = 'card';            // 手机上次停在哪个视图：日（卡片）/ 周
  const gone = {};   // 删除记录（同步用）：id → 删除时间
  if (d.gone && typeof d.gone === 'object') for (const [k, v] of Object.entries(d.gone)) if (v > 0) gone[k] = +v;
  return { version: 1, settings, events, tasks, memo: typeof d.memo === 'string' ? d.memo : '', memoMt: d.memoMt > 0 ? +d.memoMt : 0, gone, colorIdx: d.colorIdx | 0 };
}
function loadLocal() { try { return JSON.parse(localStorage.getItem('jian-data')); } catch { return null; } }
let data = normalize(BOOT.data || (native ? null : loadLocal()));

const ui = {
  week: thisMonday(),
  sel: today(),
  day: today(),
  hourH: 44,
  mini: web ? data.settings.pview !== 'week' : !!BOOT.mini, pinned: !!BOOT.pinned, max: false, autostart: !!BOOT.autostart,   // 手机的日视图就是迷你卡片的样子
  tab: 'todo',
  dayView: data.settings.miniView === 'day',   // 迷你卡片当前显示日程方块视图（只在迷你模式下生效）
  days: web ? data.settings.pdays : data.settings.days,   // 周视图一屏显示几天（1–7）
};

// 保存（防抖）与撤销（整份快照，数据很小）
let saveT = 0;
function save() { clearTimeout(saveT); saveT = setTimeout(flush, 350); }
function flush() {
  clearTimeout(saveT); saveT = 0;
  const changed = stamp();
  if (native) send('save', { data, changed });   // changed：本机有改动，原生层据此安排同步
  else {
    try { localStorage.setItem('jian-data', JSON.stringify(data)); } catch {}
    if (changed) syncSoon();
  }
}
const undoStack = [];
function snap() { undoStack.push(JSON.stringify(data)); if (undoStack.length > 80) undoStack.shift(); }
function commit(fn, undoable = true) { if (undoable) snap(); fn(); save(); renderAll(); }
function undo() {
  closePop();
  const s = undoStack.pop();
  if (!s) return toast('没有可以撤销的操作了');
  // 设置（纸色、时区……）和随记不走撤销：保留当前的，免得撤销一次日程把它们也带回旧版本；删除记录只增不减
  const keep = { settings: data.settings, memo: data.memo, memoMt: data.memoMt, gone: data.gone };
  data = normalize(JSON.parse(s)); Object.assign(data, keep); save(); renderAll(); toast('已撤销');
}

// ───────────────────────── 同步：逐条合并 ─────────────────────────
// 规则与 syncmerge.py 完全相同（改一边要两边一起改）：每条日程 / 小任务带 mt（最后修改时间），
// 删除的记入 gone[id] = 删除时间；合并时同一条取后改的，删除时间不早于 mt 的算删掉；随记取 memoMt 较新的。
// 本机改了哪些不用逐处标记：每次保存前和上次的内容比一比（stamp），变了的盖上当前时间。
const KEEP_GONE = 120 * 864e5;
const mtOf = x => (x && x.mt > 0 ? x.mt : 0);
const bodyOf = x => { const { mt, ...r } = x; return JSON.stringify(r); };
let stamped = null, stampedMemo = '';
function restamp() {   // 以当前数据为准记下各条内容（启动时、合并远端之后）：这些不算本机的改动
  stamped = new Map();
  for (const x of data.events) stamped.set(x.id, bodyOf(x));
  for (const x of data.tasks) stamped.set(x.id, bodyOf(x));
  stampedMemo = data.memo;
}
function stamp() {   // 返回本机这次有没有改动
  if (!stamped) { restamp(); return false; }
  const now = Date.now(), seen = new Set(); let changed = false;
  for (const x of data.events.concat(data.tasks)) {
    seen.add(x.id);
    const b = bodyOf(x);
    if (stamped.get(x.id) !== b) { x.mt = now; stamped.set(x.id, b); changed = true; }
  }
  for (const id of [...stamped.keys()]) if (!seen.has(id)) { data.gone[id] = now; stamped.delete(id); changed = true; }
  if (data.memo !== stampedMemo) { data.memoMt = now; stampedMemo = data.memo; changed = true; }
  return changed;
}
const syncPart = d => ({ events: d.events || [], tasks: d.tasks || [], gone: d.gone || {}, memo: d.memo || '', memoMt: d.memoMt || 0 });
function mergeDocs(a, b, now = Date.now()) {
  const gone = { ...a.gone };
  for (const [k, v] of Object.entries(b.gone || {})) if (v > (gone[k] || 0)) gone[k] = v;
  const out = {};
  for (const kind of ['events', 'tasks']) {
    const m = new Map(a[kind].map(x => [x.id, x]));
    for (const y of b[kind] || []) { const x = m.get(y.id); if (!x || mtOf(y) > mtOf(x)) m.set(y.id, y); }
    out[kind] = [...m.values()].filter(x => (gone[x.id] ?? -1) < mtOf(x));
  }
  out.gone = Object.fromEntries(Object.entries(gone).filter(([, v]) => v >= now - KEEP_GONE));
  const am = a.memoMt || 0, bmt = b.memoMt || 0;
  const bm = bmt > am || (bmt === am && (b.memo || '') > (a.memo || ''));   // 时间一样（比如两边都没改过）时比内容，各端结果一致
  out.memo = bm ? b.memo || '' : a.memo || ''; out.memoMt = bm ? bmt : am;
  return out;
}
const byId = (x, y) => (x.id < y.id ? -1 : 1);
const canonPart = p => JSON.stringify([[...p.events].sort(byId), [...p.tasks].sort(byId), Object.entries(p.gone).sort(), p.memo, p.memoMt]);
// 收到另一端（服务器 / 桌面原生层）的数据：合并进来，有变化就重画。正在拖动时先等一等。
function applyRemote(remote) {
  if (drag) { setTimeout(() => applyRemote(remote), 800); return false; }
  stamp();   // 本机还没盖戳的改动先盖上，免得被当成远端的旧数据
  const mine = syncPart(data), merged = mergeDocs(mine, syncPart(remote));
  if (canonPart(merged) === canonPart(mine)) return false;
  const editingMemo = document.activeElement === $('#memo');
  data = normalize({ ...data, ...merged });
  restamp(); undoStack.length = 0;   // 撤销只管本机刚做的事，别把别处的改动也撤回去
  if (!editingMemo) $('#memo').value = data.memo;
  clearTimeout(saveT); saveT = 0;
  if (native) send('save', { data, changed: false }); else try { localStorage.setItem('jian-data', JSON.stringify(data)); } catch {}
  renderAll();
  return true;
}

// 手机网页版：和服务器同步。本机一有改动就排一次；打开、回到前台、联网时也同步；开着时每分钟一次。
let syncInfo = {};   // 桌面：原生层报告的状态；手机：{ ok, at, err, busy }
const SY = { token: null, busy: false, again: false, timer: 0 };
try { SY.token = localStorage.getItem('jian-token'); } catch {}
function syncSoon(ms = 1200) { if (!web) return; clearTimeout(SY.timer); SY.timer = setTimeout(syncNow, ms); }
async function syncNow() {
  if (!web) return;
  if (!SY.token) return showLogin();
  if (SY.busy) { SY.again = true; return; }
  SY.busy = true; setSync({ busy: true });
  const ab = new AbortController(), to = setTimeout(() => ab.abort(), 25000);
  try {
    if (saveT) flush(); else stamp();
    const r = await fetch('api/sync', { method: 'POST', cache: 'no-store', signal: ab.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SY.token }, body: JSON.stringify(syncPart(data)) });
    if (r.status === 401) { logout('登录已失效，请重新输入同步密码'); return; }
    if (!r.ok) throw new Error('服务器返回 ' + r.status);
    applyRemote(await r.json());
    setSync({ ok: true, at: Date.now() });
  } catch (e) {
    setSync({ ok: false, at: syncInfo.at, err: navigator.onLine === false ? '没有网络' : '连不上服务器' });
    clearTimeout(SY.timer); SY.timer = setTimeout(syncNow, 30000);   // 稍后再试
  } finally {
    clearTimeout(to); SY.busy = false;
    if (SY.again) { SY.again = false; syncSoon(300); }
  }
}
function setSync(st) {
  syncInfo = { ...syncInfo, busy: false, ...st };
  const b = $('#syncInd'); if (!b) return;
  b.classList.toggle('busy', !!syncInfo.busy);
  b.classList.toggle('bad', !syncInfo.busy && syncInfo.ok === false);
  b.classList.toggle('ok', !syncInfo.busy && syncInfo.ok === true);
  b.title = syncText();
  paintSyncText();
}
function paintSyncText() { for (const n of $$('.pop-set .sync-st')) n.textContent = syncText(); }
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
}
function syncText() {
  const i = syncInfo;
  if (i.off) return '未开启';
  if (i.busy) return '正在同步…';
  if (i.ok) return `已同步 · ${ago(i.at)}`;
  if (i.err) return `${i.err}${i.at ? ` · 上次同步 ${ago(i.at)}` : ''}，改动先存在本机`;
  return native ? '未开启同步' : '还没有同步';
}
function showLogin(msg = '') {
  let box = $('#login');
  if (!box) {
    box = el(`<div class="login" id="login"><form class="login-card">
      <span class="seal-logo">笺</span>
      <h3>连接你的笺</h3>
      <p>输入同步密码，手机和电脑上的日程、待办会自动同步。</p>
      <input type="password" class="login-pw" autocomplete="current-password" placeholder="同步密码" required>
      <button class="btn solid login-go">进入</button>
      <div class="login-err"></div>
    </form></div>`);
    document.body.appendChild(box);
    box.querySelector('form').addEventListener('submit', async e => {
      e.preventDefault();
      const pw = box.querySelector('.login-pw'), err = box.querySelector('.login-err'), go = box.querySelector('.login-go');
      go.disabled = true; err.textContent = '';
      try {
        const r = await fetch('api/login', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw.value, device: /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : '手机' }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || '登录失败');
        SY.token = j.token; try { localStorage.setItem('jian-token', j.token); } catch {}
        pw.value = ''; box.classList.add('out'); setTimeout(() => box.remove(), 260);
        syncNow(); pushInit();
      } catch (ex) {
        err.textContent = ex.name === 'TypeError' ? '连不上服务器，检查一下网络' : ex.message;
        if (motion) box.querySelector('.login-card').animate([{ translate: '0' }, { translate: '-6px' }, { translate: '5px' }, { translate: '-3px' }, { translate: '0' }], { duration: 320 });
      } finally { go.disabled = false; }
    });
  }
  box.querySelector('.login-err').textContent = msg;
  setTimeout(() => box.querySelector('.login-pw').focus(), 50);
}
function logout(msg) {
  if (!msg && PU.sub) {   // 主动退出：服务器上这台手机的订阅一并取消（登录失效时令牌已经没用了，不必再发）
    const sub = PU.sub; PU.sub = null;
    fetch('api/push/off', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SY.token }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
    sub.unsubscribe().catch(() => {});
  }
  SY.token = null; try { localStorage.removeItem('jian-token'); } catch {}
  setSync({ ok: undefined, at: 0, err: '' }); closePop(); showLogin(msg);
}

// 手机提醒（Web Push，iOS 16.4 起，要先添加到主屏幕）：把推送订阅连同「提前几分钟」「时区」交给服务器，
// 到点由服务器推送，App 没开着也能收到。服务器只看到订阅地址，通知内容是加密的。
const PU = { reg: null, key: null, sub: null, err: '' };
const pushOK = () => web && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const zoneId = () => data.settings.tz === 'system' ? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') : data.settings.tz;
function b64uBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
async function api(path, body) {   // 带设备令牌的 POST
  const r = await fetch(path, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SY.token }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { logout('登录已失效，请重新输入同步密码'); throw new Error('登录已失效'); }
  if (!r.ok) throw new Error(j.error || `服务器返回 ${r.status}`);
  return j;
}
async function pushInit() {   // 先备好 Service Worker 和服务器公钥：点「开启」时要能立刻订阅；已订阅的把最新设置报给服务器
  if (!pushOK()) return paintPush();
  try {
    PU.reg = await navigator.serviceWorker.ready;
    PU.sub = await PU.reg.pushManager.getSubscription();
    if (!PU.key) {
      const r = await fetch('api/push/key', { cache: 'no-store' }), j = await r.json().catch(() => ({}));
      if (r.ok && j.key) { PU.key = b64uBytes(j.key); PU.err = ''; } else PU.err = j.error || '服务器还不支持手机提醒';
    }
    await pushSave();
  } catch {}   // 离线：下次打开再说
  paintPush();
}
async function pushSave() { if (PU.sub && SY.token) await api('api/push', { sub: PU.sub.toJSON(), remind: data.settings.remind, tz: zoneId() }); }
const pushSaveSoon = () => { if (PU.sub) pushSave().catch(e => toast('提醒设置没能存到服务器：' + e.message)); };
function pushEnable() {   // 要在点击里直接调用 subscribe：iOS 只认用户亲手点出来的订阅请求
  if (!PU.reg || !PU.key) { toast(PU.err || '还在准备，稍等一下再点'); pushInit(); return; }
  PU.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: PU.key }).then(async sub => {
    PU.sub = sub;
    if (!data.settings.remind) { data.settings.remind = 10; save(); for (const x of $$('[data-rem]')) x.classList.toggle('on', +x.dataset.rem === 10); }
    await pushSave(); paintPush(); pushTest();
  }).catch(e => {
    paintPush();
    toast(Notification.permission === 'denied' ? '通知被关掉了：到 iPhone「设置 → 通知 → 笺」里打开' : '没能开启提醒：' + (e.message || e));
  });
}
async function pushTest() {
  try { const j = await api('api/push/test', { endpoint: PU.sub.endpoint }); toast(j.ok ? '发了一条测试提醒，看看收到没有' : `测试提醒没发出去（${j.status}）`); }
  catch (e) { toast(e.message); }
}
function pushText() {
  if (!pushOK()) return navigator.standalone === false ? '添加到主屏幕、从主屏幕打开后才能收到提醒' : '这个浏览器收不到推送提醒';
  if (Notification.permission === 'denied') return '通知被关掉了：到 iPhone「设置 → 通知 → 笺」里打开';
  if (PU.err) return PU.err;
  if (!PU.sub) return '手机提醒还没开启';
  return data.settings.remind ? `日程开始前 ${data.settings.remind} 分钟提醒` : '提醒已关闭';
}
function paintPush() {
  for (const p of $$('.pop-set')) {
    const t = $('.push-st', p), b = $('.push-go', p); if (!t) continue;
    t.textContent = pushText();
    b.hidden = !pushOK() || Notification.permission === 'denied' || !!PU.err || (PU.sub && !data.settings.remind);
    b.textContent = PU.sub ? '试一下' : '开启';
  }
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
  if (n.classList.contains('task') || n.classList.contains('ev-tk')) writeIn(n);
}
function leave(n) {   // 先向右轻轻拂去，再收起高度
  n._leaving = true; n.style.pointerEvents = 'none'; n.style.overflow = 'hidden';
  const h = n.offsetHeight + 'px';
  n.animate([
    { height: h, opacity: 1, transform: 'none', easing: 'cubic-bezier(.3,.6,.4,1)' },
    { height: h, opacity: 0, transform: 'translateX(16px)', offset: .5, easing: 'ease-in-out' },
    { height: '0px', opacity: 0, transform: 'translateX(16px)', paddingTop: '0px', paddingBottom: '0px' },
  ], { duration: 340 }).onfinish = () => n.remove();
}

// ───────────────────────── 小动效 ─────────────────────────
// 只在交互的那一下播放：临时放几个小元素，播完即删，空闲时没有任何动画在跑。
// 意象都取自纸和墨：洇开的墨、笔锋甩出的墨点、印泥、落下的纸条。
const FX = $('#fx'), OUT = 'cubic-bezier(.2,.7,.3,1)';
const fxOnce = a => { a.onfinish = a.oncancel = () => a.effect.target.remove(); return a; };
function fxDot(cls, x, y, size, color) {   // 在动效层放一个一次性的小圆点 / 印痕
  const s = document.createElement('i'); s.className = cls;
  s.style.cssText = `left:${x}px;top:${y}px` + (size ? `;width:${size}px;height:${size}px;margin:${-size / 2}px 0 0 ${-size / 2}px` : '') + (color ? `;--fc:${color}` : '');
  FX.appendChild(s); return s;
}
function inkCheck(chk) {   // 勾选：方框四周洇开一圈淡墨，勾的笔锋处甩出几粒墨点
  if (!motion || !chk) return;
  const r = chk.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const k = (chk.querySelector('svg')?.getBoundingClientRect().width || 22) / 22;   // 日程块里的小方框：墨晕和墨点按比例缩小
  fxOnce(fxDot('fx-bloom', x, y, 40 * k, 'var(--accent)').animate([   // 先很快洇开，再慢慢淡掉
    { scale: .3, opacity: .95, easing: OUT }, { scale: 1.05, opacity: .8, offset: .4, easing: 'ease-in' }, { scale: 1.3, opacity: 0 },
  ], { duration: 600, delay: 40, fill: 'backwards' }));
  for (let i = 0; i < 3; i++) {
    const a = (-80 + i * 38 + (Math.random() - .5) * 18) * Math.PI / 180, d = (9 + Math.random() * 6) * (.4 + .6 * k);
    fxOnce(fxDot('fx-speck', x + 8.5 * k, y - 7.5 * k, (3.6 - i * .6) * Math.max(k, .7), 'var(--accent)').animate([
      { translate: '0 0', opacity: 0 }, { opacity: .85, offset: .2 },
      { translate: `${Math.cos(a) * d}px ${Math.sin(a) * d}px`, opacity: 0, scale: .5 },
    ], { duration: 460, delay: 190 + i * 35, easing: OUT, fill: 'backwards' }));
  }
  chk.querySelector('svg')?.animate([{ scale: 1 }, { scale: 1.16 }, { scale: 1 }], { duration: 340, easing: OUT });
}
function writeIn(li) {   // 新任务：方框一笔画出来，文字从左往右“写”出来
  const box = li.querySelector('.box'), tx = li.querySelector('.tx, .ev-tx'), t = li.querySelector('.tx-in, .ev-tx-in');
  try {
    const L = Math.ceil(box.getTotalLength()) + 'px'; box.style.strokeDasharray = L;
    box.animate([{ strokeDashoffset: L }, { strokeDashoffset: '0px' }], { duration: 420, easing: 'cubic-bezier(.45,.05,.35,1)' }).onfinish = () => { box.style.strokeDasharray = ''; };
  } catch {}
  if (!tx || !t) return;
  // 按文字实际的宽度来“写”：短的写得快，长的写得慢一点；写完时刚好露出整行
  const R = tx.getBoundingClientRect(), r = t.getBoundingClientRect(), w = r.right - R.left;
  tx.animate([{ clipPath: `inset(-3px ${R.width}px -3px 0)` }, { clipPath: `inset(-3px ${Math.max(0, R.right - r.right - 3)}px -3px 0)` }],
    { duration: clamp(200 + w * 1.4, 300, 620), delay: 90, easing: 'cubic-bezier(.4,.1,.35,1)', fill: 'backwards' });
}
function stampRing(seal) {   // 「毕」落下的那一刻，纸面上晕开一圈印泥
  if (!motion) return;
  const r = seal.getBoundingClientRect();
  fxOnce(fxDot('fx-stamp', r.left + r.width / 2, r.top + r.height / 2).animate(
    [{ scale: .92, opacity: 0 }, { scale: 1, opacity: .55, offset: .12 }, { scale: 1.5, opacity: 0 }],
    { duration: 620, delay: 270, easing: OUT, fill: 'backwards' }));
}
function inkFill(b) {   // 新日程：墨色从上往下注满这段时间
  b.animate([{ clipPath: 'inset(0 0 100% 0 round 3px 8px 8px 3px)' }, { clipPath: 'inset(0 0 0 0 round 3px 8px 8px 3px)' }], { duration: 380, easing: EASE });
}
function lift(b) {   // 拿起日程块：微微放大、倾斜
  if (motion) b._lift = b.animate([{ scale: 1, rotate: '0deg' }, { scale: 1.035, rotate: '-.8deg' }], { duration: 160, easing: EASE, fill: 'forwards' });
}
function land(b) {   // 放下：轻轻一顿再落定
  const l = b && b._lift; if (!l) return;
  b._lift = null; l.cancel();
  b.animate([{ scale: 1.035, rotate: '-.8deg' }, { scale: .985, rotate: '0deg', offset: .55 }, { scale: 1, rotate: '0deg' }], { duration: 320, easing: 'ease-out' });
}
function fadeAway(n) {
  n.style.pointerEvents = 'none';
  if (motion) fxOnce(n.animate([{ opacity: 0 }], { duration: 260, easing: EASE })); else n.remove();
}
function wash(b, from) {   // 换颜色：旧颜色带着柔边退向右下角，新颜色像从左上角洇开
  if (!motion || !b) return;
  const s = document.createElement('i'), k = 1.85;   // 1/0.55：柔边一开始正好贴着左上角
  s.className = 'fx-wash'; s.style.setProperty('--c', from);
  b.appendChild(s);
  fxOnce(s.animate([{ maskSize: `${b.offsetWidth * k}px ${b.offsetHeight * k}px` }, { maskSize: '0px 0px' }], { duration: 560, easing: 'cubic-bezier(.35,.15,.3,1)' }));
}
function pingNow() {   // 回到今天：“现在”的小红点泛起一圈涟漪
  const nl = $('#nowLine'); if (!motion || nl.hidden || ui.mini) return;
  const s = document.createElement('i'); s.className = 'fx-ping'; nl.querySelector('.seg').appendChild(s);
  fxOnce(s.animate([{ scale: .4, opacity: .8 }, { scale: 2.3, opacity: 0 }], { duration: 800, delay: 260, easing: OUT, fill: 'backwards' }));
}
const swing = (deg, at) => ({ rotate: deg + 'deg', offset: at, easing: 'ease-in-out' });   // 摆到头时慢、过中间时快
const JIGGLE = {   // 小图标：铃铛摇一摇 / 轻按一下；图钉按下去 / 拔起来
  ring: [[{ rotate: '0deg', easing: 'ease-out' }, swing(14, .14), swing(-11, .36), swing(6, .58), swing(-2.5, .78), { rotate: '0deg' }], 620, 'linear'],
  tap: [[{ scale: 1 }, { scale: .8 }, { scale: 1 }], 260],
  pinIn: [[{ translate: '0 -4px', rotate: '-14deg' }, { translate: '0 1.5px', rotate: '0deg', offset: .6 }, { translate: '0 0', rotate: '0deg' }], 380],
  pinOut: [[{ translate: '0 0', rotate: '0deg' }, { translate: '0 -4px', rotate: '-10deg', offset: .45 }, { translate: '0 0', rotate: '0deg' }], 380],
};
function jiggle(svg, kind) { const [k, ms, ease = 'ease-out'] = JIGGLE[kind]; if (motion && svg) svg.animate(k, { duration: ms, easing: ease }); }
function rollTo(n, txt, anim, dir = 1) {   // 数字换了：新数字从下方（变少时从上方）轻轻冒出来
  if (n.textContent === txt) return;
  n.textContent = txt;
  if (anim && motion && txt) n.animate([{ translate: `0 ${dir * 6}px`, opacity: 0 }, { translate: '0 0', opacity: 1 }], { duration: 260, easing: EASE });
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
  rollTo(ws.querySelector('.n'), `${dn}/${tot}`, ws._wk === s, dn < (ws._dn ?? dn) ? -1 : 1); ws._wk = s; ws._dn = dn;
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
  $('#gutter').innerHTML = Array.from({ length: 24 }, (_, i) => i ? `<span class="hl" style="--h:${i}">${pad(i)}:00</span>` : '').join('')
    + '<span class="now-lbl" id="nowLbl" hidden></span>';   // “现在”的钟点放在刻度里，横向滚动时不跑
}
// 每小时多高：按“一屏显示”的时段铺满，取整数像素。
// 网格线是按小时平铺的背景，高度带小数时浏览器会把平铺取整，线就一小时比一小时更偏，和时间标签、日程块对不齐。
function setHourH(box, hh) { box.style.setProperty('--hour-h', hh + 'px'); box.style.setProperty('--half-h', (hh >> 1) + 'px'); }
function fitHours(keep) {
  const H = scroller.clientHeight; if (!H) return;
  const span = Math.max(4, data.settings.dayEnd - data.settings.dayStart);
  const hh = Math.floor(clamp((H - 10) / span, 26, 140)), top = scroller.scrollTop / ui.hourH;
  ui.hourH = hh; setHourH($('#week'), hh);
  scroller.scrollTop = keep ? top * hh : data.settings.dayStart * hh - 10;
}

// ───────────────────────── 横向缩放：一屏显示几天（Ctrl+滚轮 / Ctrl+= / Ctrl+- / Ctrl+0） ─────────────────────────
// 一周 7 列始终都在，放大只是让每列变宽：显示 N 天时一屏放 N 列，其余几天左右滚动查看（停下后对齐到整列）。
// 左侧时间刻度钉住不动，顶部星期栏跟着网格一起横向滚动。显示几天记在设置里。
let colw = 0, colAnim = 0, tipT = 0;
const gutW = () => $('#gutter').offsetWidth || 50;
const firstVis = () => colw ? Math.round(scroller.scrollLeft / colw) : 0;
const startFor = i => clamp(i - ((ui.days - 1) >> 1), 0, 7 - ui.days);   // 让第 i 天大致居中时，最左边是哪天
function setColW(w) { colw = w; $('#week').style.setProperty('--colw', w + 'px'); }
function scrollX(x) { scroller.scrollLeft = x; $('#daysHead').scrollLeft = scroller.scrollLeft; }   // 星期栏同一帧跟上，不等 scroll 事件
function fitDays(reset) {   // 窗口宽度变了：重算列宽，最左边还是原来那天
  const W = scroller.clientWidth - gutW(); if (W <= 0) return;
  const first = reset || !colw ? startFor(diffDays(ymd(ui.week), ui.sel)) : firstVis();
  cancelAnimationFrame(colAnim); if (!asSlid) document.body.classList.remove('hfree');
  setColW(W / ui.days); scrollX(clamp(first, 0, 7 - ui.days) * colw);
}
function revealDay(ds, smooth = true) {   // 选中的那天不在眼前时，横向滚过去
  if (ui.days >= 7 || !colw || !inWeek(ds)) return;
  const i = diffDays(ymd(ui.week), ds), f = firstVis();
  const to = i < f ? i : i > f + ui.days - 1 ? i - ui.days + 1 : f;
  if (to !== f) scroller.scrollTo({ left: to * colw, behavior: smooth && motion ? 'smooth' : 'auto' });
}
function setDays(n, clientX) {
  n = clamp(n, 1, 7);
  if (n !== ui.days && colw) {
    const W = scroller.clientWidth - gutW(), from = colw, to = W / n, r = scroller.getBoundingClientRect();
    const ax = clientX == null ? W / 2 : clamp(clientX - r.left - gutW(), 0, W);   // 锚点：指针在列区里的横向位置
    const at = (scroller.scrollLeft + ax) / from;                                    // 指针下是第几天（带小数）
    const l0 = scroller.scrollLeft / from, l1 = clamp(Math.round(at - ax / to), 0, 7 - n);
    ui.days = n;
    const k = web ? 'pdays' : 'days';   // 手机和电脑屏幕宽窄不同，各记各的
    if (data.settings[k] !== n) { data.settings[k] = n; save(); }
    // 列宽和横向位置一起平滑过渡：每帧按当前列宽换算，指针下的那天始终跟着指针
    cancelAnimationFrame(colAnim); document.body.classList.add('hfree');
    const t0 = performance.now(), dur = motion ? 260 : 0;
    const step = now => {
      const p = dur ? Math.min(1, (now - t0) / dur) : 1, e = 1 - (1 - p) ** 3, w = from + (to - from) * e;
      setColW(w); scrollX((l0 + (l1 - l0) * e) * w);
      if (p < 1) colAnim = requestAnimationFrame(step);
      else { document.body.classList.remove('hfree'); renderGrid(true); }
    };
    if (dur) colAnim = requestAnimationFrame(step); else step(t0);
  }
  zoomTip(n === 7 ? '一周 7 天' : web ? `一屏 ${n} 天` : `显示 ${n} 天　Ctrl+0 回到一周`);
}
let wAcc = 0, wAccT = 0, wLast = 0;
function wheelStep(e) {   // 滚轮 → 一格一格：鼠标一格直接算一步，触摸板的细碎增量攒够了再算；一次甩动不会一路冲到底
  const d = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaMode === 2 ? e.deltaY * 300 : e.deltaY;
  clearTimeout(wAccT); wAccT = setTimeout(() => { wAcc = 0; }, 250);
  wAcc += d;
  const now = performance.now();
  if (Math.abs(wAcc) < 30 || now - wLast < 90) return 0;
  const s = Math.sign(wAcc); wAcc = 0; wLast = now; return s;
}
function zoomTip(text) {
  const t = $('#zoomTip'), r = scroller.getBoundingClientRect();
  t.textContent = text;
  t.style.left = r.left + gutW() + (r.width - gutW()) / 2 + 'px'; t.style.top = r.top + 8 + 'px';
  t.classList.add('show'); clearTimeout(tipT); tipT = setTimeout(() => t.classList.remove('show'), 1100);
}

// ───────────────────────── 迷你卡片：日程方块视图 ─────────────────────────
// 只看一天：“一屏显示”的时段（有日程落在外面就自动放宽）整段铺满，日程是方块，一眼看清这一天怎么排的。
// 点一个方块：回到待办列表并闪一下这个日程的小任务。
const dv = { hh: 0, a: 7, b: 23, gk: '', blocks: new Map() };
function renderDayView(flip, animate = false) {
  if (!(ui.mini && ui.dayView)) return;
  const ds = ui.sel, td = today(), nm = nowMin(), occs = layoutCols(occsOn(ds)), dayTasks = data.tasks.filter(t => t.date === ds);
  let a = data.settings.dayStart, b = data.settings.dayEnd;
  for (const o of occs) { a = Math.min(a, Math.floor(o.start / 60)); b = Math.max(b, Math.ceil(o.end / 60)); }
  dv.a = a; dv.b = b;
  const H = $('#dvScroll').clientHeight - 18; if (H <= 0) return;   // 18 = 上下留白
  const hh = Math.floor(Math.max(14, H / (b - a))), col = $('#dvCol'), body = $('#dvBody');   // 整数像素，理由同周视图
  dv.hh = hh; setHourH($('#dayView'), hh); body.style.setProperty('--span', b - a);
  const gk = a + '-' + b;
  if (dv.gk !== gk) { dv.gk = gk; $('#dvGutter').innerHTML = Array.from({ length: b - a + 1 }, (_, i) => `<span class="hl" style="--h:${i}">${pad(a + i)}:00</span>`).join(''); }
  const view = { hh, colW: col.clientWidth, off: a * 60, grip: false }, seen = new Set();
  for (const o of occs) {
    seen.add(o.key);
    let n = dv.blocks.get(o.key);
    const fresh = !n;
    if (fresh) { n = document.createElement('div'); n.className = 'ev'; dv.blocks.set(o.key, n); col.appendChild(n); }
    fillBlock(n, o, dayTasks, td, nm, view, fresh || !animate);
  }
  for (const [k, n] of dv.blocks) if (!seen.has(k)) { n.remove(); dv.blocks.delete(k); }
  const now = $('#dvNow'), on = ds === td && nm >= a * 60 && nm <= b * 60;
  now.hidden = !on;
  if (on) { now.style.setProperty('--s', nm - a * 60); now.firstChild.textContent = hm(nm); }
  for (const l of $$('#dvGutter .hl')) l.classList.toggle('near', on && Math.abs((a + +l.style.getPropertyValue('--h')) * 60 - nm) * hh / 60 < 13);
  $('#dvEmpty').hidden = occs.length > 0;
  if (flip) body.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
}
function syncPanes() {   // 迷你卡片里：日程方块视图 / 待办 / 随记，三选一
  const on = ui.mini && ui.dayView, btn = $('#dayBtn');
  document.body.classList.toggle('dayview', on);
  $('#dayView').classList.toggle('off', !on);
  $('#todoBody').classList.toggle('off', on || ui.tab !== 'todo');
  $('#memoPane').classList.toggle('off', on || ui.tab !== 'memo');
  btn.classList.toggle('on', ui.dayView); btn.title = ui.dayView ? '回到待办列表 (D)' : '日程方块视图 (D)';
}
function setDayView(on) {
  if (ui.dayView === on) return;
  ui.dayView = on;
  const mv = on ? 'day' : 'list';
  if (data.settings.miniView !== mv) { data.settings.miniView = mv; save(); }   // 记住：下次打开迷你卡片还是这个视图
  syncPanes();
  if (on) renderDayView(); else moveInd();
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
      fillBlock(b, o, dayTasks, td, nm, undefined, instant || fresh);
      if (fresh && !instant && motion) inkFill(b);
      if (b._lift && !b.classList.contains('dragging')) land(b);   // 兜底：拖动结束总要落定
    }
  }
  for (const [k, b] of blocks) {
    if (seen.has(k)) continue;
    blocks.delete(k);
    if (instant || !motion) b.remove();
    else {   // 删掉的日程像纸条一样往下飘走
      b.style.pointerEvents = 'none';
      b.animate([{ opacity: 0, translate: '0 8px', rotate: '-1.5deg', scale: .96 }], { duration: 300, easing: 'cubic-bezier(.45,0,.8,.5)' }).onfinish = () => b.remove();
    }
  }
  if (pop && pop.kind === 'ev') blocks.get(pop.key)?.classList.add('active');
  updateNow();
}
// 日程块里的小任务：放得下几行就列几行；放不下时没做完的排前面，末行右边标“+N”。方框可以直接勾。
const LH_T = 16.5, LH_TM = 14.6, ROW_H = 16;   // 标题一行 / 时间一行 / 小任务一行的高度（px）
const twCache = new Map(), tctx = document.createElement('canvas').getContext('2d');
let fontFam = '';
function textW(str, px) {   // 估算一段文字有多宽，用来推算标题会折成几行
  const k = px + '|' + str; let w = twCache.get(k);
  if (w == null) {
    if (!fontFam) fontFam = getComputedStyle(document.body).fontFamily;
    tctx.font = `${px}px ${fontFam}`; w = tctx.measureText(str).width;
    if (twCache.size > 600) twCache.clear();
    twCache.set(k, w);
  }
  return w;
}
const lines = (str, px, w) => Math.max(1, Math.ceil(textW(str, px) * 1.04 / Math.max(w, 1)));
function makeEvTask() {
  return el(`<li class="ev-tk"><button class="ev-chk" title="完成 / 取消完成">${BOX}</button><span class="ev-tx"><span class="ev-tx-in"></span></span><span class="ev-plus" hidden></span></li>`);
}
function fillEvTask(n, t, more) {   // more：这一行是末行、后面还有几项没列出来
  n.classList.toggle('done', !!t.done);
  const s = n.querySelector('.ev-tx-in'); if (s.textContent !== t.text) s.textContent = t.text;
  n.title = t.text;
  const p = n.lastChild, txt = more ? `+${more.n}` : '';
  p.hidden = !more; if (p.textContent !== txt) p.textContent = txt;
  p.title = more ? `还有 ${more.n} 项小任务` + (more.open ? `（${more.open} 项没做完）` : '，都已完成') : '';
}
// view：哪种视图在画这个块——每小时多高、列多宽、时间从几点算起（off 分钟）、要不要拉伸手柄
function fillBlock(b, o, dayTasks, td, nm, view = { hh: ui.hourH, colW: ui.colW, off: 0, grip: true }, instant = true) {
  const ev = o.ev, ts = dayTasks.filter(t => t.eventId === ev.id).sort(byOrder), dn = ts.filter(t => t.done).length;
  const raw = (o.end - o.start) * view.hh / 60, px = Math.max(18, raw - 2);   // raw：这段时间多高；px：块实际多高
  b.dataset.key = o.key; b.dataset.id = ev.id; b.dataset.date = o.date;
  const st = b.style;
  st.setProperty('--s', o.start - view.off); st.setProperty('--e', o.end - view.off);
  st.setProperty('--l', o.col / o.ncol); st.setProperty('--w', 1 / o.ncol);
  st.setProperty('--c', `var(--c-${ev.color || 'dai'})`);
  b.classList.toggle('past', o.date < td || (o.date === td && o.end <= nm));
  b.classList.toggle('live', o.date === td && o.start <= nm && nm < o.end);
  b.classList.toggle('short', raw < 38);
  b.classList.toggle('tiny', raw < 22);
  if (b._sk !== view.grip) {   // 骨架只搭一次；各部分分别更新，小任务行跨渲染复用，勾选才有过渡
    b.innerHTML = `<div class="ev-t"></div><div class="ev-tm"></div><ul class="ev-ts"></ul><div class="ev-badge" hidden></div>${view.grip ? '<div class="ev-grip"></div>' : ''}`;
    b._sk = view.grip; b._t = b._tm = null;
  }
  const [tEl, tmEl, list, badge] = b.children;
  const rep = ev.repeat && ev.repeat !== 'none';
  // 块里净空多高、多宽（块宽减去 5px 间隙和左右内边距；底边留出拉伸手柄）
  const inW = view.colW / o.ncol - 20, inH = px - 7 - (view.grip ? 4 : 0);
  // 时间：一行放不下“开始–结束”时只写开始时间（完整时段在悬停提示里），重复标记放得下才带上
  const tmOpts = [`${hm(o.start)}–${hm(o.end)}`, hm(o.start)].flatMap(x => rep ? [x + ' ↻', x] : [x]);
  const tmStr = tmOpts.find(x => textW(x, 11) * 1.04 <= inW) || tmOpts[tmOpts.length - 1];
  const tHtml = ev.title ? esc(ev.title) : '<span class="ph">未命名</span>', tmHtml = tmStr.replace(' ↻', ' <i class="rep">↻</i>');
  if (b._t !== tHtml) { tEl.innerHTML = tHtml; b._t = tHtml; }
  if (b._tm !== tmHtml) { tmEl.innerHTML = tmHtml; b._tm = tmHtml; }
  const tmLines = clamp(lines(tmStr, 11, inW), 1, 2);
  // 窄到连开始时间都写不下一行（手机上一屏看很多天、又有并排的日程）：不写时间，位置本身就是时间，标题一字一行竖着排
  const slim = textW(hm(o.start), 11) * 1.04 > inW;
  b.classList.toggle('slim', slim);

  // 排版
  let tl = slim ? clamp(Math.floor((raw - 7) / LH_T), 1, 6) : clamp(Math.floor((raw - 7 - LH_TM * tmLines) / LH_T), 1, 4), items = [], more = null, inl = false, noTm = false;
  if (ts.length && raw >= 38 && inW >= 60) {
    // 地方让给小任务：块够宽时标题和时间并成一行；不够宽时标题最多两行，挤不下再只留一行；
    // 还是连一行小任务都放不下，就收起时间（块的位置本身就说明了时间）
    inl = (textW(ev.title || '未命名', 12.5) + textW(tmStr, 11)) * 1.04 + 8 <= inW;
    const head = (n, tm) => inl ? LH_T : n * LH_T + (tm ? tmLines * LH_TM : 0);
    const room = (n, tm = true) => Math.floor((inH - head(n, tm) - 2) / ROW_H);
    tl = inl ? 1 : Math.min(lines(ev.title || '未命名', 12.5, inW), 2);
    if (tl > 1 && room(tl) < ts.length) tl = 1;
    if (!inl && room(tl) < 1 && room(tl, false) >= 1) noTm = true;
    const R = Math.max(0, room(tl, !noTm));
    if (R >= ts.length) items = ts;
    else if (R) {
      const order = [...ts.filter(t => !t.done), ...ts.filter(t => t.done)], rest = order.slice(R);
      items = order.slice(0, R);
      more = { n: rest.length, open: rest.filter(t => !t.done).length };
    }
  }
  b._ovf = !!more;   // 没放下全部：勾掉的会让位给还没做的
  b.classList.toggle('inl', inl); b.classList.toggle('notm', noTm);
  st.setProperty('--lines', tl);
  const last = items[items.length - 1];
  reconcile(list, items, t => t.id, makeEvTask, (n, t) => fillEvTask(n, t, t === last ? more : null), instant || !motion);
  // 列不出小任务时（块太矮 / 太窄），右下角还是显示完成了几项；窄块里会压住时间的话就不显示（悬停提示里有）
  let bt = ts.length && !items.length && !slim ? `${dn === ts.length ? '✓ ' : ''}${dn}/${ts.length}` : '';
  if (bt && raw >= 38) {
    const bottom = 3 + Math.min(tl, lines(ev.title || '未命名', 12.5, inW)) * LH_T + tmLines * LH_TM;
    if (bottom > px - 17 && textW(tmStr, 11) * 1.04 + 32 > inW) bt = '';
  }
  badge.hidden = !bt; badge.classList.toggle('all', dn === ts.length);
  if (badge.textContent !== bt) badge.textContent = bt;
  b.title = `${ev.title || '未命名'}  ${hm(o.start)}–${hm(o.end)}${rep ? '（重复）' : ''}${ts.length ? `\n小任务 ${dn}/${ts.length}` : ''}${ev.note ? '\n' + ev.note : ''}`;
}
function updateNow() {
  const idx = diffDays(ymd(ui.week), today()), nl = $('#nowLine');
  const lb = $('#nowLbl');
  if (idx < 0 || idx > 6) { nl.hidden = lb.hidden = true; return; }
  const m = nowMin();
  nl.hidden = lb.hidden = false; nl.style.setProperty('--s', m); nl.style.setProperty('--i', idx);
  lb.style.setProperty('--s', m); lb.textContent = hm(m);
  // 离“现在”标签太近的整点标签让位；按像素算，缩放后也合适
  for (const l of $$('#gutter .hl')) l.classList.toggle('near', Math.abs(+l.style.getPropertyValue('--h') * 60 - m) * ui.hourH / 60 < 13);
}

// ───────────────────────── 周视图：拖拽创建 / 移动 / 拉伸 ─────────────────────────
let drag = null, downClosedPop = false, closedKind = null;
const minAt = y => (y - $('#gridBody').getBoundingClientRect().top) / ui.hourH * 60;
const colW = () => colsEl.getBoundingClientRect().width / 7;
const dayAt = x => {   // 指针压在左边时间刻度上（下面是滚出去的那天）时，算作最左边看得见的那天
  const r = scroller.getBoundingClientRect(); x = clamp(x, r.left + gutW(), r.right - 1);
  return clamp(Math.floor((x - colsEl.getBoundingClientRect().left) / colW()), 0, 6);
};
const snap15 = m => Math.round(m / 15) * 15;
const floorTo = (m, s) => Math.floor(m / s) * s;

// 手指（手机）：轻点和鼠标单击一样；按住不动约 0.4 秒，日程块被“拿起来”（空白处则开始划出新日程）才跟着手指走；
// 没按住就移动，是在滚动页面，交给浏览器。拿起之后拦下 touchmove，页面就不会跟着滚。
const HOLD_MS = 380;
let lastScrollT = 0;
colsEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 || drag) return;
  if (e.target.closest('.ev-chk')) { e.preventDefault(); return; }   // 勾块里的小任务：不拖动、不开浮层
  const b = e.target.closest('.ev');
  if (downClosedPop && !b) return;              // 这次点击只是为了关掉浮层
  const touch = e.pointerType === 'touch';
  if (touch && performance.now() - lastScrollT < 300) return;   // 这一下只是按停正在惯性滚动的页面
  if (!touch) e.preventDefault();
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
  Object.assign(drag, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false, pid: e.pointerId, touch, armed: !touch });
  if (touch) drag.hold = setTimeout(armDrag, HOLD_MS);
  else try { colsEl.setPointerCapture(e.pointerId); } catch {}
});
function armDrag() {   // 按住够久了：拿起来
  const d = drag; if (!d || d.armed) return;
  d.armed = true; d.x0 = d.x; d.y0 = d.y;
  dragMove();
}
colsEl.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.armed) {   // 还没拿起来就动了：是在滚动页面
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) > 8) { clearTimeout(drag.hold); drag = null; }
    return;
  }
  dragMove(); autoScroll(e.clientX, e.clientY);
});
colsEl.addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pid) { clearTimeout(drag.hold); dragEnd(); } });
colsEl.addEventListener('pointercancel', () => {
  if (!drag) return;
  clearTimeout(drag.hold);
  if (drag.armed) dragCancel(); else drag = null;
});
colsEl.addEventListener('touchmove', e => { if (drag && drag.armed) e.preventDefault(); }, { passive: false });
colsEl.addEventListener('click', e => { const c = e.target.closest('.ev-chk'); if (c) blockCheck(c); });

function dragMove() {
  const d = drag;
  if (!d.moved) {
    if (!d.touch && Math.hypot(d.x - d.x0, d.y - d.y0) < 4) return;   // 手指是按住拿起的，拿起就算开始拖
    d.moved = true;
    if (d.kind === 'create') {
      d.g = el(`<div class="ev ghost" style="--c:var(--c-${nextColor()});--l:0;--w:1"><div class="ev-tm"></div></div>`);
      colEls[d.day].appendChild(d.g);
    } else {
      d.b.classList.add('dragging'); d.b.style.setProperty('--l', 0); d.b.style.setProperty('--w', 1);
      if (d.kind === 'move') lift(d.b);
      if (pop && pop.kind === 'ev' && pop.evId === d.ev.id) pop.el.classList.add('dim');   // 拖动时让浮层淡出让路
      else closePop();
    }
  }
  const m = minAt(d.y);
  if (d.kind === 'create') {
    const b = clamp(floorTo(m, 15), 0, 1425);
    d.start = Math.min(d.a, b); d.end = Math.max(d.a, b) + 15;
    if (d.touch) d.end = Math.min(1440, Math.max(d.end, d.start + 30));   // 手指划的新日程至少半小时，方块大到能看清
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
  d.b._tm = null;
}
let asV = 0, asH = 0, asRAF = 0, asSlid = false;
function autoScroll(x, y) {   // 拖到上下边缘：上下滚；只显示几天时拖到左右边缘：滚到相邻的日子
  const r = scroller.getBoundingClientRect(), z = 34, L = r.left + gutW();
  asV = y < r.top + z ? -Math.ceil((r.top + z - y) / 3) : y > r.bottom - z ? Math.ceil((y - r.bottom + z) / 3) : 0;
  asH = ui.days >= 7 ? 0 : x < L + z ? -Math.ceil((L + z - x) / 3) : x > r.right - z ? Math.ceil((x - r.right + z) / 3) : 0;
  if (asH && !asSlid) { asSlid = true; document.body.classList.add('hfree'); }
  if ((asV || asH) && !asRAF) {
    const step = () => {
      if (!(asV || asH) || !drag) { asRAF = 0; return; }
      scroller.scrollTop += asV; scroller.scrollLeft += asH; dragMove(); asRAF = requestAnimationFrame(step);
    };
    asRAF = requestAnimationFrame(step);
  }
}
function snapBack() {   // 拖动带着横向滚了一段：松手后对齐到整列
  if (!asSlid) return;
  asSlid = false; document.body.classList.remove('hfree');
  if (colw) scroller.scrollTo({ left: clamp(firstVis(), 0, 7 - ui.days) * colw, behavior: motion ? 'smooth' : 'auto' });
}
function dragEnd() {
  const d = drag; drag = null; asV = asH = 0; snapBack();
  try { colsEl.releasePointerCapture(d.pid); } catch {}
  if (d.kind === 'create') {
    if (d.g) fadeAway(d.g);   // 划出的虚线框淡去，新日程的墨色同时注满
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
function dragCancel() { const d = drag; drag = null; asV = asH = 0; snapBack(); if (d.g) d.g.remove(); if (d.b) dragRevert(d); }
function dragRevert(d) {
  d.b.classList.remove('dragging'); d.b.style.removeProperty('--dx'); d.b._tm = null; land(d.b); renderGrid(true);
  if (pop) pop.el.classList.remove('dim');
}
function settle(b) {   // 拖放落定：取消变换且本帧不做过渡，避免“弹回再飞过去”
  b.classList.add('noanim'); b.classList.remove('dragging'); b.style.removeProperty('--dx'); b._tm = null;
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
    if (newKey === d.key) { d.b.classList.remove('dragging'); d.b.style.removeProperty('--dx'); d.b._tm = null; }
    else settle(d.b);
    if (ui.sel === d.occDate) ui.sel = newDate;
    if (own) { own.key = newKey; own.date = newKey.split('@')[1]; }
  }, !(own && own.isNew));   // 新建草稿的调整不单独记撤销：一次撤销就撤掉整个新日程
  land(d.b);
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
  const key = ev.id + '@' + date;   // 迷你卡片 / 手机正看日程方块时，浮层指向方块
  openEvPop(ev.id, date, (ui.mini && ui.dayView && dv.blocks.get(key)) || blocks.get(key), true);
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
  const dateEl = $('#todoDate');
  if (dateEl._html !== dateHtml) {
    dateEl.innerHTML = dateHtml; dateEl._html = dateHtml;
    if (dayChanged && lastSel !== null && motion)   // 换天像翻日历：往后翻新日期从下方上来，往回翻从上方下来
      [...dateEl.children].forEach((c, i) => c.animate([{ translate: `0 ${ds > lastSel ? 10 : -10}px`, opacity: 0 }, { translate: '0 0', opacity: 1 }],
        { duration: 320, delay: i * 45, easing: EASE, fill: 'backwards' }));
  }

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
  rollTo(pg.querySelector('span'), tot ? `${dn} / ${tot}` : '', !dayChanged, dn < (pg._dn ?? dn) ? -1 : 1); pg._dn = dn;
  pg.classList.toggle('full', complete);
  const seal = $('#sealDone');
  if (complete !== lastComplete || dayChanged) {
    seal.classList.remove('show');
    if (complete) { void seal.offsetWidth; seal.classList.add('show'); if (!dayChanged) stampRing(seal); }
  }
  seal.title = complete ? '这一天的待办全部完成' : '';
  lastComplete = complete;
  const flip = dayChanged && lastSel !== null && motion;
  if (flip) $('#todoBody').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
  lastSel = ds;
  renderNowNext();
  renderDayView(flip, !dayChanged);
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
function toggleTask(id, li, G, linger = G.kind === 'carry') {
  const t = data.tasks.find(x => x.id === id); if (!t || li._linger) return;
  if (!t.done) inkCheck(li.querySelector('.chk, .ev-chk'));
  if (linger && !t.done) {          // 勾掉后这一行会挪走（“没做完的”、放不下全部的日程块）：先让勾选动画播完
    li.classList.add('done'); li._linger = true;
    setTimeout(() => { li._linger = false; commit(() => { t.done = true; t.doneAt = Date.now(); }); }, 650);
    return;
  }
  commit(() => { t.done = !t.done; t.doneAt = t.done ? Date.now() : null; });
}
function blockCheck(chk) {   // 在日程块里直接勾小任务
  const li = chk.closest('.ev-tk'), b = chk.closest('.ev'); if (!li || !b || !li.dataset.k) return;
  const t = data.tasks.find(x => x.id === li.dataset.k); if (!t) return;
  toggleTask(t.id, li, { kind: 'ev' }, b._ovf);
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
document.addEventListener('dblclick', e => editText(e.target.closest('.tx-in')));   // 双击修改任务文字
if (web) document.addEventListener('click', e => editText(e.target.closest('.tx-in')));   // 手机上没有双击：点一下文字就改
function editText(tx) {
  if (!tx || tx.isContentEditable) return;
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
}

// ───────────────────────── 浮层 ─────────────────────────
let pop = null;
const layer = $('#layer');
function placePop(p, r, prefer) {
  if (web) return;   // 手机上浮层是贴底的卡片，位置交给 CSS
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
    const b = e.target.closest('.sw'); if (!b || b.classList.contains('on')) return;
    const from = `var(--c-${p.querySelector('.sw.on')?.dataset.c || 'dai'})`, id = blocks.get(st.key)?.dataset.id;
    editEv(ev => { ev.color = b.dataset.c; });
    for (const s of $$('.sw', p)) s.classList.toggle('on', s === b);
    if (id) for (const blk of blocks.values()) if (blk.dataset.id === id) wash(blk, from);   // 重复日程：这一周里的每一块一起换
  });
  const title = p.querySelector('.pop-title');
  title.addEventListener('input', () => editEv(ev => { ev.title = title.value; }));
  title.addEventListener('keydown', e => { if (e.key === 'Enter' && !composing(e)) { e.preventDefault(); closePop(); } });
  p.querySelector('.bell').addEventListener('click', e => {
    editEv(ev => { ev.remind = ev.remind === false; });
    e.currentTarget.classList.toggle('on', findEv(st.evId).remind !== false);
    jiggle(e.currentTarget.querySelector('svg'), findEv(st.evId).remind !== false ? 'ring' : 'tap');
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
  if (web) pushSaveSoon();   // 服务器按这个时区推送提醒
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
    ${web ? '<div class="set-row push-row"><span class="push-st"></span><button class="link push-go" hidden></button></div>' : ''}
    ${web ? `<div class="set-row"><span class="lab">周视图一屏</span><div class="stepper"><button data-pd="-1">−</button><b class="pdv">${s.pdays} 天</b><button data-pd="1">+</button></div></div>` : ''}
    <div class="set-row"><span class="lab">一屏显示</span><div class="stepper"><button data-st="ds-1">−</button><b class="dsv">${pad(s.dayStart)}:00</b><button data-st="ds1">+</button><span style="color:var(--ink-3);margin:0 2px">至</span><button data-st="de-1">−</button><b class="dev">${pad(s.dayEnd)}:00</b><button data-st="de1">+</button></div></div>
    ${tzOK ? '<div class="set-row"><span class="lab">时区</span><button class="tz-cur" title="笺按哪里的时间显示日程、发出提醒"></button></div>' : ''}
    <div class="set-row"><span class="lab">同步</span><span class="sync-st"></span>${web ? '<button class="link sync-now">立即同步</button>' : ''}</div>
    ${web ? '<div class="set-row"><span class="lab">这台设备</span><button class="link logout">退出登录</button></div>' : `<div class="set-row"><span class="lab">开机后在后台待命</span><button class="switch${ui.autostart ? ' on' : ''}" title="登录后自动在后台启动，以便准时提醒"></button></div>
    <div class="set-row"><span class="lab">数据</span><button class="link open-data">打开数据文件夹</button></div>`}
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
  $('.sync-st', p).textContent = syncText();
  if (web) setTimeout(paintPush);   // 浮层挂上页面后再填
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
    if (th) {   // 换纸色：整张纸柔和地渐变过去
      const k = th.dataset.th, same = s.theme === k; s.theme = k; save();
      const go = () => { applyTheme(); for (const x of $$('.th', p)) x.classList.toggle('on', x === th); };
      if (motion && !same && document.startViewTransition) document.startViewTransition(go).ready.catch(() => {});   // 连点时上一次过渡被打断，属正常
      else go();
      return;
    }
    const rem = t.closest('[data-rem]');
    if (rem) {
      s.remind = +rem.dataset.rem; save(); for (const x of $$('[data-rem]', p)) x.classList.toggle('on', x === rem);
      if (web) { if (s.remind && !PU.sub && pushOK() && Notification.permission !== 'denied') pushEnable(); else pushSaveSoon(); paintPush(); }
      return;
    }
    if (t.closest('.push-go')) { PU.sub ? pushTest() : pushEnable(); return; }
    const pd = t.closest('[data-pd]');
    if (pd) { setDays(ui.days + +pd.dataset.pd); $('.pdv', p).textContent = `${s.pdays} 天`; return; }
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
    if (t.closest('.sync-now')) { syncNow(); return; }
    if (t.closest('.logout')) { logout(); return; }
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
  if (ui.days < 7 && colw) scrollX(startFor(diffDays(ymd(mon), ui.sel)) * colw);   // 翻到的那周：选中那天放在眼前
  if (slide && motion) {
    // 滑入期间先不吸附整列：不然列一平移，横向吸附就把滚动位置跟着“吸”过去，滑入效果被抵消
    document.body.classList.add('hfree');
    let a;
    for (const n of [colsEl, $('#daysHead')])
      a = n.animate([{ opacity: 0, transform: `translateX(${dir * 26}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    a.finished.catch(() => {}).then(() => { if (!asSlid) document.body.classList.remove('hfree'); });
  }
}
function flipWeek(dir) {   // 手机上滑过一周的边缘：翻到下一周从周一看起，翻回上一周从周日看起
  const mon = addDays(ui.week, 7 * dir);
  ui.sel = ymd(dir > 0 ? mon : addDays(mon, 6));
  gotoWeek(mon);
}
function selectDay(ds) {
  if (!inWeek(ds)) { ui.sel = ds; gotoWeek(mondayOf(parse(ds))); return; }
  if (ui.sel === ds) return revealDay(ds);
  ui.sel = ds; renderHeader(); renderDays(); renderTodo(); revealDay(ds);
}
function goToday() { const td = today(); if (!inWeek(td)) { ui.sel = td; gotoWeek(thisMonday()); } else selectDay(td); scrollToNow(); pingNow(); }
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
  if (ui.mini) setDayView(false);
  setTab('todo');
  const g = $$('.grp', groupsBox).find(n => n.dataset.k === 'any@' + ui.sel); if (!g) return;
  g.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  openAdd(g.querySelector('.add'));
}
function setTab(tab) {
  ui.tab = tab;
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  syncPanes();
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
function togglePin() {
  ui.pinned = !ui.pinned; updatePinBtns();
  for (const b of [$('#pinBtn'), $('#pinBtn2')]) if (b.offsetParent) jiggle(b.querySelector('svg'), ui.pinned ? 'pinIn' : 'pinOut');
  send('setPinned', { pinned: ui.pinned }); if (!native) toast('预览模式不支持置顶');
}
function toggleMini() {
  closePop();
  if (web) {   // 手机：日视图（卡片）⇄ 周视图，记住停在哪个
    const mini = !ui.mini;
    data.settings.pview = mini ? 'card' : 'week'; save();
    document.body.classList.add('switching');
    setTimeout(() => onMode({ mini, pinned: false }), 140);
    return;
  }
  if (!native) return onMode({ mini: !ui.mini, pinned: ui.pinned });
  document.body.classList.add('switching');
  setTimeout(() => send('setMode', { mini: !ui.mini }), 160);
}
function onMode(st) {
  ui.mini = !!st.mini; ui.pinned = !!st.pinned;
  document.body.classList.toggle('mini', ui.mini);
  $('#todoHead').toggleAttribute('data-drag', ui.mini);
  syncPanes(); updatePinBtns(); renderAll();
  requestAnimationFrame(() => {
    document.body.classList.remove('switching');
    fitHours(false); fitDays(true); renderGrid(true); renderDayView(); moveInd(); reportDragSoon();
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
  if (e.ctrlKey && !e.altKey && !ui.mini && (k === '=' || k === '+' || k === '-' || k === '0')) {   // 一屏显示几天：放大 / 缩小 / 回到一周
    e.preventDefault();
    setDays(k === '0' ? 7 : ui.days + (k === '-' ? 1 : -1));
    return;
  }
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
    case 'd': if (!ui.mini) return; setDayView(!ui.dayView); break;
    default: return;
  }
  e.preventDefault();
});

// ───────────────────────── 启动 ─────────────────────────
function renderAll() { renderHeader(); renderDays(); renderGrid(); renderTodo(); refreshPop(); }

function init() {
  const icons = { prevWeek: I.left, nextWeek: I.right, settingsBtn: I.set, pinBtn: I.pin, miniBtn: I.mini, minBtn: I.min, closeBtn: I.close,
    prevDay: I.left, nextDay: I.right, dayBtn: I.day, pinBtn2: I.pin, expandBtn: I.expand, closeBtn2: I.close, syncInd: I.cloud, setBtn2: I.set };
  for (const [id, svg] of Object.entries(icons)) $('#' + id).innerHTML = svg;
  restamp();   // 以启动时的数据为基准，之后的改动才算本机修改
  applyTheme(); buildGrid();
  if (BOOT.opaque) document.body.classList.add('opaque');
  document.body.classList.toggle('mini', ui.mini);
  $('#todoHead').toggleAttribute('data-drag', ui.mini);
  updatePinBtns(); syncPanes();
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
  $('#daysHead').addEventListener('click', e => {
    const h = e.target.closest('.dh'); if (!h || !h.dataset.date) return;
    selectDay(h.dataset.date);
    if (web && !ui.mini) toggleMini();   // 手机没有侧边的待办栏：点日期就去看那天的日视图
  });
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('#dayBtn').onclick = () => setDayView(!ui.dayView);
  $('#setBtn2').onclick = e => { if (closedKind !== 'settings') openSettings(undefined, e.currentTarget); };
  $('#syncInd').onclick = () => { toast(syncText()); syncNow(); };
  $('#dvCol').addEventListener('click', e => {
    const c = e.target.closest('.ev-chk'); if (c) return blockCheck(c);   // 勾方块里的小任务：留在日程视图
    const b = e.target.closest('.ev');
    if (web) {   // 手机：点方块编辑这个日程；点空白处在那个时刻新建一小时
      if (b) return openEvPop(b.dataset.id, b.dataset.date, b);
      if (downClosedPop) return;
      const m = dv.a * 60 + (e.clientY - $('#dvBody').getBoundingClientRect().top) / dv.hh * 60;
      const st = clamp(floorTo(m, 30), 0, 1380);
      return createEvent(ui.sel, st, st + 60);
    }
    if (!b) return;
    setDayView(false); flashGroup(b.dataset.key);   // 迷你卡片：回到待办列表，闪一下它的小任务
  });
  // Ctrl+滚轮：往上滚放大（少显示一天），往下滚缩小（多显示一天）；不按 Ctrl 照常上下滚
  $('#week').addEventListener('wheel', e => {
    if (!e.ctrlKey || !e.deltaY) return;
    e.preventDefault();
    const s = wheelStep(e); if (s) setDays(ui.days + s, e.clientX);
  }, { passive: false });
  // 放大后在顶部星期栏上滚滚轮：左右翻看其他几天
  $('#daysHead').addEventListener('wheel', e => {
    if (e.ctrlKey || ui.days >= 7 || !e.deltaY) return;
    e.preventDefault();
    const s = wheelStep(e); if (s) scroller.scrollTo({ left: clamp(firstVis() + s, 0, 7 - ui.days) * colw, behavior: motion ? 'smooth' : 'auto' });
  }, { passive: false });
  scroller.addEventListener('scroll', () => { $('#daysHead').scrollLeft = scroller.scrollLeft; if (!drag) lastScrollT = performance.now(); }, { passive: true });
  if (web) {
    // 两指捏合（iOS 的 gesture 事件）：张开看得少而大，捏拢看得多；顺便挡住整页被放大
    let g0 = 0;
    $('#week').addEventListener('gesturestart', e => { e.preventDefault(); g0 = ui.days; if (drag) { clearTimeout(drag.hold); if (drag.armed) dragCancel(); else drag = null; } }, { passive: false });
    $('#week').addEventListener('gesturechange', e => { e.preventDefault(); const n = clamp(Math.round(g0 / e.scale), 1, 7); if (n !== ui.days) setDays(n, e.clientX); }, { passive: false });
    $('#week').addEventListener('gestureend', e => e.preventDefault(), { passive: false });
    // 已经滚到这周最左 / 最右，再往外划：翻到上一周 / 下一周
    let sw = null;
    scroller.addEventListener('touchstart', e => {
      if (e.touches.length !== 1 || drag) { sw = null; return; }
      const t = e.touches[0], max = scroller.scrollWidth - scroller.clientWidth;
      sw = { x: t.clientX, y: t.clientY, t: performance.now(), atL: scroller.scrollLeft <= 1, atR: scroller.scrollLeft >= max - 1 };
    }, { passive: true });
    scroller.addEventListener('touchend', e => {
      const s = sw; sw = null;
      if (!s || (drag && drag.armed) || e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6 || performance.now() - s.t > 700) return;
      if (dx < 0 && s.atR) flipWeek(1); else if (dx > 0 && s.atL) flipWeek(-1);
    }, { passive: true });
    $('#expandBtn').title = '周视图'; $('#miniBtn').title = '回到日视图';
    // 点了提醒通知：打开到那天、闪一下那个日程
    navigator.serviceWorker?.addEventListener('message', e => { if (e.data && e.data.type === 'focus') App.focus(e.data.date, e.data.id); });
    const f = /^#focus=(\d{4}-\d{2}-\d{2})(?:,([\w-]+))?$/.exec(location.hash);
    if (f) { history.replaceState(null, '', location.pathname); setTimeout(() => App.focus(f[1], f[2]), 400); }
  }
  $('#memo').addEventListener('input', e => { data.memo = e.target.value; save(); });

  renderAll();
  new ResizeObserver(() => { fitHours(true); fitDays(); renderGrid(true); }).observe(scroller);
  new ResizeObserver(() => renderDayView()).observe($('#dvScroll'));
  addEventListener('resize', () => { moveInd(); reportDragSoon(); if (pop) placePop(pop.el, pop.rect, pop.prefer); });
  requestAnimationFrame(() => { fitHours(false); fitDays(true); renderGrid(true); moveInd(); reportDragSoon(); });
  document.fonts && document.fonts.ready.then(() => { twCache.clear(); fontFam = ''; renderGrid(true); renderDayView(); moveInd(); reportDragSoon(); });
  setTimeout(() => { tick(); setInterval(tick, 60000); }, 60300 - Date.now() % 60000);
  if (motion) $('#frame').animate([{ opacity: 0, transform: 'translateY(10px) scale(.99)' }, { opacity: 1, transform: 'none' }], { duration: 460, easing: EASE });
  if (web) {   // 手机：离线可用（Service Worker 缓存界面），打开、回到前台、联网时同步，开着时每分钟一次
    let stale = false;   // 服务器上有了新版本：等下次回到前台时自动刷新（数据都已存在本机）
    if ('serviceWorker' in navigator) {
      const hadSW = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadSW) stale = true; });
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { if (saveT) flush(); return; }
      if (stale && !pop && !drag && document.activeElement === document.body) { location.reload(); return; }
      tick(); syncSoon(200);
      if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
    });
    addEventListener('online', () => syncSoon(200));
    setInterval(() => { if (!document.hidden) syncNow(); }, 60000);
    setInterval(() => { if ($('#syncInd')) $('#syncInd').title = syncText(); }, 30000);
    syncNow(); pushInit();
  }
  send('ready');
}

window.App = {
  dump() { clearTimeout(saveT); saveT = 0; stamp(); return JSON.stringify(data); },
  applyRemote(remote) { return applyRemote(remote); },   // 桌面原生层同步到服务器上的改动
  syncState(st) { syncInfo = st || {}; paintSyncText(); },   // 桌面原生层报告同步状态（设置里显示）
  onMode, onWindowState,
  onShow() { tick(); reportDragSoon(); },
  setAutostart(on) { ui.autostart = !!on; },
  focus(date, evId) {
    selectDay(date);
    const key = evId + '@' + date, b = blocks.get(key), d = ui.mini && ui.dayView && dv.blocks.get(key);
    if (b && !ui.mini) revealBlock(b, findEv(evId)?.start || 0);
    if (d) { d.scrollIntoView({ block: 'nearest' }); d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash'); }   // 迷你卡片正看方块视图
    else flashGroup(key);
  },
  // 供测试脚本使用
  _debug: { get data() { return data; }, set data(v) { data = normalize(v); renderAll(); }, ui, renderAll, createEvent, openEvPop, openSettings, toast, gotoWeek, selectDay, closePop, toggleMini, onMode,
    today, nowMin, setTz, zoneOffset, zoneItems, undo, goToday, togglePin, blocks, dv, setDayView, fitHours, setDays, shift, addDays, get colw() { return colw; } },
};

init();
})();

// 共用支出, the web version for Erik. Reads and writes the same Supabase
// tables as Julia's iOS app (Ledger/SharedLedger in ledger-ios); the rules
// for splitting and balances are the same as SharedModels.swift there.
// Only the publishable key is here; what a login may see is decided by the
// database's row rules. Open with ?sample to try it with made-up records.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const SUPABASE_URL = 'https://ojxlckjjncukyoafvwgv.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_ptXYLFx_DGtLseHgZKum3w_sk0-2YoW';
// The household ledger (濟南小築); trip ledgers may come later
const HOUSEHOLD = '5a1f0c3e-0000-4000-8000-000000000001';
const TIME_ZONE = 'Asia/Taipei';

const sample = new URLSearchParams(location.search).has('sample');
const db = sample ? null : createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
  auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const CATEGORIES = {
  dining: { title: '餐飲', icon: 'utensils', color: '#FF9F43', subs: ['晚餐', '午餐', '早餐', '飲料', '點心', '宵夜'] },
  grocery: { title: '食材日用', icon: 'shopping-cart', color: '#6FD6A8', subs: ['家用品', 'PX', '市場', '食品'] },
  bill: { title: '帳單', icon: 'receipt', color: '#C9CDDB', subs: ['網路', '電費', '水費', '瓦斯'] },
  household: { title: '居家', icon: 'house', color: '#8FB2FF', subs: [] },
  transport: { title: '交通', icon: 'tram-front', color: '#5CD6FF', subs: ['Taxi', '停車', '高鐵'] },
  entertainment: { title: '娛樂', icon: 'gamepad-2', color: '#F78CFF', subs: [] },
  shopping: { title: '購物', icon: 'shopping-bag', color: '#B69CFF', subs: [] },
  other: { title: '其他', icon: 'ellipsis', color: '#8D93A6', subs: [] },
  transfer: { title: '結清', icon: 'arrow-left-right', color: '#C8F55A', subs: [] },
  income: { title: '收入', icon: 'banknote', color: '#C8F55A', subs: [] },
};
const PICKABLE = ['dining', 'grocery', 'bill', 'household', 'transport', 'entertainment', 'shopping', 'other'];

const state = {
  status: 'loading', // loading | signedOut | notMember | ready
  me: null,
  email: null,
  names: { julia: 'Julia', erik: 'Erik' },
  entries: [], // not deleted, household ledger, newest first
  month: monthKey(today()),
  offline: false,
  menuOpen: false,
  view: 'list', // list | stats | category
  basis: 'total', // 統計 counts the whole amount or my share
  statsCategory: null,
  byAmount: false,
};

// ---------- Money and dates ----------

function cents(text) {
  const cleaned = String(text ?? '').replace(/,/g, '').trim();
  if (!cleaned || !/^\d*\.?\d{0,2}$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

function money(c) {
  const negative = c < 0;
  const value = Math.abs(c);
  const whole = Math.floor(value / 100).toLocaleString('en-US');
  const fraction = value % 100;
  return (negative ? '−' : '') + whole + (fraction ? '.' + String(fraction).padStart(2, '0') : '');
}

function typed(c) { return money(c).replace(/,/g, ''); }

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function monthKey(day) { return day.slice(0, 7); }

function shiftMonth(key, by) {
  let [y, m] = key.split('-').map(Number);
  m += by;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function dayLabel(day) {
  const now = today();
  const [, m, d] = day.split('-').map(Number);
  const short = `${m}/${d}`;
  if (day === now) return { word: '今天', short };
  const y = new Date(now + 'T00:00:00Z'); y.setUTCDate(y.getUTCDate() - 1);
  if (day === y.toISOString().slice(0, 10)) return { word: '昨天', short };
  return { word: null, short };
}

// Icons from Lucide (icons/, ISC licence), drawn in the current text colour
function glyph(name) {
  return `<span class="glyph" style="--icon:url(icons/${name}.svg)" aria-hidden="true"></span>`;
}

function escape(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------- Members and splits ----------

const other = member => (member === 'julia' ? 'erik' : 'julia');
const paid = (e, m) => (m === 'julia' ? e.julia_paid_cents : e.erik_paid_cents);
const share = (e, m) => (m === 'julia' ? e.julia_share_cents : e.erik_share_cents);
const partnerName = () => state.names[other(state.me)];
const nameOf = m => (m === state.me ? '我' : state.names[m]);

// Positive: the other one owes me
function balance() {
  return state.entries.reduce((sum, e) => sum + paid(e, state.me) - share(e, state.me), 0);
}

// Who paid and how it's divided → the four amounts; null when a typed part is too big
function amounts(total, draft) {
  if (!(total > 0)) return null;
  const minePaid = draft.payer === 'me' ? total : draft.payer === 'partner' ? 0 : cents(draft.minePaidText);
  let myShare;
  switch (draft.division) {
    // An odd cent goes to whoever paid more
    case 'equal': myShare = minePaid * 2 > total ? total - Math.floor(total / 2) : Math.floor(total / 2); break;
    case 'allMine': myShare = total; break;
    case 'allPartners': myShare = 0; break;
    default: myShare = cents(draft.myShareText);
  }
  if (minePaid == null || myShare == null || minePaid > total || myShare > total) return null;
  return { minePaid, partnerPaid: total - minePaid, myShare, partnerShare: total - myShare };
}

function splitOf(e) {
  const total = e.amount_cents, minePaid = paid(e, state.me), myShare = share(e, state.me);
  const payer = minePaid === total ? 'me' : minePaid === 0 ? 'partner' : 'both';
  const base = { payer, minePaidText: payer === 'both' ? typed(minePaid) : '' };
  const equal = amounts(total, { ...base, division: 'equal' })?.myShare;
  const division = myShare === equal ? 'equal' : myShare === total ? 'allMine' : myShare === 0 ? 'allPartners' : 'custom';
  return { ...base, division, myShareText: division === 'custom' ? typed(myShare) : '' };
}

function detailOf(e) {
  if (e.kind === 'settlement') {
    const payer = e.julia_paid_cents > 0 ? 'julia' : 'erik';
    return payer === state.me ? `我付給 ${partnerName()}` : `${partnerName()} 付給我`;
  }
  if (e.kind === 'income') return '收入';
  const s = splitOf(e);
  const payer = { me: '我付', partner: `${partnerName()} 付`, both: '各付一部分' }[s.payer];
  const division = { equal: '平分', allMine: '全算我', allPartners: `全算 ${partnerName()}`, custom: '自訂' }[s.division];
  return [payer, division, e.note && !e.note.startsWith('Bill Bear 匯入') ? e.note : null].filter(Boolean).join(' · ');
}

// 子分類 for a category: names used under it before, most used first, then the usual ones
function subcategories(category) {
  const counts = new Map(), latest = new Map();
  for (const e of state.entries) {
    if (e.kind !== 'expense' || e.category !== category || !e.name) continue;
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    if (!latest.has(e.name)) latest.set(e.name, e);
  }
  const used = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (latest.get(b).date > latest.get(a).date ? 1 : -1));
  const unused = (CATEGORIES[category]?.subs ?? []).filter(n => !counts.has(n));
  return [...used.map(n => ({ name: n, cents: latest.get(n).amount_cents })), ...unused.map(n => ({ name: n, cents: null }))];
}

// ---------- Data ----------

async function loadEntries() {
  if (sample) return;
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('shared_entries').select('*')
      .eq('ledger_id', HOUSEHOLD).is('deleted_at', null)
      .order('date', { ascending: false }).order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  state.entries = all;
}

async function refresh() {
  try {
    await loadEntries();
    state.offline = false;
  } catch {
    state.offline = true;
  }
  render();
}

async function saveRow(row, isNew) {
  if (sample) {
    const index = state.entries.findIndex(e => e.id === row.id);
    if (row.deleted_at) state.entries.splice(index, 1);
    else if (index >= 0) state.entries[index] = { ...state.entries[index], ...row };
    else state.entries.unshift({ ...row, created_by: state.me, created_at: new Date().toISOString() });
    state.entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return;
  }
  const query = isNew ? db.from('shared_entries').insert(row) : db.from('shared_entries').update(row).eq('id', row.id);
  const { data, error } = await query.select();
  if (error || !data?.length) throw error ?? new Error('not saved');
  await loadEntries();
}

function baseRow(id) {
  return {
    id, ledger_id: HOUSEHOLD, deleted_at: null,
    julia_paid_cents: 0, erik_paid_cents: 0, julia_share_cents: 0, erik_share_cents: 0,
  };
}

function putAmounts(row, a) {
  const mine = state.me, theirs = other(state.me);
  row[`${mine}_paid_cents`] = a.minePaid;
  row[`${theirs}_paid_cents`] = a.partnerPaid;
  row[`${mine}_share_cents`] = a.myShare;
  row[`${theirs}_share_cents`] = a.partnerShare;
}

// ---------- Screens ----------

const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet-root');

function render() {
  if (state.status === 'loading') { app.innerHTML = '<p class="empty">載入中…</p>'; return; }
  if (state.status === 'signedOut') {
    app.innerHTML = `
      <section class="login">
        <h1>共用支出</h1>
        <p>用綁定共用帳的 Google 帳號登入。<br>登入一次之後會記住。</p>
        <button class="primary" data-action="google">用 Google 登入</button>
      </section>`;
    return;
  }
  if (state.status === 'notMember') {
    app.innerHTML = `
      <section class="login">
        <h1>這個帳號沒有加入共用帳</h1>
        <p>${escape(state.email ?? '')}</p>
        <button class="link" data-action="signOut">換一個帳號登入</button>
      </section>`;
    return;
  }

  if (state.view === 'stats') { renderStats(); return; }
  if (state.view === 'category') { renderCategory(); return; }

  const key = state.month;
  const [year, month] = key.split('-').map(Number);
  const isCurrent = key === monthKey(today());
  const monthEntries = state.entries.filter(e => e.date.startsWith(key));
  const spending = monthEntries.filter(e => e.kind === 'expense');
  const b = balance();
  const partner = partnerName();
  const label = b > 0 ? `${partner} 欠你 · 目前累計` : b < 0 ? `你欠 ${partner} · 目前累計` : '目前兩清';

  const days = new Map();
  for (const e of monthEntries) { if (!days.has(e.date)) days.set(e.date, []); days.get(e.date).push(e); }

  app.innerHTML = `
    <header class="header">
      <div>
        <div class="year">${year}</div>
        <div class="month">${month}月</div>
      </div>
      <div class="spacer"></div>
      <div class="pill">
        <button data-action="prevMonth" aria-label="上個月">‹</button>
        <span class="sep"></span>
        <button data-action="nextMonth" aria-label="下個月" ${isCurrent ? 'disabled' : ''}>›</button>
      </div>
      <button class="round" data-action="menu" aria-label="帳號">${glyph('user')}</button>
    </header>

    <section class="card balance">
      <div>
        <div class="label">${escape(label)}</div>
        <div class="amount num ${b < 0 ? 'owe' : ''}">NT$ ${money(Math.abs(b))}</div>
      </div>
      <div class="spacer"></div>
      ${b !== 0 ? '<button class="grey-button" data-action="settle">結清</button>' : ''}
    </section>

    <section class="tiles">
      <div class="card tile"><div class="label">本月共用</div><div class="value num">${money(spending.reduce((s, e) => s + e.amount_cents, 0))}</div></div>
      <div class="card tile"><div class="label">我的份</div><div class="value num">${money(spending.reduce((s, e) => s + share(e, state.me), 0))}</div></div>
      <button class="card tile link" data-action="stats" aria-label="共用分類">${glyph('chart-pie')}<span>分類</span></button>
    </section>

    ${state.offline ? '<p class="notice">沒有連上網路，顯示的是上次的資料</p>' : ''}
    ${days.size === 0 ? '<p class="empty">這個月還沒有共用支出</p>' : ''}
    ${[...days.entries()].map(([day, rows]) => dayBlock(day, rows)).join('')}

    <button class="fab" data-action="add" aria-label="新增共用支出">＋</button>
    ${state.menuOpen ? `
      <div class="menu" role="menu">
        <div class="who">${escape(state.email ?? '')}</div>
        <button data-action="refresh">重新整理</button>
        <button class="danger" data-action="signOut">登出</button>
      </div>` : ''}`;
}

// ---------- 共用分類 ----------

function monthSwitcher() {
  const [year, month] = state.month.split('-').map(Number);
  const isCurrent = state.month === monthKey(today());
  return `
    <div class="header">
      <div><div class="year">${year}</div><div class="month">${month}月</div></div>
      <div class="spacer"></div>
      <div class="pill">
        <button data-action="prevMonth" aria-label="上個月">‹</button>
        <span class="sep"></span>
        <button data-action="nextMonth" aria-label="下個月" ${isCurrent ? 'disabled' : ''}>›</button>
      </div>
    </div>`;
}

function topBar(title, trailing = '<span style="width:44px"></span>') {
  return `
    <div class="topbar">
      <button class="round" data-action="back" aria-label="返回">${glyph('chevron-left')}</button>
      <h1>${escape(title)}</h1>
      ${trailing}
    </div>`;
}

const amountOf = e => (state.basis === 'total' ? e.amount_cents : share(e, state.me));

function categoryTotals() {
  const totals = new Map();
  for (const e of state.entries) {
    if (e.kind !== 'expense' || !e.date.startsWith(state.month)) continue;
    const t = totals.get(e.category) ?? { key: e.category, cents: 0, count: 0 };
    t.cents += amountOf(e); t.count += 1;
    totals.set(e.category, t);
  }
  return [...totals.values()].filter(t => t.cents > 0).sort((a, b) => b.cents - a.cents);
}

// A thin ring with rounded segments, like the app's donut
function donut(totals, sum) {
  const r = 80, length = 2 * Math.PI * r, gap = totals.length > 1 ? 22 : 0;
  let start = 0;
  const arcs = totals.map(t => {
    const part = (t.cents / sum) * length;
    const arc = `<circle r="${r}" cx="100" cy="100" fill="none" stroke="${CATEGORIES[t.key]?.color ?? '#8D93A6'}" stroke-width="18"
      stroke-linecap="round" stroke-dasharray="${Math.max(part - gap, 0.5)} ${length}" stroke-dashoffset="${-(start + gap / 2)}"
      transform="rotate(-90 100 100)"/>`;
    start += part;
    return arc;
  }).join('');
  return `<svg viewBox="0 0 200 200" aria-hidden="true">
    <circle r="${r}" cx="100" cy="100" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="18"/>${arcs}</svg>`;
}

function renderStats() {
  const totals = categoryTotals(), sum = totals.reduce((s, t) => s + t.cents, 0);
  const count = totals.reduce((s, t) => s + t.count, 0);
  const segment = (value, text) => `<button class="${state.basis === value ? 'on' : ''}" data-action="basis" data-value="${value}">${text}</button>`;
  app.innerHTML = `
    ${topBar('共用分類')}
    ${monthSwitcher()}
    <div class="segment">${segment('total', '總額')}${segment('mine', '我的份')}</div>
    ${totals.length === 0 ? '<p class="empty">這個月沒有共用支出</p>' : `
      <div class="donut">
        ${donut(totals, sum)}
        <div class="center"><div class="value num">${money(sum)}</div>
          <div class="label">${state.basis === 'total' ? `共用 ${count} 筆` : '我的份'}</div></div>
      </div>
      <div class="card rows">
        ${totals.map(t => {
          const c = CATEGORIES[t.key] ?? CATEGORIES.other;
          return `<button class="row" data-action="statsCategory" data-value="${t.key}">
            <span class="icon" style="background:${c.color}14;border:1px solid ${c.color}29;color:${c.color}">${glyph(c.icon)}</span>
            <span class="main"><div class="title">${c.title} <span class="count">${t.count} 筆</span></div></span>
            <span class="pct num">${Math.round((t.cents / sum) * 100)}%</span>
            <span class="total num">${money(t.cents)}</span>
            <span class="chevron">${glyph('chevron-right')}</span>
          </button>`;
        }).join('')}
      </div>`}`;
}

function renderCategory() {
  const c = CATEGORIES[state.statsCategory] ?? CATEGORIES.other;
  const month = Number(state.month.slice(5));
  const rows = state.entries
    .filter(e => e.kind === 'expense' && e.category === state.statsCategory && e.date.startsWith(state.month))
    .sort((a, b) => (state.byAmount ? amountOf(b) - amountOf(a) : a.date < b.date ? 1 : -1));
  const total = rows.reduce((s, e) => s + e.amount_cents, 0), mine = rows.reduce((s, e) => s + share(e, state.me), 0);
  app.innerHTML = `
    ${topBar(`${c.title} · ${month}月`, `<button class="grey-button" data-action="sort">${state.byAmount ? '金額排序' : '日期排序'}</button>`)}
    <div class="day-head"><span class="date num">${rows.length} 筆 · 總額 ${money(total)}</span>
      <span class="spacer"></span><span class="mine num">我的份 ${money(mine)}</span></div>
    <div class="card rows">${rows.map(e => row(e, true)).join('')}</div>`;
}

function go(view) {
  state.view = view;
  history.pushState({ view, statsCategory: state.statsCategory }, '');
  render();
  scrollTo(0, 0);
}

// The phone's back gesture and the browser's back button step back a page
window.addEventListener('popstate', event => {
  state.view = event.state?.view ?? 'list';
  state.statsCategory = event.state?.statsCategory ?? null;
  render();
});

function dayBlock(day, rows) {
  const { word, short } = dayLabel(day);
  const mine = rows.filter(e => e.kind === 'expense').reduce((s, e) => s + share(e, state.me), 0);
  return `
    <div class="day-head">
      <span class="word">${word ?? short}</span>${word ? `<span class="date">· ${short}</span>` : ''}
      <span class="spacer"></span>
      ${mine > 0 ? `<span class="mine num">我的份 ${money(mine)}</span>` : ''}
    </div>
    <div class="card rows">${rows.map(e => row(e)).join('')}</div>`;
}

function row(e, withDate = false) {
  const c = CATEGORIES[e.category] ?? CATEGORIES.other;
  const [, m, d] = e.date.split('-').map(Number);
  const showShare = e.kind === 'expense' && splitOf(e).division !== 'equal';
  return `
    <button class="row" data-action="open" data-id="${e.id}">
      <span class="icon" style="background:${c.color}14;border:1px solid ${c.color}29;color:${c.color}">${glyph(c.icon)}</span>
      <span class="main">
        <div class="title">${escape(e.name || c.title)}</div>
        <div class="detail">${escape((withDate ? `${m}/${d} · ` : '') + detailOf(e))}</div>
      </span>
      <span class="right">
        <div class="total num">${money(e.amount_cents)}</div>
        ${showShare ? `<div class="share num">我的份 ${money(share(e, state.me))}</div>` : ''}
      </span>
    </button>`;
}

// ---------- Entry sheet ----------

let draft = null;

function openEntry(entry) {
  if (entry?.kind === 'income') { toast('收入紀錄請在 App 裡修改'); return; }
  if (entry?.kind === 'settlement') { openSettle(entry); return; }
  draft = entry ? {
    id: entry.id, isNew: false,
    amountText: typed(entry.amount_cents), date: entry.date,
    category: entry.category, name: entry.name, addingSub: false,
    note: entry.note?.startsWith('Bill Bear 匯入') ? '' : entry.note ?? '',
    keepNote: entry.note?.startsWith('Bill Bear 匯入') ? entry.note : null,
    ...splitOf(entry),
  } : {
    id: crypto.randomUUID(), isNew: true,
    amountText: '', date: today(), category: null, name: '', addingSub: false, note: '', keepNote: null,
    payer: 'me', minePaidText: '', division: 'equal', myShareText: '',
  };
  renderEntry();
  if (!entry) sheetRoot.querySelector('#amount')?.focus();
}

function renderEntry() {
  const d = draft;
  const partner = partnerName();
  const option = (group, value, text) => `<button class="chip ${d[group] === value ? 'on' : ''}" data-action="set" data-group="${group}" data-value="${value}">${escape(text)}</button>`;
  const subs = d.category ? subcategories(d.category) : [];
  if (d.name && !subs.some(s => s.name === d.name)) subs.unshift({ name: d.name, cents: null });

  sheetRoot.innerHTML = `
    <div class="backdrop" data-action="close"></div>
    <section class="sheet" role="dialog" aria-label="${d.isNew ? '新增共用支出' : '編輯共用支出'}">
      <div class="sheet-head">
        <button class="text-button" data-action="close">取消</button>
        <h2>${d.isNew ? '新增共用支出' : '編輯共用支出'}</h2>
        ${d.isNew ? '<span style="width:44px"></span>' : '<button class="text-button danger" data-action="delete">刪除</button>'}
      </div>

      <label class="amount-input"><span>TWD</span>
        <input id="amount" inputmode="decimal" placeholder="0" value="${escape(d.amountText)}" data-field="amountText" autocomplete="off">
      </label>

      <div class="field"><span class="name">日期</span><input type="date" value="${d.date}" max="${today()}" data-field="date"></div>

      <div class="field"><span class="name">誰付</span>
        <div class="scroll-chips">${option('payer', 'me', '我付')}${option('payer', 'partner', `${partner} 付`)}${option('payer', 'both', '各付一部分')}</div>
      </div>
      ${d.payer === 'both' ? `<div class="field"><span class="name">我付了</span><input inputmode="decimal" placeholder="NT$" value="${escape(d.minePaidText)}" data-field="minePaidText"></div>` : ''}

      <div class="field"><span class="name">怎麼分</span>
        <div class="scroll-chips">${option('division', 'equal', '平分')}${option('division', 'allMine', '全算我')}${option('division', 'allPartners', `全算 ${partner}`)}${option('division', 'custom', '自訂')}</div>
      </div>
      ${d.division === 'custom' ? `<div class="field"><span class="name">我的份</span><input inputmode="decimal" placeholder="NT$" value="${escape(d.myShareText)}" data-field="myShareText"></div>` : ''}

      <div class="categories">
        ${PICKABLE.map(key => {
          const c = CATEGORIES[key], on = d.category === key;
          return `<button class="category" data-action="category" data-value="${key}" style="background:${on ? c.color : c.color + '14'};color:${on ? '#020204' : c.color}">
            ${glyph(c.icon)}${c.title}</button>`;
        }).join('')}
      </div>

      <div class="field"><span class="name">子分類</span>
        ${!d.category ? '<span class="tertiary">請先選分類</span>'
          : d.addingSub ? `<input type="text" id="newSub" placeholder="輸入子分類" value="${escape(d.name)}" data-field="name">`
          : `<div class="scroll-chips">${subs.map(s => `<button class="chip ${s.name === d.name ? 'on' : ''}" data-action="sub" data-value="${escape(s.name)}" data-cents="${s.cents ?? ''}">${escape(s.name)}</button>`).join('')}
              <button class="chip" data-action="addSub" aria-label="新增子分類">＋</button></div>`}
      </div>

      <div class="field"><span class="name">備註</span><input type="text" placeholder="選填" value="${escape(d.note)}" data-field="note"></div>

      <div class="summary num" id="summary"></div>
      <button class="primary" data-action="save" id="save">儲存</button>
    </section>`;
  updateSummary();
  if (d.addingSub) sheetRoot.querySelector('#newSub')?.focus();
}

function updateSummary() {
  const d = draft, total = cents(d.amountText) ?? 0, a = amounts(total, d);
  const el = sheetRoot.querySelector('#summary'), save = sheetRoot.querySelector('#save');
  if (!el) return;
  const partner = partnerName();
  if (total > 0 && !a) { el.textContent = '填的金額超過總額了'; el.className = 'summary error'; }
  else if (a) {
    const effect = a.minePaid - a.myShare;
    el.textContent = `我的份 ${money(a.myShare)} · ${partner} 的份 ${money(a.partnerShare)}` +
      (effect > 0 ? ` · 這筆讓 ${partner} 欠你 ${money(effect)}` : effect < 0 ? ` · 這筆讓你欠 ${partner} ${money(-effect)}` : '');
    el.className = 'summary num';
  } else { el.textContent = ''; }
  save.disabled = !a || !d.category;
  save.textContent = !d.category && a ? '選擇分類' : '儲存';
}

async function saveEntry() {
  const d = draft, total = cents(d.amountText), a = amounts(total, d);
  if (!a || !d.category) return;
  const note = d.note.trim();
  const row = {
    ...baseRow(d.id), kind: 'expense', category: d.category, name: d.name.trim(), date: d.date,
    amount_cents: total, note: note || d.keepNote || null,
  };
  putAmounts(row, a);
  await commit(row, d.isNew, `已記共用 ${row.name || CATEGORIES[d.category].title} ${money(total)}`);
}

async function commit(row, isNew, message) {
  const save = sheetRoot.querySelector('#save');
  if (save) { save.disabled = true; save.textContent = '儲存中…'; }
  try {
    await saveRow(row, isNew);
    closeSheet();
    render();
    toast(message);
  } catch {
    if (save) { save.disabled = false; save.textContent = '儲存'; }
    toast('連不上共用帳，請確認網路後再試一次');
  }
}

async function deleteEntry(id) {
  if (!confirm('刪除這筆共用支出？兩邊都會看不到這筆，餘額也會跟著變。')) return;
  await commit({ id, deleted_at: new Date().toISOString() }, false, '已刪除');
}

// ---------- Settle sheet ----------

let settle = null;

function openSettle(entry) {
  const b = balance();
  const payer = entry ? (entry.julia_paid_cents > 0 ? 'julia' : 'erik') : (b > 0 ? other(state.me) : state.me);
  settle = {
    id: entry?.id ?? crypto.randomUUID(), isNew: !entry, payer,
    amountText: entry ? typed(entry.amount_cents) : typed(Math.abs(b)),
    date: entry?.date ?? today(), note: entry?.note ?? '',
  };
  const direction = payer === state.me ? `你付給 ${partnerName()}` : `${partnerName()} 付給你`;
  sheetRoot.innerHTML = `
    <div class="backdrop" data-action="close"></div>
    <section class="sheet" role="dialog" aria-label="結清">
      <div class="sheet-head">
        <button class="text-button" data-action="close">取消</button>
        <h2>結清</h2>
        ${settle.isNew ? '<span style="width:44px"></span>' : '<button class="text-button danger" data-action="delete">刪除</button>'}
      </div>
      <p class="secondary" style="margin:8px 4px 0">${escape(direction)}</p>
      <label class="amount-input"><span>NT$</span>
        <input id="settleAmount" inputmode="decimal" value="${escape(settle.amountText)}" data-settle="amountText">
      </label>
      <div class="field"><span class="name">日期</span><input type="date" value="${settle.date}" max="${today()}" data-settle="date"></div>
      <div class="field"><span class="name">備註</span><input type="text" placeholder="例如：轉帳、現金" value="${escape(settle.note)}" data-settle="note"></div>
      <div class="summary num" id="settleSummary"></div>
      <p class="summary">確認錢真的轉過去之後再記。</p>
      <button class="primary" data-action="saveSettle" id="save">記錄</button>
    </section>`;
  updateSettleSummary();
}

function updateSettleSummary() {
  const owed = Math.abs(balance()), amount = cents(settle.amountText) ?? 0;
  const el = sheetRoot.querySelector('#settleSummary'), save = sheetRoot.querySelector('#save');
  const partner = partnerName();
  if (!settle.isNew) { el.textContent = ''; save.disabled = !(amount > 0); return; }
  const left = owed - amount;
  el.className = 'summary num' + (amount > owed ? ' error' : '');
  el.textContent = amount > owed ? `超過目前的 NT$${money(owed)}`
    : amount === owed ? '記錄後兩清'
    : amount > 0 ? (balance() > 0 ? `記錄後 ${partner} 還欠你 NT$${money(left)}` : `記錄後你還欠 ${partner} NT$${money(left)}`) : '';
  save.disabled = !(amount > 0) || amount > owed;
}

async function saveSettle() {
  const amount = cents(settle.amountText);
  if (!(amount > 0)) return;
  const row = { ...baseRow(settle.id), kind: 'settlement', category: 'transfer', name: '結清', date: settle.date,
    amount_cents: amount, note: settle.note.trim() || null };
  row[`${settle.payer}_paid_cents`] = amount;
  row[`${other(settle.payer)}_share_cents`] = amount;
  await commit(row, settle.isNew, `已記錄結清 ${money(amount)}`);
}

function closeSheet() {
  sheetRoot.innerHTML = '';
  draft = null;
  settle = null;
}

// ---------- Events ----------

let toastTimer;
function toast(text) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 1800);
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target) { if (state.menuOpen) { state.menuOpen = false; render(); } return; }
  const action = target.dataset.action;
  if (action !== 'menu' && state.menuOpen) { state.menuOpen = false; render(); }
  switch (action) {
    case 'google':
      await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
      break;
    case 'signOut':
      if (!sample) await db.auth.signOut();
      state.status = 'signedOut'; state.entries = []; render();
      break;
    case 'refresh': await refresh(); break;
    case 'menu': state.menuOpen = !state.menuOpen; render(); break;
    case 'prevMonth': state.month = shiftMonth(state.month, -1); render(); break;
    case 'nextMonth': state.month = shiftMonth(state.month, 1); render(); break;
    case 'add': openEntry(null); break;
    case 'stats': state.basis = 'total'; go('stats'); break;
    case 'basis': state.basis = target.dataset.value; render(); break;
    case 'statsCategory': state.statsCategory = target.dataset.value; go('category'); break;
    case 'sort': state.byAmount = !state.byAmount; render(); break;
    case 'back': history.back(); break;
    case 'open': openEntry(state.entries.find(e => e.id === target.dataset.id)); break;
    case 'settle': openSettle(null); break;
    case 'close': closeSheet(); break;
    case 'set': draft[target.dataset.group] = target.dataset.value; renderEntry(); break;
    case 'category':
      if (draft.category !== target.dataset.value) { draft.name = ''; draft.addingSub = false; }
      draft.category = target.dataset.value; renderEntry(); break;
    case 'sub': {
      const name = target.dataset.value, picked = draft.name === name;
      draft.name = picked ? '' : name;
      // Last time's amount, unless one is typed already
      if (!picked && target.dataset.cents && !draft.amountText) draft.amountText = typed(Number(target.dataset.cents));
      renderEntry(); break;
    }
    case 'addSub': draft.name = ''; draft.addingSub = true; renderEntry(); break;
    case 'save': await saveEntry(); break;
    case 'delete': await deleteEntry(draft?.id ?? settle?.id); break;
    case 'saveSettle': await saveSettle(); break;
  }
});

document.addEventListener('input', event => {
  const field = event.target.dataset.field, settleField = event.target.dataset.settle;
  if (field && draft) { draft[field] = event.target.value; updateSummary(); }
  if (settleField && settle) { settle[settleField] = event.target.value; updateSettleSummary(); }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.id === 'newSub') { draft.addingSub = false; renderEntry(); }
  if (event.key === 'Escape' && sheetRoot.innerHTML) closeSheet();
});

// Coming back to the page picks up what Julia added meanwhile
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.status === 'ready' && !sheetRoot.innerHTML) refresh();
});

// ---------- Start ----------

async function start(session) {
  if (!session) { state.status = 'signedOut'; render(); return; }
  state.email = session.user?.email ?? null;
  const { data: me } = await db.rpc('shared_current_member');
  if (!me) { state.status = 'notMember'; render(); return; }
  state.me = me;
  const { data: members } = await db.from('shared_members').select('code, display_name');
  for (const m of members ?? []) state.names[m.code] = m.display_name;
  state.status = 'ready';
  await refresh();
}

function sampleEntries() {
  const day = offset => {
    const d = new Date(today() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  };
  const e = (name, category, offset, total, juliaPaid = true, juliaShare = Math.floor(total / 2)) => ({
    id: crypto.randomUUID(), kind: 'expense', name, category, date: day(offset), amount_cents: total, note: null,
    julia_paid_cents: juliaPaid ? total : 0, erik_paid_cents: juliaPaid ? 0 : total,
    julia_share_cents: juliaShare, erik_share_cents: total - juliaShare, created_at: new Date().toISOString(),
  });
  return [
    e('晚餐', 'dining', 0, 143400), e('PX', 'grocery', 1, 54500), e('咖啡', 'dining', 3, 54000, false),
    e('飲料', 'dining', 3, 11500), e('網路', 'bill', 5, 79900), e('家用品', 'grocery', 6, 137000),
    e('Taxi', 'transport', 9, 42500, false, 42500), e('電影', 'entertainment', 12, 61000),
  ];
}

if (sample) {
  state.me = 'erik';
  state.email = 'erik@example.com';
  state.entries = sampleEntries();
  state.status = 'ready';
  render();
} else {
  render();
  const { data } = await db.auth.getSession();
  await start(data.session);
  db.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && state.status !== 'ready') start(session);
    if (event === 'SIGNED_OUT') { state.status = 'signedOut'; render(); }
  });
}

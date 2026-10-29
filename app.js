// 共用支出, the web version for Erik. Reads and writes the same Supabase
// tables as Julia's iOS app (Ledger/SharedLedger in ledger-ios); the rules
// for splitting and balances are the same as SharedModels.swift there.
// Only the publishable key is here; what a login may see is decided by the
// database's row rules. Open with ?sample to try it with made-up records.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const SUPABASE_URL = 'https://ojxlckjjncukyoafvwgv.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_ptXYLFx_DGtLseHgZKum3w_sk0-2YoW';
// The household ledger (共同生活費); trips sit beside it, each settled on its own
const HOUSEHOLD = '5a1f0c3e-0000-4000-8000-000000000001';
const HOUSEHOLD_FALLBACK = { id: HOUSEHOLD, name: '共同生活費', purpose: 'household', currency: 'TWD', cash_rate: null, card_rate: null, archived_at: null };
// How a trip expense was paid (SharedPayment in the app): cash is at the
// trip's cash rate and final; card and Suica are guesses until the bill
const PAYMENTS = { card: { title: '刷卡', icon: 'credit-card' }, cash: { title: '現金', icon: 'banknote' }, suica: { title: 'Suica', icon: 'nfc' } };
const TRIP_CURRENCIES = ['JPY', 'KRW', 'USD', 'EUR', 'THB', 'HKD'];
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
  entries: [], // not deleted, the ledger on screen, newest first
  allEntries: [], // not deleted, every ledger
  ledgers: [HOUSEHOLD_FALLBACK], // household first, then trips oldest first
  ledgerId: stored('sharedLedger') ?? HOUSEHOLD, // the one on screen and new records go to
  whole: null, // the two totals: true 全程／全部, false 本月, null the ledger's default
  market: {}, // NT$ for one unit of each currency, today's market rate
  month: monthKey(today()),
  offline: false,
  menuOpen: false,
  view: 'list', // list | stats | category
  basis: 'total', // 統計 counts the whole amount or my share
  statsCategory: null,
  byAmount: false,
  flashId: null, // the record just saved, which glows once in the list
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

// ¥2,400; NT$ amounts are written without a sign, as everywhere else here
function fmt(c, code) {
  const sign = { TWD: '', JPY: '¥', KRW: '₩', USD: 'US$', EUR: '€' }[code] ?? `${code} `;
  return sign + money(c);
}
const currencySign = code => ({ TWD: 'NT$', JPY: '¥', KRW: '₩', USD: 'US$', EUR: '€' }[code] ?? code);

function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function store(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

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

// A trip record in its own currency keeps its amount and division there;
// amount_cents and the four splits are always NT$ (SharedEntry in the app)
const isForeign = e => (e.currency ?? 'TWD') !== 'TWD';
const recordedAmount = e => (isForeign(e) ? e.orig_amount_cents ?? e.amount_cents : e.amount_cents);
const recordedPaid = (e, m) => (isForeign(e) ? e[`orig_${m}_paid_cents`] ?? paid(e, m) : paid(e, m));
const recordedShare = (e, m) => (isForeign(e) ? e[`orig_${m}_share_cents`] ?? share(e, m) : share(e, m));

const ledgerOf = id => state.ledgers.find(l => l.id === id) ?? HOUSEHOLD_FALLBACK;
const currentLedger = () => ledgerOf(state.ledgerId);
const isTrip = l => l.purpose === 'trip';
const activeLedgers = () => state.ledgers.filter(l => !l.archived_at);
const ledgerEntries = id => state.allEntries.filter(e => (e.ledger_id ?? HOUSEHOLD) === id);

// Positive: the other one owes me, in one ledger (the one on screen by default)
function balance(id = state.ledgerId) {
  return ledgerEntries(id).reduce((sum, e) => sum + paid(e, state.me) - share(e, state.me), 0);
}
const estimatedCount = (id = state.ledgerId) => ledgerEntries(id).filter(e => e.twd_estimated).length;

// NT$ for an amount in the trip's currency, to the whole dollar as card bills charge
const twdFromForeign = (c, rate) => Math.round((c / 100) * rate) * 100;

// The rate a record paid this way starts from: cash at what Julia changed it
// at; card and Suica at the trip's own guide, else today's market rate
// (plain, no fee: the bill lists the fee on its own line), else cash's
function rateFor(ledger, payment) {
  if (payment === 'cash') return num(ledger.cash_rate);
  return num(ledger.card_rate) ?? state.market[ledger.currency] ?? num(ledger.cash_rate);
}
const num = v => (v == null || v === '' ? null : Number(v));

// The NT$ total divided as the trip-currency amounts were; whoever paid more
// takes the odd cents of both paid and owed (SharedFX.scale in the app)
function scale(a, twd) {
  const total = a.minePaid + a.partnerPaid;
  const part = c => Math.trunc((c * twd) / total);
  const iPaidMore = a.minePaid * 2 >= total;
  const minePaid = iPaidMore ? twd - part(a.partnerPaid) : part(a.minePaid);
  const partnerShare = iPaidMore ? part(a.partnerShare) : twd - part(a.myShare);
  return { minePaid, partnerPaid: twd - minePaid, myShare: twd - partnerShare, partnerShare };
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

// In the currency it was recorded in
function splitOf(e) {
  const total = recordedAmount(e), minePaid = recordedPaid(e, state.me), myShare = recordedShare(e, state.me);
  const payer = minePaid === total ? 'me' : minePaid === 0 ? 'partner' : 'both';
  const base = { payer, minePaidText: payer === 'both' ? typed(minePaid) : '' };
  const equal = amounts(total, { ...base, division: 'equal' })?.myShare;
  const division = myShare === equal ? 'equal' : myShare === total ? 'allMine' : myShare === 0 ? 'allPartners' : 'custom';
  return { ...base, division, myShareText: division === 'custom' ? typed(myShare) : '' };
}

// Who paid as muted text (warm for me, cool for the partner), and a mark
// only when it isn't half each; words on every row were too busy
function marksOf(e) {
  if (e.kind !== 'expense') return `<span>${escape(detailOf(e))}</span>`;
  const s = splitOf(e);
  const who = m => `<span class="payer ${m === state.me ? 'mine' : 'theirs'}">${escape(nameOf(m))}</span>`;
  const payers = s.payer === 'me' ? who(state.me) : s.payer === 'partner' ? who(other(state.me)) : who(state.me) + who(other(state.me));
  return payers + (s.division !== 'equal' ? `<span class="uneven">${glyph('sliders-horizontal')}</span>` : '');
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

// 子分類 for a category: names used under it before in that ledger, most used
// first, each with its latest amount when that was in the currency being
// typed (never NT$ offered as yen), then the usual ones
function subcategories(category, ledgerId, code) {
  const counts = new Map(), latest = new Map();
  for (const e of ledgerEntries(ledgerId)) {
    if (e.kind !== 'expense' || e.category !== category || !e.name) continue;
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    if (!latest.has(e.name)) latest.set(e.name, e);
  }
  const used = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || (latest.get(b).date > latest.get(a).date ? 1 : -1));
  const unused = (CATEGORIES[category]?.subs ?? []).filter(n => !counts.has(n));
  const amountOf = n => { const e = latest.get(n); return (e.currency ?? 'TWD') === code ? recordedAmount(e) : null; };
  return [...used.map(n => ({ name: n, cents: amountOf(n) })), ...unused.map(n => ({ name: n, cents: null }))];
}

// ---------- Data ----------

// Every ledger and every record not deleted; the ledger on screen is picked out of them
async function loadEntries() {
  if (sample) { pickLedger(); return; }
  const { data: ledgers, error: ledgerError } = await db.from('shared_ledgers').select('*').order('created_at');
  if (ledgerError) throw ledgerError;
  setLedgers(ledgers);
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('shared_entries').select('*')
      .is('deleted_at', null)
      .order('date', { ascending: false }).order('created_at', { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    all.push(...data);
    if (data.length < 1000) break;
  }
  state.allEntries = all;
  pickLedger();
}

function setLedgers(list) {
  const household = list.find(l => l.purpose === 'household') ?? HOUSEHOLD_FALLBACK;
  state.ledgers = [household, ...list.filter(isTrip)];
}

function pickLedger() {
  if (!state.ledgers.some(l => l.id === state.ledgerId)) state.ledgerId = HOUSEHOLD;
  state.entries = ledgerEntries(state.ledgerId)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.created_at ?? '') < (a.created_at ?? '') ? -1 : 1));
}

function selectLedger(id) {
  state.ledgerId = id;
  state.whole = null; // each ledger starts at its own default again
  store('sharedLedger', id);
  pickLedger();
}

// Today's market rates (the same free feed as the app); nothing about the user is sent
async function loadMarket() {
  if (sample) { state.market = { JPY: 0.2052, KRW: 0.0228, USD: 32.1, EUR: 34.9, THB: 0.95, HKD: 4.12 }; return; }
  try {
    const reply = await fetch('https://open.er-api.com/v6/latest/TWD').then(r => r.json());
    if (reply.result !== 'success') return;
    for (const [code, perTWD] of Object.entries(reply.rates)) if (perTWD > 0) state.market[code] = 1 / perTWD;
  } catch { /* offline: card guesses fall back to the trip's rates */ }
}
const marketText = code => (state.market[code] ? state.market[code].toFixed(4) : null);

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
    const index = state.allEntries.findIndex(e => e.id === row.id);
    if (row.deleted_at) state.allEntries.splice(index, 1);
    else if (index >= 0) state.allEntries[index] = { ...state.allEntries[index], ...row };
    else state.allEntries.unshift({ ...row, created_by: state.me, created_at: new Date().toISOString() });
    pickLedger();
    return;
  }
  const query = isNew ? db.from('shared_entries').insert(row) : db.from('shared_entries').update(row).eq('id', row.id);
  const { data, error } = await query.select();
  if (error || !data?.length) throw error ?? new Error('not saved');
  await loadEntries();
}

// Adds a trip, or changes one (name, rates, archiving)
async function saveLedger(ledger, isNew) {
  if (sample) {
    state.ledgers = [...state.ledgers.filter(l => l.id !== ledger.id), ledger];
    setLedgers(state.ledgers);
    return;
  }
  const query = isNew ? db.from('shared_ledgers').insert(ledger) : db.from('shared_ledgers').update(ledger).eq('id', ledger.id);
  const { data, error } = await query.select();
  if (error || !data?.length) throw error ?? new Error('not saved');
  await loadEntries();
}

function baseRow(id, ledgerId = state.ledgerId) {
  return {
    id, ledger_id: ledgerId, deleted_at: null, currency: 'TWD', payment_method: null, twd_estimated: false,
    orig_amount_cents: null, orig_julia_paid_cents: null, orig_erik_paid_cents: null,
    orig_julia_share_cents: null, orig_erik_share_cents: null,
    julia_paid_cents: 0, erik_paid_cents: 0, julia_share_cents: 0, erik_share_cents: 0,
  };
}

function putAmounts(row, a, prefix = '') {
  const mine = state.me, theirs = other(state.me);
  row[`${prefix}${mine}_paid_cents`] = a.minePaid;
  row[`${prefix}${theirs}_paid_cents`] = a.partnerPaid;
  row[`${prefix}${mine}_share_cents`] = a.myShare;
  row[`${prefix}${theirs}_share_cents`] = a.partnerShare;
}

// ---------- Screens ----------

const app = document.getElementById('app');
const sheetRoot = document.getElementById('sheet-root');

// ---------- Motion ----------

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const wait = ms => new Promise(resolve => setTimeout(resolve, reduceMotion.matches ? 0 : ms));

// Page and month changes slide like the app's; the kind picks the CSS in
// style.css (push, pop, month-next, month-prev). Without View Transitions
// (older iOS) the page just changes.
function animate(kind, update) {
  if (reduceMotion.matches || !document.startViewTransition) { update(); return; }
  document.documentElement.dataset.motion = kind;
  const t = document.startViewTransition(update);
  t.finished.finally(() => { delete document.documentElement.dataset.motion; });
}

// Opened from the home screen it is a full-screen app; in Safari it's a page
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function remembered(key) { try { return localStorage.getItem(key) === '1'; } catch { return false; } }
function remember(key) { try { localStorage.setItem(key, '1'); } catch { /* private mode */ } }

function installHint() {
  if (standalone || !iOS || remembered('hideInstallHint')) return '';
  return `
    <div class="card install">
      <span class="icon">${glyph('square-plus')}</span>
      <div class="main">
        <div class="title">加到主畫面，用起來就像 App</div>
        <div class="detail">點 Safari 的 ${glyph('share')} 分享 → 加入主畫面，之後從主畫面的圖示打開。</div>
      </div>
      <button class="text-button" data-action="hideHint" aria-label="不再顯示">${glyph('circle-x')}</button>
    </div>`;
}

// The balance counts to its new figure instead of jumping
let shownBalance = null;
function tweenBalance(b) {
  const el = app.querySelector('.balance .amount');
  const from = shownBalance;
  shownBalance = b;
  if (!el || from === null || from === b || reduceMotion.matches) return;
  const start = performance.now();
  const step = now => {
    const t = Math.min((now - start) / 550, 1), eased = 1 - Math.pow(1 - t, 3);
    el.textContent = `NT$ ${money(Math.abs(Math.round(from + (b - from) * eased)))}`;
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// The header gets its frosted background once the page scrolls under it
addEventListener('scroll', () => {
  document.body.classList.toggle('scrolled', scrollY > 4);
}, { passive: true });

// iOS only shows :active press states when the page listens for touches
document.addEventListener('touchstart', () => {}, { passive: true });

function render() {
  if (state.status === 'loading') { app.innerHTML = '<p class="empty">載入中…</p>'; return; }
  if (state.status === 'signedOut') {
    app.innerHTML = `
      <section class="login">
        <img class="app-icon" src="icon-192.png" alt="">
        <h1>共用支出</h1>
        <p>用綁定共用帳的 Google 帳號登入。<br>登入一次之後會記住。</p>
        ${!standalone && iOS ? '<p class="tertiary">先加到主畫面再登入：主畫面的 App 跟 Safari 分開記登入。</p>' : ''}
        <button class="primary" data-action="google">用 Google 登入</button>
        ${installHint()}
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
  const ledger = currentLedger(), trip = isTrip(ledger);
  const monthEntries = state.entries.filter(e => e.date.startsWith(key));
  const whole = wholeTotals();
  const spending = (whole ? state.entries : monthEntries).filter(e => e.kind === 'expense');
  const [mineTitle, totalTitle] = whole ? (trip ? ['全程我的份', '全程共用'] : ['全部我的份', '全部共用']) : ['本月我的份', '本月共用'];
  const archived = !!ledger.archived_at;

  const days = new Map();
  for (const e of monthEntries) { if (!days.has(e.date)) days.set(e.date, []); days.get(e.date).push(e); }

  app.innerHTML = `
    <header class="header sticky">
      <div>
        <div class="year">${year}</div>
        <div class="month">${month}月</div>
      </div>
      <div class="spacer"></div>
      <div class="pill">
        <button data-action="prevMonth" aria-label="上個月">${glyph('chevron-left')}</button>
        <span class="sep"></span>
        <button data-action="nextMonth" aria-label="下個月" ${isCurrent ? 'disabled' : ''}>${glyph('chevron-right')}</button>
      </div>
      <button class="round" data-action="menu" aria-label="帳號" aria-expanded="${state.menuOpen}">${glyph('circle-user')}</button>
    </header>

    <div class="ledger-row">
      <button class="ledger-name" data-action="ledgers" aria-label="帳本 ${escape(ledger.name)}，點一下切換">
        ${glyph(trip ? 'plane' : 'house')}<span>${escape(ledger.name)}</span>${archived ? '<span class="archived">已封存</span>' : ''}${glyph('chevron-down')}
      </button>
      <span class="spacer"></span>
      <button class="scope" data-action="scope" aria-label="${whole ? (trip ? '全程' : '全部') : '本月'}，點一下切換">
        ${whole ? (trip ? '全程' : '全部') : '本月'}${glyph('chevrons-up-down')}
      </button>
    </div>

    <div class="month-body">
      <section class="tiles">
        <div class="card tile"><div class="label">${mineTitle}</div><div class="value num">${money(spending.reduce((s, e) => s + share(e, state.me), 0))}</div></div>
        <div class="card tile"><div class="label">${totalTitle}</div><div class="value num">${money(spending.reduce((s, e) => s + e.amount_cents, 0))}</div></div>
        ${balanceTile()}
        <button class="card tile link" data-action="stats" aria-label="共用分類">${glyph('chart-pie')}<span>分類</span></button>
      </section>

      ${installHint()}
      ${state.offline ? '<p class="notice">沒有連上網路，顯示的是上次的資料</p>' : ''}
      ${days.size === 0 ? '<p class="empty">這個月還沒有共用支出</p>' : ''}
      ${[...days.entries()].map(([day, rows]) => dayBlock(day, rows)).join('')}
    </div>

    <button class="fab ${archived ? 'blocked' : ''}" data-action="add" aria-label="${archived ? '已封存的帳本不能新增' : '新增共用支出'}">${glyph('plus')}</button>
    ${state.menuOpen ? `
      <div class="menu" role="menu">
        <div class="who">${escape(state.email ?? '')}</div>
        <button data-action="refresh">重新整理</button>
        <button class="danger" data-action="signOut">登出</button>
      </div>` : ''}
`;
  state.flashId = null;
}

// 本月 or the whole ledger; a trip starts whole, the household by month
const wholeTotals = () => state.whole ?? isTrip(currentLedger());

// Who owes whom over the whole ledger, the same size as the totals and
// never red (a big red figure felt like pressure); the whole tile opens 結清
function balanceTile() {
  const b = balance(), partner = partnerName(), estimated = estimatedCount();
  const label = b > 0 ? `目前 ${partner} 欠你` : b < 0 ? `目前你欠 ${partner}` : '目前兩清';
  return `<button class="card tile balance-tile" data-action="settle" ${b === 0 ? 'disabled' : ''} aria-label="${escape(label)}${b ? '，點一下結清' : ''}">
    <div class="label">${escape(label)}</div>
    <div class="value-line"><span class="value num">${b === 0 ? '—' : (estimated ? '約 ' : '') + money(Math.abs(b))}</span>
      ${b !== 0 ? '<span class="settle-hint">結清 ›</span>' : ''}</div>
  </button>`;
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
        <button data-action="prevMonth" aria-label="上個月">${glyph('chevron-left')}</button>
        <span class="sep"></span>
        <button data-action="nextMonth" aria-label="下個月" ${isCurrent ? 'disabled' : ''}>${glyph('chevron-right')}</button>
      </div>
    </div>`;
}

function topBar(title, trailing = '<span style="width:44px"></span>') {
  return `
    <div class="topbar sticky">
      <button class="round" data-action="back" aria-label="返回">${glyph('chevron-left')}</button>
      <h1>${escape(title)}</h1>
      ${trailing}
    </div>`;
}

const amountOf = e => (state.basis === 'total' ? e.amount_cents : share(e, state.me));

// The month, or the whole ledger when the totals are 全程／全部
const inScope = e => wholeTotals() || e.date.startsWith(state.month);

function categoryTotals() {
  const totals = new Map();
  for (const e of state.entries) {
    if (e.kind !== 'expense' || !inScope(e)) continue;
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
  // Each arc draws in after the one before it
  const arcs = totals.map((t, i) => {
    const part = (t.cents / sum) * length;
    const arc = `<circle r="${r}" cx="100" cy="100" fill="none" stroke="${CATEGORIES[t.key]?.color ?? '#8D93A6'}" stroke-width="18"
      stroke-linecap="round" stroke-dasharray="${Math.max(part - gap, 0.5)} ${length}" stroke-dashoffset="${-(start + gap / 2)}"
      transform="rotate(-90 100 100)" style="animation-delay:${i * 60}ms"/>`;
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
    ${wholeTotals() ? wholeHeader() : monthSwitcher()}
    <div class="segment" data-on="${state.basis}">${segment('total', '總額')}${segment('mine', '我的份')}</div>
    <div class="month-body">
    ${totals.length === 0 ? `<p class="empty">${wholeTotals() ? '還沒有共用支出' : '這個月沒有共用支出'}</p>` : `
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
      </div>`}
    </div>`;
}

// In place of the month when 共用分類 counts the whole ledger: the days it covers
function wholeHeader() {
  const days = state.entries.map(e => e.date).sort();
  const short = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  const range = days.length ? (days[0] === days.at(-1) ? short(days[0]) : `${short(days[0])} – ${short(days.at(-1))}`) : currentLedger().name;
  return `<div class="header"><div><div class="year">${days.length ? days[0].slice(0, 4) + ' · ' : ''}${isTrip(currentLedger()) ? '全程' : '全部'}</div>
    <div class="month">${escape(range)}</div></div></div>`;
}

function renderCategory() {
  const c = CATEGORIES[state.statsCategory] ?? CATEGORIES.other;
  const month = Number(state.month.slice(5));
  const rows = state.entries
    .filter(e => e.kind === 'expense' && e.category === state.statsCategory && inScope(e))
    .sort((a, b) => (state.byAmount ? amountOf(b) - amountOf(a) : a.date < b.date ? 1 : -1));
  const total = rows.reduce((s, e) => s + e.amount_cents, 0), mine = rows.reduce((s, e) => s + share(e, state.me), 0);
  app.innerHTML = `
    ${topBar(wholeTotals() ? `${c.title} · ${currentLedger().name}` : `${c.title} · ${month}月`, `<button class="grey-button" data-action="sort">${state.byAmount ? '金額排序' : '日期排序'}</button>`)}
    <div class="day-head"><span class="date num">${rows.length} 筆 · 總額 ${money(total)}</span>
      <span class="spacer"></span><span class="mine num">我的份 ${money(mine)}</span></div>
    <div class="card rows">${rows.map(e => row(e, true)).join('')}</div>`;
}

// Pages push in from the right and go back to the right, like the app's
// navigation. Where each page was scrolled to is kept for coming back.
const scrollOf = {};
function go(view) {
  scrollOf[state.view] = scrollY;
  animate('push', () => {
    state.view = view;
    history.pushState({ view, statsCategory: state.statsCategory }, '');
    render();
    scrollTo(0, 0);
  });
}

// The ‹ button and the browser's back button step back a page. Safari's own
// swipe-back already slides, so only ‹ (and the edge swipe below) animate.
let backByButton = false;
window.addEventListener('popstate', event => {
  const update = () => {
    state.view = event.state?.view ?? 'list';
    state.statsCategory = event.state?.statsCategory ?? null;
    render();
    scrollTo(0, scrollOf[state.view] ?? 0);
  };
  if (backByButton) animate('pop', update); else update();
  backByButton = false;
});

// From the home screen there is no browser to swipe back with, so the left
// edge does it: the page follows the finger and goes back past a third
let edge = null;
document.addEventListener('touchstart', event => {
  const touch = event.touches[0];
  if (!standalone || state.view === 'list' || draft || settle || touch.clientX > 24) return;
  edge = { x: touch.clientX, y: touch.clientY, dx: 0, t: performance.now(), on: false };
}, { passive: true });
document.addEventListener('touchmove', event => {
  if (!edge) return;
  const touch = event.touches[0];
  edge.dx = Math.max(0, touch.clientX - edge.x);
  if (!edge.on && Math.abs(touch.clientY - edge.y) > edge.dx) { edge = null; return; }
  edge.on = edge.dx > 6;
  if (edge.on) app.style.transform = `translateX(${edge.dx}px)`;
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!edge?.on) { edge = null; return; }
  const fast = edge.dx / (performance.now() - edge.t) > 0.5;
  const back = edge.dx > innerWidth / 3 || fast;
  edge = null;
  app.style.transition = 'transform 0.3s var(--ease)';
  app.style.transform = back ? 'translateX(100%)' : '';
  setTimeout(() => {
    app.style.transition = '';
    if (back) { history.back(); requestAnimationFrame(() => { app.style.transform = ''; }); }
  }, reduceMotion.matches ? 0 : 300);
});

function dayBlock(day, rows) {
  const { word, short } = dayLabel(day);
  return `
    <div class="day-head">
      <span class="word">${word ?? short}</span>${word ? `<span class="date">· ${short}</span>` : ''}
    </div>
    <div class="card rows">${rows.map(e => row(e)).join('')}</div>`;
}

// A record; swipe it left for 刪除, like the app's list
function row(e, withDate = false) {
  const c = CATEGORIES[e.category] ?? CATEGORIES.other;
  const [, m, d] = e.date.split('-').map(Number);
  const showShare = !isForeign(e) && e.kind === 'expense' && splitOf(e).division !== 'equal';
  const deletable = e.kind !== 'income';
  const pay = PAYMENTS[e.payment_method];
  return `
    <div class="swipe ${state.flashId === e.id ? 'flash' : ''}" ${deletable ? `data-swipe="${e.id}"` : ''}>
    ${deletable ? `<button class="swipe-delete" data-action="swipeDelete" data-id="${e.id}" tabindex="-1">${glyph('trash-2')}<span>刪除</span></button>` : ''}
    <button class="row" data-action="open" data-id="${e.id}">
      <span class="icon" style="background:${c.color}14;border:1px solid ${c.color}29;color:${c.color}">${glyph(c.icon)}</span>
      <span class="main">
        <div class="title">${escape(e.name || c.title)}</div>
        <div class="detail" aria-label="${escape(detailOf(e))}">${withDate ? `<span>${m}/${d}</span>` : ''}${marksOf(e)}</div>
      </span>
      <span class="right">
        <div class="total num ${e.twd_estimated ? 'estimated' : ''}">${e.twd_estimated ? '≈ ' : ''}${money(e.amount_cents)}</div>
        ${isForeign(e) ? `<div class="share num">${fmt(recordedAmount(e), e.currency)}${pay ? ` <span class="pay" aria-label="${pay.title}">${glyph(pay.icon)}</span>` : ''}</div>` : ''}
        ${showShare ? `<div class="share num">我的份 ${money(share(e, state.me))}</div>` : ''}
      </span>
    </button>
    </div>`;
}

// ---------- Keypad ----------

// The entry screen's calculator, like Calculator in the app: what was typed
// as numbers and operators, worked out on = or 儲存. A suggested amount
// (last time's) shows highlighted and the next digit replaces it.
const OPS = { '+': (a, b) => a + b, '−': (a, b) => a - b, '×': (a, b) => a * b, '÷': (a, b) => a / b };
const calcOf = (text = '', preselected = false) => ({ numbers: [text], ops: [], preselected });
const calcEmpty = c => c.numbers.length === 1 && c.numbers[0] === '';

function calcKey(c, key) {
  const last = c.numbers.length - 1, current = c.numbers[last];
  if (key in OPS) {
    c.preselected = false;
    if (current === '' && c.ops.length) c.ops[c.ops.length - 1] = key;
    else if (current !== '') { c.ops.push(key); c.numbers.push(''); }
  } else if (key === 'back') {
    c.preselected = false;
    if (current) c.numbers[last] = current.slice(0, -1);
    else if (c.ops.length) { c.ops.pop(); c.numbers.pop(); }
  } else if (key === 'clear') {
    Object.assign(c, calcOf());
  } else if (key === '=') {
    const value = calcValue(c);
    if (value != null && value >= 0) Object.assign(c, calcOf(typed(value)));
  } else {
    if (c.preselected) Object.assign(c, calcOf());
    for (const d of key === '00' ? ['0', '0'] : [key]) {
      let n = c.numbers[c.numbers.length - 1];
      if (d === '.') { if (n.includes('.')) continue; n = (n || '0') + '.'; }
      else if (/\.\d\d$/.test(n) || n.replace('.', '').length >= 9) continue;
      else n = n === '0' ? d : n + d;
      c.numbers[c.numbers.length - 1] = n;
    }
  }
}

// In cents, × and ÷ before + and −; a trailing operator is left out
function calcValue(c) {
  const values = c.numbers.map(n => (n === '' || n === '.' ? null : parseFloat(n)));
  const ops = [...c.ops];
  if (values.length > 1 && values[values.length - 1] == null) { values.pop(); ops.pop(); }
  if (values.some(v => v == null)) return null;
  const terms = [values[0]], joins = [];
  ops.forEach((op, i) => {
    if (op === '×' || op === '÷') terms.push(OPS[op](terms.pop(), values[i + 1]));
    else { joins.push(op); terms.push(values[i + 1]); }
  });
  const result = joins.reduce((sum, op, i) => OPS[op](sum, terms[i + 1]), terms[0]);
  return Number.isFinite(result) ? Math.round(result * 100) : null;
}

const grouped = n => {
  const [whole, fraction] = n.split('.');
  return Number(whole || 0).toLocaleString('en-US') + (fraction !== undefined ? '.' + fraction : '');
};

// The big number: what is being typed, or the running total right after an operator
function calcHeadline(c) {
  const current = c.numbers[c.numbers.length - 1];
  if (current === '' && c.ops.length) { const v = calcValue(c); return v == null ? '0' : money(v); }
  return current === '' ? '0' : grouped(current);
}

const calcExpression = c => (c.ops.length
  ? c.numbers.map((n, i) => (n === '' ? '' : grouped(n)) + (c.ops[i] ? ` ${c.ops[i]} ` : '')).join('')
  : '');

const KEYS = [
  ['÷', '×', '−', '+'],
  ['7', '8', '9', 'back'],
  ['4', '5', '6', 'clear'],
  ['1', '2', '3', '='],
  ['.', '0', '00'],
];
const KEY_LOOK = { back: ['delete', '刪除'], clear: ['circle-x', '清除'], '÷': ['divide', '÷'], '×': ['x', '×'], '−': ['minus', '−'], '+': ['plus', '+'], '=': ['equal', '計算'] };

function keypad() {
  const next = missing();
  return `
    <div class="keypad">
      ${KEYS.flat().map(key => {
        const op = key in OPS || key in KEY_LOOK || key === '=';
        const [icon, label] = KEY_LOOK[key] ?? [];
        return `<button class="key ${op ? 'op' : ''} ${key === '0' ? 'wide' : ''}" data-action="key" data-value="${key}"
          aria-label="${label ?? (key === '.' ? '小數點' : key)}">${icon ? glyph(icon) : key}</button>`;
      }).join('')}
    </div>
    <button class="primary" data-action="keyAction" id="keyAction" ${draftTotal() > 0 ? '' : 'disabled'}>${next ? '下一步' : '儲存'}</button>`;
}

// ---------- Sheets ----------

// One sheet at a time. Its frame stays while what's inside changes, so a tap
// on a chip doesn't replay the rise; drag it down by the top to put it away.
let closeTimer;
function showSheet(kind, label, html) {
  clearTimeout(closeTimer);
  let sheet = sheetRoot.querySelector('.sheet');
  if (!sheet || sheet.classList.contains('closing') || sheet.dataset.kind !== kind) {
    sheetRoot.innerHTML = `
      <div class="backdrop" data-action="close"></div>
      <section class="sheet ${kind}" data-kind="${kind}" role="dialog" aria-modal="true">
        <div class="grabber" aria-hidden="true"></div>
        <div class="sheet-inner"></div>
      </section>`;
    sheet = sheetRoot.querySelector('.sheet');
    dragToDismiss(sheet);
    document.body.classList.add('sheet-open');
  }
  sheet.setAttribute('aria-label', label);
  // Keep where the body and the chip rows were scrolled to
  const body = sheet.querySelector('.sheet-body'), top = body?.scrollTop ?? 0;
  const lefts = [...sheet.querySelectorAll('.scroll-chips')].map(el => el.scrollLeft);
  sheet.querySelector('.sheet-inner').innerHTML = html;
  const newBody = sheet.querySelector('.sheet-body');
  if (newBody) newBody.scrollTop = top;
  sheet.querySelectorAll('.scroll-chips').forEach((el, i) => { el.scrollLeft = lefts[i] ?? 0; });
}

function closeSheet() {
  draft = null;
  settle = null;
  ledgerForm = null;
  document.body.classList.remove('sheet-open');
  const sheet = sheetRoot.querySelector('.sheet');
  if (!sheet) return;
  document.activeElement?.blur();
  sheet.style.transition = '';
  sheet.classList.add('closing');
  sheetRoot.querySelector('.backdrop')?.classList.add('closing');
  closeTimer = setTimeout(() => { sheetRoot.innerHTML = ''; }, reduceMotion.matches ? 0 : 300);
}

// A new record with something typed asks before it's thrown away
function requestClose() {
  const d = draft;
  const typedSomething = d?.isNew && !calcEmpty(d.calc);
  if (typedSomething && !confirm('放棄這筆共用支出？')) return false;
  closeSheet();
  return true;
}

function dragToDismiss(sheet) {
  let drag = null;
  sheet.addEventListener('pointerdown', event => {
    const handle = event.target.closest('.grabber, .sheet-head');
    if (!handle || event.target.closest('button, input, select, label')) return;
    drag = { y: event.clientY, t: performance.now(), dy: 0 };
    sheet.setPointerCapture(event.pointerId);
    sheet.style.transition = 'none';
  });
  sheet.addEventListener('pointermove', event => {
    if (!drag) return;
    const dy = event.clientY - drag.y;
    // Pulling up gives a little, like a rubber band
    drag.dy = dy > 0 ? dy : -Math.sqrt(-dy) * 2;
    sheet.style.transform = `translateY(${drag.dy}px)`;
    const backdrop = sheetRoot.querySelector('.backdrop');
    if (backdrop) backdrop.style.opacity = String(Math.max(0, 1 - drag.dy / 400));
  });
  const end = () => {
    if (!drag) return;
    const fast = drag.dy / (performance.now() - drag.t) > 0.6;
    const away = drag.dy > 120 || (fast && drag.dy > 30);
    drag = null;
    if (away && requestClose()) return;
    sheet.style.transition = 'transform 0.45s var(--spring)';
    sheet.style.transform = '';
    const backdrop = sheetRoot.querySelector('.backdrop');
    if (backdrop) backdrop.style.opacity = '';
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
}

// ---------- Entry screen ----------

// The same screen as SharedEntryScreen in the app: the amount with its
// keypad, 我付 ▾ 平分 ▾ under it, then 分類, 子分類 and 備註; pickers rise
// in a card from the bottom. Starts as 我付・平分.
let draft = null, shownPanel = null;

function openEntry(entry) {
  if (entry?.kind === 'income') { toast('收入紀錄請在 App 裡修改'); return; }
  if (entry?.kind === 'settlement') { openSettle(entry); return; }
  const billBear = entry?.note?.startsWith('Bill Bear 匯入');
  draft = entry ? {
    id: entry.id, isNew: false, calc: calcOf(typed(recordedAmount(entry))), panel: 'done', date: entry.date,
    category: entry.category, name: entry.name, addingSub: false,
    note: billBear ? '' : entry.note ?? '', keepNote: billBear ? entry.note : null,
    ...splitOf(entry),
    ledgerId: entry.ledger_id ?? HOUSEHOLD, saved: entry, foreign: isForeign(entry),
    payment: entry.payment_method ?? lastPayment(entry.ledger_id ?? HOUSEHOLD),
    twdText: '', twdConfirmed: !entry.twd_estimated,
  } : {
    id: crypto.randomUUID(), isNew: true, calc: calcOf(), panel: 'amount', date: today(),
    category: null, name: '', addingSub: false, note: '', keepNote: null,
    payer: 'me', minePaidText: '', division: 'equal', myShareText: '',
    // An archived ledger is for looking back at; new records never go there
    ledgerId: currentLedger().archived_at ? HOUSEHOLD : state.ledgerId, saved: null, twdText: '',
  };
  if (!entry) {
    draft.foreign = ledgerOf(draft.ledgerId).currency !== 'TWD';
    choosePayment(lastPayment(draft.ledgerId));
  }
  draft.keeps = keepsSaved();
  draft.calMonth = monthKey(draft.date);
  shownPanel = null;
  renderEntry();
}

const draftTotal = () => calcValue(draft.calc) ?? 0;
const draftLedger = () => ledgerOf(draft.ledgerId);
const draftForeign = () => draft.foreign && draftLedger().currency !== 'TWD';
// The currency the amount and the division are typed in
const draftCode = () => (draftForeign() ? draftLedger().currency : 'TWD');

function lastPayment(ledgerId) {
  try { return JSON.parse(localStorage.getItem('sharedLastPayment') ?? '{}')[ledgerId] ?? 'card'; } catch { return 'card'; }
}
function rememberPayment(ledgerId, payment) {
  try {
    const all = JSON.parse(localStorage.getItem('sharedLastPayment') ?? '{}');
    all[ledgerId] = payment;
    localStorage.setItem('sharedLastPayment', JSON.stringify(all));
  } catch { /* private mode */ }
}

// Cash is always Julia's (she changes it), and final at her rate; cards and
// Suica are guesses until the bill
function choosePayment(payment) {
  draft.payment = payment;
  draft.twdConfirmed = payment === 'cash';
  if (payment === 'cash') draft.payer = state.me === 'julia' ? 'me' : 'partner';
}

// NT$ at the trip's rate for how it was paid; null without a rate
function estimatedTWD() {
  const total = draftTotal(), rate = rateFor(draftLedger(), draft.payment);
  return draftForeign() && total > 0 && rate ? twdFromForeign(total, rate) : null;
}

// A saved trip record whose amount and payment are as they were keeps the NT$
// it was saved with, so changing only the note never changes what anyone owes
function keepsSaved() {
  const saved = draft.saved;
  return !!saved && isForeign(saved) && draftForeign() && draftTotal() === recordedAmount(saved)
    && draft.payment === (saved.payment_method ?? draft.payment);
}

// What's saved as the NT$ amount: typed, else the saved one, else the guess
function draftTWD() {
  if (!draftForeign()) return draftTotal();
  return cents(draft.twdText) ?? (keepsSaved() ? draft.saved.amount_cents : estimatedTWD());
}

// What is still missing before saving, in the order it's asked for
function missing() {
  const d = draft;
  if (draftTotal() <= 0) return 'amount';
  if (!d.category) return 'category';
  if (!amounts(draftTotal(), d)) return d.payer === 'both' ? 'payer' : 'division';
  if (!(draftTWD() > 0)) return 'twd';
  return null;
}

function show(panel) {
  document.activeElement?.blur();
  draft.addingSub = false;
  // There's nothing to pick for the NT$ amount; it's typed
  if (panel === 'twd') {
    draft.panel = 'done';
    renderEntry();
    sheetRoot.querySelector('#twdInput')?.focus();
    return;
  }
  draft.panel = panel;
  renderEntry();
}

function shortDay(day) {
  const { word, short } = dayLabel(day);
  return word ?? short;
}

const payerTitle = () => ({ me: '我付', partner: `${partnerName()} 付`, both: '各付一部分' }[draft.payer]);
const divisionTitle = () => ({ equal: '平分', allMine: '全算我', allPartners: `全算 ${partnerName()}`, custom: '自訂' }[draft.division]);

function categoryIcon(key, size) {
  const c = CATEGORIES[key] ?? CATEGORIES.other;
  return `<span class="icon" style="width:${size}px;height:${size}px;background:${c.color}12;border:1px solid ${c.color}29;color:${c.color}">${glyph(c.icon)}</span>`;
}

function cell(action, value, picked, label, tint = 'var(--accent)') {
  return `<button class="cell ${picked ? 'on' : ''}" data-action="${action}" data-value="${value}" style="--tint:${tint}" aria-pressed="${picked}">${label}</button>`;
}

function partField(title, field) {
  return `<label class="part-field"><span>${title}</span>
    <input inputmode="decimal" placeholder="${currencySign(draftCode())}" value="${escape(draft[field])}" data-field="${field}" class="num"></label>`;
}

function calendar() {
  const d = draft, [y, m] = d.calMonth.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const now = today();
  const cells = Array.from({ length: first }, () => '<span></span>');
  for (let day = 1; day <= days; day++) {
    const key = `${d.calMonth}-${String(day).padStart(2, '0')}`;
    cells.push(`<button class="day ${key === d.date ? 'on' : ''} ${key === now ? 'today' : ''}" data-action="day" data-value="${key}">${day}</button>`);
  }
  return `
    <div class="calendar">
      <div class="cal-head">
        <span class="cal-title">${y}年${m}月</span><span class="spacer"></span>
        <button data-action="calMonth" data-value="-1" aria-label="上個月">${glyph('chevron-left')}</button>
        <button data-action="calMonth" data-value="1" aria-label="下個月">${glyph('chevron-right')}</button>
      </div>
      <div class="cal-grid">${'日一二三四五六'.split('').map(w => `<span class="weekday">${w}</span>`).join('')}${cells.join('')}</div>
    </div>`;
}

function primaryButton() {
  const next = missing();
  const title = { null: '儲存', amount: '輸入金額', category: '選擇分類', twd: '填台幣金額' }[next] ?? '填好分攤';
  return `<button class="primary ${next ? 'pending' : ''}" data-action="primary" id="save">${title}</button>`;
}

function pickerCard() {
  const d = draft, partner = partnerName(), a = amounts(draftTotal(), d);
  let body;
  if (d.panel === 'category') {
    body = `<div class="cells two">${PICKABLE.map(key => cell('category', key, d.category === key,
      `${categoryIcon(key, 30)}<span>${CATEGORIES[key].title}</span>`, CATEGORIES[key].color)).join('')}</div>`;
  } else if (d.panel === 'payer') {
    body = `<div class="picker-title">誰付的</div>
      <div class="cells three">${cell('payer', 'me', d.payer === 'me', '我付')}${cell('payer', 'partner', d.payer === 'partner', `${escape(partner)} 付`)}${cell('payer', 'both', d.payer === 'both', '各付一部分')}</div>
      ${d.payer === 'both' ? partField('我付了多少', 'minePaidText') : ''}`;
  } else if (d.panel === 'division') {
    body = `<div class="picker-title">怎麼分</div>
      <div class="cells two">${cell('division', 'equal', d.division === 'equal', '平分')}${cell('division', 'allMine', d.division === 'allMine', '全算我')}${cell('division', 'allPartners', d.division === 'allPartners', `全算 ${escape(partner)}`)}${cell('division', 'custom', d.division === 'custom', '自訂')}</div>
      ${d.division === 'custom' ? partField('我的份', 'myShareText') : ''}
      <div class="picker-note num" id="divisionNote"></div>`;
  } else {
    body = calendar();
  }
  return `<div class="picker-card ${shownPanel !== d.panel ? 'enter' : ''}">${body}${d.panel !== 'category' ? primaryButton() : ''}</div>`;
}

function renderEntry() {
  const d = draft;
  const subs = d.category ? subcategories(d.category, d.ledgerId, draftCode()) : [];
  const ledger = draftLedger(), choices = activeLedgers();
  // Which ledger, under the title; a new record can go to another one
  const ledgerPick = d.isNew && choices.length > 1
    ? `<label class="ledger-pick">${escape(ledger.name)}${glyph('chevron-down')}
        <select data-draft="ledgerId" aria-label="記在 ${escape(ledger.name)}，點一下換帳本">${choices.map(l => `<option value="${l.id}" ${l.id === ledger.id ? 'selected' : ''}>${escape(l.name)}</option>`).join('')}</select></label>`
    : `<span class="ledger-pick">${escape(ledger.name)}</span>`;
  if (d.name && !subs.some(s => s.name === d.name)) subs.unshift({ name: d.name, cents: null });
  const title = d.isNew ? '新增共用支出' : '編輯共用支出';
  const picker = ['category', 'payer', 'division', 'date'].includes(d.panel);
  const chip = (panel, text) => `<button class="split-chip ${d.panel === panel ? 'on' : ''}" data-action="panel" data-value="${panel}">${escape(text)}${glyph('chevron-down')}</button>`;

  showSheet('entry', title, `
    <div class="sheet-head entry-head">
      <button class="circle" data-action="close" aria-label="關閉">${glyph('x')}</button>
      <div class="entry-title"><h2>${title}</h2>${ledgerPick}</div>
      ${d.isNew ? '<span class="circle-space"></span>' : `<button class="circle" data-action="delete" aria-label="刪除">${glyph('trash-2')}</button>`}
    </div>

    <div class="amount-block ${d.panel === 'amount' ? 'active' : ''}">
      <div class="amount-line">
        ${ledger.currency !== 'TWD'
          ? `<button class="currency-pill ${draftForeign() ? 'on' : ''}" data-action="currency" aria-label="幣別 ${draftCode()}，點一下切換">${draftCode()}${glyph('arrow-left-right')}</button>`
          : '<span class="currency-pill">TWD</span>'}
        <button class="figures" data-action="panel" data-value="amount" aria-label="金額">
          <span class="expression num" id="expression"></span>
          <span class="headline num" id="headline"></span>
        </button>
      </div>
      <div class="date-line">
        <button class="date-button ${d.panel === 'date' ? 'on' : ''}" data-action="panel" data-value="date">${glyph('chevron-down')}<span class="num">${shortDay(d.date)}</span></button>
      </div>
    </div>

    <div class="form">
      <div class="split-row">
        ${chip('payer', payerTitle())}${chip('division', divisionTitle())}
        <span class="spacer"></span><span class="mine num" id="myShare"></span>
      </div>
      <div class="divider"></div>
      ${draftForeign() ? `
        <div class="form-row">
          <span class="row-title">付款</span>
          <div class="scroll-chips">${Object.entries(PAYMENTS).map(([key, p]) =>
            `<button class="chip ${d.payment === key ? 'on' : ''}" data-action="payment" data-value="${key}" aria-pressed="${d.payment === key}">${p.title}</button>`).join('')}</div>
        </div>
        <div class="divider"></div>
        <div class="form-row">
          <span class="row-title">台幣</span>
          <input id="twdInput" inputmode="decimal" class="num" value="${escape(d.twdText)}" data-field="twdText">
          <button class="confirm-toggle" data-action="twdConfirm" id="twdConfirm"></button>
        </div>
        <div class="divider"></div>` : ''}
      <button class="form-row" data-action="panel" data-value="category">
        <span class="row-title ${d.panel === 'category' ? 'on' : ''}">分類</span>
        ${d.category ? `<span class="picked">${categoryIcon(d.category, 28)}${CATEGORIES[d.category].title}</span>`
          : `<span class="prompt">選擇分類${glyph('chevron-right')}</span>`}
      </button>
      <div class="divider"></div>
      <div class="form-row">
        <span class="row-title">子分類</span>
        ${!d.category ? '<span class="tertiary">請先選分類</span>'
          : d.addingSub ? `<input type="text" id="newSub" placeholder="輸入子分類" value="${escape(d.name)}" data-field="name" enterkeyhint="done">`
          : `<div class="scroll-chips">${subs.map(s => `<button class="chip ${s.name === d.name ? 'on' : ''}" data-action="sub" data-value="${escape(s.name)}" data-cents="${s.cents ?? ''}">${escape(s.name)}</button>`).join('')}
              <button class="chip plus" data-action="addSub" aria-label="新增子分類">＋</button></div>`}
      </div>
      <div class="divider"></div>
      <label class="form-row">
        <span class="row-title">備註</span>
        <input type="text" placeholder="選填" value="${escape(d.note)}" data-field="note" enterkeyhint="done">
      </label>
    </div>

    <div class="grow"></div>
    ${picker ? '' : `<div class="bottom-panel ${shownPanel !== d.panel && shownPanel !== null ? 'enter' : ''}">
      ${d.panel === 'amount' ? keypad() : primaryButton()}</div>`}
    ${picker ? `<div class="picker-backdrop" data-action="panel" data-value="${missing() === 'amount' ? 'amount' : 'done'}"></div>${pickerCard()}` : ''}`);
  shownPanel = d.panel;
  updateAmount();
  if (d.addingSub) sheetRoot.querySelector('#newSub')?.focus();
}

// What a key changes: the figures, 我的份 and the buttons' titles
function updateAmount() {
  const d = draft, total = draftTotal(), a = amounts(total, d), next = missing();
  const q = id => sheetRoot.querySelector(id);
  const headline = q('#headline');
  headline.textContent = calcHeadline(d.calc);
  headline.classList.toggle('empty', calcEmpty(d.calc));
  headline.classList.toggle('preselected', d.calc.preselected);
  q('#expression').textContent = calcExpression(d.calc) || ' ';
  const code = draftCode();
  q('#myShare').textContent = a && total > 0 ? `我的份 ${fmt(a.myShare, code)}` : '';
  const note = q('#divisionNote');
  if (note) {
    note.className = 'picker-note num' + (total > 0 && !a ? ' error' : '');
    note.textContent = total > 0 ? (a ? `我的份 ${fmt(a.myShare, code)} · ${partnerName()} 的份 ${fmt(a.partnerShare, code)}` : '填的金額超過總額了') : '';
  }
  // Moving off the saved amount (another amount, another payment) makes it a
  // fresh guess or cash figure; back on it, it's as it was saved
  const keeps = keepsSaved();
  if (keeps !== d.keeps && d.saved && !d.twdText) d.twdConfirmed = keeps ? !d.saved.twd_estimated : d.payment === 'cash';
  d.keeps = keeps;
  const twd = q('#twdInput');
  if (twd) {
    const shown = keeps ? d.saved.amount_cents : estimatedTWD();
    twd.placeholder = shown != null ? (d.twdConfirmed ? '' : '≈ ') + money(shown) : total > 0 ? '填台幣金額' : '自動換算';
    twd.classList.toggle('missing', shown == null && total > 0);
    const toggle = q('#twdConfirm');
    toggle.innerHTML = `${glyph(d.twdConfirmed ? 'circle-check' : 'circle-dashed')}<span>${d.twdConfirmed ? '已確認' : '預估'}</span>`;
    toggle.classList.toggle('on', d.twdConfirmed);
    toggle.setAttribute('aria-label', d.twdConfirmed ? '台幣已確認，點一下改回預估' : '台幣是預估，點一下標成已確認');
  }
  const action = q('#keyAction');
  if (action) { action.disabled = !(total > 0); action.textContent = next ? '下一步' : '儲存'; }
  const save = q('#save');
  if (save) {
    save.textContent = { null: '儲存', amount: '輸入金額', category: '選擇分類', twd: '填台幣金額' }[next] ?? '填好分攤';
    save.classList.toggle('pending', !!next);
  }
}

// The keypad's button: works the sum out, then on to what's missing or saves
async function keyAction() {
  calcKey(draft.calc, '=');
  const next = missing();
  if (next) show(next); else await saveEntry();
}

async function primary() {
  const next = missing();
  if (next) show(next); else await saveEntry();
}

async function saveEntry() {
  const d = draft, total = draftTotal(), a = amounts(total, d), twd = draftTWD();
  if (!a || !d.category || !(twd > 0)) return;
  const note = d.note.trim();
  const row = {
    ...baseRow(d.id, d.ledgerId), kind: 'expense', category: d.category, name: d.name.trim(), date: d.date,
    amount_cents: total, note: note || d.keepNote || null,
  };
  if (draftForeign()) {
    // Typed in the trip's currency; the NT$ columns follow its division
    row.currency = draftLedger().currency;
    row.orig_amount_cents = total;
    putAmounts(row, a, 'orig_');
    row.amount_cents = twd;
    putAmounts(row, scale(a, twd));
    row.payment_method = d.payment;
    row.twd_estimated = !d.twdConfirmed;
    rememberPayment(d.ledgerId, d.payment);
  } else {
    putAmounts(row, a);
  }
  // The next record goes where this one did
  if (d.ledgerId !== state.ledgerId) selectLedger(d.ledgerId);
  await commit(row, d.isNew, `已記共用 ${row.name || CATEGORIES[d.category].title} ${fmt(total, draftCode())}`);
}

async function commit(row, isNew, message) {
  const save = sheetRoot.querySelector('#save, #keyAction');
  const title = save?.textContent;
  if (save) { save.disabled = true; save.textContent = '儲存中…'; }
  try {
    await saveRow(row, isNew);
    state.flashId = row.id;
    closeSheet();
    if (state.view === 'list') state.month = monthKey(row.date);
    render();
    toast(message);
  } catch {
    if (save) { save.disabled = false; save.textContent = title; }
    toast('連不上共用帳，剛才填的內容都還在，請確認網路後再試一次');
  }
}

// Gone at once with a 復原 in the toast, instead of asking first
async function removeEntry(id) {
  const entry = state.entries.find(e => e.id === id);
  if (!entry) return;
  const wrap = app.querySelector(`.swipe[data-swipe="${id}"]`);
  if (wrap) {
    wrap.style.height = `${wrap.offsetHeight}px`;
    wrap.getBoundingClientRect();
    wrap.classList.add('removing');
    await wait(240);
  }
  try {
    await saveRow({ id, deleted_at: new Date().toISOString() }, false);
    render();
    toast('已刪除', { label: '復原', run: () => restore(entry) });
  } catch {
    render();
    toast('連不上共用帳，請確認網路後再試一次');
  }
}

async function restore(entry) {
  try {
    await saveRow(sample ? { ...entry, deleted_at: null } : { id: entry.id, deleted_at: null }, false);
    state.flashId = entry.id;
    render();
    toast('已復原');
  } catch { toast('連不上共用帳，請確認網路後再試一次'); }
}

// ---------- Ledger sheet ----------

// Which ledger is on screen: the ones in use with where each stands, then
// 新增旅遊帳 and the current trip's settings, then archived ones, all flat
// (SharedLedgerPicker in the app). The trip form opens in the same sheet.
let ledgerForm = null;

function openLedgers() {
  ledgerForm = null;
  const current = currentLedger(), archived = state.ledgers.filter(l => l.archived_at);
  const status = l => {
    const b = balance(l.id), partner = partnerName(), amount = `NT$ ${money(Math.abs(b))}`;
    return b === 0 ? '兩清' : b > 0 ? `${partner} 欠你 ${amount}` : `你欠 ${partner} ${amount}`;
  };
  const item = l => `<button class="row ledger-item" data-action="pickLedger" data-value="${l.id}" aria-pressed="${l.id === current.id}">
      <span class="ledger-icon">${glyph(isTrip(l) ? 'plane' : 'house')}</span>
      <span class="main"><div class="title">${escape(l.name)}</div><div class="detail num">${escape(status(l))}</div></span>
      ${l.id === current.id ? `<span class="check">${glyph('check')}</span>` : ''}</button>`;
  showSheet('ledgers', '帳本', `
    <div class="sheet-head">
      <span style="width:44px"></span>
      <h2>帳本</h2>
      <button class="text-button" data-action="close">完成</button>
    </div>
    <div class="sheet-body">
      <div class="card rows">${activeLedgers().map(item).join('')}</div>
      <div class="card rows">
        <button class="row action-row" data-action="newTrip">${glyph('plane')}<span>新增旅遊帳</span></button>
        ${isTrip(current) ? `<button class="row action-row" data-action="tripSettings">${glyph('sliders-horizontal')}<span>${escape(current.name)} 設定</span></button>` : ''}
      </div>
      ${archived.length ? `<div class="section-title">已封存</div><div class="card rows">${archived.map(item).join('')}</div>` : ''}
    </div>`);
}

// Adding a trip or a trip's settings: name, currency, the two rates
// (market rate as the hint), archiving (SharedLedgerSheet in the app)
function openLedgerForm(ledger) {
  const hasRecords = ledger && ledgerEntries(ledger.id).length > 0;
  ledgerForm = {
    ledger, isNew: !ledger, hasRecords,
    name: ledger?.name ?? '', currency: ledger?.currency ?? 'JPY',
    cashText: ledger?.cash_rate != null ? String(Number(ledger.cash_rate)) : '',
    cardText: ledger?.card_rate != null ? String(Number(ledger.card_rate)) : '',
  };
  renderLedgerForm();
}

function renderLedgerForm() {
  const f = ledgerForm, market = marketText(f.currency);
  const hint = market ? `市價 ${market}` : '例如 0.2125';
  const currencies = TRIP_CURRENCIES.includes(f.currency) ? TRIP_CURRENCIES : [...TRIP_CURRENCIES, f.currency];
  showSheet('ledgers', f.isNew ? '新增旅遊帳' : '旅遊帳設定', `
    <div class="sheet-head">
      <button class="text-button" data-action="ledgers">取消</button>
      <h2>${f.isNew ? '新增旅遊帳' : '旅遊帳設定'}</h2>
      <button class="text-button strong" data-action="saveLedger" id="saveLedger">${f.isNew ? '新增' : '儲存'}</button>
    </div>
    <div class="sheet-body">
      <div class="card">
        <label class="field"><input type="text" placeholder="名稱（例如：東京 2026 冬）" value="${escape(f.name)}" data-ledger="name"></label>
        <div class="divider"></div>
        <!-- A trip already written in keeps its currency, so old records still add up -->
        <label class="field"><span class="name">外幣</span>
          <select data-ledger="currency" ${f.hasRecords ? 'disabled' : ''}>${currencies.map(c => `<option ${c === f.currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <div class="section-title">1 ${escape(f.currency)} = ? TWD</div>
      <div class="card">
        <label class="field"><span class="name">現金匯率</span><input inputmode="decimal" class="num right" placeholder="${hint}" value="${escape(f.cashText)}" data-ledger="cashText"></label>
        <div class="divider"></div>
        <label class="field"><span class="name">刷卡參考匯率</span><input inputmode="decimal" class="num right" placeholder="${hint}" value="${escape(f.cardText)}" data-ledger="cardText"></label>
      </div>
      <p class="footnote">現金填換匯實拿的匯率；刷卡留空就用記帳當下的市價。</p>
      ${f.ledger ? `
        <div class="card"><button class="row action-row ${f.ledger.archived_at ? '' : 'danger'}" data-action="archiveLedger">${glyph('archive')}<span>${f.ledger.archived_at ? '取消封存' : '封存這本帳'}</span></button></div>` : ''}
    </div>`);
  updateLedgerForm();
}

const rateValue = text => { const v = Number(String(text).trim()); return text.trim() && v > 0 ? v : null; };

function updateLedgerForm() {
  const f = ledgerForm, button = sheetRoot.querySelector('#saveLedger');
  const ratesOk = (!f.cashText.trim() || rateValue(f.cashText)) && (!f.cardText.trim() || rateValue(f.cardText));
  if (button) button.disabled = !f.name.trim() || !/^[A-Z]{3}$/.test(f.currency) || !ratesOk;
}

async function writeLedger(changes) {
  const f = ledgerForm;
  const ledger = { ...(f.ledger ?? { id: crypto.randomUUID(), purpose: 'trip', archived_at: null }), ...changes };
  delete ledger.created_at;
  try {
    await saveLedger(ledger, f.isNew);
    // A new trip is where the next record goes; an archived one isn't
    if (f.isNew) selectLedger(ledger.id);
    else if (ledger.archived_at && state.ledgerId === ledger.id) selectLedger(HOUSEHOLD);
    else pickLedger();
    closeSheet();
    render();
    toast(f.isNew ? `已新增 ${ledger.name}` : '已儲存');
  } catch { toast('連不上共用帳，請確認網路後再試一次'); }
}

async function saveLedgerForm() {
  const f = ledgerForm;
  await writeLedger({ name: f.name.trim(), currency: f.currency, cash_rate: rateValue(f.cashText), card_rate: rateValue(f.cardText) });
}

async function archiveLedger() {
  const l = ledgerForm.ledger;
  const kept = '紀錄都會留著，隨時可以取消封存。';
  if (!l.archived_at && !confirm(`封存「${l.name}」？${balance(l.id) !== 0 ? '這本帳還沒兩清。' : ''}${kept}`)) return;
  await writeLedger({ archived_at: l.archived_at ? null : new Date().toISOString() });
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
  const ledger = currentLedger(), title = isTrip(ledger) ? `結清 · ${ledger.name}` : '結清';
  const estimated = estimatedCount();
  showSheet('settle', title, `
    <div class="sheet-head">
      <button class="text-button" data-action="close">取消</button>
      <h2>${escape(title)}</h2>
      ${settle.isNew ? '<span style="width:44px"></span>' : '<button class="text-button danger" data-action="delete">刪除</button>'}
    </div>
    <p class="secondary" style="margin:8px 4px 0">${escape(direction)}</p>
    <label class="amount-input"><span>NT$</span>
      <input id="settleAmount" inputmode="decimal" value="${escape(settle.amountText)}" data-settle="amountText">
    </label>
    <div class="field"><span class="name">日期</span><input type="date" value="${settle.date}" max="${today()}" data-settle="date"></div>
    <div class="field"><span class="name">備註</span><input type="text" placeholder="例如：轉帳、現金" value="${escape(settle.note)}" data-settle="note"></div>
    <div class="summary num" id="settleSummary"></div>
    <p class="summary">${estimated ? `還有 ${estimated} 筆台幣是預估，之後補上帳單金額可能還要補差額。` : ''}確認錢真的轉過去之後再記。</p>
    <button class="primary" data-action="saveSettle" id="save">記錄</button>`);
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

// ---------- Swipe to delete ----------

const DELETE_WIDTH = 88;
let swipe = null, openSwipe = null, swipedAt = 0;

function setSwipe(wrap, offset, animated) {
  const rowEl = wrap.querySelector('.row');
  rowEl.style.transition = animated ? 'transform 0.4s var(--spring)' : 'none';
  rowEl.style.transform = offset ? `translateX(${offset}px)` : '';
  wrap.style.setProperty('--reveal', `${-offset}px`);
  wrap.classList.toggle('revealing', offset < 0);
  wrap.classList.toggle('animated', animated);
}

function closeOpenSwipe() {
  if (openSwipe?.isConnected) setSwipe(openSwipe, 0, true);
  openSwipe = null;
}

app.addEventListener('pointerdown', event => {
  const wrap = event.target.closest('.swipe[data-swipe]');
  if (!wrap || event.target.closest('.swipe-delete') || (event.pointerType === 'mouse' && event.button !== 0)) return;
  swipe = { wrap, x: event.clientX, y: event.clientY, base: wrap === openSwipe ? -DELETE_WIDTH : 0, offset: 0, on: false };
});

app.addEventListener('pointermove', event => {
  if (!swipe) return;
  const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
  if (!swipe.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (Math.abs(dx) < 10) return;
    swipe.on = true;
    if (openSwipe && openSwipe !== swipe.wrap) closeOpenSwipe();
    swipe.wrap.setPointerCapture(event.pointerId);
  }
  // Past the button it gets heavier
  let offset = Math.min(0, swipe.base + dx);
  if (offset < -DELETE_WIDTH) offset = -DELETE_WIDTH - Math.sqrt(-offset - DELETE_WIDTH) * 4;
  swipe.offset = offset;
  setSwipe(swipe.wrap, offset, false);
});

function endSwipe() {
  if (!swipe) return;
  if (swipe.on) {
    swipedAt = Date.now();
    const open = swipe.offset < -DELETE_WIDTH / 2;
    setSwipe(swipe.wrap, open ? -DELETE_WIDTH : 0, true);
    openSwipe = open ? swipe.wrap : null;
  }
  swipe = null;
}
app.addEventListener('pointerup', endSwipe);
app.addEventListener('pointercancel', endSwipe);

// ---------- Events ----------

// A short note at the top; with an action (復原) it stays a little longer
let toastTimer;
function toast(text, action) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${escape(text)}</span>${action ? `<button>${escape(action.label)}</button>` : ''}`;
  el.querySelector('button')?.addEventListener('click', () => { el.remove(); action.run(); });
  document.body.append(el);
  toastTimer = setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, action ? 4000 : 1800);
}

function changeMonth(by) {
  if (by > 0 && state.month >= monthKey(today())) return;
  animate(by > 0 ? 'month-next' : 'month-prev', () => { state.month = shiftMonth(state.month, by); render(); });
}

document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target) { if (state.menuOpen) { state.menuOpen = false; render(); } return; }
  const action = target.dataset.action;
  if (action !== 'menu' && state.menuOpen) { state.menuOpen = false; render(); }
  // A tap that ends a swipe, or lands while a row is swiped open, only closes it
  if (action === 'open' && (Date.now() - swipedAt < 350 || openSwipe)) { closeOpenSwipe(); return; }
  switch (action) {
    case 'google':
      await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
      break;
    case 'signOut':
      if (!sample) await db.auth.signOut();
      state.status = 'signedOut'; state.entries = []; state.allEntries = []; render();
      break;
    case 'refresh': await refresh(); toast('已更新'); break;
    case 'menu': state.menuOpen = !state.menuOpen; render(); break;
    case 'hideHint': remember('hideInstallHint'); render(); break;
    case 'prevMonth': changeMonth(-1); break;
    case 'nextMonth': changeMonth(1); break;
    case 'add':
      // An archived ledger is for looking back at
      if (currentLedger().archived_at) toast('已封存的帳本不能新增'); else openEntry(null);
      break;
    case 'ledgers': openLedgers(); break;
    case 'pickLedger': selectLedger(target.dataset.value); closeSheet(); render(); break;
    case 'newTrip': openLedgerForm(null); break;
    case 'tripSettings': openLedgerForm(currentLedger()); break;
    case 'saveLedger': await saveLedgerForm(); break;
    case 'archiveLedger': await archiveLedger(); break;
    case 'scope': state.whole = !wholeTotals(); render(); break;
    case 'currency':
      draft.foreign = !draft.foreign;
      draft.twdText = '';
      renderEntry();
      break;
    case 'payment': choosePayment(target.dataset.value); renderEntry(); break;
    case 'twdConfirm': draft.twdConfirmed = !draft.twdConfirmed; updateAmount(); break;
    case 'stats': state.basis = 'total'; go('stats'); break;
    case 'basis': state.basis = target.dataset.value; render(); break;
    case 'statsCategory': state.statsCategory = target.dataset.value; go('category'); break;
    case 'sort': state.byAmount = !state.byAmount; render(); break;
    case 'back': backByButton = true; history.back(); break;
    case 'open': openEntry(state.entries.find(e => e.id === target.dataset.id)); break;
    case 'swipeDelete': openSwipe = null; await removeEntry(target.dataset.id); break;
    case 'settle': openSettle(null); break;
    case 'close': requestClose(); break;
    case 'key':
      calcKey(draft.calc, target.dataset.value);
      updateAmount();
      break;
    case 'panel':
      if (draft.panel !== target.dataset.value) show(target.dataset.value);
      break;
    case 'keyAction': await keyAction(); break;
    case 'primary': await primary(); break;
    case 'payer': case 'division': {
      const group = action, value = target.dataset.value;
      draft[group] = value;
      // 各付一部分 and 自訂 need a figure typed; the rest move straight on
      if (value === 'both' || value === 'custom') {
        renderEntry();
        sheetRoot.querySelector('.part-field input')?.focus();
      } else show(missing() ?? 'done');
      break;
    }
    case 'category':
      // Another category's 子分類 doesn't carry over
      if (draft.category !== target.dataset.value) draft.name = '';
      draft.category = target.dataset.value;
      show(missing() ?? 'done');
      break;
    case 'day': draft.date = target.dataset.value; show(missing() ?? 'done'); break;
    case 'calMonth': draft.calMonth = shiftMonth(draft.calMonth, Number(target.dataset.value)); renderEntry(); break;
    case 'sub': {
      const name = target.dataset.value, picked = draft.name === name;
      draft.name = picked ? '' : name;
      // Last time's amount, highlighted, unless one is typed already
      if (!picked && target.dataset.cents && (calcEmpty(draft.calc) || draft.calc.preselected)) {
        draft.calc = calcOf(typed(Number(target.dataset.cents)), true);
      }
      renderEntry();
      break;
    }
    case 'addSub': draft.name = ''; draft.addingSub = true; renderEntry(); break;
    case 'delete': {
      const id = draft?.id ?? settle?.id;
      closeSheet();
      await removeEntry(id);
      break;
    }
    case 'saveSettle': await saveSettle(); break;
  }
});

document.addEventListener('input', event => {
  const field = event.target.dataset.field, settleField = event.target.dataset.settle;
  const ledgerField = event.target.dataset.ledger;
  if (ledgerField && ledgerForm) {
    ledgerForm[ledgerField] = event.target.value;
    if (ledgerField === 'currency') renderLedgerForm(); else updateLedgerForm();
  }
  // Another ledger for a new record: its currency, its last payment, its names
  if (event.target.dataset.draft === 'ledgerId' && draft) {
    draft.ledgerId = event.target.value;
    draft.foreign = draftLedger().currency !== 'TWD';
    draft.twdText = '';
    draft.name = '';
    choosePayment(lastPayment(draft.ledgerId));
    renderEntry();
  }
  if (field && draft) { draft[field] = event.target.value; updateAmount(); }
  if (settleField && settle) { settle[settleField] = event.target.value; updateSettleSummary(); }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.id === 'newSub') { draft.addingSub = false; renderEntry(); }
  else if (event.key === 'Enter' && event.target.dataset.field === 'note') event.target.blur();
  if (event.key === 'Escape' && (draft || settle || sheetRoot.querySelector('.sheet'))) requestClose();
  // A keyboard on a computer types into the keypad too
  if (draft?.panel === 'amount' && !event.target.matches('input')) {
    const key = { '*': '×', '/': '÷', '-': '−', Backspace: 'back', Enter: null }[event.key] ?? event.key;
    if (event.key === 'Enter') { event.preventDefault(); keyAction(); }
    else if (/^[0-9.+×÷−=]$/.test(key) || key === 'back') { calcKey(draft.calc, key); updateAmount(); }
  }
});

// Typing 子分類 or 備註 puts the keypad away, like the app
document.addEventListener('focusin', event => {
  if (draft && event.target.matches('.form input') && draft.panel !== 'done') {
    draft.panel = 'done';
    const bottom = sheetRoot.querySelector('.bottom-panel');
    if (bottom) bottom.innerHTML = primaryButton();
    sheetRoot.querySelector('.picker-card, .picker-backdrop')?.remove();
    sheetRoot.querySelector('.amount-block')?.classList.remove('active');
  }
});

// Coming back to the page picks up what Julia added meanwhile
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.status === 'ready' && !draft && !settle) refresh();
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
  await Promise.all([refresh(), loadMarket()]);
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
  // A trip in yen: cash at the exchange rate, a card and a Suica still guessed
  const trip = (name, category, offset, yen, twd, payment, juliaPaid = true, ledger = SAMPLE_TOKYO.id) => ({
    ...e(name, category, offset, twd, juliaPaid), ledger_id: ledger, currency: 'JPY',
    orig_amount_cents: yen * 100, orig_julia_paid_cents: juliaPaid ? yen * 100 : 0, orig_erik_paid_cents: juliaPaid ? 0 : yen * 100,
    orig_julia_share_cents: yen * 50, orig_erik_share_cents: yen * 50, payment_method: payment, twd_estimated: payment !== 'cash',
  });
  const osaka = (name, category, offset, yen, twd) => ({ ...trip(name, category, offset, yen, twd, 'card', true, SAMPLE_OSAKA.id), twd_estimated: false });
  return [
    e('晚餐', 'dining', 0, 143400), e('PX', 'grocery', 1, 54500), e('咖啡', 'dining', 3, 54000, false),
    e('飲料', 'dining', 3, 11500), e('網路', 'bill', 5, 79900), e('家用品', 'grocery', 6, 137000),
    e('Taxi', 'transport', 9, 42500, false, 42500), e('電影', 'entertainment', 12, 61000),
    trip('拉麵', 'dining', 1, 2400, 51000, 'cash'), trip('Suica', 'transport', 1, 680, 14500, 'suica'),
    trip('藥妝', 'shopping', 2, 5980, 127100, 'card', false),
    osaka('燒肉', 'dining', 160, 4600, 98000), osaka('環球影城', 'entertainment', 161, 9800, 210000),
    { ...e('結清', 'transfer', 150, 154000, false, 154000), kind: 'settlement', ledger_id: SAMPLE_OSAKA.id,
      erik_share_cents: 0, julia_paid_cents: 0, erik_paid_cents: 154000, julia_share_cents: 154000 },
  ];
}

const SAMPLE_TOKYO = { id: 'sample-tokyo', name: '東京', purpose: 'trip', currency: 'JPY', cash_rate: 0.2125, card_rate: null, archived_at: null };
const SAMPLE_OSAKA = { id: 'sample-osaka', name: '2025大阪', purpose: 'trip', currency: 'JPY', cash_rate: 0.2241, card_rate: null, archived_at: '2025-08-16T04:00:00Z' };

if (sample) {
  state.me = 'erik';
  state.email = 'erik@example.com';
  setLedgers([HOUSEHOLD_FALLBACK, SAMPLE_OSAKA, SAMPLE_TOKYO]);
  state.allEntries = sampleEntries();
  await loadMarket();
  pickLedger();
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

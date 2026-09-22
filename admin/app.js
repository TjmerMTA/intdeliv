// IntDeliv admin — vanilla ES module, без збірки. Контракт моста: _bmad-output/specs/SPEC.md
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => (v == null ? '' : String(v)).replace(/[&<>"']/g, (c) => ESC[c]);
const nf = new Intl.NumberFormat('uk-UA');
const fmtN = (n) => (n == null || n === '' || isNaN(n) ? '' : nf.format(n));
const CUR = { UAH: '₴', USD: '$', EUR: '€' };
const PAGE = 300;

// Сервер (Cloudflare Worker): POST {API}/api/rpc {method, params} → {ok, result|error}
const DEFAULT_API = 'https://intdeliv.REPLACE.workers.dev';
const LS = {
get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* приватний режим */ } },
};
const cleanApi = (u) => String(u || '').trim().replace(/\/+$/, '');
const urlApi = cleanApi(new URLSearchParams(location.search).get('api'));
if (/^https?:\/\//.test(urlApi)) LS.set('intdeliv.api', urlApi);
const apiBase = () => cleanApi(LS.get('intdeliv.api')) || DEFAULT_API;
let demo = null; // демо-бекенд (лише через «Подивитись демо»)
let authed = false;
class AuthError extends Error {}

async function rpc(method, params = {}, key = LS.get('intdeliv.key'), timeout = 20000) {
const ac = new AbortController();
const t = setTimeout(() => ac.abort(), timeout);
let r;
try {
r = await fetch(apiBase() + '/api/rpc', {
method: 'POST', signal: ac.signal,
headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
body: JSON.stringify({ method, params }),
});
} catch (e) {
setNet(false);
throw new Error(e.name === 'AbortError' ? 'Сервер не відповідає (' + method + ')' : 'Немає зв\'язку з сервером');
} finally { clearTimeout(t); }
setNet(true);
if (r.status === 401) throw new AuthError('Невірний ключ доступу');
const d = await r.json().catch(() => null);
if (!d) throw new Error('Помилка сервера (' + r.status + ')');
if (!d.ok) throw new Error(d.error || 'Помилка сервера');
return d.result;
}
async function call(method, params) {
if (demo) return demo.call(method, params);
try { return await rpc(method, params); } catch (e) { if (e instanceof AuthError) showLogin(e.message); throw e; }
}
let netOk = null;
function setNet(ok) {
if (netOk === ok) return;
netOk = ok;
const el = $('#net');
el.className = 'net' + (ok ? ' on' : ' off');
$('span', el).textContent = ok ? 'онлайн' : 'немає зв\'язку';
}

// Стан
const S = {
view: 'loads', tab: 'all', f: { fromCity: '', toCity: '', fromRegion: '', toRegion: '', q: '' },
items: [], filtered: [], shown: PAGE, status: null, settings: null, version: '',
};
const TABS = [
['all', 'Усі', (c) => sum(c, ['new', 'queued', 'published', 'needs_review', 'error', 'inactive'])],
['active', 'Активні', (c) => sum(c, ['new', 'queued', 'published', 'needs_review', 'error'])],
['published', 'Опубліковані', (c) => sum(c, ['published'])],
['needs_review', 'Перевірити', (c) => sum(c, ['needs_review'])],
['inactive', 'Неактуальні', (c) => sum(c, ['inactive', 'deleted'])],
];
const TAB_MATCH = {
all: (s) => s !== 'deleted',
active: (s) => !['inactive', 'deleted'].includes(s),
published: (s) => s === 'published',
needs_review: (s) => s === 'needs_review',
inactive: (s) => s === 'inactive' || s === 'deleted',
};
function sum(c, keys) { return keys.reduce((a, k) => a + (c?.[k] || 0), 0); }
const isOff = (l) => l.status === 'inactive' || l.status === 'deleted';

// Утиліти UI
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
let toastT;
function toast(msg, err) {
const el = $('#toast');
el.textContent = msg; el.className = 'toast' + (err ? ' err' : ''); el.hidden = false;
clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), err ? 5000 : 2500);
}
function rel(ts) {
if (!ts) return 'ще не було';
const s = Math.round((Date.now() - ts) / 1000);
if (s < 10) return 'щойно';
if (s < 60) return s + ' с тому';
if (s < 3600) return Math.floor(s / 60) + ' хв тому';
if (s < 86400) return Math.floor(s / 3600) + ' год тому';
return Math.floor(s / 86400) + ' дн тому';
}
function fmtDate(d) { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ''); return m ? m[3] + '.' + m[2] : esc(d); }
const hhmm = (ts) => new Date(ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

const modal = {
open(html, onMount) { $('#m-body').innerHTML = html; $('#modal').hidden = false; onMount && onMount($('#m-body')); },
close() { $('#modal').hidden = true; $('#m-body').innerHTML = ''; },
};
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') modal.close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) modal.close(); });

function confirmBox(title, text, okLabel = 'Видалити') {
return new Promise((resolve) => {
modal.open(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="m-foot"><button class="btn" data-x="0">Скасувати</button><button class="btn dan" data-x="1">${esc(okLabel)}</button></div>`,
(b) => {
b.addEventListener('click', (e) => { const x = e.target.closest('[data-x]'); if (!x) return; modal.close(); resolve(x.dataset.x === '1'); });
$('[data-x="1"]', b).focus();
});
});
}

// Банери
function renderBanners() {
let h = '';
if (demo) h += `<div class="banner warn"><span class="tag-demo">ДЕМО</span>Показано демонстраційні дані — дії нічого не змінюють. <a href="#" data-logout>Вийти з демо</a></div>`;
if (S.settings?.lardi?.dryRun) h += `<div class="banner info">🧪 <b>Тестовий режим — нічого не публікується.</b> Заявки проходять усі перевірки, але на Lardi не відправляються. Вимкніть перемикач «Тестовий режим», коли будете готові.</div>`;
if (S.status?.lastError) h += `<div class="banner warn">Остання помилка: ${esc(S.status.lastError)}</div>`;
$('#banners').innerHTML = h;
}

// KPI
function accName(i) { return S.settings?.lardi?.accounts?.[i]?.name || 'Акаунт ' + (i + 1); }
function renderKpis() {
const st = S.status;
if (!st) return;
$('#k-col').textContent = fmtN(st.today?.collected ?? 0);
const pub = st.today?.published || [];
$('#k-pub').innerHTML = pub.length ? pub.map((n, i) => `<span title="${esc(accName(i))}">${esc(fmtN(n))}</span>`).join(' <span class="muted">/</span> ') : '0';
$('#k-pub').title = pub.map((n, i) => accName(i) + ': ' + n).join(', ');
$('#k-q').textContent = fmtN(st.queue ?? 0);
$('#k-sync').textContent = rel(st.lastPollAt);
const r = $('#k-run');
r.classList.toggle('on', !!st.running);
$('span', r).textContent = st.running ? 'Збір працює' : 'Зупинено';
renderTabs();
renderBanners();
}
setInterval(() => { if (S.status) $('#k-sync').textContent = rel(S.status.lastPollAt); }, 15000);

function renderTabs() {
const c = S.status?.counts;
$('#tabs').innerHTML = TABS.map(([k, label, cnt]) =>
`<button class="tab${S.tab === k ? ' on' : ''}" role="tab" data-tab="${k}">${label}${c ? `<span class="n">${fmtN(cnt(c))}</span>` : ''}</button>`).join('');
}

// Таблиця заявок
const svg = (d) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;
const ICON = {
edit: svg('M4 20h4L19 9l-4-4L4 16z'),
pub: svg('M12 19V5M5 12l7-7 7 7'),
unpub: svg('M12 5v14M5 12l7 7 7-7'),
del: svg('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'),
link: svg('M14 4h6v6M20 4l-9 9M18 14v6H4V6h6'),
};
const CHIP = {
published: ['c-ok', 'Опубліковано'], queued: ['c-info', 'У черзі'], dry: ['c-info', 'Тест'], new: ['c-off', 'Нова'],
needs_review: ['c-warn', 'Перевірити'], error: ['c-err', 'Помилка'], inactive: ['c-off', 'Неактуальна'],
deleted: ['c-off', 'Видалена'], removed: ['c-off', 'Знято'],
};
function chip(status, prefix, title) {
const [cls, txt] = CHIP[status] || ['c-off', status || '—'];
return `<span class="chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${prefix ? esc(prefix) + ': ' : ''}${esc(txt)}</span>`;
}
function lardiCell(l) {
let h = '';
if (l.status === 'needs_review' || l.status === 'error' || isOff(l)) h += chip(l.status, '', l.statusReason);
for (const a of l.lardi || []) {
const title = [a.id ? 'Lardi ID ' + a.id : '', a.error || ''].filter(Boolean).join(' · ');
h += chip(a.status || (a.error ? 'error' : a.id ? 'published' : 'queued'), accName(a.account), title);
}
if (!h) h = chip(l.status, '', l.statusReason);
return h;
}
function rowHtml(l) {
const off = isOff(l);
const cur = CUR[l.currency] || l.currency || '';
const dist = l.distanceKm ? ` · ${fmtN(l.distanceKm)} км` : '';
const ppk = l.pricePerKm || (l.price && l.distanceKm ? Math.round(l.price / l.distanceKm) : 0);
const tags = (l.tags || []).slice(0, 4).map((t) => `<span class="tg">${esc(t)}</span>`).join('');
const canPub = !off && l.status !== 'published' && l.status !== 'queued';
const canUnpub = (l.lardi || []).some((a) => a.id && a.status !== 'removed') || l.status === 'published';
return `<tr class="${off ? 'off' : ''}" data-id="${esc(l.id)}">
<td data-l="Дата"><div class="d1">${off ? '🚫 ' : ''}${fmtDate(l.dateFrom)}${l.dateTo && l.dateTo !== l.dateFrom ? '–' + fmtDate(l.dateTo) : ''}</div><div class="sub">${esc(l.firstSeenAt ? hhmm(l.firstSeenAt) : '')}${l.edited ? ' · ✎' : ''}</div></td>
<td class="c-rt" data-l="Маршрут"><div class="rt"><span class="dot">•</span> ${esc(l.fromCity)} → <span class="dot">•</span> ${esc(l.toCity)}</div><div class="sub">${esc(l.fromRegion)} → ${esc(l.toRegion)}${dist}</div></td>
<td class="c-cg" data-l="Вантаж / авто"><div>${esc(l.cargo)}</div><div class="sub">${esc(l.body)}${l.directCustomer ? ' · прямий замовник' : ''}</div>${tags}</td>
<td class="num" data-l="Вага">${l.weight != null ? esc(fmtN(l.weight)) + ' т' : '—'}</td>
<td class="num" data-l="Об'єм">${l.volume != null ? esc(fmtN(l.volume)) + ' м³' : '—'}</td>
<td data-l="Ціна">${l.price ? `<div class="pr">${esc(fmtN(l.price))} ${esc(cur)}</div>${ppk ? `<div class="sub">${esc(fmtN(ppk))} ${esc(cur)}/км</div>` : ''}` : '<span class="muted">—</span>'}</td>
<td data-l="Оплата">${esc(l.payment || '—')}</td>
<td class="c-lr" data-l="Lardi">${lardiCell(l)}</td>
<td class="c-ac"><div class="acts">
<button class="ib" data-act="edit" title="Редагувати">${ICON.edit}</button>
${canPub ? `<button class="ib" data-act="publish" title="Опублікувати зараз">${ICON.pub}</button>` : ''}
${canUnpub ? `<button class="ib" data-act="unpublish" title="Зняти з Lardi">${ICON.unpub}</button>` : ''}
${/^https?:\/\//.test(l.dellaUrl || '') ? `<a class="ib" href="${esc(l.dellaUrl)}" target="_blank" rel="noopener noreferrer" title="Відкрити на Della">${ICON.link}</a>` : ''}
<button class="ib red" data-act="delete" title="Видалити">${ICON.del}</button>
</div></td></tr>`;
}

const norm = (s) => (s == null ? '' : String(s)).toLowerCase().replace(/[’'`ʼ]/g, "'").trim();
function applyFilters() {
const f = Object.fromEntries(Object.entries(S.f).map(([k, v]) => [k, norm(v)]));
const qd = f.q.replace(/\D/g, '');
const m = TAB_MATCH[S.tab];
S.filtered = S.items.filter((l) => {
if (!m(l.status)) return false;
if (f.fromCity && !norm(l.fromCity).includes(f.fromCity)) return false;
if (f.toCity && !norm(l.toCity).includes(f.toCity)) return false;
if (f.fromRegion && !norm(l.fromRegion).includes(f.fromRegion)) return false;
if (f.toRegion && !norm(l.toRegion).includes(f.toRegion)) return false;
if (f.q) {
const ph = String(l.phone || '').replace(/\D/g, '');
const hit = norm(l.id).includes(f.q) || (qd.length >= 3 && ph.includes(qd)) || norm(l.company).includes(f.q) ||
(l.lardi || []).some((a) => a.id && String(a.id).includes(f.q));
if (!hit) return false;
}
return true;
});
}
function renderRows() {
const list = S.filtered;
const n = Math.min(S.shown, list.length);
let h = '';
for (let i = 0; i < n; i++) h += rowHtml(list[i]);
$('#rows').innerHTML = h;
$('#empty').hidden = list.length > 0;
$('#more').hidden = n >= list.length;
$('#shown').textContent = list.length ? `Показано ${fmtN(n)} з ${fmtN(list.length)}` : '';
}
function appendRows() {
const from = S.shown;
S.shown += PAGE;
const to = Math.min(S.shown, S.filtered.length);
let h = '';
for (let i = from; i < to; i++) h += rowHtml(S.filtered[i]);
$('#rows').insertAdjacentHTML('beforeend', h);
$('#more').hidden = to >= S.filtered.length;
$('#shown').textContent = `Показано ${fmtN(to)} з ${fmtN(S.filtered.length)}`;
}

let loadSeq = 0;
async function loadLoads() {
const my = ++loadSeq;
const p = { limit: 5000, offset: 0 };
for (const k in S.f) if (S.f[k].trim()) p[k] = S.f[k].trim();
if (S.tab === 'published' || S.tab === 'needs_review') p.status = S.tab;
try {
const r = await call('loads.list', p);
if (my !== loadSeq) return;
S.items = r?.items || [];
} catch (e) { toast(e.message, true); }
applyFilters();
renderRows();
}
const loadLoadsSoon = debounce(loadLoads, 150);

async function loadStatus() { try { S.status = await call('status.get'); renderKpis(); } catch (e) { /* тихо */ } }
async function loadSettings() { try { S.settings = await call('settings.get'); $('#dry').checked = !!S.settings?.lardi?.dryRun; renderBanners(); } catch (e) { toast(e.message, true); } }

$$('.filters input').forEach((inp) => inp.addEventListener('input', () => {
S.f[inp.dataset.f] = inp.value; S.shown = PAGE;
applyFilters(); renderRows();   // миттєво локально
loadLoadsSoon();                // і на сервері (дебаунс 150 мс)
}));
$('#tabs').addEventListener('click', (e) => {
const b = e.target.closest('[data-tab]'); if (!b) return;
S.tab = b.dataset.tab; S.shown = PAGE; renderTabs(); applyFilters(); renderRows(); loadLoads();
});
$('#more').addEventListener('click', appendRows);

const byId = (id) => S.items.find((l) => l.id === id);
function replaceLoad(l) {
if (!l || !l.id) return;
const i = S.items.findIndex((x) => x.id === l.id);
if (i >= 0) S.items[i] = l; else S.items.unshift(l);
applyFilters(); renderRows();
}
$('#rows').addEventListener('click', async (e) => {
const b = e.target.closest('[data-act]'); if (!b) return;
const id = b.closest('tr').dataset.id;
const l = byId(id); if (!l) return;
const act = b.dataset.act;
try {
if (act === 'edit') return editLoad(l);
if (act === 'publish') { b.disabled = true; replaceLoad(await call('loads.publish', { id })); toast('Поставлено в чергу на публікацію'); }
if (act === 'unpublish') { b.disabled = true; replaceLoad(await call('loads.unpublish', { id })); toast('Знято з Lardi'); }
if (act === 'delete') {
if (!(await confirmBox('Видалити заявку?', `${l.fromCity} → ${l.toCity}, ${l.cargo}. Якщо вона опублікована — буде знята з Lardi.`))) return;
await call('loads.delete', { id, fromLardi: true });
S.items = S.items.filter((x) => x.id !== id); applyFilters(); renderRows(); toast('Видалено');
}
loadStatus(); loadLoads();
} catch (err) { toast(err.message, true); b.disabled = false; }
});

// Редагування
const EDIT_FIELDS = [
['dateFrom', 'Дата від', 'date'], ['dateTo', 'Дата до', 'date'],
['fromCity', 'Із міста'], ['fromRegion', 'Із області'], ['toCity', 'До міста'], ['toRegion', 'До області'],
['distanceKm', 'Відстань, км', 'number'], ['cargo', 'Вантаж'], ['body', 'Тип кузова'],
['weight', 'Вага, т', 'number'], ['volume', "Об'єм, м³", 'number'], ['price', 'Ціна', 'number'],
['currency', 'Валюта', ['UAH', 'USD', 'EUR']], ['payment', 'Оплата'], ['company', 'Компанія'], ['phone', 'Телефон'],
['status', 'Статус', ['new', 'queued', 'published', 'needs_review', 'error', 'inactive']],
];
function editLoad(l) {
const f = EDIT_FIELDS.map(([k, label, type]) => {
const v = l[k] ?? '';
const input = Array.isArray(type)
? `<select name="${k}">${type.map((o) => `<option value="${o}"${o === v ? ' selected' : ''}>${esc(CHIP[o]?.[1] || o)}</option>`).join('')}</select>`
: `<input name="${k}" type="${type || 'text'}"${type === 'number' ? ' step="any" min="0"' : ''} value="${esc(v)}">`;
return `<label class="fld">${esc(label)}${input}</label>`;
}).join('');
modal.open(`<h3>Редагувати заявку</h3><form id="ef"><div class="grid">${f}
<label class="fld wide">Мітки (через кому)<input name="tags" value="${esc((l.tags || []).join(', '))}"></label></div>
<div class="m-foot"><button type="button" class="btn" data-close>Скасувати</button><button class="btn pri">Зберегти</button></div></form>`, (b) => {
$('[data-close]', b).onclick = modal.close;
$('#ef', b).onsubmit = async (e) => {
e.preventDefault();
const fd = new FormData(e.target); const patch = { edited: true };
for (const [k, , type] of EDIT_FIELDS) {
let v = String(fd.get(k) ?? '').trim();
if (type === 'number') v = v === '' ? null : Number(v.replace(',', '.'));
if (String(l[k] ?? '') !== String(v ?? '')) patch[k] = v;
}
const tags = String(fd.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (tags.join('|') !== (l.tags || []).join('|')) patch.tags = tags;
if ('price' in patch || 'distanceKm' in patch) {
const p = patch.price ?? l.price, d = patch.distanceKm ?? l.distanceKm;
patch.pricePerKm = p && d ? Math.round((p / d) * 100) / 100 : null;
}
const btn = $('.btn.pri', b); btn.disabled = true;
try { replaceLoad(await call('loads.update', { id: l.id, patch })); modal.close(); toast('Збережено'); loadLoads(); loadStatus(); }
catch (err) { toast(err.message, true); btn.disabled = false; }
};
});
}

// KPI дії
$('#sync').addEventListener('click', async (e) => {
e.target.disabled = true;
try { await call('sync.now'); toast('Синхронізацію запущено'); setTimeout(() => { loadStatus(); loadLoads(); }, 1500); }
catch (err) { toast(err.message, true); }
setTimeout(() => (e.target.disabled = false), 3000);
});
$('#dry').addEventListener('change', async (e) => {
const want = e.target.checked;
try {
S.settings = await call('settings.set', { lardi: { ...(S.settings?.lardi || {}), dryRun: want } });
toast(want ? 'Тестовий режим увімкнено' : 'Тестовий режим вимкнено — заявки публікуються на Lardi');
} catch (err) { toast(err.message, true); e.target.checked = !want; }
renderBanners(); if (S.view === 'settings') renderSettings(); loadStatus();
});

// Налаштування
const lines = (a) => (a || []).join('\n');
const list = (a) => (a || []).join(', ');
function renderSettings() {
const s = S.settings || {};
const d = s.della || {}, f = s.filters || {}, L = s.lardi || {};
const accs = (L.accounts && L.accounts.length ? L.accounts : [{}, {}]).slice(0, 2);
while (accs.length < 2) accs.push({});
const num = (name, label, v, extra = '') => `<label class="fld">${label}<input name="${name}" type="number" min="0" value="${esc(v ?? '')}" ${extra}></label>`;
const txt = (name, label, v, ph = '') => `<label class="fld">${label}<input name="${name}" value="${esc(v ?? '')}" placeholder="${esc(ph)}"></label>`;
const chk = (name, label, v) => `<label class="chk"><input type="checkbox" name="${name}"${v ? ' checked' : ''}> ${label}</label>`;
$('#sf').innerHTML = `
<div class="card"><h3>Сервер</h3><p class="help">Система працює на сервері цілодобово, 24/7, сама по собі: збирає заявки з Della й публікує їх на Lardi, навіть коли цю сторінку закрито, а комп'ютер вимкнено. Ця панель лише показує дані та змінює налаштування.${S.version ? ' Версія: ' + esc(S.version) + '.' : ''}</p>
<div class="grid"><label class="fld wide">Адреса сервера<input name="api" value="${esc(demo ? '' : apiBase())}" placeholder="${esc(DEFAULT_API)}"${demo ? ' disabled' : ''}></label></div></div>

<div class="card"><h3>Della — звідки брати заявки</h3>
<p class="help">Зробіть пошук на <a href="https://della.com.ua/" target="_blank" rel="noopener">della.com.ua</a> з потрібними фільтрами (країна, області, «прямий замовник», «з вартістю»), натисніть «Знайти» і скопіюйте адресу сторінки з рядка браузера. Одна адреса — один рядок. Якщо порожньо — береться вся Україна, прямий замовник, з вартістю.</p>
<div class="grid"><label class="fld wide">Посилання на пошук Della<textarea name="searchUrls" placeholder="https://della.com.ua/search/a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m1.html">${esc(lines(d.searchUrls))}</textarea></label>
${num('pollSeconds', 'Опитувати кожні, с', d.pollSeconds, 'min="30"')}${num('pagesPerPoll', 'Сторінок за раз (по 25)', d.pagesPerPoll, 'min="1" max="40"')}</div></div>

<div class="card"><h3>Фільтри</h3><p class="help">Списки — через кому. Області пишіть як на Della, напр. «Київська обл.». Порожнє поле — без обмежень.</p>
<div class="grid">${num('minPrice', 'Мінімальна ціна, грн', f.minPrice ?? 8000)}${num('maxAgeHours', 'Не старші ніж, год', f.maxAgeHours)}
${txt('bodies', 'Типи кузова', list(f.bodies), 'тент, рефрижератор')}${txt('stopWords', 'Стоп-слова у вантажі', list(f.stopWords), 'металобрухт, наливом')}
${txt('fromRegions', 'Лише з областей', list(f.fromRegions))}${txt('toRegions', 'Лише до областей', list(f.toRegions))}
${txt('excludeRegions', 'Виключити області', list(f.excludeRegions))}
<div class="fld" style="justify-content:flex-end">${chk('directOnly', 'Лише прямий замовник', f.directOnly)}</div></div></div>

<div class="card"><h3>Lardi — куди публікувати</h3>
<p class="help">Токен API: увійдіть на <a href="https://lardi-trans.com/" target="_blank" rel="noopener">lardi-trans.com</a> → <b>Налаштування → API</b> → створіть/скопіюйте ключ і вставте сюди. Для кожного акаунта свій токен. Збережений токен показано як <code>••••1234</code> — щоб не змінювати, залиште як є.</p>
${accs.map((a, i) => `<div class="acc" data-acc="${i}">
${txt('acc' + i + 'name', 'Назва акаунта ' + (i + 1), a.name, 'Акаунт ' + (i + 1))}
<label class="fld">Токен API${a.token ? ' · збережено ' + esc(a.token) : ''}<input name="acc${i}token" type="password" autocomplete="new-password" value="${esc(a.token || '')}"></label>
${chk('acc' + i + 'enabled', 'Увімкнено', a.enabled)}
<button type="button" class="btn" data-test="${i}">Перевірити</button><div class="res muted" id="res${i}"></div></div>`).join('')}
<div class="grid" style="margin-top:12px">
<label class="fld">Режим<select name="mode"><option value="both"${L.mode !== 'roundrobin' ? ' selected' : ''}>На обидва акаунти</option><option value="roundrobin"${L.mode === 'roundrobin' ? ' selected' : ''}>По черзі (roundrobin)</option></select></label>
${num('intervalSeconds', 'Пауза між публікаціями, с', L.intervalSeconds)}${num('dailyLimit', 'Ліміт на акаунт за добу', L.dailyLimit ?? 500)}
${txt('note', 'Примітка до заявки', L.note)}
<div class="fld" style="justify-content:flex-end;gap:8px">${chk('autoPublish', 'Автопублікація', L.autoPublish)}${chk('dryRun', 'Тестовий режим (нічого не публікується)', L.dryRun)}</div></div></div>

<div class="card"><h3>Актуальність</h3><p class="help">Заявка стає неактуальною, якщо дата завантаження минула або її не видно на Della довше за вказаний час — тоді її знято з Lardi.</p>
<div class="grid">${num('staleHours', 'Неактуальна після, год', s.staleHours ?? 6)}</div></div>

<div class="save-bar"><button class="btn pri">Зберегти налаштування</button><span class="muted" id="sf-st"></span></div>`;
}
const splitList = (v) => String(v || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
const numOr = (v, d) => (String(v).trim() === '' || isNaN(Number(v)) ? d : Number(v));
$('#sf').addEventListener('submit', async (e) => {
e.preventDefault();
const fd = new FormData(e.target); const g = (k) => fd.get(k); const on = (k) => fd.get(k) === 'on';
const old = S.settings || {};
const patch = {
della: { searchUrls: String(g('searchUrls') || '').split('\n').map((s) => s.trim()).filter(Boolean),
pollSeconds: numOr(g('pollSeconds'), old.della?.pollSeconds ?? 90), pagesPerPoll: numOr(g('pagesPerPoll'), old.della?.pagesPerPoll ?? 4) },
filters: { minPrice: numOr(g('minPrice'), 8000), directOnly: on('directOnly'), bodies: splitList(g('bodies')),
fromRegions: splitList(g('fromRegions')), toRegions: splitList(g('toRegions')), excludeRegions: splitList(g('excludeRegions')),
stopWords: splitList(g('stopWords')), maxAgeHours: numOr(g('maxAgeHours'), old.filters?.maxAgeHours ?? 24) },
lardi: { accounts: [0, 1].map((i) => ({ name: String(g('acc' + i + 'name') || '').trim(), token: String(g('acc' + i + 'token') || '').trim(), enabled: on('acc' + i + 'enabled') })),
mode: g('mode') === 'roundrobin' ? 'roundrobin' : 'both', autoPublish: on('autoPublish'), dryRun: on('dryRun'),
intervalSeconds: numOr(g('intervalSeconds'), old.lardi?.intervalSeconds ?? 20), dailyLimit: numOr(g('dailyLimit'), 500), note: String(g('note') || '') },
staleHours: numOr(g('staleHours'), 6),
};
const api = cleanApi(g('api'));
if (!demo && api && api !== apiBase()) { LS.set('intdeliv.api', api); netOk = null; }
const btn = $('.save-bar .btn', e.target); btn.disabled = true;
try {
S.settings = await call('settings.set', patch);
$('#dry').checked = !!S.settings?.lardi?.dryRun;
renderSettings(); renderBanners(); renderKpis(); toast('Налаштування збережено'); loadStatus();
} catch (err) { toast(err.message, true); btn.disabled = false; }
});
$('#sf').addEventListener('click', async (e) => {
const b = e.target.closest('[data-test]'); if (!b) return;
const i = Number(b.dataset.test); const res = $('#res' + i);
b.disabled = true; res.className = 'res muted'; res.textContent = 'Перевіряю… (спочатку збережіть новий токен)';
try {
const r = await call('lardi.test', { accountIndex: i });
res.className = 'res ' + (r?.ok ? 'c-ok' : 'c-err');
res.textContent = r?.ok ? '✓ Токен працює' + (r.name ? ': ' + r.name : '') : '✗ ' + (r?.error || 'Помилка');
} catch (err) { res.className = 'res c-err'; res.textContent = '✗ ' + err.message; }
b.disabled = false;
});

// Журнал
async function loadLog() {
try {
const items = (await call('log.list', { limit: 200 })) || [];
$('#log').innerHTML = items.length ? items.map((x) => `<div class="${esc(x.level)}"><time>${esc(new Date(x.t).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</time><span>${esc(x.msg)}</span></div>`).join('')
: '<div class="muted">Журнал порожній</div>';
} catch (e) { $('#log').innerHTML = `<div class="error">${esc(e.message)}</div>`; }
}
setInterval(() => { if (S.view === 'log' && !document.hidden) loadLog(); }, 5000);

// Навігація
function go(view) {
S.view = view;
$$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
$$('.view').forEach((v) => (v.hidden = v.id !== 'v-' + view));
if (view === 'loads') loadLoads();
if (view === 'settings') { renderSettings(); loadSettings().then(renderSettings); }
if (view === 'log') loadLog();
if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
}
$$('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

// Вхід / вихід
function showLogin(msg) {
authed = false; demo = null;
document.body.classList.add('locked');
$('#login').hidden = false; modal.close();
$('#l-err').textContent = msg || '';
$('#l-api').value = LS.get('intdeliv.api');
$('#l-key').focus();
}
$('#lf').addEventListener('submit', async (e) => {
e.preventDefault();
const key = $('#l-key').value.trim(), api = cleanApi($('#l-api').value);
if (!key) return;
if (api && !/^https?:\/\//.test(api)) { $('#l-err').textContent = 'Адреса має починатися з https://'; return; }
LS.set('intdeliv.api', api);
const btn = $('#lf .btn'); btn.disabled = true; $('#l-err').textContent = '';
try {
const r = await rpc('ping', {}, key);
if (r && r.authed === false) throw new AuthError('Невірний ключ доступу');
LS.set('intdeliv.key', key); $('#l-key').value = '';
start(r);
} catch (err) { $('#l-err').textContent = err.message; }
btn.disabled = false;
});
$('#l-demo').addEventListener('click', async (e) => { e.preventDefault(); demo = await makeDemo(); start({ version: 'demo' }); });
document.addEventListener('click', (e) => {
if (!e.target.closest('[data-logout]')) return;
e.preventDefault();
if (!demo) LS.set('intdeliv.key', '');
showLogin();
});

// Старт
function start(ping) {
authed = true;
S.version = ping?.version || '';
S.items = []; S.status = null; S.settings = null;
document.body.classList.remove('locked');
$('#login').hidden = true;
if (demo) { const n = $('#net'); n.className = 'net'; $('span', n).textContent = 'демо'; netOk = null; }
boot();
}
async function boot() {
renderTabs(); renderBanners();
await Promise.all([loadSettings(), loadStatus()]);
go(['settings', 'log'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'loads');
}
// Опитування замість пушів
const visible = () => document.visibilityState === 'visible';
setInterval(() => { if (authed) loadStatus(); }, 10000);
setInterval(() => { if (authed && visible() && S.view === 'loads' && $('#modal').hidden) loadLoads(); }, 20000);
document.addEventListener('visibilitychange', () => { if (authed && visible()) { loadStatus(); if (S.view === 'loads') loadLoads(); } });

(async () => {
renderTabs();
if (new URLSearchParams(location.search).has('demo')) { demo = await makeDemo(); return start({ version: 'demo' }); }
if (!LS.get('intdeliv.key')) return showLogin();
try {
const r = await rpc('ping');
if (r && r.authed === false) return showLogin('Ключ більше не дійсний — увійдіть знову');
start(r);
} catch (e) {
if (e instanceof AuthError) return showLogin(e.message);
start(null); // сервер тимчасово недоступний — показуємо інтерфейс, опитування підхопить
}
})();

// Демо-бекенд
async function makeDemo() {
const now = Date.now(), H = 3600e3;
const day = (d) => new Date(now + d * 86400e3).toISOString().slice(0, 10);
const R = [
['Полтава', 'Полтавська обл.', 'Харків', 'Харківська обл.', 143, 'запчастини на палетах', 'тент', 6.9, 30, 23000, 'Безнал', 'published', [['published', 51234001], ['published', 51234002]]],
['Київ', 'Київська обл.', 'Львів', 'Львівська обл.', 540, 'побутова техніка', 'тент', 10, 82, 32000, 'Безнал', 'queued', [['queued'], ['queued']]],
['Вінниця', 'Вінницька обл.', 'Одеса', 'Одеська обл.', 425, 'заморожена риба', 'рефрижератор', 20, 86, 38500, 'Безнал', 'published', [['published', 51233870], ['error', null, '429: забагато запитів']]],
['Рівне', 'Рівненська обл.', 'Дніпро', 'Дніпропетровська обл.', 920, 'будматеріали', 'тент', 22, 90, 45000, 'Картка', 'needs_review', []],
['Черкаси', 'Черкаська обл.', 'Київ', 'Київська обл.', 190, 'зерно в біг-бегах', 'зерновоз', 24, 0, 14000, 'Готівка', 'queued', [['dry'], ['dry']]],
['Житомир', 'Житомирська обл.', 'Тернопіль', 'Тернопільська обл.', 285, 'меблі', 'цільномет', 3, 20, 9500, 'Безнал', 'new', []],
['Запоріжжя', 'Запорізька обл.', 'Кривий Ріг', 'Дніпропетровська обл.', 200, 'металопрокат', 'відкрита', 20, 0, 16000, 'Безнал', 'inactive', [['removed', 51230011]]],
['Луцьк', 'Волинська обл.', 'Ужгород', 'Закарпатська обл.', 390, 'продукти харчування', 'рефрижератор', 8, 45, 21000, 'Безнал', 'published', [['published', 51233500]]],
['Суми', 'Сумська обл.', 'Чернігів', 'Чернігівська обл.', 290, 'картопля', 'тент', 15, 60, 12500, 'Готівка', 'error', [['error', null, 'Не знайдено місто на Lardi'], ['error', null, 'Не знайдено місто на Lardi']]],
['Хмельницький', 'Хмельницька обл.', 'Київ', 'Київська обл.', 330, 'текстиль у коробках', 'тент', 5, 40, 13800, 'Картка', 'published', [['published', 51233111], ['published', 51233112]]],
['Миколаїв', 'Миколаївська обл.', 'Херсон', 'Херсонська обл.', 70, 'будівельні суміші', 'тент', 12, 0, 8200, 'Готівка', 'deleted', []],
['Івано-Франківськ', 'Івано-Франківська обл.', 'Біла Церква', 'Київська обл.', 520, 'пиломатеріали', 'відкрита', 21, 80, 29000, 'Безнал', 'needs_review', []],
['Кропивницький', 'Кіровоградська обл.', 'Умань', 'Черкаська обл.', 165, 'соняшникова олія в тарі', 'тент', 18, 50, 11500, 'Безнал', 'inactive', []],
['Одеса', 'Одеська обл.', 'Чернівці', 'Чернівецька обл.', 510, 'ПЕТ-преформи', 'тент', 7.5, 86, 27500, 'Безнал', 'queued', [['queued']]],
['Кременчук', 'Полтавська обл.', 'Бориспіль', 'Київська обл.', 280, 'кондитерські вироби', 'рефрижератор', 4.2, 33, 15500, 'Картка', 'published', [['published', 51232991], ['dry']]],
];
const TAGS = [['Довантаження'], ['Кільк. палет: 8'], ['ADR'], []];
let items = R.map((r, i) => {
const [fromCity, fromRegion, toCity, toRegion, distanceKm, cargo, body, weight, volume, price, payment, status, lardi] = r;
const seen = now - i * 0.7 * H;
return { id: 'd_' + (0x5f3a91c + i * 7919).toString(16) + 'e2', source: 'della',
dateFrom: status === 'inactive' ? day(-2) : day(i % 3), fromCity, fromRegion, toCity, toRegion, distanceKm, cargo, body, weight,
volume: volume || undefined, price, pricePerKm: Math.round(price / distanceKm), currency: 'UAH', payment, tags: TAGS[i % 4],
directCustomer: i % 4 !== 3, phone: '+38067' + String(1234567 + i * 1111).slice(0, 7), dellaUrl: 'https://della.com.ua/', status, statusReason: status === 'needs_review' ? 'Не вдалося зіставити місто або кузов з Lardi' : status === 'inactive' ? 'Дата завантаження минула' : '',
lardi: lardi.map(([st, id, err], a) => ({ account: a, status: st, id: id || undefined, error: err })),
seenAt: seen, firstSeenAt: seen - H, updatedAt: seen };
});
let settings = { della: { searchUrls: ['https://della.com.ua/search/a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m1.html'], pollSeconds: 90, pagesPerPoll: 4 },
filters: { minPrice: 8000, directOnly: true, bodies: [], fromRegions: [], toRegions: [], excludeRegions: [], stopWords: ['металобрухт'], maxAgeHours: 24 },
lardi: { accounts: [{ name: 'Софія', token: '••••4821', enabled: true }, { name: 'Логістик-2', token: '••••0937', enabled: true }],
mode: 'both', autoPublish: true, dryRun: true, intervalSeconds: 20, dailyLimit: 500, note: '' }, staleHours: 6 };
const counts = () => items.reduce((c, l) => ((c[l.status] = (c[l.status] || 0) + 1), c), {});
const logs = [['info', 'Зібрано 25 заявок зі сторінки 1, нових: 3'], ['info', 'Опубліковано на Lardi (Софія): Полтава → Харків'], ['warn', 'needs_review: не знайдено кузов «цільномет» на Lardi'], ['error', 'Lardi 429 — повтор через 30 с']]
.map(([level, msg], i) => ({ t: now - i * 4 * 60e3, level, msg }));
const clone = (x) => JSON.parse(JSON.stringify(x));
const upd = (id, fn) => { const l = items.find((x) => x.id === id); if (!l) throw new Error('Заявку не знайдено'); fn(l); l.updatedAt = Date.now(); return clone(l); };
const api = {
ping: () => ({ version: 'demo', authed: true }),
'loads.list': (p) => { const r = items.filter((l) => !p.status || l.status === p.status); return { items: clone(r), total: r.length }; },
'loads.update': ({ id, patch }) => upd(id, (l) => Object.assign(l, patch)),
'loads.delete': ({ id }) => { items = items.filter((l) => l.id !== id); return { ok: true }; },
'loads.publish': ({ id }) => upd(id, (l) => { l.status = 'queued'; l.lardi = [0, 1].map((a) => ({ account: a, status: settings.lardi.dryRun ? 'dry' : 'queued' })); }),
'loads.unpublish': ({ id }) => upd(id, (l) => { l.status = 'inactive'; l.statusReason = 'Знято вручну'; l.lardi = l.lardi.map((a) => ({ ...a, status: 'removed' })); }),
'settings.get': () => clone(settings),
'settings.set': (p) => { for (const k in p) settings[k] = typeof p[k] === 'object' && !Array.isArray(p[k]) ? { ...settings[k], ...p[k] } : p[k]; return clone(settings); },
'status.get': () => ({ running: true, lastPollAt: now - 70e3, counts: counts(), today: { collected: 187, published: [142, 139] }, queue: items.filter((l) => l.status === 'queued').length }),
'sync.now': () => ({ started: true }),
'lardi.test': ({ accountIndex }) => ({ ok: true, name: settings.lardi.accounts[accountIndex]?.name || 'Демо' }),
'log.list': () => clone(logs),
};
return { call: async (m, p = {}) => { if (!api[m]) throw new Error('Невідомий метод ' + m); await new Promise((r) => setTimeout(r, 60)); return api[m](p); } };
}

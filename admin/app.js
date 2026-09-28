// IntDeliv admin — vanilla ES module, без збірки. Контракт моста: _bmad-output/specs/SPEC.md
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => (v == null ? '' : String(v)).replace(/[&<>"']/g, (c) => ESC[c]);
const nf = new Intl.NumberFormat('uk-UA');
const fmtN = (n) => (n == null || n === '' || isNaN(n) ? '' : nf.format(n));
const CUR = { UAH: '₴', USD: '$', EUR: '€' };
const PAGE = 300;

// Сервер (GitHub Actions + тунель): POST {API}/api/rpc {method, params} → {ok, result|error}
// Адреса тунелю змінюється при кожному перезапуску (~6 год) — беремо її з гілки data репозиторію.
// Спершу raw.githubusercontent.com (без ліміту, простий GET без preflight), api.github.com — лише запасний:
// він дає 60 запитів/год на IP, а за спільним IP провайдера (CGNAT) ліміт може вичерпати хтось інший.
const DISCOVERY = [
['https://raw.githubusercontent.com/TjmerMTA/intdeliv/data/api.json?t=', {}],
['https://api.github.com/repos/TjmerMTA/intdeliv/contents/api.json?ref=data&t=', { Accept: 'application/vnd.github.raw+json' }],
];
let DEFAULT_API = '';
let discoveredAt = 0;
let discoverWhy = ''; // '' — GitHub відповів; 'limit' — ліміт api.github.com; 'down' — GitHub недоступний
// fetch з таймаутом, що покриває і читання тіла (read) — інакше завислий потік тримає вхід без кінця
async function fetchT(url, opts = {}, ms = 8000, read = (r) => r) {
const ac = new AbortController();
const t = setTimeout(() => ac.abort(), ms);
try { return await read(await fetch(url, { ...opts, signal: ac.signal })); } finally { clearTimeout(t); }
}
async function discover(force = false) {
if (!force && DEFAULT_API) return DEFAULT_API;
if (Date.now() - discoveredAt < 30000 && DEFAULT_API) return DEFAULT_API;
discoveredAt = Date.now();
discoverWhy = 'down';
for (const [url, headers] of DISCOVERY) {
try {
const j = await fetchT(url + Date.now(), { headers, cache: 'no-store' }, 8000,
(r) => (r.headers.get('x-ratelimit-remaining') === '0' ? { limit: true } : r.json()));
if (j?.limit) { discoverWhy = 'limit'; continue; }
if (j && /^https:\/\//.test(j.url)) { DEFAULT_API = String(j.url).replace(/\/+$/, ''); discoverWhy = ''; break; }
} catch { /* це джерело недоступне — пробуємо наступне */ }
}
return DEFAULT_API;
}
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
for (;;) {
if (!LS.get('intdeliv.api')) await discover();
if (!apiBase()) { if (await waitForReconnect()) continue; throw new Error('Сервер запускається… спробуйте за хвилину'); }
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
clearTimeout(t);
if (await waitForReconnect()) continue;
throw new Error(e.name === 'AbortError' ? 'Сервер не відповідає (' + method + ')' : 'Немає зв\'язку з сервером');
}
setNet(true);
if (r.status === 401) { clearTimeout(t); throw new AuthError('Невірний ключ доступу'); }
const d = await r.json().catch(() => null); // таймаут t діє і на тіло відповіді
clearTimeout(t);
if (!d) { if (await waitForReconnect()) continue; throw new Error('Сервер перезапускається… (' + r.status + ')'); }
if (!d.ok) throw new Error(d.error || 'Помилка сервера');
return d.result;
}
}
async function call(method, params) {
if (demo) return demo.call(method, params);
try { return await rpc(method, params); } catch (e) { if (e instanceof AuthError) showLogin(e.message); throw e; }
}
let netOk = null;
function setNet(state, label) {
const cls = state === true ? 'on' : state === false ? 'off' : state === 'warn' ? 'warn' : '';
const changed = netOk !== state;
netOk = state;
const el = $('#net');
if (changed) el.className = 'net' + (cls ? ' ' + cls : '');
$('span', el).textContent = label || (state === true ? 'онлайн' : state === false ? 'немає зв\'язку' : '…');
}

// Тунель перезапускається раз на кілька годин (~1–2 хв простою) — тихо перепробовуємо,
// а не одразу показуємо помилку; заразом перечитуємо api.json без кешу і, якщо адреса
// змінилась, перемикаємось на неї навіть якщо стара була збережена вручну.
const RECONNECT_STEP_MS = 10000, RECONNECT_MAX_MS = 180000, RECONNECT_MSG = 'Сервер перезапускається, підключаюсь…';
const LOGIN_DIAG_MS = 25000;
let reconnectPromise = null;
function waitForReconnect() {
if (!reconnectPromise) reconnectPromise = doReconnect().finally(() => { reconnectPromise = null; });
return reconnectPromise;
}
function showConnHint(text) {
const el = $('#l-wait');
if (!el) return;
el.hidden = !text;
el.textContent = text || '';
}
async function doReconnect() {
const started = Date.now();
setNet('warn', RECONNECT_MSG);
while (Date.now() - started < RECONNECT_MAX_MS) {
await new Promise((res) => setTimeout(res, RECONNECT_STEP_MS));
const fresh = await discover(true);
if (fresh && cleanApi(LS.get('intdeliv.api')) !== fresh) LS.set('intdeliv.api', fresh);
if (!apiBase()) continue;
try {
const ac = new AbortController();
const t = setTimeout(() => ac.abort(), 6000);
await fetch(apiBase() + '/api/rpc', {
method: 'POST', signal: ac.signal,
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ method: 'ping', params: {} }),
}).finally(() => clearTimeout(t));
setNet(true);
return true;
} catch { /* сервер ще не піднявся — пробуємо ще раз */ }
}
setNet(false);
return false;
}

// Діагностика з'єднання (кнопка на екрані входу + автозапуск, коли сервер не відповідає).
// Результат лише на екрані й у «Скопіювати звіт» — нікуди не відправляється.
// Час до помилки підказує причину: миттєва відмова ≈ розширення/антивірус або DNS, довгий таймаут ≈ мережа мовчки відкидає.
const DIAG_TIMEOUT_MS = 12000, DIAG_INSTANT_MS = 50, DIAG_FAST_MS = 1500;
function browserName(ua = navigator.userAgent) {
const m = /Edg\w*\/(\d+)/.exec(ua) || /OPR\/(\d+)/.exec(ua) || /YaBrowser\/(\d+)/.exec(ua) || /Firefox\/(\d+)/.exec(ua) || /Chrome\/(\d+)/.exec(ua) || /Version\/(\d+).*Safari/.exec(ua);
const name = !m ? 'невідомий браузер' : /^Edg/.test(m[0]) ? 'Edge' : /^OPR/.test(m[0]) ? 'Opera' : /^Ya/.test(m[0]) ? 'Yandex' : /^Firefox/.test(m[0]) ? 'Firefox' : /^Chrome/.test(m[0]) ? 'Chrome' : 'Safari';
const os = /Windows NT/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
return name + (m ? ' ' + m[1] : '') + (os ? ' · ' + os : '');
}
const timeoutErr = () => Object.assign(new Error('таймаут'), { name: 'AbortError' });
// одна проба → {ok, ms, note}; ms — від старту до відповіді або до помилки
async function probe(run) {
const t0 = performance.now();
const ms = () => Math.round(performance.now() - t0);
try { const note = await run(); return { ok: true, ms: ms(), note: note || '' }; }
catch (e) { return { ok: false, ms: ms(), note: e.name === 'AbortError' ? 'таймаут' : e.message === 'ліміт' ? 'ліміт запитів' : 'відмова' }; }
}
const getT = (url, opts, read) => fetchT(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store', ...opts }, DIAG_TIMEOUT_MS, read);
function imgT(src) {
return new Promise((res, rej) => {
const i = new Image();
const t = setTimeout(() => { i.onload = i.onerror = null; i.src = ''; rej(timeoutErr()); }, DIAG_TIMEOUT_MS);
i.onload = () => { clearTimeout(t); res('завантажено'); };
i.onerror = () => { clearTimeout(t); rej(new Error('onerror')); };
i.src = src + '?t=' + Date.now();
});
}
const traceNote = (txt) => { const m = Object.fromEntries(String(txt).split('\n').map((l) => l.split('='))); return [m.colo && 'вузол ' + m.colo, m.loc, m.warp === 'on' && 'WARP'].filter(Boolean).join(', '); };
const DIAG_ROWS = [
['raw', 'GitHub raw (адреса сервера)'], ['api', 'GitHub API (запасний)'], ['cf', 'Cloudflare — контроль'],
['dns', 'DNS імені сервера (dns.google)'], ['edge', 'Cloudflare для імені сервера'], ['ping', 'Сервер: ping (fetch)'],
['nocors', 'Сервер: no-cors до кореня'], ['img', 'Картинка з імені сервера'],
];
let diagRun = null; // {res, host, verdict, at}
function runDiag() {
if (diagRun?.pending) return diagRun.pending;
const res = {}; let host = '';
const d = { res, get host() { return host; }, at: new Date(), verdict: '', pending: true };
diagRun = d;
const set = (k, p) => p.then((r) => { res[k] = r; renderDiag(); return r; });
d.pending = (async () => {
renderDiag();
let fromGh = '';
const pick = (j) => { if (!fromGh && j && /^https:\/\//.test(j.url)) fromGh = String(j.url).replace(/\/+$/, ''); };
await Promise.all([
set('raw', probe(async () => { const j = await getT(DISCOVERY[0][0].replace(/\?t=$/, ''), {}, (r) => r.json()); pick(j); return j?.url ? 'адреса є' : 'без адреси'; })),
set('api', probe(async () => {
const j = await getT(DISCOVERY[1][0].replace(/&t=$/, ''), { headers: DISCOVERY[1][1] }, async (r) => { const left = r.headers.get('x-ratelimit-remaining'); if (left === '0') throw new Error('ліміт'); return { ...(await r.json()), left }; });
pick(j); return 'лишилось запитів: ' + (j.left ?? '?');
})),
set('cf', probe(async () => traceNote(await getT('https://www.cloudflare.com/cdn-cgi/trace', {}, (r) => r.text())))),
]);
const base = fromGh || apiBase();
host = base ? new URL(base).host : '';
if (host) {
await Promise.all([
set('dns', probe(async () => {
const j = await getT('https://dns.google/resolve?type=A&name=' + encodeURIComponent(host), {}, (r) => r.json());
const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
if (!ips.length) { d.nx = true; return j.Status === 3 ? 'імені немає (NXDOMAIN)' : 'без адрес'; }
return ips.join(', ');
})),
set('edge', probe(async () => traceNote(await getT(base + '/cdn-cgi/trace', {}, (r) => r.text())) || 'відповів')),
set('ping', probe(async () => {
const j = await getT(base + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'ping', params: {} }) }, (r) => r.json());
if (!j?.ok) throw new Error('bad'); return 'версія ' + (j.result?.version || '?');
})),
set('nocors', probe(async () => { await getT(base + '/', { mode: 'no-cors' }); return 'відповідь отримана'; })),
set('img', probe(() => imgT(base + '/cdn-cgi/images/cf-icon-ok.png'))), // справжня картинка з краю Cloudflare
]);
}
d.verdict = diagVerdict(res, host, d.nx);
d.pending = null;
renderDiag();
return d;
})();
return d.pending;
}
function diagVerdict(r, host, nx) {
const ok = (k) => r[k]?.ok;
if (ok('ping')) return 'З\'єднання з сервером працює — мережа не заважає. Якщо вхід не проходить, перевірте ключ або оновіть сторінку (Ctrl+F5).';
if (!ok('raw') && !ok('api') && !ok('cf')) return 'Немає інтернету або мережа блокує все, крім цієї сторінки.';
if (!host) return r.api?.note === 'ліміт запитів' ? 'GitHub не віддає адресу сервера (ліміт запитів з вашої мережі) — спробуйте за годину або з іншого інтернету.' : 'GitHub недоступний — не вдається дізнатися адресу сервера (блокує мережа або антивірус).';
if (nx) return 'Адреса сервера ще не активна — сервер перезапускається, спробуйте за 2–3 хв.';
if (ok('edge') || ok('nocors')) return 'Мережа до сервера пропускає, але сервер не відповідає як слід — він перезапускається або запит блокує розширення/антивірус браузера.';
const srv = ['edge', 'nocors', 'ping'].map((k) => r[k]).filter(Boolean);
const worst = Math.max(...srv.map((x) => x.ms));
const where = '*.' + host.split('.').slice(-2).join('.');
if (!ok('cf')) return 'Мережа блокує з\'єднання з Cloudflare загалом (і з сервером теж).';
if (srv.every((x) => x.note === 'таймаут')) return 'Мережа блокує з\'єднання: запити до ' + where + ' мовчки зникають (провайдер, роутер або веб-щит антивірусу), а інші сайти Cloudflare працюють.';
if (worst < DIAG_INSTANT_MS) return 'Блокує розширення/антивірус браузера: запит до ' + where + ' зупиняється миттєво, ще до мережі. Спробуйте інший браузер без розширень.';
if (worst < DIAG_FAST_MS) return 'Не резолвиться DNS провайдера (або блокує антивірус): ' + (ok('dns') ? 'ім\'я ' + where + ' в інтернеті існує, але ' : '') + 'цей комп\'ютер одразу отримує відмову.';
return 'Мережа або антивірус скидає з\'єднання з ' + where + ', а інші сайти Cloudflare працюють.';
}
function diagReport(d = diagRun) {
if (!d) return '';
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
const lines = DIAG_ROWS.map(([k, label]) => { const x = d.res[k]; return pad(label, 32) + (x ? pad(x.ok ? 'OK' : 'ПОМИЛКА', 8) + pad(x.ms + ' мс', 9) + x.note : '—'); });
const ver = new URL(import.meta.url).searchParams.get('v') || 'dev';
return ['IntDeliv — діагностика з\'єднання', d.at.toLocaleString('uk-UA') + ' (UTC' + (d.at.getTimezoneOffset() > 0 ? '-' : '+') + Math.abs(d.at.getTimezoneOffset() / 60) + ')',
'Браузер: ' + browserName() + ' · онлайн: ' + (navigator.onLine ? 'так' : 'ні') + ' · сторінка v=' + ver,
'Сервер: ' + (d.host || 'адресу не отримано'), '', ...lines, '', 'Висновок: ' + (d.verdict || 'перевіряю…')].join('\n');
}
function renderDiag() {
const el = $('#l-diag'); const d = diagRun;
if (!el || !d) return;
el.hidden = false;
el.innerHTML = `<div class="dg-h"><b>Діагностика з'єднання</b><span class="muted">${esc(browserName())}</span></div>
<table class="dg">${DIAG_ROWS.map(([k, label]) => { const x = d.res[k]; const st = !x ? (d.pending ? '<span class="muted">…</span>' : '<span class="muted">—</span>') : x.ok ? '<b class="ok">OK</b>' : '<b class="bad">помилка</b>';
return `<tr><td>${esc(label)}</td><td>${st}</td><td class="n">${x ? esc(x.ms + ' мс') : ''}</td><td class="muted">${esc(x?.note || '')}</td></tr>`; }).join('')}</table>
<div class="dg-v">${d.verdict ? '<b>Висновок:</b> ' + esc(d.verdict) : '<span class="muted">Перевіряю… до ' + DIAG_TIMEOUT_MS * 2 / 1000 + ' с</span>'}</div>
<div class="dg-f"><button type="button" class="btn" data-dg="copy"${d.pending ? ' disabled' : ''}>Скопіювати звіт</button><button type="button" class="btn" data-dg="again"${d.pending ? ' disabled' : ''}>Повторити</button><span class="muted" data-dg-msg>Звіт нікуди не надсилається — скопіюйте й перешліть.</span></div>`;
}
async function copyText(text) {
try { await navigator.clipboard.writeText(text); return true; } catch { /* немає доступу до буфера — старий спосіб */ }
const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
document.body.append(ta); ta.select();
let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
ta.remove(); return ok;
}
$('#l-diag').addEventListener('click', async (e) => {
const b = e.target.closest('[data-dg]'); if (!b) return;
if (b.dataset.dg === 'again') return runDiag();
const msg = $('[data-dg-msg]', e.currentTarget); // currentTarget після await уже null
const ok = await copyText(diagReport());
msg.textContent = ok ? 'Скопійовано — вставте в повідомлення власнику.' : 'Не вдалося скопіювати — виділіть текст вручну.';
});

// Стан
const S = {
view: 'loads', tab: 'all', f: { fromCity: '', toCity: '', fromRegion: '', toRegion: '', payment: '', account: '', q: '', fav: false },
items: [], filtered: [], shown: PAGE, status: null, settings: null, version: '',
cList: 'white', customers: null, accDraft: null,
};
const TABS = [
['all', 'Усі', (c) => sum(c, ['new', 'queued', 'published', 'needs_review', 'error', 'inactive'])],
['active', 'Активні', (c) => sum(c, ['new', 'queued', 'published', 'needs_review', 'error'])],
['published', 'Опубліковані', (c) => sum(c, ['published'])],
['needs_review', 'Перевірити', (c) => sum(c, ['needs_review'])],
['archive', 'Архів · 30 днів', (c) => sum(c, ['inactive', 'deleted'])],
];
const TAB_MATCH = {
all: (s) => s !== 'deleted',
active: (s) => !['inactive', 'deleted'].includes(s),
published: (s) => s === 'published',
needs_review: (s) => s === 'needs_review',
archive: (s) => s === 'inactive' || s === 'deleted',
};
function sum(c, keys) { return keys.reduce((a, k) => a + (c?.[k] || 0), 0); }
const isOff = (l) => l.status === 'inactive' || l.status === 'deleted';

// Утиліти UI
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
let toastT;
function toast(msg, err, action) {
const el = $('#toast');
el.textContent = msg; el.className = 'toast' + (err ? ' err' : ''); el.hidden = false;
if (action) {
const b = document.createElement('button'); b.className = 't-act'; b.textContent = action.label;
b.onclick = () => { el.hidden = true; action.run(); }; el.append(b);
}
clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), err ? 5000 : action ? 6000 : 2500);
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
const ARCHIVE_MS = 30 * 86400e3;
function fmtDay(t) { const d = new Date(t); return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'); }
function fmtDate(d) { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(d || ''); return m ? m[3] + '.' + m[2] : esc(d); }
const hhmm = (ts) => new Date(ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

const modal = {
open(html, onMount) { $('#m-body').innerHTML = html; $('#modal').hidden = false; onMount && onMount($('#m-body')); },
close() { $('#modal').hidden = true; $('#m-body').innerHTML = ''; },
};
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') modal.close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) modal.close(); });

function confirmBox(title, text, okLabel = 'Видалити', warn = '') {
return new Promise((resolve) => {
modal.open(`<h3>${esc(title)}</h3><p>${esc(text)}</p>${warn ? `<div class="warnline">${esc(warn)}</div>` : ''}<div class="m-foot"><button class="btn" data-x="0">Скасувати</button><button class="btn dan" data-x="1">${esc(okLabel)}</button></div>`,
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
const accs = S.settings?.lardi?.accounts || [];
const shown = pub.map((n, i) => [n, i]).filter(([n, i]) => n || (!accs[i]?.archived && accs[i]?.state !== 'pending'));
$('#k-pub').innerHTML = shown.length ? shown.map(([n, i]) => `<span title="${esc(accName(i))}">${esc(fmtN(n))}</span>`).join(' <span class="muted">/</span> ') : '0';
$('#k-pub').title = shown.map(([n, i]) => accName(i) + ': ' + n).join(', ');
$('#k-q').textContent = fmtN(st.queue ?? 0);
$('#k-sync').textContent = rel(st.lastPollAt);
const r = $('#k-run');
r.classList.toggle('on', !!st.running);
const on = st.autoPublish !== false;
r.classList.toggle('on', on);
$('span', r).textContent = on ? 'Публікація працює' : 'Публікацію зупинено';
const pb = $('#pause'); pb.textContent = on ? 'Зупинити публікацію' : 'Відновити публікацію'; pb.classList.toggle('pri', !on);
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
// Умови оплати з тегів Della (ПДВ, «При розвантаженні», «За оригіналами»…) показуємо в колонці «Оплата»
const PAY_TERM = /пдв|оплат|платеж|розвантаженні|завантаженні|оригінал|передоплат|відтермін|рахун/i;
const payTerms = (l) => (l.tags || []).filter((t) => PAY_TERM.test(t));
const cargoTags = (l) => (l.tags || []).filter((t) => !PAY_TERM.test(t));
const PAY_FILTER = {
cashless: (l) => l.payment === 'Безнал', cash: (l) => l.payment === 'Готівка', card: (l) => l.payment === 'Картка',
vat: (l) => (l.tags || []).some((t) => /^пдв$/i.test(String(t).trim())), novat: (l) => (l.tags || []).some((t) => /без пдв/i.test(t)),
};
// Прямого посилання на заявку Della немає (ID шифрується на кожен запит), тож відкриваємо пошук саме цього маршруту місто → місто
function dellaLink(l) {
if (/^\d+$/.test(String(l.fromCityId || '')) && /^\d+$/.test(String(l.toCityId || ''))) {
return `https://della.com.ua/search/a204b0j${l.fromCityId}d204e0t${l.toCityId}flolz1z2z3z4z5z6z7z8z9y1y2y3y4y5y6h0ilk0m1.html`;
}
return /^https?:\/\//.test(l.dellaUrl || '') ? l.dellaUrl : '';
}
// Чи є в заявці дані про замовника (як customerKeys на сервері, спрощено) — інакше кнопки списків неактивні
const hasCustomer = (l) => !!(l.dellaCompanyId || String(l.edrpou || '').replace(/\D/g, '').length >= 8
|| String(l.phone || '').replace(/\D/g, '').length >= 9 || String(l.company || '').replace(/[^\p{L}\p{N}]/gu, '').length >= 4);
const NO_CUST = 'Немає даних про замовника — впишіть телефон або компанію в редагуванні заявки';
function custLine(l) {
const parts = [l.company, l.phone, l.edrpou ? 'ЄДРПОУ ' + l.edrpou : ''].filter(Boolean);
return parts.length ? `<div class="cust">${l.fav ? '<span class="star">★</span>' : ''}${esc(parts.join(' · '))}</div>` : '';
}
function rowHtml(l) {
const off = isOff(l);
const cur = CUR[l.currency] || l.currency || '';
const dist = l.distanceKm ? ` · ${fmtN(l.distanceKm)} км` : '';
const ppk = l.pricePerKm || (l.price && l.distanceKm ? Math.round(l.price / l.distanceKm) : 0);
const tags = cargoTags(l).slice(0, 4).map((t) => `<span class="tg">${esc(t)}</span>`).join('');
const terms = payTerms(l);
const dl = dellaLink(l);
const canPub = l.status !== 'published' && l.status !== 'queued';
const canUnpub = (l.lardi || []).some((a) => a.id && a.status !== 'removed') || l.status === 'published';
const hc = hasCustomer(l);
return `<tr class="${off ? 'off' : ''}${l.fav ? ' fav' : ''}" data-id="${esc(l.id)}">
<td data-l="Дата"><div class="d1">${off ? '🚫 ' : ''}${fmtDate(l.dateFrom)}${l.dateTo && l.dateTo !== l.dateFrom ? '–' + fmtDate(l.dateTo) : ''}</div><div class="sub">${esc(l.firstSeenAt ? hhmm(l.firstSeenAt) : '')}${l.edited ? ' · ✎' : ''}</div>${off && l.updatedAt ? `<div class="sub" title="${esc(l.statusReason || '')}">в архіві до ${esc(fmtDay(l.updatedAt + ARCHIVE_MS))}</div>` : ''}</td>
<td class="c-rt" data-l="Маршрут"><div class="rt">${l.fav ? '<span class="star" title="Обраний замовник">★</span>' : ''}${dl ? `<a class="rtl" href="${esc(dl)}" target="_blank" rel="noopener noreferrer" title="Відкрити на Della">` : ''}<span class="nw"><span class="dot">•</span> ${esc(l.fromCity)}</span> → <span class="nw"><span class="dot">•</span> ${esc(l.toCity)}</span>${dl ? '</a>' : ''}</div><div class="sub">${esc(l.fromRegion)} → ${esc(l.toRegion)}${dist}</div>${custLine(l)}</td>
<td class="c-cg" data-l="Вантаж / авто"><div>${esc(l.cargo)}</div><div class="sub">${esc(l.body)}</div>${tags}</td>
<td class="num" data-l="Вага">${l.weight != null ? esc(fmtN(l.weight)) + ' т' : '—'}</td>
<td class="num" data-l="Об'єм">${l.volume != null ? esc(fmtN(l.volume)) + ' м³' : '—'}</td>
<td data-l="Ціна">${l.price ? `<div class="pr">${esc(fmtN(l.price))} ${esc(cur)}</div>${ppk ? `<div class="sub">${esc(fmtN(ppk))} ${esc(cur)}/км</div>` : ''}` : '<span class="muted">—</span>'}</td>
<td class="c-pay" data-l="Оплата">${l.payment || terms.length ? `${l.payment ? `<div>${esc(l.payment)}</div>` : ''}${terms.map((t) => `<div class="sub">${esc(t)}</div>`).join('')}` : '<span class="muted">—</span>'}</td>
<td class="c-lr" data-l="Lardi">${lardiCell(l)}</td>
<td class="c-ac"><div class="acts">
<button class="ib" data-act="edit" title="Редагувати">${ICON.edit}</button>
<button class="ib${l.fav ? ' fav-on' : ''}" data-act="fav" title="${hc ? (l.fav ? 'Прибрати з обраних' : 'В обрані — завжди вгорі й публікуються першими') : NO_CUST}"${hc ? '' : ' disabled'}>${l.fav ? '★' : '☆'}</button>
<button class="ib" data-act="black" title="${hc ? 'В чорний список — не показувати й не публікувати' : NO_CUST}"${hc ? '' : ' disabled'}>🚫</button>
${canPub ? `<button class="ib" data-act="publish" title="${off ? 'Повернути з архіву й опублікувати' : 'Опублікувати зараз'}">${ICON.pub}</button>` : ''}
${canUnpub ? `<button class="ib" data-act="unpublish" title="Зняти з Lardi">${ICON.unpub}</button>` : ''}
${dl ? `<a class="ib" href="${esc(dl)}" target="_blank" rel="noopener noreferrer" title="Відкрити на Della">${ICON.link}</a>` : ''}
<button class="ib red" data-act="delete" title="Видалити">${ICON.del}</button>
</div></td></tr>`;
}

const norm = (s) => (s == null ? '' : String(s)).toLowerCase().replace(/[’'`ʼ]/g, "'").trim();
function applyFilters() {
const f = Object.fromEntries(Object.entries(S.f).map(([k, v]) => [k, typeof v === 'string' ? norm(v) : v]));
const qd = f.q.replace(/\D/g, '');
const m = TAB_MATCH[S.tab];
S.filtered = S.items.filter((l) => {
if (!m(l.status)) return false;
if (f.fromCity && !norm(l.fromCity).includes(f.fromCity)) return false;
if (f.toCity && !norm(l.toCity).includes(f.toCity)) return false;
if (f.fromRegion && !norm(l.fromRegion).includes(f.fromRegion)) return false;
if (f.toRegion && !norm(l.toRegion).includes(f.toRegion)) return false;
if (f.payment && PAY_FILTER[f.payment] && !PAY_FILTER[f.payment](l)) return false;
if (S.f.fav && !l.fav) return false;
if (f.account === 'none' && (l.lardi || []).some((a) => a.status === 'published')) return false;
if (f.account !== '' && f.account !== 'none' && !(l.lardi || []).some((a) => String(a.account) === f.account && a.status === 'published')) return false;
if (f.q) {
const ph = String(l.phone || '').replace(/\D/g, '');
const hit = norm(l.id).includes(f.q) || (qd.length >= 3 && ph.includes(qd)) || norm(l.company).includes(f.q) || String(l.edrpou || '').includes(f.q) ||
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
for (const k in S.f) {
if (typeof S.f[k] === 'boolean') { if (S.f[k]) p[k] = true; } else if (S.f[k].trim()) p[k] = S.f[k].trim();
}
if (S.tab === 'published' || S.tab === 'needs_review') p.status = S.tab;
if (S.tab === 'archive') p.status = ['inactive', 'deleted'];
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
async function loadSettings() { try { S.settings = await call('settings.get'); $('#dry').checked = !!S.settings?.lardi?.dryRun; renderBanners(); fillAccountFilter(); } catch (e) { toast(e.message, true); } }
function fillAccountFilter() {
const sel = $('select[data-f="account"]'); if (!sel) return;
const accs = (S.settings?.lardi?.accounts || []).map((a, i) => [a, i]).filter(([a]) => !a.archived);
sel.innerHTML = '<option value="">Lardi: будь-який</option>' + accs.map(([a, i]) => `<option value="${i}">Lardi: ${esc(a.name || 'Акаунт ' + (i + 1))}</option>`).join('') + '<option value="none">Не опубліковано</option>';
sel.value = S.f.account;
}

$$('.filters input, .filters select').forEach((inp) => inp.addEventListener(inp.tagName === 'SELECT' || inp.type === 'checkbox' ? 'change' : 'input', () => {
S.f[inp.dataset.f] = inp.type === 'checkbox' ? inp.checked : inp.value; S.shown = PAGE;
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
if (act === 'fav') return toggleFav(l, b);
if (act === 'black') return toBlack(l, b);
if (act === 'publish') { b.disabled = true; replaceLoad(await call('loads.publish', { id })); toast('Поставлено в чергу на публікацію'); }
if (act === 'unpublish') { b.disabled = true; replaceLoad(await call('loads.unpublish', { id })); toast('Знято з Lardi'); }
if (act === 'delete') {
if (!(await confirmBox('Видалити заявку?', `${l.fromCity} → ${l.toCity}, ${l.cargo}. Якщо вона опублікована — буде знята з Lardi. Заявка ще 30 днів зберігатиметься в «Архіві».`))) return;
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
['currency', 'Валюта', ['UAH', 'USD', 'EUR']], ['payment', 'Оплата'], ['company', 'Компанія'], ['phone', 'Телефон'], ['edrpou', 'ЄДРПОУ'],
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
const pubs = (l.lardi || []).length ? `<h4>Публікації на Lardi</h4><table class="pubs">${l.lardi.map((a) => `<tr><td>${esc(accName(a.account))}</td><td>${a.id ? 'Lardi id ' + esc(a.id) : '—'}</td><td>${chip(a.status || (a.error ? 'error' : 'queued'), '', a.error)}</td><td class="muted">${a.publishedAt ? esc(new Date(a.publishedAt).toLocaleString('uk-UA')) : ''}</td></tr>`).join('')}</table>` : '';
const hc = hasCustomer(l);
modal.open(`<h3>Редагувати заявку</h3><form id="ef"><div class="grid">${f}
<label class="fld wide">Мітки (через кому)<input name="tags" value="${esc((l.tags || []).join(', '))}"></label></div>${pubs}
<div class="m-foot"><button type="button" class="btn" data-lst="fav"${hc ? '' : ` disabled title="${esc(NO_CUST)}"`}>${l.fav ? '★ Прибрати з обраних' : '☆ В обрані'}</button><button type="button" class="btn" data-lst="black"${hc ? '' : ` disabled title="${esc(NO_CUST)}"`}>🚫 В чорний список</button><span style="flex:1"></span><button type="button" class="btn" data-close>Скасувати</button><button class="btn pri">Зберегти</button></div></form>`, (b) => {
$('[data-close]', b).onclick = modal.close;
$$('[data-lst]', b).forEach((x) => { x.onclick = () => { modal.close(); (x.dataset.lst === 'fav' ? toggleFav : toBlack)(l, x); }; });
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

// Обрані / чорний список
function keyLabel(k) {
const [t, v] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
if (t === 'tel') return '+' + v.replace(/^(\d{3})(\d{2})(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3 $4 $5');
if (t === 'edrpou') return 'ЄДРПОУ ' + v;
if (t === 'della') return 'Della #' + v;
return '«' + v + '»';
}
function blackText(pv) {
const live = Object.entries(pv.live || {}).map(([n, c]) => `${n}: ${c}`).join(', ');
return `Замовник «${pv.label}» (${pv.keys.map(keyLabel).join(', ')}). Приховаємо заявок у базі: ${pv.loads}; з Lardi буде знято публікацій: ${pv.liveTotal}${live ? ' (' + live + ')' : ''}. Нові заявки цього замовника з Della не збиратимуться.`;
}
const WEAK = 'Замовника визначено лише за назвою — може збігтися з іншою компанією з такою самою назвою.';
function blackDone(a) {
return `У чорному списку. Приховано: ${a?.hidden ?? 0}, знято з Lardi: ${a?.removed ?? 0}${a?.failed ? ', не вдалося зняти: ' + a.failed + ' (див. Журнал)' : ''}`;
}
async function toBlack(l, b) {
let pv;
try { pv = await call('customers.preview', { loadId: l.id }); } catch (e) { return toast(e.message, true); }
if (!(await confirmBox('Додати в чорний список?', blackText(pv), 'В чорний список', pv.weak ? WEAK : ''))) return;
if (b) b.disabled = true;
try { const r = await call('customers.add', { list: 'black', loadId: l.id }); toast(blackDone(r.affected), !!r.affected?.failed); }
catch (e) { toast(e.message, true); }
if (b) b.disabled = false;
loadLoads(); loadStatus(); if (S.customers) loadCustomers();
}
async function toggleFav(l, b) {
if (b) b.disabled = true;
try {
const pv = await call('customers.preview', { loadId: l.id });
if (pv.list === 'white') {
await call('customers.remove', { id: pv.customerId });
toast('Прибрано з обраних');
} else {
const r = await call('customers.add', { list: 'white', loadId: l.id });
const undo = async () => {
try { await call(pv.list === 'black' ? 'customers.move' : 'customers.remove', { id: r.customer.id, list: 'black' }); toast('Скасовано'); }
catch (e) { toast(e.message, true); }
loadLoads(); loadStatus();
};
toast(`«${r.customer.label || 'Замовник'}» — в обраних ★`, false, { label: 'Скасувати', run: undo });
}
} catch (e) { toast(e.message, true); }
if (b) b.disabled = false;
loadLoads(); loadStatus(); if (S.customers) loadCustomers();
}
async function loadCustomers() {
try { S.customers = await call('customers.list', {}); } catch (e) { toast(e.message, true); return; }
renderCustomers();
}
function renderCustomers() {
const c = S.customers || { items: [], hiddenBlack: 0 };
const cnt = (k) => c.items.filter((x) => x.list === k).length;
$('#c-tabs').innerHTML = [['white', 'Обрані ★'], ['black', 'Чорний список']].map(([k, label]) =>
`<button class="tab${S.cList === k ? ' on' : ''}" data-cl="${k}">${label}<span class="n">${fmtN(cnt(k))}</span></button>`).join('');
const hid = $('#c-hidden');
hid.hidden = S.cList !== 'black';
hid.textContent = 'Приховано заявок: ' + fmtN(c.hiddenBlack || 0);
$('#c-add .btn').textContent = S.cList === 'black' ? 'В чорний список' : 'В обрані';
const rows = c.items.filter((x) => x.list === S.cList);
$('#c-rows').innerHTML = rows.map((x) => `<tr data-cid="${esc(x.id)}">
<td data-l="Замовник"><b>${esc(x.label || '—')}</b></td>
<td data-l="Ключі">${(x.keys || []).map((k) => `<span class="key">${esc(keyLabel(k))}</span>`).join('')}</td>
<td data-l="Додано" class="num">${esc(new Date(x.createdAt).toLocaleDateString('uk-UA'))}</td>
<td data-l="Нотатка"><input class="note-in" data-note value="${esc(x.note || '')}" placeholder="—" aria-label="Нотатка"></td>
<td data-l="Заявок у базі" class="num">${x.loads ? `<button type="button" class="lnk" data-c="loads">${esc(fmtN(x.loads))}</button>` : '0'}</td>
<td data-l="На Lardi зараз" class="num">${esc(fmtN(x.live))}</td>
<td class="c-ac"><div class="acts"><button type="button" class="btn" data-c="move">${x.list === 'black' ? 'В обрані' : 'В чорний список'}</button><button type="button" class="btn" data-c="remove">Прибрати</button></div></td></tr>`).join('');
const em = $('#c-empty');
em.hidden = rows.length > 0;
em.textContent = S.cList === 'black'
? 'Чорний список порожній. Натисніть 🚫 у рядку заявки або впишіть вище телефон, ЄДРПОУ чи назву — заявки такого замовника не показуватимуться й не публікуватимуться на Lardi.'
: 'Обраних ще немає. Натисніть ☆ у рядку заявки або впишіть замовника вище — його заявки завжди вгорі списку й публікуються першими.';
}
$('#c-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-cl]'); if (!b) return; S.cList = b.dataset.cl; renderCustomers(); });
$('#c-add').addEventListener('submit', async (e) => {
e.preventDefault();
const fd = new FormData(e.target); const text = String(fd.get('text') || '').trim(); const note = String(fd.get('note') || '').trim();
const list = S.cList; const btn = $('.btn', e.target);
try {
if (list === 'black') {
const pv = await call('customers.preview', { text });
if (!(await confirmBox('Додати в чорний список?', blackText(pv), 'В чорний список', pv.weak ? WEAK : ''))) return;
}
btn.disabled = true;
const r = await call('customers.add', { list, text, note });
e.target.reset();
toast(list === 'black' ? blackDone(r.affected) : `«${r.customer.label}» — в обраних ★`, !!r.affected?.failed);
} catch (err) { toast(err.message, true); }
btn.disabled = false; loadCustomers(); loadStatus();
});
$('#c-rows').addEventListener('change', async (e) => {
const inp = e.target.closest('[data-note]'); if (!inp) return;
try { await call('customers.update', { id: Number(inp.closest('tr').dataset.cid), note: inp.value }); toast('Нотатку збережено'); } catch (err) { toast(err.message, true); }
});
$('#c-rows').addEventListener('click', async (e) => {
const b = e.target.closest('[data-c]'); if (!b) return;
const id = Number(b.closest('tr').dataset.cid);
const x = (S.customers?.items || []).find((c) => c.id === id); if (!x) return;
try {
if (b.dataset.c === 'loads') return showCustomerLoads(x);
if (b.dataset.c === 'remove') {
const txt = x.list === 'black' ? `«${x.label}» прибрати з чорного списку? Актуальні заявки повернуться в роботу (і в чергу публікації), минулі лишаться в Архіві.` : `«${x.label}» прибрати з обраних?`;
if (!(await confirmBox('Прибрати зі списку?', txt, 'Прибрати'))) return;
b.disabled = true;
const r = await call('customers.remove', { id });
toast(r?.restored ? `Прибрано, повернуто заявок: ${r.restored}` : 'Прибрано зі списку');
} else {
const to = x.list === 'black' ? 'white' : 'black';
if (to === 'black') {
const pv = await call('customers.preview', { keys: x.keys, label: x.label });
if (!(await confirmBox('Перенести в чорний список?', blackText(pv), 'В чорний список', pv.weak ? WEAK : ''))) return;
}
b.disabled = true;
const r = await call('customers.move', { id, list: to });
toast(to === 'black' ? blackDone(r.affected) : `Перенесено в обрані${r.affected?.restored ? ', повернуто заявок: ' + r.affected.restored : ''}`, !!r.affected?.failed);
}
} catch (err) { toast(err.message, true); }
loadCustomers(); loadStatus();
});
async function showCustomerLoads(x) {
let r;
try { r = await call('loads.list', { customer: x.id, status: 'all', limit: 300 }); } catch (e) { return toast(e.message, true); }
const items = r?.items || [];
modal.open(`<h3>${esc(x.label || 'Замовник')} — заявки (${fmtN(r?.total ?? items.length)})</h3>
<table class="pubs">${items.map((l) => `<tr><td>${fmtDate(l.dateFrom)}</td><td>${esc(l.fromCity)} → ${esc(l.toCity)}</td><td>${l.price ? esc(fmtN(l.price)) + ' ' + esc(CUR[l.currency] || '') : ''}</td><td>${chip(l.status, '', l.statusReason)}</td></tr>`).join('')}</table>
<div class="m-foot"><button type="button" class="btn" data-close>Закрити</button></div>`, (b) => { $('[data-close]', b).onclick = modal.close; });
}

// KPI дії
$('#sync').addEventListener('click', async (e) => {
e.target.disabled = true;
try { await call('sync.now'); toast('Синхронізацію запущено'); setTimeout(() => { loadStatus(); loadLoads(); }, 1500); }
catch (err) { toast(err.message, true); }
setTimeout(() => (e.target.disabled = false), 3000);
});
$('#pause').addEventListener('click', async (e) => {
const on = S.status?.autoPublish !== false;
if (on && !(await confirmBox('Зупинити публікацію?', 'Нові заявки з Della перестануть публікуватися на Lardi, черга очиститься. Уже опубліковані залишаться на Lardi — щоб зняти і їх, натисніть «Зняти все з Lardi».', 'Зупинити'))) return;
e.target.disabled = true;
try {
if (on) { const r = await call('lardi.stopAll', { remove: false }); toast(`Публікацію зупинено${r?.dequeued ? ', знято з черги: ' + r.dequeued : ''}`); }
else { await call('lardi.resume'); toast('Публікацію відновлено'); }
} catch (err) { toast(err.message, true); }
e.target.disabled = false; loadSettings(); loadStatus(); loadLoads();
});
$('#unpub-all').addEventListener('click', async (e) => {
const n = S.status?.counts?.published || 0;
if (!(await confirmBox('Зняти все з Lardi?', `Публікацію буде зупинено, черга очиститься, а всі опубліковані заявки (${n}) буде знято з Lardi. Вони перейдуть в «Архів» і зберігатимуться там 30 днів — звідти будь-яку можна повернути.`, 'Зняти все'))) return;
e.target.disabled = true; toast('Знімаю з Lardi… це може зайняти хвилину');
try {
const r = await call('lardi.stopAll', { remove: true });
toast(`Знято з Lardi: ${r?.removed ?? 0}${r?.failed ? ', не вдалося: ' + r.failed + ' (див. Журнал)' : ''}`, !!r?.failed);
} catch (err) { toast(err.message, true); }
e.target.disabled = false; loadSettings(); loadStatus(); loadLoads();
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
S.accDraft = (L.accounts && L.accounts.length ? L.accounts : [{}]).map((a) => ({ ...a }));
const num = (name, label, v, extra = '') => `<label class="fld">${label}<input name="${name}" type="number" min="0" value="${esc(v ?? '')}" ${extra}></label>`;
const txt = (name, label, v, ph = '') => `<label class="fld">${label}<input name="${name}" value="${esc(v ?? '')}" placeholder="${esc(ph)}"></label>`;
const chk = (name, label, v) => `<label class="chk"><input type="checkbox" name="${name}"${v ? ' checked' : ''}> ${label}</label>`;
$('#sf').innerHTML = `
<div class="card"><h3>Сервер</h3><p class="help">Система працює на сервері цілодобово, 24/7, сама по собі: збирає заявки з Della й публікує їх на Lardi, навіть коли цю сторінку закрито, а комп'ютер вимкнено. Ця панель лише показує дані та змінює налаштування.${S.version ? ' Версія: ' + esc(S.version) + '.' : ''}</p>
<div class="grid"><label class="fld wide">Адреса сервера<input name="api" value="${esc(demo ? '' : apiBase())}" placeholder="${esc(DEFAULT_API || 'автоматично')}"${demo ? ' disabled' : ''}></label></div></div>

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
<p class="help">Токен API: увійдіть на <a href="https://lardi-trans.com/" target="_blank" rel="noopener">lardi-trans.com</a> потрібним акаунтом → <b>Налаштування → API</b> → створіть/скопіюйте ключ і вставте сюди. Для кожного акаунта свій токен. Токен зберігається лише в зашифрованій базі на сервері; тут його видно як <code>••••1234</code> — щоб не змінювати, залиште як є. Акаунт без токена «очікує підключення» й нічого не публікує.</p>
<div class="accs" id="accs"></div>
<div class="acc-acts"><button type="button" class="btn" id="acc-add">＋ Додати акаунт</button><span class="muted" id="acc-max"></span></div>
<div class="grid" style="margin-top:12px">
<label class="fld">Режим<select name="mode"><option value="both"${L.mode !== 'roundrobin' ? ' selected' : ''}>На всі акаунти (дублювати)</option><option value="roundrobin"${L.mode === 'roundrobin' ? ' selected' : ''}>По черзі (roundrobin)</option></select></label>
${num('intervalSeconds', 'Пауза між публікаціями, с', L.intervalSeconds)}${num('dailyLimit', 'Ліміт на акаунт за добу', L.dailyLimit ?? 500)}
${txt('note', 'Примітка до заявки', L.note)}
<div class="fld" style="justify-content:flex-end;gap:8px">${chk('autoPublish', 'Автопублікація', L.autoPublish)}${chk('dryRun', 'Тестовий режим (нічого не публікується)', L.dryRun)}</div></div></div>

<div class="card"><h3>Актуальність</h3><p class="help">Заявка стає неактуальною, якщо дата завантаження минула або її не видно на Della довше за вказаний час — тоді її знято з Lardi.</p>
<div class="grid">${num('staleHours', 'Неактуальна після, год', s.staleHours ?? 6)}</div></div>

<div class="save-bar"><button class="btn pri">Зберегти налаштування</button><span class="muted" id="sf-st"></span></div>`;
renderAccs();
}
const MAX_ACCOUNTS = 5;
const ACC_ST = {
ok: ['c-ok', 'Підключено'], unchecked: ['c-info', 'Токен не перевірено'], pending: ['c-warn', 'Очікує підключення'],
invalid: ['c-err', 'Токен відхилено — на паузі'], disabled: ['c-off', 'Вимкнено'],
};
function accStateOf(a) {
if (a.archived || a.enabled === false) return 'disabled';
if (!a.token) return 'pending';
return a.state === 'invalid' ? 'invalid' : a.state === 'unchecked' ? 'unchecked' : 'ok';
}
// значення полів карток → чернетка (перед перемальовуванням і збереженням)
function syncAccDraft() {
const fd = new FormData($('#sf'));
S.accDraft.forEach((a, i) => {
if (a.archived || !$(`[data-acc="${i}"]`)) return;
a.name = String(fd.get('acc' + i + 'name') || '').trim();
a.token = String(fd.get('acc' + i + 'token') || '').trim();
a.enabled = fd.get('acc' + i + 'enabled') === 'on';
});
}
function accCard(a, i) {
const state = accStateOf(a);
const [cls, label] = ACC_ST[state];
const st = (S.status?.accounts || [])[i];
const saved = i < (S.settings?.lardi?.accounts?.length || 0);
const num = (n) => esc(fmtN(n || 0));
return `<div class="acc-card ${state}" data-acc="${i}">
<div class="acc-top"><b>${esc(a.name || 'Акаунт ' + (i + 1))}</b><span class="chip ${cls}">${label}</span>${saved ? '' : '<span class="muted">новий — збережіть</span>'}</div>
<div class="grid">${txtFld('acc' + i + 'name', 'Назва акаунта', a.name, 'Акаунт ' + (i + 1))}
<label class="fld">Токен API${a.token ? ' · збережено ' + esc(a.token) : ' · не підключено'}<input name="acc${i}token" type="password" autocomplete="new-password" value="${esc(a.token || '')}" placeholder="вставте токен з Lardi"></label>
<div class="fld" style="justify-content:flex-end"><label class="chk"><input type="checkbox" name="acc${i}enabled"${a.enabled !== false ? ' checked' : ''}> Увімкнено</label></div></div>
${st && saved ? `<div class="acc-stats"><span>Сьогодні: <b>${num(st.today?.published)}</b>${st.today?.dry ? ` (тест: ${num(st.today.dry)})` : ''} з ${st.today?.limit ? num(st.today.limit) : '∞'}</span><span>На Lardi зараз: <b>${num(st.live)}</b></span><span>Помилок: <b>${num(st.errors)}</b></span><span>Остання публікація: <b>${st.lastPublishAt ? esc(rel(st.lastPublishAt)) : '—'}</b></span></div>` : ''}
${a.lastError && state !== 'pending' ? `<div class="res c-err">✗ ${esc(a.lastError)}</div>` : ''}
<div class="acc-acts"><button type="button" class="btn" data-test="${i}">Перевірити</button>
${saved && state === 'ok' && S.settings?.lardi?.mode !== 'roundrobin' ? `<button type="button" class="btn" data-backfill="${i}" title="Поставити в чергу актуальні опубліковані заявки, яких на цьому акаунті ще немає">Опублікувати й сюди актуальні заявки</button>` : ''}
<button type="button" class="btn" data-archive="${i}">Видалити</button><div class="res muted" id="res${i}"></div></div></div>`;
}
function txtFld(name, label, v, ph = '') { return `<label class="fld">${label}<input name="${name}" value="${esc(v ?? '')}" placeholder="${esc(ph)}"></label>`; }
function renderAccs() {
const box = $('#accs'); if (!box) return;
const act = S.accDraft.map((a, i) => [a, i]).filter(([a]) => !a.archived);
const arch = S.accDraft.map((a, i) => [a, i]).filter(([a]) => a.archived);
box.innerHTML = act.map(([a, i]) => accCard(a, i)).join('')
+ (arch.length ? `<details class="arch"><summary>Видалені акаунти (${arch.length})</summary>${arch.map(([a, i]) => `<div class="acc-acts"><span>${esc(a.name || 'Акаунт ' + (i + 1))}</span><button type="button" class="btn" data-restore="${i}">Повернути</button></div>`).join('')}</details>` : '');
const full = S.accDraft.length >= MAX_ACCOUNTS;
$('#acc-add').disabled = full;
$('#acc-max').textContent = full ? `максимум ${MAX_ACCOUNTS} акаунтів` : '';
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
lardi: { accounts: (syncAccDraft(), S.accDraft).map((a) => (a.archived ? { name: a.name, token: '', enabled: false, archived: true }
: { name: a.name, token: a.token || '', enabled: a.enabled !== false, ...(a.restore ? { restore: true } : {}) })),
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
if (e.target.closest('#acc-add')) {
syncAccDraft();
if (S.accDraft.length < MAX_ACCOUNTS) S.accDraft.push({ name: 'Акаунт ' + (S.accDraft.length + 1), token: '', enabled: true });
renderAccs(); return;
}
const ar = e.target.closest('[data-archive]');
if (ar) {
const i = Number(ar.dataset.archive); syncAccDraft();
const a = S.accDraft[i]; const live = (S.status?.accounts || [])[i]?.live || 0;
if (!(await confirmBox('Видалити акаунт?', `«${a.name || 'Акаунт ' + (i + 1)}» буде вимкнено, а токен стерто. Вже опубліковані з нього заявки (${live}) лишаться на Lardi — зняти їх можна кнопкою «Зняти все з Lardi» до видалення. Акаунт можна повернути, вставивши токен знову.`, 'Видалити'))) return;
if (i >= (S.settings?.lardi?.accounts?.length || 0)) { S.accDraft.splice(i, 1); renderAccs(); return; } // ще не збережений
a.archived = true; $('#sf').requestSubmit(); return;
}
const rs = e.target.closest('[data-restore]');
if (rs) { syncAccDraft(); const a = S.accDraft[Number(rs.dataset.restore)]; a.archived = false; a.restore = true; a.enabled = true; renderAccs(); toast('Вставте токен і збережіть'); return; }
const bf = e.target.closest('[data-backfill]');
if (bf) {
const i = Number(bf.dataset.backfill);
try {
const pv = await call('lardi.backfill', { accountIndex: i, dryRunOnly: true });
if (!pv?.candidates) return toast('Немає актуальних заявок, яких бракує на цьому акаунті');
if (!(await confirmBox('Опублікувати й на цей акаунт?', `У чергу стане ${pv.candidates} актуальних опублікованих заявок, яких на «${accName(i)}» ще немає (обрані — першими, у межах добового ліміту).`, 'Поставити в чергу'))) return;
const r = await call('lardi.backfill', { accountIndex: i });
toast(`У черзі: ${r?.queued ?? 0}`); loadStatus();
} catch (err) { toast(err.message, true); }
return;
}
const b = e.target.closest('[data-test]'); if (!b) return;
const i = Number(b.dataset.test); const res = $('#res' + i);
const typed = String($(`[name="acc${i}token"]`)?.value || '').trim();
b.disabled = true; res.className = 'res muted'; res.textContent = 'Перевіряю…';
try {
const r = await call('lardi.test', { accountIndex: i, ...(typed && !typed.startsWith('••') ? { token: typed } : {}) });
res.className = 'res ' + (r?.ok ? 'c-ok' : 'c-err');
res.textContent = r?.ok ? '✓ Токен працює' + (r.name ? ': ' + r.name : '') + (typed && !typed.startsWith('••') ? ' — натисніть «Зберегти налаштування»' : '') : '✗ ' + (r?.error || 'Помилка');
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
if (view === 'settings') { renderSettings(); Promise.all([loadSettings(), loadStatus()]).then(renderSettings); }
if (view === 'customers') { renderCustomers(); loadCustomers(); }
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
showConnHint('');
$('#l-diag').hidden = true;
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
// одразу показуємо, що йде підключення, а через LOGIN_DIAG_MS без відповіді — причину, а не мовчазну бліду кнопку
const t0 = Date.now();
let diag = null;
const tickHint = () => showConnHint((diag ? 'Продовжую спроби' : 'Підключаюсь до сервера') + '… ' + Math.round((Date.now() - t0) / 1000) + ' с');
tickHint();
const ticker = setInterval(tickHint, 1000);
const diagT = setTimeout(async () => {
diag = true; tickHint();
$('#l-err').textContent = 'Сервер не відповідає — перевіряю з\'єднання…';
const d = await runDiag();
if (btn.disabled) $('#l-err').textContent = d.verdict; // вхід ще триває — показуємо причину
}, LOGIN_DIAG_MS);
try {
const r = await rpc('ping', {}, key);
if (r && r.authed === false) throw new AuthError('Невірний ключ доступу');
LS.set('intdeliv.key', key); $('#l-key').value = '';
start(r);
} catch (err) {
if (err instanceof AuthError || !diag) $('#l-err').textContent = err.message;
else $('#l-err').insertAdjacentHTML('beforeend', '<br>Спроби зупинено — натисніть «Увійти», щоб повторити.');
}
clearInterval(ticker); clearTimeout(diagT); showConnHint('');
btn.disabled = false;
});
$('#l-diag-run').addEventListener('click', (e) => { e.preventDefault(); runDiag(); });
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
go(['settings', 'log', 'customers'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'loads');
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
// показуємо інтерфейс одразу, не чекаючи на пінг — rpc() сам тихо перепробує з'єднання,
// якщо сервер саме перезапускається, і опитування (loadStatus/loadSettings) підхопить дані
start(null);
try {
const r = await rpc('ping');
if (r && r.authed === false) return showLogin('Ключ більше не дійсний — увійдіть знову');
S.version = r?.version || '';
} catch (e) {
if (e instanceof AuthError) showLogin(e.message);
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
directCustomer: i % 4 !== 3, phone: i % 5 === 4 ? undefined : '+38067' + String(1234567 + i * 1111).slice(0, 7),
company: ['ТОВ «Агроплюс»', 'Логістик-Юг', undefined, 'ФОП Коваль', 'ТОВ «Меблі Захід»'][i % 5], dellaUrl: 'https://della.com.ua/', status, statusReason: status === 'needs_review' ? 'Не вдалося зіставити місто або кузов з Lardi' : status === 'inactive' ? 'Дата завантаження минула' : '',
lardi: lardi.map(([st, id, err], a) => ({ account: a, status: st, id: id || undefined, error: err })),
seenAt: seen, firstSeenAt: seen - H, updatedAt: seen };
});
// замовник заявки в демо — за телефоном
const dKey = (l) => (l.phone ? 'tel:' + String(l.phone).replace(/\D/g, '').slice(-12) : null);
let customers = [];
let custSeq = 1;
const listOf = (l) => { const k = dKey(l); const c = k && customers.find((x) => x.keys.includes(k)); return c ? c.list : null; };
const visible = () => items.filter((l) => listOf(l) !== 'black');
const withFav = (l) => ({ ...clone(l), ...(listOf(l) === 'white' ? { fav: true } : {}) });
const demoAdd = (list, key, label) => {
const c = customers.find((x) => x.keys.includes(key));
if (c) { c.list = list; return c; }
const n = { id: custSeq++, list, label, note: '', keys: [key], createdAt: Date.now() };
customers.push(n); return n;
};
let settings = { della: { searchUrls: ['https://della.com.ua/search/a204bd204eflolz1z21z3z4z51z6z7z8z9y1y2y3y4y5y6h0ilk0m1.html'], pollSeconds: 90, pagesPerPoll: 4 },
filters: { minPrice: 8000, directOnly: true, bodies: [], fromRegions: [], toRegions: [], excludeRegions: [], stopWords: ['металобрухт'], maxAgeHours: 24 },
lardi: { accounts: [{ name: 'Кілик В.', token: '••••4821', enabled: true, state: 'ok' }, { name: 'Друге Ларді', token: '', enabled: true, state: 'pending' }],
mode: 'both', autoPublish: true, dryRun: true, intervalSeconds: 20, dailyLimit: 500, note: '' }, staleHours: 6 };
const counts = () => items.reduce((c, l) => ((c[l.status] = (c[l.status] || 0) + 1), c), {});
const logs = [['info', 'Зібрано 25 заявок зі сторінки 1, нових: 3'], ['info', 'Опубліковано на Lardi (Софія): Полтава → Харків'], ['warn', 'needs_review: не знайдено кузов «цільномет» на Lardi'], ['error', 'Lardi 429 — повтор через 30 с']]
.map(([level, msg], i) => ({ t: now - i * 4 * 60e3, level, msg }));
const clone = (x) => JSON.parse(JSON.stringify(x));
const upd = (id, fn) => { const l = items.find((x) => x.id === id); if (!l) throw new Error('Заявку не знайдено'); fn(l); l.updatedAt = Date.now(); return clone(l); };
const api = {
ping: () => ({ version: 'demo', authed: true }),
'loads.list': (p) => {
if (p.customer) { const c = customers.find((x) => x.id === p.customer); const r = items.filter((l) => c && c.keys.includes(dKey(l))); return { items: clone(r), total: r.length }; }
const sts = p.status ? [].concat(p.status) : null;
const r = visible().filter((l) => (!sts || sts.includes(l.status)) && (!p.fav || listOf(l) === 'white'))
.sort((a, b) => (listOf(b) === 'white') - (listOf(a) === 'white') || b.seenAt - a.seenAt);
return { items: r.map(withFav), total: r.length };
},
'customers.list': () => ({ items: clone(customers).map((c) => ({ ...c, loads: items.filter((l) => c.keys.includes(dKey(l))).length, live: items.filter((l) => c.keys.includes(dKey(l)) && l.status === 'published').length })), hiddenBlack: items.filter((l) => listOf(l) === 'black').length }),
'customers.preview': (p) => {
const l = p.loadId && items.find((x) => x.id === p.loadId);
const key = l ? dKey(l) : p.keys ? p.keys[0] : p.text && /\d{9}/.test(p.text.replace(/\D/g, '')) ? 'tel:380' + p.text.replace(/\D/g, '').slice(-9) : p.text ? 'name:' + p.text.toLowerCase() : null;
if (!key) throw new Error('Немає даних про замовника — впишіть телефон або компанію в редагуванні заявки');
const own = items.filter((x) => dKey(x) === key);
const c = customers.find((x) => x.keys.includes(key));
return { label: (l && (l.company || l.phone)) || p.label || p.text, keys: [key], weak: key.startsWith('name:'), loads: own.length, queued: own.filter((x) => x.status === 'queued').length,
live: { 'Кілик В.': own.filter((x) => x.status === 'published').length }, liveTotal: own.filter((x) => x.status === 'published').length, list: c ? c.list : null, customerId: c ? c.id : null };
},
'customers.add': (p) => {
const pv = api['customers.preview'](p);
const c = demoAdd(p.list, pv.keys[0], p.label || pv.label);
if (p.note) c.note = p.note;
return { customer: clone(c), affected: p.list === 'black' ? { hidden: pv.loads, removed: pv.liveTotal, failed: 0 } : { restored: 0 } };
},
'customers.move': ({ id, list }) => { const c = customers.find((x) => x.id === id); c.list = list; return { customer: clone(c), affected: { hidden: 0, removed: 0, failed: 0, restored: 0 } }; },
'customers.update': ({ id, note }) => { const c = customers.find((x) => x.id === id); if (note !== undefined) c.note = note; return clone(c); },
'customers.remove': ({ id }) => { customers = customers.filter((x) => x.id !== id); return { restored: 0 }; },
'lardi.accounts': () => api['status.get']().accounts,
'lardi.backfill': ({ dryRunOnly }) => (dryRunOnly ? { candidates: 3 } : { queued: 3 }),
'loads.update': ({ id, patch }) => upd(id, (l) => Object.assign(l, patch)),
'loads.delete': ({ id }) => { items = items.filter((l) => l.id !== id); return { ok: true }; },
'loads.publish': ({ id }) => upd(id, (l) => { l.status = 'queued'; l.lardi = [0, 1].map((a) => ({ account: a, status: settings.lardi.dryRun ? 'dry' : 'queued' })); }),
'loads.unpublish': ({ id }) => upd(id, (l) => { l.status = 'inactive'; l.statusReason = 'Знято вручну'; l.lardi = l.lardi.map((a) => ({ ...a, status: 'removed' })); }),
'settings.get': () => clone(settings),
'settings.set': (p) => {
for (const k in p) settings[k] = typeof p[k] === 'object' && !Array.isArray(p[k]) ? { ...settings[k], ...p[k] } : p[k];
settings.lardi.accounts = settings.lardi.accounts.map((a) => {
const t = a.archived ? '' : a.token && !String(a.token).startsWith('••') ? '••••' + String(a.token).slice(-4) : a.token || '';
return { ...a, token: t, state: a.archived || !a.enabled ? 'disabled' : t ? 'ok' : 'pending' };
});
return clone(settings);
},
'status.get': () => ({ running: true, autoPublish: settings.lardi.autoPublish, lastPollAt: now - 70e3, counts: counts(), today: { collected: 187, published: settings.lardi.accounts.map((a, i) => (i ? 0 : 142)), dry: settings.lardi.accounts.map(() => 0) }, queue: items.filter((l) => l.status === 'queued').length,
accounts: settings.lardi.accounts.map((a, i) => ({ index: i, name: a.name, enabled: a.enabled, archived: !!a.archived, state: a.archived || !a.enabled ? 'disabled' : a.token ? 'ok' : 'pending', hasToken: !!a.token, today: { published: i ? 0 : 142, dry: 0, limit: settings.lardi.dailyLimit }, live: i ? 0 : 118, errors: i ? 0 : 2, lastPublishAt: i ? undefined : now - 95e3 })) }),
'sync.now': () => ({ started: true }),
'lardi.stopAll': ({ remove }) => { settings.lardi.autoPublish = false; let removed = 0; if (remove) items.forEach((l) => { if (l.status === 'published') { l.status = 'inactive'; l.statusReason = 'знято вручну (усі)'; l.lardi = l.lardi.map((a) => ({ ...a, status: 'removed' })); removed++; } }); return { dequeued: 0, removed, failed: 0 }; },
'lardi.resume': () => { settings.lardi.autoPublish = true; return { ok: true }; },
'lardi.test': ({ accountIndex, token }) => (token || settings.lardi.accounts[accountIndex]?.token ? { ok: true, name: 'токен дійсний (демо)' } : { ok: false, error: 'токен не задано' }),
'log.list': () => clone(logs),
};
return { call: async (m, p = {}) => { if (!api[m]) throw new Error('Невідомий метод ' + m); await new Promise((r) => setTimeout(r, 60)); return api[m](p); } };
}

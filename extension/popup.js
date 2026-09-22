const ADMIN_URL = 'https://intdeliv.siteboosty.com/';
const $ = (id) => document.getElementById(id);

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ __intdeliv: 'req', method, params }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'немає відповіді'));
      resolve(resp.result);
    });
  });
}

function ago(t) {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s} с тому`;
  if (s < 3600) return `${Math.round(s / 60)} хв тому`;
  return new Date(t).toLocaleString('uk-UA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

async function refresh() {
  try {
    const st = await call('status.get');
    const mode = $('mode');
    mode.textContent = st.dryRun ? 'DRY RUN' : 'ПУБЛІКАЦІЯ';
    mode.classList.toggle('live', !st.dryRun);
    $('state').textContent = st.polling ? 'збір…' : st.publishing ? 'публікація…' : st.running ? 'працює' : 'зупинено';
    $('lastPoll').textContent = ago(st.lastPollAt);
    $('collected').textContent = st.today.collected;
    const pub = (st.today.published || []).reduce((a, b) => a + b, 0);
    const dry = (st.today.dry || []).reduce((a, b) => a + b, 0);
    $('published').textContent = st.dryRun ? `${pub} (dry: ${dry})` : `${pub} (${(st.today.published || []).join(' / ')})`;
    $('queue').textContent = st.queue;
    const total = Object.entries(st.counts || {}).filter(([k]) => k !== 'deleted').reduce((a, [, v]) => a + v, 0);
    $('total').textContent = total;
    $('review').textContent = (st.counts && st.counts.needs_review) || 0;
    const e = $('error');
    e.hidden = !st.lastError;
    e.textContent = st.lastError || '';
  } catch (err) {
    $('state').textContent = 'помилка';
    $('error').hidden = false;
    $('error').textContent = err.message;
  }
}

$('open').addEventListener('click', () => { chrome.tabs.create({ url: ADMIN_URL }); window.close(); });
$('sync').addEventListener('click', async () => {
  const b = $('sync');
  b.disabled = true;
  b.textContent = 'Запущено…';
  try { await call('sync.now'); } catch (e) { $('error').hidden = false; $('error').textContent = e.message; }
  setTimeout(() => { b.disabled = false; b.textContent = 'Синхронізувати зараз'; refresh(); }, 2500);
});

refresh();
setInterval(refresh, 3000);

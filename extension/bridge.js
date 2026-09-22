// IntDeliv — мост между страницей админки и service worker расширения.
// Страница: window.postMessage({__intdeliv:'req', id, method, params}, '*')
// Ответ:   {__intdeliv:'res', id, ok, result|error}; пуш: {__intdeliv:'event', type, data}; {__intdeliv:'hello', version}
(() => {
  if (window.__intdelivBridge) return;
  window.__intdelivBridge = true;

  const VERSION = chrome.runtime.getManifest().version;
  const post = (msg) => window.postMessage(msg, window.location.origin === 'null' ? '*' : window.location.origin);
  const hello = () => post({ __intdeliv: 'hello', version: VERSION });
  const alive = () => { try { return !!chrome.runtime.id; } catch { return false; } };

  // постоянный порт для событий loads.changed / status
  let port = null;
  let retry = 0;
  function connect() {
    if (!alive()) return;
    try {
      port = chrome.runtime.connect({ name: 'intdeliv-bridge' });
    } catch {
      return;
    }
    retry = 0;
    port.onMessage.addListener((msg) => {
      if (msg && msg.__intdeliv === 'event') post(msg);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      void chrome.runtime.lastError;
      // service worker усыпили или перезапустили — переподключаемся
      if (alive()) setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
    });
  }
  connect();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.__intdeliv !== 'req') return;
    const { id, method, params } = msg;
    if (method === 'ping') hello();
    if (!alive()) {
      post({ __intdeliv: 'res', id, ok: false, error: 'Розширення оновлено — перезавантажте сторінку' });
      return;
    }
    try {
      chrome.runtime.sendMessage({ __intdeliv: 'req', method, params: params || {} }, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          post({ __intdeliv: 'res', id, ok: false, error: err.message || String(err) });
          return;
        }
        if (!resp) {
          post({ __intdeliv: 'res', id, ok: false, error: 'порожня відповідь від розширення' });
          return;
        }
        post({ __intdeliv: 'res', id, ok: !!resp.ok, result: resp.result, error: resp.error });
      });
      if (!port) connect();
    } catch (e) {
      post({ __intdeliv: 'res', id, ok: false, error: e.message || String(e) });
    }
  });

  hello();
  // на случай, если скрипт страницы подписался позже document_start
  document.addEventListener('DOMContentLoaded', hello, { once: true });
  window.addEventListener('load', hello, { once: true });
})();

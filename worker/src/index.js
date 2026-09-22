// IntDeliv — Cloudflare Worker: cron (збір/публікація) + RPC для адмінки.
import { Engine, VERSION } from './engine.js';

const ALLOWED_ORIGINS = new Set(['https://intdeliv.siteboosty.com', 'https://tjmermta.github.io']);
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function allowedOrigin(origin) {
  if (!origin) return null;
  return ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin) ? origin : null;
}

function corsHeaders(req) {
  const origin = allowedOrigin(req.headers.get('Origin'));
  const h = { Vary: 'Origin' };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(req) },
  });
}

/** Порівняння без раннього виходу. */
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export function isAuthed(req, env) {
  const key = env && env.ADMIN_KEY;
  if (!key) return false;
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return !!m && safeEqual(m[1].trim(), key);
}

export function makeEngine(env, ctx) {
  return new Engine(env, { ctx, ...(env.__engineOpts || {}) });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: allowedOrigin(req.headers.get('Origin')) ? 204 : 403, headers: corsHeaders(req) });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return json(req, { name: 'intdeliv', ok: true });
    }
    if (url.pathname !== '/api/rpc') return json(req, { ok: false, error: 'not found' }, 404);
    if (req.method !== 'POST') return json(req, { ok: false, error: 'method not allowed' }, 405);

    let body;
    try { body = await req.json(); } catch { return json(req, { ok: false, error: 'bad json' }, 400); }
    const method = body && typeof body.method === 'string' ? body.method : '';
    const params = (body && body.params) || {};
    const authed = isAuthed(req, env);

    if (method === 'ping') return json(req, { ok: true, result: { version: VERSION, authed } });
    if (!authed) return json(req, { ok: false, error: 'unauthorized' }, 401);

    try {
      const result = await makeEngine(env, ctx).rpc(method, params);
      return json(req, { ok: true, result });
    } catch (e) {
      return json(req, { ok: false, error: (e && e.message) || String(e) });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(makeEngine(env, ctx).runCycle().catch((e) => console.error('[IntDeliv] cron', e)));
  },
};

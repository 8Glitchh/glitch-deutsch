// Glitch Deutsch sync server (Cloudflare Worker).
// Devices that share a sync code send the entries they changed and get back what the others changed.
// Each entry is [value, time]; the newest time wins. Only study progress is stored, keyed by a hash of the code.

const ORIGINS = ['https://8glitchh.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const CODE = /^[A-HJ-NP-Z2-9]{16}$/;
const MAX_BODY = 3_000_000, MAX_ENTRIES = 20_000, MAX_VALUE = 200_000;

const headers = origin => ({
  'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
  'Content-Type': 'application/json',
});
const reply = (body, status, h) => new Response(JSON.stringify(body), { status, headers: h });

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    const h = headers(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/') return reply({ ok: true }, 200, h);
    if (req.method !== 'POST' || path !== '/sync') return reply({ error: 'not found' }, 404, h);

    const body = await req.text();
    if (body.length > MAX_BODY) return reply({ error: 'too big' }, 413, h);
    let msg;
    try { msg = JSON.parse(body); } catch { return reply({ error: 'bad request' }, 400, h); }
    if (!msg || !CODE.test(msg.code || '')) return reply({ error: 'bad code' }, 400, h);

    const room = env.ROOMS.get(env.ROOMS.idFromName(await sha256(msg.code)));
    const res = await room.fetch('https://room/sync', { method: 'POST', body: JSON.stringify({ since: msg.since, changes: msg.changes }) });
    return new Response(res.body, { status: res.status, headers: h });
  },
};

export class SyncRoom {
  constructor(state) { this.state = state; }

  async fetch(req) {
    const msg = await req.json();
    const doc = (await this.state.storage.get('doc')) || { ver: 0, e: {} };
    const now = Date.now();
    const changes = msg.changes && typeof msg.changes === 'object' ? msg.changes : {};
    const keys = Object.keys(changes);
    if (keys.length > MAX_ENTRIES) return Response.json({ error: 'too many entries' }, { status: 413 });

    let wrote = false;
    for (const k of keys) {
      const c = changes[k];
      if (!Array.isArray(c) || k.length > 300) continue;
      const v = c[0];
      if (v !== null && (typeof v !== 'string' || v.length > MAX_VALUE)) continue;
      const t = Math.min(Number(c[1]) || 0, now + 5 * 60_000);   // a phone with its clock far ahead can't win forever
      const old = doc.e[k];
      if (old && (old[1] > t || (old[1] === t && old[0] === v))) continue;
      if (!wrote) { doc.ver++; wrote = true; }
      doc.e[k] = [v, t, doc.ver];
    }
    if (wrote) await this.state.storage.put('doc', doc);

    // Everything changed since the version this device last saw (all of it if it's ahead of us).
    let since = Number.isInteger(msg.since) ? msg.since : 0;
    if (since > doc.ver) since = 0;
    const out = {};
    for (const k in doc.e) { const e = doc.e[k]; if (e[2] > since) out[k] = [e[0], e[1]]; }
    return Response.json({ ver: doc.ver, changes: out });
  }
}

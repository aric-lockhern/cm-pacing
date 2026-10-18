// The dashboard's FAST READ PATH. The Apps Script gateway is slow and flaky (Google's web-app front
// end takes 3–50 s and sometimes 404s from script.googleusercontent.com, even though the script runs in
// milliseconds). So reads are served from here instead: Publish.gs posts the gateway's finished payloads
// to Netlify Blobs every few minutes, and this function answers the page's reads from that copy, on the
// dashboard's own address (no Google front end).
//
// cm-pacing is single-tenant: ONE shared secret, ONE global payload (not per-account tokens). So the
// access check collapses to "the request's secret must hash to the published secretHash" — exactly the
// gateway's `p.secret !== SHARED_SECRET` check, done against a hash so the secret never lives here.
//
// The Sheet + Apps Script stay the source of truth and the ONLY writer. This path never writes anything
// to the Sheet; every write still goes to Apps Script. Anything this can't positively verify (no secret
// match, nothing published yet, a payload not published yet, a forced-fresh read, an unknown action)
// answers {ok:false, fallback:true} and the page asks Apps Script, which stays the authority.
// tests/fastapi.test.mjs pins all of it.
import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
// A stored payload is returned verbatim (it already carries ok:true) so the page uses it exactly as it
// would the gateway's JSONP answer.
const raw = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: HEADERS });
const ok = (result) => json({ ok: true, result });
const fail = (error, status = 200) => json({ ok: false, error }, status);
const fallback = (why) => json({ ok: false, fallback: true, error: why });

export function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// The payloads the gateway serves as reads; everything else (writes, settings, queues, moves, syncs,
// email) must keep going to Apps Script, so it never comes through here.
const READ_KINDS = { data: 1, campaignBulk: 1 };

/** GET /api?action=data|campaignBulk|ping&secret=... (the gateway's own params), POST /api/ingest. */
export async function handle(req, store, env) {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.replace(/\/$/, '').endsWith('/ingest')) return ingest(req, store, env);
  if (req.method !== 'GET') return fail('Reads only.', 405);
  const p = Object.fromEntries(url.searchParams);
  const ix = await store.get('index', { type: 'json' });

  // ping answers "is fast loading on?" from a browser, naming nothing secret.
  if (p.action === 'ping') return ok({ ran: true, fast: true, published: !!ix, at: (ix && ix.at) || '', gatewayVersion: (ix && ix.gatewayVersion) || '' });

  if (!READ_KINDS[p.action]) return fallback('unknown action');   // writes etc. → Apps Script
  if (p.fresh === '1') return fallback('fresh requested');         // the page's Refresh wants the authority
  if (!ix) return fallback('nothing published yet');
  if (!ix.secretHash || !same(sha256(String(p.secret || '')), ix.secretHash)) return fallback('not known here');

  const snap = await store.get(p.action, { type: 'json' });
  if (!snap || !snap.data) return fallback(p.action + ' not published');
  return raw(snap.data);   // the stored gateway payload, byte-for-byte what JSONP would return
}

/** POST /api/ingest from Publish.gs: {kind:'index'|'data'|'campaignBulk', version, gz: base64(gzip(JSON))}. */
async function ingest(req, store, env) {
  const secret = env.INGEST_SECRET || '';
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (secret.length < 24 || !same(auth, secret)) return fail('Not accepted.', 403);   // fails closed with no/short secret
  let b;
  try { b = await req.json(); } catch (e) { return fail('Bad body.', 400); }
  let data;
  try { data = JSON.parse(gunzipSync(Buffer.from(String(b.gz || ''), 'base64')).toString('utf8')); } catch (e) { return fail('Bad payload.', 400); }

  if (b.kind === 'index') {
    if (!data || typeof data.secretHash !== 'string' || data.secretHash.length !== 64) return fail('Bad index.', 400);
    await store.setJSON('index', data);
    return ok({ stored: 'index' });
  }
  if (READ_KINDS[b.kind]) {
    if (!data || data.ok !== true) return fail('Bad ' + b.kind + ' payload.', 400);
    await store.setJSON(b.kind, { version: String(b.version || ''), at: Date.now(), data });
    return ok({ stored: b.kind });
  }
  return fail('Unknown kind.', 400);
}

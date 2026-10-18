// The FAST READ PATH (netlify/lib/fastapi.mjs) must answer exactly as the Apps Script gateway would —
// serve the gateway's published payloads to a matching secret, and fall back for anything it can't
// verify — and never store or write anything but the published copies. Driven through the REAL publisher
// (apps-script/Publish.gs) into the REAL function, over an in-memory Blobs store. See tests/harness.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { world, published, fixtures, gz, INGEST } from './harness.mjs';

const SECRET = 'cmp_test_secret';
const plain = (x) => JSON.parse(JSON.stringify(x));

test('the publisher sends the index + both read payloads; nothing without the ingest secret', async () => {
  const w = await published();
  assert.ok(w.store.m.has('index'), 'index published');
  assert.ok(w.store.m.has('data'), 'data published');
  assert.ok(w.store.m.has('campaignBulk'), 'campaignBulk published');
  const ix = JSON.parse(w.store.m.get('index'));
  assert.equal(ix.secretHash.length, 64, 'index carries a SHA-256, not the secret');
  assert.ok(!JSON.stringify(ix).includes(SECRET), 'the shared secret itself never leaves the script');
  assert.equal(ix.gatewayVersion, 'test-gw');

  // No Script Property INGEST_SECRET → pubOn_() is false → the publisher sends nothing at all.
  const off = world({ props_ingest: '' });
  let calls = 0; const realFetch = off.g; // marker; count via a fresh world where UrlFetchApp isn't hit
  off.g.publishAll();
  await off.flush();
  assert.ok(!off.store.m.has('index') && !off.store.m.has('data'), 'nothing published without the secret');
});

test('same answers as the gateway: the fast path serves the published payloads to a matching secret', async () => {
  const w = await published();
  const fx = fixtures();
  const d = await w.fast({ action: 'data', secret: SECRET });
  assert.equal(d.status, 200);
  assert.deepEqual(d.body, fx.data, 'data payload byte-for-byte');
  const c = await w.fast({ action: 'campaignBulk', secret: SECRET });
  assert.deepEqual(c.body, fx.bulk, 'campaignBulk payload byte-for-byte');
});

test('unchanged payloads are not re-sent; a changed payload is', async () => {
  const w = await published();
  let posts = {};
  // wrap the store writes by re-publishing and counting what ingest stored a new version of
  const before = { data: JSON.parse(w.store.m.get('data')).at, bulk: JSON.parse(w.store.m.get('campaignBulk')).at };
  await new Promise((r) => setTimeout(r, 2));
  w.g.publishAll(); await w.flush();
  assert.equal(JSON.parse(w.store.m.get('data')).at, before.data, 'unchanged data keeps its stored version (not re-sent)');
  // Now change the data and republish: it is re-sent.
  w.state.data = { ...w.state.data, google: [{ Label: 'Fetch - Boise', Spend: 999 }] };
  await new Promise((r) => setTimeout(r, 2));
  w.g.publishAll(); await w.flush();
  assert.notEqual(JSON.parse(w.store.m.get('data')).at, before.data, 'changed data is re-sent');
  assert.equal((await w.fast({ action: 'data', secret: SECRET })).body.google[0].Spend, 999);
});

test('SECURITY: the fast path never widens, and falls back for anything it cannot verify', async () => {
  const w = await published();
  // Wrong/empty secret → fallback (ask Apps Script), never the data.
  for (const secret of ['nope', '', 'cmp_test_secre']) {
    const r = await w.fast({ action: 'data', secret });
    assert.equal(r.body.ok, false, JSON.stringify(secret));
    assert.equal(r.body.fallback, true);
    assert.equal(r.body.google, undefined, 'no data leaked');
  }
  // The Refresh button (fresh=1) always goes to Apps Script, the authority.
  assert.equal((await w.fast({ action: 'data', secret: SECRET, fresh: '1' })).body.fallback, true);
  // Unknown / write actions never come through the fast path.
  for (const action of ['queueBudget', 'logMove', 'setConfigBatch', 'bogus'])
    assert.equal((await w.fast({ action, secret: SECRET })).body.fallback, true, action);
});

test('before anything is published, every read falls back; ping reports the state', async () => {
  const w = world();
  assert.equal((await w.fast({ action: 'data', secret: SECRET })).body.fallback, true, 'nothing published → fallback');
  const ping0 = (await w.fast({ action: 'ping' })).body.result;
  assert.equal(ping0.published, false);
  const p = await published();
  const ping = (await p.fast({ action: 'ping' })).body.result;
  assert.ok(ping.published && ping.at && ping.gatewayVersion === 'test-gw');
  assert.ok(!JSON.stringify(ping).includes(SECRET), 'ping leaks no secret');
});

test('rotating the shared secret republishes the index: the old secret stops, the new one works', async () => {
  const w = await published();
  assert.equal((await w.fast({ action: 'data', secret: SECRET })).body.ok, true);
  // Same Blobs store, a publisher running with a NEW SHARED_SECRET re-publishes the index.
  const w2 = world({ store: w.store, secret: 'cmp_NEW_secret' });
  w2.g.publishIndex_(); await w2.flush();
  assert.equal((await w.fast({ action: 'data', secret: SECRET })).body.fallback, true, 'old secret no longer recognized');
  assert.equal((await w.fast({ action: 'data', secret: 'cmp_NEW_secret' })).body.ok, true, 'new secret works');
});

test('ingest refuses a wrong, missing or short bearer secret, and fails closed with none configured', async () => {
  const w = world();
  const body = { kind: 'index', gz: gz({ secretHash: 'a'.repeat(64) }) };
  assert.equal((await w.post('Bearer wrong', body)).status, 403, 'wrong secret');
  assert.equal((await w.post('', body)).status, 403, 'no bearer');
  assert.equal((await w.post('Bearer ' + INGEST.slice(0, -1), body)).status, 403, 'off by one');
  assert.equal((await w.post('Bearer ' + INGEST, body, { INGEST_SECRET: '' })).status, 403, 'no env secret → refuse everything');
  assert.equal((await w.post('Bearer ' + INGEST, body, { INGEST_SECRET: 'short' })).status, 403, 'too-short env secret → refuse');
  assert.equal((await w.post('Bearer ' + INGEST, body)).status, 200, 'correct secret accepted');
  // Shape validation.
  assert.equal((await w.post('Bearer ' + INGEST, { kind: 'index', gz: gz({ nope: 1 }) })).status, 400, 'index must carry secretHash');
  assert.equal((await w.post('Bearer ' + INGEST, { kind: 'data', gz: gz({ ok: false }) })).status, 400, 'read payload must be ok:true');
  assert.equal((await w.post('Bearer ' + INGEST, { kind: 'bogus', gz: gz({ ok: true }) })).status, 400, 'unknown kind');
});

test('non-GET reads are rejected', async () => {
  const w = world();
  const r = await (await import('../netlify/lib/fastapi.mjs')).handle(new Request('https://pacing.example.com/api?action=ping', { method: 'DELETE' }), w.store, w.env);
  assert.equal(r.status, 405);
});

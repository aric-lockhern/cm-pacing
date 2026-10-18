// Runs the REAL publisher (apps-script/Publish.gs) with mocked Apps Script services, posting into the
// REAL Netlify function (netlify/lib/fastapi.mjs) backed by an in-memory Blobs store. So the tests
// exercise the actual publish → ingest → read round-trip, not a reimplementation.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { handle } from '../netlify/lib/fastapi.mjs';

const PUB_SRC = readFileSync(fileURLToPath(new URL('../apps-script/Publish.gs', import.meta.url)), 'utf8');
const SITE = 'https://pacing.example.com';
export const INGEST = 'x'.repeat(40);

function memStore() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => { m.set(k, JSON.stringify(v)); } };
}

// A fixture that looks like what the gateway's getDataString_/campaignBulkString_ return.
export function fixtures() {
  return {
    data: {
      ok: true, gatewayVersion: 'test-gw', generatedAt: '2026-10-18T00:00:00.000Z',
      google: [{ Label: 'Fetch - Boise', Spend: 10, Conv: 1 }],
      budgets: [{ Label: 'Fetch - Boise', Platform: 'Google', Month: '2026-10', 'Total Budget': 2000 }],
      metaFeed: [], googleCampaigns: [{ Label: 'Fetch - Boise', Campaign: 'Fetch - Boise - PMax', CampaignId: '123' }],
      config: { googleFee: 0.25, metaFee: 0.2 }
    },
    bulk: { ok: true, labels: ['Fetch - Boise'], camps: ['Fetch - Boise - PMax'], rows: [['2026-10-01', 0, 0, 10, 1, 2, 0]] }
  };
}

export function world(opts = {}) {
  const store = opts.store || memStore(), env = { INGEST_SECRET: opts.ingest ?? INGEST }, sent = [];
  const state = { data: (opts.fx || fixtures()).data, bulk: (opts.fx || fixtures()).bulk, secret: opts.secret || 'cmp_test_secret' };
  const props = new Map([['INGEST_SECRET', opts.props_ingest ?? INGEST]]);
  const cache = new Map();

  const blob = (s) => ({ _s: s });
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    computeDigest: (_algo, s) => [...createHash('sha256').update(String(s)).digest()],   // 0..255; pubHex_ masks with &0xff
    newBlob: (s) => blob(s),
    gzip: (b) => ({ getBytes: () => gzipSync(Buffer.from(b._s)) }),
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
    getUuid: () => '00000000-0000-4000-8000-000000000000'
  };
  const UrlFetchApp = {
    fetch: (url, opt) => {
      const b = JSON.parse(opt.payload);
      const req = new Request(url, { method: 'POST', headers: { authorization: opt.headers.Authorization, 'content-type': 'application/json' }, body: JSON.stringify(b) });
      sent.push(handle(req, store, env));   // real ingest, async; flushed by the test
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true }) };
    }
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => { props.set(k, String(v)); }, deleteProperty: (k) => { props.delete(k); } }) };
  const CacheService = { getScriptCache: () => ({ get: (k) => cache.get(k) || null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) };
  const ScriptApp = { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }), forSpreadsheet: () => ({ onEdit: () => ({ create: () => {} }) }) }) };
  const noopUi = { alert: () => {}, showModalDialog: () => {}, createMenu: () => ({ addItem: () => ({ addToUi: () => {} }) }) };
  const SpreadsheetApp = { getUi: () => noopUi, openById: () => ({}) };
  const HtmlService = { createHtmlOutput: () => ({ setWidth: () => ({ setHeight: () => ({}) }) }) };

  // Load Publish.gs with PUBLISH_SITE_URL pointed at the test site (the file ships it blank).
  const src = PUB_SRC.replace(/var PUBLISH_SITE_URL = '';/, "var PUBLISH_SITE_URL = '" + SITE + "';");
  const names = ['PropertiesService', 'CacheService', 'Utilities', 'UrlFetchApp', 'ScriptApp', 'SpreadsheetApp', 'HtmlService', 'console',
    'SHARED_SECRET', 'GATEWAY_VERSION', 'SPREADSHEET_ID', 'getDataString_', 'campaignBulkString_'];
  const getDataString_ = () => JSON.stringify(state.data);
  const campaignBulkString_ = () => JSON.stringify(state.bulk);
  const factory = new Function(...names, src + '\n;return { publishAll, publishSoon_, publishIndex_, onEditPublish, pubIndex_, pubReadPayload_ };');
  const g = factory(PropertiesService, CacheService, Utilities, UrlFetchApp, ScriptApp, SpreadsheetApp, HtmlService, console,
    state.secret, 'test-gw', 'SHEET_ID', getDataString_, campaignBulkString_);

  const flush = () => Promise.all(sent.splice(0));
  const fast = async (q) => {
    const r = await handle(new Request(SITE + '/api?' + new URLSearchParams(q)), store, env);
    return { status: r.status, body: await r.json() };
  };
  const post = (auth, body, e = env) => handle(new Request(SITE + '/api/ingest', { method: 'POST', headers: { authorization: auth }, body: JSON.stringify(body) }), store, e);
  return { g, state, store, env, props, cache, flush, fast, post, secret: state.secret };
}

export async function published(opts) {
  const w = world(opts);
  w.g.publishAll();
  await w.flush();
  return w;
}

export const gz = (obj) => gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');

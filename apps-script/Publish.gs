/**
 * FAST LOADING — publishes what the dashboard READS to Netlify Blobs, so the page doesn't wait on
 * Google's web-app front end (the script runs in ms, but requests take 3–50 s and sometimes 404).
 * -----------------------------------------------------------------------------------------------
 * Every 5 minutes (a time trigger) `publishAll` POSTs to <PUBLISH_SITE_URL>/api/ingest
 * (netlify/functions/api.mjs), gzipped + base64, with `Authorization: Bearer <INGEST_SECRET>`:
 *   - index: a SHA-256 hash of SHARED_SECRET (never the secret), the gateway version, a timestamp.
 *     The function checks a reader's `secret` against this hash — the same check as the gateway's
 *     `p.secret !== SHARED_SECRET`, so the fast path grants exactly what the gateway would.
 *   - data: getDataString_(true) — the WHOLE payload the gateway's `action=data` returns.
 *   - campaignBulk: campaignBulkString_(true) — the per-campaign bundle `action=campaignBulk` returns.
 * data / campaignBulk are only re-sent when their content changed (a SHA-256 of the payload is kept in
 * Script Properties). A settings save and hand edits to the Sheet republish right away. The Sheet +
 * Apps Script stay the source of truth and the only writer; this path only serves copies of reads.
 *
 * Nothing is sent until BOTH exist: Script Property INGEST_SECRET and the Netlify env var of the same
 * name. Run the Sheet menu "Fast loading ▸ Set up" once to create the secret, install the triggers,
 * test-send, and get the Netlify steps.
 *
 * SET THIS: the hosted dashboard's base URL (the Netlify site that serves the dashboard).
 */
var PUBLISH_SITE_URL = '';                 // e.g. 'https://cm-pacing.netlify.app'  ← set once
var PUB_BUDGET_MS = 4 * 60 * 1000;

function pubSecret_() { return PropertiesService.getScriptProperties().getProperty('INGEST_SECRET') || ''; }
function pubUrl_() { return PUBLISH_SITE_URL ? PUBLISH_SITE_URL.replace(/\/?$/, '/') + 'api/ingest' : ''; }
function pubOn_() { return !!(pubSecret_() && pubUrl_()); }

function pubHex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s))
    .map(function (b) { return ((b & 0xff) + 0x100).toString(16).slice(1); }).join('');
}

/** POSTs one payload (a JSON string). Returns '' on success, else the reason it failed. */
function pubPost_(kind, version, jsonStr) {
  var gz = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(jsonStr, 'application/json')).getBytes());
  var res = UrlFetchApp.fetch(pubUrl_(), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + pubSecret_() },
    payload: JSON.stringify({ kind: kind, version: version || '', gz: gz })
  });
  var code = res.getResponseCode(), body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  return code === 200 && body.ok ? '' : 'HTTP ' + code + (body.error ? ': ' + body.error : '');
}

function pubIndex_() {
  return { at: Date.now(), secretHash: pubHex_(SHARED_SECRET), gatewayVersion: typeof GATEWAY_VERSION === 'string' ? GATEWAY_VERSION : '' };
}
function publishIndex_() { return pubOn_() ? pubPost_('index', '', JSON.stringify(pubIndex_())) : ''; }

var PUB_HASH_PREFIX = 'PUB_H_';
/** Builds one read payload fresh, and sends it only if it changed. Returns '' or the reason. */
function pubReadPayload_(kind, force) {
  var str = kind === 'campaignBulk' ? campaignBulkString_(true) : getDataString_(true);
  var hash = pubHex_(str);
  var props = PropertiesService.getScriptProperties(), key = PUB_HASH_PREFIX + kind;
  if (!force && props.getProperty(key) === hash) return '';          // unchanged — don't re-send
  var err = pubPost_(kind, hash.slice(0, 12), str);
  if (!err) props.setProperty(key, hash);
  return err;
}

/** Time trigger (every 5 min): index, then each read payload that changed, within the budget. */
function publishAll() {
  if (!pubOn_()) return;
  var cache = CacheService.getScriptCache();
  if (cache.get('pub_running')) return;              // the previous run is still going
  cache.put('pub_running', '1', 300);
  try {
    var started = Date.now(), fails = [];
    var e = publishIndex_();
    if (e) { console.log('Fast loading: index not accepted: ' + e); return; }
    e = pubReadPayload_('data', false); if (e) fails.push('data: ' + e);
    if (Date.now() - started < PUB_BUDGET_MS) { e = pubReadPayload_('campaignBulk', false); if (e) fails.push('campaignBulk: ' + e); }
    console.log('Fast loading: published' + (fails.length ? ' with issues: ' + fails.join(' | ') : ' ok') + '.');
  } finally {
    cache.remove('pub_running');
  }
}

/** Right away after a settings save or a hand edit. Never throws — the write itself already succeeded. */
function publishSoon_() {
  if (!pubOn_()) return;
  try { publishIndex_(); pubReadPayload_('data', true); } catch (e) { console.log('Fast loading: could not publish now: ' + e); }
}

/** Installable onEdit: a hand edit in the Sheet reaches the fast path within seconds. Debounced so a
 * burst of edits republishes once; the 5-minute trigger catches anything after that. */
function onEditPublish(e) {
  if (!pubOn_()) return;
  var c = CacheService.getScriptCache();
  if (c.get('pub_edit')) return;                     // at most once per 90 s
  c.put('pub_edit', '1', 90);
  try { publishSoon_(); } catch (x) {}
}

/* ── Sheet menu ─────────────────────────────────────────────────────────────── */
function onOpen() {
  try { SpreadsheetApp.getUi().createMenu('Fast loading').addItem('Set up', 'fastSetup').addToUi(); } catch (e) {}
}

/** Creates the shared secret, installs the triggers, test-sends, and shows the Netlify step with the secret. */
function fastSetup() {
  var ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  if (!pubUrl_()) { ui.alert('Set PUBLISH_SITE_URL at the top of Publish.gs to your Netlify dashboard URL first (e.g. https://cm-pacing.netlify.app), then run this again.'); return; }
  var secret = pubSecret_();
  if (!secret) { secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''); props.setProperty('INGEST_SECRET', secret); }
  var have = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  if (have.indexOf('publishAll') < 0) ScriptApp.newTrigger('publishAll').timeBased().everyMinutes(5).create();
  if (have.indexOf('onEditPublish') < 0) ScriptApp.newTrigger('onEditPublish').forSpreadsheet(SpreadsheetApp.openById(SPREADSHEET_ID)).onEdit().create();
  var test = '';
  try { test = publishIndex_(); } catch (e) { test = String(e && e.message ? e.message : e); }
  var html = test
    ? '<p><b>One step left, in Netlify:</b> Site configuration &rsaquo; Environment variables &rsaquo; Add a variable</p>'
      + '<p>Key: <b>INGEST_SECRET</b><br>Value (click to select):</p>'
      + '<input style="width:100%;padding:6px;font:13px monospace" value="' + secret + '" onclick="this.select()" readonly>'
      + '<p>Then Deploys &rsaquo; Trigger deploy, wait for it to finish, and run this menu item again.</p>'
      + '<p style="color:#64748b">Test send result: ' + String(test).replace(/</g, '&lt;') + '</p>'
    : '<p><b>Fast loading is on.</b> The dashboard payloads are being published now, then every 5 minutes when something changed, and immediately after a settings save or a hand edit.</p>';
  ui.showModalDialog(HtmlService.createHtmlOutput('<div style="font:14px Arial;padding:4px">' + html + '</div>').setWidth(560).setHeight(test ? 320 : 150), 'Fast loading');
}

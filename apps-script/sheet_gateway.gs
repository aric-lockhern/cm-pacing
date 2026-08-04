/**
 * Pacing Gateway (Apps Script Web App) — FRANCHISE / CAMPAIGN-LABEL edition
 * ------------------------------------------------------------------------
 * The ONLY thing the app + Slack talk to. Keeps the sheet private, dodges CORS
 * via JSONP, posts to Slack server-side, and syncs budgets from a linked sheet.
 *
 * Unit of analysis = LABEL (a franchise). Google + Meta roll up per label.
 *
 * DEPLOY: Deploy ▸ New deployment ▸ Web app ▸ Execute as: Me ▸ Access: Anyone.
 * Every code change needs Deploy ▸ Manage deployments ▸ ✏️ ▸ Version: New version.
 * Run testSlack() once in the editor to grant the external-request scope.
 *
 * ── CONFIG ──────────────────────────────────────────────────────────────── */
var GATEWAY_VERSION   = '2026-08-04';   // bump on each deploy; the app shows this in Settings so you can confirm a redeploy took
var SPREADSHEET_ID    = '16RYai7RW9By034nDapw7DKzVSRUdJIYk1B1ISNHYSLE';
var SHARED_SECRET     = 'cmp_02RvW0fsAIuSBBTRYmNQupEz';   // must match app + ads scripts
var SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/PUT/WEBHOOK/HERE';
var SLACK_BOT_TOKEN   = '';                            // xoxb-... with users:read (optional)
var SLACK_CHANNEL     = '#pacing';                     // display only
/* ─────────────────────────────────────────────────────────────────────────── */

var TABS = {
  google:     { name: 'Google_Feed',   header: ['Label','Spend','Conv','Clicks','Impr','Revenue','DailyBudget','Status','Updated'] },
  googleCampaigns:{ name: 'Google_Campaigns', header: ['Label','Campaign','BudgetId','DailyBudget','Status'] },
  dailyG:     { name: 'Daily_Google',  header: ['Date','Label','Spend','Conv','Clicks','Impr','Revenue'] },
  dailyGCamp: { name: 'Daily_Google_Campaign', header: ['Date','Label','Campaign','Spend','Conv','Clicks','Impr','Revenue'] },
  lsa:        { name: 'LSA_Feed',      header: ['Label','Spend','Conv','Status','Updated'] },
  dailyLsa:   { name: 'Daily_LSA',     header: ['Date','Label','Spend','Conv'] },
  metaDaily:  { name: 'Meta_Daily',    header: ['Date','Label','Campaign','Spend','Impressions','Clicks','Leads/Conv','Revenue'] },
  metaFeed:   { name: 'Meta_Feed',     header: ['Label','DailyBudget','Status','Updated'] },
  budgets:    { name: 'Budgets',       header: ['Label','Platform','Month','Total Budget','Updated'] },
  budgetLog:  { name: 'Budget_Changes',header: ['Timestamp','Label','Platform','Month','Old','New','Source','Ack'] },
  budgetQueue:{ name: 'Budget_Queue',  header: ['Timestamp','Label','NewDailyBudget','RequestedBy','Status','AppliedAt','Note'] },
  budgetMoves:{ name: 'Budget_Moves',  header: ['Id','Timestamp','Month','Franchise','From','To','Amount','By','Note','Void'] },
  groups:     { name: 'Groups',        header: ['Label','Group','Hidden','Type','Manager','Updated'] },
  dismissals: { name: 'Dismissals',    header: ['Label','Until','Updated'] },
  team:       { name: 'Team',          header: ['Name','SlackID'] },
  config:     { name: 'Config',        header: ['Key','Value','Updated'] }
};
// columns forced to plain-text so Sheets doesn't coerce them
var TEXT_COLS = {
  'Budgets':    ['Month'],
  'Dismissals': ['Until'],
  'Meta_Daily': []
};

/* ── HTTP entry points ───────────────────────────────────────────────────── */

function doGet(e) {
  var p = e.parameter || {};
  var cb = p.callback || 'callback';
  if (p.secret !== SHARED_SECRET) return jsonp_(cb, { ok: false, error: 'bad secret' });

  try {
    // 'data' is served as a pre-built JSON string (possibly from cache), so we
    // never re-stringify a ~400KB payload on a cache hit.
    if (p.action === 'data') {
      var str = getDataString_(String(p.fresh) === '1');
      return ContentService.createTextOutput(cb + '(' + str + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    if (p.action === 'campaignBulk') {
      var cstr = campaignBulkString_(String(p.fresh) === '1');
      return ContentService.createTextOutput(cb + '(' + cstr + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    var out;
    switch (p.action) {
      case 'campaignDaily': out = campaignDaily_(p.label); break;
      case 'setBudget':  out = setBudget_(p); break;
      case 'setConfig':  out = setConfig_(p.key, p.value); break;
      case 'setConfigBatch': out = setConfigBatch_(p.pairs); break;
      case 'syncBudgets':  out = syncBudgets_(p); break;
      case 'budgetTabs':   out = budgetTabs_(p.url); break;
      case 'budgetColumns':out = budgetColumns_(p.url, p.tab); break;
      case 'syncMeta':     out = syncMeta_(p); break;
      case 'metaPreview':  out = metaPreview_(p.url, p.tab, p.range); break;
      case 'queueBudget':  out = queueBudget_(p); break;
      case 'logMove':      out = logMove_(p); break;
      case 'voidMove':     out = voidMove_(p); break;
      case 'setType':    out = setGroupField_(p.label, 'Type', p.value); break;
      case 'setManager': out = setGroupField_(p.label, 'Manager', p.value); break;
      case 'setHidden':  out = setGroupField_(p.label, 'Hidden', p.value); break;
      case 'setGroup':   out = setGroupField_(p.label, 'Group', p.value); break;
      case 'setDismiss': out = setDismiss_(p.label, p.until); break;
      case 'ackBudget':  out = ackBudget_(p); break;
      case 'postSlack':  out = postSlack_(p.text); break;
      case 'sendEmail':  out = sendEmail_(p); break;
      case 'slackUsers': out = slackUsers_(); break;
      default:           out = { ok: false, error: 'unknown action' };
    }
    return jsonp_(cb, out);
  } catch (err) {
    return jsonp_(cb, { ok: false, error: String(err) });
  }
}

// Optional: lets a future Meta script POST rows instead of manual entry.
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.secret !== SHARED_SECRET) return json_({ ok: false, error: 'bad secret' });
    if (body.metaDaily) { writeMetaDaily_(body.metaDaily); }
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ── data read ───────────────────────────────────────────────────────────── */

// Per-campaign daily rows for ONE franchise (loaded on demand by the deep-dive,
// so the main data payload stays small).
function campaignDaily_(label) {
  if (!label) return { ok: false, error: 'no label' };
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var all = readTab_(ss, TABS.dailyGCamp);
  var lc = String(label).trim().toLowerCase();
  var rows = all.filter(function (r) { return String(r.Label).trim().toLowerCase() === lc; });
  return { ok: true, rows: rows };
}

/* ── cached payload ──────────────────────────────────────────────────────────
   The Google Ads script writes once a day, so the payload is cached and reused.
   Any write (budget sync, settings, dismissals) busts the cache instantly, and
   the app's Refresh button can force a rebuild with &fresh=1.
   NOTE: CacheService caps entries at 6 hours, so worst case the cache rebuilds a
   few times a day — every other load is served from memory. ── */
var CACHE_TTL   = 21600;   // 6h = CacheService maximum
var CACHE_CHUNK = 90000;   // stay under the 100KB-per-key limit

function cacheToken_() {
  var props = PropertiesService.getScriptProperties();
  var t = props.getProperty('cacheToken');
  if (!t) { t = String(Date.now()); props.setProperty('cacheToken', t); }
  return t;
}
function bustCache_() {
  PropertiesService.getScriptProperties().setProperty('cacheToken', String(Date.now()));
}
function readCache_(name) {
  var c = CacheService.getScriptCache(), t = cacheToken_(), base = (name || 'pace') + '_' + t;
  var n = c.get(base + '_n');
  if (!n) return null;
  n = Number(n);
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(base + '_' + i);
  var got = c.getAll(keys), parts = [];
  for (var j = 0; j < n; j++) {
    var v = got[base + '_' + j];
    if (v == null) return null;           // partial expiry → treat as miss
    parts.push(v);
  }
  return parts.join('');
}
function writeCache_(name, str) {
  try {
    var c = CacheService.getScriptCache(), t = cacheToken_(), base = (name || 'pace') + '_' + t;
    var obj = {}, i = 0, k = 0;
    for (i = 0; i < str.length; i += CACHE_CHUNK) obj[base + '_' + (k++)] = str.substring(i, i + CACHE_CHUNK);
    obj[base + '_n'] = String(k);
    c.putAll(obj, CACHE_TTL);
  } catch (e) { /* oversized or unavailable → just skip caching */ }
}

// Budgets auto-sync at most ONCE PER DAY on the data path (a quick read of the
// budget sheet). Meta is deliberately NOT synced here — reading the big DataSlayer
// block is slow, so it runs in the background on a daily trigger (dailyAutoSync_)
// and via the manual "Sync Meta now" button. This keeps app loads fast.
function maybeAutoSync_(cfg) {
  if (String(cfg.budgetAutoSync) !== 'false' &&
      cfg.budgetSheetUrl && cfg.budgetLabelCol !== undefined &&
      String(cfg.lastBudgetSync || '') !== currentDate_()) {
    ['google', 'lsa', 'meta'].forEach(function (ch) {
      var platform = ch === 'lsa' ? 'LSA' : ch === 'meta' ? 'Meta' : 'Google';
      if (!cfg['budget' + platform + 'Col']) return;                  // channel not mapped
      try { syncBudgets_({ url: cfg.budgetSheetUrl, tab: cfg.budgetTab, channel: ch, source: 'auto' }); }
      catch (e) { /* leave that channel's snapshot in place */ }
    });
  }
}

// Run ONCE from the Apps Script editor to schedule the daily background sync, so no
// user request ever waits on the DataSlayer read. Safe to re-run (replaces itself).
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyAutoSync_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyAutoSync_').timeBased().everyDays(1).atHour(6).create();
  return 'Daily background sync scheduled (~6am).';
}

// The scheduled background job: refresh budgets (all mapped channels) + Meta once.
function dailyAutoSync_() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var cfg = readConfig_(ss);
  if (cfg.budgetSheetUrl && cfg.budgetLabelCol !== undefined) {
    ['google', 'lsa', 'meta'].forEach(function (ch) {
      var platform = ch === 'lsa' ? 'LSA' : ch === 'meta' ? 'Meta' : 'Google';
      if (!cfg['budget' + platform + 'Col']) return;
      try { syncBudgets_({ url: cfg.budgetSheetUrl, tab: cfg.budgetTab, channel: ch, source: 'auto' }); }
      catch (e) {}
    });
  }
  if (String(cfg.metaAutoSync) !== 'false' && cfg.metaSheetUrl) {
    try { syncMeta_({ source: 'auto' }); } catch (e) {}
  }
  bustCache_();
}

function getDataString_(force) {
  if (!force) {
    var hit = readCache_('pace');
    if (hit) return hit;
  }
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  maybeAutoSync_(readConfig_(ss));

  var payload = {
    ok: true,
    gatewayVersion: GATEWAY_VERSION,
    generatedAt: new Date().toISOString(),
    google:     readTab_(ss, TABS.google),
    googleCampaigns: readTab_(ss, TABS.googleCampaigns),
    dailyG:     readTab_(ss, TABS.dailyG),
    lsa:        readTab_(ss, TABS.lsa),
    dailyLsa:   readTab_(ss, TABS.dailyLsa),
    metaDaily:  readTab_(ss, TABS.metaDaily),
    metaFeed:   readTab_(ss, TABS.metaFeed),
    budgetQueue:readTab_(ss, TABS.budgetQueue),
    budgetMoves:readTab_(ss, TABS.budgetMoves),
    budgets:    readTab_(ss, TABS.budgets),
    budgetLog:  readTab_(ss, TABS.budgetLog),
    groups:     readTab_(ss, TABS.groups),
    dismissals: readTab_(ss, TABS.dismissals),
    team:       readTab_(ss, TABS.team),
    config:     readConfig_(ss),
    slackChannel: SLACK_CHANNEL
  };
  var str = JSON.stringify(payload);
  writeCache_('pace', str);
  return str;
}

/* Columnar bundle of ALL per-campaign daily rows. The app prefetches this in the
   background right after load, so opening any deep-dive is instant. Columnar
   (names sent once, rows as arrays) keeps it ~60% smaller than object rows. */
function campaignBulkString_(force) {
  if (!force) {
    var hit = readCache_('camp');
    if (hit) return hit;
  }
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var rows = readTab_(ss, TABS.dailyGCamp);
  var labels = [], li = {}, camps = [], ci = {}, out = [];
  rows.forEach(function (r) {
    var l = String(r.Label || '').trim(), c = String(r.Campaign || '—').trim() || '—';
    if (!l) return;
    if (li[l] === undefined) { li[l] = labels.length; labels.push(l); }
    if (ci[c] === undefined) { ci[c] = camps.length; camps.push(c); }
    out.push([String(r.Date).slice(0, 10), li[l], ci[c],
              Number(r.Spend) || 0, Number(r.Conv) || 0, Number(r.Clicks) || 0, Number(r.Revenue) || 0]);
  });
  var str = JSON.stringify({ ok: true, labels: labels, camps: camps, rows: out });
  writeCache_('camp', str);
  return str;
}

function readTab_(ss, def) {
  var tab = ss.getSheetByName(def.name);
  if (!tab) { tab = ss.insertSheet(def.name); ensureHeader_(tab, def); return []; }
  ensureHeader_(tab, def);
  var values = tab.getDataRange().getValues();
  if (values.length < 2) return [];
  var head = values[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    var obj = {};
    for (var c = 0; c < head.length; c++) obj[head[c]] = normalize_(row[c]);
    out.push(obj);
  }
  return out;
}

function readConfig_(ss) {
  var rows = readTab_(ss, TABS.config);
  var cfg = { googleFee: 0.25, metaFee: 0.20, budgetSheetUrl: '',
              metaSheetUrl: '', metaTab: '', metaRange: '', metaAutoSync: true,
              emailTo: 'aric@contentmassive.com,larry@contentmassive.com,manuel@contentmassive.com', budgetAutoSync: true,
              lsaFee: 0.20, lsaMonths: 1,
              alertMinLeads: 10, alertLeadsWarn: 0.25, alertLeadsCrit: 0.50,
              alertCplWarn: 0.30, alertCplCrit: 0.60 };
  rows.forEach(function (r) {
    var k = r.Key, v = r.Value;
    if (k === 'googleFee' || k === 'metaFee' || k === 'lsaFee' || k === 'lsaMonths' || k === 'alertMinLeads' ||
        k === 'alertLeadsWarn' || k === 'alertLeadsCrit' ||
        k === 'alertCplWarn' || k === 'alertCplCrit') cfg[k] = Number(v);
    else if (k) cfg[k] = v;
  });
  return cfg;
}

function normalize_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}

/* ── writes ──────────────────────────────────────────────────────────────── */

function setBudget_(p) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.budgets.name) || ss.insertSheet(TABS.budgets.name);
  ensureHeader_(tab, TABS.budgets);
  var label = String(p.label), platform = String(p.platform || 'Google'), month = String(p.month);
  var amount = Number(p.amount);
  var values = tab.getDataRange().getValues();
  var head = headIndex_(values[0]);
  var found = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][head.Label]).trim() === label &&
        String(values[r][head.Platform]).trim().toLowerCase() === platform.toLowerCase() &&
        String(values[r][head.Month]).trim() === month) { found = r + 1; break; }
  }
  var rowVals = [label, platform, month, amount, new Date()];
  if (found > 0) tab.getRange(found, 1, 1, rowVals.length).setValues([rowVals]);
  else tab.appendRow(rowVals);
  forceText_(tab, TABS.budgets);
  bustCache_();
  return { ok: true };
}

function setConfig_(key, value) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.config.name) || ss.insertSheet(TABS.config.name);
  ensureHeader_(tab, TABS.config);
  var values = tab.getDataRange().getValues();
  var found = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]).trim() === key) { found = r + 1; break; }
  }
  var rowVals = [key, value, new Date()];
  if (found > 0) tab.getRange(found, 1, 1, 3).setValues([rowVals]);
  else tab.appendRow(rowVals);
  bustCache_();
  return { ok: true };
}

// Accepts a JSON object of key/values from the app in a single request.
function setConfigBatch_(pairsJson) {
  var pairs;
  try { pairs = JSON.parse(pairsJson || '{}'); }
  catch (e) { return { ok: false, error: 'bad pairs json' }; }
  if (!pairs || typeof pairs !== 'object') return { ok: false, error: 'no pairs' };
  return setConfigMany_(pairs);
}

// Write several config keys in ONE read + ONE write.
function setConfigMany_(pairs) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.config.name) || ss.insertSheet(TABS.config.name);
  ensureHeader_(tab, TABS.config);
  var raw = tab.getDataRange().getValues();
  var rows = raw.map(function (r) { return [r[0], r[1], r[2]]; });
  if (!rows.length) rows = [TABS.config.header.slice(0, 3)];
  var idx = {};
  for (var r = 1; r < rows.length; r++) idx[String(rows[r][0]).trim()] = r;
  var now = new Date();
  for (var k in pairs) {
    if (idx[k] !== undefined) { rows[idx[k]][1] = pairs[k]; rows[idx[k]][2] = now; }
    else rows.push([k, pairs[k], now]);
  }
  tab.getRange(1, 1, rows.length, 3).setValues(rows);
  bustCache_();
  return { ok: true };
}

function setGroupField_(label, field, value) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.groups.name) || ss.insertSheet(TABS.groups.name);
  ensureHeader_(tab, TABS.groups);
  var values = tab.getDataRange().getValues();
  var head = headIndex_(values[0]);
  var found = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][head.Label]).trim() === String(label).trim()) { found = r + 1; break; }
  }
  if (found < 0) {
    tab.appendRow([label, '', '', '', '', new Date()]);
    found = tab.getLastRow();
    values = tab.getDataRange().getValues();
    head = headIndex_(values[0]);
  }
  var col = head[field] + 1;
  tab.getRange(found, col).setValue(value);
  tab.getRange(found, head.Updated + 1).setValue(new Date());
  bustCache_();
  return { ok: true };
}

function setDismiss_(label, until) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.dismissals.name) || ss.insertSheet(TABS.dismissals.name);
  ensureHeader_(tab, TABS.dismissals);
  var values = tab.getDataRange().getValues();
  var found = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]).trim() === String(label).trim()) { found = r + 1; break; }
  }
  var rowVals = [label, until, new Date()];
  if (found > 0) tab.getRange(found, 1, 1, 3).setValues([rowVals]);
  else tab.appendRow(rowVals);
  forceText_(tab, TABS.dismissals);
  bustCache_();
  return { ok: true };
}

// Mark budget-change rows as reviewed. Pass all=1 to clear everything pending,
// or label+date to clear one. The Ack column keeps a permanent record of who
// reviewed it and when — nothing is deleted.
function ackBudget_(p) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.budgetLog.name);
  if (!tab) return { ok: true, acked: 0 };
  var values = tab.getDataRange().getValues();
  if (values.length < 2) return { ok: true, acked: 0 };
  var head = headIndex_(values[0]);
  if (head.Ack === undefined) return { ok: false, error: 'no Ack column' };

  var all   = String(p.all) === '1';
  var label = String(p.label || '').trim().toLowerCase();
  var date  = String(p.date || '').trim();
  var who   = String(p.by || 'team');
  var mark  = who + ' · ' + currentDate_();
  var col = [], n = 0;

  for (var r = 1; r < values.length; r++) {
    var cur = values[r][head.Ack];
    if (cur) { col.push([cur]); continue; }                 // already reviewed
    var rowLabel = String(values[r][head.Label]).trim().toLowerCase();
    var ts = values[r][head.Timestamp];
    var rowDate = (ts instanceof Date)
      ? Utilities.formatDate(ts, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(ts).slice(0, 10);
    var hit = all || (rowLabel === label && (!date || rowDate === date));
    if (hit) { col.push([mark]); n++; } else { col.push(['']); }
  }
  if (col.length) tab.getRange(2, head.Ack + 1, col.length, 1).setValues(col);
  bustCache_();
  return { ok: true, acked: n };
}

function writeMetaDaily_(rows) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.metaDaily.name) || ss.insertSheet(TABS.metaDaily.name);
  ensureHeader_(tab, TABS.metaDaily);
  rows.forEach(function (r) {
    tab.appendRow([r.date, r.label, r.campaign || '', r.spend || 0, r.impressions || 0,
                   r.clicks || 0, r.conv || 0, r.revenue || 0]);
  });
}

/* ── Meta sync from the DataSlayer sheet (column-mapped by header) ────────────
 * The DataSlayer query writes a daily block (Date … On Facebook Leads) somewhere
 * in a wide tab; we read just that column block (e.g. AH:AP). Franchise = the
 * Campaign tag, so only campaigns carrying a tag are imported — untagged ones are
 * skipped (they show as inactive). Meta_Daily is REWRITTEN every sync (rolling
 * window, like the Google feed), so re-runs never double-count.
 * ─────────────────────────────────────────────────────────────────────────── */

// 'AH:AP' -> { start: 34, width: 9 }  (1-based start column). null if malformed.
function colBlock_(range) {
  var m = String(range || '').toUpperCase().replace(/\$/g, '').match(/^([A-Z]+)\s*:\s*([A-Z]+)$/);
  if (!m) return null;
  var a = colToNum_(m[1]), b = colToNum_(m[2]);
  if (!a || !b) return null;
  var start = Math.min(a, b), end = Math.max(a, b);
  return { start: start, width: end - start + 1 };
}
function colToNum_(s) {
  s = String(s || '').toUpperCase(); var n = 0;
  for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i) - 64; if (c < 1 || c > 26) return 0; n = n * 26 + c; }
  return n;
}

// Locate each KPI column within the block's header row (by name, with a few aliases).
function metaColMap_(H) {
  function pick(al) { for (var i = 0; i < al.length; i++) { if (H[al[i]] !== undefined) return H[al[i]]; } return -1; }
  var map = {
    date:     pick(['Date', 'Day']),
    tag:      pick(['Campaign tags', 'Campaign tag', 'Tags', 'Tag']),
    campaign: pick(['Campaign name', 'Campaign']),
    spend:    pick(['Total Cost', 'Cost', 'Amount spent', 'Spend']),
    impr:     pick(['Impressions', 'Impr']),
    clicks:   pick(['Clicks', 'Link clicks']),
    webConv:  pick(['Website conversions', 'Web conversions', 'Website Conversions']),
    fbLeads:  pick(['On Facebook Leads', 'On-Facebook Leads', 'Facebook Leads', 'Leads']),
    dailyBudget: pick(['Daily budget', 'Daily Budget', 'Budget']),         // optional
    status:      pick(['Campaign status', 'Status', 'Effective status'])   // optional
  };
  var missing = [];
  ['date', 'tag', 'campaign', 'spend'].forEach(function (k) { if (map[k] < 0) missing.push(k); });
  map.missing = missing;
  return map;
}

// True for a tag cell that means "no franchise" (skip the row).
function metaNoTag_(tag) {
  var t = String(tag || '').trim();
  return t === '' || t === '--' || t.toLowerCase() === 'n/a';
}

function metaSource_(p, cfg) {
  return {
    url:   p.url   || cfg.metaSheetUrl,
    tab:   p.tab   || cfg.metaTab   || 'QUERY - RAW DATA',
    range: p.range || cfg.metaRange || 'AH:AR'
  };
}

// Read-only peek so the app can show what WOULD import before committing.
function metaPreview_(url, tab, range) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var s = metaSource_({ url: url, tab: tab, range: range }, readConfig_(ss));
  if (!s.url) return { ok: false, error: 'no Meta sheet url' };
  var src;
  try { src = SpreadsheetApp.openByUrl(s.url); }
  catch (e) { return { ok: false, error: 'cannot open Meta sheet (share it with this account): ' + e }; }
  var t = src.getSheetByName(s.tab);
  if (!t) return { ok: false, error: 'tab "' + s.tab + '" not found' };
  var block = colBlock_(s.range);
  if (!block) return { ok: false, error: 'bad range "' + s.range + '" (use e.g. AH:AR)' };
  var lastRow = t.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'tab "' + s.tab + '" has no rows' };

  var values = t.getRange(1, block.start, Math.min(lastRow, 1000), block.width).getValues();  // sample
  var col = metaColMap_(headIndex_(values[0].map(function (h) { return String(h).trim(); })));
  if (col.missing.length) return { ok: false, columns: values[0], error: 'missing columns in ' + s.range + ': ' + col.missing.join(', ') };

  var tags = {}, tagged = 0, noTag = 0;
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (String(row[col.campaign] || '').trim() === '' && parseNumber_(row[col.spend]) == null) continue;  // spacer
    if (metaNoTag_(row[col.tag])) { noTag++; continue; }
    tags[String(row[col.tag]).trim()] = true; tagged++;
  }
  return { ok: true, columns: values[0], franchises: Object.keys(tags).sort(), tagged: tagged, noTag: noTag };
}

function syncMeta_(p) {
  p = p || {};
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var s = metaSource_(p, readConfig_(ss));
  if (!s.url) return { ok: false, error: 'no Meta sheet url' };

  var src;
  try { src = SpreadsheetApp.openByUrl(s.url); }
  catch (e) { return { ok: false, error: 'cannot open Meta sheet (share it with this account): ' + e }; }
  var tab = src.getSheetByName(s.tab);
  if (!tab) return { ok: false, error: 'tab "' + s.tab + '" not found' };
  var block = colBlock_(s.range);
  if (!block) return { ok: false, error: 'bad range "' + s.range + '" (use e.g. AH:AR)' };
  var lastRow = tab.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'tab "' + s.tab + '" has no rows' };

  var values = tab.getRange(1, block.start, lastRow, block.width).getValues();
  var col = metaColMap_(headIndex_(values[0].map(function (h) { return String(h).trim(); })));
  if (col.missing.length) return { ok: false, error: 'missing columns in ' + s.range + ': ' + col.missing.join(', ') };

  var out = [], skipped = 0, tags = {};
  var feedByDate = {};   // date -> { tag -> {budget, active} }  (for the latest-day feed)
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var camp = String(row[col.campaign] || '').trim();
    var spendRaw = parseNumber_(row[col.spend]);
    if (!camp && spendRaw == null) continue;                       // blank spacer row
    if (metaNoTag_(row[col.tag])) { skipped++; continue; }         // no tag → inactive, excluded
    var date = normalize_(row[col.date]);
    if (!date) continue;
    var tag = String(row[col.tag]).trim();
    var impr = col.impr   < 0 ? 0 : (parseNumber_(row[col.impr])   || 0);
    var clk  = col.clicks < 0 ? 0 : (parseNumber_(row[col.clicks]) || 0);
    var conv = (col.webConv < 0 ? 0 : (parseNumber_(row[col.webConv]) || 0)) +
               (col.fbLeads < 0 ? 0 : (parseNumber_(row[col.fbLeads]) || 0));
    out.push([date, tag, camp, round2_(spendRaw || 0), impr, clk, round2_(conv), 0]);
    tags[tag] = true;

    // feed: per franchise per day, sum ACTIVE campaigns' daily budget + set active flag
    var isActive = col.status < 0 ? true : (String(row[col.status] || '').trim().toUpperCase() === 'ACTIVE');
    var db = col.dailyBudget < 0 ? 0 : (parseNumber_(row[col.dailyBudget]) || 0);
    var fb = (feedByDate[date] = feedByDate[date] || {});
    var ft = (fb[tag] = fb[tag] || { budget: 0, active: false });
    if (isActive) { ft.budget += db; ft.active = true; }
  }

  // Full rewrite of Meta_Daily (rolling window; never stacks duplicates on re-sync).
  var mt = ss.getSheetByName(TABS.metaDaily.name) || ss.insertSheet(TABS.metaDaily.name);
  mt.clearContents();
  var body = [TABS.metaDaily.header].concat(out);
  mt.getRange(1, 1, body.length, TABS.metaDaily.header.length).setValues(body);
  forceText_(mt, TABS.metaDaily);

  // Meta feed = each franchise's status/daily-budget from the last few days of data.
  // A franchise is active if any of its campaigns is ACTIVE in that window; daily budget
  // = its active campaigns' budget on its most recent active day. Franchises with no rows
  // in the window aren't written, so the app treats them as not running (paused).
  var feedRows = [], now = new Date();
  var recent = Object.keys(feedByDate).sort().slice(-3);   // last 3 days present in the data
  var feedAgg = {};                                        // tag -> { budget, active, day }
  recent.forEach(function (d) {
    var fmap = feedByDate[d];
    Object.keys(fmap).forEach(function (tg) {
      var cur = feedAgg[tg] = feedAgg[tg] || { budget: 0, active: false, day: '' };
      if (fmap[tg].active) { cur.active = true; if (d >= cur.day) { cur.budget = fmap[tg].budget; cur.day = d; } }
    });
  });
  Object.keys(feedAgg).sort().forEach(function (tg) {
    feedRows.push([tg, round2_(feedAgg[tg].budget), feedAgg[tg].active ? 'active' : 'paused', now]);
  });
  var mf = ss.getSheetByName(TABS.metaFeed.name) || ss.insertSheet(TABS.metaFeed.name);
  mf.clearContents();
  var fbody = [TABS.metaFeed.header].concat(feedRows);
  mf.getRange(1, 1, fbody.length, TABS.metaFeed.header.length).setValues(fbody);

  setConfigMany_({ metaSheetUrl: s.url, metaTab: s.tab, metaRange: s.range, lastMetaSync: currentDate_() });
  bustCache_();
  return { ok: true, synced: out.length, franchises: Object.keys(tags).length, skipped: skipped, feed: feedRows.length };
}

function round2_(n) { return Math.round(Number(n) * 100) / 100; }

/* ── budget queue (pacing auto-adjust) ───────────────────────────────────────
 * The app writes a requested per-franchise daily budget here; the hourly Google
 * Ads "budget_apply" script reads PENDING rows, applies them to campaigns within
 * safety limits, and writes back status + emails a summary. We supersede any older
 * pending request for the same franchise so only the newest is applied. */
function queueBudget_(p) {
  var label = String((p && p.label) || '').trim();
  var amt = Number(p && p.amount);
  if (!label) return { ok: false, error: 'no franchise' };
  if (isNaN(amt) || amt < 0) return { ok: false, error: 'bad amount' };
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.budgetQueue.name) || ss.insertSheet(TABS.budgetQueue.name);
  ensureHeader_(tab, TABS.budgetQueue);
  var vals = tab.getDataRange().getValues();
  var h = headIndex_(vals[0]);
  var changed = false;
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][h.Label]).trim().toLowerCase() === label.toLowerCase() &&
        String(vals[i][h.Status]).trim().toLowerCase() === 'pending') {
      vals[i][h.Status] = 'superseded'; vals[i][h.Note] = 'replaced by a newer request'; changed = true;
    }
  }
  if (changed) tab.getRange(1, 1, vals.length, vals[0].length).setValues(vals);
  tab.appendRow([new Date(), label, round2_(amt), String((p && p.by) || ''), 'pending', '', '']);
  bustCache_();
  return { ok: true };
}

/* ── budget moves (channel reallocation ledger) ──────────────────────────────
 * A move records that $Amount of a franchise's monthly budget was shifted from
 * one channel to another (e.g. Google → LSA). It NEVER edits the master billing
 * sheet — the client's total bill is unchanged. The app applies the net move on
 * top of the synced budgets so per-channel pacing reflects reality. Reversible
 * by voiding the row. */
function logMove_(p) {
  var month = String((p && p.month) || '').trim();
  var fr = String((p && p.franchise) || '').trim();
  var from = String((p && p.from) || '').trim();
  var to = String((p && p.to) || '').trim();
  var amt = Number(p && p.amount);
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: 'bad month (YYYY-MM)' };
  if (!fr) return { ok: false, error: 'no franchise' };
  if (!from || !to) return { ok: false, error: 'need from + to channel' };
  if (from.toLowerCase() === to.toLowerCase()) return { ok: false, error: 'from and to are the same channel' };
  if (isNaN(amt) || amt <= 0) return { ok: false, error: 'bad amount' };
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.budgetMoves.name) || ss.insertSheet(TABS.budgetMoves.name);
  ensureHeader_(tab, TABS.budgetMoves);
  var id = 'mv' + (new Date()).getTime();
  var row = tab.getLastRow() + 1;
  tab.appendRow([id, new Date(), month, fr, from, to, round2_(amt), String((p && p.by) || ''), String((p && p.note) || ''), '']);
  // Month is column 3 — force it to plain text so Sheets doesn't coerce '2026-08' into a date.
  tab.getRange(row, 3).setNumberFormat('@').setValue(month);
  bustCache_();
  return { ok: true, id: id };
}

function voidMove_(p) {
  var id = String((p && p.id) || '').trim();
  if (!id) return { ok: false, error: 'no id' };
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var tab = ss.getSheetByName(TABS.budgetMoves.name);
  if (!tab) return { ok: false, error: 'no moves tab' };
  var vals = tab.getDataRange().getValues();
  var h = headIndex_(vals[0]);
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][h.Id]).trim() === id) {
      vals[i][h.Void] = 'TRUE';
      tab.getRange(i + 1, h.Void + 1).setValue('TRUE');
      bustCache_();
      return { ok: true };
    }
  }
  return { ok: false, error: 'id not found' };
}

/* ── budget sync from a linked sheet (column-mapped) ─────────────────────── */

// List the tab names in the linked workbook so the app can let you pick one.
function budgetTabs_(url) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (!url) url = readConfig_(ss).budgetSheetUrl;
  if (!url) return { ok: false, error: 'no budget sheet url' };
  var src;
  try { src = SpreadsheetApp.openByUrl(url); }
  catch (e) { return { ok: false, error: 'cannot open budget sheet (share it with this account): ' + e }; }
  var names = src.getSheets().map(function (s) { return s.getName(); });
  return { ok: true, tabs: names };
}

// Read a chosen tab's header row + a few sample rows.
function budgetColumns_(url, tabName) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  if (!url) url = readConfig_(ss).budgetSheetUrl;
  if (!url) return { ok: false, error: 'no budget sheet url' };
  var src;
  try { src = SpreadsheetApp.openByUrl(url); }
  catch (e) { return { ok: false, error: 'cannot open budget sheet (share it with this account): ' + e }; }
  var tab = tabName ? src.getSheetByName(tabName) : (src.getSheetByName('Budgets') || src.getSheets()[0]);
  if (!tab) return { ok: false, error: 'tab "' + tabName + '" not found' };
  var values = tab.getDataRange().getValues();
  if (!values.length) return { ok: false, error: 'tab "' + tab.getName() + '" is empty' };
  var header = values[0].map(function (h) { return String(h); });
  var sample = values.slice(1, 4).map(function (row) {
    return row.map(function (c) { return c instanceof Date
      ? Utilities.formatDate(c, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(c); });
  });
  return { ok: true, tab: tab.getName(), columns: header, sample: sample };
}

// Sync using chosen column indexes. Writes rows for ONE month + platform,
// replacing any existing rows for that month+platform (so mid-month changes and
// month-to-month picks both work cleanly). Other months are left untouched.
function syncBudgets_(p) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var cfg = readConfig_(ss);
  var url = p.url || cfg.budgetSheetUrl;
  if (!url) return { ok: false, error: 'no budget sheet url' };

  // channel drives which column spec + platform name + how the month is keyed
  var channel  = String(p.channel || 'google').toLowerCase();
  var platform = channel === 'lsa' ? 'LSA' : channel === 'meta' ? 'Meta' : 'Google';
  var colKey   = 'budget' + platform + 'Col';                 // budgetGoogleCol / budgetLsaCol / budgetMetaCol

  var labelCol  = p.labelCol != null && p.labelCol !== '' ? Number(p.labelCol) : Number(cfg.budgetLabelCol);
  // budgetCol can be a single index OR a comma list of month columns (newest last).
  // Each column maps to a month; LSA also sums them into a running 'pool'.
  var budgetSpec = (p.budgetCol != null && p.budgetCol !== '') ? String(p.budgetCol) : String(cfg[colKey] || '');
  var amountCols = budgetSpec.split(',').map(function (x) { return Number(String(x).trim()); }).filter(function (x) { return !isNaN(x); });
  if (isNaN(labelCol) || !amountCols.length) {
    return { ok: false, error: 'pick a label column and a budget column first' };
  }

  var src;
  try { src = SpreadsheetApp.openByUrl(url); }
  catch (e) { return { ok: false, error: 'cannot open budget sheet: ' + e }; }
  var tabName = p.tab || cfg.budgetTab || '';
  var srcTab = tabName ? src.getSheetByName(tabName) : (src.getSheetByName('Budgets') || src.getSheets()[0]);
  if (!srcTab) return { ok: false, error: 'tab "' + tabName + '" not found' };
  var values = srcTab.getDataRange().getValues();
  if (values.length < 2) return { ok: false, error: 'tab "' + srcTab.getName() + '" has no rows' };

  // Map each budget column to a MONTH — chronological, with the LAST column = the
  // current month (append the newest month at the end). A single column is just the
  // current month. This preserves each past month's billed instead of overwriting it.
  // LSA additionally keeps a summed 'pool' row for its burn-down view.
  var curMonth = p.month || currentMonth_();
  var nCols = amountCols.length;
  var colMonth = amountCols.map(function (_, i) { return monthOffset_(curMonth, -(nCols - 1 - i)); });

  var byMonth = {};                     // month -> [{label, amount}]
  colMonth.forEach(function (m) { byMonth[m] = []; });
  var poolRows = [];                    // LSA only: sum across the listed months
  for (var r = 1; r < values.length; r++) {
    var label = String(values[r][labelCol] || '').trim();
    if (!label) continue;
    var poolAmt = 0, anyPool = false;
    for (var ci = 0; ci < amountCols.length; ci++) {
      var v = parseNumber_(values[r][amountCols[ci]]);
      if (v == null) continue;
      byMonth[colMonth[ci]].push({ label: label, amount: v });
      poolAmt += v; anyPool = true;
    }
    if (channel === 'lsa' && anyPool) poolRows.push({ label: label, amount: poolAmt });
  }
  if (channel === 'lsa') byMonth['pool'] = poolRows;

  // change detection: only for the CURRENT month (editing history shouldn't fire alerts)
  var existing = readBudgetMonth_(ss, platform, curMonth);
  var changes = [];
  (byMonth[curMonth] || []).forEach(function (x) {
    var k = x.label.toLowerCase();
    if (existing.hasOwnProperty(k) && Math.abs(existing[k] - x.amount) >= 0.01) {
      changes.push({ label: x.label, old: existing[k], now: x.amount });
    }
  });

  writeBudgetMonths_(ss, platform, byMonth);   // one rebuild, replacing every listed (platform, month) + LSA pool

  if (changes.length) logBudgetChanges_(ss, changes, platform, curMonth, p.source || 'manual');

  // remember the picks per channel (one batched write)
  var save = {
    budgetSheetUrl: url,
    budgetTab:      srcTab.getName(),
    budgetLabelCol: labelCol,
    lastBudgetSync: currentDate_()
  };
  save[colKey] = budgetSpec;
  if (channel === 'lsa') save.lsaMonths = amountCols.length;
  setConfigMany_(save);

  return { ok: true, synced: (byMonth[curMonth] || []).length, month: curMonth,
           platform: platform, channel: channel, changed: changes.length, months: colMonth.length };
}

// Shift a 'YYYY-MM' month string by delta months.
function monthOffset_(ym, delta) {
  var p = ym.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1 + delta, 1);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
}

// Existing budget amounts for one (platform, month): label(lower) -> amount.
function readBudgetMonth_(ss, platform, month) {
  var out = {};
  var bt = ss.getSheetByName(TABS.budgets.name);
  if (!bt) return out;
  var v = bt.getDataRange().getValues();
  if (v.length < 2) return out;
  var h = headIndex_(v[0]);
  for (var i = 1; i < v.length; i++) {
    if (String(v[i][h.Platform]).trim().toLowerCase() === platform.toLowerCase() &&
        String(v[i][h.Month]).trim() === month) {
      out[String(v[i][h.Label]).trim().toLowerCase()] = Number(v[i][h['Total Budget']]) || 0;
    }
  }
  return out;
}

// Rebuild the Budgets tab, replacing every (platform, month) row for the months that
// appear as keys in byMonth (including 'pool'); all other rows are left untouched.
function writeBudgetMonths_(ss, platform, byMonth) {
  var bt = ss.getSheetByName(TABS.budgets.name) || ss.insertSheet(TABS.budgets.name);
  ensureHeader_(bt, TABS.budgets);
  var bvals = bt.getDataRange().getValues();
  var head = headIndex_(bvals[0]);
  var keep = [TABS.budgets.header];
  for (var i = 1; i < bvals.length; i++) {
    var row = bvals[i];
    if (row.every(function (c) { return c === '' || c === null; })) continue;
    var samePlat = String(row[head.Platform]).trim().toLowerCase() === platform.toLowerCase();
    var m = String(row[head.Month]).trim();
    if (samePlat && byMonth.hasOwnProperty(m)) continue;   // replaced below
    keep.push(row);
  }
  var now = new Date();
  Object.keys(byMonth).forEach(function (m) {
    byMonth[m].forEach(function (x) { keep.push([x.label, platform, m, x.amount, now]); });
  });
  bt.clearContents();
  bt.getRange(1, 1, keep.length, TABS.budgets.header.length).setValues(keep);
  forceText_(bt, TABS.budgets);
}

// Append change rows to Budget_Changes and email the flag recipients.
function logBudgetChanges_(ss, changes, platform, month, source) {
  var tab = ss.getSheetByName(TABS.budgetLog.name) || ss.insertSheet(TABS.budgetLog.name);
  ensureHeader_(tab, TABS.budgetLog);
  var now = new Date();
  var rows = changes.map(function (c) {
    return [now, c.label, platform, month, c.old, c.now, source, ''];
  });
  tab.getRange(tab.getLastRow() + 1, 1, rows.length, TABS.budgetLog.header.length).setValues(rows);

  // email (only auto-detected changes email by default; manual is logged silently)
  if (source === 'auto') {
    var to = readConfig_(ss).emailTo;
    if (to) {
      var lines = changes.map(function (c) {
        return '• ' + c.label + ': $' + fmtNum_(c.old) + ' → $' + fmtNum_(c.now)
          + '  (Δ ' + (c.now >= c.old ? '+' : '') + fmtNum_(c.now - c.old) + ')';
      }).join('\n');
      try {
        MailApp.sendEmail({
          to: to,
          subject: 'Budget change detected — ' + changes.length + ' account' + (changes.length > 1 ? 's' : '') + ' (' + platform + ', ' + month + ')',
          body: 'The live budget sheet changed and the pacing tool picked it up automatically:\n\n'
            + lines + '\n\nThese are also flagged in the tool under "Budget changes".'
        });
      } catch (e) { /* logged regardless */ }
    }
  }
}
function fmtNum_(n) { return (Math.round(Number(n) * 100) / 100).toLocaleString(); }

function parseNumber_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}
function currentMonth_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
}
function currentDate_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/* ── Slack ───────────────────────────────────────────────────────────────── */

function postSlack_(text) {
  if (!text) return { ok: false, error: 'empty text' };
  var res = UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ text: text }), muteHttpExceptions: true
  });
  return { ok: res.getResponseCode() === 200, code: res.getResponseCode() };
}

// Email a flag note as an HTML report (tables render for the team) plus a plain
// text fallback. The app sends compact JSON; the HTML is built here so the
// request URL stays small.
function sendEmail_(p) {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var to = p.to || readConfig_(ss).emailTo;
  if (!to) return { ok: false, error: 'no recipients configured' };
  var d = {};
  try { d = JSON.parse(p.payload || '{}'); }
  catch (e) { return { ok: false, error: 'bad payload: ' + e }; }
  if (!d.label) return { ok: false, error: 'empty payload' };
  try {
    MailApp.sendEmail({
      to: to,
      subject: p.subject || ('Pacing: ' + d.label),
      body: flagText_(d),
      htmlBody: flagHtml_(d)
    });
    return { ok: true, to: to };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

var MAIL_INK = '#2b2a35', MAIL_MUTED = '#6c6b78', MAIL_LINE = '#e4e4ea', MAIL_ACCENT = '#f26722';

function flagHtml_(d) {
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function th(t) { return '<th style="text-align:right;padding:7px 10px;border-bottom:2px solid ' + MAIL_LINE +
    ';font:600 11px Arial,sans-serif;letter-spacing:.5px;text-transform:uppercase;color:' + MAIL_MUTED + '">' + esc(t) + '</th>'; }
  function td(t, alignLeft) { return '<td style="text-align:' + (alignLeft ? 'left' : 'right') +
    ';padding:7px 10px;border-bottom:1px solid ' + MAIL_LINE + ';font:13px Arial,sans-serif;color:' + MAIL_INK + '">' + esc(t) + '</td>'; }
  function table(headers, rows) {
    if (!rows || !rows.length) return '';
    var h = '<tr>' + headers.map(function (x, i) { return i === 0
      ? '<th style="text-align:left;padding:7px 10px;border-bottom:2px solid ' + MAIL_LINE +
        ';font:600 11px Arial,sans-serif;letter-spacing:.5px;text-transform:uppercase;color:' + MAIL_MUTED + '">' + esc(x) + '</th>'
      : th(x); }).join('') + '</tr>';
    var b = rows.map(function (r) {
      return '<tr>' + r.map(function (c, i) { return td(c, i === 0); }).join('') + '</tr>';
    }).join('');
    return '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:6px 0 18px">' + h + b + '</table>';
  }
  function h3(t) { return '<div style="font:700 13px Arial,sans-serif;color:' + MAIL_INK + ';margin:20px 0 2px">' + esc(t) + '</div>'; }

  var pill = d.paceWord === 'over' ? '#d64535' : d.paceWord === 'under' ? '#c07d12' : '#1f9d5b';
  var out = '<div style="font-family:Arial,sans-serif;color:' + MAIL_INK + ';max-width:640px">';
  out += '<div style="border-left:4px solid ' + MAIL_ACCENT + ';padding:2px 0 2px 12px;margin-bottom:14px">' +
         '<div style="font:700 18px Arial,sans-serif">' + esc(d.label) + '</div>' +
         '<div style="font:13px Arial,sans-serif;color:' + MAIL_MUTED + '">' + esc(d.month) +
         ' &middot; ' + esc(d.status) + ' &middot; ' + esc(d.type) + '</div></div>';

  if (d.note) {
    out += '<div style="background:#fff6f0;border:1px solid ' + MAIL_ACCENT + ';border-radius:6px;padding:11px 13px;margin-bottom:16px">' +
           '<div style="font:600 11px Arial,sans-serif;text-transform:uppercase;letter-spacing:.5px;color:' + MAIL_ACCENT + '">Note</div>' +
           '<div style="font:14px Arial,sans-serif;margin-top:3px">' + esc(d.note) + '</div></div>';
  }
  if (d.alert) {
    out += '<div style="background:#fdf3f2;border:1px solid #f0c4bf;border-radius:6px;padding:9px 12px;margin-bottom:16px;font:13px Arial,sans-serif">' +
           '<b>' + esc(d.alertTier) + '</b> &mdash; ' + esc(d.alert) + '</div>';
  }

  out += '<div style="font:14px Arial,sans-serif;margin-bottom:4px">Pace <b style="color:' + pill + '">' +
         esc(d.pace) + '</b> (' + esc(d.paceWord) + ')</div>';
  if (d.basis) out += '<div style="font:12px Arial,sans-serif;color:' + MAIL_MUTED + ';margin-bottom:6px">' + esc(d.basis) + '</div>';

  out += h3('Pacing');
  out += table(['Metric', 'Value'], [
    ['MTD ad spend', d.spend], ['Expected by today', d.expected],
    ['Ad spend target (month)', d.target], ['Forecast', d.forecast + ' (' + d.delta + ')'],
    ['Daily budget in platform', d.dailyBudget], ['Needed per day to hit target', d.reqDaily],
    ['Billings / our fee', d.billings + ' / ' + d.fee]
  ]);

  out += h3('Performance (month to date)');
  out += table(['Metric', 'Value'], [['Leads', d.leads], ['CPL', d.cpl]]);

  if (d.weeks && d.weeks.length) {
    out += h3('Weekly trend');
    out += table(['Week of', 'Cost', 'Clicks', 'CVR', 'Leads', 'CPL'], d.weeks);
  }
  if (d.camps && d.camps.length) {
    out += h3('Campaign split (last 30 days)');
    out += table(['Campaign', 'Cost', 'Clicks', 'CVR', 'Leads', 'CPL'], d.camps);
  }

  out += '<div style="font:12px Arial,sans-serif;color:' + MAIL_MUTED + ';border-top:1px solid ' + MAIL_LINE +
         ';padding-top:10px;margin-top:18px">' + esc(d.sender || 'Sent from the pacing dashboard') + '</div></div>';
  return out;
}

function flagText_(d) {
  var L = [];
  if (d.note) L.push('Note: ' + d.note);
  L.push(d.label + ' — ' + d.month, d.status + ' · ' + d.type, '');
  if (d.basis) L.push(d.basis);
  L.push('Pace: ' + d.pace + ' (' + d.paceWord + ')');
  L.push('MTD ad spend: ' + d.spend + '  (expected by today ' + d.expected + ')');
  L.push('Ad spend target: ' + d.target + '   Forecast: ' + d.forecast + ' (' + d.delta + ')');
  L.push('Daily budget: ' + d.dailyBudget + '   Needed/day: ' + d.reqDaily);
  L.push('Billings: ' + d.billings + '   Fee: ' + d.fee);
  L.push('Leads: ' + d.leads + '   CPL: ' + d.cpl);
  if (d.alert) L.push('Alert: ' + d.alertTier + ' — ' + d.alert);
  if (d.weeks && d.weeks.length) {
    L.push('', 'Weekly trend (week / cost / clicks / CVR / leads / CPL):');
    d.weeks.forEach(function (w) { L.push('  ' + w.join('  ')); });
  }
  if (d.camps && d.camps.length) {
    L.push('', 'Campaign split, last 30 days:');
    d.camps.forEach(function (c) { L.push('  ' + c.join('  ')); });
  }
  L.push('', d.sender || 'Sent from the pacing dashboard');
  return L.join('\n');
}

function testSlack() {  // run once in editor to grant external_request scope
  Logger.log(postSlack_('Pacing gateway connected ✅'));
}

/* ── header / formatting helpers ─────────────────────────────────────────── */

function ensureHeader_(tab, def) {
  var lastCol = Math.max(def.header.length, tab.getLastColumn() || def.header.length);
  var current = tab.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var need = false;
  for (var i = 0; i < def.header.length; i++) {
    if (current[i] !== def.header[i]) { need = true; break; }
  }
  // Only write when the header is actually wrong. forceText_ is a WRITE, so it
  // must not run on the read path — callers that write invoke it explicitly.
  if (need) {
    tab.getRange(1, 1, 1, def.header.length).setValues([def.header]);
    forceText_(tab, def);
  }
}

function forceText_(tab, def) {
  var cols = TEXT_COLS[def.name] || [];
  cols.forEach(function (colName) {
    var idx = def.header.indexOf(colName);
    if (idx >= 0) {
      var n = Math.max(tab.getMaxRows() - 1, 1);
      tab.getRange(2, idx + 1, n, 1).setNumberFormat('@');
    }
  });
}

function headIndex_(headerRow) {
  var idx = {};
  headerRow.forEach(function (h, i) { idx[String(h).trim()] = i; });
  return idx;
}

/* ── responders ──────────────────────────────────────────────────────────── */

function jsonp_(cb, obj) {
  return ContentService
    .createTextOutput(cb + '(' + JSON.stringify(obj) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

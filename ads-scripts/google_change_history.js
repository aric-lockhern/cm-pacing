/**
 * Google Ads MCC Change History — real change_event feed for the pacing tool
 * ------------------------------------------------------------------------------
 * Pulls Google Ads' NATIVE change history (the "Change History" you see in the
 * Google Ads UI) and writes it to the Sheet, so the dashboard's change log shows
 * changes made DIRECTLY in Google Ads (by anyone, any tool) — not just changes
 * made through the pacing tool.
 *
 * "Key changes" only, to keep the log readable:
 *   • Campaign BUDGET amount changes          (change_resource_type CAMPAIGN_BUDGET)
 *   • Campaign STATUS changes (pause/enable)  (change_resource_type CAMPAIGN)
 *   • Campaign BIDDING changes (strategy / target CPA / target ROAS)
 * Everything else (ads, keywords, targeting, ad groups) is skipped.
 *
 * Rolls each change up to a franchise using the same campaign location label the
 * pacing feed uses, and records WHO made it (user email) and WHERE from (web UI /
 * API / script). Google only exposes the LAST 30 DAYS of change_event (max 10k
 * rows per account), so this tab is a rolling 30-day window — rewritten each run.
 *
 * INSTALL (same as google_pacing_feed.js):
 *   Google Ads (MCC) ▸ Tools ▸ Bulk actions ▸ Scripts ▸ + New script ▸ paste ▸
 *   Authorize ▸ set a schedule (daily is plenty; hourly is fine too).
 *
 * Writes:
 *   Google_Changes   Date | Label | Campaign | Type | Change | User | Source
 *
 * ── CONFIG ──────────────────────────────────────────────────────────────── */
var SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/16RYai7RW9By034nDapw7DKzVSRUdJIYk1B1ISNHYSLE/edit';
var ACCOUNT_LABEL   = 'Active';                       // only accounts carrying this MCC label
var LOOKBACK_DAYS   = 30;                              // Google caps change_event at 30 days
var IGNORE_LABELS   = ['Active', 'Paused', 'DoNotTouch'];
var ACCOUNT_ALIASES = { /* 'Waxing - 1812 Marketing': 'Waxing', */ };
var MAX_ROWS        = 4000;                            // cap written to the sheet (newest first)
/* ─────────────────────────────────────────────────────────────────────────── */

var OUT_TAB    = 'Google_Changes';
var OUT_HEADER = ['Date', 'Label', 'Campaign', 'Type', 'Change', 'User', 'Source'];

function main() {
  var ss = SpreadsheetApp.openByUrl(SPREADSHEET_URL);

  var ignore = {};
  IGNORE_LABELS.forEach(function (n) { ignore[n.toLowerCase()] = true; });

  var tz = AdsApp.currentAccount().getTimeZone();
  var now = new Date();
  var start = new Date(now.getTime() - LOOKBACK_DAYS * 864e5);
  var startDt = Utilities.formatDate(start, tz, 'yyyy-MM-dd HH:mm:ss');
  var endDt   = Utilities.formatDate(now,   tz, 'yyyy-MM-dd HH:mm:ss');

  var out = [], acctCount = 0;

  var selector = AdsManagerApp.accounts();
  if (ACCOUNT_LABEL) selector = selector.withCondition("LabelNames CONTAINS '" + ACCOUNT_LABEL + "'");
  var accounts = selector.get();

  while (accounts.hasNext()) {
    var acct = accounts.next();
    AdsManagerApp.select(acct);
    acctCount++;
    var rawName = acct.getName() || acct.getCustomerId();
    var acctName = ACCOUNT_ALIASES[rawName] || rawName;

    // campaign id -> franchise label(s) (same rollup the pacing feed uses)
    var campLabels = {};
    try {
      var lit = AdsApp.search("SELECT campaign.id, label.name FROM campaign_label");
      while (lit.hasNext()) {
        var lr = lit.next(), nm = lr.label.name;
        if (ignore[nm.toLowerCase()]) continue;
        (campLabels[String(lr.campaign.id)] = campLabels[String(lr.campaign.id)] || []).push(nm);
      }
    } catch (e) { Logger.log('  [' + acctName + '] campaign_label query failed: ' + e); }

    // campaign id -> name (for display)
    var campName = {};
    try {
      var nit = AdsApp.search("SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status != 'REMOVED'");
      while (nit.hasNext()) { var nr = nit.next(); campName[String(nr.campaign.id)] = nr.campaign.name || ''; }
    } catch (e) { /* names are best-effort */ }

    // change_event REQUIRES a change_date_time window (≤30 days) and a LIMIT (≤10000).
    var q =
      "SELECT change_event.change_date_time, change_event.change_resource_type, " +
      "change_event.changed_fields, change_event.client_type, change_event.user_email, " +
      "change_event.campaign, change_event.old_resource, change_event.new_resource " +
      "FROM change_event " +
      "WHERE change_event.change_date_time >= '" + startDt + "' " +
      "AND change_event.change_date_time <= '" + endDt + "' " +
      "AND change_event.change_resource_type IN ('CAMPAIGN','CAMPAIGN_BUDGET') " +
      "ORDER BY change_event.change_date_time DESC " +
      "LIMIT 10000";

    var it;
    try { it = AdsApp.search(q); it.hasNext(); }
    catch (e) { Logger.log('  [' + acctName + '] change_event query failed: ' + e); continue; }

    while (it.hasNext()) {
      var ce = it.next().changeEvent || {};
      var fields = String(ce.changedFields || '');
      var type = String(ce.changeResourceType || '');
      var desc = describe_(type, fields, ce.oldResource || {}, ce.newResource || {});
      if (!desc) continue;                                   // not a key change (status/budget/bidding)

      var cid = idFromResource_(ce.campaign);
      var labs = cid && campLabels[cid];
      var fr = (labs && labs.length) ? labs[0] : acctName;   // one row per change; first label wins
      var cname = (cid && campName[cid]) || '';
      var when = String(ce.changeDateTime || '').replace('T', ' ').substring(0, 19);

      out.push([ when, fr, cname, desc.kind, desc.text, String(ce.userEmail || ''), clientLabel_(ce.clientType) ]);
    }
    Logger.log('  [' + acctName + '] key changes: ' + out.length + ' so far');
  }

  // newest first, capped
  out.sort(function (a, b) { return String(b[0]).localeCompare(String(a[0])); });
  if (out.length > MAX_ROWS) out = out.slice(0, MAX_ROWS);

  writeTab_(ss, OUT_TAB, OUT_HEADER, out);
  Logger.log('──────── summary ────────');
  Logger.log('Accounts matched "' + ACCOUNT_LABEL + '": ' + acctCount + ' | key changes written: ' + out.length);
}

/* Turn a change_event into a {kind, text} for budget / status / bidding changes,
   or null for anything else. old/new_resource carry only the changed fields. */
function describe_(type, fields, oldR, newR) {
  if (type === 'CAMPAIGN_BUDGET' && fields.indexOf('amount_micros') >= 0) {
    var ob = (oldR.campaignBudget || {}).amountMicros, nb = (newR.campaignBudget || {}).amountMicros;
    return { kind: 'Budget', text: 'daily budget ' + micros_(ob) + ' → ' + micros_(nb) };
  }
  if (type === 'CAMPAIGN') {
    var oc = oldR.campaign || {}, nc = newR.campaign || {};
    if (fields.indexOf('status') >= 0 && nc.status) {
      return { kind: 'Status', text: 'status ' + (oc.status || '?') + ' → ' + nc.status };
    }
    if (fields.indexOf('bidding_strategy_type') >= 0 && nc.biddingStrategyType) {
      return { kind: 'Bidding', text: 'bidding ' + (oc.biddingStrategyType || '?') + ' → ' + nc.biddingStrategyType };
    }
    // target CPA / ROAS live on the strategy sub-objects; report whichever changed
    if (fields.indexOf('target_cpa') >= 0) {
      var ot = pickTarget_(oc, 'targetCpa', 'targetCpaMicros'), nt = pickTarget_(nc, 'targetCpa', 'targetCpaMicros');
      return { kind: 'Bidding', text: 'target CPA ' + micros_(ot) + ' → ' + micros_(nt) };
    }
    if (fields.indexOf('target_roas') >= 0) {
      var orr = pickTarget_(oc, 'targetRoas', 'targetRoas'), nrr = pickTarget_(nc, 'targetRoas', 'targetRoas');
      return { kind: 'Bidding', text: 'target ROAS ' + roas_(orr) + ' → ' + roas_(nrr) };
    }
  }
  return null;
}

function pickTarget_(c, a, b) {
  // target may sit directly on the campaign or inside a maximize_* sub-object
  var strat = c.maximizeConversions || c.maximizeConversionValue || c.targetCpa || c.targetRoas || c;
  if (c[a] != null) return c[a];
  if (c[b] != null) return c[b];
  if (strat && strat[b] != null) return strat[b];
  if (strat && strat[a] != null) return strat[a];
  return null;
}
function micros_(v) { if (v == null || v === '') return '—'; var n = Number(v) / 1e6; return '$' + (Math.round(n * 100) / 100); }
function roas_(v) { if (v == null || v === '') return '—'; return (Math.round(Number(v) * 100) / 100) + 'x'; }
function idFromResource_(res) { var m = String(res || '').match(/campaigns\/(\d+)/); return m ? m[1] : ''; }
function clientLabel_(ct) {
  ct = String(ct || '');
  if (ct.indexOf('WEB') >= 0) return 'web UI';
  if (ct.indexOf('SCRIPT') >= 0) return 'script';
  if (ct.indexOf('API') >= 0) return 'API';
  if (ct.indexOf('EDITOR') >= 0) return 'Editor';
  if (ct.indexOf('MOBILE') >= 0) return 'mobile app';
  return ct ? ct.toLowerCase().replace(/_/g, ' ') : '';
}

function writeTab_(ss, name, header, rows) {
  var tab = ss.getSheetByName(name) || ss.insertSheet(name);
  tab.clearContents();
  var body = [header].concat(rows.length ? rows : []);
  tab.getRange(1, 1, body.length, header.length).setValues(body);
  // keep the Date column as plain text so Sheets doesn't reformat it
  if (rows.length) tab.getRange(2, 1, rows.length, 1).setNumberFormat('@');
}

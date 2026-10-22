/**
 * Google Ads MCC Change History — real change_event feed for the pacing tool
 * ------------------------------------------------------------------------------
 * Pulls Google Ads' NATIVE change history (the "Change History" you see in the
 * Google Ads UI) and writes it to the Sheet, so the dashboard's change log shows
 * changes made DIRECTLY in Google Ads (by anyone, any tool) — not just changes
 * made through the pacing tool.
 *
 * Captures the changes the team actually makes, including in Google Ads Editor:
 *   • Campaign BUDGET amount changes          (CAMPAIGN_BUDGET)
 *   • Campaign STATUS changes (pause/enable)  (CAMPAIGN)
 *   • Campaign BIDDING changes (strategy / target CPA / target ROAS)
 *   • KEYWORDS added / removed / paused        (AD_GROUP_CRITERION)
 *   • NEGATIVE keywords added / removed        (AD_GROUP_CRITERION, CAMPAIGN_CRITERION)
 *   • ADS / RSA copy added / removed / edited  (AD_GROUP_AD)
 *   • ASSET (sitelink / callout / image / pmax) copy edits   (ASSET)
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
      "change_event.changed_fields, change_event.resource_change_operation, " +
      "change_event.client_type, change_event.user_email, " +
      "change_event.campaign, change_event.ad_group, " +
      "change_event.old_resource, change_event.new_resource " +
      "FROM change_event " +
      "WHERE change_event.change_date_time >= '" + startDt + "' " +
      "AND change_event.change_date_time <= '" + endDt + "' " +
      "AND change_event.change_resource_type IN " +
      "('CAMPAIGN','CAMPAIGN_BUDGET','AD_GROUP_AD','AD_GROUP_CRITERION','CAMPAIGN_CRITERION','ASSET') " +
      "ORDER BY change_event.change_date_time DESC " +
      "LIMIT 10000";

    var it;
    try { it = AdsApp.search(q); it.hasNext(); }
    catch (e) { Logger.log('  [' + acctName + '] change_event query failed: ' + e); continue; }

    while (it.hasNext()) {
      var ce = it.next().changeEvent || {};
      var fields = String(ce.changedFields || '');
      var type = String(ce.changeResourceType || '');
      var op = String(ce.resourceChangeOperation || '');
      var desc = describe_(type, fields, ce.oldResource || {}, ce.newResource || {}, op);
      if (!desc) continue;                                   // not a change we surface

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

/* Turn a change_event into a {kind, text}, or null for anything we don't surface.
   old/new_resource carry ONLY the changed fields (except on add/remove, where the
   whole resource is present), so text falls back gracefully when a field is absent. */
function describe_(type, fields, oldR, newR, operation) {
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
    return null;
  }

  // Keywords & ad-group negatives (added in Google Ads Editor or the UI)
  if (type === 'AD_GROUP_CRITERION') {
    var oac = oldR.adGroupCriterion || {}, nac = newR.adGroupCriterion || {};
    var kw = nac.keyword || oac.keyword || null;
    var isNeg = nac.negative === true || oac.negative === true;
    var kwText = kw && kw.text ? '"' + kw.text + '"' + matchTag_(kw.matchType) : '';
    if (isNeg) return { kind: 'Negative', text: op_(operation) + ' ad-group negative' + (kwText ? ' ' + kwText : '') };
    // a keyword status change (paused/enabled) — report even without the text
    if (fields.indexOf('status') >= 0 && (nac.status || oac.status)) {
      return { kind: 'Keyword', text: 'keyword' + (kwText ? ' ' + kwText : '') + ' ' + (oac.status || '?') + ' → ' + (nac.status || '?') };
    }
    // add / remove with a keyword payload → a real keyword change (audiences,
    // placements etc. carry no keyword text, so they fall through and are skipped)
    if (kw) return { kind: 'Keyword', text: op_(operation) + ' keyword' + (kwText ? ' ' + kwText : '') };
    return null;
  }

  // Campaign-level criteria — we surface negative keywords; skip locations/languages noise
  if (type === 'CAMPAIGN_CRITERION') {
    var occ = oldR.campaignCriterion || {}, ncc = newR.campaignCriterion || {};
    var ckw = ncc.keyword || occ.keyword || null;
    var cNeg = ncc.negative === true || occ.negative === true;
    if (ckw || cNeg) {
      var ct = ckw && ckw.text ? '"' + ckw.text + '"' + matchTag_(ckw.matchType) : '';
      return { kind: 'Negative', text: op_(operation) + ' campaign negative' + (ct ? ' ' + ct : '') };
    }
    return null;
  }

  // Ads — RSA/ad copy edits, pauses, adds/removes
  if (type === 'AD_GROUP_AD') {
    var oaa = oldR.adGroupAd || {}, naa = newR.adGroupAd || {};
    if (fields.indexOf('status') >= 0 && (naa.status || oaa.status)) {
      return { kind: 'Ad', text: 'ad' + adTag_(naa.ad || oaa.ad) + ' ' + (oaa.status || '?') + ' → ' + (naa.status || '?') };
    }
    var copyEdit = fields.indexOf('responsive_search_ad') >= 0 || fields.indexOf('ad.') >= 0 ||
                   fields.indexOf('headlines') >= 0 || fields.indexOf('descriptions') >= 0 ||
                   fields.indexOf('final_urls') >= 0;
    if (copyEdit) return { kind: 'Ad', text: op_(operation) + ' ad copy' + adTag_(naa.ad || oaa.ad) };
    return { kind: 'Ad', text: op_(operation) + ' ad' + adTag_(naa.ad || oaa.ad) };
  }

  // Assets — sitelink / callout / image / PMax text asset copy edits
  if (type === 'ASSET') {
    var oas = oldR.asset || {}, nas = newR.asset || {};
    var txt = (nas.textAsset && nas.textAsset.text) || (oas.textAsset && oas.textAsset.text) || nas.name || oas.name || '';
    return { kind: 'Asset', text: op_(operation) + ' asset' + (txt ? ' "' + txt + '"' : '') };
  }

  return null;
}

/* CREATE / UPDATE / REMOVE → a plain verb for the change text. */
function op_(o) {
  o = String(o || '');
  if (o.indexOf('CREATE') >= 0) return 'added';
  if (o.indexOf('REMOVE') >= 0) return 'removed';
  if (o.indexOf('UPDATE') >= 0) return 'edited';
  return 'changed';
}
function matchTag_(mt) { mt = String(mt || ''); return mt && mt !== 'UNSPECIFIED' && mt !== 'UNKNOWN' ? ' [' + mt + ']' : ''; }
/* Pull the first headline off an RSA so an ad edit reads with some context. */
function adTag_(ad) {
  if (!ad) return '';
  var rsa = ad.responsiveSearchAd;
  if (rsa && rsa.headlines && rsa.headlines.length && rsa.headlines[0].text) return ' "' + rsa.headlines[0].text + '…"';
  if (ad.name) return ' "' + ad.name + '"';
  return '';
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

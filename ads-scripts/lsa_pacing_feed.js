/**
 * LSA Pacing Feed — for the "Content Massive - LSA Accounts" MCC
 * -------------------------------------------------------------------------
 * Local Services Ads live in their own MCC and only need SPEND + CONVERSIONS.
 * This is intentionally minimal so it can't choke on LSA-specific campaign
 * types. The franchise key is each account's ACCOUNT LABEL — set in Google Ads to
 * match the budget sheet (column A) 1:1. Accounts with no franchise label fall back
 * to the account name (LSA has no campaign labels to roll up here).
 *
 * Window is 365 days ending YESTERDAY, because LSA paces as a running burn-down
 * against the cumulative approved budget (leftover rolls forward), so the app
 * needs enough history to total spend since the engagement started.
 *
 * Writes to the SAME spreadsheet as the main tool, into its own tabs:
 *   LSA_Feed    Label | Spend | Conv | Status | Updated     (last-365d totals + status)
 *   Daily_LSA   Date | Label | Spend | Conv                 (rolling 365 days)
 *
 * ── CONFIG ──────────────────────────────────────────────────────────────── */
var SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/16RYai7RW9By034nDapw7DKzVSRUdJIYk1B1ISNHYSLE/edit';
var ACCOUNT_LABEL   = '';    // '' = every account in this MCC (it's LSA-only). Set a label to filter which accounts run.
var LOOKBACK_DAYS   = 365;
// Franchise name = each account's Google Ads ACCOUNT LABEL (set to match the budget
// sheet, column A, 1:1). Status labels below are skipped when picking that label; an
// account with no franchise label falls back to its name (optionally via ACCOUNT_ALIASES).
var IGNORE_LABELS   = ['Active', 'Paused', 'DoNotTouch'];
var ACCOUNT_ALIASES = { /* 'LSA - Something': 'Something', */ };
/* ─────────────────────────────────────────────────────────────────────────── */

var FEED_TAB  = 'LSA_Feed';
var DAILY_TAB = 'Daily_LSA';
var FEED_HEADER  = ['Label', 'Spend', 'Conv', 'Status', 'Updated'];
var DAILY_HEADER = ['Date', 'Label', 'Spend', 'Conv'];

function main() {
  var ss = SpreadsheetApp.openByUrl(SPREADSHEET_URL);
  var range = dateRange_(LOOKBACK_DAYS);
  var recentCut = (function(){ var d=new Date(); d.setDate(d.getDate()-15); return Utilities.formatDate(d, AdsApp.currentAccount().getTimeZone(), 'yyyyMMdd'); })();

  var daily = {}, totals = {}, enabled = {}, allFr = {};
  var acctCount = 0;

  // Resolve each account's franchise from its ACCOUNT LABEL (matches the budget sheet).
  // Build customerId -> franchise-label-name, skipping the status labels in IGNORE_LABELS.
  var ignore = {};
  IGNORE_LABELS.forEach(function (n) { ignore[String(n).toLowerCase()] = true; });
  var franchiseByCustomer = {};
  try {
    var labelIt = AdsManagerApp.accountLabels().get();
    while (labelIt.hasNext()) {
      var lbl = labelIt.next(), lname = lbl.getName();
      if (ignore[lname.toLowerCase()]) continue;
      var la = lbl.accounts().get();
      while (la.hasNext()) {
        var cid = la.next().getCustomerId();
        if (franchiseByCustomer[cid] && franchiseByCustomer[cid] !== lname)
          Logger.log('  [' + cid + '] has multiple franchise labels ("' + franchiseByCustomer[cid] + '", "' + lname + '") — using "' + lname + '"');
        franchiseByCustomer[cid] = lname;
      }
    }
  } catch (e) {
    Logger.log('account label lookup failed (' + e + ') — falling back to account names');
  }

  var selector = AdsManagerApp.accounts();
  if (ACCOUNT_LABEL) selector = selector.withCondition("LabelNames CONTAINS '" + ACCOUNT_LABEL + "'");
  var accounts = selector.get();

  while (accounts.hasNext()) {
    var acct = accounts.next();
    AdsManagerApp.select(acct);
    acctCount++;
    var rawName = acct.getName() || acct.getCustomerId();
    var name = franchiseByCustomer[acct.getCustomerId()] || ACCOUNT_ALIASES[rawName] || rawName;
    allFr[name] = true;

    // (status is derived from recent spend below — LSA campaign resource is unreliable)

    // spend + conversions by day — ACCOUNT level (LSA campaigns don't report
    // through the standard campaign resource, so we query the customer resource).
    var rows, gotRows = false;
    try {
      rows = runSearch_(
        "SELECT metrics.cost_micros, metrics.conversions, segments.date FROM customer " +
        "WHERE segments.date BETWEEN '" + range.startDash + "' AND '" + range.endDash + "'");
      gotRows = true;
    } catch (e1) {
      Logger.log('  [' + name + '] customer query failed (' + e1 + ') — trying campaign level');
      try {
        rows = runSearch_(
          "SELECT metrics.cost_micros, metrics.conversions, segments.date FROM campaign " +
          "WHERE segments.date BETWEEN '" + range.startDash + "' AND '" + range.endDash + "' " +
          "AND campaign.status != 'REMOVED'");
        gotRows = true;
      } catch (e2) { Logger.log('  [' + name + '] metrics query failed: ' + e2); }
    }
    if (!gotRows) continue;

    while (rows.hasNext()) {
      var row = rows.next();
      var m = row.metrics || {};
      var spend = Number(m.costMicros || 0) / 1e6;
      var conv  = Number(m.conversions || 0);
      var d = String(row.segments.date).replace(/-/g, '');
      addDaily_(daily, d, name, spend, conv);
      if (!totals[name]) totals[name] = { spend: 0, conv: 0 };
      totals[name].spend += spend; totals[name].conv += conv;
      if (d >= recentCut) enabled[name] = true;   // spend in the last 14 days = active
    }
    Logger.log('  [' + name + '] ' + (totals[name] ? r2(totals[name].spend) : 0) + ' spend / ' +
               (totals[name] ? r2(totals[name].conv) : 0) + ' conv');
  }

  writeFeed_(ss, totals, enabled, allFr);
  writeDaily_(ss, daily);
  Logger.log('──── LSA summary ──── accounts: ' + acctCount + ' | franchises: ' + Object.keys(allFr).length);
  if (acctCount === 0) Logger.log('0 accounts — is this running in the LSA MCC? Is ACCOUNT_LABEL set correctly?');
}

function runSearch_(q) { var it = AdsApp.search(q); it.hasNext(); return it; }

function addDaily_(o, d, name, spend, conv) {
  if (!o[d]) o[d] = {};
  if (!o[d][name]) o[d][name] = { spend: 0, conv: 0 };
  o[d][name].spend += spend; o[d][name].conv += conv;
}

function writeFeed_(ss, totals, enabled, allFr) {
  var tab = ensureTab_(ss, FEED_TAB); tab.clearContents();
  var now = new Date(), out = [FEED_HEADER];
  Object.keys(allFr).sort().forEach(function (f) {
    var t = totals[f] || { spend: 0, conv: 0 };
    out.push([f, r2(t.spend), r2(t.conv), enabled[f] ? 'active' : 'paused', now]);
  });
  tab.getRange(1, 1, out.length, FEED_HEADER.length).setValues(out);
}

function writeDaily_(ss, daily) {
  var tab = ensureTab_(ss, DAILY_TAB); tab.clearContents();
  var out = [DAILY_HEADER];
  Object.keys(daily).sort().forEach(function (d) {
    var dash = d.substring(0, 4) + '-' + d.substring(4, 6) + '-' + d.substring(6, 8);
    Object.keys(daily[d]).sort().forEach(function (f) {
      var b = daily[d][f];
      out.push([dash, f, r2(b.spend), r2(b.conv)]);
    });
  });
  tab.getRange(1, 1, out.length, DAILY_HEADER.length).setValues(out);
}

function ensureTab_(ss, name) { var t = ss.getSheetByName(name); if (!t) t = ss.insertSheet(name); return t; }
function dateRange_(days) {
  var e = new Date(); e.setDate(e.getDate() - 1);
  var s = new Date(e); s.setDate(s.getDate() - (days - 1));
  return { startDash: ymdDash_(s), endDash: ymdDash_(e) };
}
function ymdDash_(d) { return Utilities.formatDate(d, AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd'); }
function r2(n) { return Math.round(n * 100) / 100; }

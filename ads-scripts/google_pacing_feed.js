/**
 * Google Ads MCC Pacing Feed — v10 (drops ENDED campaigns; status + daily budgets)
 * ------------------------------------------------------------------------------
 * ENDED campaigns are excluded everywhere — no daily budget, no active status,
 * no metrics. Detected via campaign.serving_status = ENDED, which is what the
 * Google Ads UI displays as "Ended" (campaign.status still reads ENABLED).
 * If serving_status is unavailable in your API version the script logs a warning
 * and continues without that filter rather than failing.
 * 1. Processes only accounts carrying ACCOUNT_LABEL (e.g. "Active").
 * 2. Rolls campaigns up to a franchise (location label, else account name).
 * 3. Sums the DAILY BUDGET of each franchise's ENABLED campaigns (shared budgets
 *    counted once), so you can compare it against the spend needed to pace to 100%.
 * 4. Reports each franchise's STATUS: "active" if ≥1 of its campaigns is ENABLED,
 *    otherwise "paused". Paused franchises are still written (with their stats)
 *    so they show in an easy column.
 * 5. Writes a per-campaign daily tab for the analytics split.
 *
 * Writes:
 *   Google_Feed            Label | Spend | Conv | Clicks | Impr | Revenue | DailyBudget | Status | Updated
 *   Daily_Google           Date | Label | Spend | Conv | Clicks | Impr | Revenue
 *   Daily_Google_Campaign  Date | Label | Campaign | Spend | Conv | Clicks | Impr | Revenue
 *
 * ── CONFIG ──────────────────────────────────────────────────────────────── */
var SPREADSHEET_URL    = 'https://docs.google.com/spreadsheets/d/16RYai7RW9By034nDapw7DKzVSRUdJIYk1B1ISNHYSLE/edit';
var ACCOUNT_LABEL      = 'Active';
var UNLABELED_FALLBACK = 'account';   // 'account' or 'campaign'
var LOOKBACK_DAYS      = 90;
var IGNORE_LABELS      = ['Active', 'Paused', 'DoNotTouch'];
var ACCOUNT_ALIASES    = { /* 'Waxing - 1812 Marketing': 'Waxing', */ };
/* ─────────────────────────────────────────────────────────────────────────── */

var FEED_TAB   = 'Google_Feed';
var DAILY_TAB  = 'Daily_Google';
var CAMP_TAB   = 'Daily_Google_Campaign';
var FEED_HEADER  = ['Label', 'Spend', 'Conv', 'Clicks', 'Impr', 'Revenue', 'DailyBudget', 'Status', 'Updated'];
var DAILY_HEADER = ['Date', 'Label', 'Spend', 'Conv', 'Clicks', 'Impr', 'Revenue'];
var CAMP_HEADER  = ['Date', 'Label', 'Campaign', 'Spend', 'Conv', 'Clicks', 'Impr', 'Revenue'];

function main() {
  var ss = SpreadsheetApp.openByUrl(SPREADSHEET_URL);

  var ignore = {};
  IGNORE_LABELS.forEach(function (n) { ignore[n.toLowerCase()] = true; });

  var range = dateRange_(LOOKBACK_DAYS);
  var monthPrefix = todayYmd_().substring(0, 6);

  var daily = {}, mtd = {}, camp = {}, enabled = {}, allFr = {}, budgets = {};
  var acctCount = 0, totalCampaigns = 0;

  var selector = AdsManagerApp.accounts();
  if (ACCOUNT_LABEL) selector = selector.withCondition("LabelNames CONTAINS '" + ACCOUNT_LABEL + "'");
  var accounts = selector.get();

  while (accounts.hasNext()) {
    var acct = accounts.next();
    AdsManagerApp.select(acct);
    acctCount++;

    var rawName = acct.getName() || acct.getCustomerId();
    var acctName = ACCOUNT_ALIASES[rawName] || rawName;

    // campaign labels: id -> [franchise label names]
    var campLabels = {};
    try {
      var lit = AdsApp.search("SELECT campaign.id, label.name FROM campaign_label");
      while (lit.hasNext()) {
        var lr = lit.next(); var nm = lr.label.name;
        if (ignore[nm.toLowerCase()]) continue;
        (campLabels[String(lr.campaign.id)] = campLabels[String(lr.campaign.id)] || []).push(nm);
      }
    } catch (e) { Logger.log('  [' + acctName + '] campaign_label query failed: ' + e); }

    // campaign info + status + daily budget: resolve franchises & enabled rollup.
    // "Ended" in the Google Ads UI = campaign.serving_status ENDED (the API still
    // reports campaign.status as ENABLED), so serving_status is what we check.
    var campToFr = {}, endedIds = {};
    var cit = null, haveServing = true;
    var qBase = "SELECT campaign.id, campaign.name, campaign.status, %S" +
                "campaign_budget.id, campaign_budget.amount_micros " +
                "FROM campaign WHERE campaign.status != 'REMOVED'";
    try {
      cit = runSearch_(qBase.replace('%S', 'campaign.serving_status, '));
    } catch (e1) {
      haveServing = false;
      Logger.log('  [' + acctName + '] serving_status unavailable (' + e1 + ') — ended campaigns will NOT be filtered');
      try { cit = runSearch_(qBase.replace('%S', '')); }
      catch (e2) { Logger.log('  [' + acctName + '] campaign query failed: ' + e2); cit = null; }
    }

    if (cit) {
      while (cit.hasNext()) {
        var cr = cit.next();
        var id = String(cr.campaign.id);
        var cname = cr.campaign.name || ('Campaign ' + id);
        var labs = campLabels[id];
        var fr = (labs && labs.length) ? labs : [ UNLABELED_FALLBACK === 'campaign' ? cname : acctName ];
        campToFr[id] = { name: cname, fr: fr };

        var isEnded = haveServing && String(cr.campaign.servingStatus) === 'ENDED';
        if (isEnded) { endedIds[id] = true; continue; }   // no budget, no status, no metrics

        var isOn  = String(cr.campaign.status) === 'ENABLED';
        var cb    = cr.campaignBudget || {};
        var bAmt  = Number(cb.amountMicros || 0) / 1e6;
        var bId   = String(cb.id || ('c' + id));   // dedupe shared budgets

        fr.forEach(function (f) {
          allFr[f] = true;
          if (isOn) {
            enabled[f] = true;
            if (!budgets[f]) budgets[f] = {};
            budgets[f][bId] = bAmt;   // same shared budget counted once
          }
        });
      }
    }

    // daily campaign metrics (ended campaigns are skipped in code, below)
    var q =
      "SELECT campaign.id, metrics.cost_micros, metrics.conversions, metrics.clicks, " +
      "metrics.impressions, metrics.conversions_value, segments.date " +
      "FROM campaign " +
      "WHERE segments.date BETWEEN '" + range.startDash + "' AND '" + range.endDash + "' " +
      "AND campaign.status != 'REMOVED'";

    var campSeen = {}, rows;
    try { rows = runSearch_(q); }
    catch (e) { Logger.log('  [' + acctName + '] metrics query failed: ' + e); continue; }

    while (rows.hasNext()) {
      var row = rows.next();
      var cid = String(row.campaign.id);
      if (endedIds[cid]) continue;               // drop ended campaigns entirely
      campSeen[cid] = true;
      var info = campToFr[cid] || { name: 'Campaign ' + cid, fr: [acctName] };

      var m = row.metrics || {};
      var vals = {
        spend:  Number(m.costMicros || 0) / 1e6,
        conv:   Number(m.conversions || 0),
        clicks: Number(m.clicks || 0),
        impr:   Number(m.impressions || 0),
        rev:    Number(m.conversionsValue || 0)
      };
      var dYmd = String(row.segments.date).replace(/-/g, '');
      var inMonth = dYmd.substring(0, 6) === monthPrefix;

      info.fr.forEach(function (f) {
        addTo_(bucket2_(daily, dYmd, f), vals);
        if (inMonth) addTo_(bucket1_(mtd, f), vals);
        addTo_(bucket3_(camp, f, info.name, dYmd), vals);
      });
    }

    totalCampaigns += Object.keys(campSeen).length;
    Logger.log('  [' + acctName + '] ' + Object.keys(campSeen).length + ' campaigns');
  }

  writeFeed_(ss, mtd, enabled, allFr, budgets);
  writeDaily_(ss, daily);
  writeCamp_(ss, camp);

  Logger.log('──────── summary ────────');
  Logger.log('Accounts matched "' + ACCOUNT_LABEL + '": ' + acctCount + ' | campaigns: ' + totalCampaigns);
  Logger.log('Franchises: ' + Object.keys(allFr).length + ' | active: ' + Object.keys(enabled).length);
  if (acctCount === 0) Logger.log('0 accounts → is the ACCOUNT label spelled exactly "' + ACCOUNT_LABEL + '"? (case-sensitive)');
}

/* Runs a GAQL query and forces execution immediately, so an invalid-field error
   is thrown here (catchable) instead of later during iteration. */
function runSearch_(q) {
  var it = AdsApp.search(q);
  it.hasNext();          // triggers the request
  return it;
}

/* ── aggregation helpers ─────────────────────────────────────────────────── */
function bucket1_(o, a) { if (!o[a]) o[a] = zero_(); return o[a]; }
function bucket2_(o, d, a) { if (!o[d]) o[d] = {}; if (!o[d][a]) o[d][a] = zero_(); return o[d][a]; }
function bucket3_(o, f, c, d) { if (!o[f]) o[f] = {}; if (!o[f][c]) o[f][c] = {}; if (!o[f][c][d]) o[f][c][d] = zero_(); return o[f][c][d]; }
function zero_() { return { spend: 0, conv: 0, clicks: 0, impr: 0, rev: 0 }; }
function addTo_(b, v) { b.spend += v.spend; b.conv += v.conv; b.clicks += v.clicks; b.impr += v.impr; b.rev += v.rev; }

/* ── writers ─────────────────────────────────────────────────────────────── */
function writeFeed_(ss, mtd, enabled, allFr, budgets) {
  var tab = ensureTab_(ss, FEED_TAB);
  tab.clearContents();
  var now = new Date(), out = [FEED_HEADER];
  Object.keys(allFr).sort().forEach(function (f) {
    var b = mtd[f] || zero_();
    var bud = 0, map = budgets[f] || {};
    for (var k in map) bud += map[k];      // enabled campaigns only, shared budgets deduped
    out.push([f, r2(b.spend), r2(b.conv), b.clicks, b.impr, r2(b.rev), r2(bud), enabled[f] ? 'active' : 'paused', now]);
  });
  tab.getRange(1, 1, out.length, FEED_HEADER.length).setValues(out);
}

function writeDaily_(ss, daily) {
  var tab = ensureTab_(ss, DAILY_TAB);
  tab.clearContents();
  var out = [DAILY_HEADER];
  Object.keys(daily).sort().forEach(function (d) {
    var dash = dash_(d);
    Object.keys(daily[d]).sort().forEach(function (f) {
      var b = daily[d][f];
      out.push([dash, f, r2(b.spend), r2(b.conv), b.clicks, b.impr, r2(b.rev)]);
    });
  });
  tab.getRange(1, 1, out.length, DAILY_HEADER.length).setValues(out);
}

function writeCamp_(ss, camp) {
  var tab = ensureTab_(ss, CAMP_TAB);
  tab.clearContents();
  var out = [CAMP_HEADER];
  Object.keys(camp).sort().forEach(function (f) {
    Object.keys(camp[f]).sort().forEach(function (c) {
      Object.keys(camp[f][c]).sort().forEach(function (d) {
        var b = camp[f][c][d];
        out.push([dash_(d), f, c, r2(b.spend), r2(b.conv), b.clicks, b.impr, r2(b.rev)]);
      });
    });
  });
  tab.getRange(1, 1, out.length, CAMP_HEADER.length).setValues(out);
}

function ensureTab_(ss, name) { var t = ss.getSheetByName(name); if (!t) t = ss.insertSheet(name); return t; }
function dash_(d) { return d.substring(0, 4) + '-' + d.substring(4, 6) + '-' + d.substring(6, 8); }
// Window ENDS YESTERDAY — today is still in progress and its partial numbers
// would understate spend and distort pacing.
function dateRange_(days) {
  var e = new Date(); e.setDate(e.getDate() - 1);
  var s = new Date(e); s.setDate(s.getDate() - (days - 1));
  return { startDash: ymdDash_(s), endDash: ymdDash_(e) };
}
function ymdDash_(d) { return Utilities.formatDate(d, AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd'); }
function todayYmd_() { return Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyyMMdd'); }
function r2(n) { return Math.round(n * 100) / 100; }

/**
 * Google Ads — Budget Apply  (pacing auto-adjust, driven by the pacing tool)
 * ---------------------------------------------------------------------------
 * Runs HOURLY in the same MCC as the Google pacing feed. Reads PENDING rows from
 * the Budget_Queue tab (written by the app's "Apply" button) and, for each
 * franchise, sets its ENABLED campaigns' daily budget to hit the requested total,
 * then writes the result back to the sheet and emails a summary.
 *
 * ── SAFETY (why this is safe to run) ──
 *  • Touches only ENABLED, non-ENDED campaigns; paused/ended are skipped.
 *  • Any campaign carrying a SAFE_LABELS tag (e.g. DoNotTouch) is never touched.
 *  • Every change is clamped to [MIN_DAILY, MAX_DAILY] AND to ±MAX_CHANGE_PCT of the
 *    franchise's current total, so a bad input can't blow up a budget.
 *  • DRY_RUN=true logs what WOULD change without touching anything — leave it on until
 *    you've eyeballed a few runs, then flip to false.
 *  • Shared budgets are set once; separate budgets are scaled proportionally to hit the
 *    requested franchise total while preserving the existing split.
 *  • The app only ever queues a target that finishes the month on the client's approved
 *    (billed) budget — it never asks to spend past what the client paid for.
 *
 * ── WHY GAQL (Performance Max fix) ──
 *  AdsApp.campaigns() only returns Search & Display campaigns — it silently OMITS
 *  Performance Max, Shopping, and Video. Accounts that are PMAX-only (e.g. some
 *  Fetch locations) would report "no active campaigns found". We instead enumerate
 *  campaigns via GAQL `FROM campaign` (returns EVERY type, exactly like the feed)
 *  and set budgets by budget id via AdsApp.budgets().withIds() — which is
 *  campaign-type-agnostic.
 *
 * DEPLOY: add to the SAME MCC as google_pacing_feed.js; schedule it HOURLY.
 * ── CONFIG ─────────────────────────────────────────────────────────────── */
var SPREADSHEET_URL   = 'https://docs.google.com/spreadsheets/d/16RYai7RW9By034nDapw7DKzVSRUdJIYk1B1ISNHYSLE/edit';
var QUEUE_TAB         = 'Budget_Queue';
var ACCOUNT_LABEL     = 'Active';                          // only process accounts carrying this label
var IGNORE_LABELS     = ['Active', 'Paused', 'DoNotTouch'];// not franchise labels
var SAFE_LABELS       = ['DoNotTouch'];                    // NEVER change campaigns/accounts with these
var UNLABELED_FALLBACK = 'account';                        // 'account' or 'campaign' — must match the feed
var MAX_CHANGE_PCT    = 0.5;                               // clamp each apply to ±50% of the current total
var MIN_DAILY         = 1;                                 // never set a daily budget below this
var MAX_DAILY         = 100000;                            // ... or above this
var EMAIL_TO          = 'aric@contentmassive.com';         // confirmation / failure summary
var DRY_RUN           = true;                              // ← START HERE: true = log only, change nothing
/* ─────────────────────────────────────────────────────────────────────────── */

function main() {
  var ss = SpreadsheetApp.openByUrl(SPREADSHEET_URL);
  var tab = ss.getSheetByName(QUEUE_TAB);
  if (!tab) { Logger.log('No "' + QUEUE_TAB + '" tab — nothing to do.'); return; }
  var data = tab.getDataRange().getValues();
  if (data.length < 2) { Logger.log('Queue empty.'); return; }
  var H = {}; data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
  if (H.Label === undefined || H.NewDailyBudget === undefined || H.Status === undefined) {
    Logger.log('Queue header missing required columns.'); return;
  }

  // newest PENDING request per franchise
  var pending = {};   // labelLower -> { row, label, newDaily }
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][H.Status]).trim().toLowerCase() !== 'pending') continue;
    var label = String(data[r][H.Label] || '').trim();
    var amt = Number(data[r][H.NewDailyBudget]);
    if (!label || isNaN(amt)) { mark_(data, H, r, 'failed', 'bad row'); continue; }
    pending[label.toLowerCase()] = { row: r, label: label, newDaily: amt };
  }
  var keys = Object.keys(pending);
  if (!keys.length) { Logger.log('Nothing pending.'); return; }
  Logger.log(keys.length + ' pending franchise budget change(s).');

  var ignore = {}; IGNORE_LABELS.forEach(function (n) { ignore[n.toLowerCase()] = true; });
  var safe = {};   SAFE_LABELS.forEach(function (n) { safe[n.toLowerCase()] = true; });

  // franchise -> { budgets: {budgetId -> {cur, ids:[]}}, acctName }
  // Collected across accounts by enumerating EVERY campaign type via GAQL.
  var found = {};
  var sel = AdsManagerApp.accounts();
  if (ACCOUNT_LABEL) sel = sel.withCondition("LabelNames CONTAINS '" + ACCOUNT_LABEL + "'");
  var accts = sel.get();
  while (accts.hasNext()) {
    var acct = accts.next(); AdsManagerApp.select(acct);
    var acctName = acct.getName() || acct.getCustomerId();

    var campLabels = {};   // campaign id -> [label names]
    try {
      var lit = AdsApp.search("SELECT campaign.id, label.name FROM campaign_label");
      while (lit.hasNext()) { var lr = lit.next();
        (campLabels[String(lr.campaign.id)] = campLabels[String(lr.campaign.id)] || []).push(lr.label.name); }
    } catch (e) { Logger.log('  [' + acctName + '] label query failed: ' + e); }

    // Enumerate ALL enabled, serving (non-ended) campaigns of EVERY type via GAQL.
    // campaign_budget.id + amount_micros come back on the same row — no extra query.
    var q = "SELECT campaign.id, campaign.name, campaign.serving_status, " +
            "campaign_budget.id, campaign_budget.amount_micros " +
            "FROM campaign WHERE campaign.status = 'ENABLED'";
    var cit;
    try { cit = AdsApp.search(q); }
    catch (eq) { Logger.log('  [' + acctName + '] campaign query failed: ' + eq); continue; }

    while (cit.hasNext()) {
      var row = cit.next();
      var cid = String(row.campaign.id);
      var serving = row.campaign.servingStatus;
      if (serving === 'ENDED') continue;                       // skip ended campaigns
      var labs = campLabels[cid] || [];
      if (labs.some(function (n) { return safe[n.toLowerCase()]; })) continue;   // DoNotTouch

      var fr = null;
      for (var i = 0; i < labs.length; i++) { if (!ignore[labs[i].toLowerCase()]) { fr = labs[i]; break; } }
      if (!fr) fr = (UNLABELED_FALLBACK === 'campaign') ? row.campaign.name : acctName;
      var flc = String(fr).toLowerCase();
      if (!pending[flc]) continue;

      var bid = row.campaignBudget && row.campaignBudget.id != null ? String(row.campaignBudget.id) : null;
      if (!bid) continue;                                      // no shared/standard budget id — can't set
      var micros = Number(row.campaignBudget.amountMicros || 0);

      var f = (found[flc] = found[flc] || { budgets: {}, acctName: acctName });
      if (!f.budgets[bid]) f.budgets[bid] = { cur: micros / 1e6 };
    }
  }

  // apply, franchise by franchise. Budgets are set while the OWNING account is selected.
  var results = [];
  keys.forEach(function (flc) {
    var p = pending[flc];
    var f = found[flc];
    if (!f) { mark_(data, H, p.row, 'failed', 'no active campaigns found'); results.push('X ' + p.label + ' — no active campaigns found'); return; }

    var bids = Object.keys(f.budgets);
    if (!bids.length) { mark_(data, H, p.row, 'failed', 'no editable budget found'); results.push('X ' + p.label + ' — no editable budget found'); return; }

    var curTotal = 0; bids.forEach(function (bid) { curTotal += f.budgets[bid].cur; });

    var target = clamp_(p.newDaily, MIN_DAILY, MAX_DAILY);
    var capped = false;
    if (curTotal > 0) {   // clamp to ±MAX_CHANGE_PCT of the current total
      var up = curTotal * (1 + MAX_CHANGE_PCT), dn = curTotal * (1 - MAX_CHANGE_PCT);
      var clamped = Math.max(dn, Math.min(up, target));
      if (Math.abs(clamped - target) > 0.005) capped = true;
      target = clamped;
    }

    // compute the per-budget target amounts (shared = 1 budget; split = proportional)
    var plan = {};   // bid -> newAmount
    if (bids.length === 1) {
      plan[bids[0]] = clamp_(round2_(target), MIN_DAILY, MAX_DAILY);
    } else {
      var factor = curTotal > 0 ? target / curTotal : 1;
      bids.forEach(function (bid) { plan[bid] = clamp_(round2_(f.budgets[bid].cur * factor), MIN_DAILY, MAX_DAILY); });
    }

    try {
      // Re-select the owning account, then set each budget by id (type-agnostic).
      var applied = applyPlan_(f.acctName, plan);
      if (!applied.ok) { mark_(data, H, p.row, 'failed', applied.note); results.push('X ' + p.label + ' — ' + applied.note); return; }

      var note;
      if (bids.length === 1) {
        note = 'budget ' + round2_(f.budgets[bids[0]].cur) + ' -> ' + plan[bids[0]];
      } else {
        var factor2 = curTotal > 0 ? target / curTotal : 1;
        note = 'scaled ' + bids.length + ' budgets x' + round2_(factor2) + ' (' + round2_(curTotal) + ' -> ' + round2_(target) + ')';
      }
      if (capped) note += ' [capped to +/-' + Math.round(MAX_CHANGE_PCT * 100) + '%]';
      mark_(data, H, p.row, DRY_RUN ? 'dry-run' : 'applied', note);
      results.push((DRY_RUN ? '~ ' : 'OK ') + p.label + ' — ' + note);
    } catch (e) {
      mark_(data, H, p.row, 'failed', String(e));
      results.push('X ' + p.label + ' — ' + e);
    }
  });

  tab.getRange(1, 1, data.length, data[0].length).setValues(data);
  emailSummary_(results);
  Logger.log(results.join('\n'));
}

/**
 * Set budgets by id within a given account. Returns {ok, note}.
 * Budgets can only be fetched/edited while their account is the selected one, so
 * we re-select here. AdsApp.budgets().withIds() is type-agnostic — it finds the
 * budget behind a Performance Max / Shopping / Video campaign just as well as Search.
 */
function applyPlan_(acctName, plan) {
  var bids = Object.keys(plan);
  if (!bids.length) return { ok: false, note: 'nothing to set' };

  // re-select the owning account
  var target = null;
  var accts = AdsManagerApp.accounts().withCondition("Name = '" + String(acctName).replace(/'/g, "\\'") + "'").get();
  if (accts.hasNext()) target = accts.next();
  if (!target) {
    // fall back to a full scan (name lookup can miss on odd characters)
    var all = AdsManagerApp.accounts().get();
    while (all.hasNext()) { var a = all.next(); if ((a.getName() || a.getCustomerId()) === acctName) { target = a; break; } }
  }
  if (!target) return { ok: false, note: 'account "' + acctName + '" not found on re-select' };
  AdsManagerApp.select(target);

  if (DRY_RUN) return { ok: true, note: 'dry-run' };

  var it = AdsApp.budgets().withIds(bids.map(Number)).get();
  var set = 0;
  while (it.hasNext()) { var b = it.next(); var id = String(b.getId()); if (plan[id] != null) { b.setAmount(plan[id]); set++; } }
  if (!set) return { ok: false, note: 'budget id(s) not found on re-select' };
  return { ok: true, note: 'set ' + set + ' budget(s)' };
}

function mark_(data, H, row, status, note) {
  data[row][H.Status] = status;
  if (H.AppliedAt !== undefined) data[row][H.AppliedAt] = new Date();
  if (H.Note !== undefined) data[row][H.Note] = note;
}
function clamp_(v, lo, hi) { return Math.max(lo, Math.min(hi, Number(v))); }
function round2_(n) { return Math.round(Number(n) * 100) / 100; }
function emailSummary_(results) {
  if (!results.length || !EMAIL_TO) return;
  var fails = 0;
  results.forEach(function (s) { if (s.charAt(0) === 'X') fails++; });
  var subj = 'Pacing budget apply' + (DRY_RUN ? ' (DRY RUN)' : '') + ' — ' + (results.length - fails) + ' ok'
           + (fails ? ', ' + fails + ' failed' : '');
  try { MailApp.sendEmail(EMAIL_TO, subj, results.join('\n')); } catch (e) { Logger.log('email failed: ' + e); }
}

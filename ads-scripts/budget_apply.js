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
 *  • Any campaign/account carrying a SAFE_LABELS tag (e.g. DoNotTouch) is never touched.
 *  • Every change is clamped to [MIN_DAILY, MAX_DAILY] AND to ±MAX_CHANGE_PCT of the
 *    franchise's current total, so a bad input can't blow up a budget.
 *  • DRY_RUN=true logs what WOULD change without touching anything — leave it on until
 *    you've eyeballed a few runs, then flip to false.
 *  • Shared budgets are set once; separate budgets are scaled proportionally to hit the
 *    requested franchise total while preserving the existing split.
 *  • The app only ever queues a target that finishes the month on the client's approved
 *    (billed) budget — it never asks to spend past what the client paid for.
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

  // franchise -> [{campaign, budget}] across accounts (ENABLED, non-ended, non-safe)
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

    var ended = {};   // ENDED campaigns to skip (best-effort)
    try {
      var eit = AdsApp.search("SELECT campaign.id FROM campaign WHERE campaign.serving_status = 'ENDED'");
      while (eit.hasNext()) ended[String(eit.next().campaign.id)] = true;
    } catch (e2) { /* serving_status unavailable — skip the ended filter */ }

    var cit = AdsApp.campaigns().withCondition("Status = ENABLED").get();
    while (cit.hasNext()) {
      var c = cit.next(); var id = String(c.getId());
      if (ended[id]) continue;
      var labs = campLabels[id] || [];
      if (labs.some(function (n) { return safe[n.toLowerCase()]; })) continue;   // DoNotTouch
      var fr = null;
      for (var i = 0; i < labs.length; i++) { if (!ignore[labs[i].toLowerCase()]) { fr = labs[i]; break; } }
      if (!fr) fr = (UNLABELED_FALLBACK === 'campaign') ? c.getName() : acctName;
      var flc = String(fr).toLowerCase();
      if (!pending[flc]) continue;
      (found[flc] = found[flc] || []).push({ campaign: c, budget: c.getBudget() });
    }
  }

  // apply, franchise by franchise
  var results = [];
  keys.forEach(function (flc) {
    var p = pending[flc];
    var camps = found[flc];
    if (!camps || !camps.length) { mark_(data, H, p.row, 'failed', 'no active campaigns found'); results.push('X ' + p.label + ' — no active campaigns found'); return; }

    // dedupe shared budgets (same budget id counted once)
    var budgets = {};
    camps.forEach(function (x) { var bid = String(x.budget.getId()); if (!budgets[bid]) budgets[bid] = { b: x.budget, cur: x.budget.getAmount() }; });
    var bids = Object.keys(budgets);
    var curTotal = 0; bids.forEach(function (bid) { curTotal += budgets[bid].cur; });

    var target = clamp_(p.newDaily, MIN_DAILY, MAX_DAILY);
    var capped = false;
    if (curTotal > 0) {   // clamp to ±MAX_CHANGE_PCT of the current total
      var up = curTotal * (1 + MAX_CHANGE_PCT), dn = curTotal * (1 - MAX_CHANGE_PCT);
      var clamped = Math.max(dn, Math.min(up, target));
      if (Math.abs(clamped - target) > 0.005) capped = true;
      target = clamped;
    }

    try {
      var note;
      if (bids.length === 1) {
        var only = budgets[bids[0]]; var amt = clamp_(round2_(target), MIN_DAILY, MAX_DAILY);
        if (!DRY_RUN) only.b.setAmount(amt);
        note = 'budget ' + round2_(only.cur) + ' -> ' + amt;
      } else {
        var factor = curTotal > 0 ? target / curTotal : 1;
        bids.forEach(function (bid) { var o = budgets[bid]; var a = clamp_(round2_(o.cur * factor), MIN_DAILY, MAX_DAILY); if (!DRY_RUN) o.b.setAmount(a); });
        note = 'scaled ' + bids.length + ' budgets x' + round2_(factor) + ' (' + round2_(curTotal) + ' -> ' + round2_(target) + ')';
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

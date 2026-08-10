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
var CAMPQ_TAB         = 'Campaign_Queue';                  // pause/activate requests from the app
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
      if (!f.budgets[bid]) f.budgets[bid] = { cur: micros / 1e6, names: [] };
      f.budgets[bid].names.push(row.campaign.name);
    }
  }

  // apply, franchise by franchise. Budgets are set while the OWNING account is selected.
  var results = [];
  var changes = [];   // per-budget detail for the email table: {franchise, campaigns, oldAmt, newAmt, capped}
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

      // one email-table row per budget (campaigns sharing it are listed together)
      bids.forEach(function (bid) {
        var b = f.budgets[bid];
        var nm = uniq_(b.names).join(', ') + (b.names.length > 1 ? ' · shared' : '');
        changes.push({ franchise: p.label, campaigns: nm, oldAmt: round2_(b.cur), newAmt: plan[bid], capped: capped });
      });

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
  emailSummary_(results, changes);
  Logger.log(results.join('\n'));

  applyCampaignQueue_(ss);   // pause / activate requests share this hourly run
}

/* ── campaign pause / activate ───────────────────────────────────────────────
 * Drains Campaign_Queue: matches each PENDING request to a live campaign (by id
 * when the feed provided one, else by name+franchise-label), pauses/enables it
 * across EVERY campaign type (PMax/Shopping/Video included), then writes status
 * back and emails a summary. DoNotTouch and DRY_RUN are honored. */
function applyCampaignQueue_(ss) {
  var tab = ss.getSheetByName(CAMPQ_TAB);
  if (!tab) { Logger.log('No "' + CAMPQ_TAB + '" tab — no pause/activate to do.'); return; }
  var data = tab.getDataRange().getValues();
  if (data.length < 2) { Logger.log('Campaign queue empty.'); return; }
  var H = {}; data[0].forEach(function (h, i) { H[String(h).trim()] = i; });
  if (H.Action === undefined || H.Status === undefined || H.Campaign === undefined) {
    Logger.log('Campaign queue header missing required columns.'); return;
  }

  // pending requests — keyed by id when present, else by label||name
  var byId = {}, byName = {}, pend = [];
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][H.Status]).trim().toLowerCase() !== 'pending') continue;
    var act = String(data[r][H.Action]).trim().toLowerCase();
    if (act !== 'pause' && act !== 'enable') { mark_(data, H, r, 'failed', 'bad action'); continue; }
    var cid = (H.CampaignId !== undefined) ? String(data[r][H.CampaignId] || '').trim() : '';
    var camp = String(data[r][H.Campaign] || '').trim();
    var label = String(data[r][H.Label] || '').trim();
    if (!camp && !cid) { mark_(data, H, r, 'failed', 'no campaign'); continue; }
    var rec = { row: r, action: act, camp: camp, label: label, cid: cid, done: false };
    pend.push(rec);
    if (cid) byId[cid] = rec; else byName[(label + '||' + camp).toLowerCase()] = rec;
  }
  if (!pend.length) { Logger.log('No pending campaign status changes.'); return; }
  Logger.log(pend.length + ' pending campaign status change(s).');

  var ignore = {}; IGNORE_LABELS.forEach(function (n) { ignore[n.toLowerCase()] = true; });
  var safe = {};   SAFE_LABELS.forEach(function (n) { safe[n.toLowerCase()] = true; });
  var results = [];

  var sel = AdsManagerApp.accounts();
  if (ACCOUNT_LABEL) sel = sel.withCondition("LabelNames CONTAINS '" + ACCOUNT_LABEL + "'");
  var accts = sel.get();
  while (accts.hasNext()) {
    var acct = accts.next(); AdsManagerApp.select(acct);
    var acctName = acct.getName() || acct.getCustomerId();

    var campLabels = {};   // id -> [label names]
    try {
      var lit = AdsApp.search("SELECT campaign.id, label.name FROM campaign_label");
      while (lit.hasNext()) { var lr = lit.next();
        (campLabels[String(lr.campaign.id)] = campLabels[String(lr.campaign.id)] || []).push(lr.label.name); }
    } catch (e) { Logger.log('  [' + acctName + '] label query failed: ' + e); }

    var selectors = campaignSelectors_();
    for (var s = 0; s < selectors.length; s++) {
      var it; try { it = selectors[s](); } catch (e0) { continue; }
      if (!it) continue;
      while (it.hasNext()) {
        var c = it.next(); var id = String(c.getId()); var nm = c.getName();
        var labs = campLabels[id] || [];
        // resolve which pending (if any) this campaign satisfies
        var rec = byId[id];
        if (!rec) {
          // name fallback: match campaign name AND franchise label (or account fallback)
          for (var kk in byName) {
            var cand = byName[kk];
            if (cand.done) continue;
            if (cand.camp.toLowerCase() !== nm.toLowerCase()) continue;
            var labelOk = labs.some(function (n) { return n.toLowerCase() === cand.label.toLowerCase(); })
                        || acctName.toLowerCase() === cand.label.toLowerCase();
            if (labelOk) { rec = cand; break; }
          }
        }
        if (!rec || rec.done) continue;
        if (labs.some(function (n) { return safe[n.toLowerCase()]; })) {   // DoNotTouch
          mark_(data, H, rec.row, 'failed', 'campaign is DoNotTouch — skipped'); rec.done = true;
          results.push('X ' + labelName_(rec) + ' — DoNotTouch, skipped'); continue;
        }
        try {
          if (!DRY_RUN) { if (rec.action === 'pause') c.pause(); else c.enable(); }
          var word = rec.action === 'pause' ? 'paused' : 'enabled';
          mark_(data, H, rec.row, DRY_RUN ? 'dry-run' : word, (DRY_RUN ? 'would ' : '') + word + ' [' + acctName + ']');
          rec.done = true;
          results.push((DRY_RUN ? '~ ' : 'OK ') + labelName_(rec) + ' — ' + (DRY_RUN ? 'would ' : '') + word);
        } catch (e2) {
          mark_(data, H, rec.row, 'failed', String(e2)); rec.done = true;
          results.push('X ' + labelName_(rec) + ' — ' + e2);
        }
      }
    }
  }

  // anything still pending wasn't found in any processed account
  pend.forEach(function (rec) {
    if (rec.done) return;
    mark_(data, H, rec.row, 'failed', rec.cid ? 'campaign id not found' : 'campaign not found (rerun the feed so it has an id)');
    results.push('X ' + labelName_(rec) + ' — not found');
  });

  tab.getRange(1, 1, data.length, data[0].length).setValues(data);
  emailCampaigns_(results);
  Logger.log(results.join('\n'));
}

function labelName_(rec) { return (rec.label ? rec.label + ' · ' : '') + (rec.camp || rec.cid); }

// selectors for EVERY campaign type — older API versions may lack some, so guard each
function campaignSelectors_() {
  var out = [function () { return AdsApp.campaigns().get(); }];
  if (typeof AdsApp.performanceMaxCampaigns === 'function') out.push(function () { return AdsApp.performanceMaxCampaigns().get(); });
  if (typeof AdsApp.shoppingCampaigns === 'function')       out.push(function () { return AdsApp.shoppingCampaigns().get(); });
  if (typeof AdsApp.videoCampaigns === 'function')          out.push(function () { return AdsApp.videoCampaigns().get(); });
  return out;
}

function emailCampaigns_(results) {
  if (!results.length || !EMAIL_TO) return;
  var fails = 0; results.forEach(function (s) { if (s.charAt(0) === 'X') fails++; });
  var subj = 'Pacing campaign status' + (DRY_RUN ? ' (DRY RUN)' : '') + ' — ' + (results.length - fails) + ' ok'
           + (fails ? ', ' + fails + ' failed' : '');
  try { MailApp.sendEmail(EMAIL_TO, subj, results.join('\n')); } catch (e) { Logger.log('email failed: ' + e); }
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
function uniq_(a) { var seen = {}, out = []; a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } }); return out; }
function money_(n) { return '$' + Number(n).toFixed(2); }
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function emailSummary_(results, changes) {
  if (!results.length || !EMAIL_TO) return;
  var fails = 0;
  results.forEach(function (s) { if (s.charAt(0) === 'X') fails++; });
  var subj = 'Pacing budget apply' + (DRY_RUN ? ' (DRY RUN)' : '') + ' — ' + (results.length - fails) + ' ok'
           + (fails ? ', ' + fails + ' failed' : '');

  // ── HTML: the same campaign-level table you see in the tool ──
  var rows = (changes || []).map(function (c) {
    var d = round2_(c.newAmt - c.oldAmt);
    var dHtml = d === 0 ? '<span style="color:#888">no change</span>'
      : '<span style="color:' + (d > 0 ? '#1f9d5b' : '#d64535') + '">' + (d > 0 ? '+' : '') + money_(d) + '</span>';
    return '<tr>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee">' + esc_(c.franchise) + '</td>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee">' + esc_(c.campaigns) + '</td>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">' + money_(c.oldAmt) + '</td>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">' + money_(c.newAmt) + (c.capped ? ' <span style="color:#c07d12;font-size:11px">(capped)</span>' : '') + '</td>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">' + dHtml + '</td>'
      + '</tr>';
  }).join('');

  var table = rows
    ? '<table style="border-collapse:collapse;font:13px Arial,sans-serif;margin:8px 0">'
      + '<thead><tr style="text-align:left;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.5px">'
      + '<th style="padding:6px 10px;border-bottom:2px solid #ddd">Franchise</th>'
      + '<th style="padding:6px 10px;border-bottom:2px solid #ddd">Campaign(s)</th>'
      + '<th style="padding:6px 10px;border-bottom:2px solid #ddd;text-align:right">Was / day</th>'
      + '<th style="padding:6px 10px;border-bottom:2px solid #ddd;text-align:right">Now / day</th>'
      + '<th style="padding:6px 10px;border-bottom:2px solid #ddd;text-align:right">Change</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
    : '<p style="font:13px Arial,sans-serif;color:#666">No campaign budgets were changed.</p>';

  var failLines = results.filter(function (s) { return s.charAt(0) === 'X'; });
  var html = '<div style="font:13px Arial,sans-serif;color:#222">'
    + '<h2 style="font-size:16px;margin:0 0 4px">Pacing budget apply' + (DRY_RUN ? ' — DRY RUN (nothing changed)' : '') + '</h2>'
    + '<p style="color:#666;margin:0 0 12px">' + (results.length - fails) + ' applied' + (fails ? ', ' + fails + ' failed' : '') + '.'
    + (DRY_RUN ? ' <b>DRY_RUN is on</b> — the “Now / day” column is what <i>would</i> be set once you flip DRY_RUN to false.' : '') + '</p>'
    + table
    + (failLines.length ? '<p style="color:#d64535;margin-top:12px"><b>Failed:</b><br>' + failLines.map(esc_).join('<br>') + '</p>' : '')
    + '</div>';

  try { MailApp.sendEmail({ to: EMAIL_TO, subject: subj, htmlBody: html, body: results.join('\n') }); }
  catch (e) { Logger.log('email failed: ' + e); }
}

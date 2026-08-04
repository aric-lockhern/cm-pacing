# Content Massive · Pacing

An internal dashboard for tracking monthly ad-spend **pacing** across franchise
accounts on Google Ads (including Local Services Ads) and Meta. It answers one
question per franchise: *are we on track to spend the month's budget by the end
of the month?* — and nudges the team in Slack when a franchise is over- or
under-pacing.

## Architecture

Three loosely-coupled parts, glued together by a single Google Sheet:

```
  Google Ads scripts            Apps Script web app            Static dashboard
  (ads-scripts/*.js)            (apps-script/*.gs)             (dashboard/*.html)
  ─────────────────             ───────────────────            ────────────────
  Pull spend / conv /   ─┐      Reads the sheet, serves    ┌─  Fetches JSON via
  budgets on a schedule  ├──▶   it as JSONP, posts to      │   JSONP, renders the
  and write them to      │      Slack, syncs budgets   ◀───┤   pacing table, lets
  the Google Sheet      ─┘         ▲                        │   the team edit
                                   │  Google Sheet          └─  budgets/settings
                                   └──(the shared datastore)
```

- The **Google Sheet** is the source of truth. Every component reads or writes
  named tabs (`Google_Feed`, `LSA_Feed`, `Daily_Google`, `Budgets`, …).
- The **gateway** is the only thing the dashboard and Slack talk to. It keeps the
  sheet private, dodges CORS via JSONP, and holds the Slack webhook server-side.
- The **dashboard** is a single static HTML file — no build step. Gateway URL,
  shared secret, and your name are stored per-browser in `localStorage`.

## Repository layout

| Path | What it is |
|------|-----------|
| `dashboard/index.html` | The single-file pacing dashboard (UI + all client JS/CSS). Includes the **Exec** tab — an all-channel summary rolled up to Account/brand, month + YTD, with a spend chart — and **Budget moves**, a channel-reallocation ledger. |
| `apps-script/sheet_gateway.gs` | Apps Script **web app** — the JSONP gateway, Slack poster, and budget sync. |
| `ads-scripts/google_pacing_feed.js` | Google Ads MCC script — writes Google spend/conv/budgets + per-campaign daily. Drops ENDED campaigns. |
| `ads-scripts/lsa_pacing_feed.js` | Google Ads MCC script for the **LSA** accounts (spend + conversions only, 365-day running total). |
| `ads-scripts/budget_apply.js` | Google Ads MCC script (hourly) that **applies** pacing budget changes queued from the app UI, within safety limits, and emails a summary. Starts in `DRY_RUN`. |

> Meta has no Google Ads-style script (Meta can't run one). Instead the gateway
> **pulls Meta daily spend + metrics from a DataSlayer Google Sheet** into
> `Meta_Daily` — configured under **Settings ▸ Meta / Facebook import**. The
> franchise is the campaign **tag**; untagged campaigns are skipped. It rewrites
> `Meta_Daily` on each sync (rolling window) and auto-syncs once a day.

## Budget moves (channel reallocation)

Sometimes you shift a franchise's budget **between channels** mid-month — e.g.
move spend from Google Ads into LSA — without changing what the client is
billed. Editing the master billing sheet would be wrong (the invoice didn't
change) and untrackable. Instead, **Budget moves** (header button) logs each
shift to a `Budget_Moves` tab and the app applies it *on top of* the synced
budgets:

- The move is `from` one channel `to` another, in **billed dollars**, scoped to
  a **month** — it's zero-sum, so the franchise's total budget is unchanged.
- Google's pacing target drops and LSA's rises by the moved amount, so neither
  looks falsely over-/under-pacing. The `Budgets` tab (from the master sheet) is
  never touched.
- Every move is one auditable row (id, who, when, from→to, amount, note) and is
  **reversible** — void it and targets revert. The deep-dive shows a note when a
  target was adjusted by a move.
- LSA moves apply across the burn-down pool window; Google/Meta apply to the
  calendar month. If a new split is permanent, set it directly in next month's
  budget column instead of logging a recurring move.

## Setup

### 1. The Google Sheet
Create (or reuse) one spreadsheet. All components point at it by ID/URL — it's
currently `16RYai7RW9By034nDapw7DKzVSRUdJIYk1B1ISNHYSLE`. The gateway creates any
missing tabs on first run.

### 2. The gateway (`apps-script/sheet_gateway.gs`)
1. Open the sheet ▸ **Extensions ▸ Apps Script** and paste in the file.
2. Set the config block at the top: `SPREADSHEET_ID`, `SHARED_SECRET`,
   `SLACK_WEBHOOK_URL` (and optionally `SLACK_BOT_TOKEN` / `SLACK_CHANNEL`).
3. Run `testSlack()` once in the editor to grant the external-request scope.
4. **Deploy ▸ New deployment ▸ Web app** ▸ *Execute as: Me* ▸ *Access: Anyone*.
5. Copy the `/exec` URL — that's the gateway URL the dashboard uses.
   > Every code change needs **Deploy ▸ Manage deployments ▸ ✏️ ▸ New version**.

### 3. The Ads scripts (`ads-scripts/*.js`)
Add each script under the relevant **MCC ▸ Tools ▸ Bulk actions ▸ Scripts**,
set the config block (`SPREADSHEET_URL`, `ACCOUNT_LABEL`, aliases…), authorize,
and schedule it (e.g. daily). Note the two run in **different MCCs**:
- `google_pacing_feed.js` → the main Google Ads MCC (only accounts labelled `Active`).
- `lsa_pacing_feed.js` → the *Content Massive - LSA Accounts* MCC.

### 4. The dashboard (`dashboard/index.html`)
Open the file in a browser (or host it anywhere static). On first use, open
**Settings** and set the Gateway URL, shared secret, and your name — or rely on
the defaults baked into the file. Fee rates and the budget sheet are shared by
the whole team (saved back to the sheet); URL/secret/name are per-browser.

## Config & secrets

The `SHARED_SECRET` must match across the gateway, the dashboard
(`DEFAULT_SECRET` in `index.html`), and any script that posts back. The Slack
webhook, the shared secret, and the spreadsheet IDs are currently **committed in
the source**. That's workable for an internal tool, but treat rotating the
secret / webhook as the way to revoke access, and don't make this repo public
without scrubbing them first.

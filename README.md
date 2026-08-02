# LinkedIn Comment Poller

Unipile has no webhook for new post comments (only Account, Messaging, Email/Tracking,
and New Relation events exist). This script does the polling *outside* n8n, so n8n's
execution quota is only spent when a real trigger-word comment is found -- not on every
empty check.

It also polls **multiple posts at once**, driven entirely by a Google Sheet -- add a
row when you publish a new post, no code or secrets changes needed per post.

## How it works

Every ~10-15 minutes (GitHub Actions cron), this repo runs `poll.js`, which:

1. Fetches the campaigns sheet (public, read via its CSV export URL -- no API key
   needed) and picks up every row that has a Post Link + Trigger Word and a blank
   `Status`.
2. For each active campaign, fetches all comments on that post via Unipile's API
   (auto-paginated) and filters for comments containing *that row's* trigger word
   that haven't been forwarded before (tracked per-post in
   `state/seen-comments.json`, committed back to the repo after each run).
3. POSTs each new match to your n8n workflow's webhook URL, including that
   campaign's lead magnet link/message and the post's resolved `social_id`, so n8n
   knows which post and which lead magnet to use without any static per-post config.

The n8n workflow ("LinkedIn Auto-DM - Comment Trigger to Lead Magnet DM") only executes
when this script actually POSTs something -- i.e. only on real new leads.

Every run also checks connection status for pending leads (see below) -- this used to
be a separate n8n-internal schedule trigger, but that's been folded into this same
script/cron job so there's only one polling schedule to think about, not two.

## Connection-status polling ("did they accept my connection request yet?")

Unipile has no reliable webhook for "someone accepted a connection request I
*received*" -- its `new_relation` webhook only covers invitations *you* sent that got
accepted by someone else (confirmed against live data: a real accepted connection sat
for 20+ hours with the webhook never firing). Same fix as the comments problem: poll
for it ourselves instead of waiting for a push event that doesn't cover this direction.

Every run, `poll.js` also:

1. Fetches the Lead Tracking sheet (the one n8n itself writes to, `LEAD_TRACKING_SHEET_ID`
   -- also read via its public CSV export URL) and finds every row where `dm_status` is
   still `not_sent`, `connection_status` isn't `UNREACHABLE` (skips company pages), and a
   `provider_id` is present (older rows from before this column existed are skipped --
   they'd need a one-off manual backfill to be picked up).
2. For each one, calls Unipile directly to check whether that person is now connected
   (`network_distance == "FIRST_DEGREE"` or `is_relationship == true`).
3. The moment one is, POSTs to n8n's `CONNECTION_CONFIRMED_WEBHOOK_URL`, which sends
   that person their lead magnet DM and logs it -- no need for them to comment again.

This step is entirely optional/soft-fail: if `LEAD_TRACKING_SHEET_ID` or
`CONNECTION_CONFIRMED_WEBHOOK_URL` aren't set, it's skipped with a log line, and the
comment-polling above runs completely unaffected.

## The campaigns sheet

Columns (see the sheet for the live version):

| Post Link | Trigger Word | Lead Magnet Link | DM Message 1 | DM Message 2 | DM Message 3 | Reply Message 1 | Reply Message 2 | Reply Message 3 | Status |
|---|---|---|---|---|---|---|---|---|---|

- **Post Link**: the full LinkedIn post URL. `poll.js` extracts the post ID and
  whether it's a `share` or `activity` URL straight from this string -- no manual
  type column needed.
- **Trigger Word**: the word to watch for in comments on that specific post.
- **Lead Magnet Link**: the single link sent to matching commenters (not
  randomized).
- **DM Message 1-3**: up to 3 variants of the private DM text. One is picked at
  random per matched comment. Leave any unused variant blank -- at least one is
  required.
- **Reply Message 1-3**: up to 3 variants of the public reply posted under their
  comment. Same random-pick behavior. n8n prepends an `@mention` of the commenter
  to whichever variant is picked, so LinkedIn notifies them directly.
- **Status**: leave blank while the campaign should keep being polled. Write
  anything into it (e.g. `done`, `paused`) to stop polling that post -- no need to
  delete the row.

**To run a new campaign:** add one row with the post link, trigger word, and lead
magnet. That's it -- nothing to touch in GitHub.

The sheet must be shared as **"Anyone with the link" -> Viewer** so the plain CSV
export URL (`https://docs.google.com/spreadsheets/d/{ID}/export?format=csv`) works
without authentication. Don't put anything sensitive in it (it's link-public) --
API keys and tokens stay in GitHub Secrets, never in the sheet.

## Setup

1. Create a GitHub repo and push this folder to it (already done for the current repo).
2. In the repo's **Settings -> Secrets and variables -> Actions**, add (these are
   fixed, set once, and never change per campaign):

   | Secret | Value |
   |---|---|
   | `UNIPILE_BASE_URL` | Your Unipile DSN, e.g. `https://api8.unipile.com:13008` |
   | `UNIPILE_ACCOUNT_ID` | Your Unipile LinkedIn `account_id` |
   | `UNIPILE_API_KEY` | Your Unipile API key |
   | `GOOGLE_SHEET_ID` | The ID from the campaigns sheet's URL (the long string between `/d/` and `/edit`) |
   | `N8N_WEBHOOK_URL` | `https://qismt.app.n8n.cloud/webhook/8f62b703-8f95-4656-9a53-3c860767c51b/unipile-comment-webhook` |
   | `LEAD_TRACKING_SHEET_ID` | `1TONtjXhWE1eYcpdNopHhib7Or-hpRYj_hAXo3MhENVE` (the Lead Tracking sheet n8n writes to) |
   | `CONNECTION_CONFIRMED_WEBHOOK_URL` | `https://qismt.app.n8n.cloud/webhook/fc575b3b-bd15-4b78-a826-6f04d4acd467/unipile-connection-confirmed-webhook` |

3. The workflow is scheduled via cron and also supports manual runs (Actions tab ->
   "Poll LinkedIn Comments" -> Run workflow) for testing.
4. **VERIFY before relying on this**: the Unipile request path, the `account_id`
   query param, the comments array field name (assumed `items`), the pagination
   cursor field name (assumed `cursor`), and the comment field names (`id`, `text`,
   `author`, `author_details.headline`) all need confirming against your actual
   Unipile API response.

## Adjusting the poll interval

Edit the `cron` line in `.github/workflows/poll-comments.yml`. GitHub Actions doesn't
guarantee exact timing on scheduled runs (expect some drift, especially at `*/5`), and
very short intervals put more load on both Unipile's API and your GitHub Actions minutes
quota (free tier: 2,000 min/month on private repos, unlimited on public repos). This
matters more now that one run polls every active post, not just one.

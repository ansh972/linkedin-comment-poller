# LinkedIn Comment Poller

Unipile has no webhook for new post comments (only Account, Messaging, Email/Tracking,
and New Relation events exist). This script does the polling *outside* n8n, so n8n's
execution quota is only spent when a real trigger-word comment is found -- not on every
empty check.

## How it works

Every ~10-15 minutes (GitHub Actions cron), this repo runs `poll.js`, which:

1. Fetches all comments on the configured LinkedIn post via Unipile's API (auto-paginated).
2. Filters for comments containing your trigger word that haven't been forwarded before
   (tracked in `state/seen-comments.json`, committed back to the repo after each run).
3. POSTs each new match to your n8n workflow's webhook URL.

The n8n workflow ("LinkedIn Auto-DM - Comment Trigger to Lead Magnet DM") only executes
when this script actually POSTs something -- i.e. only on real new leads.

## Setup

1. Create a GitHub repo and push this folder to it.
2. In the repo's **Settings -> Secrets and variables -> Actions**, add:

   | Secret | Value |
   |---|---|
   | `UNIPILE_BASE_URL` | Your Unipile DSN, e.g. `https://api8.unipile.com:13008` |
   | `UNIPILE_ACCOUNT_ID` | Your Unipile LinkedIn `account_id` |
   | `UNIPILE_API_KEY` | Your Unipile API key |
   | `POST_ID` | The LinkedIn post ID (numeric part of the post URL) |
   | `POST_ID_TYPE` | `share` or `activity` (see below) -- optional, defaults to `share` |
   | `TRIGGER_WORD` | e.g. `workflow` |
   | `N8N_WEBHOOK_URL` | `https://qismt.app.n8n.cloud/webhook/8f62b703-8f95-4656-9a53-3c860767c51b/unipile-comment-webhook` |

3. The workflow is scheduled via cron and also supports manual runs (Actions tab ->
   "Poll LinkedIn Comments" -> Run workflow) for testing.
4. **VERIFY before relying on this**: the Unipile request path, the `account_id` query
   param, the comments array field name (assumed `items`), the pagination cursor field
   name (assumed `cursor`), and the comment field names (`id`, `text`, `author_id`,
   `author_name`, `author_headline`) all need confirming against your actual Unipile
   API response -- these were carried over as assumptions from the original workflow
   and haven't been checked against live data yet.

## POST_ID_TYPE: share vs activity

LinkedIn post URLs come in two flavors, and Unipile needs different handling for each:

- `.../posts/name_text-**share**-1234567890-AbCd/` -> `POST_ID_TYPE=share`. The post's
  `social_id` (needed for all comment/reply calls) is just `urn:li:share:{POST_ID}` --
  no extra API call needed.
- `.../posts/name_text-**activity**-1234567890-AbCd/` or
  `.../feed/update/urn:li:activity:1234567890/` -> `POST_ID_TYPE=activity`. The numeric
  ID only works to look up the post; the poller calls `GET /api/v1/posts/{POST_ID}`
  once per run to read the real `social_id` off the response.

Check your post's URL to know which one to set. Get this wrong and you'll see a 404
"resource not found" (tried `activity` lookup on a `share` post) or a 400
"invalid post_id" (tried using the raw numeric ID directly for a post that actually
needed the `activity` lookup).

**Important**: n8n's `Set Config` node has its own `postId` value used to build reply
URLs (`POST /api/v1/posts/{postId}/comments`) -- it needs to hold the *resolved*
`social_id` string (e.g. `urn:li:share:7489052847762784256`), not the raw numeric ID,
or those calls will fail the same way.

## Adjusting the poll interval

Edit the `cron` line in `.github/workflows/poll-comments.yml`. GitHub Actions doesn't
guarantee exact timing on scheduled runs (expect some drift, especially at `*/5`), and
very short intervals put more load on both Unipile's API and your GitHub Actions minutes
quota (free tier: 2,000 min/month on private repos, unlimited on public repos).

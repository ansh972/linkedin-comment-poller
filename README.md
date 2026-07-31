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

## Adjusting the poll interval

Edit the `cron` line in `.github/workflows/poll-comments.yml`. GitHub Actions doesn't
guarantee exact timing on scheduled runs (expect some drift, especially at `*/5`), and
very short intervals put more load on both Unipile's API and your GitHub Actions minutes
quota (free tier: 2,000 min/month on private repos, unlimited on public repos).

// Polls Unipile for new comments on a LinkedIn post, filters for a trigger word,
// and forwards only genuinely new matches to the n8n production webhook.
// State (which comment IDs we've already forwarded) is persisted in state/seen-comments.json,
// committed back to the repo by the GitHub Actions workflow after each run.

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "state", "seen-comments.json");
const MAX_SEEN_IDS_KEPT = 1000;

const {
  UNIPILE_BASE_URL,
  UNIPILE_ACCOUNT_ID,
  UNIPILE_API_KEY,
  POST_ID,
  // "share" (default) or "activity" -- which kind of LinkedIn post URL POST_ID came from.
  // Look at the post's URL: ".../posts/name_text-share-1234567890-AbCd" -> "share",
  // ".../posts/name_text-activity-1234567890-AbCd" or ".../feed/update/urn:li:activity:1234567890" -> "activity".
  POST_ID_TYPE = "share",
  TRIGGER_WORD,
  N8N_WEBHOOK_URL,
} = process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

requireEnv("UNIPILE_BASE_URL", UNIPILE_BASE_URL);
requireEnv("UNIPILE_ACCOUNT_ID", UNIPILE_ACCOUNT_ID);
requireEnv("UNIPILE_API_KEY", UNIPILE_API_KEY);
requireEnv("POST_ID", POST_ID);
requireEnv("TRIGGER_WORD", TRIGGER_WORD);
requireEnv("N8N_WEBHOOK_URL", N8N_WEBHOOK_URL);

function loadSeenIds() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed.seenIds) ? parsed.seenIds : []);
  } catch {
    return new Set();
  }
}

function saveSeenIds(seenSet) {
  const idsArray = Array.from(seenSet).slice(-MAX_SEEN_IDS_KEPT);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ seenIds: idsArray, updatedAt: new Date().toISOString() }, null, 2)
  );
}

// VERIFY: path, account_id query param, response shape (comments array field name,
// pagination cursor field name) against your Unipile docs -- same caveat that applied
// to the old in-n8n HTTP Request node.

// Every post interaction (listing comments, posting a reply) needs the post's
// "social_id", not the raw numeric ID from the URL. How to get it depends on which
// URL variant the numeric ID came from:
//   - "share" URLs: the social_id is just `urn:li:share:{numeric id}`, no lookup needed.
//   - "activity" URLs: the numeric id works to look up the post, whose response
//     contains the real social_id (usually `urn:li:activity:{numeric id}`, but let
//     the API tell us rather than assuming).
async function resolveSocialId() {
  if (POST_ID_TYPE === "share") {
    const socialId = `urn:li:share:${POST_ID}`;
    console.log(`Using share social_id: ${socialId}`);
    return socialId;
  }

  const url = new URL(`${UNIPILE_BASE_URL}/api/v1/posts/${POST_ID}`);
  url.searchParams.set("account_id", UNIPILE_ACCOUNT_ID);

  const response = await fetch(url, {
    headers: { "X-API-KEY": UNIPILE_API_KEY, accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Unipile post lookup failed: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  if (!body.social_id) {
    throw new Error(`Unipile post response had no social_id: ${JSON.stringify(body)}`);
  }

  console.log(`Resolved social_id for post ${POST_ID}: ${body.social_id}`);
  return body.social_id;
}

async function fetchAllComments(socialId) {
  const comments = [];
  let cursor = null;

  do {
    const url = new URL(`${UNIPILE_BASE_URL}/api/v1/posts/${encodeURIComponent(socialId)}/comments`);
    url.searchParams.set("account_id", UNIPILE_ACCOUNT_ID);
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: { "X-API-KEY": UNIPILE_API_KEY, accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Unipile request failed: ${response.status} ${await response.text()}`);
    }

    const body = await response.json();
    comments.push(...(body.items || []));
    cursor = body.cursor || null;
  } while (cursor);

  return comments;
}

async function forwardToN8n(comment) {
  const response = await fetch(N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: comment.id,
      text: comment.text,
      // Unipile's comment object has no display name -- only an opaque author id
      // and author_details.headline. n8n resolves the actual name later via the
      // profile lookup it already does for connection-status checking.
      author_id: comment.author,
      author_headline: comment.author_details ? comment.author_details.headline : null,
    }),
  });

  if (!response.ok) {
    throw new Error(`n8n webhook call failed: ${response.status} ${await response.text()}`);
  }
}

async function main() {
  const seenIds = loadSeenIds();
  const socialId = await resolveSocialId();
  const comments = await fetchAllComments(socialId);

  const newMatches = comments.filter(
    (c) =>
      c.id &&
      !seenIds.has(c.id) &&
      typeof c.text === "string" &&
      c.text.toLowerCase().includes(TRIGGER_WORD.toLowerCase())
  );

  console.log(`Fetched ${comments.length} comments, ${newMatches.length} new trigger-word match(es).`);

  for (const comment of newMatches) {
    console.log(`Forwarding comment ${comment.id} from author ${comment.author}`);
    await forwardToN8n(comment);
    seenIds.add(comment.id);
  }

  if (newMatches.length > 0) {
    saveSeenIds(seenIds);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
async function fetchAllComments() {
  const comments = [];
  let cursor = null;

  do {
    const url = new URL(`${UNIPILE_BASE_URL}/api/v1/posts/${POST_ID}/comments`);
    url.searchParams.set("account_id", UNIPILE_ACCOUNT_ID);
    url.searchParams.set("limit", "50");
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${UNIPILE_API_KEY}` },
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
      author_id: comment.author_id,
      author_name: comment.author_name,
      author_headline: comment.author_headline,
    }),
  });

  if (!response.ok) {
    throw new Error(`n8n webhook call failed: ${response.status} ${await response.text()}`);
  }
}

async function main() {
  const seenIds = loadSeenIds();
  const comments = await fetchAllComments();

  const newMatches = comments.filter(
    (c) =>
      c.id &&
      !seenIds.has(c.id) &&
      typeof c.text === "string" &&
      c.text.toLowerCase().includes(TRIGGER_WORD.toLowerCase())
  );

  console.log(`Fetched ${comments.length} comments, ${newMatches.length} new trigger-word match(es).`);

  for (const comment of newMatches) {
    console.log(`Forwarding comment ${comment.id} from ${comment.author_name || comment.author_id}`);
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

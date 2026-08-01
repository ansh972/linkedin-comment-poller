// Polls Unipile for new comments across every active campaign listed in a public
// Google Sheet, filters each post's comments for that campaign's trigger word,
// and forwards only genuinely new matches to the n8n production webhook.
// State (which comment IDs we've already forwarded, per post) is persisted in
// state/seen-comments.json, committed back to the repo by the GitHub Actions
// workflow after each run.
//
// Campaigns come from a Google Sheet (public "anyone with the link can view"),
// read via its plain CSV export URL -- no service account or API key needed.
// Sheet columns: Post Link, Trigger Word, Lead Magnet Link, DM Message 1-3,
// Reply Message 1-3, Status. A row is "active" as long as Status is blank.
// Write anything into Status (e.g. "done") to stop polling that post.
// One DM variant and one reply variant are picked at random per matched
// comment, so repeat commenters don't all see identical text.

const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "state", "seen-comments.json");
const MAX_SEEN_IDS_KEPT_PER_POST = 1000;

const { UNIPILE_BASE_URL, UNIPILE_ACCOUNT_ID, UNIPILE_API_KEY, GOOGLE_SHEET_ID, N8N_WEBHOOK_URL } =
  process.env;

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

requireEnv("UNIPILE_BASE_URL", UNIPILE_BASE_URL);
requireEnv("UNIPILE_ACCOUNT_ID", UNIPILE_ACCOUNT_ID);
requireEnv("UNIPILE_API_KEY", UNIPILE_API_KEY);
requireEnv("GOOGLE_SHEET_ID", GOOGLE_SHEET_ID);
requireEnv("N8N_WEBHOOK_URL", N8N_WEBHOOK_URL);

function loadSeenState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    // Migrate the old flat-array format ({ seenIds: [...] }) transparently --
    // there's no way to know which post those IDs belonged to, so just drop them.
    if (Array.isArray(parsed.seenIds)) return {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSeenState(state) {
  const trimmed = {};
  for (const [postKey, ids] of Object.entries(state)) {
    trimmed[postKey] = ids.slice(-MAX_SEEN_IDS_KEPT_PER_POST);
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(trimmed, null, 2));
}

// --- Minimal CSV parsing (handles quoted fields with commas, per RFC 4180) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

async function fetchCampaigns() {
  const url = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch campaigns sheet: ${response.status}. Is it shared "Anyone with the link can view"?`
    );
  }

  const rows = parseCsv(await response.text());
  const [header, ...dataRows] = rows;
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name);

  const idx = {
    postLink: col("post link"),
    triggerWord: col("trigger word"),
    leadMagnetLink: col("lead magnet link"),
    dmMessages: [col("dm message 1"), col("dm message 2"), col("dm message 3")],
    replyMessages: [col("reply message 1"), col("reply message 2"), col("reply message 3")],
    status: col("status"),
  };

  const campaigns = [];
  for (const row of dataRows) {
    const postLink = (row[idx.postLink] || "").trim();
    const triggerWord = (row[idx.triggerWord] || "").trim();
    const status = (row[idx.status] || "").trim();

    if (!postLink || !triggerWord) continue; // incomplete row, skip
    if (status) continue; // anything in Status means "not active"
    if (postLink.includes("example.com") || postLink.includes("/posts/example")) continue; // template placeholder row

    const parsed = parsePostUrl(postLink);
    if (!parsed) {
      console.error(`Could not parse post ID/type from URL, skipping: ${postLink}`);
      continue;
    }

    const dmMessages = idx.dmMessages.map((i) => (row[i] || "").trim()).filter(Boolean);
    const replyMessages = idx.replyMessages.map((i) => (row[i] || "").trim()).filter(Boolean);

    if (dmMessages.length === 0 || replyMessages.length === 0) {
      console.error(`Row for ${postLink} has no DM/reply message variants filled in, skipping.`);
      continue;
    }

    campaigns.push({
      postLink,
      postId: parsed.postId,
      postIdType: parsed.postIdType,
      triggerWord,
      leadMagnetLink: (row[idx.leadMagnetLink] || "").trim(),
      dmMessages,
      replyMessages,
    });
  }
  return campaigns;
}

// Extracts the numeric post ID and whether it's a "share" or "activity" URL,
// straight from the LinkedIn post URL -- no manual column needed.
//   .../posts/name_text-share-1234567890-AbCd/        -> share
//   .../posts/name_text-activity-1234567890-AbCd/     -> activity
//   .../feed/update/urn:li:activity:1234567890/       -> activity
function parsePostUrl(url) {
  let match = url.match(/urn:li:activity:(\d+)/);
  if (match) return { postId: match[1], postIdType: "activity" };

  match = url.match(/-(share|activity)-(\d+)-/);
  if (match) return { postId: match[2], postIdType: match[1] };

  return null;
}

// Every post interaction (listing comments, posting a reply) needs the post's
// "social_id", not the raw numeric ID from the URL.
//   - "share" URLs: the social_id is just `urn:li:share:{numeric id}`, no lookup needed.
//   - "activity" URLs: look the post up; the response holds the real social_id.
async function resolveSocialId(postId, postIdType) {
  if (postIdType === "share") {
    return `urn:li:share:${postId}`;
  }

  const url = new URL(`${UNIPILE_BASE_URL}/api/v1/posts/${postId}`);
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

function pickRandom(options) {
  return options[Math.floor(Math.random() * options.length)];
}

async function forwardToN8n(comment, campaign, socialId) {
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
      post_social_id: socialId,
      lead_magnet_link: campaign.leadMagnetLink,
      // One of up to 3 sheet-provided variants, picked per-comment so repeat
      // commenters on the same post don't all see identical text.
      lead_magnet_message: pickRandom(campaign.dmMessages),
      reply_message: pickRandom(campaign.replyMessages),
    }),
  });

  if (!response.ok) {
    throw new Error(`n8n webhook call failed: ${response.status} ${await response.text()}`);
  }
}

async function processCampaign(campaign, seenState) {
  const postKey = `${campaign.postIdType}:${campaign.postId}`;
  const seenIds = new Set(seenState[postKey] || []);

  const socialId = await resolveSocialId(campaign.postId, campaign.postIdType);
  const comments = await fetchAllComments(socialId);

  const newMatches = comments.filter(
    (c) =>
      c.id &&
      !seenIds.has(c.id) &&
      typeof c.text === "string" &&
      c.text.toLowerCase().includes(campaign.triggerWord.toLowerCase())
  );

  console.log(
    `[${postKey}] fetched ${comments.length} comment(s), ${newMatches.length} new "${campaign.triggerWord}" match(es).`
  );

  for (const comment of newMatches) {
    console.log(`[${postKey}] forwarding comment ${comment.id} from author ${comment.author}`);
    await forwardToN8n(comment, campaign, socialId);
    seenIds.add(comment.id);
  }

  if (newMatches.length > 0) {
    seenState[postKey] = Array.from(seenIds);
  }
}

async function main() {
  const seenState = loadSeenState();
  const campaigns = await fetchCampaigns();

  console.log(`Loaded ${campaigns.length} active campaign(s) from the sheet.`);

  let anyStateChanged = false;
  const stateBefore = JSON.stringify(seenState);

  for (const campaign of campaigns) {
    try {
      await processCampaign(campaign, seenState);
    } catch (err) {
      // One bad/misconfigured row shouldn't stop the other campaigns from polling.
      console.error(`Error processing campaign for ${campaign.postLink}:`, err);
    }
  }

  anyStateChanged = JSON.stringify(seenState) !== stateBefore;
  if (anyStateChanged) {
    saveSeenState(seenState);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

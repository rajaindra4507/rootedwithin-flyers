#!/usr/bin/env node
/**
 * Rooted Within — Instagram feed publisher
 *
 * Runs in GitHub Actions, NOT in the Claude sandbox (Meta hosts are blocked there).
 * Reads the day's manifest committed by the daily Claude task, then publishes the
 * square flyer to the Instagram feed via the official Content Publishing API.
 *
 * Required env:
 *   IG_USER_ID        Instagram professional account ID
 *   IG_ACCESS_TOKEN   Long-lived Instagram access token
 *   PUBLIC_BASE_URL   Public https base that serves the flyer, e.g. https://rootedwithin.my
 * Optional env:
 *   GRAPH_VERSION     Default v23.0 — check against current Meta docs and bump if needed
 *   POSTS_DIR         Default "posts"
 *   DRY_RUN           "1" to do everything except the two writing calls
 */

const API = 'https://graph.instagram.com';
const VERSION = process.env.GRAPH_VERSION || 'v23.0';
const POSTS_DIR = process.env.POSTS_DIR || 'posts';
const DRY_RUN = process.env.DRY_RUN === '1';

const { IG_USER_ID, IG_ACCESS_TOKEN, PUBLIC_BASE_URL } = process.env;

const fs = await import('node:fs/promises');
const path = await import('node:path');

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFile(process.env.GITHUB_STEP_SUMMARY, line + '\n').catch(() => {});
  }
}

// Malaysia date (UTC+8) — never the runner's local date.
function malaysiaToday() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

async function call(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = body?.error?.message || body?.raw || res.statusText;
    throw new Error(`${res.status} ${err}`);
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!IG_USER_ID || !IG_ACCESS_TOKEN || !PUBLIC_BASE_URL) {
    fail('Missing IG_USER_ID, IG_ACCESS_TOKEN or PUBLIC_BASE_URL.');
  }

  const today = malaysiaToday();
  const manifestPath = path.join(POSTS_DIR, `${today}.json`);

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch {
    summary(`No manifest at ${manifestPath}. The daily task did not produce a post for ${today} (MY). Nothing published.`);
    fail(`No post prepared for ${today}. Check that the daily Claude task ran and committed its manifest.`);
  }

  summary(`### Day ${manifest.day} — ${manifest.topic}`);
  summary(`Pillar: ${manifest.pillar} · Date: ${today} (MY)`);

  // Safety valve: the daily run flags anything it could not verify.
  if (manifest.blocked === true) {
    summary(`\n**HELD — not published.**`);
    summary(`Reason: ${manifest.blockedReason || '(none given)'}`);
    summary(`\nResolve it, set "blocked": false in ${manifestPath}, then re-run this workflow manually.`);
    fail(`Post is flagged blocked and was NOT published: ${manifest.blockedReason || 'no reason given'}`);
  }

  if (!manifest.image || !manifest.caption) {
    fail(`Manifest is missing "image" or "caption".`);
  }

  const imageUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/${manifest.image.replace(/^\//, '')}`;

  // Meta fetches this URL itself — if it is not publicly reachable, publishing fails
  // with an unhelpful error, so check it here where the message is clear.
  const head = await fetch(imageUrl, { method: 'GET', headers: { Range: 'bytes=0-0' } })
    .catch((e) => fail(`Could not reach the image at ${imageUrl} — ${e.message}`));
  if (!head.ok) fail(`Image is not publicly reachable: ${imageUrl} returned HTTP ${head.status}. Meta must be able to fetch it anonymously.`);
  summary(`Image OK: ${imageUrl}`);

  if (DRY_RUN) {
    summary(`\nDRY_RUN — stopping before publishing. Caption is ${manifest.caption.length} characters.`);
    return;
  }

  // Step 1 — create the media container.
  const createUrl = new URL(`${API}/${VERSION}/${IG_USER_ID}/media`);
  const createBody = new URLSearchParams({
    image_url: imageUrl,
    caption: manifest.caption,
    access_token: IG_ACCESS_TOKEN,
  });
  if (manifest.altText) createBody.set('alt_text', manifest.altText);

  const container = await call(createUrl, { method: 'POST', body: createBody })
    .catch((e) => fail(`Creating the media container failed — ${e.message}`));
  summary(`Container created: ${container.id}`);

  // Step 2 — wait for Meta to finish ingesting the image.
  let state = '';
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const s = await call(`${API}/${VERSION}/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`)
      .catch((e) => fail(`Polling the container failed — ${e.message}`));
    state = s.status_code;
    if (state === 'FINISHED') break;
    if (state === 'ERROR' || state === 'EXPIRED') {
      fail(`Container ended in state ${state}. ${s.status || ''}`);
    }
  }
  if (state !== 'FINISHED') fail(`Container never reached FINISHED (last state: ${state || 'unknown'}).`);

  // Step 3 — publish.
  const published = await call(`${API}/${VERSION}/${IG_USER_ID}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: container.id, access_token: IG_ACCESS_TOKEN }),
  }).catch((e) => fail(`Publishing failed — ${e.message}`));

  summary(`\n**Published.** Media ID: ${published.id}`);

  // Step 4 — the hashtag block / pinned comment, if the manifest carries one.
  // Needs the instagram_business_manage_comments scope; a failure here must not
  // fail the run, because the post itself is already live.
  if (manifest.firstComment) {
    try {
      const c = await call(`${API}/${VERSION}/${published.id}/comments`, {
        method: 'POST',
        body: new URLSearchParams({ message: manifest.firstComment, access_token: IG_ACCESS_TOKEN }),
      });
      summary(`First comment posted: ${c.id}`);
    } catch (e) {
      summary(`\n⚠ Post is live but the first comment failed — ${e.message}`);
      summary(`Add it by hand. (Needs the instagram_business_manage_comments scope.)`);
    }
  }

  summary(`\nhttps://www.instagram.com/rootedwithin.my/`);
}

await main();

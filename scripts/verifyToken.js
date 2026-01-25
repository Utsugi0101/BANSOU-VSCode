const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function getPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    fail('GITHUB_EVENT_PATH is not set.');
  }
  const raw = fs.readFileSync(eventPath, 'utf8');
  return JSON.parse(raw);
}

function getRepoSlug() {
  const owner = process.env.GITHUB_REPOSITORY_OWNER;
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
  if (!owner || !repo) {
    fail('GITHUB_REPOSITORY is not set.');
  }
  return `${owner}/${repo}`;
}

function extractToken(text) {
  if (!text) return null;
  const match = text.match(/BANSOU:\s*([A-Za-z0-9_\-\.=]+)/);
  return match ? match[1] : null;
}

function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 2) {
    fail('Token format invalid.');
  }
  const [payloadB64, signature] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  if (signature !== expected) {
    fail('Token signature mismatch.');
  }
  const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
  return JSON.parse(payloadJson);
}

async function main() {
  const secret = process.env.UNDERSTANDING_TOKEN_SECRET;
  if (!secret) {
    fail('UNDERSTANDING_TOKEN_SECRET is not set.');
  }
  const payload = getPayload();
  const pr = payload.pull_request;
  if (!pr) {
    fail('This workflow must run on pull_request events.');
  }
  const repoSlug = getRepoSlug();
  const token =
    extractToken(pr.body) ||
    extractToken(payload.comment?.body) ||
    null;
  if (!token) {
    fail('BANSOU token not found in PR body or comment.');
  }
  const decoded = verifyToken(token, secret);
  if (decoded.repo !== repoSlug) {
    fail(`Token repo mismatch: ${decoded.repo} != ${repoSlug}`);
  }
  if (decoded.commit !== pr.head.sha) {
    fail(`Token commit mismatch: ${decoded.commit} != ${pr.head.sha}`);
  }
  const minScore = Number(process.env.MIN_SCORE ?? 80);
  if (decoded.score < minScore) {
    fail(`Token score too low: ${decoded.score} < ${minScore}`);
  }
  console.log('BANSOU token verified.');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

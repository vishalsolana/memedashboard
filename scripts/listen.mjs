// Live listener: counts pump.fun creations and migrations from PumpPortal's free
// feed, fills in create times (Solana RPC) and post-bond highs (GeckoTerminal),
// and serves the dashboard at http://localhost:3000.
//
//   npm run listen
//
// Env:
//   PORT                 dashboard port (default 3000, 0 to disable)
//   SOLANA_RPC_URL       RPC for create times of tokens created before the listener started
//   CREATE_MEMORY_DAYS   how long to remember create times for time-to-bond (default 3)
//   ENRICH_MINUTES       how often to fetch create times and highs (default 15)
//   PUBLISH_MINUTES      commit + push the data files every N minutes so Vercel
//                        redeploys (default 0 = off; needs a git clone with push access)

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gecko, updateHighs } from './lib/gecko.mjs';
import { PUMPPORTAL_URL as DEFAULT_FEED, SUBSCRIBE, parseEvent } from './lib/pumpportal.mjs';
import { fillCreateTimes, SolanaRpc } from './lib/rpc.mjs';
import { addBonds, addCoverage, buildPublic, DAY, dayKey, emptyState, prune } from './lib/stats.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const STATE = join(root, 'data/state.json');
const CREATES = join(root, 'data/creates.json');
const PUBLIC_DIR = join(root, 'public');
const PUBLIC = join(PUBLIC_DIR, 'data.json');

const env = process.env;
const PORT = Number(env.PORT ?? 3000);
const PUMPPORTAL_URL = env.PUMPPORTAL_URL || DEFAULT_FEED;
const MEMORY = Number(env.CREATE_MEMORY_DAYS ?? 3) * DAY;
const ENRICH_MS = Number(env.ENRICH_MINUTES ?? 15) * 60_000;
const PUBLISH_MS = Number(env.PUBLISH_MINUTES ?? 0) * 60_000;
const STALE_MS = 90_000; // reconnect if nothing arrives for this long
const now = () => Math.floor(Date.now() / 1000);

if (typeof WebSocket === 'undefined') {
  console.error('This needs Node.js 22 or newer (built-in WebSocket).');
  process.exit(1);
}

const state = await loadJson(STATE, emptyState, (s) => s.version === 2);
const creates = new Map(Object.entries(await loadJson(CREATES, () => ({}))));
const counts = { creates: 0, bonds: 0 };

let ws = null;
let connectedAt = null;
let lastMessageAt = null;
let retry = 0;

function connect() {
  ws = new WebSocket(PUMPPORTAL_URL);
  ws.onopen = () => {
    connectedAt = now();
    lastMessageAt = Date.now();
    retry = 0;
    for (const sub of SUBSCRIBE) ws.send(JSON.stringify(sub));
    log(`connected to ${PUMPPORTAL_URL}`);
  };
  ws.onmessage = (e) => {
    lastMessageAt = Date.now();
    handle(parseEvent(String(e.data), now()));
  };
  ws.onerror = () => {}; // onclose follows with the details
  ws.onclose = (e) => {
    closeCoverage();
    const wait = Math.min(60, 2 ** retry++) * 1000;
    log(`disconnected (${e.code}${e.reason ? ` ${e.reason}` : ''}), reconnecting in ${wait / 1000}s`);
    setTimeout(connect, wait);
  };
}

function handle(ev) {
  if (!ev) return;
  if (ev.type === 'info') return log(`pumpportal: ${ev.text}`);
  if (ev.type === 'create') {
    const day = dayKey(ev.at);
    state.days[day] = { created: (state.days[day]?.created ?? 0) + 1 };
    creates.set(ev.mint, ev.at);
    counts.creates++;
    return;
  }
  addBonds(state, [{ mint: ev.mint, bonded_at: ev.at, signature: ev.signature }]);
  const t = state.tokens[ev.mint];
  t.symbol ??= ev.symbol;
  t.name ??= ev.name;
  if (t.created_at == null && creates.has(ev.mint)) {
    t.created_at = creates.get(ev.mint);
    t.create_checked = true;
  }
  counts.bonds++;
  const ttb = t.created_at != null ? ` after ${Math.round((t.bonded_at - t.created_at) / 60)}m` : '';
  log(`bonded ${t.symbol ?? ev.mint}${ttb}`);
}

function closeCoverage() {
  if (connectedAt == null) return;
  addCoverage(state, connectedAt, Math.floor((lastMessageAt ?? Date.now()) / 1000));
  connectedAt = null;
}

function extendCoverage() {
  if (connectedAt != null) addCoverage(state, connectedAt, now());
}

async function save() {
  extendCoverage();
  prune(state, now());
  const cutoff = now() - MEMORY;
  for (const [mint, at] of creates) if (at < cutoff) creates.delete(mint);
  state.cursor = new Date().toISOString();
  await writeAtomic(STATE, JSON.stringify(state) + '\n');
  await writeAtomic(PUBLIC, JSON.stringify(buildPublic(state, now())) + '\n');
}

let enriching = false;
async function enrich() {
  if (enriching) return;
  enriching = true;
  try {
    const rpc = new SolanaRpc({ url: env.SOLANA_RPC_URL || undefined, budget: 100, log });
    const r = await fillCreateTimes(state, rpc).catch((err) => log(`rpc: ${err.message}`));
    if (r) log(`rpc: ${r.found} create times found, ${r.left} left`);
    const gecko = new Gecko({ budget: 100, log });
    const g = await updateHighs(state, gecko, now()).catch((err) => log(`gecko: ${err.message}`));
    if (g) log(`gecko: ${g.done} highs updated, ${g.queued} queued`);
    await save();
  } finally {
    enriching = false;
  }
}

// Pushes the data files to the current branch. Vercel redeploys on each push,
// so keep the interval at 30 minutes or more (Hobby allows 100 deploys a day).
async function publish() {
  const git = (...args) =>
    new Promise((resolve, reject) =>
      execFile('git', args, { cwd: root }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
    );
  try {
    await git('add', 'data/state.json', 'public/data.json');
    if (!(await git('status', '--porcelain', 'data/state.json', 'public/data.json')).trim()) return;
    await git('commit', '-m', `data: live update ${new Date().toISOString().slice(0, 16)}Z`);
    await git('pull', '--rebase', '--autostash');
    await git('push');
    log('published data to GitHub');
  } catch (err) {
    log(`publish failed: ${err.message.trim().split('\n')[0]}`);
  }
}

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(PUBLIC_DIR, path || 'index.html');
    if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
    const stream = createReadStream(file);
    stream.on('open', () => {
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      stream.pipe(res);
    });
    stream.on('error', () => res.writeHead(404).end('not found'));
  }).listen(PORT, () => log(`dashboard: http://localhost:${PORT}`));
}

async function shutdown() {
  log('saving and exiting…');
  closeCoverage();
  await save();
  await writeAtomic(CREATES, JSON.stringify(Object.fromEntries(creates)));
  process.exit(0);
}

async function loadJson(path, fallback, valid = () => true) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    return valid(data) ? data : fallback();
  } catch {
    return fallback();
  }
}

async function writeAtomic(path, text) {
  await writeFile(path + '.tmp', text);
  try {
    await rename(path + '.tmp', path);
  } catch {
    // Windows refuses to replace a file that is open (e.g. being served); write in place.
    await writeFile(path, text);
  }
}

function log(msg) {
  console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);
}

connect();
if (PORT) serve();
await save();

setInterval(() => save().catch((err) => log(`save failed: ${err.message}`)), 60_000);
setInterval(() => writeAtomic(CREATES, JSON.stringify(Object.fromEntries(creates))).catch(() => {}), 5 * 60_000);
setInterval(() => {
  log(`last minute: ${counts.creates} created, ${counts.bonds} bonded`);
  counts.creates = counts.bonds = 0;
}, 60_000);
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > STALE_MS) {
    log('no messages for 90s, reconnecting');
    ws.close();
  }
}, 15_000);
setTimeout(() => {
  enrich();
  setInterval(enrich, ENRICH_MS);
}, 60_000);

if (PUBLISH_MS) {
  log(`publishing to GitHub every ${PUBLISH_MS / 60_000} min`);
  setInterval(() => save().then(publish), PUBLISH_MS);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

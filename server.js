// Roblox games overview: serves the dashboard and proxies Roblox's public APIs
// (browsers can't call them directly because of CORS). It also samples player
// counts every minute so the dashboard can show trends over the last 24 hours.
//
// Usage: node server.js            (then open http://localhost:3000)
//        PORT=8080 node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const POLL_MS = 60 * 1000;
const HISTORY_MS = 24 * 60 * 60 * 1000;
const DATA_FILE = path.join(__dirname, 'data', 'history.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const { resolveUser, resolveGroup, fetchOwnerGames, fetchStore } = require('./lib/roblox');
const storeCache = new Map(); // universeId -> store, refreshed hourly

// history[universeId] = [[timestampMs, playing, visits], ...]
let history = {};
// Owners the dashboard has asked about; polled in the background.
const tracked = new Map(); // key -> { type: 'user'|'group', id }

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  history = saved.history || {};
  for (const o of saved.tracked || []) tracked.set(`${o.type}:${o.id}`, o);
} catch {}

function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify({ history, tracked: [...tracked.values()] }));
}

function record(games, now = Date.now()) {
  for (const g of games) {
    const h = (history[g.universeId] ||= []);
    const last = h[h.length - 1];
    // Skip duplicate samples taken within a few seconds of each other.
    if (last && now - last[0] < 5000) last.splice(1, 2, g.playing, g.visits);
    else h.push([now, g.playing, g.visits]);
    while (h.length && now - h[0][0] > HISTORY_MS) h.shift();
  }
}

async function snapshot(owner) {
  const games = await fetchOwnerGames(owner);
  record(games);
  return games;
}

async function pollAll() {
  for (const owner of tracked.values()) {
    try { await snapshot(owner); } catch (e) { console.warn(`poll ${owner.type}:${owner.id}: ${e.message}`); }
  }
  save();
}

async function overview(params) {
  const owners = [];
  const user = (params.get('user') || '').trim();
  if (user) owners.push({ type: 'user', ...(await resolveUser(user)) });
  for (const gid of (params.get('groups') || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!/^\d+$/.test(gid)) throw new Error(`Group ID "${gid}" should be a number`);
    owners.push({ type: 'group', ...(await resolveGroup(gid)) });
  }
  if (!owners.length) throw new Error('Enter a Roblox username/user ID or a group ID');

  const seen = new Set();
  const games = [];
  for (const owner of owners) {
    tracked.set(`${owner.type}:${owner.id}`, { type: owner.type, id: owner.id });
    for (const g of await snapshot(owner)) {
      if (seen.has(g.universeId)) continue;
      seen.add(g.universeId);
      let store = storeCache.get(g.universeId);
      if (!store || Date.now() - store.fetchedAt > 3600000) {
        try { store = await fetchStore(g.universeId); storeCache.set(g.universeId, store); } catch {}
      }
      games.push({ ...g, ownerType: owner.type, ownerName: owner.name, history: history[g.universeId] || [], store: store || null });
    }
  }
  save();
  return { fetchedAt: Date.now(), owners, games };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/overview') {
    try {
      const body = await overview(url.searchParams);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`Roblox games overview running at http://localhost:${PORT}`);
});

setInterval(pollAll, POLL_MS);

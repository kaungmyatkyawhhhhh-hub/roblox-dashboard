// Takes one snapshot of every experience owned by the accounts in config.json,
// appends it to the stored history, and writes the dashboard's data file.
// Run on a schedule by .github/workflows/dashboard.yml.
//
// Usage: node scripts/collect.js <history.json> <out/data.json>

const fs = require('fs');
const path = require('path');
const { resolveUser, resolveGroup, fetchOwnerGames } = require('../lib/roblox');

const HOUR = 60 * 60 * 1000;
const HISTORY_MS = 30 * 24 * HOUR;
const FULL_RES_MS = 48 * HOUR; // older samples are thinned to one per hour

// history[universeId] = [[time, playing, visits, favorites, upVotes, downVotes], ...]
// Keeps every sample from the last 48 hours and the hourly peak before that,
// so 30 days of history stays small.
function thin(h, now) {
  const out = [];
  let bucket = null;
  for (const p of h) {
    if (now - p[0] > HISTORY_MS) continue;
    if (now - p[0] <= FULL_RES_MS) { out.push(p); continue; }
    const b = Math.floor(p[0] / HOUR);
    const last = out[out.length - 1];
    if (bucket === b && last) {
      // Keep the busiest moment of the hour, with the latest totals.
      out[out.length - 1] = [last[1] >= p[1] ? last[0] : p[0], Math.max(last[1], p[1]), ...p.slice(2)];
    } else {
      out.push(p);
      bucket = b;
    }
  }
  return out;
}
const [historyFile = 'history.json', outFile = 'site/data.json'] = process.argv.slice(2);

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  let history = {};
  try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch {}

  const owners = [];
  if (config.user) owners.push({ type: 'user', ...(await resolveUser(String(config.user))) });
  for (const id of config.groups || []) owners.push({ type: 'group', ...(await resolveGroup(id)) });
  if (!owners.length) throw new Error('config.json needs a "user" or at least one entry in "groups"');

  const now = Date.now();
  const seen = new Set();
  const games = [];
  for (const owner of owners) {
    for (const g of await fetchOwnerGames(owner)) {
      if (seen.has(g.universeId)) continue;
      seen.add(g.universeId);
      const h = thin([...(history[g.universeId] || []), [now, g.playing, g.visits, g.favorites, g.upVotes, g.downVotes]], now);
      history[g.universeId] = h;
      games.push({ ...g, ownerType: owner.type, ownerName: owner.name, history: h });
    }
  }
  // Drop experiences that are no longer listed.
  for (const id of Object.keys(history)) if (!seen.has(Number(id))) delete history[id];

  fs.writeFileSync(historyFile, JSON.stringify(history));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ fetchedAt: now, intervalMinutes: 5, liveProxy: config.liveProxy || '', owners, games }));
  const ccu = games.reduce((s, g) => s + g.playing, 0);
  console.log(`${games.length} experiences, ${ccu} playing, ${owners.map((o) => o.name).join(', ')}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

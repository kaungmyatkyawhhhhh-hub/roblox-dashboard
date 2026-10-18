// Takes one snapshot of every experience owned by the accounts in config.json,
// appends it to the stored history, and writes the dashboard's data file.
// Run on a schedule by .github/workflows/dashboard.yml.
//
// Usage: node scripts/collect.js <history.json> <out/data.json>

const fs = require('fs');
const path = require('path');
const { resolveUser, resolveGroup, fetchOwnerGames } = require('../lib/roblox');

const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;
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
      const h = (history[g.universeId] ||= []);
      h.push([now, g.playing, g.visits]);
      while (h.length && now - h[0][0] > HISTORY_MS) h.shift();
      games.push({ ...g, ownerType: owner.type, ownerName: owner.name, history: h });
    }
  }
  // Drop experiences that are no longer listed.
  for (const id of Object.keys(history)) if (!seen.has(Number(id))) delete history[id];

  fs.writeFileSync(historyFile, JSON.stringify(history));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ fetchedAt: now, intervalMinutes: 15, owners, games }));
  const ccu = games.reduce((s, g) => s + g.playing, 0);
  console.log(`${games.length} experiences, ${ccu} playing, ${owners.map((o) => o.name).join(', ')}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

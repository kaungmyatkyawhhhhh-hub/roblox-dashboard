// Takes one snapshot of every experience owned by the accounts in config.json,
// appends it to the stored history, and writes the dashboard's data file.
// Run on a schedule by .github/workflows/dashboard.yml.
//
// Usage: node scripts/collect.js <history.json> <out/data.json>

const fs = require('fs');
const path = require('path');
const { saleKey, resolveUser, resolveGroup, fetchGames, fetchOwnerGames, fetchStore, fetchRevenueSummary, fetchGroupSales } = require('../lib/roblox');
const { runAlerts } = require('./alerts');

const HOUR = 60 * 60 * 1000;
const HISTORY_MS = 30 * 24 * HOUR;
const FULL_RES_MS = 48 * HOUR; // older samples are thinned to one per hour
const STORE_MS = HOUR;          // store listings change rarely; refresh hourly

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
  const stores = history._store || {};
  delete history._store;
  let ledger = history._sales || [];
  delete history._sales;
  const compHistory = history._comp || {};
  const updates = history._updates || {};
  const alertState = history._alerts || {};
  const members = history._members || {};
  for (const k of ['_comp', '_updates', '_alerts', '_members']) delete history[k];
  // Re-key saved sales (older versions used Roblox's non-unique ids) and drop duplicates.
  const seenKeys = new Set();
  ledger = ledger.filter((x) => {
    x.id = saleKey(x.t, x.itemId, x.robux);
    if (seenKeys.has(x.id)) return false;
    seenKeys.add(x.id);
    return true;
  });

  const owners = [];
  if (config.user) owners.push({ type: 'user', ...(await resolveUser(String(config.user))) });
  for (const id of config.groups || []) owners.push({ type: 'group', ...(await resolveGroup(id)) });
  const now = Date.now();
  // Group member counts over time: one sample per hour is plenty.
  for (const o of owners) {
    if (o.type !== 'group' || !o.memberCount) continue;
    const h = (members[o.id] || []).filter((p) => now - p[0] <= HISTORY_MS);
    const last = h[h.length - 1];
    if (last && Math.floor(last[0] / HOUR) === Math.floor(now / HOUR)) h[h.length - 1] = [now, o.memberCount];
    else h.push([now, o.memberCount]);
    members[o.id] = h;
    o.members = h;
  }
  history._members = members;
  if (!owners.length) throw new Error('config.json needs a "user" or at least one entry in "groups"');

  const seen = new Set();
  const games = [];
  for (const owner of owners) {
    for (const g of await fetchOwnerGames(owner)) {
      if (seen.has(g.universeId)) continue;
      seen.add(g.universeId);
      const h = thin([...(history[g.universeId] || []), [now, g.playing, g.visits, g.favorites, g.upVotes, g.downVotes]], now);
      history[g.universeId] = h;
      let cached = stores[g.universeId];
      if (!cached || now - cached.fetchedAt > STORE_MS) {
        try { cached = stores[g.universeId] = await fetchStore(g.universeId); } catch (e) { console.warn(`store ${g.universeId}: ${e.message}`); }
      }
      // Every publish changes the "updated" time; keep a list of them for update-impact charts.
      const ups = (updates[g.universeId] ||= []);
      const ut = Date.parse(g.updated);
      if (ut && !ups.includes(ut)) { ups.push(ut); ups.sort((a, b) => a - b); }
      games.push({ ...g, ownerType: owner.type, ownerName: owner.name, history: h, store: cached || null, updates: ups });
    }
  }
  // Drop experiences that are no longer listed.
  for (const id of Object.keys(history)) if (!seen.has(Number(id))) delete history[id];
  for (const id of Object.keys(stores)) if (!seen.has(Number(id))) delete stores[id];
  history._store = stores;

  // Real revenue, when a cookie for an account that can view group revenue is set
  // as the ROBLOX_COOKIE secret. Published as-is (the owner chose a public page).
  let revenue = { connected: false };
  const newSales = [];
  const cookie = process.env.ROBLOX_COOKIE;
  const groups = owners.filter((o) => o.type === 'group');
  if (cookie && groups.length) {
    try {
      const known = new Set(ledger.map((x) => x.id));
      const summaries = {};
      for (const g of groups) {
        summaries[g.id] = await fetchRevenueSummary(g.id, cookie);
        const fresh = await fetchGroupSales(g.id, cookie, known);
        for (const x of fresh) { x.groupId = g.id; ledger.push(x); newSales.push(x); }
        // Pending sales settle a few days later; update the ones Roblox now shows as settled.
        for (const x of ledger) if (x.pending && fresh.settled.has(x.id)) x.pending = false;
      }
      ledger.sort((a, b) => b.t - a.t);
      ledger = ledger.slice(0, 20000);
      revenue = { connected: true, updatedAt: now, summaries, sales: ledger };
      console.log(`revenue: ${ledger.length} sales saved; summary fields: ${Object.keys(Object.values(summaries)[0]?.month || {}).join(', ')}`);
    } catch (e) {
      const expired = /401|403/.test(e.message);
      console.warn(`revenue: ${e.message}`);
      revenue = { connected: false, error: expired ? 'The Roblox login in ROBLOX_COOKIE was rejected or has expired.' : `Couldn't read revenue: ${e.message}`, sales: ledger };
    }
  } else if (ledger.length) {
    revenue = { connected: false, sales: ledger };
  }
  history._sales = ledger;

  // Similar public games to compare against (config.json "competitors": place or universe ids / game links).
  const competitors = [];
  try {
    const ids = [];
    for (const c of config.competitors || []) {
      const m = String(c).match(/games\/(\d+)/) || String(c).match(/^place:(\d+)$/);
      if (m) {
        const r = await fetch(`https://apis.roblox.com/universes/v1/places/${m[1]}/universe`).then((x) => x.json()).catch(() => ({}));
        if (r.universeId) ids.push(r.universeId);
      } else if (/^\d+$/.test(String(c))) ids.push(Number(c));
    }
    const mine = new Set(games.map((g) => g.universeId));
    const list = ids.length ? await fetchGames([...new Set(ids)].filter((id) => !mine.has(id))) : [];
    for (const g of list) {
      const h = thin([...(compHistory[g.universeId] || []), [now, g.playing, g.visits, g.favorites, g.upVotes, g.downVotes]], now);
      compHistory[g.universeId] = h;
      competitors.push({ ...g, history: h });
    }
    for (const id of Object.keys(compHistory)) if (!list.some((g) => String(g.universeId) === id)) delete compHistory[id];
  } catch (e) { console.warn(`competitors: ${e.message}`); }
  history._comp = compHistory;
  for (const id of Object.keys(updates)) if (!seen.has(Number(id))) delete updates[id];
  history._updates = updates;

  const repo = process.env.GITHUB_REPOSITORY;
  const siteUrl = repo ? `https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}/` : undefined;
  try {
    history._alerts = await runAlerts({ state: alertState, games, newSales, sales: ledger, now, siteUrl, revenueConnected: revenue.connected });
  } catch (e) { console.warn(`alerts: ${e.message}`); history._alerts = alertState; }
  const alerts = { discord: !!process.env.DISCORD_WEBHOOK, ntfy: !!process.env.NTFY_TOPIC };

  fs.writeFileSync(historyFile, JSON.stringify(history));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ fetchedAt: now, intervalMinutes: 5, liveProxy: config.liveProxy || '', owners, games, revenue, competitors, alerts, goals: config.goals || [] }));
  const ccu = games.reduce((s, g) => s + g.playing, 0);
  console.log(`${games.length} experiences, ${ccu} playing, ${owners.map((o) => o.name).join(', ')}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

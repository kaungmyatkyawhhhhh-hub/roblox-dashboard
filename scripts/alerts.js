// Notifications from the scheduled collector: new sales, player records, visit
// milestones, game updates, and a weekly report every Monday.
//
// Delivered to a Discord channel (DISCORD_WEBHOOK secret) and/or the ntfy app
// (NTFY_TOPIC secret). With neither set, nothing is sent.

const MILESTONES = [10, 25, 50, 100, 250, 500, 1e3, 2.5e3, 5e3, 1e4, 2.5e4, 5e4, 1e5, 2.5e5, 5e5, 1e6, 2.5e6, 5e6, 1e7, 1e8, 1e9];
const DAY = 24 * 60 * 60 * 1000;
const fmt = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const clean = (name) => name.replace(/\[[^\]]*\]\s*/g, '').trim() || name;

async function send(title, lines, url) {
  const webhook = process.env.DISCORD_WEBHOOK;
  const topic = process.env.NTFY_TOPIC;
  const body = lines.join('\n');
  const jobs = [];
  if (webhook) {
    jobs.push(fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [{ title, description: body, url, color: 0xf5f5f7 }] }),
    }));
  }
  if (topic) {
    jobs.push(fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, ...(url ? { Click: url } : {}) },
      body: body || title,
    }));
  }
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'rejected') console.warn(`alert not sent: ${r.reason.message}`);
    else if (!r.value.ok) console.warn(`alert not sent: ${r.value.status}`);
  }
}

// ISO week key like 2026-W43, so the weekly report goes out once per week.
function weekKey(t) {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y) / DAY + 1) / 7)).padStart(2, '0')}`;
}

function weeklySummary(games, sales, now) {
  const span = (from, to) => {
    let visits = 0, peak = 0;
    for (const g of games) {
      const h = g.history.filter((p) => p[0] >= from && p[0] < to);
      if (h.length > 1) visits += h[h.length - 1][2] - h[0][2];
      for (const p of h) peak = Math.max(peak, p[1]);
    }
    const s = sales.filter((x) => x.t >= from && x.t < to);
    const items = new Map();
    for (const x of s) items.set(x.item, (items.get(x.item) || 0) + x.robux);
    const best = [...items].sort((a, b) => b[1] - a[1])[0];
    return { visits, peak, robux: s.reduce((a, x) => a + x.robux, 0), sales: s.length, best };
  };
  return { cur: span(now - 7 * DAY, now), prev: span(now - 14 * DAY, now - 7 * DAY) };
}

const change = (a, b) => (b ? `${a >= b ? '▲' : '▼'} ${Math.abs(Math.round(((a - b) / b) * 100))}%` : '');

async function runAlerts({ state, games, newSales, sales, now, siteUrl, revenueConnected }) {
  const enabled = !!(process.env.DISCORD_WEBHOOK || process.env.NTFY_TOPIC);
  const first = !state.init;
  const ccu = games.reduce((s, g) => s + g.playing, 0);
  const next = { ...state, init: true, peakTotal: Math.max(state.peakTotal || 0, ccu), visits: { ...(state.visits || {}) }, updated: { ...(state.updated || {}) } };

  const events = [];
  if (!first) {
    // Sales since the last run.
    for (const x of newSales.slice(0, 5)) {
      const g = games.find((gg) => gg.universeId === x.universeId);
      events.push([`💰 +R$ ${fmt.format(x.robux)} · ${x.item}`, [g ? clean(g.name) : 'Group store', x.pending ? 'Pending' : '']]);
    }
    if (newSales.length > 5) events.push([`💰 ${newSales.length - 5} more sales`, [`R$ ${fmt.format(newSales.slice(5).reduce((a, x) => a + x.robux, 0))} more`]]);
    // New player record across all games.
    if (ccu > (state.peakTotal || 0) && ccu >= 2) events.push([`🏆 New record: ${fmt.format(ccu)} players at once`, games.filter((g) => g.playing).map((g) => `${clean(g.name)}: ${g.playing}`)]);
  }
  for (const g of games) {
    const prevVisits = state.visits ? state.visits[g.universeId] : undefined;
    const crossed = MILESTONES.filter((m) => prevVisits !== undefined && prevVisits < m && g.visits >= m).pop();
    if (crossed && !first) events.push([`🎉 ${clean(g.name)} passed ${compact.format(crossed)} visits`, [`${fmt.format(g.visits)} visits total`]]);
    next.visits[g.universeId] = g.visits;
    const was = state.updated ? state.updated[g.universeId] : undefined;
    if (was && g.updated && was !== g.updated && !first) events.push([`🛠 ${clean(g.name)} was updated`, ['Its before-and-after impact shows on the dashboard after a few days.']]);
    if (g.updated) next.updated[g.universeId] = g.updated;
  }

  // Weekly report: the first run of each week (Monday, UTC).
  const wk = weekKey(now);
  if (state.week && state.week !== wk) {
    const { cur, prev } = weeklySummary(games, sales, now);
    const lines = [
      `Visits: **${fmt.format(cur.visits)}** ${change(cur.visits, prev.visits)}`,
      `Peak players: **${fmt.format(cur.peak)}** ${change(cur.peak, prev.peak)}`,
    ];
    if (revenueConnected) {
      lines.push(`Robux: **R$ ${fmt.format(cur.robux)}** ${change(cur.robux, prev.robux)} from ${cur.sales} sales`);
      if (cur.best) lines.push(`Best seller: **${cur.best[0]}** (R$ ${fmt.format(cur.best[1])})`);
    }
    events.push(['📊 Your weekly report', lines]);
  }
  next.week = wk;

  if (enabled) for (const [title, lines] of events) await send(title, lines.filter(Boolean), siteUrl);
  if (events.length) console.log(`alerts: ${events.length} event(s)${enabled ? '' : ' (no DISCORD_WEBHOOK or NTFY_TOPIC set)'}`);
  return next;
}

module.exports = { runAlerts };

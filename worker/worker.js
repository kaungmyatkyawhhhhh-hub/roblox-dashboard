// Cloudflare Worker that lets the hosted dashboard read live Roblox stats.
// Browsers can't call Roblox's APIs directly (CORS), so the page asks this
// worker instead. It only answers GET /live?ids=<universe ids> with public
// stats, and only for the dashboard's own site.
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker,
// paste this file, Deploy. Then put the worker's URL in config.json → "liveProxy".

const ALLOWED_ORIGIN = 'https://kaungmyatkyawhhhhh-hub.github.io';

export default {
  async fetch(request) {
    const cors = { 'access-control-allow-origin': ALLOWED_ORIGIN, vary: 'origin' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'access-control-allow-methods': 'GET' } });
    }
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/live') return json({ error: 'Not found' }, 404, cors);

    const ids = (url.searchParams.get('ids') || '').split(',').filter((s) => /^\d+$/.test(s)).slice(0, 50);
    if (!ids.length) return json({ error: 'Pass ?ids= with one or more universe IDs' }, 400, cors);

    try {
      const q = ids.join(',');
      const [details, votes] = await Promise.all([
        getJson(`https://games.roblox.com/v1/games?universeIds=${q}`),
        getJson(`https://games.roblox.com/v1/games/votes?universeIds=${q}`),
      ]);
      const voteById = new Map(votes.data.map((v) => [v.id, v]));
      const games = details.data.map((d) => ({
        universeId: d.id,
        playing: d.playing || 0,
        visits: d.visits || 0,
        favorites: d.favoritedCount || 0,
        upVotes: (voteById.get(d.id) || {}).upVotes || 0,
        downVotes: (voteById.get(d.id) || {}).downVotes || 0,
      }));
      return json({ fetchedAt: Date.now(), games }, 200, cors);
    } catch (e) {
      return json({ error: e.message }, 502, cors);
    }
  },
};

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'roblox-dashboard-live/1.0' } });
  if (!res.ok) throw new Error(`Roblox returned ${res.status}`);
  return res.json();
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

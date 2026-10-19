// Cloudflare Worker that lets the hosted dashboard read live Roblox stats.
// Browsers can't call Roblox's APIs directly (CORS), so the page asks this
// worker instead. It only answers GET /live?ids=<universe ids> with public
// stats, and only for the dashboard's own site.
//
// It also answers GET /search?q=<words> with YouTube search results for the
// music player. That needs a YouTube Data API key saved on the worker as a
// secret named YOUTUBE_API_KEY (Settings → Variables and Secrets).
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker,
// paste this file, Deploy. Then put the worker's URL in config.json → "liveProxy".

const ALLOWED_ORIGIN = 'https://kaungmyatkyawhhhhh-hub.github.io';

export default {
  async fetch(request, env = {}, ctx) {
    const cors = { 'access-control-allow-origin': ALLOWED_ORIGIN, vary: 'origin' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'access-control-allow-methods': 'GET' } });
    }
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/search') return search(url, env, ctx, cors);
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

// YouTube search for the music player. Results are cached for a day so repeated
// searches don't use up the API key's daily quota (about 100 searches).
async function search(url, env, ctx, cors) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) return json({ error: 'Pass ?q= with something to search for' }, 400, cors);
  if (!env.YOUTUBE_API_KEY) return json({ error: 'Search is not set up yet: add a YOUTUBE_API_KEY secret to this worker.' }, 501, cors);
  const cache = caches.default;
  const key = new Request(`https://cache.local/search?q=${encodeURIComponent(q.toLowerCase())}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const api = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=12&safeSearch=moderate&q=${encodeURIComponent(q)}&key=${env.YOUTUBE_API_KEY}`;
  const res = await fetch(api);
  const data = await res.json();
  if (!res.ok) {
    const reason = data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason;
    return json({ error: reason === 'quotaExceeded' ? 'Daily search limit reached. Try again tomorrow, or paste a link.' : 'YouTube search failed.' }, 502, cors);
  }
  const results = (data.items || []).map((it) => ({
    id: it.id.videoId,
    title: it.snippet.title,
    channel: it.snippet.channelTitle,
    thumb: (it.snippet.thumbnails.medium || it.snippet.thumbnails.default || {}).url,
  })).filter((r) => r.id);
  const body = JSON.stringify({ results });
  if (ctx) ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'cache-control': 'max-age=86400' } })));
  return new Response(body, { headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

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

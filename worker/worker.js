// Cloudflare Worker that lets the hosted dashboard read live Roblox stats.
// Browsers can't call Roblox's APIs directly (CORS), so the page asks this
// worker instead. It only answers GET /live?ids=<universe ids> with public
// stats, and only for the dashboard's own site.
//
// It also answers GET /search?q=<words> with YouTube search results for the
// music player. That needs a YouTube Data API key saved on the worker as a
// secret named YOUTUBE_API_KEY (Settings → Variables and Secrets).
//
// It also relays messages from Claude Code on your own computer to the dashboard's
// Claude tab (POST/GET /claude). That needs a KV namespace bound as CLAUDE_FEED and
// a secret named CLAUDE_FEED_KEY; both requests must send that key, so only you can
// write or read the feed. See README → "Claude Code feed".
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker,
// paste this file, Deploy. Then put the worker's URL in config.json → "liveProxy".

const ALLOWED_ORIGIN = 'https://kaungmyatkyawhhhhh-hub.github.io';

export default {
  async fetch(request, env = {}, ctx) {
    const cors = { 'access-control-allow-origin': ALLOWED_ORIGIN, vary: 'origin' };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, x-feed-key', 'access-control-max-age': '86400' } });
    }
    const url = new URL(request.url);
    if (url.pathname === '/claude') return claudeFeed(request, env, cors);
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
  // Accept small slips in the secret's name (case, spaces, dashes) and stray spaces in the key.
  const name = Object.keys(env).find((k) => k.replace(/[\s_-]/g, '').toUpperCase() === 'YOUTUBEAPIKEY');
  const apiKey = name && typeof env[name] === 'string' ? env[name].trim() : '';
  if (!apiKey) {
    // List only the names this worker can see (never values) so a misnamed secret is easy to spot.
    const seen = Object.keys(env).filter((k) => typeof env[k] === 'string');
    return json({ error: `Search is not set up yet: this worker has no YOUTUBE_API_KEY secret. ${seen.length ? `It only sees: ${seen.join(', ')}.` : 'It sees no variables or secrets at all. Add the secret, then click Deploy.'}` }, 501, cors);
  }
  const cache = caches.default;
  const key = new Request(`https://cache.local/search-v2?q=${encodeURIComponent(q.toLowerCase())}`);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, { headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const api = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=25&safeSearch=moderate&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(api);
  const data = await res.json();
  if (!res.ok) {
    const reason = data.error && data.error.errors && data.error.errors[0] && data.error.errors[0].reason;
    const why = {
      quotaExceeded: 'Daily search limit reached. Try again tomorrow, or paste a link.',
      keyInvalid: 'Google rejected the YOUTUBE_API_KEY. Copy the key again from Google Cloud → Credentials.',
      badRequest: 'Google rejected the YOUTUBE_API_KEY. Copy the key again from Google Cloud → Credentials.',
      accessNotConfigured: 'YouTube Data API v3 is not enabled in your Google Cloud project yet (APIs & Services → Library).',
      forbidden: 'The API key is not allowed to use YouTube Data API v3. Check its restrictions in Google Cloud → Credentials.',
    }[reason];
    return json({ error: why || `YouTube search failed (${reason || res.status}).` }, 502, cors);
  }
  const found = (data.items || []).map((it) => ({
    id: it.id.videoId,
    title: it.snippet.title,
    channel: it.snippet.channelTitle,
    thumb: (it.snippet.thumbnails.medium || it.snippet.thumbnails.default || {}).url,
  })).filter((r) => r.id);
  const results = (await withoutShorts(found, apiKey)).slice(0, 12);
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

// YouTube Shorts are vertical videos: drop anything taller than it is wide,
// anything a minute or shorter, and anything tagged #shorts. Costs 1 quota
// unit per search (the search itself costs 100).
async function withoutShorts(items, apiKey) {
  const tagged = (r) => /#shorts?\b/i.test(r.title);
  if (!items.length) return items;
  try {
    const ids = items.map((r) => r.id).join(',');
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,player&maxWidth=320&id=${ids}&key=${encodeURIComponent(apiKey)}`);
    if (!res.ok) return items.filter((r) => !tagged(r));
    const info = new Map(((await res.json()).items || []).map((v) => [v.id, v]));
    return items.filter((r) => {
      const v = info.get(r.id);
      if (tagged(r)) return false;
      if (!v) return true;
      const w = Number(v.player && v.player.embedWidth), h = Number(v.player && v.player.embedHeight);
      if (w && h && h > w) return false;
      return seconds(v.contentDetails && v.contentDetails.duration) > 60;
    });
  } catch {
    return items.filter((r) => !tagged(r));
  }
}

// ISO 8601 duration (PT3M25S) to seconds; unknown or live counts as long.
function seconds(d) {
  if (!d || d === 'P0D') return Infinity;   // live streams report P0D
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  if (!m) return Infinity;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// ---- Claude Code feed ----
// Keeps the latest 300 messages (prompts you typed and Claude's replies) plus
// whether each session is busy, in one KV entry.
const FEED_MAX = 300;
const FEED_TEXT_MAX = 8000;

async function claudeFeed(request, env, cors) {
  if (!env.CLAUDE_FEED || !env.CLAUDE_FEED_KEY) {
    return json({ error: 'The Claude feed is not set up on this worker yet: add the CLAUDE_FEED KV binding and the CLAUDE_FEED_KEY secret.', setup: true }, 501, cors);
  }
  if (!sameKey(request.headers.get('x-feed-key') || '', String(env.CLAUDE_FEED_KEY).trim())) {
    return json({ error: 'Wrong feed key.' }, 401, cors);
  }
  const feed = (await env.CLAUDE_FEED.get('feed', 'json')) || { messages: [], sessions: {} };
  if (request.method === 'GET') {
    const since = Number(new URL(request.url).searchParams.get('since')) || 0;
    return json({ messages: feed.messages.filter((m) => m.t > since), sessions: feed.sessions, now: Date.now() }, 200, cors);
  }
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Send JSON.' }, 400, cors); }
  const session = String(body.session || 'unknown').slice(0, 80);
  const now = Date.now();
  const s = (feed.sessions[session] ||= { project: '', started: now });
  if (body.project) s.project = String(body.project).slice(0, 120);
  if (body.status) s.status = body.status === 'working' ? 'working' : 'idle';
  s.seen = now;
  if (body.text && (body.role === 'user' || body.role === 'assistant')) {
    const text = String(body.text);
    feed.messages.push({
      t: Math.max(now, (feed.messages[feed.messages.length - 1] || {}).t + 1 || 0),
      session, role: body.role,
      text: text.length > FEED_TEXT_MAX ? `${text.slice(0, FEED_TEXT_MAX)}\n… (shortened)` : text,
    });
    feed.messages = feed.messages.slice(-FEED_MAX);
  }
  // Forget sessions with nothing left in the feed and no activity for a week.
  for (const [id, x] of Object.entries(feed.sessions)) {
    if (now - x.seen > 7 * 86400000 && !feed.messages.some((m) => m.session === id)) delete feed.sessions[id];
  }
  await env.CLAUDE_FEED.put('feed', JSON.stringify(feed));
  return json({ ok: true }, 200, cors);
}

function sameKey(a, b) {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

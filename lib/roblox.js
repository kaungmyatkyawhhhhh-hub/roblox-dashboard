// Thin client for Roblox's public web APIs: resolve users/groups, list their
// public experiences, and fetch stats (CCU, visits, favorites, votes, icons).

async function getJson(url, init) {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init && init.headers) } });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}${new URL(url).pathname}`);
  return res.json();
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function resolveUser(input) {
  if (/^\d+$/.test(input)) {
    const u = await getJson(`https://users.roblox.com/v1/users/${input}`);
    return { id: u.id, name: u.name, displayName: u.displayName };
  }
  const r = await getJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [input], excludeBannedUsers: false }),
  });
  const u = r.data && r.data[0];
  if (!u) throw new Error(`No Roblox user named "${input}"`);
  return { id: u.id, name: u.name, displayName: u.displayName };
}

async function resolveGroup(id) {
  const g = await getJson(`https://groups.roblox.com/v1/groups/${id}`);
  return { id: g.id, name: g.name };
}

async function listUniverseIds(owner) {
  const ids = [];
  let cursor = '';
  do {
    const base = owner.type === 'user'
      ? `https://games.roblox.com/v2/users/${owner.id}/games`
      : `https://games.roblox.com/v2/groups/${owner.id}/gamesV2`;
    const page = await getJson(`${base}?accessFilter=Public&limit=50&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const g of page.data) ids.push(g.id);
    cursor = page.nextPageCursor;
  } while (cursor && ids.length < 500);
  return ids;
}

async function fetchGames(universeIds) {
  const games = [];
  for (const ids of chunk(universeIds, 50)) {
    const q = ids.join(',');
    const [details, votes, icons] = await Promise.all([
      getJson(`https://games.roblox.com/v1/games?universeIds=${q}`),
      getJson(`https://games.roblox.com/v1/games/votes?universeIds=${q}`),
      getJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${q}&size=150x150&format=Png&isCircular=false`).catch(() => ({ data: [] })),
    ]);
    const voteById = new Map(votes.data.map((v) => [v.id, v]));
    const iconById = new Map(icons.data.map((i) => [i.targetId, i.imageUrl]));
    for (const d of details.data) {
      const v = voteById.get(d.id) || { upVotes: 0, downVotes: 0 };
      games.push({
        universeId: d.id,
        placeId: d.rootPlaceId,
        name: d.name,
        creator: d.creator && d.creator.name,
        genre: d.genre_l1 || d.genre,
        playing: d.playing || 0,
        visits: d.visits || 0,
        favorites: d.favoritedCount || 0,
        maxPlayers: d.maxPlayers,
        upVotes: v.upVotes,
        downVotes: v.downVotes,
        created: d.created,
        updated: d.updated,
        icon: iconById.get(d.id) || null,
      });
    }
  }
  return games;
}

async function fetchOwnerGames(owner) {
  return fetchGames(await listUniverseIds(owner));
}

module.exports = { resolveUser, resolveGroup, listUniverseIds, fetchGames, fetchOwnerGames };

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

async function thumb(url) {
  try {
    const r = await getJson(url);
    return (r.data && r.data[0] && r.data[0].imageUrl) || null;
  } catch { return null; }
}

async function withAvatar(u) {
  const avatar = await thumb(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${u.id}&size=150x150&format=Png`);
  return { id: u.id, name: u.name, displayName: u.displayName, avatar };
}

async function resolveUser(input) {
  if (/^\d+$/.test(input)) return withAvatar(await getJson(`https://users.roblox.com/v1/users/${input}`));
  const r = await getJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [input], excludeBannedUsers: false }),
  });
  const u = r.data && r.data[0];
  if (!u) throw new Error(`No Roblox user named "${input}"`);
  return withAvatar(u);
}

async function resolveGroup(id) {
  const g = await getJson(`https://groups.roblox.com/v1/groups/${id}`);
  const avatar = await thumb(`https://thumbnails.roblox.com/v1/groups/icons?groupIds=${g.id}&size=150x150&format=Png`);
  return { id: g.id, name: g.name, avatar, memberCount: g.memberCount || 0 };
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
    const [details, votes, icons, banners] = await Promise.all([
      getJson(`https://games.roblox.com/v1/games?universeIds=${q}`),
      getJson(`https://games.roblox.com/v1/games/votes?universeIds=${q}`),
      getJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${q}&size=150x150&format=Png&isCircular=false`).catch(() => ({ data: [] })),
      getJson(`https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${q}&countPerUniverse=1&size=768x432&format=Png`).catch(() => ({ data: [] })),
    ]);
    const bannerById = new Map(banners.data.map((b) => [b.universeId, b.thumbnails && b.thumbnails[0] && b.thumbnails[0].imageUrl]));
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
        thumbnail: bannerById.get(d.id) || null,
      });
    }
  }
  return games;
}

// Public store of an experience: game passes and developer products with prices
// and icons. Sales and revenue are private to the owner, so they aren't here.
async function fetchStore(universeId) {
  const passes = [];
  let token = '';
  do {
    const page = await getJson(`https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes?passView=Full&pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
    for (const g of page.gamePasses || []) {
      passes.push({ id: g.id, name: g.displayName || g.name, price: g.price, forSale: !!g.isForSale, created: g.created });
    }
    token = page.nextPageToken;
  } while (token && passes.length < 500);

  const products = [];
  let cursor = '';
  do {
    const page = await getJson(`https://apis.roblox.com/developer-products/v2/universes/${universeId}/developerproducts?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const d of page.developerProducts || []) {
      products.push({ id: d.ProductId, name: d.displayName || d.Name, price: d.PriceInRobux, forSale: !!d.IsForSale, iconAsset: d.IconImageAssetId || d.displayIcon || null, created: d.Created });
    }
    cursor = page.nextPageCursor;
  } while (cursor && products.length < 500);

  // Icons, in batches.
  for (const ids of chunk(passes.map((x) => x.id), 100)) {
    const r = await getJson(`https://thumbnails.roblox.com/v1/game-passes?gamePassIds=${ids.join(',')}&size=150x150&format=Png`).catch(() => ({ data: [] }));
    const byId = new Map(r.data.map((t) => [t.targetId, t.imageUrl]));
    for (const x of passes) if (byId.has(x.id)) x.icon = byId.get(x.id);
  }
  const assetIds = [...new Set(products.map((x) => x.iconAsset).filter(Boolean))];
  for (const ids of chunk(assetIds, 100)) {
    const r = await getJson(`https://thumbnails.roblox.com/v1/assets?assetIds=${ids.join(',')}&size=150x150&format=Png`).catch(() => ({ data: [] }));
    const byId = new Map(r.data.map((t) => [t.targetId, t.imageUrl]));
    for (const x of products) if (byId.has(x.iconAsset)) x.icon = byId.get(x.iconAsset);
  }
  for (const x of products) delete x.iconAsset;
  return { passes, products, fetchedAt: Date.now() };
}

// ---- private revenue (needs a signed-in account that can view the group's revenue) ----
function authed(cookie) {
  const v = cookie.trim().replace(/^\.ROBLOSECURITY=/, '');
  return { headers: { cookie: `.ROBLOSECURITY=${v}` } };
}

// Totals Roblox shows in the group's Revenue summary, per period.
async function fetchRevenueSummary(groupId, cookie) {
  const out = {};
  for (const period of ['day', 'week', 'month', 'year']) {
    out[period] = await getJson(`https://economy.roblox.com/v1/groups/${groupId}/revenue/summary/${period}`, authed(cookie));
  }
  return out;
}

// Times a place was published (not just saved), newest first, from its version
// history. Needs a login that can edit the experience; throws otherwise.
async function fetchPublishTimes(placeId, cookie, maxPages = 3) {
  const times = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const r = await getJson(`https://develop.roblox.com/v1/assets/${placeId}/published-versions?limit=100&sortOrder=Desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, authed(cookie));
    for (const v of r.data || []) {
      const t = Date.parse(v.created || v.Created);
      if (t) times.push(t);
    }
    cursor = r.nextPageCursor;
    if (!cursor) break;
  }
  return times;
}

const saleKey = (t, itemId, robux) => `${t}|${itemId ?? ''}|${robux}`;

// Sales (game passes, developer products, ...) newest first, stopping at a sale we
// already have. Buyer names are dropped: they belong to other people.
async function fetchGroupSales(groupId, cookie, knownIds = new Set(), maxPages = 60) {
  const sales = [];
  sales.settled = new Set(); // known sales that are no longer pending
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const r = await getJson(`https://economy.roblox.com/v2/groups/${groupId}/transactions?transactionType=Sale&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, authed(cookie));
    let reachedKnown = false;
    for (const t of r.data || []) {
      const d = t.details || {};
      // Roblox doesn't return a unique id per sale, so key on time + item + amount.
      const id = saleKey(Date.parse(t.created), d.id, (t.currency && t.currency.amount) || 0);
      if (knownIds.has(id)) { reachedKnown = true; if (!t.isPending) sales.settled.add(id); continue; }
      sales.push({
        id,
        t: Date.parse(t.created),
        robux: (t.currency && t.currency.amount) || 0,
        pending: !!t.isPending,
        item: d.name || 'Item',
        itemId: d.id || null,
        type: d.type || '',
        universeId: (d.place && d.place.universeId) || null,
        place: (d.place && d.place.name) || '',
      });
    }
    cursor = r.nextPageCursor;
    if (!cursor || reachedKnown) break;
  }
  return sales;
}

async function fetchOwnerGames(owner) {
  return fetchGames(await listUniverseIds(owner));
}

module.exports = { saleKey, fetchPublishTimes, resolveUser, resolveGroup, listUniverseIds, fetchGames, fetchOwnerGames, fetchStore, fetchRevenueSummary, fetchGroupSales };

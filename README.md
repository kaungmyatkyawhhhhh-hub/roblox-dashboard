# Roblox Experience Overview

A black-and-white, one-screen analytics dashboard for every Roblox experience owned by the accounts in [`config.json`](config.json). It's currently set to the **Myanmar Builders Club** group.

- **Totals:** players right now (with a 24h trend), visits and visits gained, favorites, like ratio, and how many experiences are live. The browser tab shows the live player count.
- **Concurrent users:** your top 5 experiences plus all others, over the last 12 hours, 24 hours, 7 days or month.
- **When players are online:** a day-by-hour heatmap of average players in your local time.
- **Highlights:** busiest hour and day, peak since tracking began, visits per day, and the most played experience this week.
- **Visits per day** for the last 14 days, and **next milestones** for visits and favorites, with an estimate of when you'll reach each one at your current pace.
- **Music player:** the music button in the top bar (with a live mini equalizer) opens a player. Search YouTube by name (needs a YouTube Data API key on the Cloudflare worker as the `YOUTUBE_API_KEY` secret) or paste video and playlist links to build a queue; they play through YouTube's official embedded player with a seek bar, and your queue is remembered in your browser. When the queue runs out (or you press next on the last song), it keeps going with YouTube's Mix of songs similar to the last one. There are also three relaxing moods generated live in the browser. Videos whose owners block embedding are skipped automatically.
- **Monetization tab:** your real Robux and sales (when connected, see below): Robux today, 7 days, 30 days and all tracked, Premium Payouts, pending Robux, Robux per day, top items and recent sales, for all games or one selected game. Below that: every game pass and developer product with prices, store stats and a price-tier chart. Without a connection it shows an earnings estimator instead.

- **Compare tab:** your games next to similar public games (`competitors` in `config.json`, as universe ids, place ids like `place:123`, or game links): players now (log-scale bars), 24h trend and peak, visits per day, visits, favorites, like ratio.
- **Reports tab:** this week vs. last week (visits, peak players, Robux, sales, best seller); goals with progress rings and a projected finish date (add your own in the page, or list shared ones in `config.json` → `goals`, e.g. `{ "metric": "visits", "target": 5000, "by": "2026-12-31" }`; metrics: `visits`, `favorites`, `robux_month`, `robux_total`, `peak`); update impact (7 days before vs. after each publish); month forecast (visits and Robux by month end at the last 7 days' pace); best time to publish an update (an hour before your busiest stretch of the week); group member growth next to total visits; CSV/JSON export.
- **Monetization extras:** a when-people-buy heatmap and Robux per 1K visits per game. Game updates are also marked on the Overview players chart.

### Updating every 5 minutes reliably

GitHub only runs scheduled workflows when it has capacity, and on quiet repositories that can mean every few hours. The worker can start the updater itself:

1. GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token. Repository access: only `roblox-dashboard`. Permissions: **Actions: Read and write**. Copy the token.
2. Cloudflare → the worker → Settings → Variables and Secrets → add a secret `GITHUB_TOKEN` with that token. Deploy the latest `worker/worker.js`.
3. Worker → Settings → Triggers → Cron Triggers → add `*/5 * * * *`.

### All-ages eligibility

Roblox Kids and Select (all-ages audiences) need 250 highly engaged players per game in a 60-day window. Roblox shows that count only in Creator Hub, with no API, so the game drawer and the Reports tab let you type in the number you see there; the dashboard keeps each entry (in that browser) and shows progress and the pace toward the target. To show a count to everyone, add it to `config.json`: `"allAges": { "<universe id>": { "count": 120, "at": "2026-10-20" } }`. Change the target with `"allAgesTarget"` if Roblox changes it.

### Alerts and the weekly report

The collector can notify you about new sales, new player records, visit milestones, game updates and sudden like-ratio drops (the last 24 hours' votes at least 15 points below the game's usual ratio), plus a weekly report every Monday. Add either repository secret:

- `DISCORD_WEBHOOK`: a Discord channel webhook URL (channel settings → Integrations → Webhooks).
- `NTFY_TOPIC`: a private topic name you subscribe to in the free ntfy app.

### Connecting Robux and sales

Roblox only shows revenue to signed-in group members with permission, so the updater signs in with a cookie you provide:

1. Create a separate Roblox account and add it to your group with a role that can only view the group's revenue.
2. Sign in to that account in a browser and copy the value of the `.ROBLOSECURITY` cookie (developer tools → Application → Cookies → roblox.com).
3. In this repository: **Settings → Secrets and variables → Actions → New repository secret**, name `ROBLOX_COOKIE`, paste the value.

The next run reads the group's revenue summary and sales. Sales are published on the public page (item, game, Robux, time), without buyer names. If the cookie expires, the Monetization tab says so; paste a fresh one into the same secret.
- **Experience cards:** click any card for a detail panel with its own player chart, daily visits, favorites over time, milestones, and details. Each panel has its own link (`#game-<id>`).

## Hosted automatically (GitHub Pages)

The [Update dashboard](.github/workflows/dashboard.yml) workflow runs every 5 minutes. It takes a snapshot of every experience, adds it to 30 days of history (every sample for the last 48 hours, hourly peaks before that) stored on the `stats` branch, and publishes the dashboard to GitHub Pages:

**https://kaungmyatkyawhhhhh-hub.github.io/roblox-dashboard/**

One-time setup: open **Settings → Pages** and set **Source** to **GitHub Actions**. After that, nothing needs to be running on your computer.

To track different games, edit `config.json`. Set `"user"` to a Roblox username or user ID, and `"groups"` to a list of group IDs. The next run picks up the change.

Notes:
- GitHub can start scheduled runs a few minutes late, and it pauses schedules on repositories with no commits for 60 days. Any commit to `main` turns them back on.
- To refresh right away, open **Actions → Update dashboard → Run workflow**.

## Live updates every 15 seconds (optional)

GitHub can only run the collector every few minutes. For live numbers, deploy the tiny proxy in [`worker/worker.js`](worker/worker.js) as a free Cloudflare Worker, and put its URL in `config.json` → `"liveProxy"`. The open dashboard then refreshes every 15 seconds. Roblox itself updates player counts about once a minute.

## Run it locally (optional)

You need Node.js 18 or newer. There are no dependencies to install.

```sh
npm start        # or: node server.js
```

Open http://localhost:3000 and enter a username or group IDs. The local server samples every minute and keeps 24 hours of history in `data/history.json`.

## How it works

- `lib/roblox.js` calls Roblox's public APIs (games, votes, thumbnails, users, groups).
- `scripts/collect.js` is the scheduled collector. `server.js` is the local server, which also proxies the APIs because browsers can't call them directly (CORS).
- `public/index.html` is the dashboard. It reads `data.json` when it's hosted and the local API otherwise.
- Only **public** experiences and public stats are shown. Creator Dashboard metrics such as revenue, retention and session length need a Roblox Open Cloud API key and aren't included.

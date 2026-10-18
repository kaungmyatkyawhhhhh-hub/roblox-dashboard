# Roblox Experience Overview

A black-and-white, one-screen analytics dashboard for every Roblox experience owned by the accounts in [`config.json`](config.json). It's currently set to the **Myanmar Builders Club** group.

- **Totals:** players right now (with a 24h trend), visits and visits gained, favorites, like ratio, and how many experiences are live. The browser tab shows the live player count.
- **Concurrent users:** your top 5 experiences plus all others, over the last 12 hours, 24 hours, 7 days or month.
- **When players are online:** a day-by-hour heatmap of average players in your local time.
- **Highlights:** busiest hour and day, peak since tracking began, visits per day, and the most played experience this week.
- **Visits per day** for the last 14 days, and **next milestones** for visits and favorites, with an estimate of when you'll reach each one at your current pace.
- **Music player:** the music button in the top bar (with a live mini equalizer) opens a player. Paste YouTube video or playlist links to build a queue; they play through YouTube's official embedded player with a seek bar, and your queue is remembered in your browser. When the queue runs out (or you press next on the last song), it keeps going with YouTube's Mix of songs similar to the last one. There are also three relaxing moods generated live in the browser. Videos whose owners block embedding are skipped automatically.
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

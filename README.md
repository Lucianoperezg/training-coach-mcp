**English** · [Español](README.es.md)

# Training Coach MCP

**An architecture to build your own AI training coach**, on a free Cloudflare account. It runs on your own data from your watch and, optionally, from your gym app.

The core is generic. It syncs your data, stores it in your own database and lets Claude query it through a remote MCP connector, from the web, mobile or desktop.

The **running and strength coach** in [`claude-ai/`](claude-ai/) is just one example built on top of it. Copy it and adapt it to your sport, your goals and your rules.

<!-- screenshots -->

## What it connects

- **intervals.icu.** It receives your activities from **Garmin, COROS, Polar, Suunto, Wahoo** and many more, and it calculates load, zones and fitness. This is the main source.
- **Hevy** (optional). Your strength workouts and routines. Without it everything else works the same.

```
Watch ─► watch app ─► intervals.icu ─┐
                                     ├─► Cloudflare Worker (sync every 15 min) ─► D1 database
Hevy app (optional) ─────────────────┘                                              │
                                                                                    ▼
                                         Claude (claude.ai) ◄── MCP connector ◄── tools
```

Three layers, each with one job:

| Layer | Where | What it does |
|---|---|---|
| **Data** | MCP server + D1 (this repo) | Syncs, stores and calculates. It's the same for any coach |
| **Rules** | Project instructions in claude.ai | Who the coach is and how it should answer |
| **Procedures** | Skills in claude.ai | How to do a specific job, such as drawing a chart |

More detail in [`docs/architecture.md`](docs/architecture.md) and [`docs/data-provenance.md`](docs/data-provenance.md).

## Tools Claude can use

> **Note:** tool names, fields and outputs are in **Spanish**, because that's the language the project was born in. Claude doesn't care. You can talk to it in English and it will answer in English.

| Tool | What it does | Writes? |
|---|---|---|
| `revisar_actividad` | Full review of one workout in one call: HR zones, splits per km, HR drift, HR recovery, comparison with similar workouts from the last 8 weeks, that day's plan, fitness and alerts | No |
| `estado_atleta` | Overview for planning: fitness, 7/28-day load, recovery (sleep, resting HR, HRV, steps), last hard session, recent gym, notes, thresholds, sync status and alerts | No |
| `historial` | Weekly summary: volume, long run, zones and gym sets per muscle group | No |
| `progreso` | Trend of a metric (efficiency, pace, HR, cadence, km, load, fitness, resting HR, HRV) or of an exercise, using only completed weeks | No |
| `ver_plan` | Your intervals.icu calendar and, for past days, what you actually did | No |
| `tramos` | Analyses segments that aren't official laps: pace, cadence and HR profile, detected steps, exact averages of a segment, or a pattern of repeats | No |
| `consulta_sql` | Any other question, read-only, over a fixed list of views | No |
| `nota` | Notes the coach remembers between chats (feelings, niggles, goals). It also marks alerts as resolved | **Yes** |
| `estado` | Shared state between chats, with version history: goal, plan, routine, decisions and rules | **Yes** |
| `programar_entrenos` | Creates, changes or deletes workouts in your intervals.icu calendar, in two steps: preview first, then the change once you confirm. It only touches future workouts it created itself | **Yes** |
| `programar_rutinas` | Creates, changes or restores Hevy routines, in two steps, with a backup before each change. **It only appears if you set up Hevy** | **Yes** |

## Requirements

- An **intervals.icu** account (free), connected to your watch.
- A **Cloudflare** account (free).
- **Node.js** LTS on your computer, only to install it. Nothing runs on your computer afterwards.
- A **claude.ai** account that can add custom connectors.
- Optional: **Hevy**.

## Installation, step by step

You don't need to know how to program. You'll copy and paste a few commands into a terminal. It takes about 20 minutes.

### 1. intervals.icu

1. Create an account at [intervals.icu](https://intervals.icu).
2. In **Settings → Connections**, connect your watch (Garmin, COROS, Polar, Suunto…). Your activities will start arriving.
3. **Set your thresholds.** In **Settings**, in the sport settings for running (and any other sport you do), fill in your **threshold heart rate (LTHR)**, **max heart rate** and **threshold pace**. The MCP takes your zones from there. Nothing is hard-coded, so if they're wrong, the analysis will be wrong too.
4. At the bottom of **Settings**, in **Developer Settings**, create your **API key**. Keep it at hand.

### 2. Hevy (optional)

In the Hevy app, open **Settings → Developer** and generate your **API key**. If you skip this step, the coach works the same, just without gym data or routines.

### 3. Cloudflare and Node.js

1. Create a free account at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
2. Install **Node.js LTS** from [nodejs.org](https://nodejs.org). Check that it works by opening a terminal and typing `node --version`.
3. Download this repo: the green **Code** button → **Download ZIP**, and unzip it. Open a terminal inside that folder.

### 4. Install and log in

```bash
npm install
```

```bash
npx wrangler login
```

The second command opens your browser so you can allow access to your Cloudflare account.

### 5. Create the database (D1)

```bash
npx wrangler d1 create entrenos
```

It shows a `database_id`. Open `wrangler.toml` with any text editor and paste it where it says `PEGA_AQUI_EL_ID`.

### 6. Set your time zone and watch in `wrangler.toml`

In the same file, in the `[vars]` section:

- **`TZ`**: your time zone in [IANA format](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones), for example `"America/New_York"` or `"Europe/London"`. It decides what "today" means and turns Hevy dates into your local date. **Set it.** If you delete the line, the server falls back to `Europe/Madrid`.
- **`WATCH`**: write `"suunto"` if your watch is a Suunto, otherwise leave it empty (`""`). Suunto shows the post-workout "feel" on a reversed scale, and with this setting the coach also tells you the value as your watch shows it.

Save the file.

### 7. Create the tables

```bash
npm run db:init
```

### 8. Save the secrets

Secrets are stored encrypted in Cloudflare, never in a file. Each command asks you for the value; it won't show on screen as you paste it.

First you need a **token**: a long random password that will protect your server. Use a password generator with at least 40 characters, letters and numbers only. Or, on Windows, in PowerShell:

```powershell
-join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })
```

On Mac or Linux:

```bash
openssl rand -hex 32
```

Save it somewhere safe, then:

```bash
npx wrangler secret put MCP_TOKEN
```

```bash
npx wrangler secret put INTERVALS_API_KEY
```

```bash
npx wrangler secret put HEVY_API_KEY
```

Skip the last one if you don't use Hevy.

### 9. Publish

```bash
npm run deploy
```

It shows your URL: `https://entrenos-mcp.<your-subdomain>.workers.dev`. To check it works, open `https://entrenos-mcp.<your-subdomain>.workers.dev/health` in your browser. It should say `{"ok":true,...}`.

**Your history imports by itself, in chunks.** Every 15 minutes it imports about 6 months of activities and up to 80 Hevy workouts, so several years take a few hours. Meanwhile, `estado_atleta` shows how far it has got.

### 10. Connect it to claude.ai

1. In claude.ai, open **Settings → Connectors** and add a **custom connector**, without OAuth, with this URL:

   ```
   https://entrenos-mcp.<your-subdomain>.workers.dev/mcp/<YOUR_MCP_TOKEN>
   ```

2. In the connector's tool permissions, set the tools that write (`nota`, `estado`, `programar_entrenos`, `programar_rutinas`) to **"Always ask"**.
3. Create a **project** in claude.ai. Paste in the example instructions from [`claude-ai/en/project-instructions.md`](claude-ai/en/project-instructions.md), adapted to you, and add the [`graficas`](claude-ai/en/skills/graficas/) skill if you want charts.

Try asking: *"How has my bench press progressed over the last 3 months?"* or *"Am I overdoing it this week, counting gym and running?"*

## Cost

**€0 on Cloudflare's free plan.** It doesn't ask for a card, so it can't charge you. Your usage stays well below the limits:

- 100,000 requests a day. Syncing uses about 100, plus your questions.
- 500 MB of database, enough for many years of workouts.
- A CPU limit per run. That's why the history imports in chunks.

One caveat: per-km splits are calculated from intervals.icu's second-by-second data. For a very long activity (an ultra lasting many hours) that could exceed the free plan's CPU limit. In that case the review comes out without splits and everything else works.

intervals.icu is free. Hevy is optional.

## Security

- **The token is in the URL, so the URL is your password. Don't share it.** Whoever has the full URL can read your workouts and also write: save notes, change the shared state, edit the MCP's workouts in your intervals.icu calendar and change your Hevy routines.
- If it leaks, change it with `npx wrangler secret put MCP_TOKEN` and update the connector in claude.ai.
- Set the tools that write to **"Always ask"** in claude.ai, so Claude can't change anything without you seeing it first.
- With a wrong token the server answers 404, and `/health` shows no data. `/mcp` allows 60 requests per minute per IP, which also slows down anyone trying to guess the token.
- API keys are stored as encrypted secrets in Cloudflare, not in the code.
- `consulta_sql` only accepts a single `SELECT`/`WITH` over an allow-list of views. D1 has no read-only mode, so that filter is the only defence: keep it in mind if you change it.

## Not medical advice

This is a personal project to analyse your own training data. **It is not medical advice and it doesn't replace a doctor, a physiotherapist or a qualified coach.** The AI can be wrong. If you're in pain, have strange symptoms or a health condition, see a professional.

## Maintenance

```bash
npm run logs        # watch what it does live (syncs, errors)
npm run deploy      # publish code changes
npm run typecheck   # types + tests
npm run db:init     # apply new migrations to the database
npx wrangler d1 export entrenos --remote --output=copia.sql   # back up your data
```

## Try it locally

```bash
cp .dev.vars.example .dev.vars           # fill in your keys
npm run db:init:local
npm run dev                              # MCP at http://localhost:8787/mcp/<MCP_TOKEN>
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"   # trigger a sync
```

## Troubleshooting

### `/health` shows `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` on a new Cloudflare account

Your browser says it can't provide a secure connection when you open `https://entrenos-mcp.<your-subdomain>.workers.dev/health`.

- **Cause:** your workers.dev subdomain is brand new and doesn't have its certificate yet. Cloudflare takes from a few minutes to about 30 to issue it.
- **Fix:** wait, close the tab and open it again. The Worker is already running even if the browser fails.

<!-- Add more cases here: ### Symptom, then **Cause** and **Fix**. -->

## Limitations

- Metrics computed only by your watch brand's app (its own recovery score, for example) don't reach intervals.icu, so they don't reach the coach. Data from the activity file does: HR, GPS, cadence, altitude, laps…
- Thresholds set on the watch itself aren't used. The coach uses those in intervals.icu.
- Hevy's API doesn't allow deleting routines or moving them between folders. You do that in the app.

## License

[MIT](LICENSE).

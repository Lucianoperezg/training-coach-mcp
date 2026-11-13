**English** · [Español](README.es.md)

# Training Coach MCP

**An architecture to build your own AI training coach**, on a free Cloudflare account. It runs on your own data from your watch and, optionally, from your gym app.

## Why it exists

- **Connect your watch to your AI even if the brand doesn't let you.** Suunto and many other sports apps don't offer an open API or an official connector for your AI. But almost all of them sync with **intervals.icu**, and this project uses that bridge: your Suunto, Garmin, COROS, Polar or Wahoo data reaches Claude.
- **No server at home.** You don't need to leave a computer on or run anything locally: everything runs **in the cloud, on Cloudflare**, for free, and Claude uses it from the web, mobile or desktop.

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

When it finishes, it shows some text with a line like this one (yours will have different letters and numbers):

```
database_id = "1a2b3c4d-1234-5678-9abc-def012345678"
```

Copy what's **between the quotes**. You'll paste it in the next step.

### 6. Edit `wrangler.toml` (the configuration)

**What it is:** `wrangler.toml` is a text file with your server's configuration. It's inside the folder you unzipped in step 3.

**How to open it:**
- **Windows:** right-click `wrangler.toml` → **Open with** → **Notepad**.
- **Mac:** right-click → **Open With** → **TextEdit**.
- Or any code editor, such as VS Code.

**Rules, before you touch anything:**
- Change **only what's between quotes**, and keep the quotes.
- Don't touch anything else: not the names, not the brackets, not the other lines.
- Anything after `#` on a line is a comment: an explanation the server doesn't read.

**1. The database ID.** Find this line:

```toml
database_id = "PEGA_AQUI_EL_ID"   # el que te da: npx wrangler d1 create entrenos
```

Replace `PEGA_AQUI_EL_ID` with the ID you copied in step 5. It should end up like this, with your ID:

```toml
database_id = "1a2b3c4d-1234-5678-9abc-def012345678"   # el que te da: npx wrangler d1 create entrenos
```

**2. Your time zone and your watch.** Further down, in the `[vars]` section, you'll see this:

```toml
TZ = "UTC"                        # tu zona horaria, p. ej. "America/Mexico_City" o "Europe/London"
WATCH = ""                        # marca del reloj: "suunto" si es un Suunto (explica el feel en su escala); si no, vacío
```

For example, for someone in Spain with a Suunto watch it should end up like this:

```toml
TZ = "Europe/Madrid"              # tu zona horaria, p. ej. "America/Mexico_City" o "Europe/London"
WATCH = "suunto"                  # marca del reloj: "suunto" si es un Suunto (explica el feel en su escala); si no, vacío
```

(The comments are in Spanish; you can leave them as they are.)

- **`TZ` (time zone):** the template comes with `"UTC"`, universal time with no daylight saving. **Change it to yours**: it decides what "today" is for your coach and which day each workout falls on. Write it exactly as shown, with capitals and the slash:

  | If you live in… | Write |
  |---|---|
  | London / UK | `"Europe/London"` |
  | New York (US East Coast) | `"America/New_York"` |
  | Spain (mainland and Balearics) | `"Europe/Madrid"` |
  | Mexico City | `"America/Mexico_City"` |
  | Buenos Aires | `"America/Argentina/Buenos_Aires"` |
  | Bogotá | `"America/Bogota"` |

  If yours isn't there, look it up in the "TZ identifier" column of [this list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).
- **`WATCH` (watch):** it only matters if your watch is a Suunto: then write `"suunto"`. With any other watch, leave it as it is, `""`.

**3. Where to start importing your history.** In the same `[vars]` section there is this line:

```toml
HISTORY_START = "2018-01-01"      # desde cuándo importar el histórico
```

Set the date when **your data really starts** in intervals.icu, for example `"2024-01-01"` if you started using your watch in 2024. The import moves forward 6 months every 15 minutes: if you leave it at 2018 and your data is recent, you'll wait hours without seeing anything. With the right date, you'll have everything in minutes.

**4. Save the file.** In Notepad, use **File → Save**, not "Save as". Check that the file is still called `wrangler.toml` and not `wrangler.toml.txt`: if you see `.txt` at the end, remove it when renaming.

### 7. Create the tables

```bash
npm run db:init
```

### 8. Save the secrets (the token and the API keys)

Secrets are passwords stored encrypted in Cloudflare, never in a file in the folder.

**First, the MCP token.** It's a password **you make up yourself**: no website gives it to you. It protects your server, and later it goes at the end of the connector URL (step 10). Whoever has that URL can read your data.

1. **Generate it.** On Windows, open PowerShell and run:

   ```powershell
   -join ((1..32) | % { '{0:x2}' -f (Get-Random -Max 256) })
   ```

   On Mac or Linux, in the terminal:

   ```bash
   openssl rand -hex 32
   ```

   You get a line of 64 letters and numbers: that's your token. A password generator also works, with letters and numbers only and 40 characters or more.
2. **Copy it and save it** in your password manager or a private note. You'll need it in step 10, and Cloudflare won't show it to you again.
3. **Give it to Cloudflare.** Run:

   ```bash
   npx wrangler secret put MCP_TOKEN
   ```

   When it asks `Enter a secret value`, paste it and press Enter. **It's normal that nothing shows when you paste**: it's hidden on purpose.
4. If it asks whether you want to create the Worker because it doesn't exist yet, answer yes (`Y`).

**Then, the API keys.** Do the same with each one; here you don't make anything up, you paste the key you already have:

```bash
npx wrangler secret put INTERVALS_API_KEY
```

Paste the intervals.icu API key from step 1.

```bash
npx wrangler secret put HEVY_API_KEY
```

Paste the Hevy API key from step 2. Skip it if you don't use Hevy.

**If you make a mistake** pasting one, run the same command again: the new value overwrites the old one.

### 9. Publish

```bash
npm run deploy
```

It shows your URL: `https://entrenos-mcp.<your-subdomain>.workers.dev`. To check it works, open `https://entrenos-mcp.<your-subdomain>.workers.dev/health` in your browser. It should say `{"ok":true,...}`.

**Your history imports by itself, in chunks.** Every 15 minutes it imports about 6 months of activities and up to 80 Hevy workouts, so if your `HISTORY_START` (step 6) is years before your first data, it will take hours to reach it. Meanwhile, `estado_atleta` shows how far it has got.

### 10. Connect it to claude.ai

1. **Build your connector URL.** Start from the address you opened in step 9 to check `/health` and change only the end: **remove `health` and put `mcp/` followed by your token** (the one from step 8).

   | | Example (made-up subdomain and token) |
   |---|---|
   | What you opened in step 9 | `https://entrenos-mcp.abc123.workers.dev/health` |
   | What you paste into the connector | `https://entrenos-mcp.abc123.workers.dev/mcp/3f9a1c7e5b2d8a4f6c0e9b1d7a3f5c2e8b4d6a0f1c3e5b7d9a2c4e6f8b0d1a3c` |

   - The token must be **exactly the same** one you pasted into `npx wrangler secret put MCP_TOKEN`.
   - No spaces, no `<` `>` and no trailing slash.
   - **Don't share this URL** with anyone or paste it into a chat: whoever has it can read your data.

2. In claude.ai, open **Settings → Connectors** → **Add custom connector**. Give it any name, paste the URL from the previous point and leave everything about OAuth empty.

3. In the connector's tool permissions, set the tools that write (`nota`, `estado`, `programar_entrenos`, `programar_rutinas`) to **"Always ask"**.
4. Create a **project** in claude.ai. Paste in the example instructions from [`claude-ai/en/project-instructions.md`](claude-ai/en/project-instructions.md), adapted to you, and add the [`graficas`](claude-ai/en/skills/graficas/) skill if you want charts.

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

### claude.ai can't connect to the connector

It's almost always the URL:

- Check that it ends in `/mcp/` + your token, not `/health`.
- The token must be exactly the one you saved with `npx wrangler secret put MCP_TOKEN`. If you're not sure, run that command again with a new token and use that one in the URL.
- No spaces and no trailing slash.

<!-- Add more cases here: ### Symptom, then **Cause** and **Fix**. -->

## Limitations

- Metrics computed only by your watch brand's app (its own recovery score, for example) don't reach intervals.icu, so they don't reach the coach. Data from the activity file does: HR, GPS, cadence, altitude, laps…
- Thresholds set on the watch itself aren't used. The coach uses those in intervals.icu.
- Hevy's API doesn't allow deleting routines or moving them between folders. You do that in the app.

## License

[MIT](LICENSE).

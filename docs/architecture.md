# Architecture

## Goal

A coherent flow **data → MCP → Claude → project, skills and chats**, where it's clear what each layer calculates, and that anyone can reproduce on a free Cloudflare account.

## Layers (from lowest to highest)

| Level | Component | What it does |
|---|---|---|
| 1 | **Sources**: your watch and its app; the Hevy app (optional) | Measure and record: HR, GPS, cadence, sleep and HRV; gym sets |
| 2 | **Aggregator: intervals.icu** | Receives activities from the watch brand and calculates load, zones, fitness/fatigue/form (CTL/ATL/TSB) and GAP. Hevy doesn't go through here: it uses its own API |
| 3 | **Storage: Cloudflare D1 (SQLite)** | Your own copy of the data, plus read-only views: `v_activities`, `v_splits`, `v_gym`, `v_wellness`, `v_rutinas`, `v_rutinas_copias` |
| 4 | **MCP server** (Cloudflare Worker, this repo) | Syncs intervals.icu and Hevy every 15 minutes, does its own calculations and exposes tools |
| 5 | **Connector in claude.ai** | The MCP plugged into Claude, available on web, mobile and desktop |
| 6 | **Skills** | Procedures ("how to draw a chart"). A plugin can bundle skills, commands and connector settings |
| 7 | **claude.ai project** | Instructions (rules) and memory, shared by all its chats. Personal state lives in the MCP |
| 8 | **Chats** | Conversations inside the project |

```
Watch ─► watch app ─► intervals.icu ─┐
                                     ├─► Worker (cron */15) ─► D1 ─► MCP tools ─► claude.ai connector
Hevy (optional) ─────────────────────┘                                                │
                                                     project instructions + skills ◄──┘
                                                                  │
                                                                chats
```

## Design rules

- **Rules in the instructions, procedures in the skills, data and personal state in the MCP.** The server knows nothing about your goals; the instructions say who the coach is.
- **The core is generic.** Nothing about one athlete is hard-coded: zones and thresholds are read from intervals.icu, the time zone comes from `TZ` and the watch brand from `WATCH`.
- **Chats don't talk to each other.** They share the instructions, the MCP state (`estado`), notes (`nota`), active alerts and the intervals.icu calendar (`ver_plan`). That's how information passes between them.
- **Open new chats often** (for example, one a month per kind): a very long conversation makes Claude more error-prone.
- **Every number comes from a tool or from code.** Claude's own arithmetic is where mistakes happen, so the example instructions forbid mental maths.
- **Writes are two-step.** Tools that change your calendar or routines first return a preview and only apply it after an explicit confirmation.

## Communication channels between chats

No chat talks to another directly: they communicate by reading and writing to a shared place.

| Channel | Who writes | Who reads | Live | What for |
|---|---|---|---|---|
| **MCP / database** | Any chat (`estado`, `nota`, `programar_entrenos`, `programar_rutinas`) | Any chat | Yes | Day to day: current plan, niggles, the week's decisions |
| **Project instructions and skills** | You, by editing them in claude.ai | Every chat in the project | No (an open chat may not see changes) | Rules and procedures |
| **This repo** | You or your coding assistant | You, when updating the server | No | Design: code, technical docs |

## Example: chat types

The example coach in `claude-ai/` uses two chats in one project. You can use one, or many.

| Chat | What for | Reads | Writes |
|---|---|---|---|
| Runs | Review each run, ask about feelings and record them | `revisar_actividad`, `estado` | `nota` (feelings, niggles), `nota(resolver_alerta)` |
| Coach | Weekly review and replanning, adjustments, gym routine | `estado_atleta`, `estado`, `ver_plan`, `historial`, `progreso` | `estado`, `programar_entrenos`, `programar_rutinas`, `nota` |

## Sync and free-plan limits

- A cron trigger runs every 15 minutes. Each run has a budget of subrequests and CPU time, so the history imports in chunks (about 6 months of activities and up to 80 Hevy workouts per run) and per-km splits are calculated a few activities at a time.
- Per-km splits are calculated once from intervals.icu's second-by-second streams and stored. Transient errors are retried with back-off (see [`data-provenance.md`](data-provenance.md)).
- `tramos` stores nothing: it fetches an activity's streams on each call (one request), resamples them to 1 Hz and calculates on the spot.
- Without `HEVY_API_KEY`, Hevy sync switches itself off and `programar_rutinas` isn't registered.

## Security model

- The MCP endpoint is `/mcp/<MCP_TOKEN>`. A wrong token returns 404. `/health` returns no data.
- `/mcp` is rate-limited to 60 requests per minute per IP, before the token is checked.
- API keys are Cloudflare secrets, never in the code or in `wrangler.toml`.
- `consulta_sql` accepts a single `SELECT`/`WITH` over an allow-list of views and metadata tables. D1 has no read-only mode, so that filter is the only defence.
- Texts coming from Hevy and intervals.icu (titles, notes) are treated as data, never as instructions.

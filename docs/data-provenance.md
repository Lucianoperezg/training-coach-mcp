# Data provenance

For each piece of data: who measures it or calculates it. Things the code can't prove are marked **[unverified]**.

Column and tool names are in Spanish, as they appear in the MCP.

## Summary by origin

| Origin | Data | Confidence |
|---|---|---|
| **Watch (measured)** | HR, GPS, distance, speed, altitude, cadence, temperature, duration | High |
| **Watch brand's own model** | Training effect, recovery time, VO₂ max, the watch's own zones | They may be in the watch file, but **they don't reach the MCP** |
| **You, on the watch** | Feel after the workout. On Suunto, intervals.icu reverses the scale (see below) | High |
| **intervals.icu (calculated)** | Moving time (`moving_s`, its own algorithm, not always reliable), average speed (`avg_speed_ms`), average HR and time per zone (`avg_hr` and `hr_z*_s`, which include pauses; the MCP calculates its own version on foot), `training_load`, `intensity`, TRIMP, zones from **your** settings (LTHR, max HR and limits configured in intervals.icu), CTL/ATL/TSB/ramp, GAP | Medium-high |
| **intervals.icu (read from raw data; unclear whether intervals calculates it or it comes from the watch)** | Average stride (`stride_m`), HR recovery (`hrr_*`) and polarisation index (`polarization_index`) **[unverified]** | Medium |
| **intervals.icu, wellness** | Resting HR, HRV, sleep hours, score and quality, sleeping HR, steps, weight. Read from intervals.icu's wellness; which device originally sent them can't be checked in the code | Medium-high |
| **Hevy** | Weight, reps, RPE, set type, exercise template, muscle group, routines | High |
| **MCP (calculated)** | See the next table | Checked in the code |
| **Claude** | Interpretation, recommendations and any arithmetic done in an answer | This is where mistakes happen. Rule: every number of its own is calculated with SQL or code and flagged as calculated by Claude |

## What the MCP calculates, and how

"Today" is the local date in `TZ`. "Days" includes today, even if it's only half over.

| Metric | Formula | Window | Source fields | Where |
|---|---|---|---|---|
| **Cadence** (`cadence_spm`) | `avg_cadence × 2` in Run, TrailRun, VirtualRun, Walk and Hike (intervals gives it per leg); unchanged otherwise | One activity | intervals' `average_cadence` | `migrations/0002` |
| **Moving pace** (`ritmo_min_km`, `ritmo_movimiento_min_km`) | 1000 / `avg_speed_ms` | One activity | intervals' `average_speed` | `src/format.ts`, `src/coach.ts` |
| **Total pace** (`ritmo_total_min_km`) | `elapsed_s` / distance, including pauses | One activity | `elapsed_time` and `distance` | `src/format.ts` |
| **Moving time** (`tiempo`, `horas`, `progreso` paces, "done" in the plan) | `distance_m / avg_speed_ms` on foot with distance and speed ≥ 0.5 m/s; otherwise (treadmill, gym, other sports) `moving_s`. `tiempo_total` = `elapsed_s` | One activity | `distance`, `average_speed`, `moving_time` | `src/format.ts` |
| **GAP** (`gap_min_km`) | 1000 / `gap_ms`. intervals calculates it; the MCP only converts it | One activity | intervals' `gap` | `src/format.ts` |
| **Average HR without pauses** (`fc`, `fc_media`, `fc_marcha`) | Time-weighted mean of the moving seconds (same rule as splits). Sports on foot with ≥ 1000 m; otherwise intervals' `avg_hr`. Max HR is intervals' | One activity | `heartrate` stream | `src/splits.ts`, `migrations/0008` |
| **Aerobic efficiency** (`eficiencia_m_lat`, `eficiencia`; metres per beat) | `GAP × 60 / fc_media` (average speed if there's no GAP). Sports on foot only, ≥ 1000 m, ≥ 1.5 m/s and with HR. `aerobic_eff` is the older version, with `avg_hr` | One activity | `gap`, `avg_speed_ms`, `fc_media` | `migrations/0008` |
| **% in zones** (`z1_2_pct`, `pct_z1_z7`, `fc_z1_s..fc_z7_s`) | Time in Z1+Z2 / total time in Z1…Z7. On foot, without pauses: each second goes to the first zone whose upper limit it doesn't exceed. Otherwise intervals' zone times | One activity | `heartrate` stream and your intervals.icu HR zones | `src/splits.ts`, `src/format.ts` |
| **Per-km splits** (`v_splits`) | Walks the second-by-second data. Every second with distance counts as moving. A gap without distance counts as a pause if less than 0.5 m/s is covered during it; otherwise (signal lost while running) its time counts. Pace = time of the km / metres of the km. HR and cadence (×2) = mean of the moving samples. Elevation = sum of climbs, excluding pauses. The last segment is kept only if ≥ 200 m. Sports on foot with ≥ 1000 m. Calculated once and stored | One activity | intervals streams: `time`, `distance`, `heartrate`, `cadence`, `altitude` | `src/splits.ts` |
| **HR drift** (`deriva_fc_pct`) | With complete kms (≥ 900 m with HR), at least 4: efficiency per km = speed / HR; average the first half and the second (with an odd number, the extra km goes to the second); drift = (first / second − 1) × 100. Positive = worse at the end. Uses split pace, **not GAP**, so hills affect it | One activity | MCP splits | `src/splits.ts` |
| **Comparison with similar activities** | Mean km, pace, HR, cadence and efficiency of **earlier** activities of the **same sport** with a distance between 60 % and 140 % of the current one. If there are fewer than 3, all of the same sport are used | 56 days before the activity | `v_activities` | `src/coach.ts` |
| **7-day / 28-day load and ratio** | c7 = sum of `training_load` for today and the 6 previous days; c28 = sum over 28 days; weekly mean = c28 / 4; ratio = c7 / weekly mean. **c28 includes the last 7 days**, which smooths the ratio. Sums **all** activities | 7 and 28 days | intervals' `training_load` | `src/coach.ts` |
| **"Hard session"** | Any sport with `intensity` ≥ 85 (0-100 from intervals) or ≥ 600 s in Z4-Z7 | 21 days | `intensity`, zone times | `src/coach.ts` |
| **"Leg gym day"** | The title contains a leg-day word (lower, leg, squat, deadlift, and Spanish equivalents) or an exercise's primary muscle group in Hevy is a leg group | 48 h before the activity (review) or 72 h (status) | Hevy | `src/coach.ts` |
| **e1RM** | Epley formula: `weight × (1 + reps / 30)`, only with weight > 0 and reps > 0. `progreso` excludes warm-up sets and takes each week's maximum | Per set / per week | Hevy | `migrations/0002`, `src/analisis.ts` |
| **Sets per muscle group** | Number of non-warm-up sets, by the template's primary muscle | Week (Monday-Sunday) | Hevy | `src/analisis.ts` |
| **`progreso` trends** | Least-squares line over the values of **completed weeks**; needs 4 completed weeks with data; "stable" if the total change is under 2 %. The current week doesn't enter the line: it comes separately in `semana_en_curso`, flagged as incomplete | The last N completed weeks: 4 to 104 (12 by default) | Depends on the metric | `src/analisis.ts` |
| **Open notes** | All open notes of type niggle, without limit, plus the 10 most recent of other types. If others are left out, it says how many (`notas_omitidas`) | No time window | `notas` table | `src/coach.ts` |
| **Recovery** (`estado_atleta`) | 28-day medians of resting HR and HRV (with at least 10 days of data); mean sleep hours and lists of the 7 most recent rows; steps = mean of the 7 days before today, because today isn't complete | 7 and 28 days | intervals.icu wellness | `src/coach.ts` |

"Junk recordings" (left out of comparisons, "the last one" and per-sport totals): under 120 s moving, or sports on foot of 1 to 299 m.

## Alerts

At most 2 per answer, by priority and, when tied, the oldest first. **An alert keeps showing in every chat until it's resolved with `nota(resolver_alerta=key)` or it expires**: the ones that don't fit show up in a later answer. A resolved alert doesn't come back; those with the week in their key can return the following week if the condition still holds. Logic in `src/coach.ts`.

| Alert | When it fires | Priority | How long it stays active |
|---|---|---|---|
| Activity cut short | Distance < 40 % of the median of the previous 8 of the same sport (56 days), or another of the same sport the same day starting less than 1 h apart | 3 | 7 days |
| High load | Weekly mean ≥ 20 and c7 > 1.3 × weekly mean | 3 | While it holds |
| High resting HR | The last 3 values of the last 6 days, all ≥ 28-day median + 5 bpm | 3 | While it holds |
| Low HRV | The last 3 values of the last 6 days, all ≤ 80 % of the median. **Only checked if the resting HR alert didn't fire** | 2 | While it holds |
| High HR for the pace | Efficiency < 92 % of the mean of similar activities (at least 3), and the activity wasn't cut short | 2 | 5 days |
| Legs before a hard session | Hard activity on foot with a leg gym day in the previous 48 h | 2 | 3 days |
| Niggle not reviewed | Open niggle note last reviewed (or created) 6 or more days ago | 2 | While it holds |
| Legs less than 48 h ago (`estado_atleta`) | Leg gym day less than 48 h ago | 1 | Until 48 h have passed |
| High drift | HR drift > 8 % | 1 | 3 days |
| No feelings | No feel or RPE on an activity of ≥ 10 min | 1 | 2 days |

All thresholds are relative to your own history, so they work for anyone without tuning.

## Transient sync failures

A momentary error mustn't leave data wrong forever without warning. None of this recalculates what was already stored.

| Data | Accepted as good or final | Asked again | Limit | Where |
|---|---|---|---|---|
| **Splits and HR without pauses** (`splits_estado`) | Streams with data: `ok`. 404 or streams without data: `error`, at the first attempt | Network error, any other HTTP error or odd response: retried after **1, 6 and 24 hours** | **4 requests in total**; the fourth failure leaves `error` | `src/splits.ts`, `src/sync.ts` |
| **Hevy change cursor** (`hevy_since`) | A page with an `events` list and an integer `page_count`. Only advances after reading the last one | A 404 or a missing list or `page_count`: doesn't advance, stops and reports it (`fallos_seguidos` in `estado_atleta`) | No limit: retried on each run | `src/sync.ts` |
| **Initial Hevy import** | A page with a `workouts` list and an integer `page_count` | Same as the cursor: nothing is written and that page is retried | No limit | `src/sync.ts` |
| **Exercise templates** | With a title: stored. **Only a 404** stores an empty row, which isn't asked for again | Error or response without a title: nothing is stored and it's retried in the next run | At most 1 failed request per run | `src/sync.ts` |

While an activity is waiting for a retry, `revisar_actividad` says `pendiente`, HR and zones come from intervals (with pauses), and once the wait is over it recalculates on the spot.

## Sleep, steps, HR recovery and polarisation

Virtual columns read from what was already stored from intervals.icu (`migrations/0012`): the MCP calculates nothing, it only exposes them.

| Data | intervals.icu field | Where it shows |
|---|---|---|
| Sleep score (`sleep_score`, `sueno_puntuacion`) | `sleepScore` | `estado_atleta`, `revisar_actividad`, `v_wellness` |
| Sleep quality (`sleep_quality`) | `sleepQuality` | `v_wellness` only |
| Sleeping HR (`avg_sleeping_hr`, `fc_sueno`) | `avgSleepingHR` | `estado_atleta`, `revisar_actividad`, `v_wellness` |
| Steps (`steps`, `pasos_media_7d`) | `steps` | `estado_atleta`, `v_wellness` |
| HR recovery (`recuperacion_fc`, `hrr_*`) | `icu_hrr` | `revisar_actividad`, `v_activities`. Drop over a 60 s window; missing doesn't mean anything bad |
| Polarisation (`polarizacion`, `polarization_index`) | `polarization_index` | `revisar_actividad` (on foot, from 500 m), `v_activities` |

- **Polarisation:** 0 means "no time in a high zone" (Z5 or above), not missing data. It has no defined interpretation in this project.
- **Which night a day's sleep belongs to:** assumed to be the night before **[unverified]**.
- **Sleep stages (REM, deep):** not seen in intervals.icu **[unverified]**.
- Which of these fields arrive depends on your watch brand and on what it sends to intervals.icu.

## Hevy routines

Routines are written by you (or by the MCP, with your confirmation) in Hevy. Weight and reps are **targets**, not completed sets; what you did stays in `v_gym`. The MCP calculates nothing about them.

| Data | Origin | How it arrives | Where |
|---|---|---|---|
| **`v_rutinas`** | `GET /v1/routines`, full response stored and unpacked in SQL | Every 15 minutes, or right after a change made by the MCP | `migrations/0013`, `src/sync.ts` |
| **`carpeta`** (folder) | `GET /v1/routine_folders` | With the same sync. If it fails, routines are still stored, without the name | `src/sync.ts` |
| **Current routine** | Marked as deleted if it's missing from a valid, **complete and non-empty** list; if it reappears, it's current again. So if every routine is deleted at once, the last list keeps showing as current | Each sync | `src/sync.ts` |
| **`notas_rutina`** | The routine's `notes`, **only if Hevy returns it**: its docs accept it on write but don't list it on read **[unverified]** | With the routine | `migrations/0013` |
| **Backups** | Full routine read from Hevy just before changing it | Before each change or restore | `src/rutinas.ts`, `rutina_copias` |

From Hevy's official API docs (`https://api.hevyapp.com/docs/`):

- **Routines:** `GET`, `POST` and `PUT`. **No `DELETE`.** **Folders:** `GET` and `POST`. **Exercise templates:** `GET` and `POST`.
- **The docs don't say whether `PUT` replaces the whole routine.** Its exercises have no id, so the MCP treats it as a replacement and always sends the full routine.
- **Unknown fields:** if Hevy returns a field with a value its API doesn't allow sending, the preview warns about it. The backup keeps it, but it can't be restored through the API.

## Feel: the scale depends on the watch

- intervals.icu stores feel as 1 = strong (very good) … 5 = weak (very bad). `feel` is that value as is; `revisar_actividad` adds `feel_etiqueta` and `feel_escala`.
- **Suunto** shows feel the other way round (1 = poor … 5 = excellent), and intervals.icu reverses it on import: **intervals feel = 6 − Suunto value**. Sources: the thread [Import feeling from Suunto](https://forum.intervals.icu/t/import-feeling-from-suunto/26588) on the intervals.icu forum and [Suunto's help on feeling](https://www.suunto.com/Support/Product-support/suunto_run/suunto_run/recording-an-exercise/feeling/).
- With `WATCH = "suunto"` (case-insensitive) in `wrangler.toml`, the MCP also returns `feel_reloj` (6 − feel), the value as the watch shows it.
- With any other value, or empty, only intervals.icu's scale is used. How intervals.icu imports feel from other brands hasn't been checked, so no conversion is invented.
- Code: `esSuunto`, `escalaFeel` and `feelExplicado` in `src/format.ts`.

## Paces

| Pace | Calculation |
|---|---|
| Moving | 1000 / `avg_speed_ms` |
| Total | `elapsed_s` / distance, including pauses |
| Per km | `pace_s` in `v_splits`, without pauses |

**There's no "running only" pace** anywhere. A per-second speed cut-off doesn't work for it, because distance comes in whole metres and in jumps, already in the watch file: it would need smoothed velocity and cadence.

## Time zone

- `TZ` in `wrangler.toml` decides the local date ("today", activity dates, Hevy dates, which arrive in UTC).
- If `TZ` is missing, the server falls back to `Europe/Madrid` (`localDate` in `src/env.ts`). Always set your own.

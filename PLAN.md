# Observability Demo — Build Handoff

A companion demo for a Medium article on Prometheus + Grafana. The goal is a small but *complete* stack that exercises every core Prometheus concept: the pull model, the `/metrics` endpoint, `up`, exporters, scrape jobs, labels & cardinality, the RED framework, all four metric types, Grafana dashboards, and alerting with Alertmanager.

**Status:** All milestones (1–7) are complete; the demo is fully working. Where the build differs from the original plan, see §4 *As-built notes*.

**Four sections:** §1 the overall plan, §2 the build spec, §3 the milestones, §4 as-built notes.

---

# 1. Overall Plan — What We're Building

## The concept: an async job-queue API

A **producer/consumer** system in a single Hono.js service, with Redis as the queue in the middle:

- **The API (producer)** receives HTTP requests, validates them, pushes valid jobs onto a Redis list, and returns `202` immediately. It does no real work.
- **The worker (consumer)** is a background loop with a concurrency pool that pops jobs off Redis and "processes" them (simulated latency, occasional failure).

This shape is chosen deliberately: fast intake + slower background processing is what makes *every* metric type show up naturally — especially a gauge (queue depth) that genuinely rises and falls under load.

## Why it teaches well

The key insight the demo is built to show: because the API only *enqueues*, heavy load does **not** appear as slow HTTP requests — it appears as **growing queue depth**. So you instrument *both* layers, because load hides in different places. Looking only at request latency would tell you everything's fine while jobs pile up.

## How metrics get populated (the mental model)

Nothing is pushed. Every counter/gauge/histogram/summary lives in-memory in the app's `prom-client` registry:
- The **HTTP middleware** updates request metrics on every request (in-flight gauge up, time it, record duration + count on exit).
- The **worker** updates business metrics each time it processes a job (duration, success/failure count).
- **Queue depth** is read from BullMQ (`getWaitingCount()`) at scrape time via a `collect()` callback.
- **Prometheus pulls** `/metrics` every 5s and stores timestamped samples. `rate()`/percentiles in Grafana are just Prometheus comparing successive scrapes.
- **`up`** is Prometheus's own per-target record of whether each scrape succeeded — never exposed by the app.

## Stack

| Service | Role |
|---|---|
| `backend` | Hono.js API + worker (Node 20+) — container name `hono-app` |
| `redis` | Job queue + job-state store |
| `redis_exporter` | Translates Redis's internal stats into Prometheus metrics |
| `prometheus` | Scraper + TSDB |
| `alertmanager` | Receives firing alerts from Prometheus; groups, dedupes, silences |
| `grafana` | Dashboards |
| `k6` | Load generator — one-shot, behind a Compose profile |

**Libraries:** `prom-client` (metrics), Hono middleware (HTTP instrumentation), `bullmq` (queue, job state + worker pool, on Redis via `ioredis`).

**Decided constraints:** single app replica (so the histogram-vs-summary cross-instance lesson is *described in the article, not demonstrated live*); worker concurrency pool of **4**; Prometheus `scrape_interval: 5s`.

---

# 2. Build Spec

## 2.1 Endpoints

| Method | Path | Purpose | Notes |
|---|---|---|---|
| `GET` | `/healthz` | Liveness check | Plain `200`; not scraped |
| `GET` | `/metrics` | Prometheus scrape target | Serves the `prom-client` registry (include default process metrics) |
| `POST` | `/jobs` | Enqueue a job `{type, payload}` | Returns `202`. ~10% return `400` (validation = client errors); ~3% return `500` (simulated downstream failure = server errors, so the error-rate panel has signal). Small random delay (~5–50ms, **load-independent**) so the request-duration histogram has a real distribution |
| `GET` | `/jobs/:id` | Job status | Reads job state from BullMQ (`waiting → active → completed/failed`); `404` if unknown. **Cardinality rule:** the metric label is `route="/jobs/:id"`, never the raw id |
| `GET` | `/stats` | Human-readable queue snapshot | Optional — **not built** (the dashboard covers it) |

## 2.2 Worker

In-process BullMQ `Worker` with **`concurrency: 4`** (up to 4 jobs in flight at once). BullMQ handles popping jobs and tracking state (`waiting → active → completed/failed`). The job handler:
1. Simulates processing — duration depends on type (email 50–300ms, thumbnail 200–800ms, report 0.5–2s), 7% failure (throwing marks the job `failed`).
2. Updates the business metrics.

The pool is what makes `worker_active_jobs` (0–4) and queue-drain dynamics meaningful. Keeps the demo single-container while still producing real async behaviour.

## 2.3 Metrics Design (the heart of the demo)

**Counters**
- `http_requests_total{method, route, status_code}` — RED **Rate** + **Errors**
- `jobs_enqueued_total{type}`
- `jobs_processed_total{type, result}` — `result=success|failure`

**Gauges**
- `http_requests_in_flight` — rises/falls with concurrency
- `job_queue_depth{queue}` — **the showcase gauge**; populated via `prom-client`'s scrape-time `collect()` callback calling BullMQ `getWaitingCount()` (no separate polling timer)
- `worker_active_jobs` — jobs currently being processed (0–4, given the pool)

**Histogram**
- `http_request_duration_seconds{method, route, status_code}` — RED **Duration** (custom buckets tuned to expected latency)

**Summary**
- `job_processing_duration_seconds{type}` — business latency. Deliberately a summary (the HTTP metric already demonstrates a histogram), so all four metric types appear once. Quantiles (0.5/0.9/0.99) are calculated in the app over a sliding 10-minute window. The trade-offs vs a histogram (fixed quantiles, no aggregation across labels or instances, no heatmap) are **described in the article, not demonstrated live**.

## 2.4 Labels & Cardinality

**Use (bounded sets):** `method` (~7), `status_code` (~10), `route` (small fixed set of templates), `type` (small enum), `result` (success/failure).

**Never use as labels:** `job_id`, `user_id`, raw paths containing IDs, timestamps, free-text payload values — each unique value creates a new time series (cardinality explosion).

**Key rule:** normalise routes before labelling — `/jobs/123` → `route="/jobs/:id"`.

## 2.5 Exporters

Demonstrates "an exporter is a translator for a service that doesn't speak Prometheus."

- `redis_exporter` sits beside Redis, reads Redis's own stats via `INFO`, exposes `redis_*` metrics on `:9121`. Prometheus scrapes *the exporter*, not Redis directly.
- Surfaced in Grafana: memory usage, connected clients, commands processed.
- *Stretch:* add `cadvisor` or `node_exporter` for container/host metrics.

## 2.6 Infrastructure

**`docker-compose.yml`** — see the file itself. Seven services, all images pinned: `backend` (container `hono-app`, `./src` mounted, `REDIS_URL` + `CHOKIDAR_USEPOLLING` env), `redis` (`7.4.8-alpine`, `redis-data` volume so jobs survive restarts), `redis_exporter` (`v1.93.0`), `prometheus` (`v3.12.0`, 15d retention, `prometheus.yml` + `alerts.yml` mounted), `alertmanager` (`v0.34.1`, `alertmanager.yml` mounted), `grafana` (`13.0.2`, `./grafana/provisioning` mounted read-only), and `k6` (`2.3.0`, behind the `load` profile, `./loadgen` mounted).

**`prometheus.yml`**
```yaml
global:
  scrape_interval: 5s
  evaluation_interval: 5s   # how often alert rules are checked

rule_files:
  - /etc/prometheus/alerts.yml

# Firing alerts are sent here
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

scrape_configs:
  - job_name: 'hono-app'
    static_configs:
      - targets: ['backend:3000']

  - job_name: 'redis'
    static_configs:
      - targets: ['redis_exporter:9121']

  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  - job_name: 'alertmanager'
    static_configs:
      - targets: ['alertmanager:9093']
```

Notes: `metrics_path` defaults to `/metrics` for all four. The `alerting:` block is where Prometheus *pushes* firing alerts; the `alertmanager` scrape job is separate — it *pulls* Alertmanager's own health metrics. The Prometheus self-scrape uses `localhost:9090` because that target resolves from *inside* the Prometheus container. On this Compose network, hostnames are the **service names** (`backend`, `redis_exporter`) — not container names. `up` is auto-generated per target; use it for the Grafana target-health panel. Retention default is ~15 days (set explicitly above).

## 2.7 Grafana Dashboard

Provisioned Prometheus datasource (fixed uid `prometheus`) + a dashboard provisioned via JSON (`grafana/provisioning/dashboards/json/job-queue-api.json`, uid `job-queue-api`). Queries use Grafana's `$__rate_interval` instead of a fixed `[5m]`. 13 panels, top to bottom:

1. **Target health** — `up` per job (UP/DOWN tiles)
2. **Request rate** — `sum(rate(http_requests_total[$__rate_interval])) by (route)`
3. **Error rate %** — two lines: 5xx ÷ all (~3% simulated server errors) and 4xx ÷ all (client errors from bad bodies)
4. **Latency p50/p95/p99** — `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[$__rate_interval])) by (le))`
5. **Queue depth** — `job_queue_depth`
6. **Worker active jobs** — `worker_active_jobs` (axis capped at 4) *(added during build)*
7. **Jobs processed** — `sum(rate(jobs_processed_total[$__rate_interval])) by (result)`
8. **Job failure rate %** — failures ÷ all processed (worker failures are async — they never show up in HTTP status)
9. **Job p90 by type** — `job_processing_duration_seconds{quantile="0.9"}`, read straight from the summary *(added during build)*
10. **Latency heatmap** — `sum(increase(http_request_duration_seconds_bucket[$__rate_interval])) by (le)` (a histogram-only capability)
11. **In-flight requests** — `http_requests_in_flight`
12. **Redis memory** — `redis_memory_used_bytes` (exporter)
13. **Redis connected clients** — `redis_connected_clients` (exporter)

## 2.8 Load Generation (k6)

k6 chosen over autocannon/Artillery because its **ramping** (climb → hold → drop) makes the dashboards show cause-and-effect — rate rising, latency reacting, queue depth filling and draining. Constant-rate floods give flat, un-instructive graphs.

- Runs as a one-shot `grafana/k6` container, behind the `load` Compose profile.
- Script at `loadgen/script.js`, mounted in; targets `http://backend:3000` over the Compose network.
- Stages: 30s → 5 VUs, 30s → 20 VUs, hold 20 VUs for 1m, 30s → 0 (~2.5 min total). Each VU iteration has 1–2s think time.
- Traffic mix: ~90% valid `POST /jobs` (random type), ~10% bad bodies (→ `400`), and 30% of new jobs followed by a `GET /jobs/:id`. `400`s are marked as expected so k6 only counts the simulated `500`s as failures.
- Result at peak: queue depth reaches ~400 while HTTP p95 stays ~50ms, then drains after the ramp down.

Run on demand:
```bash
docker compose run --rm k6
```

*Dev-time only:* `npx autocannon <url>` as a throwaway smoke test — not committed.

## 2.9 Alerting

- **`alerts.yml`** (loaded via `rule_files`, evaluated every 5s):
  - `QueueBackingUp` — `job_queue_depth > 200` for 1m, `severity: warning`. Fires during the bigger k6 burst (`--stage 20s:50,1m:50,20s:0`) while HTTP metrics stay healthy.
  - `HighServerErrorRate` — 5xx ÷ all > 5% for 1m, `severity: critical`. Stays inactive at the normal ~3%.
- States: inactive → pending (condition true, `for` clock running) → firing (sent to Alertmanager). Visible at `:9090/alerts`; history via `ALERTS{...}`.
- **`alertmanager.yml`**: groups by `alertname` (`group_wait 10s`, `group_interval 1m`, `repeat_interval 1h`), one `default` receiver with no delivery configured — alerts are viewed and silenced in the UI at `:9093`.

## 2.10 Out of Scope (mention in article, don't build)

- Logs & traces (the other two observability pillars — this demo is metrics only)
- Remote write / Thanos / Mimir
- *Stretch goals not built:* recording rules, native histograms, a real notification receiver (Slack/PagerDuty/email). Alertmanager itself was built — see Milestone 7.

---

# 3. Milestones

Build in this order. Each has a "done when" check.

### Milestone 1 — Hono app + metrics foundation ✅
Build the Hono skeleton with `/healthz` and `/metrics` (prom-client registry incl. default process metrics), plus the HTTP middleware: `http_requests_total`, `http_requests_in_flight`, `http_request_duration_seconds`. Normalise routes for the `route` label.
**Done when:** `docker compose up backend` serves `/metrics`, and Prometheus `:9090/targets` shows `hono-app` **UP**.

### Milestone 2 — Redis + job pipeline + business metrics ✅
Wire BullMQ. Implement `POST /jobs` (enqueue, `202`, ~10% `400`, ~3% `500`, submit delay), `GET /jobs/:id` (BullMQ job state), and the worker pool of 4. Add business metrics: `jobs_enqueued_total`, `jobs_processed_total{result}`, `job_processing_duration_seconds` (summary), `worker_active_jobs`, and `job_queue_depth` via a `collect()` callback calling `getWaitingCount()`.
**Done when:** posting jobs moves queue depth + processed counters, and `/jobs/:id` reflects `waiting → active → completed/failed`.

### Milestone 3 — Prometheus scraping verified ✅
Added the `redis` and `prometheus` scrape jobs to `prometheus.yml`, then confirmed scraping.
**Done when:** all targets are green at `:9090/targets` (three at the time; four once Alertmanager was added) and app metrics are queryable.

### Milestone 4 — Redis exporter confirmed ✅
Already in compose (§2.6). Confirm it's scraped.
**Done when:** `redis_*` metrics (e.g. `redis_memory_used_bytes`) are queryable in Prometheus and the `redis` target is UP.

### Milestone 5 — Grafana provisioning ✅
Added `./grafana/provisioning` (mounted in compose), with a provisioned Prometheus datasource and the dashboard JSON for the §2.7 panels.
**Done when:** Grafana at `:3001` loads the dashboard automatically on boot, showing live data.

### Milestone 6 — k6 load script ✅
Wrote `loadgen/script.js` with a staged ramp.
**Done when:** `docker compose run --rm k6` drives traffic and the panels visibly react — request rate climbs, latency percentiles move, queue depth fills and drains.

### Milestone 7 — *(stretch)* Alerting ✅
Alertmanager + alert rules in `alerts.yml`: `QueueBackingUp` (`job_queue_depth > 200` for 1m, fires during the bigger k6 burst) and `HighServerErrorRate` (5xx > 5% for 1m). Alertmanager (`:9093`) uses a receiver with no delivery configured, so alerts are viewed in its UI only; a real setup would add Slack/PagerDuty/email.
**Done when:** a sustained error spike fires a visible alert.

---

# 4. As-built notes

Where the build differs from the original plan, and things learned along the way.

- **BullMQ instead of hand-rolled Redis.** The original plan used `ioredis` directly (`LPUSH`/`BRPOP`, a state hash per job, a hand-written pool). BullMQ replaces all of that: `queue.add()` to enqueue, `Worker` with `concurrency: 4`, `job.getState()` for status. Job IDs are sequential numbers, not UUIDs. Finished jobs are trimmed to the last 1000 completed / 1000 failed.
- **One histogram, one summary.** The plan had job latency as both a histogram and a summary twin. To avoid bloat, job latency is a summary only (`job_processing_duration_seconds`), since the HTTP metric already demonstrates a histogram. Each of the four metric types now appears once.
- **400s come from real validation.** Instead of rejecting ~10% of valid requests at random, the API validates properly and k6 sends ~10% bad bodies. The ~3% `500`s stay random (simulated downstream failure).
- **Unmatched routes** are labelled `route="unmatched"`, so 404s for arbitrary paths can't create new series. The route label comes from Hono's `routePath(c, -1)` helper (`c.req.routePath` is deprecated).
- **`/metrics` scrapes are counted** in `http_requests_total` (a steady baseline under `route="/metrics"`); filter with `route!="/metrics"` if it adds noise.
- **In-flight gauge looks flat.** A gauge is only sampled at scrape time (every 5s); requests last 5–50ms, so most scrapes miss them. A useful lesson on gauge sampling, not a bug.
- **tsconfig uses `moduleResolution: "bundler"`** so imports need no `.js` extension. Plain `tsc` output can't run under Node ESM without extensions, so `build` uses **tsup** (esbuild) to bundle `src/` into `dist/index.js`, `start` runs that, and `typecheck` (`tsc --noEmit`) does type-checking only.
- **Images pinned** to the versions verified working (see §2.6), so the demo is reproducible later.
- **Alertmanager without delivery.** Chosen over a webhook/echo container to keep the stack lean; a real setup would add `slack_configs` (or similar) to the `default` receiver.
- **Windows / Docker Desktop quirks.** File change events on bind mounts don't reach watchers inside containers. Fixed for the app with `CHOKIDAR_USEPOLLING=true` on `backend` (tsx's watcher polls instead), so code edits hot-reload. Grafana's provisioning poll still doesn't notice JSON edits — reload with `POST /api/admin/provisioning/dashboards/reload`. In Git Bash, `docker compose run` needs `MSYS_NO_PATHCONV=1`.

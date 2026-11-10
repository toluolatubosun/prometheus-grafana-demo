# Prometheus + Grafana Demo

A Hono + BullMQ job-queue API that demonstrates Prometheus and Grafana: the pull model, `/metrics`, `up`, exporters, scrape jobs, labels and cardinality, the RED framework, all four metric types, provisioned dashboards, and load testing with k6.

I did a deep dive and walkthrough of the concepts implemented here in a [Medium article](#). I would recommend reading that first if you're new to Prometheus, so the code is more understandable.

The app is a producer/consumer system: the API accepts jobs and puts them on a Redis queue, and an in-process worker (4 slots) processes them. Under load the API stays fast while jobs pile up in the queue, so HTTP metrics alone would say everything is fine. The demo instruments both layers to show where load actually hides.

## Quick start

```bash
docker compose up -d --build
docker compose run --rm k6
```

The second command runs a ~2.5 minute load test. Open the dashboard while it runs.

| Service | URL |
|---|---|
| API | http://localhost:3000 |
| Prometheus | http://localhost:9090 (targets at `/targets`) |
| Grafana | http://localhost:3001/d/job-queue-api (`admin` / `admin`) |
| Alertmanager | http://localhost:9093 |
| redis_exporter | http://localhost:9121/metrics |
| Redis | `localhost:6379` |

## Where things live

**src/**

- `index.ts` — Hono app. Mounts the metrics middleware on every route, serves `/healthz` and `/metrics`, mounts the job routes, and starts the worker by importing it (same process as the API).
- `libraries/metrics.ts` — the `prom-client` registry and every metric definition. `collectDefaultMetrics()` adds `process_*` / `nodejs_*` for free. `job_queue_depth` has no update code: its `collect()` callback runs on each scrape and reads `getWaitingCount()` from the queue.
- `libraries/queue.ts` — the BullMQ `Queue`, the job type enum (`email`, `thumbnail`, `report`, which is small and fixed, so it is safe as a label), and job retention (last 1000 completed / failed).
- `libraries/bullmq.ts` — Redis connection options from `REDIS_URL`. BullMQ opens and manages its own connections.
- `middleware/metrics.ts` — records the RED metrics for every request: in-flight gauge up, start timer, `next()`, then in `finally` the counter, histogram, and gauge down. Labels use the matched route template (`routePath(c, -1)`), never the raw path; unmatched requests collapse into `route="unmatched"`.
- `routes/jobs.ts` — `POST /jobs` adds a 5–50ms delay, validates the body (`400`), fails ~3% of the time (`500`, simulated downstream failure), then enqueues and returns `202 { id }`. `GET /jobs/:id` returns the BullMQ state: `waiting`, `active`, `completed`, or `failed`.
- `workers/jobs.ts` — BullMQ `Worker` with `concurrency: 4`. Simulates work per type (email 50–300ms, thumbnail 200–800ms, report 0.5–2s) and fails ~7% of the time. Records `worker_active_jobs`, `jobs_processed_total{result}`, and the job duration summary. These failures happen after the `202`, so they never show up in HTTP status codes.

**prometheus.yml**
Three scrape jobs, every 5s: `hono-app` (`backend:3000`), `redis` (`redis_exporter:9121`), and `prometheus` (itself). Targets use Compose service names. Loads the alert rules via `rule_files`, evaluates them every 5s, and sends firing alerts to Alertmanager. Also scrapes Alertmanager itself.

**alerts.yml**
Alert rules. `QueueBackingUp` fires when `job_queue_depth > 200` for 1m. `HighServerErrorRate` fires when 5xx responses are above 5% for 1m; it stays quiet at the normal ~3%.

**alertmanager.yml**
Groups alerts by name and routes them to a single `default` receiver with no delivery configured, so alerts show in the Alertmanager UI only. In a real setup you'd add a Slack, PagerDuty, or email config to that receiver.

**grafana/provisioning/**

- `datasources/prometheus.yml` — Prometheus datasource with a fixed uid (`prometheus`) so the dashboard JSON can reference it.
- `dashboards/dashboards.yml` — provider that loads every JSON file in `dashboards/json/`.
- `dashboards/json/job-queue-api.json` — the dashboard: target health, RED (rate, error %, p50/p95/p99), queue depth, worker active jobs, jobs processed, job failure %, job p90 (summary), latency heatmap, in-flight requests, and Redis memory and clients.

**loadgen/script.js**
k6 load test. Stages: 30s → 5 users, 30s → 20, hold 1m, 30s → 0. About 90% valid `POST /jobs`, 10% bad bodies (`400`), and 30% of new jobs followed by `GET /jobs/:id`.

**docker-compose.yml**
`backend`, `redis` (with a volume), `redis_exporter`, `prometheus`, `alertmanager`, `grafana` (provisioning mounted), and `k6` (behind the `load` profile, so it only runs on demand).

## Metrics

| Type | Metric |
|---|---|
| Counter | `http_requests_total{method, route, status_code}`, `jobs_enqueued_total{type}`, `jobs_processed_total{type, result}` |
| Gauge | `http_requests_in_flight`, `job_queue_depth{queue}`, `worker_active_jobs` |
| Histogram | `http_request_duration_seconds{method, route, status_code}` |
| Summary | `job_processing_duration_seconds{type}` |

## Load test flow

Run `docker compose run --rm k6` with the dashboard set to **Last 15 minutes**.

```
warm up -> climb -> hold (queue grows) -> drop -> queue drains
```

- **Request rate** follows the k6 stages.
- **HTTP p95** stays flat at around 50ms, because the API only enqueues.
- **Queue depth** grows during the hold (about 400 at peak), because jobs arrive faster than 4 workers finish them. It drains after k6 stops.
- **Worker active jobs** pins at 4.
- **Error rate** shows ~3% server errors and the client errors from bad bodies; **job failure rate** shows ~7% worker failures that HTTP never sees.

## Alerting

Run the bigger burst so the queue stays above 200 long enough to fire `QueueBackingUp`:

```bash
docker compose run --rm k6 run --stage 20s:50,1m:50,20s:0 /scripts/script.js
```

Watch http://localhost:9090/alerts. The rule goes **inactive → pending** once the queue passes 200 (the 1 minute `for` clock starts), then **firing** after a full minute above 200, and back to **inactive** once the queue drains. The HTTP error rate stays normal the whole time, so only the queue alert catches the problem.

Once firing, Prometheus sends the alert to Alertmanager. Open http://localhost:9093 to see it grouped under `QueueBackingUp` with its labels and description, or to create a silence. Pending alerts never reach Alertmanager.

The alerts page only shows the current state. For history, query `ALERTS{alertname="QueueBackingUp"}` in the Graph tab.

## Useful commands

```bash
# Bigger burst (fires the QueueBackingUp alert) or a flat burst
docker compose run --rm k6 run --stage 20s:50,1m:50,20s:0 /scripts/script.js
docker compose run --rm k6 run --vus 30 --duration 30s /scripts/script.js

# Try the API by hand
curl -X POST localhost:3000/jobs -H "Content-Type: application/json" -d '{"type":"email","payload":{}}'
curl localhost:3000/jobs/1
curl localhost:3000/metrics

# Reload the dashboard after editing its JSON
curl -X POST -u admin:admin localhost:3001/api/admin/provisioning/dashboards/reload
```

In Git Bash on Windows, prefix `docker compose run` with `MSYS_NO_PATHCONV=1` so `/scripts` isn't rewritten.

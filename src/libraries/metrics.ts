import { Counter, Gauge, Histogram, Registry, Summary, collectDefaultMetrics } from "prom-client";

import { QUEUE_NAME, jobsQueue } from "./queue";

// One registry holds every metric the app exposes on /metrics
export const register = new Registry();

// Built-in process/Node.js metrics: CPU, memory, event loop lag, GC, etc.
collectDefaultMetrics({ register });

// RED: Rate + Errors (filter by status_code for errors)
export const httpRequestsTotal = new Counter({
	name: "http_requests_total",
	help: "Total HTTP requests",
	labelNames: ["method", "route", "status_code"],
	registers: [register],
});

// Requests currently being handled; goes up and down
export const httpRequestsInFlight = new Gauge({
	name: "http_requests_in_flight",
	help: "HTTP requests currently being processed",
	registers: [register],
});

// RED: Duration. Buckets tuned around the expected 5–50ms latency
export const httpRequestDuration = new Histogram({
	name: "http_request_duration_seconds",
	help: "HTTP request duration in seconds",
	labelNames: ["method", "route", "status_code"],
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
	registers: [register],
});

// Business metric: jobs accepted onto the queue
export const jobsEnqueuedTotal = new Counter({
	name: "jobs_enqueued_total",
	help: "Total jobs enqueued",
	labelNames: ["type"],
	registers: [register],
});

// Business metric: jobs finished by the worker. result = success | failure.
export const jobsProcessedTotal = new Counter({
	name: "jobs_processed_total",
	help: "Total jobs processed by the worker",
	labelNames: ["type", "result"],
	registers: [register],
});

// Business latency, as a summary (HTTP duration above shows the histogram).
// Quantiles are calculated here in the app (over a sliding 10 minute window), not by Prometheus.
export const jobProcessingDuration = new Summary({
	name: "job_processing_duration_seconds",
	help: "Job processing duration in seconds",
	labelNames: ["type"],
	percentiles: [0.5, 0.9, 0.99],
	maxAgeSeconds: 600,
	ageBuckets: 5,
	registers: [register],
});

// Business metric: Jobs currently being processed
export const workerActiveJobs = new Gauge({
	name: "worker_active_jobs",
	help: "Jobs currently being processed by the worker",
	registers: [register],
});

// Not updated by our code: collect() runs on every scrape and reads the current number of waiting jobs from the queue.
export const jobQueueDepth = new Gauge({
	name: "job_queue_depth",
	help: "Jobs waiting in the queue",
	labelNames: ["queue"],
	registers: [register],
	async collect() {
		this.set({ queue: QUEUE_NAME }, await jobsQueue.getWaitingCount());
	},
});

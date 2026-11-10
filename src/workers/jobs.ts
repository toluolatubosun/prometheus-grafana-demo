import { Worker } from "bullmq";
import { setTimeout as sleep } from "node:timers/promises";

import { connection } from "../libraries/bullmq";
import { QUEUE_NAME, type JobType } from "../libraries/queue";
import { jobProcessingDuration, jobsProcessedTotal, workerActiveJobs } from "../libraries/metrics";

// Simulated processing time per job type (ms), so the type label shows different latencies
const DURATION_MS: Record<JobType, [min: number, max: number]> = {
	email: [50, 300],
	thumbnail: [200, 800],
	report: [500, 2000],
};

const FAILURE_RATE = 0.07;

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

// Consumer: BullMQ pops jobs and tracks state (waiting -> active -> completed/failed).
// Up to 4 jobs are processed at once.
export const jobsWorker = new Worker(
	QUEUE_NAME,
	async (job) => {
		const type = job.name as JobType;
		let result: "success" | "failure" = "failure";

		workerActiveJobs.inc();
		const start = performance.now();

		try {
			const [min, max] = DURATION_MS[type];
			await sleep(randomBetween(min, max));

			// Throwing marks the job as failed. This failure happens after the HTTP 202,
			// so it never shows up in HTTP status codes.
			if (Math.random() < FAILURE_RATE) {
				throw new Error("simulated processing failure");
			}

			result = "success";
		} finally {
			const seconds = (performance.now() - start) / 1000;

			jobProcessingDuration.observe({ type }, seconds);
			jobsProcessedTotal.inc({ type, result });
			workerActiveJobs.dec();
		}
	},
	{ connection, concurrency: 4 },
);

jobsWorker.on("error", (err) => console.error("Worker error:", err.message));

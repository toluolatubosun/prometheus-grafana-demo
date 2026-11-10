import { Queue } from "bullmq";

import { connection } from "./bullmq";

// Shared between the API (producer) and the worker (consumer)
export const QUEUE_NAME = "jobs";

export const jobsQueue = new Queue(QUEUE_NAME, {
	connection,
	defaultJobOptions: {
		// Keep recent finished jobs so GET /jobs/:id can report them, without growing Redis forever
		removeOnComplete: { count: 1000 },
		removeOnFail: { count: 1000 },
	},
});

// Small fixed set, so it is safe to use as a metric label
export const JOB_TYPES = ["email", "report", "thumbnail"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const isJobType = (value: unknown): value is JobType =>
	typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);

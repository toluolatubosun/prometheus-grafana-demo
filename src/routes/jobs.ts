import { Hono } from "hono";
import { setTimeout as sleep } from "node:timers/promises";

import { jobsEnqueuedTotal } from "../libraries/metrics";
import { isJobType, jobsQueue } from "../libraries/queue";

export const jobs = new Hono();

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

// Producer: validate, enqueue, return 202 immediately.
jobs.post("/", async (c) => {
	// Load-independent intake delay so the request-duration histogram has a real spread
	await sleep(randomBetween(5, 50));

	const body = await c.req.json().catch(() => null);
	if (!body || !isJobType(body.type) || typeof body.payload !== "object" || body.payload === null) {
		return c.json({ error: "body must be { type: email|report|thumbnail, payload: object }" }, 400);
	}

	// Simulated downstream failure (~3%) so the server-error-rate panel has signal
	if (Math.random() < 0.03) {
		return c.json({ error: "simulated downstream failure" }, 500);
	}

	// The job name is its type; BullMQ stores the job and its state in Redis for us
	const job = await jobsQueue.add(body.type, body.payload);

	jobsEnqueuedTotal.inc({ type: body.type });

	return c.json({ id: job.id }, 202);
});

// Job status: waiting -> active -> completed/failed (BullMQ's state names)
jobs.get("/:id", async (c) => {
	const job = await jobsQueue.getJob(c.req.param("id"));
	if (!job) return c.json({ error: "job not found" }, 404);

	return c.json({ id: job.id, type: job.name, state: await job.getState() });
});

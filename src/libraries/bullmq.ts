import type { ConnectionOptions } from "bullmq";

// BullMQ opens and manages its own Redis connections from these options
export const connection: ConnectionOptions = {
	url: process.env.REDIS_URL ?? "redis://localhost:6379",
};

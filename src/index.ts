import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { jobs } from "./routes/jobs";
import { register } from "./libraries/metrics";
import { metricsMiddleware } from "./middleware/metrics";

// Starts the background worker in the same process as the API
import "./workers/jobs";

const app = new Hono();

app.use("*", metricsMiddleware);

app.get("/", (c) => c.text("Hello Hono!"));
app.get("/healthz", (c) => c.text("ok"));

app.route("/jobs", jobs);

// Prometheus scrape target: serialises everything in the registry
app.get("/metrics", async (c) => {
	return c.text(await register.metrics(), 200, { "Content-Type": register.contentType });
});

serve(
	{
		fetch: app.fetch,
		port: 3000,
	},
	(info) => {
		console.log(`Server is running on http://localhost:${info.port}`);
	},
);

import { routePath } from "hono/route";
import { createMiddleware } from "hono/factory";

import { httpRequestDuration, httpRequestsInFlight, httpRequestsTotal } from "../libraries/metrics";

// Records RED metrics for every request
export const metricsMiddleware = createMiddleware(async (c, next) => {
	httpRequestsInFlight.inc();
	const endTimer = httpRequestDuration.startTimer();

	try {
		await next();
	} finally {
		// Use the matched route template ("/jobs/:id"), never the raw path, to keep cardinality bounded.
		// Unmatched requests (404s) all collapse into one "unmatched" series.
		
		const matched = routePath(c, -1); // -1 = last matched route, i.e. the handler
		const route = matched === "/*" ? "unmatched" : matched;
		const labels = { method: c.req.method, route, status_code: String(c.res.status) };

		httpRequestsTotal.inc(labels);
		endTimer(labels);
		httpRequestsInFlight.dec();
	}
});

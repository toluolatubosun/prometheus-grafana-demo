import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = "http://backend:3000";
const JOB_TYPES = ["email", "thumbnail", "report"];
const HEADERS = { "Content-Type": "application/json" };

// Climb -> hold -> drop, so the dashboard shows cause and effect.
// At peak, jobs arrive faster than the 4 worker slots can finish them,
// so queue depth grows during the hold and drains after the ramp down.
export const options = {
	stages: [
		{ duration: "30s", target: 5 }, // warm up
		{ duration: "30s", target: 20 }, // climb
		{ duration: "1m", target: 20 }, // hold at peak
		{ duration: "30s", target: 0 }, // drop
	],
};

// 400s are expected (we send bad bodies on purpose), so don't count them as k6 failures
http.setResponseCallback(http.expectedStatuses(200, 202, 400));

export default function () {
	// ~10% invalid bodies -> 400 (client errors)
	if (Math.random() < 0.1) {
		const res = http.post(`${BASE_URL}/jobs`, JSON.stringify({ type: "unknown" }), { headers: HEADERS });
		check(res, { "bad body -> 400": (r) => r.status === 400 });
	} else {
		const type = JOB_TYPES[Math.floor(Math.random() * JOB_TYPES.length)];
		const res = http.post(`${BASE_URL}/jobs`, JSON.stringify({ type, payload: { n: __ITER } }), {
			headers: HEADERS,
		});
		check(res, { "enqueued -> 202": (r) => r.status === 202 });

		// Sometimes check on the job we just created (exercises the /jobs/:id route label)
		if (res.status === 202 && Math.random() < 0.3) {
			http.get(`${BASE_URL}/jobs/${res.json("id")}`);
		}
	}

	sleep(1 + Math.random()); // think time: 1–2s between iterations per virtual user
}

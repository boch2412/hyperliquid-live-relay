import test from "node:test";
import assert from "node:assert/strict";

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("health response body deadline and compatibility", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousTimeout = process.env.HEALTH_API_TIMEOUT_MS;
  process.env.HEALTH_API_TIMEOUT_MS = "25";

  try {
    const { default: handler } = await import(
      "../api/health.js?test=response-body"
    );

    await t.test("abort a body stalled after HTTP 200 headers", async () => {
      let aborted = false;
      globalThis.fetch = async (url, options) => {
        assert.equal(url, "https://api.hyperliquid.xyz/info");
        assert.deepEqual(JSON.parse(options.body), { type: "allMids" });
        return {
          ok: true,
          status: 200,
          text: () => new Promise((_, reject) => {
            const abort = () => {
              aborted = true;
              reject(options.signal.reason);
            };
            if (options.signal.aborted) abort();
            else options.signal.addEventListener("abort", abort, { once: true });
          }),
        };
      };

      const res = makeRes();
      let watchdog;
      try {
        await Promise.race([
          handler({}, res),
          new Promise((_, reject) => {
            watchdog = setTimeout(() => reject(
              new Error("health response body timeout was not enforced")
            ), 500);
          }),
        ]);
      } finally {
        clearTimeout(watchdog);
      }
      assert.equal(aborted, true);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.ok, false);
      assert.match(res.body.error, /health API timeout after 25ms/);
      assert.equal(res.headers["Cache-Control"], "no-store");
    });

    for (const scenario of [
      { name: "JSON success", body: '{"BTC":"100","SUI":"1"}', status: 200, expected: 200, sample: ["BTC", "SUI"] },
      { name: "non-JSON success", body: "not JSON", status: 200, expected: 200, sample: null },
      { name: "upstream HTTP error", body: "rate limited", status: 429, expected: 502, sample: null },
    ]) {
      await t.test(scenario.name, async () => {
        globalThis.fetch = async () => new Response(scenario.body, { status: scenario.status });
        const res = makeRes();
        await handler({}, res);
        assert.equal(res.statusCode, scenario.expected);
        assert.equal(res.body.ok, scenario.status === 200);
        assert.equal(res.body.upstreamStatus, scenario.status);
        assert.deepEqual(res.body.sample, scenario.sample);
        assert.equal(typeof res.body.latencyMs, "number");
        assert.equal(typeof res.body.receivedAt, "number");
        assert.equal(res.headers["Cache-Control"], "no-store");
      });
    }

    await t.test("preserve non-timeout body errors", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => { throw new Error("body read failed"); },
      });
      const res = makeRes();
      await handler({}, res);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, "Error: body read failed");
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTimeout === undefined) delete process.env.HEALTH_API_TIMEOUT_MS;
    else process.env.HEALTH_API_TIMEOUT_MS = previousTimeout;
  }
});

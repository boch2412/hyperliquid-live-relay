const HL_INFO = "https://api.hyperliquid.xyz/info";
const API_TIMEOUT_MS = Math.max(
  1,
  Number(
    process.env.HEALTH_API_TIMEOUT_MS
  ) || 8_000
);

async function postInfo(payload) {
  const t0 = Date.now();
  const controller =
    new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    API_TIMEOUT_MS
  );
  let r;

  try {
    r = await fetch(HL_INFO, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `health API timeout after ${API_TIMEOUT_MS}ms`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await r.text();
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {}

  return {
    ok: r.ok,
    status: r.status,
    data,
    latencyMs: Date.now() - t0
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    const out = await postInfo({ type: "allMids" });

    res.status(out.ok ? 200 : 502).json({
      ok: out.ok,
      upstreamStatus: out.status,
      latencyMs: out.latencyMs,
      receivedAt: Date.now(),
      sample:
        out.data && typeof out.data === "object"
          ? Object.keys(out.data).slice(0, 8)
          : null
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e)
    });
  }
}

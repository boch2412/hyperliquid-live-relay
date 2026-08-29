const HL_INFO = "https://api.hyperliquid.xyz/info";

async function postInfo(payload) {
  const t0 = Date.now();
  const r = await fetch(HL_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

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

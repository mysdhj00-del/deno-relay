// CloudStream relay — Deno Deploy edition.
// Phase 1 (this file): a PROBE that measures, from Deno Deploy's real
// egress, whether the four problem sites answer and how fast — before
// any production relay code is ported. Phase 2 replaces /probe with the
// full relay routes once the probe verdict is in.

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - t0), value };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: String(e).slice(0, 300) };
  }
}

async function probeEgress() {
  const r = await fetch("https://cloudflare.com/cdn-cgi/trace", {
    signal: AbortSignal.timeout(12000),
  });
  const text = await r.text();
  const kv: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  return { ip: kv.ip, loc: kv.loc, colo: kv.colo };
}

async function probeEgyDeadPlain() {
  const r = await fetch("https://tv10.egydead.live/", {
    headers: { "User-Agent": CHROME_UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  return {
    status: r.status,
    bytes: text.length,
    cards: (text.match(/BottomTitle/g) || []).length,
    challenge: text.includes("Just a moment"),
  };
}

async function probeEgyDeadImpit() {
  // impit is the Chrome-impersonating client the Render relay uses to
  // pass EgyDead's TLS-fingerprint wall. On Deno Deploy it may or may
  // not load (native module) — that is exactly what this probe answers.
  const mod = await import("npm:impit");
  const impit = new mod.Impit({ browser: "chrome" });
  const r = await impit.fetch("https://tv10.egydead.live/", {
    headers: { "User-Agent": CHROME_UA, Accept: "text/html" },
  });
  const text = await r.text();
  return {
    status: r.status,
    bytes: text.length,
    cards: (text.match(/BottomTitle/g) || []).length,
    challenge: text.includes("Just a moment"),
  };
}

async function probeAnimeZid() {
  const r = await fetch("https://animezid.org/", {
    headers: { "User-Agent": CHROME_UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  return { status: r.status, bytes: text.length };
}

async function probeWeCima() {
  const r = await fetch("https://wecima.mobile/", {
    headers: { "User-Agent": CHROME_UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  return {
    status: r.status,
    bytes: text.length,
    cards: (text.match(/show-card/g) || []).length,
  };
}

async function probeViu() {
  const digits = Math.floor(100000000 + Math.random() * 900000000).toString();
  const r = await fetch(
    `https://api-gateway-global.viu.com/api/auth/token?v=${digits}000`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CHROME_UA },
      body: JSON.stringify({
        countryCode: "EG",
        platform: "browser",
        platformFlagLabel: "web",
        language: "en",
        uuid: crypto.randomUUID(),
        carrierId: "0",
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const text = await r.text();
  let hasToken = false;
  try {
    hasToken = Boolean(JSON.parse(text).token);
  } catch { /* not json */ }
  return { status: r.status, bytes: text.length, hasToken };
}

async function probeViuPage() {
  const r = await fetch("https://www.viu.com/ott/eg/ar/", {
    headers: { "User-Agent": CHROME_UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  const text = await r.text();
  return {
    status: r.status,
    finalUrl: r.url,
    noService: r.url.includes("no-service"),
    bytes: text.length,
  };
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (url.pathname === "/") {
    return new Response("deno-relay probe: GET /probe", { status: 200 });
  }
  if (url.pathname !== "/probe") {
    return new Response("not found", { status: 404 });
  }
  const [egress, egydeadPlain, egydeadImpit, animezid, wecima, viu, viuPage] =
    await Promise.all([
      timed(probeEgress),
      timed(probeEgyDeadPlain),
      timed(probeEgyDeadImpit),
      timed(probeAnimeZid),
      timed(probeWeCima),
      timed(probeViu),
      timed(probeViuPage),
    ]);
  const out = {
    egress,
    egydeadPlain,
    egydeadImpit,
    animezid,
    wecima,
    viu,
    viuPage,
  };
  return new Response(JSON.stringify(out, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});

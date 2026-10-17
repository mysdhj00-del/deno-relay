// CloudStream relay — Deno Deploy edition.
// Phase 1 was a probe (kept at /probe). Phase 2 (this file, 2026-10-17):
// the EgyDead relay routes ported from the Render service
// (src/relay.js + src/egydead.js + src/impfetch.js of EgyDead-Stremio),
// because the probe proved EgyDead answers Deno's egress (plain fetch
// AND the Chrome-impersonating impit client) while animezid.org times
// out from it — so only the EgyDead routes move here; AnimeZid stays on
// Render. Mohamed approved the split move 2026-10-17.
//
// Routes:
//   GET /relay/egydead?url=<urlencoded EgyDead post/episode URL>
//       -> { ok, embeds, mirrors, diag }   (warm GET + POST View=1 +
//          MegaMax Inertia mirror expansion, Chrome-impersonated)
//   GET /relay/page?url=<urlencoded EgyDead URL>
//       -> { ok, code, finalUrl, text }    (impersonated GET passthrough,
//          restricted to egydead hosts, text sliced to 2.5 MB)
//   GET /probe -> egress/site probe JSON (kept from phase 1)
//   GET /      -> plain text banner

import { Impit } from "npm:impit";
import * as cheerio from "npm:cheerio";

// ------------------------------------------------------------ impfetch
let impitClient: Impit | null = null;
function impFetch(url: string, opts: Record<string, unknown> = {}) {
  if (!impitClient) impitClient = new Impit({ browser: "chrome" });
  return impitClient.fetch(url, opts);
}

const BASE = (Deno.env.get("EGYDEAD_BASE") || "https://tv10.egydead.live")
  .replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ar-EG,ar;q=0.9,en;q=0.7",
};

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

/** Minimal host-scoped cookie jar (ported from the Render relay). */
// deno-lint-ignore no-explicit-any
class CookieJar {
  entries = new Map<string, { host: string; name: string; value: string }>();
  // deno-lint-ignore no-explicit-any
  store(res: any, url: string) {
    const host = hostOf(url);
    if (!host) return;
    let lines: string[] = [];
    if (res.headers && typeof res.headers.getSetCookie === "function") {
      try {
        lines = res.headers.getSetCookie() || [];
      } catch {
        lines = [];
      }
    }
    if (!lines.length && res.headers) {
      const single = res.headers.get("set-cookie");
      if (single) lines = [single];
    }
    for (const line of lines) {
      const first = String(line).split(";")[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) this.entries.set(`${host}|${name}`, { host, name, value });
    }
  }
  headerFor(url: string): string {
    const host = hostOf(url);
    if (!host) return "";
    const pairs: string[] = [];
    for (const e of this.entries.values()) {
      if (host === e.host || host.endsWith("." + e.host)) {
        pairs.push(`${e.name}=${e.value}`);
      }
    }
    return pairs.join("; ");
  }
}

/** fetchText through impit (egydead.js equivalent). */
async function fetchText(
  url: string,
  opts: {
    method?: string;
    body?: string;
    referer?: string;
    headers?: Record<string, string>;
    timeout?: number;
  } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 25000);
  try {
    const res = await impFetch(url, {
      method: opts.method || "GET",
      body: opts.body,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "ar,en;q=0.8",
        ...(opts.referer ? { Referer: opts.referer } : {}),
        ...(opts.headers || {}),
      },
    });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function fixUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  u = String(u).trim();
  if (!u) return null;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return BASE + u;
  return u;
}

/** MegaMax Inertia mirror resolution (ported from egydead.js). */
async function megaMaxMirrors(
  embed: string,
  referer: string,
): Promise<{ quality: string; mirrors: string[] }[]> {
  const pageText = await fetchText(embed, { referer });
  const m = /<script[^>]*data-page[^>]*>(\{.*?\})<\/script>/s.exec(pageText);
  if (!m) return [];
  // deno-lint-ignore no-explicit-any
  let pageJson: any;
  try {
    pageJson = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const version = pageJson.version;
  if (!version) return [];
  const component = pageJson.component || "files/mirror/video";
  const streamsText = await fetchText(embed, {
    referer: embed,
    headers: {
      "X-Inertia": "true",
      "X-Inertia-Version": version,
      "X-Inertia-Partial-Component": component,
      "X-Inertia-Partial-Data": "streams",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  // deno-lint-ignore no-explicit-any
  let streams: any;
  try {
    streams = JSON.parse(streamsText).props.streams;
  } catch {
    return [];
  }
  if (!streams || streams.status !== "success" || !Array.isArray(streams.data)) {
    return [];
  }
  // deno-lint-ignore no-explicit-any
  return streams.data.map((q: any) => ({
    quality: q.label || q.quality || "",
    mirrors: (q.mirrors || [])
      // deno-lint-ignore no-explicit-any
      .map((x: any) => fixUrl(x.link))
      .filter(Boolean) as string[],
  }));
}

/** Jar-aware impersonated fetch (fetchImp equivalent). */
async function fetchImp(
  url: string,
  opts: {
    method?: string;
    body?: string;
    referer?: string;
    headers?: Record<string, string>;
    jar?: CookieJar;
    timeout?: number;
  } = {},
): Promise<{ status: number; text: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 25000);
  try {
    const headers: Record<string, string> = {
      ...BROWSER_HEADERS,
      ...(opts.headers || {}),
    };
    if (opts.referer) headers.Referer = opts.referer;
    if (opts.jar) {
      const cookie = opts.jar.headerFor(url);
      if (cookie) headers.Cookie = cookie;
    }
    const res = await impFetch(url, {
      method: opts.method || "GET",
      body: opts.body,
      redirect: "follow",
      signal: controller.signal,
      headers,
    });
    if (opts.jar) opts.jar.store(res, url);
    const text = await res.text();
    return { status: res.status, text, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------ EgyDead relay
async function relayEgyDead(targetUrl: string) {
  const diag: Record<string, unknown> = {
    getCode: null,
    postCode: null,
    embedCount: 0,
    mirrorCount: 0,
  };
  const jar = new CookieJar();

  try {
    const g = await fetchImp(targetUrl, { jar, referer: BASE + "/" });
    diag.getCode = g.status;
  } catch (e) {
    diag.getError = String((e as Error)?.message || e);
  }

  let postHtml = "";
  try {
    const p = await fetchImp(targetUrl, {
      method: "POST",
      jar,
      referer: targetUrl,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ View: "1" }).toString(),
    });
    diag.postCode = p.status;
    postHtml = p.text;
  } catch (e) {
    diag.postError = String((e as Error)?.message || e);
  }

  const embeds: string[] = [];
  const seen = new Set<string>();
  if (postHtml) {
    const $ = cheerio.load(postHtml);
    $(".serversList li[data-link]").each((_, el) => {
      const fixed = fixUrl(($(el).attr("data-link") || "").trim());
      if (fixed && !seen.has(fixed)) {
        seen.add(fixed);
        embeds.push(fixed);
      }
    });
    const iframeSrc = $(".watchAreaMaster .holder iframe").first().attr("src");
    const fixedIframe = fixUrl(iframeSrc && iframeSrc.trim());
    if (fixedIframe && !seen.has(fixedIframe)) {
      seen.add(fixedIframe);
      embeds.push(fixedIframe);
    }
  }
  diag.embedCount = embeds.length;

  const mirrors: string[] = [];
  const mSeen = new Set<string>();
  for (const embed of embeds) {
    let groups: { quality: string; mirrors: string[] }[] = [];
    try {
      groups = await megaMaxMirrors(embed, targetUrl);
    } catch {
      groups = [];
    }
    for (const g of groups) {
      for (const m of g.mirrors || []) {
        if (m && !mSeen.has(m)) {
          mSeen.add(m);
          mirrors.push(m);
        }
      }
    }
  }
  diag.mirrorCount = mirrors.length;

  return { ok: embeds.length > 0 || mirrors.length > 0, embeds, mirrors, diag };
}

// ------------------------------------------------------------ probe (phase 1)
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; value?: T; error?: string }> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - t0), value };
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), error: String(e).slice(0, 300) };
  }
}

async function probeAll() {
  const egress = await timed(async () => {
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
  });
  const animezid = await timed(async () => {
    const r = await fetch("https://animezid.org/", {
      headers: { "User-Agent": CHROME_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    return { status: r.status, bytes: text.length };
  });
  return { egress, animezid };
}

// ------------------------------------------------------------ server
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (url.pathname === "/") {
    return new Response("deno-relay: /relay/egydead /relay/page /probe", {
      status: 200,
    });
  }

  if (url.pathname === "/probe") {
    return json(await probeAll());
  }

  if (url.pathname === "/relay/egydead") {
    const target = url.searchParams.get("url");
    if (!target) return json({ ok: false, error: "missing url param" }, 400);
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return json({ ok: false, error: "bad url" }, 400);
    }
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes("egydead")) {
      return json({ ok: false, error: "url must be an EgyDead http(s) URL" }, 400);
    }
    try {
      return json(await relayEgyDead(parsed.toString()));
    } catch (e) {
      return json({ ok: false, error: String((e as Error)?.message || e) });
    }
  }

  if (url.pathname === "/relay/page") {
    const target = url.searchParams.get("url");
    if (!target) return json({ ok: false, error: "missing url param" }, 400);
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return json({ ok: false, error: "bad url" }, 400);
    }
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes("egydead")) {
      return json({ ok: false, error: "url must be an EgyDead http(s) URL" }, 400);
    }
    try {
      const r = await fetchImp(parsed.toString(), {
        referer: "https://" + parsed.hostname + "/",
        timeout: 30000,
      });
      return json({
        ok: r.status === 200,
        code: r.status,
        finalUrl: r.finalUrl,
        text: (r.text || "").slice(0, 2500000),
      });
    } catch (e) {
      return json({ ok: false, error: String((e as Error)?.message || e) });
    }
  }

  return new Response("not found", { status: 404 });
});

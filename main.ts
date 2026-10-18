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

  if (url.pathname === "/xfetch") {
    // Cross-IP probe helper (added 2026-10-17 for the Doodstream
    // IP-binding experiment): fetches a URL from THIS service's egress
    // with a 1 KB Range header, reads at most the first chunk, and
    // reports only the status + byte count. No body is returned.
    const target = url.searchParams.get("url");
    if (!target) return json({ status: 0, error: "missing url param" }, 400);
    try {
      const res = await fetch(target, {
        headers: { Range: "bytes=0-1023" },
        signal: AbortSignal.timeout(20000),
      });
      let bytesRead = 0;
      if (res.body) {
        const reader = res.body.getReader();
        const first = await reader.read();
        if (first.value) bytesRead = first.value.byteLength;
        await reader.cancel().catch(() => {});
      }
      return json({ status: res.status, bytesRead });
    } catch (e) {
      return json({ status: 0, error: String((e as Error)?.message || e) });
    }
  }

  if (url.pathname === "/relay/ping") {
    // v21 stage beacon for the EgyDead provider: log-only endpoint.
    logHitD("ping", {
      stage: url.searchParams.get("stage") || "",
      n: url.searchParams.get("n") || "",
      pv: url.searchParams.get("pv") || "",
      door: "deno",
    });
    return json({ ok: true });
  }

  if (url.pathname === "/relay/vid") {
    const src = url.searchParams.get("src");
    if (!src) return json({ ok: false, error: "missing src param" }, 400);
    try {
      return json(await relayVidD(url, src));
    } catch (e) {
      return json({ ok: false, error: String((e as Error)?.message || e) });
    }
  }

  if (url.pathname === "/relay/hls" || url.pathname.startsWith("/relay/hls/")) {
    return relayHlsD(req);
  }

  if (url.pathname === "/relay/hits") {
    if (url.searchParams.get("k") !== HITS_KEY_D) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    return json({ hits: hitLogD });
  }

  return new Response("not found", { status: 404 });
});

// ============================================================ STREAM PROXY
// Ported 2026-10-18 from the Render service (src/relay.js relayVid /
// relayHls) as the SECOND DOOR for EgyDead v20: the provider tries the
// Render door first, then this Deno door. Same design and same law: the
// egybestvid CDN binds its stream token to the fetching identity's IP
// AND full header profile at master, variant AND segment level, and the
// player cannot carry that profile — so the proxy digs AND fetches with
// one fixed full-header identity and the phone only ever talks to us.
//   GET /relay/vid?src=<egybestvid embed URL>[&pv=20]
//       -> { ok, master:<proxied URL>, diag }
//   GET /relay/hls/m.m3u8?u=<base64url target>&r=<base64url referer>[&pv=20]
//       -> the target fetched with the proxy identity; playlists are
//          rewritten so every resource resolves back through /relay/hls.
//   GET /relay/hits?k=<key> -> the in-memory hit log (pv-tagged), so one
//          tap on the phone is fully visible server-side.

const vidCacheD = new Map<string, { at: number; master: string }>();
const VID_TTL_MS = 30 * 60 * 1000;
const HITS_KEY_D = "saher-obs-7f3";
const hitLogD: Record<string, unknown>[] = [];
function logHitD(route: string, info: Record<string, unknown>) {
  hitLogD.push({ t: new Date().toISOString(), route, ...info });
  if (hitLogD.length > 120) hitLogD.shift();
}

function b64eD(s: string): string {
  return btoa(unescape(encodeURIComponent(String(s))))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64dD(s: string): string {
  const b = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(b)));
}

function isVidHostD(host: string): boolean {
  const h = (host || "").toLowerCase();
  return h === "egybestvid.com" || h.endsWith(".egybestvid.com");
}

function hlsProxyUrlD(origin: string, target: string, referer: string, pv: string): string {
  const p = pv ? `&pv=${encodeURIComponent(pv)}` : "";
  return `${origin}/relay/hls/m.m3u8?u=${encodeURIComponent(b64eD(target))}&r=${encodeURIComponent(b64eD(referer))}${p}`;
}

async function relayVidD(reqUrl: URL, src: string) {
  const pv = reqUrl.searchParams.get("pv") || "";
  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    return { ok: false, error: "bad src" };
  }
  if (!isVidHostD(parsed.hostname)) {
    return { ok: false, error: "src must be an egybestvid embed URL" };
  }
  const cached = vidCacheD.get(src);
  if (cached && Date.now() - cached.at < VID_TTL_MS) {
    logHitD("vid", { src: src.split("/").pop(), ok: true, cached: 1, pv, door: "deno" });
    return { ok: true, master: hlsProxyUrlD(reqUrl.origin, cached.master, src, pv), diag: { cached: 1 } };
  }
  let status = 0;
  let text = "";
  try {
    const res = await fetch(src, {
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
      headers: { ...BROWSER_HEADERS, Referer: "https://egydead.ca/" },
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    logHitD("vid", { src: src.split("/").pop(), ok: false, err: String((e as Error)?.message || e).slice(0, 60), pv, door: "deno" });
    return { ok: false, error: String((e as Error)?.message || e) };
  }
  const clean = text.replace(/\\\//g, "/");
  let master: string | null = null;
  const fileM = /file\s*:\s*["'](https?:[^"']+\.m3u8[^"']*)["']/.exec(clean);
  if (fileM) master = fileM[1];
  if (!master) {
    const bare = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/.exec(clean);
    if (bare) master = bare[0];
  }
  if (!master) {
    logHitD("vid", { src: src.split("/").pop(), ok: false, code: status, pv, door: "deno" });
    return { ok: false, diag: { code: status, len: text.length }, error: "no m3u8 in embed page" };
  }
  if (vidCacheD.size > 100) vidCacheD.clear();
  vidCacheD.set(src, { at: Date.now(), master });
  logHitD("vid", { src: src.split("/").pop(), ok: true, cached: 0, pv, door: "deno" });
  return { ok: true, master: hlsProxyUrlD(reqUrl.origin, master, src, pv), diag: { code: status, cached: 0 } };
}

async function relayHlsD(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pv = url.searchParams.get("pv") || "";
  let target = "";
  let referer = "";
  try {
    target = b64dD(url.searchParams.get("u") || "");
    referer = b64dD(url.searchParams.get("r") || "");
  } catch {
    return json({ ok: false, error: "bad u/r params" }, 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return json({ ok: false, error: "bad target" }, 400);
  }
  if (!isVidHostD(parsed.hostname)) {
    return json({ ok: false, error: "target host not allowed" }, 400);
  }
  let up: Response;
  try {
    up = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(120000),
      headers: { ...BROWSER_HEADERS, Referer: referer || "https://egydead.ca/" },
    });
  } catch (e) {
    logHitD("hls", { err: String((e as Error)?.message || e).slice(0, 60), pv, door: "deno" });
    return json({ ok: false, error: String((e as Error)?.message || e) }, 502);
  }
  const ctype = (up.headers.get("content-type") || "").toLowerCase();
  const isPlaylist = target.includes(".m3u8") || ctype.includes("mpegurl");
  if (isPlaylist) {
    const text = await up.text();
    if (up.status !== 200 || !text.startsWith("#EXTM3U")) {
      // Never rewrite an error page as if it were a playlist.
      logHitD("hls", { kind: "playlist-err", status: up.status, pv, door: "deno" });
      return new Response(text.slice(0, 500), {
        status: up.status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const out = text.split("\n").map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) {
        return t.replace(/URI="([^"]+)"/g, (whole, uri: string) => {
          try {
            const abs = new URL(uri, target).toString();
            return `URI="${hlsProxyUrlD(url.origin, abs, referer, pv)}"`;
          } catch {
            return whole;
          }
        });
      }
      try {
        const abs = new URL(t, target).toString();
        return hlsProxyUrlD(url.origin, abs, referer, pv);
      } catch {
        return line;
      }
    }).join("\n");
    logHitD("hls", { kind: "playlist", status: up.status, bytes: out.length, pv, door: "deno" });
    return new Response(out, {
      status: up.status,
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
    });
  }
  const headers = new Headers();
  headers.set("Content-Type", ctype || "application/octet-stream");
  headers.set("Cache-Control", "no-cache");
  const len = up.headers.get("content-length");
  if (len) headers.set("Content-Length", len);
  if (!up.body) return new Response(null, { status: up.status, headers });
  let segBytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      segBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      logHitD("hls", { kind: "segment", status: up.status, bytes: segBytes, pv, door: "deno" });
    },
  });
  return new Response(up.body.pipeThrough(counter), { status: up.status, headers });
}

import { appendFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { Viewport } from "./viewports.ts";

/**
 * The mirror: the copy at every chosen screen size at once, side by side, like Responsively or
 * Polypane. What the tester does in one size (clicks, typing, selects, Enter/Escape, scrolling, page
 * changes) happens in the others too, so one pass through a flow checks every size.
 *
 * A reverse proxy on 127.0.0.1 serves the copy and the mirror page from one origin, so the page can
 * reach into each frame: it listens in the size the tester drives and repeats each step in the
 * others. The proxy drops what stops the copy from loading in a frame (X-Frame-Options, CSP
 * frame-ancestors). A page loaded in the browser's tab (not in a frame) gets the mirror at that path.
 */
export const MIRROR_PATH = "/__gespann/mirror";
const NOTE_PATH = "/__gespann/note";

/** Space around and between the frames, the label above each, and the bar on top of the page, in CSS px. */
export const LAYOUT = { pad: 16, gap: 16, label: 24, bar: 96 } as const;
/** The largest browser area a mirror asks for: a 4K screen minus the window's frame and toolbar. */
const MAX = { width: 3820, height: 2040 } as const;

/** Frames left to right, a new row when the next one would pass `maxWidth`; sizes scaled by `scale`. */
export function shelf(sizes: readonly Viewport[], scale: number, maxWidth: number): { width: number; height: number; at: { x: number; y: number }[] } {
  let x = 0;
  let y = 0;
  let row = 0;
  let width = 0;
  const at: { x: number; y: number }[] = [];
  for (const v of sizes) {
    const w = v.width * scale;
    if (x > 0 && x + w > maxWidth) {
      x = 0;
      y += row + LAYOUT.gap;
      row = 0;
    }
    at.push({ x, y });
    width = Math.max(width, x + w);
    x += w + LAYOUT.gap;
    row = Math.max(row, v.height * scale + LAYOUT.label);
  }
  return { width, height: y + row, at };
}

/** The browser area the mirror shows every size in at full scale, capped at a 4K screen. */
export function mirrorCanvas(sizes: readonly Viewport[]): { width: number; height: number } {
  const inner = MAX.width - 2 * LAYOUT.pad;
  const s = shelf(sizes, 1, inner);
  return { width: Math.min(MAX.width, Math.ceil(s.width) + 2 * LAYOUT.pad), height: Math.min(MAX.height, Math.ceil(s.height) + LAYOUT.bar + 2 * LAYOUT.pad) };
}

export interface MirrorOptions {
  /** The copy's URL. */
  target: string;
  /** At least two sizes; the widest is driven first. */
  viewports: Viewport[];
  /** Notes the page reports (a step a size could not repeat, a page wider than its size), one per line. */
  notes?: string;
  port?: number;
}

export interface Mirror {
  url: string;
  close(): Promise<void>;
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

/** Starts the proxy and mirror page; resolves once it listens. */
export async function startMirror(o: MirrorOptions): Promise<Mirror> {
  const target = new URL(o.target);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`the copy's URL is not http(s): ${o.target}`);
  if (o.viewports.length < 2) throw new Error("the mirror needs at least two screen sizes");
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  let origin = "";

  const upstreamHeaders = (h: IncomingHttpHeaders): IncomingHttpHeaders => {
    const out: IncomingHttpHeaders = {};
    for (const [k, v] of Object.entries(h)) if (!HOP.has(k) && v !== undefined) out[k] = v;
    // The copy sees its own address, as if the browser talked to it directly: its host checks and CSRF
    // checks (Origin against Host) pass.
    out.host = target.host;
    for (const k of ["origin", "referer"] as const) {
      const v = out[k];
      if (typeof v === "string" && v.startsWith(origin)) out[k] = target.origin + v.slice(origin.length);
    }
    return out;
  };

  const downstreamHeaders = (h: IncomingHttpHeaders): Record<string, string | string[]> => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(h)) {
      if (HOP.has(k) || v === undefined || k === "x-frame-options") continue;
      if (k === "content-security-policy" || k === "content-security-policy-report-only") {
        const kept = String(v)
          .split(";")
          .map((d) => d.trim())
          .filter((d) => d && !/^(frame-ancestors|upgrade-insecure-requests)\b/i.test(d))
          .join("; ");
        if (kept) out[k] = kept;
        continue;
      }
      if (k === "location" && typeof v === "string") {
        out[k] = v.startsWith(target.origin) ? origin + v.slice(target.origin.length) : v;
        continue;
      }
      if (k === "set-cookie") {
        // The mirror's own host and plain http: a cookie for the copy's domain, or one marked Secure, would be dropped.
        out[k] = (Array.isArray(v) ? v : [v]).map((c) =>
          c
            .replace(/;\s*domain=[^;]*/gi, "")
            .replace(/;\s*secure(?=;|$)/gi, "")
            .replace(/;\s*samesite=none/gi, "; SameSite=Lax"),
        );
        continue;
      }
      out[k] = v;
    }
    return out;
  };

  /** Links in an HTML page that name the copy's own address stay in the mirror. */
  const rewriteHtml = (body: Buffer, encoding: string | undefined): Buffer | null => {
    let raw: Buffer;
    try {
      raw = !encoding || encoding === "identity" ? body : encoding === "gzip" ? gunzipSync(body) : encoding === "br" ? brotliDecompressSync(body) : encoding === "deflate" ? inflateSync(body) : body;
    } catch {
      return null;
    }
    if (encoding && !["identity", "gzip", "br", "deflate"].includes(encoding)) return null;
    return Buffer.from(raw.toString("utf8").split(target.origin).join(origin), "utf8");
  };

  const page = (path: string): string => mirrorPage({ viewports: o.viewports, path, note: NOTE_PATH });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url === MIRROR_PATH || url.startsWith(`${MIRROR_PATH}?`)) {
      const path = new URL(url, origin).searchParams.get("path") ?? target.pathname + target.search + target.hash;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page(path.startsWith("/") ? path : "/"));
      return;
    }
    if (url === NOTE_PATH && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8").replace(/\s+/g, " ").trim().slice(0, 500);
        if (text && o.notes) appendFileSync(o.notes, `${new Date().toISOString()} ${text}\n`);
        res.writeHead(204).end();
      });
      return;
    }
    // A page opened in the browser's tab, not in one of the mirror's frames: show it mirrored.
    if (req.method === "GET" && req.headers["sec-fetch-dest"] === "document") {
      res.writeHead(302, { location: `${MIRROR_PATH}?path=${encodeURIComponent(url)}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    const up = send(
      { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: url, headers: upstreamHeaders(req.headers), rejectUnauthorized: false },
      (r) => {
        const headers = downstreamHeaders(r.headers);
        if (/^text\/html/i.test(String(r.headers["content-type"] ?? "")) && req.method !== "HEAD") {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => {
            const body = Buffer.concat(chunks);
            const html = rewriteHtml(body, r.headers["content-encoding"]?.toLowerCase());
            if (html) {
              delete headers["content-encoding"];
              headers["content-length"] = String(html.length);
            }
            res.writeHead(r.statusCode ?? 502, headers);
            res.end(html ?? body);
          });
          r.on("error", () => res.destroy());
          return;
        }
        res.writeHead(r.statusCode ?? 502, headers);
        r.pipe(res);
      },
    );
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`gespann mirror: the copy at ${target.origin} did not answer (${e.message})`);
    });
    req.pipe(up);
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const headers = upstreamHeaders(req.headers);
    headers.connection = "Upgrade";
    headers.upgrade = req.headers.upgrade ?? "websocket";
    const up = send({ protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers, rejectUnauthorized: false });
    up.on("upgrade", (r, upSocket: Socket, upHead: Buffer) => {
      const lines = [`HTTP/1.1 ${r.statusCode ?? 101} ${r.statusMessage ?? "Switching Protocols"}`];
      for (let i = 0; i < r.rawHeaders.length; i += 2) lines.push(`${r.rawHeaders[i]}: ${r.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      const end = () => {
        socket.destroy();
        upSocket.destroy();
      };
      socket.on("error", end);
      upSocket.on("error", end);
    });
    up.on("response", (r) => {
      socket.end(`HTTP/1.1 ${r.statusCode ?? 502} ${r.statusMessage ?? ""}\r\n\r\n`);
    });
    up.on("error", () => socket.destroy());
    up.end();
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(o.port ?? 0, "127.0.0.1", () => ok());
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}${MIRROR_PATH}`,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The mirror page: the bar, one frame per size, and the script that repeats steps between them. */
export function mirrorPage(c: { viewports: Viewport[]; path: string; note: string }): string {
  const config = JSON.stringify({ viewports: c.viewports, path: c.path, note: c.note, layout: LAYOUT }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>gespann mirror · ${escapeHtml(c.viewports.map((v) => v.name).join(", "))}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#1f2023;color:#e8e8ea;font:13px/1.4 system-ui,sans-serif;overflow:hidden}
#bar{position:fixed;left:0;right:0;top:0;height:${LAYOUT.bar}px;padding:8px ${LAYOUT.pad}px;border-bottom:1px solid #34353a;display:flex;gap:16px;align-items:flex-start}
#bar h1{font-size:13px;margin:4px 0 0;white-space:nowrap}
#bar .group{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
#bar button{font:inherit;color:inherit;background:#2c2d31;border:1px solid #45464c;border-radius:6px;padding:3px 9px;cursor:pointer}
#bar button[aria-pressed=true]{background:#e8e8ea;color:#1f2023;border-color:#e8e8ea}
#notes{flex:1;margin:0;padding:0;list-style:none;height:${LAYOUT.bar - 16}px;overflow:auto;font-size:12px;color:#c9c9ce}
#notes li.warn{color:#ffb86b}
.frame{position:absolute}
.frame .label{height:${LAYOUT.label}px;display:flex;gap:8px;align-items:center;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.frame .label b{font-weight:600}
.frame .label .drive{color:#7ee0a1}
.frame .label .warn{color:#ffb86b}
.frame .box{position:relative;overflow:hidden;background:#fff;outline:1px solid #45464c}
.frame.leader .box{outline:2px solid #7ee0a1}
</style>
</head>
<body>
<div id="bar">
  <h1>gespann mirror</h1>
  <div class="group" role="group" aria-label="Drive this size"><span>Drive:</span><span id="drive"></span></div>
  <div class="group"><button id="mirroring" type="button" aria-pressed="true">Repeat steps in all sizes: on</button></div>
  <ul id="notes" role="log" aria-label="Mirror notes"></ul>
</div>
<div id="stage"></div>
<script type="application/json" id="gespann-config">${config}</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}

/** Runs in the mirror page. Plain JavaScript in a string: it never runs in Node. */
const CLIENT = String.raw`
(function () {
  "use strict";
  var cfg = JSON.parse(document.getElementById("gespann-config").textContent);
  var L = cfg.layout;
  var frames = [];
  var notes = [];
  var mirroring = true;
  var widest = cfg.viewports.reduce(function (a, v) { return v.width > a.width ? v : a; }, cfg.viewports[0]);
  var leader = widest.id;
  var lastClick = { at: 0, el: null };

  function shelf(scale, maxWidth) {
    var x = 0, y = 0, row = 0, width = 0, at = [];
    cfg.viewports.forEach(function (v) {
      var w = v.width * scale;
      if (x > 0 && x + w > maxWidth) { x = 0; y += row + L.gap; row = 0; }
      at.push({ x: x, y: y });
      width = Math.max(width, x + w);
      x += w + L.gap;
      row = Math.max(row, v.height * scale + L.label);
    });
    return { width: width, height: y + row, at: at };
  }

  function layout() {
    var W = window.innerWidth - 2 * L.pad, H = window.innerHeight - L.bar - 2 * L.pad;
    var lo = 0.05, hi = 1;
    var fits = function (s) { var r = shelf(s, W); return r.width <= W + 0.5 && r.height <= H + 0.5; };
    if (fits(1)) lo = 1; else for (var i = 0; i < 24; i++) { var m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
    var r = shelf(lo, W);
    frames.forEach(function (f, i) {
      f.wrap.style.left = L.pad + r.at[i].x + "px";
      f.wrap.style.top = L.bar + L.pad + r.at[i].y + "px";
      f.box.style.width = f.v.width * lo + "px";
      f.labelEl.style.width = f.v.width * lo + "px";
      f.box.style.height = f.v.height * lo + "px";
      f.el.style.transform = "scale(" + lo + ")";
    });
  }

  function sizeName(f) { return f.v.name + " " + f.v.width + "x" + f.v.height; }

  function note(f, text, warn) {
    var line = sizeName(f) + ": " + text;
    notes.unshift({ text: line, warn: !!warn });
    if (notes.length > 50) notes.pop();
    var ul = document.getElementById("notes");
    var li = document.createElement("li");
    li.textContent = line;
    if (warn) li.className = "warn";
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 50) ul.removeChild(ul.lastChild);
    try { fetch(cfg.note, { method: "POST", body: line, keepalive: true }); } catch (e) { /* the log file is optional */ }
  }

  function label(f) {
    var parts = ["<b>" + f.v.name + "</b> " + f.v.width + "x" + f.v.height];
    if (f.v.id === leader) parts.push('<span class="drive">you drive this size</span>');
    if (f.foreign) parts.push('<span class="warn">left the copy: ' + f.foreign + "</span>");
    else if (f.overflow) parts.push('<span class="warn">page is ' + f.overflow + " px wide: scrolls sideways</span>");
    f.labelEl.innerHTML = parts.join(" · ");
  }

  function setLeader(id) {
    leader = id;
    frames.forEach(function (f) {
      var on = f.v.id === id;
      f.wrap.className = on ? "frame leader" : "frame";
      place(f, on);
      f.button.setAttribute("aria-pressed", on ? "true" : "false");
      label(f);
    });
  }

  // Only the driven size is visible to the tester's browser tool, so its page snapshot holds the app
  // once and its clicks land there: the other sizes sit in a closed shadow root, which page scripts
  // (the tool's included) cannot enter. moveBefore keeps a frame's page when it moves; without it the
  // frame reloads at its current address.
  function place(f, driven) {
    var to = driven ? f.box : f.shadow;
    if (f.el.parentNode === to) return;
    if (to.moveBefore && f.el.isConnected) { to.moveBefore(f.el, null); return; }
    var at = f.el.isConnected && here(f);
    to.appendChild(f.el);
    if (at) { f.ready = false; f.el.src = at; }
  }

  function lead() { return frames.filter(function (f) { return f.v.id === leader; })[0]; }
  function followers() { return frames.filter(function (f) { return f.v.id !== leader; }); }

  // ---- finding the same element in another size

  var ACTIONABLE = "a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[tabindex]";

  function actionable(el) {
    if (!el || el.nodeType !== 1) el = el && el.parentElement;
    return (el && el.closest(ACTIONABLE)) || el;
  }

  function norm(s) { return (s || "").replace(/\s+/g, " ").trim().slice(0, 120); }

  // What an element says, never what was typed into it: notes and screenshots must not show a password.
  function says(el) {
    if (el.tagName === "INPUT") return /^(button|submit|reset)$/i.test(el.type) ? norm(el.value) : "";
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return "";
    return norm(el.innerText);
  }

  function describe(el) {
    var path = [];
    for (var n = el; n && n.parentElement && n.tagName !== "BODY"; n = n.parentElement) {
      var i = 0;
      for (var s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      path.unshift([n.tagName, i]);
    }
    return {
      tag: el.tagName,
      path: path,
      id: el.id || "",
      testid: testid(el),
      name: el.getAttribute("name") || "",
      type: el.tagName === "INPUT" ? el.type : el.getAttribute("type") || "",
      href: el.getAttribute("href") || "",
      role: el.getAttribute("role") || "",
      aria: el.getAttribute("aria-label") || "",
      placeholder: el.getAttribute("placeholder") || "",
      text: says(el),
    };
  }

  function shown(el, win) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.right <= 0 || r.left >= win.innerWidth) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    return true;
  }

  function testid(el) { return el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-cy") || ""; }

  // How well an element matches a description; -1 when it is another field (another type, name or test id).
  // A differing DOM id alone does not count: frameworks generate them.
  function same(el, d) {
    if (el.tagName !== d.tag) return -1;
    if ((el.tagName === "INPUT" ? el.type : el.getAttribute("type") || "") !== d.type) return -1;
    if (d.name && el.getAttribute("name") && el.getAttribute("name") !== d.name) return -1;
    if (d.testid && testid(el) && testid(el) !== d.testid) return -1;
    var score = 0;
    if (d.testid && testid(el) === d.testid) score += 8;
    if (d.id && el.id === d.id) score += 6;
    if (d.href && el.getAttribute("href") === d.href) score += 4;
    if (d.name && el.getAttribute("name") === d.name) score += 4;
    if (d.aria && el.getAttribute("aria-label") === d.aria) score += 3;
    if (d.placeholder && el.getAttribute("placeholder") === d.placeholder) score += 3;
    if (d.role && el.getAttribute("role") === d.role) score += 1;
    if (d.text && says(el) === d.text) score += 3;
    return score;
  }

  function byPath(doc, d) {
    var n = doc.body;
    for (var i = 0; n && i < d.path.length; i++) {
      var tag = d.path[i][0], k = d.path[i][1], hit = null;
      for (var c = n.firstElementChild; c; c = c.nextElementSibling) if (c.tagName === tag && k-- === 0) { hit = c; break; }
      n = hit;
    }
    return n;
  }

  // The element in another size: the same place in the page when it is visible there and still looks
  // the same, else the visible element of that kind that matches best (the same link in the mobile menu).
  function find(f, d) {
    var doc = f.el.contentDocument, win = f.el.contentWindow;
    var p = byPath(doc, d);
    if (p && shown(p, win) && same(p, d) >= 0 && (!d.text || same(p, d) >= 3 || !says(p))) return { el: p };
    var best = null, top = 0, hidden = false;
    var all = doc.getElementsByTagName(d.tag);
    for (var i = 0; i < all.length; i++) {
      var s = same(all[i], d);
      if (s <= 0) continue;
      if (!shown(all[i], win)) { if (s >= 3) hidden = true; continue; }
      if (s > top) { top = s; best = all[i]; }
    }
    if (best && top >= 3) return { el: best };
    return { el: null, hidden: hidden || !!(p && p.tagName === d.tag) };
  }

  function what(d) {
    var name = d.aria || d.text || d.placeholder || d.name || d.href || d.id || "";
    var kind = d.role || (d.tag === "A" ? "link" : d.tag === "INPUT" ? (d.type || "text") + " field" : d.tag.toLowerCase());
    return kind + (name ? ' "' + name.slice(0, 60) + '"' : "");
  }

  function miss(f, d, r, step) {
    note(f, "could not " + step + " the " + what(d) + (r.hidden ? ": it is not visible at this size (behind a menu, collapsed or off screen)" : ": not on this page at this size"), true);
  }

  // ---- repeating a step

  function each(fn, quiet) {
    if (!mirroring) return;
    followers().forEach(function (f) {
      if (f.foreign) return;
      if (!f.ready) { if (!quiet) note(f, "missed a step while its page was loading; do it there again if the check needs it", true); return; }
      try { fn(f); } catch (e) { note(f, "could not repeat the step: " + (e && e.message), true); }
    });
  }

  function click(f, d) {
    var r = find(f, d);
    if (!r.el) return miss(f, d, r, "click");
    var w = f.el.contentWindow, el = r.el, b = el.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, composed: true, view: w, button: 0, buttons: 1, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
    var p = Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, o);
    if (w.PointerEvent) el.dispatchEvent(new w.PointerEvent("pointerdown", p));
    el.dispatchEvent(new w.MouseEvent("mousedown", o));
    o.buttons = 0; p.buttons = 0;
    if (w.PointerEvent) el.dispatchEvent(new w.PointerEvent("pointerup", p));
    el.dispatchEvent(new w.MouseEvent("mouseup", o));
    el.click();
    f.acted = Date.now();
  }

  function setValue(f, d, src, kind) {
    var r = find(f, d);
    if (!r.el) return miss(f, d, r, "fill in");
    var w = f.el.contentWindow, el = r.el;
    if (el.isContentEditable) { el.innerHTML = src.innerHTML; }
    else if (el.tagName === "SELECT") {
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i], s = src.options[i];
        o.selected = s ? s.selected : false;
      }
    } else if (el.type === "file") {
      var dt = new w.DataTransfer();
      for (var j = 0; j < src.files.length; j++) dt.items.add(src.files[j]);
      el.files = dt.files;
    } else if (el.type !== "checkbox" && el.type !== "radio") {
      var proto = el.tagName === "TEXTAREA" ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, src.value);
    }
    el.dispatchEvent(new w.Event(kind, { bubbles: true }));
    f.acted = Date.now();
  }

  function key(f, d, e) {
    var w = f.el.contentWindow, doc = f.el.contentDocument;
    var el = d ? find(f, d).el : null;
    el = el || doc.activeElement || doc.body;
    var o = { key: e.key, code: e.code, keyCode: e.keyCode, which: e.keyCode, bubbles: true, cancelable: true, composed: true, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey };
    el.dispatchEvent(new w.KeyboardEvent("keydown", o));
    el.dispatchEvent(new w.KeyboardEvent("keyup", o));
    f.acted = Date.now();
  }

  function submit(f, d) {
    var r = find(f, d);
    if (!r.el) return miss(f, d, r, "submit");
    r.el.requestSubmit ? r.el.requestSubmit() : r.el.submit();
    f.acted = Date.now();
  }

  var KEYS = { Enter: 1, Escape: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1 };
  var scrollTimer = 0;

  // ---- each frame

  function here(f) {
    try { var l = f.el.contentWindow.location; return l.pathname + l.search + l.hash; } catch (e) { return null; }
  }

  function attach(f) {
    var doc, win;
    try { doc = f.el.contentDocument; win = f.el.contentWindow; void doc.body; } catch (e) { doc = null; }
    if (!doc || !doc.body) {
      f.foreign = "another site";
      f.ready = false;
      label(f);
      note(f, "left the copy for another site; the mirror cannot repeat steps there. Go back, or open that page in its own tab.", true);
      return;
    }
    f.foreign = "";
    f.ready = true;
    f.loading = false;
    f.url = here(f);
    f.changed = Date.now();
    win.addEventListener("pagehide", function () { f.loading = true; f.ready = false; });
    ["pushState", "replaceState"].forEach(function (m) {
      var orig = win.history[m];
      win.history[m] = function () { var r = orig.apply(this, arguments); moved(f); return r; };
    });
    win.addEventListener("popstate", function () { moved(f); });
    win.addEventListener("hashchange", function () { moved(f); });

    var mine = function () { return mirroring && f.v.id === leader; };
    doc.addEventListener("click", function (e) {
      if (!mine() || !e.isTrusted) return;
      var t = actionable(e.target);
      if (!t) return;
      // A click on a label also clicks its control: the label's click, repeated, does that in the other sizes too.
      if (lastClick.el && lastClick.el.tagName === "LABEL" && lastClick.el.control === t && Date.now() - lastClick.at < 100) {
        lastClick.el = t;
        return;
      }
      lastClick = { at: Date.now(), el: t };
      var d = describe(t);
      setTimeout(function () { each(function (g) { click(g, d); }); }, 0);
    }, true);
    ["input", "change"].forEach(function (kind) {
      doc.addEventListener(kind, function (e) {
        if (!mine()) return;
        var t = e.target;
        if (!t || t.nodeType !== 1 || t.type === "checkbox" || t.type === "radio") return;
        if (!t.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        var d = describe(t);
        setTimeout(function () { each(function (g) { setValue(g, d, t, kind); }); }, 0);
      }, true);
    });
    doc.addEventListener("submit", function (e) {
      if (!mine()) return;
      // A click on the submit button (or Enter, which clicks it) already submits the other sizes.
      if (e.submitter && Date.now() - lastClick.at < 1500 && lastClick.el && (lastClick.el === e.submitter || lastClick.el.contains(e.submitter))) return;
      var d = describe(e.target);
      setTimeout(function () { each(function (g) { submit(g, d); }); }, 0);
    }, true);
    doc.addEventListener("keydown", function (e) {
      if (!mine() || !e.isTrusted || !KEYS[e.key]) return;
      var t = e.target && e.target.nodeType === 1 && e.target !== doc.body ? describe(e.target) : null;
      var copy = { key: e.key, code: e.code, keyCode: e.keyCode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey };
      setTimeout(function () { each(function (g) { key(g, t, copy); }); }, 0);
    }, true);
    win.addEventListener("scroll", function () {
      if (!mine() || scrollTimer) return;
      scrollTimer = setTimeout(function () {
        scrollTimer = 0;
        var se = doc.scrollingElement || doc.documentElement;
        var max = se.scrollHeight - win.innerHeight;
        var ratio = max > 0 ? win.scrollY / max : 0;
        each(function (g) {
          var gw = g.el.contentWindow, gs = g.el.contentDocument.scrollingElement || g.el.contentDocument.documentElement;
          gw.scrollTo(gw.scrollX, ratio * Math.max(0, gs.scrollHeight - gw.innerHeight));
        }, true);
      }, 120);
    }, { passive: true });
    label(f);
    measure(f);
  }

  function moved(f) {
    var u = here(f);
    if (u !== f.url) { f.url = u; f.changed = Date.now(); }
  }

  function measure(f) {
    if (!f.ready) return;
    try {
      var doc = f.el.contentDocument, se = doc.scrollingElement || doc.documentElement;
      var wide = se.scrollWidth > f.el.contentWindow.innerWidth + 1 ? se.scrollWidth : 0;
      if (wide && wide !== f.overflow) note(f, "the page at " + f.url + " is " + wide + " px wide and scrolls sideways", true);
      if (wide !== f.overflow) { f.overflow = wide; label(f); }
    } catch (e) { /* left the copy */ }
  }

  // The other sizes follow the driven one to its page when a step did not take them there, e.g. when
  // the link sits behind a menu at their size.
  setInterval(function () {
    frames.forEach(function (f) { if (f.ready) moved(f); measure(f); });
    var l = lead();
    if (!mirroring || !l || !l.ready || l.foreign || Date.now() - l.changed < 1500) return;
    followers().forEach(function (f) {
      if (f.loading || f.url === l.url || Date.now() - (f.acted || 0) < 2000) return;
      // Once per page change of the driven size: a size the copy sends elsewhere (a mobile page) stays there.
      var key = l.url + "@" + l.changed;
      if (f.synced === key) return;
      f.synced = key;
      note(f, "followed to " + l.url);
      f.loading = true;
      f.ready = false;
      if (f.foreign) f.el.src = l.url; else f.el.contentWindow.location.assign(l.url);
    });
  }, 700);

  // ---- the page

  var stage = document.getElementById("stage"), drive = document.getElementById("drive");
  cfg.viewports.forEach(function (v) {
    var wrap = document.createElement("div"), lab = document.createElement("div"), box = document.createElement("div"), el = document.createElement("iframe");
    wrap.className = "frame"; lab.className = "label"; box.className = "box";
    el.title = v.name + " " + v.width + "x" + v.height;
    el.width = v.width; el.height = v.height;
    el.style.cssText = "border:0;display:block;background:#fff;transform-origin:0 0;width:" + v.width + "px;height:" + v.height + "px";
    var shadow = box.attachShadow({ mode: "closed" });
    shadow.appendChild(document.createElement("slot"));
    wrap.appendChild(lab); wrap.appendChild(box); stage.appendChild(wrap);
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = v.name;
    button.addEventListener("click", function () { setLeader(v.id); });
    drive.appendChild(button);
    var f = { v: v, wrap: wrap, labelEl: lab, box: box, shadow: shadow, el: el, button: button, ready: false, overflow: 0, foreign: "" };
    frames.push(f);
    el.addEventListener("load", function () { attach(f); });
  });
  document.getElementById("mirroring").addEventListener("click", function (e) {
    mirroring = !mirroring;
    e.currentTarget.setAttribute("aria-pressed", mirroring ? "true" : "false");
    e.currentTarget.textContent = "Repeat steps in all sizes: " + (mirroring ? "on" : "off");
  });
  setLeader(leader);
  layout();
  window.addEventListener("resize", layout);
  frames.forEach(function (f) { f.el.src = cfg.path; });
  window.gespannMirror = { notes: notes, frames: frames, setLeader: setLeader };
})();
`;

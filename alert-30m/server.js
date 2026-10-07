// alert-30m 프록시 겸 정적 서버 — 실행: node server.js → http://localhost:8082/alert-30m/
// (PC 서버와 포트 충돌 방지: 8080은 PC앱 전용, 모바일은 8082 또는 PC서버의 /alert-30m/ 경로)
const http = require("http");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".wav": "audio/wav" };
const MONITOR_FLAG = "C:\\Users\\yhko7\\buy-monitor\\enabled.txt";
function monitorEnabled() {
  try { const v = fs.readFileSync(MONITOR_FLAG, "utf-8").trim().toUpperCase(); return !["0", "OFF", "DISABLED", "NO"].includes(v); }
  catch (_) { return true; }
}
function readBody(req) {
  return new Promise((resolve) => { let s = ""; req.on("data", c => s += c); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (_) { resolve({}); } }); });
}
http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, authorization, api-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  try {
    if (req.url.startsWith("/yahoo-api") && req.method === "GET") {
      const u = new URL(req.url, "http://localhost");
      const target = u.searchParams.get("url") || "";
      if (!/^https:\/\/query[12]\.finance\.yahoo\.com\//.test(target)) { res.writeHead(400); res.end("bad url"); return; }
      const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0" } });
      const t = await r.text();
      res.writeHead(r.status, { "Content-Type": "application/json" }); res.end(t); return;
    }
    if (req.url === "/monitor-status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ enabled: monitorEnabled() })); return;
    }
    if (req.url === "/monitor-toggle" && req.method === "POST") {
      const b = await readBody(req);
      const enabled = typeof b.enabled === "boolean" ? b.enabled : !monitorEnabled();
      try { fs.writeFileSync(MONITOR_FLAG, enabled ? "ON" : "OFF", "utf-8"); }
      catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e) })); return; }
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ enabled })); return;
    }
    let f = req.url.split("?")[0];
    if (f === "/") f = "/alert-30m/index.html";
    const fp = path.join(path.dirname(ROOT), decodeURIComponent(f));
    const data = fs.readFileSync(fp);
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch (_) { res.writeHead(404); res.end("not found"); }
}).listen(8082, () => console.log("HTTP http://localhost:8082/alert-30m/"));

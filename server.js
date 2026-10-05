// 통합 서버 — 정적파일 + 시뮬 WS + 키움 프록시(CORS 회피용)
// 실행: npm i ws  →  node server.js  →  http://localhost:8080
// 키움키를 프론트에 직접 넣기 싫으면 환경변수로: KIWOOM_APPKEY / KIWOOM_SECRET / KIWOOM_MOCK=1
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const HTTP_PORT = 8080, WS_PORT = 8081;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".wav": "audio/wav" };

// ---- 정적 파일 ----
http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, authorization, api-id");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  try {
    if (req.url === "/kiwoom-token" && req.method === "POST") return await handleToken(req, res);
    if (req.url === "/kiwoom-api" && req.method === "POST") return await handleApi(req, res);
    if (req.url.startsWith("/yahoo-chart") && req.method === "GET") return await handleYahoo(req, res);
    let f = req.url.split("?")[0];
    if (f === "/") f = "/index.html";
    const fp = path.join(__dirname, decodeURIComponent(f));
    if (!fp.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
    const data = fs.readFileSync(fp);
    res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    res.end(data);
  } catch (_) { res.writeHead(404); res.end("not found"); }
}).listen(HTTP_PORT, () => console.log(`HTTP http://localhost:${HTTP_PORT}`));

function readBody(req) {
  return new Promise((resolve) => { let s = ""; req.on("data", c => s += c); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (_) { resolve({}); } }); });
}
function kiwoomBase(mock) { return mock ? "https://mockapi.kiwoom.com" : "https://api.kiwoom.com"; }
async function handleToken(req, res) {
  const b = await readBody(req);
  const appkey = b.appkey || process.env.KIWOOM_APPKEY;
  const secretkey = b.secretkey || process.env.KIWOOM_SECRET;
  const mock = b.mock ?? (process.env.KIWOOM_MOCK === "1");
  try {
    const r = await fetch(kiwoomBase(mock) + "/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey, secretkey }),
    });
    const j = await r.json();
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(j));
  } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e) })); }
}
async function handleApi(req, res) {
  const b = await readBody(req);
  const token = b.token; // 프론트가 토큰을 갖고 있으면 전달, 없으면 서버 키로 발급 시도
  try {
    let t = token;
    if (!t) {
      const r = await fetch(kiwoomBase(b.mock) + "/oauth2/token", {
        method: "POST", headers: { "Content-Type": "application/json;charset=UTF-8" },
        body: JSON.stringify({ grant_type: "client_credentials", appkey: process.env.KIWOOM_APPKEY, secretkey: process.env.KIWOOM_SECRET }),
      });
      const j = await r.json(); t = j.token;
    }
    const apiPath = (typeof b.path === "string" && b.path.startsWith("/api/")) ? b.path : "/api/dostk/chart";
    const r = await fetch(kiwoomBase(b.mock) + apiPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8", authorization: "Bearer " + t, "api-id": b.apiId,
        ...(b.contYn === "Y" ? { "cont-yn": "Y", "next-key": b.nextKey || "" } : {}),
      },
      body: JSON.stringify(b.body),
    });
    const j = await r.json();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "cont-yn": r.headers.get("cont-yn") || "N",
      "next-key": r.headers.get("next-key") || "",
      "Access-Control-Expose-Headers": "cont-yn, next-key",
    });
    res.end(JSON.stringify(j));
  } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(e) })); }
}

// ---- 야후 파이낸스 프록시 (지수용: 브라우저 CORS 회피) ----
async function handleYahoo(req, res) {
  const u = new URL(req.url, "http://x");
  const symbol = u.searchParams.get("symbol") || "^KS11";
  const interval = u.searchParams.get("interval") || "1m";
  const range = u.searchParams.get("range") || "1d";
  const qs = `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
  let lastErr = null;
  for (const h of hosts) {
    try {
      const r = await fetch(h + "/v8/finance/chart/" + encodeURIComponent(symbol) + qs, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      const j = await r.json();
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(j));
      return;
    } catch (e) { lastErr = e; }
  }
  res.writeHead(500, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "야후 조회 실패: " + String(lastErr) }));
}

// ---- 시뮬 WS (키움 없을 때) ----
const wss = new WebSocketServer({ port: WS_PORT });
const spot = { "BTC/KRW": 97200000, "ETH/KRW": 5120000, "SOL/KRW": 248000, "XRP/KRW": 890 };
const vol = { "BTC/KRW": 0.0009, "ETH/KRW": 0.0012, "SOL/KRW": 0.0016, "XRP/KRW": 0.0014 };
function randn() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
console.log(`WS sim on ws://localhost:${WS_PORT}`);
setInterval(() => {
  for (const sym of Object.keys(spot)) {
    spot[sym] = Math.max(1, spot[sym] + randn() * vol[sym] * spot[sym] * 0.35);
    const msg = JSON.stringify({ symbol: sym, price: spot[sym], time: Date.now(), volume: Math.round(Math.abs(randn()) * 8 + 1) });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
  }
}, 250);

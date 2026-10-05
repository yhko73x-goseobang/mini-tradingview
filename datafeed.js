/* Datafeed — TradingView식 getBars/subscribeBars + 키움증권 REST/WS 어댑터
 *
 * 키움 REST (공식):
 *  REST 실전 https://api.kiwoom.com / 모의 https://mockapi.kiwoom.com
 *  WS   실전 wss://api.kiwoom.com:10000 / 모의 wss://mockapi.kiwoom.com:10000, 경로 /api/dostk/websocket
 *  1) POST {base}/oauth2/token {grant_type:"client_credentials", appkey, secretkey} → {token}
 *  2) 차트: POST {base}/api/dostk/chart, 헤더 api-id (ka10080 분봉 / ka10081 일봉 / ka10082 주봉 / ka10083 월봉 / ka10079 틱)
 *  3) 실시간: WS 접속 → {"trnm":"LOGIN","token"} → {"trnm":"REG","grp_no":"1","refresh":"1",
 *     "data":[{"item":["005930"],"type":["0B"]}]} → trnm REAL 수신, values["10"]=현재가, ["15"]=거래량
 *
 * 브라우저 CORS가 막히면 server.js 프록시(/kiwoom-token, /kiwoom-api)를 경유합니다.
 * 키 없이도 시뮬레이션 피드로 전부 동작합니다.
 */
(function (global) {
  const TF = { "1s": 1, "15s": 15, "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800, "1M": 2592000 };
  const MIN_VALID = ["1", "3", "5", "10", "15", "30", "45", "60"]; // 키움 분봉 tic_scope 허용값
  // 봉 경계 (주봉=월요일, 월봉=1일, 나머지는 epoch)
  function bucketTime(ms, tfSec) {
    if (tfSec === 604800) { const d = new Date(ms); const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); return d.getTime() - day * 86400000; }
    if (tfSec === 2592000) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
    return Math.floor(ms / 1000 / tfSec) * tfSec * 1000;
  }
  function resampleBars(bars, targetSec) {
    const out = []; let cur = null;
    for (const b of [...bars].sort((a, c) => a.time - c.time)) {
      const t = bucketTime(b.time * 1000, targetSec) / 1000;
      if (!cur || cur.time !== t) { if (cur) out.push(cur); cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }; }
      else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
    }
    if (cur) out.push(cur);
    return out;
  }
  // 기본 관심종목: 텔레그램 파일(국내 6자리 → 미국 티커 → 코인 순)
  const KR_CURATED = [
    ["102110","TIGER","코스피200"],["069500","KODEX","코스피200"],["148020","RISE","코스피200"],
    ["395270","HANARO","반도체"],["396500","TIGER","반도체"],
    ["476260","HANARO 반도체핵심공정주도주","소부장"],["471990","KODEX AI반도체핵심장비","소부장"],["471760","TIGER AI 반도체핵심공정","소부장"],["482030","KoAct 반도체&2차전지핵심소재액티브","소부장"],
    ["232080","TIGER 코스닥150","코스닥"],["261060","TIGER 코스닥150IT","코스닥"],
    ["123310","TIGER 인버스","인버스"],["114800","KODEX 인버스","인버스"],
    ["337140","KODEX 대형주","대형주"],["277640","TIGER 대형주","대형주"],
    ["448300","나스닥100(H)","나스닥100(H)"],["449190","나스닥100(H)","나스닥100(H)"],["453080","나스닥100(H)","나스닥100(H)"],
    ["448290","S&P500(H)","S&P500(H)"],["449180","S&P500(H)","S&P500(H)"],
    ["466920","조선 S","조선"],["228790","TIGER 화장품","화장품"],["449450","방산","방산"],
    ["161510","PLUS 고배당","고배당"],["004380","TIGER 머니마켓액티브","채권혼합"],["458730","TIGER 미국배당다우존스","미국배당"],
  ];
  const US_TICKERS = ["NVDA","AAPL","MSFT","AMZN","GOOGL","GOOG","META","AVGO","TSLA","MU","LLY","JPM","WMT","AMD","BRK-B","V","XOM","JNJ","INTC","MA","ABBV","CSCO","ORCL","CVX","PLTR","BAC","COST","KO","CAT","DELL","MRK","PG","LRCX","UNH","AMAT","GE","MS","NFLX","PANW","HD","PM","GS","WFC","RTX","ANET","CRWD","GEV","TXN","TMO","IBM","C","SNDK","KLAC","AXP","VZ","MRVL","CRM","AMGN","QCOM","APH","PEP","PFE","ABT","MCD","DIS","INTU","NOW","CMCSA","TMUS","BKNG","SBUX","GILD","NKE","BLK","CCEP","UNP","LOW","COP","VRTX","ADBE","SHOP","PYPL","DDOG","ABNB","DASH","APP","CEG","LIN","ADI","HON","WDC","STX","MDT","SNOW","WDAY","SNPS","CDNS","REGN","MDLZ","ISRG","MCHP"];
  const DEFAULT_SYMBOLS = [
    { id: "KOSPI", name: "KOSPI", base: 3200, vol: 0.002, grp: "지수" },
    { id: "KOSPI200", name: "KOSPI200", base: 430, vol: 0.002, grp: "지수" },
    { id: "KOSDAQ", name: "KOSDAQ", base: 800, vol: 0.003, grp: "지수" },
    { id: "US100", name: "US100 나스닥100", base: 25000, vol: 0.003, grp: "지수" },
    { id: "IXIC", name: "IXIC 나스닥종합", base: 22000, vol: 0.003, grp: "지수" },
    ...KR_CURATED.map(([id, name, grp]) => ({ id, name, base: 50000, vol: 0.002, grp })),
    { id: "BTC/KRW", name: "BTC/KRW", base: 97200000, vol: 0.0009, grp: "코인" },
    { id: "ETH/KRW", name: "ETH/KRW", base: 5120000, vol: 0.0012, grp: "코인" },
    { id: "SOL/KRW", name: "SOL/KRW", base: 248000, vol: 0.0016, grp: "코인" },
    { id: "XRP/KRW", name: "XRP/KRW", base: 890, vol: 0.0014, grp: "코인" },
  ];
  const isKiwoomCode = (s) => /^\d{6}$/.test(String(s || "").trim());

  // 지수/미국주식 심볼 해석 (차트+실시간 라우팅용)
  const INDEX_MAP = { KOSPI: "001", KOSPI200: "201", KOSDAQ: "101" };
  // 야후 파이낸스 매핑 (모의투자는 KRX만 지원 → 미국 지수용 + 국내 지수 폴백)
  const YAHOO_MAP = { KOSPI: "^KS11", KOSPI200: "^KS200", KOSDAQ: "^KQ11", US100: "^NDX", IXIC: "^IXIC" };
  function yahooTF(tfSec) {
    if (tfSec <= 60) return { interval: "1m", range: "1mo" };
    if (tfSec <= 300) return { interval: "5m", range: "3mo" };
    if (tfSec <= 900) return { interval: "15m", range: "6mo" };
    if (tfSec <= 1800) return { interval: "30m", range: "1mo" };
    if (tfSec <= 3600) return { interval: "60m", range: "1y" };
    if (tfSec <= 14400) return { interval: "60m", range: "3mo" }; // 4h는 60m 받아서 리샘플
    if (tfSec <= 604800) return { interval: "1wk", range: "5y" };
    return { interval: "1mo", range: "5y" };
  }
  const US_EXCHANGES = ["ND", "NY", "NA"]; // 미국 거래소 자동탐색 순서
  function resolveKiwoom(symbol) {
    if (INDEX_MAP[symbol]) return { kind: "index", code: INDEX_MAP[symbol] };
    if (symbol === "US100") return { kind: "us", stex_tp: "ND", stk_cd: "NDX" }; // 나스닥100 (=US100 CFD 기초지수)
    if (symbol === "IXIC") return { kind: "us", stex_tp: "ND", stk_cd: "IXIC" }; // 나스닥종합
    if (isKiwoomCode(symbol)) return { kind: "stock", code: symbol };
    if (/^[A-Z.\-^]+$/.test(symbol)) return { kind: "us", stex_tp: null, stk_cd: symbol };
    return null;
  }

  function randn() {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---------- 키움 클라이언트 ----------
  class KiwoomClient {
    constructor({ appkey, secretkey, mock }) {
      this.appkey = appkey; this.secretkey = secretkey; this.mock = !!mock;
      this.base = this.mock ? "https://mockapi.kiwoom.com" : "https://api.kiwoom.com";
      this.wsBase = this.mock ? "wss://mockapi.kiwoom.com:10000" : "wss://api.kiwoom.com:10000";
      this.token = null; this.ws = null; this.onTick = null; this.onStatus = null;
      this.regSet = new Set();
    }
    async getToken() {
      // 1차: 로컬 프록시 (CORS 회피, server.js 실행 시)
      const tries = [
        { url: "/kiwoom-token", body: { appkey: this.appkey, secretkey: this.secretkey, mock: this.mock } },
        { url: this.base + "/oauth2/token", body: { grant_type: "client_credentials", appkey: this.appkey, secretkey: this.secretkey } },
      ];
      let lastErr = null;
      for (const t of tries) {
        try {
          const r = await fetch(t.url, { method: "POST", headers: { "Content-Type": "application/json;charset=UTF-8" }, body: JSON.stringify(t.body) });
          const j = await r.json();
          if (j && (j.token || j.access_token)) {
            this.token = j.token || j.access_token;
            this.tokenVia = t.url.startsWith("/") ? "프록시" : "직접";
            this.step && this.step("token", "OK(" + this.tokenVia + ")");
            return this.token;
          }
          lastErr = new Error("[" + (j.return_code ?? "?") + "] " + (j.return_msg || j.message || ("HTTP " + r.status)));
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("토큰 발급 실패");
    }
    apiIdFor(tfSec) {
      if (tfSec === 604800) return "ka10082";  // 주봉
      if (tfSec === 2592000) return "ka10083"; // 월봉
      if (tfSec < 60) return "ka10079";       // 틱
      if (tfSec < 86400) return "ka10080";    // 분봉
      if (tfSec < 86400 * 7) return "ka10081";// 일봉
      if (tfSec < 86400 * 31) return "ka10082";// 주봉
      return "ka10083";                        // 월봉
    }
    async getChart(symbol, tfSec) {
      if (!this.token) await this.getToken();
      const r = resolveKiwoom(symbol);
      if (!r) throw new Error("지원하지 않는 심볼: " + symbol);
      if (r.kind === "us") return this.getUSChart(r, tfSec);
      if (r.kind === "index") return this.getIndexChart(r.code, tfSec);
      return this.getStockChart(r.code, tfSec);
    }
    async _postChart(path, apiId, body, extra) {
      extra = extra || {};
      const headers = {
        "Content-Type": "application/json;charset=UTF-8",
        authorization: "Bearer " + this.token,
        "api-id": apiId,
        ...extra,
      };
      // 프록시 우선 (프론트가 발급받은 토큰을 함께 전달)
      const tries = [
        { url: "/kiwoom-api", proxy: true },
        { url: this.base + path, proxy: false },
      ];
      let lastErr = null;
      for (const t of tries) {
        try {
          const payload = t.proxy
            ? { mock: this.mock, apiId, body, token: this.token, path, contYn: extra["cont-yn"] || "N", nextKey: extra["next-key"] || "" }
            : body;
          const hdrs = t.proxy ? { "Content-Type": "application/json" } : headers;
          const r = await fetch(t.url, { method: "POST", headers: hdrs, body: JSON.stringify(payload) });
          const j = await r.json();
          return { j, via: t.proxy ? "프록시" : "직접", contYn: r.headers.get("cont-yn"), nextKey: r.headers.get("next-key") };
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("차트 조회 실패");
    }
    async _parseBars(tfSec, path, apiId, body, maxBars) {
      maxBars = maxBars || 20000; // 참조 봉 최대 2만개 (연속조회)
      let all = [], via = "", contYn = "N", nextKey = "", guard = 0, lastJ = null;
      do {
        const extra = contYn === "Y" && nextKey ? { "cont-yn": "Y", "next-key": nextKey } : {};
        const r = await this._postChart(path, apiId, body, extra);
        via = r.via; lastJ = r.j;
        const bars = parseKiwoomChart(r.j, tfSec) || [];
        all = all.concat(bars);
        contYn = r.contYn; nextKey = r.nextKey;
        if (contYn === "Y" && nextKey) await new Promise(rr => setTimeout(rr, 150));
      } while (contYn === "Y" && nextKey && all.length < maxBars && ++guard < 30);
      const seen = new Map();
      all.forEach(b => seen.set(b.time, b));
      const out = [...seen.values()].sort((a, b) => a.time - b.time).slice(-maxBars);
      if (out.length) {
        this.step && this.step("chart", "OK " + out.length + "개(" + via + "," + apiId + ")");
        return out;
      }
      const j = lastJ || {};
      throw new Error("[" + (j.return_code ?? "?") + "] " + (j.return_msg || j.message || ("차트 응답 파싱 실패(키: " + Object.keys(j).join(",") + ")")));
    }
    async getStockChart(code, tfSec) {
      // 4h 등 비표준 분봉은 60분봉 조회 후 리샘플
      if (tfSec < 86400 && !MIN_VALID.includes(String(Math.round(tfSec / 60)))) {
        const bars = await this._parseBars(3600, "/api/dostk/chart", "ka10080", { stk_cd: code, tic_scope: "60", upd_stkpc_tp: "1" });
        return resampleBars(bars, tfSec);
      }
      const apiId = this.apiIdFor(tfSec);
      const ticScope = tfSec < 60 ? "1" : String(Math.max(1, Math.round(tfSec / 60)));
      const body = apiId === "ka10080"
        ? { stk_cd: code, tic_scope: ticScope, upd_stkpc_tp: "1" }
        : apiId === "ka10079"
        ? { stk_cd: code, tic_scope: "1", upd_stkpc_tp: "1" }
        : { stk_cd: code, base_dt: todayStr(), upd_stkpc_tp: "1" };
      return this._parseBars(tfSec, "/api/dostk/chart", apiId, body);
    }
    async getIndexChart(indsCd, tfSec) {
      // 틱봉은 업종틱 지원이 불확실 → 1분봉으로 대체 (실데이터 유지)
      let apiId, body;
      if (tfSec === 604800) { apiId = "ka20007"; body = { inds_cd: indsCd, base_dt: todayStr() }; }
      else if (tfSec === 2592000) { apiId = "ka20008"; body = { inds_cd: indsCd, base_dt: todayStr() }; }
      else if (tfSec < 86400 && !MIN_VALID.includes(String(Math.round(tfSec / 60)))) {
        const bars = await this._parseBars(3600, "/api/dostk/chart", "ka20005", { inds_cd: indsCd, tic_scope: "60", base_dt: todayStr() });
        return resampleBars(bars, tfSec);
      }
      else if (tfSec < 86400) {
        apiId = "ka20005";
        body = { inds_cd: indsCd, tic_scope: String(Math.max(1, Math.round(tfSec / 60))), base_dt: todayStr() };
      } else if (tfSec < 86400 * 7) { apiId = "ka20006"; body = { inds_cd: indsCd, base_dt: todayStr() }; }
      else if (tfSec < 86400 * 31) { apiId = "ka20007"; body = { inds_cd: indsCd, base_dt: todayStr() }; }
      else { apiId = "ka20008"; body = { inds_cd: indsCd, base_dt: todayStr() }; }
      return this._parseBars(tfSec, "/api/dostk/chart", apiId, body);
    }
    async getUSChart(r, tfSec) {
      // 분봉 usa06011 / 일봉 이상 usa06012, 경로 /api/us/chart, 환율 미적용(달러 그대로)
      // 4h 등 비표준 분봉은 60분봉 조회 후 리샘플
      if (tfSec < 86400 && !MIN_VALID.includes(String(Math.round(tfSec / 60)))) {
        const saved = r.stex_tp ? [r.stex_tp] : US_EXCHANGES;
        let lastErr = null;
        for (const stex of saved) {
          try {
            const bars = await this._parseBars(3600, "/api/us/chart", "usa06011",
              { stex_tp: stex, stk_cd: r.stk_cd, strt_dt: todayStr(), tic_scope: "60", upd_stkpc_tp: "1", exrt_appl_tp: "0" });
            this._usExch = this._usExch || {}; this._usExch[r.stk_cd] = stex;
            return resampleBars(bars, tfSec);
          } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error("미국 차트 조회 실패");
      }
      const isMin = tfSec < 86400;
      const apiId = isMin ? "usa06011" : "usa06012";
      const exList = r.stex_tp ? [r.stex_tp] : US_EXCHANGES;
      let lastErr = null;
      for (const stex of exList) {
        try {
          const body = isMin
            ? { stex_tp: stex, stk_cd: r.stk_cd, strt_dt: todayStr(), tic_scope: String(Math.max(1, Math.round(tfSec / 60))), upd_stkpc_tp: "1", exrt_appl_tp: "0" }
            : { stex_tp: stex, stk_cd: r.stk_cd, strt_dt: todayStr(), upd_stkpc_tp: "1", exrt_appl_tp: "0" };
          const bars = await this._parseBars(tfSec, "/api/us/chart", apiId, body);
          this._usExch = this._usExch || {}; this._usExch[r.stk_cd] = stex; // 실시간 구독에 재사용
          return bars;
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("미국 차트 조회 실패");
    }
    async getStockName(code) {
      if (!this.token) await this.getToken();
      const { j } = await this._postChart("/api/dostk/stkinfo", "ka10100", { stk_cd: code });
      return (j && j.name ? String(j.name).trim() : null);
    }
    connectWS() {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return this.ws;
      const url = this.wsBase + "/api/dostk/websocket";
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ trnm: "LOGIN", token: this.token }));
        this.onStatus && this.onStatus("ws-login");
        this.step && this.step("ws", "접속→로그인 전송");
        // 기존 구독 복원
        if (this.regSet.size) this._sendReg([...this.regSet]);
        if (this.idxReg && this.idxReg.size) this._sendRegIdx([...this.idxReg]);
      };
      this.ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.trnm === "REAL" && Array.isArray(m.data)) {
          if (!this._wsData) { this._wsData = true; this.step && this.step("ws", "실시간 수신중"); }
          m.data.forEach(row => {
            if (row.type !== "0B" && row.type !== "0J") return; // 0B 주식체결 / 0J 업종지수
            const v = row.values || {};
            const price = Math.abs(parseFloat(String(v["10"]).replace(/[+,]/g, "")));
            const qty = Math.abs(parseInt(String(v["15"] || "0").replace(/[+,]/g, ""), 10) || 0);
            if (!price) return;
            let symbol = row.item;
            if (row.type === "0J") { // 업종코드 → 심볼 역매핑 (001→KOSPI)
              symbol = (this.idxRev && this.idxRev[row.item]) || row.item;
            }
            this.onTick && this.onTick({ symbol, price, time: Date.now(), volume: qty || 1, src: "kiwoom" });
          });
        } else if (m.return_code !== undefined && m.trnm !== "REAL") {
          this.onStatus && this.onStatus("ws-msg:" + (m.return_msg || m.return_code));
        }
      };
      this.ws.onclose = () => { this.onStatus && this.onStatus("ws-close"); this.step && this.step("ws", "끊김"); };
      this.ws.onerror = () => { this.onStatus && this.onStatus("ws-error"); this.step && this.step("ws", "오류"); };
      return this.ws;
    }
    subscribe(codes) {
      codes.forEach(c => this.regSet.add(c));
      if (!this.ws || this.ws.readyState !== 1) { this.connectWS(); return; }
      this._sendReg(codes);
    }
    _sendReg(codes) {
      try { this.ws.send(JSON.stringify({ trnm: "REG", grp_no: "1", refresh: "1", data: [{ item: codes, type: ["0B"] }] })); } catch (_) {}
    }
    subscribeIndex(entries) {
      // entries: [{symbol, code}] — 0J 업종지수 구독
      this.idxReg = this.idxReg || new Set();
      this.idxRev = this.idxRev || {};
      entries.forEach(({ symbol, code }) => { this.idxReg.add(code); this.idxRev[code] = symbol; });
      if (!this.ws || this.ws.readyState !== 1) { this.connectWS(); return; }
      this._sendRegIdx([...this.idxReg]);
    }
    _sendRegIdx(codes) {
      try { this.ws.send(JSON.stringify({ trnm: "REG", grp_no: "2", refresh: "1", data: [{ item: codes, type: ["0J"] }] })); } catch (_) {}
    }
    // ---- 미국 실시간 (FE, /api/us/websocket, item {jmcode, stex_tp}) ----
    connectUSWS() {
      if (this.usWs && (this.usWs.readyState === 0 || this.usWs.readyState === 1)) return this.usWs;
      this.usWs = new WebSocket(this.wsBase + "/api/us/websocket");
      this.usWs.onopen = () => {
        this.usWs.send(JSON.stringify({ trnm: "LOGIN", token: this.token }));
        this.onStatus && this.onStatus("us-ws-login");
        if (this.usSubs && this.usSubs.length) this._sendUSReg();
      };
      this.usWs.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.trnm === "REAL" && Array.isArray(m.data)) {
          this.step && this.step("ws", "실시간 수신중(US포함)");
          m.data.forEach(row => {
            const v = row.values || {};
            const price = Math.abs(parseFloat(String(v["10"]).replace(/[+,]/g, "")));
            if (!price) return;
            const jm = typeof row.item === "string" ? row.item : (row.item && row.item.jmcode);
            const symbol = (this.usRev && this.usRev[jm]) || jm;
            if (!symbol) return;
            const qty = Math.abs(parseInt(String(v["15"] || "0").replace(/[+,]/g, ""), 10) || 0);
            this.onTick && this.onTick({ symbol, price, time: Date.now(), volume: qty || 1, src: "kiwoom-us" });
          });
        } else if (m.return_code !== undefined && m.trnm !== "REAL") {
          this.onStatus && this.onStatus("us-ws-msg:" + (m.return_msg || m.return_code));
        }
      };
      this.usWs.onclose = () => { this.onStatus && this.onStatus("us-ws-close"); };
      this.usWs.onerror = () => { this.onStatus && this.onStatus("us-ws-error"); };
      return this.usWs;
    }
    subscribeUS(entries) {
      // entries: [{symbol, jmcode, stex_tp}]
      this.usSubs = entries;
      this.usRev = {};
      entries.forEach(en => { this.usRev[en.jmcode] = en.symbol; });
      if (!this.usWs || this.usWs.readyState !== 1) { this.connectUSWS(); return; }
      this._sendUSReg();
    }
    _sendUSReg() {
      try {
        this.usWs.send(JSON.stringify({
          trnm: "REG", grp_no: "3", refresh: "1",
          data: [{ item: this.usSubs.map(s => ({ jmcode: s.jmcode, stex_tp: s.stex_tp })), type: ["FE"] }],
        }));
      } catch (_) {}
    }
  }
  function todayStr() {
    const d = new Date();
    return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  }
  // 키움 차트 응답 파서 — 공식 명세(kiwoom_api_spec.json) 기준
  // ka10079 stk_tic_chart_qry / ka10080 stk_min_pole_chart_qry /
  // ka10081 stk_dt_pole_chart_qry / ka10082 stk_stk_pole_chart_qry / ka10083 stk_mth_pole_chart_qry
  // 행: {cur_prc 현재가, trde_qty 거래량, cntr_tm 체결시간(분/틱), dt 일자(일/주/월), open_pric/high_pric/low_pric}
  const KIWOOM_QRY = ["stk_tic_chart_qry", "stk_min_pole_chart_qry", "stk_dt_pole_chart_qry", "stk_stk_pole_chart_qry", "stk_mth_pole_chart_qry", "inds_min_pole_qry", "inds_dt_pole_qry", "inds_stk_pole_qry", "inds_mth_pole_qry", "result_list"];
  function parseKiwoomChart(j, tfSec) {
    if (!j || typeof j !== "object") return null;
    let arr = null;
    for (const k of KIWOOM_QRY) {
      if (Array.isArray(j[k]) && j[k].length) { arr = j[k]; break; }
    }
    if (!arr) {
      const candidates = [];
      if (Array.isArray(j)) candidates.push(j);
      for (const k of ["output", "data", "list", "chart", "bars"]) {
        if (Array.isArray(j[k])) candidates.push(j[k]);
      }
      if (j.data && Array.isArray(j.data.output)) candidates.push(j.data.output);
      arr = candidates.find(a => a.length && (a[0].cur_prc || a[0].close || a[0].stk_prc || a[0].price)) || candidates[0];
    }
    if (!arr || !arr.length) return null;
    const num = (v) => Math.abs(parseFloat(String(v == null ? "" : v).replace(/[+, ]/g, "")) || 0); // 키움가는 부호 포함 → 절댓값
    const bars = arr.map(r => {
      const dt = String(r.cntr_tm ?? r.dt ?? r.date ?? r.stk_dt ?? r.dtm ?? "").replace(/\D/g, "");
      const t = parseDt(dt, tfSec);
      return {
        time: t,
        open: num(r.open_pric ?? r.open ?? r.strt_prc),
        high: num(r.high_pric ?? r.high),
        low: num(r.low_pric ?? r.low),
        close: num(r.cur_prc ?? r.close ?? r.stk_prc ?? r.price),
        volume: num(r.trde_qty ?? r.acc_trde_qty ?? r.volume),
      };
    }).filter(b => b.time && b.close > 0).sort((a, b) => a.time - b.time);
    return bars.length ? bars : null;
  }
  function parseDt(dt, tfSec) {
    // "20240102103000" / "20240102" 등
    try {
      if (dt.length >= 14) {
        const iso = `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}T${dt.slice(8,10)}:${dt.slice(10,12)}:${dt.slice(12,14)}`;
        return Math.floor(new Date(iso).getTime() / 1000 / tfSec) * tfSec;
      }
      if (dt.length === 8) {
        const iso = `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}T15:30:00`;
        return Math.floor(new Date(iso).getTime() / 1000);
      }
    } catch (_) {}
    return Math.floor(Date.now() / 1000);
  }

  // ---------- 통합 Datafeed ----------
  class Datafeed {
    constructor() {
      this.symbols = [...DEFAULT_SYMBOLS];
      this.spot = {}; this.symbols.forEach(s => (this.spot[s.id] = s.base));
      this.tickCb = new Map();
      this.kiwoom = null; this.mode = "sim";
      this.onWatch = null; this.onMode = null; this.onLog = null; this.onStep = null;
      this._steps = {};
      this._yahooOnly = new Set(); this._yPoll = {};
      setInterval(() => { // 시뮬 펌프 (키움 지원 외 심볼용)
        this.symbols.forEach(s => {
          if (this.mode === "kiwoom" && resolveKiwoom(s.id) && this.kiwoomSubscribed) return;
          const tick = this._nextTick(s.id);
          (this.tickCb.get(s.id) || []).forEach(cb => cb(tick));
        });
        if (this.onWatch) this.onWatch({ ...this.spot });
      }, 250);
    }
    log(m) { this.onLog && this.onLog(m); }
    step(k, v) { this._steps[k] = v; this.onStep && this.onStep({ ...this._steps }); }
    addSymbols(list) {
      // list: [{id, name}] — 6자리 키움코드 or 가상심볼
      let added = 0;
      list.forEach(({ id, name }) => {
        id = String(id).trim();
        if (!id || this.symbols.some(s => s.id === id)) return;
        const base = isKiwoomCode(id) ? 50000 : 1000;
        this.symbols.push({ id, name: name || id, base, vol: 0.002 });
        if (!(id in this.spot)) this.spot[id] = base;
        added++;
      });
      return added;
    }
    _nextTick(symbolId) {
      const meta = this.symbols.find(s => s.id === symbolId) || { base: 10000, vol: 0.002 };
      const p = this.spot[symbolId] || meta.base;
      const np = Math.max(1, p + randn() * (meta.vol || 0.002) * p * 0.35);
      this.spot[symbolId] = np;
      return { symbol: symbolId, price: np, time: Date.now(), volume: Math.round(Math.abs(randn()) * 8 + 1), src: "sim" };
    }
    async connectKiwoom({ appkey, secretkey, mock }) {
      const cli = new KiwoomClient({ appkey, secretkey, mock });
      this._steps = {};
      cli.step = (k, v) => this.step(k, v);
      await cli.getToken();
      cli.onTick = (tick) => {
        this.spot[tick.symbol] = tick.price;
        (this.tickCb.get(tick.symbol) || []).forEach(cb => cb(tick));
        if (this.onWatch) this.onWatch({ ...this.spot });
      };
      cli.onStatus = (s) => this.log("키움WS: " + s);
      cli.connectWS();
      this.kiwoom = cli; this.mode = "kiwoom"; this.kiwoomSubscribed = true;
      this._subscribeAllKiwoom();
      this.onMode && this.onMode("kiwoom");
      return true;
    }
    _kiwoomLists() {
      const stocks = [], indices = [], us = [];
      this.symbols.forEach(s => {
        const r = resolveKiwoom(s.id);
        if (!r) return;
        if (r.kind === "stock") stocks.push(s.id);
        else if (r.kind === "index") indices.push({ symbol: s.id, code: r.code });
        else us.push({ symbol: s.id, jmcode: r.stk_cd, stex_tp: (this.kiwoom._usExch && this.kiwoom._usExch[r.stk_cd]) || r.stex_tp || "ND" });
      });
      return { stocks, indices, us };
    }
    _subscribeAllKiwoom() {
      // 관심종목의 키움 지원 심볼은 전부 실시간 구독 (현재 차트 종목만 하면 나머지가 멈춤)
      if (!this.kiwoom) return;
      const { stocks, indices, us } = this._kiwoomLists();
      try { if (stocks.length) this.kiwoom.subscribe(stocks); } catch (_) {}
      try { if (indices.length) this.kiwoom.subscribeIndex(indices); } catch (_) {}
      try { if (us.length) this.kiwoom.subscribeUS(us); } catch (_) {}
    }
    async resolveNames(onUpdate) {
      // 6자리 종목의 한글 종목명을 ka10100으로 조회 (키움 연결 시)
      if (!this.kiwoom || this._resolving) return 0;
      this._resolving = true;
      let n = 0;
      try {
        const targets = this.symbols.filter(s => isKiwoomCode(s.id) && (!s.name || s.name === s.id));
        for (const s of targets) {
          try {
            const name = await this.kiwoom.getStockName(s.id);
            if (name) { s.name = name; n++; onUpdate && onUpdate(s); }
          } catch (_) {}
          await new Promise(r => setTimeout(r, 120));
        }
      } finally { this._resolving = false; }
      return n;
    }
    disconnectKiwoom() {
      try { this.kiwoom && this.kiwoom.ws && this.kiwoom.ws.close(); } catch (_) {}
      try { this.kiwoom && this.kiwoom.usWs && this.kiwoom.usWs.close(); } catch (_) {}
      this.kiwoom = null; this.mode = "sim"; this.kiwoomSubscribed = false;
      this.onMode && this.onMode("sim");
    }
    async getBars(symbol, timeframe) {
      const tfSec = TF[timeframe] || 60;
      const rk = resolveKiwoom(symbol);
      const canYahoo = !!YAHOO_MAP[symbol];
      this._src = this._src || {};
      if (rk && this.mode === "kiwoom" && this.kiwoom) {
        try {
          this.log(`키움 차트요청 ${symbol} ${timeframe}`);
          const bars = await this.kiwoom.getChart(symbol, tfSec);
          bars.forEach(b => { this.spot[symbol] = b.close; });
          this._yahooOnly.delete(symbol);
          this._src[symbol] = "키움";
          return bars;
        } catch (e) {
          const msg = e.message || e;
          this.log("키움 차트 실패: " + msg);
          if (canYahoo) {
            const yb = await this._yahooBars(symbol, tfSec).catch(err => { this.step("chart", "실패→시뮬: " + String(err.message || err).slice(0, 60)); return null; });
            if (yb) { this._yahooOnly.add(symbol); yb.forEach(b => { this.spot[symbol] = b.close; }); this._src[symbol] = "야후"; return yb; }
          } else {
            this.step("chart", "실패→시뮬: " + String(msg).slice(0, 60));
          }
        }
      } else if (rk && canYahoo) {
        // 키움 미연결이어도 지수는 야후로 실데이터 (server.js 실행 필요)
        const yb = await this._yahooBars(symbol, tfSec).catch(() => null);
        if (yb) { this._yahooOnly.add(symbol); yb.forEach(b => { this.spot[symbol] = b.close; }); this._src[symbol] = "야후"; return yb; }
        this._yahooOnly.delete(symbol);
      }
      this._src[symbol] = "시뮬";
      return Promise.resolve(this._genHistory(symbol, tfSec, 300));
    }
    async _yahooBars(symbol, tfSec) {
      const ysym = YAHOO_MAP[symbol];
      if (!ysym) throw new Error("야후 매핑 없음");
      const { interval, range } = yahooTF(tfSec);
      // 1차: 로컬 프록시 (server.js 실행 시, CORS 회피)
      // 2차: 야후 직접 호출 (APK/Capacitor 등 프록시 없을 때)
      let j = null;
      try {
        const r = await fetch(`/yahoo-chart?symbol=${encodeURIComponent(ysym)}&interval=${interval}&range=${range}`);
        j = await r.json();
      } catch (_) { j = null; }
      if (!j || !j.chart || !j.chart.result) {
        const qs = `?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
        const hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
        let lastErr = null;
        for (const h of hosts) {
          try {
            const r = await fetch(h + "/v8/finance/chart/" + encodeURIComponent(ysym) + qs, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            });
            const jj = await r.json();
            if (jj && jj.chart && jj.chart.result) { j = jj; lastErr = null; break; }
            lastErr = new Error("야후 직접 응답 오류");
          } catch (e) { lastErr = e; }
        }
        if (!j || !j.chart || !j.chart.result) throw lastErr || new Error("야후 응답 오류");
      }
      const res = j && j.chart && j.chart.result && j.chart.result[0];
      if (!res) throw new Error("야후 응답 오류: " + ((j.chart && j.chart.error && j.chart.error.description) || "?"));
      const ts = res.timestamp || [], q = (res.indicators.quote || [{}])[0];
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const c = q.close && q.close[i];
        if (c == null) continue;
        bars.push({ time: ts[i], open: q.open[i] ?? c, high: q.high[i] ?? c, low: q.low[i] ?? c, close: c, volume: (q.volume && q.volume[i]) || 0 });
      }
      if (!bars.length) throw new Error("야후 빈 응답");
      const out = tfSec === 14400 ? resampleBars(bars, tfSec) : bars;
      this.step && this.step("chart", `OK ${out.length}개(야후 ${ysym})`);
      this.log(`야후 차트 ${symbol}(${ysym}) ${out.length}개`);
      return out;
    }
    _stopYahoo(symbol) {
      if (this._yPoll[symbol]) { clearInterval(this._yPoll[symbol]); delete this._yPoll[symbol]; }
    }
    _pollYahoo(symbol, onTick) {
      // 야후 폴링 실시간 (15초 간격 최종가)
      this._stopYahoo(symbol);
      const pull = async () => {
        try {
          const bars = await this._yahooBars(symbol, 60);
          if (bars && bars.length) {
            const last = bars[bars.length - 1];
            this.spot[symbol] = last.close;
            onTick({ symbol, price: last.close, time: Date.now(), volume: last.volume || 0, src: "yahoo" });
          }
        } catch (_) {}
      };
      pull();
      this._yPoll[symbol] = setInterval(pull, 15000);
      return () => this._stopYahoo(symbol);
    }
    _genHistory(symbolId, tfSec, count = 300) {
      const meta = this.symbols.find(s => s.id === symbolId) || { base: 50000, vol: 0.002 };
      const now = Math.floor(Date.now() / 1000);
      const start = now - (now % tfSec) - count * tfSec;
      let price = (this.spot[symbolId] || meta.base) * (1 + randn() * 0.005);
      const bars = [];
      for (let i = 0; i < count; i++) {
        const t = start + i * tfSec;
        const o = price;
        const drift = randn() * (meta.vol || 0.002) * price * 0.5;
        const c = Math.max(1, o + drift);
        const h = Math.max(o, c) + Math.abs(randn()) * (meta.vol || 0.002) * price * 0.5;
        const l = Math.min(o, c) - Math.abs(randn()) * (meta.vol || 0.002) * price * 0.5;
        const v = Math.round(50 + Math.abs(randn()) * 150 + (Math.abs(c - o) / price) * 80000);
        bars.push({ time: t, open: o, high: h, low: l, close: c, volume: v });
        price = c;
      }
      this.spot[symbolId] = price;
      return bars;
    }
    subscribeBars(symbol, timeframe, onTick) {
      if (!this.tickCb.has(symbol)) this.tickCb.set(symbol, new Set());
      const set = this.tickCb.get(symbol);
      const wrapped = (tick) => onTick(tick);
      set.add(wrapped);
      const off = () => { set.delete(wrapped); this._stopYahoo(symbol); };
      if (this._yahooOnly.has(symbol)) { this._pollYahoo(symbol, onTick); return off; }
      if (this.mode === "kiwoom" && this.kiwoom && resolveKiwoom(symbol)) {
        // 새로 추가된 종목도 포함해 키움 지원 심볼 전체를 구독 상태로 유지
        try { this._subscribeAllKiwoom(); } catch (_) {}
      }
      return off;
    }
  }

  global.Datafeed = { create: () => new Datafeed(), TF, DEFAULT_SYMBOLS, isKiwoomCode };
})(window);

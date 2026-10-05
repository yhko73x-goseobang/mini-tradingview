/* app.js — Datafeed + ChartEngine + 키움/얼럿/TXT 연결 */
(function () {
  const feed = Datafeed.create();
  const chart = new ChartEngine(document.getElementById("chart"), document.getElementById("overlay"));
  const bundle = new PineBundle(); // 필수지표모음 포팅
  chart.bundle = bundle;
  const $ = id => document.getElementById(id);
  const symTabs = $("symbolTabs"), tfTabs = $("tfTabs");
  const TF = Datafeed.TF;
  let symbol = "102110", tf = "1m";
  let unsub = null, lastBundleTs = 0;
  const fired = new Set(); // 중복 얼럿 방지: symbol@tf@barTime@type

  // ---------- 사운드 (WebAudio, 외부파일 불필요) ----------
  let audioCtx = null;
  function beep(freq, dur, delay, type) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime + (delay || 0);
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || "sine"; o.frequency.value = freq || 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.25));
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + (dur || 0.25) + 0.05);
    } catch (_) {}
  }
  function alertSound(kind) {
    if (kind === "PC") { beep(660, 0.2, 0); beep(880, 0.25, 0.22); }
    else { beep(520, 0.2, 0); beep(780, 0.25, 0.22); }
  }

  // ---------- 로그 ----------
  function log(msg) {
    const el = $("log"), d = document.createElement("div");
    d.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
    el.prepend(d);
    while (el.children.length > 80) el.lastChild.remove();
  }
  function alertLog(msg, kind) {
    const el = $("alertLog"), d = document.createElement("div");
    d.className = "alert-item " + (kind || "");
    d.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
    el.prepend(d);
    while (el.children.length > 40) el.lastChild.remove();
  }
  feed.onLog = log;
  window.addEventListener("error", e => log("JS오류: " + (e.message || (e.error && e.error.message) || e)));
  chart.onError = (e) => log("차트오류(표시는 유지): " + (e.message || e));
  feed.onStep = (s) => {
    $("kiwoomStatus").textContent = `토큰: ${s.token || "-"} · 차트: ${s.chart || "-"} · WS: ${s.ws || "-"}`;
  };
  if (location.protocol === "file:") {
    log("주의: file:// 실행 중 — 프록시(/kiwoom-*) 사용 불가. 키움 직접 호출이 CORS로 막히면 node server.js 후 http://localhost:8080 접속");
  }

  // ---------- 심볼/타임프레임 탭 ----------
  function updateCurSym() {
    const m = feed.symbols.find(s => s.id === symbol);
    const label = m ? (m.name && m.name !== m.id ? `${m.id} ${m.name}` : m.id) : "—";
    $("curSym").textContent = label;
    chart.watermark = m ? label : ""; // 차트 상/하단 워터마크
    chart.dirty = true;
  }
  function refreshNames() {
    renderSymbolTabs(); renderWatchlist(); updateCurSym();
  }
  function selectSymbol(id) {
    symbol = id;
    updateCurSym();
    load();
  }
  function renderSymbolTabs() {
    symTabs.innerHTML = "";
    const cur = feed.symbols.find(s => s.id === symbol);
    const others = feed.symbols.filter(s => s.id !== symbol);
    [cur, ...others].filter(Boolean).slice(0, 12).forEach(s => {
      const b = document.createElement("button");
      b.textContent = s.name && s.name !== s.id ? `${s.id} ${s.name}` : s.id;
      b.title = s.id;
      if (s.id === symbol) b.classList.add("active");
      b.onclick = () => selectSymbol(s.id);
      symTabs.appendChild(b);
    });
  }
  function renderTFTabs() {
    tfTabs.innerHTML = "";
    Object.keys(TF).forEach(t => {
      const b = document.createElement("button");
      b.textContent = t; if (t === tf) b.classList.add("active");
      b.onclick = () => { tf = t; renderTFTabs(); syncAlertTFLabel(); load(); };
      tfTabs.appendChild(b);
    });
  }
  function syncAlertTFLabel() {
    const sel = $("alertTF");
    if (sel.value === "chart") $("feedInfo").textContent = `Datafeed: ${symbol} · ${tf} · 모드=${feed.mode}`;
  }

  // ---------- 필수지표 MTF (H1/D1/US100) ----------
  let usTimer = null;
  async function ensureMTF(sym, useTF) {
    if (!bundle.show.master) return;
    try {
      const [h1, d1] = await Promise.all([
        feed.getBars(sym, "1h").catch(() => []),
        feed.getBars(sym, "1D").catch(() => []),
      ]);
      bundle.mt.h1 = h1 || []; bundle.mt.d1 = d1 || [];
    } catch (_) {}
    await refreshUS(sym, useTF);
    bundle.computeMTF();
    chart.dirty = true;
    updatePineTable(true);
  }
  async function refreshUS(sym, useTF) {
    if (!bundle.show.master) return;
    try {
      const ub = await feed.getBars("US100", useTF || tf);
      if (ub && ub.length) { bundle.mt.us = ub; bundle.computeMTF(); chart.dirty = true; updatePineTable(true); }
    } catch (_) {}
  }
  function startUsTimer() {
    if (usTimer) clearInterval(usTimer);
    usTimer = setInterval(() => { if (bundle.show.master) refreshUS(symbol, $("alertTF").value !== "chart" ? $("alertTF").value : tf); }, 90000);
  }
  let pineTableTs = 0;
  function updatePineTable(force) {
    const now = Date.now();
    if (!force && now - pineTableTs < 1500) return;
    pineTableTs = now;
    const el = $("pineTable"), top = $("pineTop");
    if (!bundle.show.master || !bundle.show.mtf) { el.hidden = true; top.hidden = true; return; }
    const d = bundle.tableData();
    if (!d) { el.hidden = true; top.hidden = true; return; }
    bundle.lastTable = d; // 캔버스 라벨 스트립용
    el.hidden = true; // HTML 테이블 미사용 (라벨식으로 대체)
    chart.dirty = true;
    const pos = Math.round(d.curPos), filled = Math.round(pos / 100 * 10);
    top.hidden = false;
    top.textContent = `일간 ${"●".repeat(filled)}${"─".repeat(10 - filled)} ${pos}%`;
  }

  // ---------- 차트 로드 ----------
  async function load() {
    if (unsub) { unsub(); unsub = null; }
    if (!feed.symbols.some(s => s.id === symbol)) symbol = (feed.symbols[0] && feed.symbols[0].id) || "";
    if (!symbol) return;
    const alertTF = $("alertTF").value;
    const useTF = alertTF !== "chart" ? alertTF : tf; // 얼럿 시간대 지정 시 그 봉으로 차트 전환
    if (alertTF !== "chart" && alertTF !== tf) { tf = alertTF; renderTFTabs(); }
    log(`getBars(${symbol}, ${useTF}) 요청`);
    const bars = await feed.getBars(symbol, useTF);
    chart.setBars(bars, TF[useTF]);
    bbBroken = false; // 종목/시간대 변경 시 2단계 무장 초기화
    bundle.tfLabel = useTF;
    try { bundle.compute(bars, TF[useTF]); } catch (e) { log("번들 연산 실패(차트는 표시): " + (e.message || e)); }
    try { ensureMTF(symbol, useTF); } catch (e) { log("MTF 실패: " + (e.message || e)); }
    updatePineTable(true);
    log(`과거 ${bars.length}개 로드 완료 (모드=${feed.mode})`);
    checkAlert(true);
    unsub = feed.subscribeBars(symbol, useTF, tick => {
      if (tick.symbol !== symbol) return;
      const prevT = chart.bars.length ? chart.bars[chart.bars.length - 1].time : 0;
      const cur = chart.applyTick(tick);
      if (!cur) return;
      const nowT = Date.now();
      const newBar = chart.bars[chart.bars.length - 1].time !== prevT;
      if (newBar || nowT - lastBundleTs > 800) {
        try { bundle.compute(chart.bars, chart.tfSec); } catch (e) { console.error("[bundle tick]", e); }
        lastBundleTs = nowT;
      }
      updatePineTable(false);
      if (chart.follow && chart.view.offset !== 0) { chart.view.offset = 0; chart.dirty = true; }
      checkAlert(false);
    });
    chart.follow = true;
    $("btnFollow").classList.add("active");
    $("btnFollow").textContent = "▶ 추적 ON";
    renderSymbolTabs(); renderWatchlist(); syncAlertTFLabel(); updateCurSym(); ensureBg();
  }

  // ---------- 얼럿 판정 (소리+배너는 얼럿 종목만, 기록은 전부) ----------
  function audible(id) { return alertSyms.has(id); }
  let bbBroken = false; // BB 하단 이탈 무장 상태 (2단계 얼럿용, 차트 종목)
  let wavAudio = null;
  function playWav() {
    try {
      wavAudio = wavAudio || new Audio("alert.wav");
      wavAudio.currentTime = 0;
      const p = wavAudio.play();
      if (p && p.catch) p.catch(() => { alertSound("PC"); log("WAV 재생 차단 → 기본음"); });
    } catch (_) { alertSound("PC"); }
  }
  function checkAlert(isInitial) {
    const v = chart.lastValues();
    if (!v || v.bbLow == null || v.pcLow == null) return;
    const tol = 1.0015; // 저가가 밴드하단 * 1.0015 이하이면 "닿음"
    const pcOn = $("alertPC").checked, bbOn = $("alertBB").checked;
    const pcTouch = pcOn && v.low <= v.pcLow * tol;
    const bbTouch = bbOn && v.low <= v.bbLow * tol;
    chart.signal = (pcTouch || bbTouch) ? { barTime: v.bar.time, pcTouch, bbTouch } : null;
    chart.dirty = true;
    const key = (t) => `${symbol}@${tf}@${v.bar.time}@${t}`;
    if (pcTouch && !fired.has(key("PC"))) {
      fired.add(key("PC"));
      if (audible(symbol)) {
        alertSound("PC");
        showBanner(symbol, "PC 하단 터치");
        flash(`PC 하단 터치 ${symbol} ${fmtPrice(v.low)} ≤ ${fmtPrice(v.pcLow)}`);
      }
      alertLog(`[PC 하단] ${symbol} (${tf}) 저가 ${fmtPrice(v.low)} ≤ 하단 ${fmtPrice(v.pcLow)}`, "pc");
      log(`얼럿 PC 하단 터치 ${symbol} @${tf}`);
    }
    if (bbTouch && !fired.has(key("BB"))) {
      fired.add(key("BB"));
      if (audible(symbol)) {
        alertSound("BB");
        showBanner(symbol, "볼린저 하단 터치");
        flash(`볼린저 하단 터치 ${symbol} ${fmtPrice(v.low)} ≤ ${fmtPrice(v.bbLow)}`);
      }
      alertLog(`[BB 하단] ${symbol} (${tf}) 저가 ${fmtPrice(v.low)} ≤ 하단 ${fmtPrice(v.bbLow)}`, "bb");
      log(`얼럿 BB 하단 터치 ${symbol} @${tf}`);
    }
    if (isInitial && !pcTouch && !bbTouch) { chart.signal = null; }
    // BB(20,2) 하단이 BB(60,2) 하단을 뚫고 내려가면 얼럿
    if ($("alertBB60").checked) {
      const n = chart.bars.length;
      if (n >= 61) {
        const b20 = chart.bb(20, 2), b60 = chart.bb(60, 2);
        if (b20.lo[n - 2] != null && b60.lo[n - 2] != null && b60.lo[n - 1] != null &&
            b20.lo[n - 2] >= b60.lo[n - 2] && b20.lo[n - 1] < b60.lo[n - 1] && !fired.has(key("BB60"))) {
          fired.add(key("BB60"));
          if (audible(symbol)) {
            playWav();
            setTimeout(() => speak(symbol, "볼린저 20 60 하단 돌파"), 1200);
            showBanner(symbol, "BB20 하단↓BB60 하단");
            flash(`BB20 하단↓BB60 하단 ${symbol}`);
          }
          alertLog(`[BB20↓BB60] ${symbol} (${tf})`, "bb");
          log(`얼럿 BB20 하단↓BB60 하단 ${symbol} @${tf}`);
        }
      }
    }
    // 2단계 얼럿: BB 하단 통과(종가 이탈) 이후 PC 하단/상단 터치 → WAV
    if ($("alertStage").checked && v.pcUp != null && v.bbMid != null) {
      if (v.close < v.bbLow) {
        if (!bbBroken) { bbBroken = true; log(`BB 하단 통과 ${symbol} — PC 터치 대기 중`); }
      } else if (v.close > v.bbMid) {
        bbBroken = false; // 밴드 안으로 복귀 → 무장 해제
      }
      if (bbBroken) {
        const touchLow = v.low <= v.pcLow * tol;
        const touchUp = v.high >= v.pcUp / tol;
        const side = touchLow ? "하단" : touchUp ? "상단" : null;
        if (side && !fired.has(key("STAGE"))) {
          fired.add(key("STAGE"));
          if (audible(symbol)) {
            playWav();
            setTimeout(() => speak(symbol, "매수 준비"), 1200);
            showBanner(symbol, `PC${side} 터치 (BB이탈 후)`);
            flash(`PC ${side} 터치(BB이탈 후) ${symbol} ${fmtPrice(v.close)}`);
          }
          alertLog(`[2단계 PC${side}] ${symbol} (${tf}) 종가 ${fmtPrice(v.close)}`, "pc");
          log(`얼럿 2단계 PC${side} 터치 ${symbol} @${tf} (WAV)`);
          bbBroken = false;
        }
      }
    }
  }
  let flashTimer = null;
  function symbolLabel(id) {
    const m = feed.symbols.find(s => s.id === id);
    return m ? (m.name && m.name !== m.id ? `${m.id} ${m.name}` : m.id) : id;
  }
  function speak(id, kind) {
    // WAV는 "매수준비"만 말해서 종목이 뭔지 모름 → 음성으로 종목명 안내
    try {
      if (!$("alertVoice").checked || !("speechSynthesis" in window)) return;
      const m = feed.symbols.find(s => s.id === id);
      const code = /^\d{6}$/.test(id) ? id.split("").join(" ") : id;
      const name = m && m.name && m.name !== m.id ? m.name : "";
      const u = new SpeechSynthesisUtterance(`${code} ${name} ${kind}`);
      u.lang = "ko-KR"; u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }
  function showBanner(symbol, kind) {
    const el = $("alertBanner");
    el.textContent = `🔔 ${symbolLabel(symbol)} ${kind}`;
    el.style.top = "8px"; // 가격창 우상단 고정 (라벨 스트립과 겹치지 않게)
    el.hidden = false;
  }
  function flash(msg) {
    const el = $("alertFlash");
    el.textContent = "🔔 " + msg;
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (el.hidden = true), 4000);
  }

  // ---------- 백그라운드 얼럿 (차트에 안 띄워도 감시) ----------
  const CURATED_IDS = Datafeed.DEFAULT_SYMBOLS.filter(s => s.grp && s.grp !== "코인").map(s => s.id);
  const alertSyms = new Set(JSON.parse(localStorage.getItem("alert_syms_v5") || JSON.stringify(CURATED_IDS)));
  const bg = {}; // id -> {bars, label, tfSec, bbBroken, fired:Set, unsub}
  const bgPending = {};
  function saveAlertSyms() { try { localStorage.setItem("alert_syms_v5", JSON.stringify([...alertSyms])); } catch (_) {} }
  function alertTFLabel() { const a = $("alertTF").value; return a !== "chart" ? a : tf; }
  function alertTFSec() { return TF[alertTFLabel()]; }
  function lastBB(bars, n, k) {
    if (bars.length < n) return null;
    const s = bars.slice(-n);
    const m = s.reduce((a, b) => a + b.close, 0) / n;
    const v = s.reduce((a, b) => a + (b.close - m) ** 2, 0) / n;
    return { mid: m, up: m + k * Math.sqrt(v), lo: m - k * Math.sqrt(v) };
  }
  function lastPC(bars, n) {
    if (bars.length < n) return null;
    const s = bars.slice(-n);
    let up = -Infinity, lo = Infinity;
    s.forEach(b => { if (b.high > up) up = b.high; if (b.low < lo) lo = b.low; });
    return { up, lo, mid: (up + lo) / 2 };
  }
  function rollBg(st, tick) {
    let t;
    if (st.tfSec === 604800) { const d = new Date(tick.time); const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); t = Math.floor((d.getTime() - day * 86400000) / 1000); }
    else if (st.tfSec === 2592000) { const d = new Date(tick.time); t = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000); }
    else t = Math.floor(tick.time / 1000 / st.tfSec) * st.tfSec;
    const last = st.bars[st.bars.length - 1];
    if (!last) return null;
    if (t > last.time) {
      const nb = { time: t, open: last.close, high: tick.price, low: tick.price, close: tick.price, volume: tick.volume || 1 };
      st.bars.push(nb);
      if (st.bars.length > 600) st.bars.shift();
      return nb;
    }
    if (t === last.time) {
      last.close = tick.price;
      if (tick.price > last.high) last.high = tick.price;
      if (tick.price < last.low) last.low = tick.price;
      last.volume += (tick.volume || 1) * 0.2;
      return last;
    }
    return null;
  }
  function bgCheck(id, st) {
    if (id === symbol) return; // 차트에 띄운 종목은 차트 경로에서 처리 (중복 방지)
    const last = st.bars[st.bars.length - 1];
    const bb = lastBB(st.bars, chart.ind.bbN, chart.ind.bbK);
    const pc = lastPC(st.bars, chart.ind.pcLen);
    if (!bb || !pc) return;
    const tol = 1.0015;
    const key = (t) => `${id}@${st.label}@${last.time}@${t}`;
    if ($("alertPC").checked && last.low <= pc.lo * tol && !st.fired.has(key("PC"))) {
      st.fired.add(key("PC"));
      alertSound("PC"); showBanner(id, "PC 하단 터치"); flash(`PC 하단 터치 ${id}`);
      alertLog(`[PC 하단] ${id} (${st.label}) 저가 ${fmtPrice(last.low)}`, "pc");
      log(`얼럿 PC 하단 터치 ${id} @${st.label}`);
    }
    if ($("alertBB").checked && last.low <= bb.lo * tol && !st.fired.has(key("BB"))) {
      st.fired.add(key("BB"));
      alertSound("BB"); showBanner(id, "볼린저 하단 터치"); flash(`볼린저 하단 터치 ${id}`);
      alertLog(`[BB 하단] ${id} (${st.label}) 저가 ${fmtPrice(last.low)}`, "bb");
      log(`얼럿 BB 하단 터치 ${id} @${st.label}`);
    }
    if ($("alertBB60").checked && st.bars.length >= 61) {
      const a20 = lastBB(st.bars, 20, chart.ind.bbK), a60 = lastBB(st.bars, 60, 2);
      const p20 = lastBB(st.bars.slice(0, -1), 20, chart.ind.bbK), p60 = lastBB(st.bars.slice(0, -1), 60, 2);
      if (a20 && a60 && p20 && p60 && p20.lo >= p60.lo && a20.lo < a60.lo && !st.fired.has(key("BB60"))) {
        st.fired.add(key("BB60"));
        playWav(); setTimeout(() => speak(id, "볼린저 20 60 하단 돌파"), 1200);
        showBanner(id, "BB20 하단↓BB60 하단"); flash(`BB20 하단↓BB60 하단 ${id}`);
        alertLog(`[BB20↓BB60] ${id} (${st.label})`, "bb");
        log(`얼럿 BB20 하단↓BB60 하단 ${id} @${st.label}`);
      }
    }
    if ($("alertStage").checked) {
      if (last.close < bb.lo) { if (!st.bbBroken) { st.bbBroken = true; log(`BB 하단 통과 ${id} — PC 터치 대기 중`); } }
      else if (last.close > bb.mid) st.bbBroken = false;
      if (st.bbBroken) {
        const side = last.low <= pc.lo * tol ? "하단" : last.high >= pc.up / tol ? "상단" : null;
        if (side && !st.fired.has(key("STAGE"))) {
          st.fired.add(key("STAGE"));
          playWav(); setTimeout(() => speak(id, "매수 준비"), 1200);
          showBanner(id, `PC${side} 터치 (BB이탈 후)`); flash(`PC${side} 터치 ${id} (WAV)`);
          alertLog(`[2단계 PC${side}] ${id} (${st.label})`, "pc");
          log(`얼럿 2단계 PC${side} 터치 ${id} @${st.label} (WAV)`);
          st.bbBroken = false;
        }
      }
    }
  }
  async function bgAdd(id) {
    const label = alertTFLabel(), tfSec = TF[label];
    const ex = bg[id];
    if (ex && ex.tfSec === tfSec) return;
    if (bgPending[id]) return;
    bgPending[id] = 1; bgRemove(id);
    try {
      const bars = await feed.getBars(id, label);
      if (!bars || !bars.length || !alertSyms.has(id)) return;
      if ((feed._src || {})[id] === "시뮬") { log(`얼럿 감시 제외(가짜데이터): ${id} — server.js 또는 키움 연결 필요`); return; }
      const st = { bars, label, tfSec, bbBroken: false, fired: new Set(), unsub: null };
      st.unsub = feed.subscribeBars(id, label, tick => {
        if (tick.symbol !== id || !bg[id]) return;
        const cur = rollBg(st, tick);
        if (cur) bgCheck(id, st);
      });
      bg[id] = st;
    } catch (_) {} finally { delete bgPending[id]; }
  }
  function bgRemove(id) {
    if (bg[id]) { try { bg[id].unsub && bg[id].unsub(); } catch (_) {} delete bg[id]; }
  }
  function ensureBg() {
    const ts = alertTFSec();
    Object.keys(bg).forEach(id => {
      if (!alertSyms.has(id)) bgRemove(id);
      else if (bg[id].tfSec !== ts) { bgRemove(id); bgAdd(id); }
    });
    alertSyms.forEach(id => { if (!bg[id]) bgAdd(id); });
  }
  function renderAlertList() {
    const el = $("alertList");
    el.innerHTML = "";
    let lastGrp = null;
    alertSyms.forEach(id => {
      const m = feed.symbols.find(s => s.id === id);
      if (m && m.grp && m.grp !== lastGrp) grpHdr(el, m.grp);
      lastGrp = (m && m.grp) || lastGrp;
      const d = document.createElement("div");
      d.className = "wl" + (id === symbol ? " active" : "");
      const label = m && m.name && m.name !== m.id ? `${id} <small>${m.name}</small>` : id;
      const span = document.createElement("span"); span.innerHTML = label;
      const rm = document.createElement("button");
      rm.className = "rm"; rm.textContent = "✕"; rm.title = `${id} 얼럿 해제`;
      rm.onclick = () => {
        alertSyms.delete(id); bgRemove(id); saveAlertSyms(); renderAlertList();
        log(`얼럿 해제: ${id}`);
      };
      d.append(span, rm);
      d.onclick = () => selectSymbol(id);
      el.appendChild(d);
    });
    $("alertCount").textContent = alertSyms.size;
  }
  $("btnAlertAdd").onclick = () => {
    if (!symbol) return;
    if (alertSyms.has(symbol)) { log(`이미 얼럿 등록됨: ${symbol}`); return; }
    alertSyms.add(symbol); saveAlertSyms(); renderAlertList(); bgAdd(symbol);
    log(`얼럿 등록: ${symbol}`);
  };

  // ---------- 관심종목 (위: 지수 / 아래: 종목) ----------
  const INDEX_IDS = ["KOSPI", "KOSPI200", "KOSDAQ", "US100", "IXIC"];
  const wl = $("watchlist"), il = $("indexList");
  const rows = {};
  function grpHdr(container, text) {
    const h = document.createElement("div");
    h.className = "grp-hdr"; h.textContent = "▶ " + text;
    container.appendChild(h);
  }
  function renderWatchlist() {
    wl.innerHTML = ""; il.innerHTML = "";
    for (const k in rows) delete rows[k];
    let lastGrp = null;
    feed.symbols.forEach(s => {
      const d = document.createElement("div");
      d.className = "wl" + (s.id === symbol ? " active" : "");
      const label = s.name && s.name !== s.id ? `${s.id} <small>${s.name}</small>` : s.id;
      const span = document.createElement("span"); span.innerHTML = label;
      const b = document.createElement("b"); b.textContent = "—";
      const rm = document.createElement("button");
      rm.className = "rm"; rm.textContent = "✕"; rm.title = `${s.id} 삭제`;
      rm.onclick = (e) => { e.stopPropagation(); removeSymbol(s.id); };
      d.append(span, b, rm);
      d.onclick = () => selectSymbol(s.id);
      if (INDEX_IDS.includes(s.id)) { il.appendChild(d); }
      else {
        if (s.grp && s.grp !== lastGrp) grpHdr(wl, s.grp);
        lastGrp = s.grp || lastGrp;
        wl.appendChild(d);
      }
      rows[s.id] = d;
    });
  }
  function removeSymbol(id) {
    feed.symbols = feed.symbols.filter(s => s.id !== id);
    feed.tickCb.delete(id);
    try { feed._stopYahoo(id); } catch (_) {}
    if (alertSyms.has(id)) { alertSyms.delete(id); saveAlertSyms(); renderAlertList(); }
    bgRemove(id);
    delete feed.spot[id];
    delete rows[id];
    log(`종목 삭제: ${id}`);
    if (symbol === id) {
      if (feed.symbols.length) selectSymbol(feed.symbols[0].id);
      else { symbol = ""; chart.setBars([], chart.tfSec); renderSymbolTabs(); renderWatchlist(); updateCurSym(); }
    } else {
      renderSymbolTabs(); renderWatchlist(); updateCurSym();
    }
  }
  let prev = {};
  feed.onWatch = (spot) => {
    for (const id in spot) {
      const el = rows[id]; if (!el) continue;
      const b = el.querySelector("b");
      b.textContent = Number(spot[id]).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
      b.className = prev[id] != null ? (spot[id] >= prev[id] ? "up" : "down") : "";
    }
    prev = { ...spot };
    const cur = spot[symbol];
    if (cur) $("priceInfo").textContent = `${symbol} ${Number(cur).toLocaleString()} tick 수신 중 (${feed.mode})`;
  };

  feed.onMode = (m) => {
    const dot = $("connDot"), txt = $("connText");
    if (m === "kiwoom") { dot.className = "dot online"; txt.textContent = "키움 실시간 연결"; }
    else if (m === "ws") { dot.className = "dot online"; txt.textContent = "WebSocket 연결"; }
    else { dot.className = "dot sim"; txt.textContent = "시뮬레이션 피드"; }
    syncAlertTFLabel();
  };

  // ---------- 키움 연결 ----------
  try { // 입력값 유지 (매번 재입력 방지)
    $("kiwoomAppKey").value = localStorage.getItem("kw_app") || "";
    $("kiwoomSecret").value = localStorage.getItem("kw_sec") || "";
    const m = localStorage.getItem("kw_mock");
    if (m != null) $("kiwoomMock").checked = m === "1";
  } catch (_) {}
  $("btnKiwoom").onclick = async () => {
    const appkey = $("kiwoomAppKey").value.trim(), secretkey = $("kiwoomSecret").value.trim();
    const mock = $("kiwoomMock").checked;
    if (!appkey || !secretkey) { alert("앱키와 시크릿키를 입력하세요. (openapi.kiwoom.com 발급)"); return; }
    try {
      await doConnect(appkey, secretkey, mock);
    } catch (e) {
      log("키움 연결 실패: " + (e.message || e) + " → 시뮬 유지");
      alert("키움 연결 실패: " + (e.message || e) + "\n(CORS 차단이면 node server.js 프록시를 실행하세요)");
    }
  };
  async function doConnect(appkey, secretkey, mock) {
    log("키움 토큰 발급 시도…");
    await feed.connectKiwoom({ appkey, secretkey, mock });
    try { localStorage.setItem("kw_app", appkey); localStorage.setItem("kw_sec", secretkey); localStorage.setItem("kw_mock", mock ? "1" : "0"); } catch (_) {}
    log("키움 연결 성공 — 0B 실시간 구독 시작");
    log("종목명 조회 중… (ka10100)");
    feed.resolveNames(() => refreshNames()).then(n => log(`종목명 ${n}개 확인`));
    load();
  }
  $("btnKiwoomOff").onclick = () => { feed.disconnectKiwoom(); log("키움 해제 → 시뮬레이션"); load(); };

  // ---------- TXT 업로드 / 직접입력 ----------
  function parseCodeText(text) {
    const out = [];
    text.split(/\r?\n/).forEach(line => {
      const t = line.trim().replace(/,/g, " ");
      if (!t || t.startsWith("#")) return;
      const m = t.match(/(\d{6})/);
      if (m) {
        const name = t.replace(m[1], "").trim().replace(/^[\s\-_]+/, "");
        out.push({ id: m[1], name: name || m[1] });
      } else if (/^[A-Z/]+$/.test(t.replace(/\s/g, "").toUpperCase())) {
        out.push({ id: t.trim().toUpperCase(), name: t.trim().toUpperCase() });
      }
    });
    return out;
  }
  function addCodes(text) {
    const list = parseCodeText(text);
    if (!list.length) { alert("인식된 종목이 없습니다. 예) 005930 삼성전자"); return; }
    const n = feed.addSymbols(list);
    log(`종목 ${list.length}개 인식, ${n}개 추가`);
    if (feed.mode === "kiwoom") feed.resolveNames(() => refreshNames());
    selectSymbol(list[0].id); // 새로 추가됐든 이미 있었든 해당 종목으로 이동
  }
  function quickAdd() {
    const v = $("quickCode").value.trim();
    if (!v) return;
    const list = parseCodeText(v);
    if (!list.length) { alert("종목번호를 입력하세요. 예) 005930"); return; }
    const n = feed.addSymbols(list);
    $("quickCode").value = "";
    log(n > 0 ? `종목 추가: ${list[0].id}` : `이미 등록됨 → 이동: ${list[0].id}`);
    if (feed.mode === "kiwoom") feed.resolveNames(() => refreshNames());
    selectSymbol(list[0].id);
  }
  $("btnQuickAdd").onclick = quickAdd;
  $("quickCode").addEventListener("keydown", e => { if (e.key === "Enter") quickAdd(); });
  $("fileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => addCodes(String(r.result || ""));
    r.readAsText(f, "utf-8");
    e.target.value = "";
  });
  $("btnLoadCodes").onclick = () => addCodes($("codeBox").value);
  $("btnSample").onclick = () => {
    const blob = new Blob(["# 한 줄에 하나씩: 종목코드 + 이름(선택)\n005930 삼성전자\n000660 SK하이닉스\n035420 NAVER\n051910 LG화학\n"], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "종목예시.txt"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ---------- 지표/얼럿 UI ----------
  chart.onFps = fps => { $("hud").textContent = `${fps} fps · ${chart.bars.length} bars · Canvas`; };
  chart.onHover = b => {
    const chg = ((b.close - b.open) / b.open * 100);
    $("ohlc").innerHTML = `O <b>${fmtPrice(b.open)}</b> H <b>${fmtPrice(b.high)}</b> L <b>${fmtPrice(b.low)}</b> C <b class="${b.close >= b.open ? "up" : "down"}">${fmtPrice(b.close)} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)</b> Vol ${Math.round(b.volume).toLocaleString()}`;
  };
  chart.onTickApplied = last => {
    const chg = ((last.close - last.open) / last.open * 100);
    if (!chart.mouse) $("ohlc").innerHTML = `O <b>${fmtPrice(last.open)}</b> H <b>${fmtPrice(last.high)}</b> L <b>${fmtPrice(last.low)}</b> C <b class="${last.close >= last.open ? "up" : "down"}">${fmtPrice(last.close)} (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%)</b> Vol ${Math.round(last.volume).toLocaleString()}`;
  };
  chart.onFollowChange = () => {
    $("btnFollow").classList.remove("active");
    $("btnFollow").textContent = "⏸ 추적 OFF";
  };
  $("btnFollow").onclick = () => {
    chart.follow = !chart.follow;
    if (chart.follow) chart.view.offset = 0;
    $("btnFollow").classList.toggle("active", chart.follow);
    $("btnFollow").textContent = chart.follow ? "▶ 추적 ON" : "⏸ 추적 OFF";
    chart.dirty = true;
  };
  $("btnReset").onclick = () => load();
  $("tglMA").onchange = e => { chart.show.maShort = e.target.checked; chart.dirty = true; };
  $("tglMALong").onchange = e => { chart.show.maLong = e.target.checked; chart.dirty = true; };
  $("tglBB").onchange = e => { chart.show.bb = e.target.checked; chart.dirty = true; checkAlert(false); };
  $("tglBB60").onchange = e => { chart.show.bb60 = e.target.checked; chart.dirty = true; };
  $("tglPC").onchange = e => { chart.show.pc = e.target.checked; chart.dirty = true; checkAlert(false); };
  $("tglVol").onchange = e => { chart.show.vol = e.target.checked; chart.dirty = true; };
  $("pcLen").onchange = e => { chart.ind.pcLen = Math.max(5, +e.target.value || 20); chart.dirty = true; checkAlert(false); };
  $("bbN").onchange = e => { chart.ind.bbN = Math.max(5, +e.target.value || 20); chart.dirty = true; checkAlert(false); };
  $("bbK").onchange = e => { chart.ind.bbK = +e.target.value || 2; chart.dirty = true; checkAlert(false); };
  $("alertTF").onchange = () => { load(); }; // 얼럿 시간대 선택 → 해당 봉으로 차트 전환
  $("btnTestSound").onclick = () => { alertSound("PC"); setTimeout(() => alertSound("BB"), 500); };
  $("btnTestWav").onclick = () => playWav();
  const pineMap = [["tglPine", "master"], ["tglPineATR", "atr"], ["tglPineLR", "lr"], ["tglPineBBDC", "bbdc"], ["tglPineOsc", "osc"], ["tglPineRSI", "rsi"], ["tglPineMTF", "mtf"]];
  pineMap.forEach(([id, k]) => {
    $(id).onchange = e => {
      bundle.show[k] = e.target.checked;
      chart.dirty = true;
      if (k === "master" && e.target.checked) { ensureMTF(symbol, $("alertTF").value !== "chart" ? $("alertTF").value : tf); updatePineTable(true); }
      if (k === "mtf" || k === "master") updatePineTable(true);
    };
  });
  $("btnClearAlerts").onclick = () => { $("alertLog").innerHTML = ""; fired.clear(); };

  renderSymbolTabs(); renderTFTabs(); renderWatchlist(); updateCurSym(); renderAlertList(); ensureBg();
  startUsTimer();
  feed.onMode(feed.mode);
  // 저장된 키가 있으면 모의투자 자동 연결, 없으면 시뮬레이션
  (async () => {
    const appkey = $("kiwoomAppKey").value.trim(), secretkey = $("kiwoomSecret").value.trim();
    if (appkey && secretkey) {
      try {
        log("저장된 키로 자동 연결 중…");
        await doConnect(appkey, secretkey, $("kiwoomMock").checked);
        return;
      } catch (e) {
        log("자동 연결 실패: " + (e.message || e) + " → 시뮬레이션으로 시작");
      }
    } else {
      log("저장된 키 없음 → 시뮬레이션으로 시작. 키 입력 후 연결하면 다음부터 자동 연결.");
    }
    load();
  })();
})();

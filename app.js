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
  let unsub = null, lastBundleTs = 0, jumpTF = null;
  const fired = new Set(); // 중복 얼럿 방지: symbol@tf@barTime@type
  const touchState = new Map(); // 터치형 얼럿 진입 판정: symbol@tf@type -> touching?
  let bbBoost = null; // {startLen} — 급락 연속 얼럿 시 σ 2.2로 10봉간 상향
  let fireTimes = [];
  function noteFire() {
    // 2분 내 2회 발동 = 급락 연속 → σ 부스트
    const now = Date.now();
    fireTimes = fireTimes.filter(t => now - t < 120000);
    fireTimes.push(now);
    if (fireTimes.length >= 2 && !bbBoost) {
      bbBoost = { startLen: chart.bars.length };
      chart.ind.bbK = 2.2; $("bbK").value = "2.2"; chart.dirty = true;
      log("급락 연속 얼럿 → BB σ 2.2로 10봉간 상향");
    }
  }
  function checkBoostEnd() {
    if (bbBoost && chart.bars.length - bbBoost.startLen >= 10) {
      bbBoost = null; chart.ind.bbK = 2.0; $("bbK").value = "2"; chart.dirty = true;
      log("BB σ 2.0으로 복귀");
    }
  }

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
  function alertSound(kind, isTest) {
    if (!isTest) noteFire();
    if (!beepOn) return;
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
    // 상세 로그는 없애고 오른쪽 칩 스타일로만 기록 (클릭 점프 포함)
    const el = $("sigFeed");
    if (!el) return;
    const d = document.createElement("div");
    d.className = "sig-item";
    let txt = msg;
    if (lastAlertCtx) {
      const ctx = lastAlertCtx;
      const m = msg.match(/^\[([^\]]+)\]/);
      const label = symbolLabel(ctx.sym);
      txt = `${label} ${ctx.tf} ${m ? m[1] : (kind || "")} ${new Date().toLocaleTimeString()}`.trim();
      d.dataset.sym = ctx.sym; d.dataset.tf = ctx.tf;
      d.onclick = () => gotoAlert(ctx.sym, ctx.tf);
      lastAlertCtx = null;
    }
    d.textContent = txt;
    el.prepend(d);
    while (el.children.length > 50) el.lastChild.remove();
  }
  $("alertBanner").onclick = () => gotoAlert($("alertBanner").dataset.sym, $("alertBanner").dataset.tf);
  $("alertFlash").onclick = () => gotoAlert($("alertFlash").dataset.sym, $("alertFlash").dataset.tf);
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
      if (t === "1s" || t === "15s") b.classList.add("tiny");
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
  async function refreshChartSource() {
    // 차트가 시뮬이면 실데이터 재시도 (서버 뒤늦게 켜짐 등 대응) — 스크롤/세팅 유지
    if (!symbol || (feed._src || {})[symbol] !== "시뮬") return;
    try {
      const bars = await feed.getBars(symbol, tf);
      if ((feed._src || {})[symbol] !== "시뮬" && bars && bars.length) {
        chart.setBars(bars, TF[tf]);
        try { bundle.compute(bars, TF[tf]); } catch (e) { console.error("[bundle]", e); }
        ensureMTF(symbol, tf); updatePineTable(true);
        log(`차트 실데이터 확보: ${symbol} (${feed._src[symbol]})`);
      }
    } catch (_) {}
  }
  setInterval(() => {
    loadPrevCloses(); refreshChartSource(); ensureBg();
    alertSyms.forEach(id => { if (alertOn[id] === false && !alertManual[id]) probeAlert(id); });
  }, 60000); // 1분마다 미확보 데이터 재시도
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
    top.hidden = true; // 일간 진행률은 정보 스트립 칩으로 통합
    chart.dirty = true;
  }

  // ---------- 차트 로드 ----------
  async function load() {
    if (unsub) { unsub(); unsub = null; }
    if (!feed.symbols.some(s => s.id === symbol)) symbol = (feed.symbols[0] && feed.symbols[0].id) || "";
    if (!symbol) return;
    const alertTF = $("alertTF").value;
    let useTF = alertTF !== "chart" ? alertTF : tf; // 얼럿 시간대 지정 시 그 봉으로 차트 전환
    if (jumpTF && TF[jumpTF]) useTF = jumpTF; // 얼럿 클릭 점프 우선
    jumpTF = null;
    if (alertTF !== "chart" && alertTF !== tf) { tf = alertTF; renderTFTabs(); }
    if (useTF !== tf) { tf = useTF; renderTFTabs(); } // 점프 등으로 시간대 변경 시 동기화
    log(`getBars(${symbol}, ${useTF}) 요청`);
    const bars = await feed.getBars(symbol, useTF);
    chart.setBars(bars, TF[useTF]);
    bbBroken = false; // 종목/시간대 변경 시 2단계 무장 초기화
    autoAlert(symbol); // 시뮬 종목이면 얼럿 자동 OFF
    checkBoostEnd();
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
    $("btnFollow").textContent = "▶ 최신봉";
    renderSymbolTabs(); renderWatchlist(); syncAlertTFLabel(); updateCurSym(); renderAlertList(); ensureBg();
  }

  // ---------- 얼럿 판정 (소리+배너는 얼럿 종목만, 기록은 전부) ----------
  function audible(id) {
    return alertSyms.has(id) && alertOn[id] !== false && (feed._src || {})[id] !== "시뮬";
  }
  let bbBroken = false; // BB 하단 이탈 무장 상태 (2단계 얼럿용, 차트 종목)
  let wavAudio = null;
  function playWav(isTest) {
    if (!isTest) noteFire();
    if (!voiceOn) return;
    try {
      wavAudio = wavAudio || new Audio("alert.wav");
      wavAudio.currentTime = 0;
      const p = wavAudio.play();
      if (p && p.catch) p.catch(() => { alertSound("PC"); log("WAV 재생 차단 → 기본음"); });
    } catch (_) { alertSound("PC"); }
  }
  function checkAlert(isInitial) {
    checkBoostEnd();
    const v = chart.lastValues();
    if (!v || v.bbLow == null || v.pcLow == null) return;
    const tol = 1.0015; // 저가가 밴드하단 * 1.0015 이하이면 "닿음"
    const pcOn = $("alertPC").checked, bbOn = $("alertBB").checked;
    const pcTouch = pcOn && v.low <= v.pcLow * tol;
    const bbTouch = bbOn && v.low <= v.bbLow * tol;
    chart.signal = (pcTouch || bbTouch) ? { barTime: v.bar.time, pcTouch, bbTouch } : null;
    chart.dirty = true;
    if ((feed._src || {})[symbol] === "시뮬") return; // 시뮬 종목은 마커만, 얼럿 전체 스톱
    const key = (t) => `${symbol}@${tf}@${v.bar.time}@${t}`;
    // 터치형은 진입 엣지에만 발동 (급락 중 매봉 울림 방지 — 벗어났다 다시 닿으면 재발동)
    const pcEdge = pcTouch && !touchState.get(`${symbol}@${tf}@PC`);
    const bbEdge = bbTouch && !touchState.get(`${symbol}@${tf}@BB`);
    touchState.set(`${symbol}@${tf}@PC`, pcTouch);
    touchState.set(`${symbol}@${tf}@BB`, bbTouch);
    if (pcEdge && !fired.has(key("PC"))) {
      fired.add(key("PC"));
      if (audible(symbol)) {
        alertSound("PC");
        showBanner(symbol, "PC 하단 터치", tf);
        flash(`PC 하단 터치 ${symbol} ${fmtPrice(v.low)} ≤ ${fmtPrice(v.pcLow)}`);
      }
      alertLog(`[PC 하단] ${symbol} (${tf}) 저가 ${fmtPrice(v.low)} ≤ 하단 ${fmtPrice(v.pcLow)}`, "pc");
      log(`얼럿 PC 하단 터치 ${symbol} @${tf}`);
    }
    if (bbEdge && !fired.has(key("BB"))) {
      fired.add(key("BB"));
      if (audible(symbol)) {
        alertSound("BB");
        showBanner(symbol, "볼린저 하단 터치", tf);
        flash(`볼린저 하단 터치 ${symbol} ${fmtPrice(v.low)} ≤ ${fmtPrice(v.bbLow)}`);
      }
      alertLog(`[BB 하단] ${symbol} (${tf}) 저가 ${fmtPrice(v.low)} ≤ 하단 ${fmtPrice(v.bbLow)}`, "bb");
      log(`얼럿 BB 하단 터치 ${symbol} @${tf}`);
    }
    if (isInitial && !pcTouch && !bbTouch) { chart.signal = null; }
    // BB 중간선 상향돌파 → 매수준비 (기본 OFF)
    if ($("alertBBMid").checked) {
      const n = chart.bars.length;
      if (n >= 21) {
        const mid = chart.bb().mid;
        if (mid[n - 2] != null && mid[n - 1] != null &&
            chart.bars[n - 2].close <= mid[n - 2] && chart.bars[n - 1].close > mid[n - 1] && !fired.has(key("BBMID"))) {
          fired.add(key("BBMID"));
          if (audible(symbol)) {
            setTimeout(() => speak(symbol, "BB 중간", tf), 1200);
            showBanner(symbol, "BB 중간 상향돌파", tf);
            flash(`BB 중간 상향돌파 ${symbol}`);
          }
          alertLog(`[BB중간↑] ${symbol} (${tf})`, "bb");
          log(`얼럿 BB 중간 상향돌파 ${symbol} @${tf} (WAV)`);
        }
      }
    }
    // 거래량 20일선 상향통과 + BB 상단 돌파
    if ($("alertVolBB").checked) {
      const n = chart.bars.length;
      if (n >= 21) {
        const vols = chart.bars.map(b => b.volume);
        const vma = (i) => { let s = 0; for (let j = i - 19; j <= i; j++) s += vols[j]; return s / 20; };
        const bbu = chart.bb().up;
        if (bbu[n - 1] != null && bbu[n - 2] != null &&
            vols[n - 1] > vma(n - 1) && vols[n - 2] <= vma(n - 2) &&
            chart.bars[n - 1].close > bbu[n - 1] && !fired.has(key("VOLBB"))) {
          fired.add(key("VOLBB"));
          if (audible(symbol)) {
            alertSound("PC");
            showBanner(symbol, "거래량↑ BB상단 돌파", tf);
            flash(`거래량↑ BB상단 돌파 ${symbol}`);
          }
          alertLog(`[거래량↑BB상단] ${symbol} (${tf})`, "bb");
          log(`얼럿 거래량↑ BB상단 돌파 ${symbol} @${tf}`);
        }
      }
    }
    // PC 중심선 터치 → 매수준비 (기본 OFF)
    if ($("alertPCMid").checked && v.pcMid != null) {
      if (v.low <= v.pcMid * tol && v.high >= v.pcMid / tol && !fired.has(key("PCMID"))) {
        fired.add(key("PCMID"));
        if (audible(symbol)) {
          setTimeout(() => speak(symbol, "PC 중심", tf), 1200);
          showBanner(symbol, "PC 중심선 터치", tf);
          flash(`PC 중심선 터치 ${symbol}`);
        }
        alertLog(`[PC중심] ${symbol} (${tf})`, "pc");
        log(`얼럿 PC 중심선 터치 ${symbol} @${tf} (WAV)`);
      }
    }
    // BB(20,2) 하단이 BB(60,2) 하단을 뚫고 내려가면 얼럿
    if ($("alertBB60").checked) {
      const n = chart.bars.length;
      if (n >= 61) {
        const b20 = chart.bb(20, 2), b60 = chart.bb(60, 2);
        if (b20.lo[n - 2] != null && b60.lo[n - 2] != null && b60.lo[n - 1] != null &&
            b20.lo[n - 2] >= b60.lo[n - 2] && b20.lo[n - 1] < b60.lo[n - 1] && !fired.has(key("BB60"))) {
          fired.add(key("BB60"));
          if (audible(symbol)) {
            setTimeout(() => speak(symbol, "볼린저 20 60 하단 돌파", tf), 1200);
            showBanner(symbol, "BB20 하단↓BB60 하단", tf);
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
            setTimeout(() => speak(symbol, `PC ${side}`, tf), 1200);
            showBanner(symbol, `PC${side} 터치 (BB이탈 후)`, tf);
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
  function speak(id, cond, tflabel) {
    noteFire(); // 급락 연속 감지용 (음성 출력 여부와 무관)
    try {
      if (!voiceOn) return;
      if (!$("alertVoice").checked || !("speechSynthesis" in window)) return;
      const m = feed.symbols.find(s => s.id === id);
      const name = m && m.name && m.name !== m.id ? m.name : id; // 이름 우선, 없으면 번호
      const showTf = tflabel && tflabel !== "1m"; // 1분은 시간대 생략
      const txt = `${name}${cond ? " " + cond : ""}${showTf ? " " + tfKo(tflabel) : ""}`;
      const u = new SpeechSynthesisUtterance(txt);
      u.lang = "ko-KR"; u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (_) {}
  }
  function showBanner(symbol, kind, tflabel) {
    const el = $("alertBanner");
    el.textContent = `🔔 ${symbolLabel(symbol)} ${kind}${tflabel ? " " + tflabel : ""}`;
    el.style.top = "8px"; // 가격창 우상단 고정 (라벨 스트립과 겹치지 않게)
    el.hidden = false;
    el.dataset.sym = symbol; el.dataset.tf = tflabel || "";
    lastAlertCtx = { sym: symbol, tf: tflabel || "" };
  }
  let lastAlertCtx = null;
  function gotoAlert(sym, tfLabel) {
    if (!sym) return;
    if (!feed.symbols.some(s => s.id === sym)) { log("삭제된 종목이라 이동 불가: " + sym); return; }
    if (tfLabel && TF[tfLabel]) jumpTF = tfLabel;
    selectSymbol(sym);
  }
  function flash(msg) {
    const el = $("alertFlash");
    el.textContent = "🔔 " + msg;
    el.hidden = false;
    if (lastAlertCtx) { el.dataset.sym = lastAlertCtx.sym; el.dataset.tf = lastAlertCtx.tf; }
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (el.hidden = true), 4000);
  }

  // ---------- 백그라운드 얼럿 (차트에 안 띄워도 감시) ----------
  const CURATED_IDS = Datafeed.DEFAULT_SYMBOLS.filter(s => s.grp && s.grp !== "코인" && s.grp !== "추가" && !["069500", "148020", "KOSPI"].includes(s.id)).map(s => s.id);
  let _savedAlert = null;
  try { _savedAlert = JSON.parse(localStorage.getItem("alert_syms_v7") || "null"); } catch (_) {}
  const alertSyms = new Set((_savedAlert && _savedAlert.ids) || CURATED_IDS);
  const alertOn = ((_savedAlert && _savedAlert.on) || {}); // id -> false면 끔 (미지정은 켜짐)
  const alertManual = ((_savedAlert && _savedAlert.manual) || {}); // 사용자가 직접 켜고 끈 종목
  function saveAlertSyms() { try { localStorage.setItem("alert_syms_v7", JSON.stringify({ ids: [...alertSyms], on: alertOn, manual: alertManual })); } catch (_) {} }
  function autoAlert(id) {
    // 시뮬 데이터 종목은 얼럿 자동 OFF, 실데이터 복귀하면 자동 재개 (수동 설정은 존중)
    if (alertManual[id]) return;
    const src = (feed._src || {})[id];
    if (src === "시뮬" && alertOn[id] !== false) {
      alertOn[id] = false; saveAlertSyms(); renderAlertList();
      log(`얼럿 자동 OFF(시뮬 데이터): ${id}`);
    } else if (src && src !== "시뮬" && alertOn[id] === false) {
      alertOn[id] = true; saveAlertSyms(); renderAlertList();
      log(`얼럿 자동 재개(실데이터 ${src}): ${id}`);
      if (id !== symbol) bgAdd(id);
    }
  }
  async function probeAlert(id) {
    // 꺼져 있는 자동 종목의 실데이터 복귀 감시 (60초 간격)
    if (!alertSyms.has(id) || alertOn[id] !== false || alertManual[id] || bgPending[id + "@probe"]) return;
    bgPending[id + "@probe"] = 1;
    try {
      await feed.getBars(id, alertTFLabel(), 5);
      autoAlert(id);
      if (alertOn[id] !== false) bgAdd(id);
    } catch (_) {} finally { delete bgPending[id + "@probe"]; }
  }
  const bg = {}; // "id@tf" -> {bars, label, tfSec, bbBroken, fired:Set, unsub}
  const bgPending = {};
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
    if ((feed._src || {})[id] === "시뮬") return; // 시뮬 종목 얼럿 스톱
    const last = st.bars[st.bars.length - 1];
    const bb = lastBB(st.bars, chart.ind.bbN, chart.ind.bbK);
    const pc = lastPC(st.bars, chart.ind.pcLen);
    if (!bb || !pc) return;
    const tol = 1.0015;
    const key = (t) => `${id}@${st.label}@${last.time}@${t}`;
    st.touch = st.touch || {};
    const pcT = last.low <= pc.lo * tol, bbT = last.low <= bb.lo * tol;
    const pcEdge = pcT && !st.touch.PC, bbEdge = bbT && !st.touch.BB;
    st.touch.PC = pcT; st.touch.BB = bbT;
    if ($("alertPC").checked && pcEdge && !st.fired.has(key("PC"))) {
      st.fired.add(key("PC"));
      alertSound("PC"); showBanner(id, "PC 하단 터치", st.label); flash(`PC 하단 터치 ${id}`);
      alertLog(`[PC 하단] ${id} (${st.label}) 저가 ${fmtPrice(last.low)}`, "pc");
      log(`얼럿 PC 하단 터치 ${id} @${st.label}`);
    }
    if ($("alertBB").checked && bbEdge && !st.fired.has(key("BB"))) {
      st.fired.add(key("BB"));
      alertSound("BB"); showBanner(id, "볼린저 하단 터치", st.label); flash(`볼린저 하단 터치 ${id}`);
      alertLog(`[BB 하단] ${id} (${st.label}) 저가 ${fmtPrice(last.low)}`, "bb");
      log(`얼럿 BB 하단 터치 ${id} @${st.label}`);
    }
    if ($("alertPCMid").checked && pc.mid != null) {
      if (last.low <= pc.mid * tol && last.high >= pc.mid / tol && !st.fired.has(key("PCMID"))) {
        st.fired.add(key("PCMID"));
        setTimeout(() => speak(id, "PC 중심", st.label), 1200);
        showBanner(id, "PC 중심선 터치", st.label); flash(`PC 중심선 터치 ${id}`);
        alertLog(`[PC중심] ${id} (${st.label})`, "pc");
        log(`얼럿 PC 중심선 터치 ${id} @${st.label} (WAV)`);
      }
    }
    if ($("alertVolBB").checked && st.bars.length >= 21) {
      const bn = chart.ind.bbN, bk = chart.ind.bbK;
      const cl = st.bars.map(b => b.close), vs = st.bars.map(b => b.volume);
      const li2 = st.bars.length - 1;
      const sma = (arr, i, nn) => { let s = 0; for (let j = i - nn + 1; j <= i; j++) s += arr[j]; return s / nn; };
      const sdv = (arr, i, nn, m) => { let v = 0; for (let j = i - nn + 1; j <= i; j++) v += (arr[j] - m) ** 2; return Math.sqrt(v / nn); };
      const m = sma(cl, li2, bn), u = m + bk * sdv(cl, li2, bn, m);
      const vm = sma(vs, li2, 20), vmp = sma(vs, li2 - 1, 20);
      if (vs[li2] > vm && vs[li2 - 1] <= vmp && cl[li2] > u && !st.fired.has(key("VOLBB"))) {
        st.fired.add(key("VOLBB"));
        alertSound("PC"); showBanner(id, "거래량↑ BB상단 돌파", st.label); flash(`거래량↑ BB상단 돌파 ${id}`);
        alertLog(`[거래량↑BB상단] ${id} (${st.label})`, "bb");
        log(`얼럿 거래량↑ BB상단 돌파 ${id} @${st.label}`);
      }
    }
    if ($("alertBBMid").checked && st.bars.length >= 21) {
      const bn = chart.ind.bbN;
      const cl = st.bars.map(b => b.close);
      const li2 = st.bars.length - 1;
      const sm = (arr, i, nn) => { let s = 0; for (let j = i - nn + 1; j <= i; j++) s += arr[j]; return s / nn; };
      const mNow = sm(cl, li2, bn), mPrev = sm(cl, li2 - 1, bn);
      if (cl[li2 - 1] <= mPrev && cl[li2] > mNow && !st.fired.has(key("BBMID"))) {
        st.fired.add(key("BBMID"));
        setTimeout(() => speak(id, "BB 중간", st.label), 1200);
        showBanner(id, "BB 중간 상향돌파", st.label); flash(`BB 중간 상향돌파 ${id}`);
        alertLog(`[BB중간↑] ${id} (${st.label})`, "bb");
        log(`얼럿 BB 중간 상향돌파 ${id} @${st.label} (WAV)`);
      }
    }
    if ($("alertBB60").checked && st.bars.length >= 61) {
      const a20 = lastBB(st.bars, 20, chart.ind.bbK), a60 = lastBB(st.bars, 60, 2);
      const p20 = lastBB(st.bars.slice(0, -1), 20, chart.ind.bbK), p60 = lastBB(st.bars.slice(0, -1), 60, 2);
      if (a20 && a60 && p20 && p60 && p20.lo >= p60.lo && a20.lo < a60.lo && !st.fired.has(key("BB60"))) {
        st.fired.add(key("BB60"));
        setTimeout(() => speak(id, "볼린저 20 60 하단 돌파", st.label), 1200);
        showBanner(id, "BB20 하단↓BB60 하단", st.label); flash(`BB20 하단↓BB60 하단 ${id}`);
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
          setTimeout(() => speak(id, `PC ${side}`, st.label), 1200);
          showBanner(id, `PC${side} 터치 (BB이탈 후)`, st.label); flash(`PC${side} 터치 ${id} (WAV)`);
          alertLog(`[2단계 PC${side}] ${id} (${st.label})`, "pc");
          log(`얼럿 2단계 PC${side} 터치 ${id} @${st.label} (WAV)`);
          st.bbBroken = false;
        }
      }
    }
  }
  // 백그라운드 감시 시간대: 차트 시간대 + 5분 + 30분 (중복 제거)
  function targetLabels() {
    return [...new Set([alertTFLabel(), "5m", "30m"])];
  }
  const TF_KO = { "1s": "1초", "15s": "15초", "1m": "1분", "3m": "3분", "5m": "5분", "15m": "15분", "30m": "30분", "1h": "1시간", "4h": "4시간", "1D": "일봉", "1W": "주봉", "1M": "월봉" };
  function tfKo(label) { return TF_KO[label] || label; }
  const bgQueue = []; let bgWorking = false;
  async function bgPump() {
    if (bgWorking) return; bgWorking = true;
    while (bgQueue.length) {
      const fn = bgQueue.shift();
      try { await fn(); } catch (_) {}
      await new Promise(r => setTimeout(r, 300)); // 호출한도 보호
    }
    bgWorking = false;
  }
  function queueBg(fn) { bgQueue.push(fn); bgPump(); }
  async function bgAdd(id) {
    targetLabels().forEach(label => queueBg(() => bgAddOne(id, label)));
  }
  async function bgAddOne(id, label) {
    const key = id + "@" + label, tfSec = TF[label];
    const ex = bg[key];
    if (ex && ex.tfSec === tfSec) return;
    if (bgPending[key]) return;
    bgPending[key] = 1; bgRemoveOne(key);
    try {
      const bars = await feed.getBars(id, label);
      if (!bars || !bars.length || !alertSyms.has(id)) return;
      autoAlert(id);
      if (alertOn[id] === false) return; // 꺼져 있으면 감시 안 함
      if ((feed._src || {})[id] === "시뮬") { log(`얼럿 감시 제외(가짜데이터): ${id} — server.js 또는 키움 연결 필요`); return; }
      const st = { bars, label, tfSec, bbBroken: false, fired: new Set(), unsub: null };
      st.unsub = feed.subscribeBars(id, label, tick => {
        if (tick.symbol !== id || !bg[key]) return;
        const cur = rollBg(st, tick);
        if (cur) bgCheck(id, st);
      });
      bg[key] = st;
    } catch (_) {} finally { delete bgPending[key]; }
  }
  function bgRemoveOne(key) {
    if (bg[key]) { try { bg[key].unsub && bg[key].unsub(); } catch (_) {} delete bg[key]; }
    delete bgPending[key];
  }
  function bgRemove(id) {
    Object.keys(bg).forEach(k => { if (k === id || k.startsWith(id + "@")) bgRemoveOne(k); });
  }
  function ensureBg() {
    const labels = targetLabels();
    Object.keys(bg).forEach(k => {
      const at = k.lastIndexOf("@"), id = k.slice(0, at), lb = k.slice(at + 1);
      if (!alertSyms.has(id) || alertOn[id] === false || !labels.includes(lb) || bg[k].tfSec !== TF[lb]) bgRemoveOne(k);
    });
    alertSyms.forEach(id => {
      if (alertOn[id] === false) return;
      labels.forEach(lb => {
        const k = id + "@" + lb;
        if (!bg[k] && !bgPending[k]) queueBg(() => bgAddOne(id, lb));
      });
    });
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
      d.dataset.sym = id;
      const label = m && m.name && m.name !== m.id ? `${id} <small>${m.name}</small>` : id;
      const span = document.createElement("span"); span.innerHTML = label;
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = alertOn[id] !== false; cb.title = "얼럿 켜기/끄기";
      cb.onclick = (e) => e.stopPropagation();
      cb.onchange = () => {
        alertOn[id] = cb.checked; alertManual[id] = true; saveAlertSyms(); renderAlertList();
        if (cb.checked) bgAdd(id); else bgRemove(id);
        log(`얼럿 ${cb.checked ? "켜짐" : "꺼짐"}: ${id}`);
      };
      const si = document.createElement("i");
      const [stxt, scls] = srcTag(id);
      si.className = scls; si.textContent = stxt; si.title = "데이터 출처";
      const rm = document.createElement("button");
      rm.className = "rm"; rm.textContent = "✕"; rm.title = `${id} 얼럿 해제`;
      rm.onclick = () => {
        alertSyms.delete(id); delete alertOn[id]; delete alertManual[id];
        bgRemove(id); saveAlertSyms(); renderAlertList();
        log(`얼럿 해제: ${id}`);
      };
      d.append(span, si, cb, rm);
      d.onclick = () => selectSymbol(id);
      el.appendChild(d);
    });
    const onCount = [...alertSyms].filter(id => alertOn[id] !== false).length;
    $("alertCount").textContent = `${onCount}/${alertSyms.size}`;
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
      const px = document.createElement("div"); px.className = "px";
      const b = document.createElement("b"); b.textContent = "—";
      const em = document.createElement("em"); em.className = "chg";
      const si = document.createElement("i"); si.className = "src"; si.title = "데이터 출처";
      px.append(b, em, si);
      const rm = document.createElement("button");
      rm.className = "rm"; rm.textContent = "✕"; rm.title = `${s.id} 삭제`;
      rm.onclick = (e) => { e.stopPropagation(); removeSymbol(s.id); };
      d.append(span, px, rm);
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
    delete prevClose[id];
    delete rows[id];
    log(`종목 삭제: ${id}`);
    if (symbol === id) {
      if (feed.symbols.length) selectSymbol(feed.symbols[0].id);
      else { symbol = ""; chart.setBars([], chart.tfSec); renderSymbolTabs(); renderWatchlist(); updateCurSym(); }
    } else {
      renderSymbolTabs(); renderWatchlist(); updateCurSym();
    }
  }
  function srcTag(id) {
    const s = (feed._src || {})[id];
    if (s === "키움") return ["키움", "src live"];
    if (s === "야후") return ["야후", "src live"];
    if (s === "시뮬") return ["시뮬", "src sim"];
    return ["", "src"];
  }
  let prev = {};
  const prevClose = {}; // 전일종가 (등락률용)
  let prevLoading = false;
  let prevRun = 0;
  async function loadPrevCloses() {
    // 일봉 5개만 조회 (호출한도 절약) → 마지막 완성봉 = 전일종가
    // 새 호출이 오면 이전 실행은 중단 (시작 시 시뮬 실행이 키움 연결 후 조회를 막던 버그 수정)
    const my = ++prevRun;
    if (prevLoading) { await new Promise(r => setTimeout(r, 300)); if (my !== prevRun) return; }
    prevLoading = true;
    try {
      for (let pass = 0; pass < 3; pass++) {
        let missing = 0;
        for (const s of feed.symbols) {
          if (my !== prevRun) return;
          if (prevClose[s.id] && pass === 0) continue;
          try {
            const bars = await feed.getBars(s.id, "1D", 5);
            if (bars && bars.length >= 2 && (feed._src || {})[s.id] !== "시뮬") {
              prevClose[s.id] = bars[bars.length - 2].close;
            } else { delete prevClose[s.id]; missing++; }
          } catch (_) { delete prevClose[s.id]; missing++; }
          await new Promise(r => setTimeout(r, 200));
        }
        if (!missing) break;
      }
      log(`전일종가 ${Object.keys(prevClose).length}개 확인 (등락률 표시)`);
    } finally { if (my === prevRun) prevLoading = false; }
  }
  feed.onWatch = (spot) => {
    for (const id in spot) {
      const el = rows[id]; if (!el) continue;
      const b = el.querySelector("b");
      b.textContent = Number(spot[id]).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
      b.className = prev[id] != null ? (spot[id] >= prev[id] ? "up" : "down") : "";
      const em = el.querySelector("em");
      const pc = prevClose[id];
      if (em && pc) {
        const chg = (spot[id] - pc) / pc * 100;
        em.textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
        em.className = "chg " + (chg >= 0 ? "up" : "down");
      } else if (em) { em.textContent = ""; em.className = "chg"; }
      const si = el.querySelector("i.src");
      if (si) {
        const [txt, cls] = srcTag(id);
        if (si.textContent !== txt) { si.textContent = txt; si.className = cls; }
      }
    }
    prev = { ...spot };
    const cur = spot[symbol];
    if (cur) $("priceInfo").textContent = `${symbol} ${Number(cur).toLocaleString()} tick 수신 중 (${(feed._src || {})[symbol] || feed.mode})`;
  };
  // 얼럿 목록 출처 표시 갱신
  setInterval(() => {
    const al = $("alertList");
    if (!al) return;
    alertSyms.forEach(id => {
      const row = al.querySelector(`[data-sym="${CSS.escape(id)}"]`);
      if (!row) return;
      const si = row.querySelector("i.src");
      if (!si) return;
      const [txt, cls] = srcTag(id);
      if (si.textContent !== txt) { si.textContent = txt; si.className = cls; }
    });
  }, 2000);

  feed.onMode = (m) => {
    const dot = $("connDot"), txt = $("connText");
    if (m === "kiwoom") { dot.className = "dot online"; txt.textContent = "키움 실시간 연결"; }
    else if (m === "ws") { dot.className = "dot online"; txt.textContent = "WebSocket 연결"; }
    else { dot.className = "dot sim"; txt.textContent = "시뮬레이션 피드"; }
    syncAlertTFLabel();
  };

  // ---------- 키움 연결 (모의투자 전용 기본키 내장 — 실전키는 절대 여기에 넣지 말 것) ----------
  const DEFAULT_KW_APP = "x8sAlJAoICsTr_CHh_zHCeuBlj7huBgI5Wo57ela6Tc";
  const DEFAULT_KW_SEC = "zG-IUQO4KEVtXo3C5qq5uSV9zZCcQ04x1jXdC5LILek";
  try { // 입력값 유지 (매번 재입력 방지)
    $("kiwoomAppKey").value = localStorage.getItem("kw_app") || DEFAULT_KW_APP;
    $("kiwoomSecret").value = localStorage.getItem("kw_sec") || DEFAULT_KW_SEC;
    const m = localStorage.getItem("kw_mock");
    $("kiwoomMock").checked = m == null ? true : m === "1";
    const ps = localStorage.getItem("kw_poll");
    if (ps) { $("pollSec").value = ps; feed.setPollSec(ps); }
  } catch (_) {}
  $("pollSec").onchange = e => {
    const s = feed.setPollSec(e.target.value);
    try { localStorage.setItem("kw_poll", String(s)); } catch (_) {}
    log(`야후 폴링 간격 ${s}초로 변경 (실행 중 폴링에 즉시 적용)`);
  };
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
    loadPrevCloses();
    load();
  }
  $("btnKiwoomOff").onclick = () => { feed.disconnectKiwoom(); log("키움 해제 → 시뮬레이션"); load(); };

  // ---------- buy-monitor ON/OFF (작업 스케줄러 5분 스캔) ----------
  async function refreshMonitor() {
    try {
      const r = await fetch("/monitor-status");
      const j = await r.json();
      $("btnMonitor").textContent = j.enabled ? "모니터 끄기" : "모니터 켜기";
      $("monitorStatus").textContent = j.enabled ? "켜짐 (5분 스캔)" : "꺼짐";
    } catch (_) { $("monitorStatus").textContent = "서버 미연결 (node server.js 필요)"; }
  }
  $("btnMonitor").onclick = async () => {
    try {
      const cur = $("btnMonitor").textContent.includes("끄기");
      const r = await fetch("/monitor-toggle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !cur }) });
      const j = await r.json();
      $("btnMonitor").textContent = j.enabled ? "모니터 끄기" : "모니터 켜기";
      $("monitorStatus").textContent = j.enabled ? "켜짐 (5분 스캔)" : "꺼짐";
      log(`buy-monitor ${j.enabled ? "켜짐" : "꺼짐"}`);
    } catch (e) { log("모니터 전환 실패(서버 실행 확인): " + (e.message || e)); }
  };
  refreshMonitor();

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
        return;
      }
      const m2 = t.match(/^([A-Za-z0-9.\-^/]+)/);
      if (m2) {
        const id = m2[1].toUpperCase();
        const name = t.slice(m2[1].length).trim().replace(/^[\s\-_]+/, "");
        out.push({ id, name: name || id });
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
    loadPrevCloses();
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
    loadPrevCloses();
    selectSymbol(list[0].id);
  }
  $("btnQuickAdd").onclick = quickAdd;
  $("btnExportWatch").onclick = exportWatchlist;
  $("wlFile").addEventListener("change", e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { addCodes(String(r.result || "")); log(`관심종목 파일 반영: ${f.name}`); };
    r.readAsText(f, "utf-8");
    e.target.value = "";
  });
  $("btnExportAlerts").onclick = exportAlerts;
  let alertFileText = "";
  $("alertFile").addEventListener("change", e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { alertFileText = String(r.result || ""); log(`얼럿 파일 선택됨: ${f.name} — 가져오기를 누르세요`); };
    r.readAsText(f, "utf-8");
    e.target.value = "";
  });
  $("btnImportAlerts").onclick = () => {
    if (!alertFileText) { alert("먼저 얼럿 파일을 선택하세요."); return; }
    importAlerts(alertFileText);
    alertFileText = "";
  };
  $("quickCode").addEventListener("keydown", e => { if (e.key === "Enter") quickAdd(); });
  $("fileInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => addCodes(String(r.result || ""));
    r.readAsText(f, "utf-8");
    e.target.value = "";
  });
  $("btnLoadCodes").onclick = () => addCodes($("codeBox").value);
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportWatchlist() {
    const lines = ["# 관심종목 (종목번호 종목명) — 이름 고쳐서 하단 업로드로 가져오기"];
    feed.symbols.forEach(s => lines.push(`${s.id} ${(s.name && s.name !== s.id) ? s.name : ""}`.trim()));
    downloadText("관심종목.txt", lines.join("\n"));
    log(`관심종목 ${feed.symbols.length}개 다운로드`);
  }
  function exportAlerts() {
    const lines = ["# 얼럿종목 (종목번호 종목명) — 수정 후 아래 가져오기로 반영"];
    alertSyms.forEach(id => {
      const m = feed.symbols.find(s => s.id === id);
      lines.push(`${id} ${(m && m.name && m.name !== m.id) ? m.name : ""}`.trim());
    });
    downloadText("얼럿종목.txt", lines.join("\n"));
    log(`얼럿종목 ${alertSyms.size}개 다운로드`);
  }
  function importAlerts(text) {
    const list = parseCodeText(text);
    if (!list.length) { alert("인식된 종목이 없습니다."); return; }
    feed.addSymbols(list);
    // 이름 갱신 (같은 번호면 새 이름으로)
    list.forEach(({ id, name }) => {
      const m = feed.symbols.find(s => s.id === id);
      if (m && name && name !== id) m.name = name;
    });
    let n = 0;
    list.forEach(({ id }) => { if (!alertSyms.has(id)) { alertSyms.add(id); n++; } });
    saveAlertSyms(); renderAlertList(); renderWatchlist(); renderSymbolTabs(); ensureBg();
    log(`얼럿 가져오기: ${list.length}개 인식, ${n}개 신규 등록`);
  }
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
    $("btnFollow").textContent = "⏸ 최신봉";
  };
  function parseMA(text, fallback) {
    const ns = String(text).split(",").map(s => parseInt(s.trim(), 10)).filter(n => n >= 2 && n <= 2000).slice(0, 6);
    return ns.length ? ns : fallback.slice();
  }
  $("maShort").onchange = e => {
    chart.maShort = parseMA(e.target.value, [20, 50]);
    e.target.value = chart.maShort.join(",");
    chart.dirty = true;
  };
  $("maLong").onchange = e => {
    chart.maLong = parseMA(e.target.value, [100, 200]);
    e.target.value = chart.maLong.join(",");
    chart.dirty = true;
  };
  $("btnFollow").onclick = () => {
    chart.follow = !chart.follow;
    if (chart.follow) chart.view.offset = 0;
    $("btnFollow").classList.toggle("active", chart.follow);
    $("btnFollow").textContent = chart.follow ? "▶ 최신봉" : "⏸ 최신봉";
    chart.dirty = true;
  };
  let beepOn = false, voiceOn = false; // 시작 시 둘 다 무음
  $("btnBeep").textContent = "🔕";
  $("btnMute").textContent = "🔇";
  $("btnBeep").onclick = () => {
    beepOn = !beepOn;
    $("btnBeep").textContent = beepOn ? "🔔" : "🔕";
    log(beepOn ? "전자음 켜짐" : "전자음 꺼짐");
  };
  const syncVoice = () => {
    $("btnMute").textContent = voiceOn ? "🔊" : "🔇";
    $("alertVoice").checked = voiceOn;
  };
  $("btnMute").onclick = () => {
    voiceOn = !voiceOn; syncVoice();
    log(voiceOn ? "음성 켜짐 (WAV+종목안내)" : "음성 꺼짐");
  };
  $("alertVoice").onchange = e => { voiceOn = e.target.checked; syncVoice(); };
  syncVoice();
  $("btnReset").onclick = () => load();
  $("tglMA").onchange = e => { chart.show.maShort = e.target.checked; chart.dirty = true; };
  $("tglMALong").onchange = e => { chart.show.maLong = e.target.checked; chart.dirty = true; };
  $("tglBB").onchange = e => { chart.show.bb = e.target.checked; chart.dirty = true; checkAlert(false); };
  $("tglBB60").onchange = e => { chart.show.bb60 = e.target.checked; chart.dirty = true; };
  $("tglPC").onchange = e => { chart.show.pc = e.target.checked; chart.dirty = true; checkAlert(false); };
  $("tglVol").onchange = e => { chart.show.vol = e.target.checked; chart.dirty = true; };
  $("pcLen").onchange = e => { chart.ind.pcLen = Math.max(5, +e.target.value || 20); chart.dirty = true; checkAlert(false); };
  $("bbN").onchange = e => { chart.ind.bbN = Math.max(5, +e.target.value || 20); chart.dirty = true; checkAlert(false); };
  $("bbK").onchange = e => { chart.ind.bbK = +e.target.value || 2; bbBoost = null; chart.dirty = true; checkAlert(false); };
  $("alertTF").onchange = () => { load(); }; // 얼럿 시간대 선택 → 해당 봉으로 차트 전환
  $("btnTestSound").onclick = () => { alertSound("PC", true); setTimeout(() => alertSound("BB", true), 500); };
  $("btnTestWav").onclick = () => playWav(true);
  // ---------- 흐름 코치 (규칙 기반 브리핑) ----------
  function coachFor(id, bars, label) {
    const out = [];
    if (!bars || bars.length < 61) return out;
    const n = chart.ind.bbN, k = chart.ind.bbK, pcLen = chart.ind.pcLen;
    const last = bars[bars.length - 1], prev = bars[bars.length - 2];
    const cl = bars.map(b => b.close);
    const bbM = PineBundle.smaArr(cl, n), bbS = PineBundle.stdevArr(cl, n);
    const li = bars.length - 1;
    const blo = bbM[li] - k * bbS[li], bup = bbM[li] + k * bbS[li];
    const tail = bars.slice(-pcLen);
    const pcLo = Math.min(...tail.map(b => b.low)), pcUp = Math.max(...tail.map(b => b.high));
    const pcMid = (pcLo + pcUp) / 2;
    const rsiA = PineBundle.rsiArr(cl, 14), rsi = rsiA[li];
    const m20 = PineBundle.smaArr(cl, 20), m50 = PineBundle.smaArr(cl, 50);
    const vs = bars.map(b => b.volume);
    let vm = 0; for (let j = li - 19; j <= li; j++) vm += vs[j]; vm /= 20;
    const mc = PineBundle.macdArr(cl, 12, 26, 9);
    const dPct = (a, b) => ((a - b) / b) * 100;
    if (last.low >= blo) { const d = dPct(last.low, blo); if (d <= 0.3) out.push(`BB 하단 접근 중`); }
    else out.push(`BB 하단 이탈 중 (${fmtPrice(last.close)} < ${fmtPrice(blo)})`);
    if (last.high <= bup) { const d = dPct(bup, last.high); if (d <= 0.3) out.push(`BB 상단 접근 중`); }
    else out.push(`BB 상단 돌파 중`);
    if (last.low >= pcLo) { const d = dPct(last.low, pcLo); if (d <= 0.5) out.push(`PC 하단 접근 중`); }
    if (last.high <= pcUp) { const d = dPct(pcUp, last.high); if (d <= 0.5) out.push(`PC 상단 접근 중`); }
    if (Math.abs(last.close - pcMid) / pcMid * 100 <= 0.3) out.push(`PC 중심선 근처`);
    if (rsi != null && rsi <= 30) out.push(`RSI 과매도 (${rsi.toFixed(1)})`);
    else if (rsi != null && rsi >= 70) out.push(`RSI 과열 (${rsi.toFixed(1)})`);
    if (m20[li - 1] != null && m50[li - 1] != null) {
      if (m20[li - 1] <= m50[li - 1] && m20[li] > m50[li]) out.push(`MA20/50 골든크로스`);
      else if (m20[li - 1] >= m50[li - 1] && m20[li] < m50[li]) out.push(`MA20/50 데드크로스`);
    }
    if (bars.length >= 200) {
      let s200 = 0; for (let j = li - 199; j <= li; j++) s200 += cl[j]; s200 /= 200;
      out.push(last.close >= s200 ? `MA200 위 (추세↑)` : `MA200 아래 (추세↓)`);
    }
    if (last.volume > 2 * vm) out.push(`거래량 급증 (${(last.volume / vm).toFixed(1)}배)`);
    const hh = mc.h;
    if (hh[li] != null && hh[li - 1] != null) {
      if (hh[li - 1] <= 0 && hh[li] > 0) out.push(`MACD 매수 모멘텀 전환`);
      else if (hh[li - 1] >= 0 && hh[li] < 0) out.push(`MACD 매도 모멘텀 전환`);
    }
    void prev;
    return out.slice(0, 4).map(t => ({ id, label, text: t }));
  }
  function coachToast(id, label, text) {
    const box = $("coachBox");
    if (!box) return;
    const m = feed.symbols.find(s => s.id === id);
    const name = m && m.name && m.name !== m.id ? `${id} ${m.name}` : id;
    const d = document.createElement("div");
    d.className = "coach-toast";
    const b = document.createElement("b"); b.textContent = name;
    const s = document.createElement("span"); s.className = "c-tf"; s.textContent = label;
    const t = document.createElement("span"); t.textContent = " " + text;
    d.append(b, s, t);
    d.onclick = () => { d.remove(); gotoAlert(id, label); };
    box.appendChild(d);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { d.classList.add("fade"); setTimeout(() => d.remove(), 700); }, 12000);
  }
  let spokenKeys = new Map(); // 메시지 -> 마지막 알림 시각 (10분 지나면 반복)
  function coachBrief(manual) {
    const seen = new Set(), items = [];
    const push = (id, bars, label) => {
      const k = id + "@" + label;
      if (seen.has(k) || !bars || !bars.length) return;
      seen.add(k);
      coachFor(id, bars, label).forEach(o => items.push(o));
    };
    push(symbol, chart.bars, tf);
    Object.keys(bg).forEach(k => {
      const at = k.lastIndexOf("@");
      const id = k.slice(0, at);
      if (id === symbol || !bg[k]) return;
      push(id, bg[k].bars, bg[k].label);
    });
    const keyOf = (o) => `${o.id}@${o.label}@${o.text}`;
    const now = Date.now();
    const fresh = [];
    items.forEach(o => {
      const k = keyOf(o), ts = spokenKeys.get(k);
      if (manual || ts == null || now - ts > 10 * 60 * 1000) {
        fresh.push(o);
        spokenKeys.set(k, now);
      }
    });
    [...spokenKeys.keys()].forEach(k => {
      if (!items.some(o => keyOf(o) === k)) spokenKeys.delete(k);
    });
    if (manual && !items.length) coachToast(symbol, tf, "특이사항 없음");
    fresh.slice(0, 6).forEach(o => coachToast(o.id, o.label, o.text));
    fresh.slice(0, 3).forEach(o => coachSpeak(o.id, o.label, o.text));
    if (items.length) log(`코치 브리핑: ${items.length}건`);
  }
  let coachVoiceOn = false;
  $("btnCoach").onclick = () => coachBrief(true);
  $("btnCoachVoice").onclick = () => {
    coachVoiceOn = !coachVoiceOn;
    $("btnCoachVoice").classList.toggle("active", coachVoiceOn);
    log(coachVoiceOn ? "코치 음성 켜짐" : "코치 음성 꺼짐");
  };
  function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }
  function coachSpeak(id, label, text) {
    try {
      if (!coachVoiceOn || !("speechSynthesis" in window)) return;
      const m = feed.symbols.find(s => s.id === id);
      const name = m && m.name && m.name !== m.id ? m.name : id;
      const u = new SpeechSynthesisUtterance(`${name} ${tfKo(label)} ${text}`);
      u.lang = "ko-KR"; u.rate = 1.05;
      window.speechSynthesis.speak(u); // 큐에 쌓음
    } catch (_) {}
  }
  setInterval(() => coachBrief(false), 5 * 60 * 1000); // 5분마다 자동 브리핑
  $("btnAlertFold").onclick = () => {
    const c = $("alertPanel").classList.toggle("collapsed");
    $("btnAlertFold").textContent = c ? "▶" : "▼";
  };
  // 신호 피드 높이 조절 (패널 상단 손잡이 드래그)
  try {
    const lh = parseInt(localStorage.getItem("alert_log_h") || "", 10);
    if (lh >= 30 && lh <= 600) $("sigFeed").style.maxHeight = lh + "px";
  } catch (_) {}
  (() => {
    let resizing = false, sy = 0, sh = 0;
    const panel = $("sigPanel"), el = $("sigFeed");
    panel.addEventListener("mousedown", e => {
      const r = panel.getBoundingClientRect();
      if (e.clientY - r.top <= 10) { resizing = true; sy = e.clientY; sh = el.getBoundingClientRect().height; e.preventDefault(); }
    });
    window.addEventListener("mousemove", e => {
      if (!resizing) return;
      const h = Math.min(600, Math.max(30, sh - (e.clientY - sy)));
      el.style.maxHeight = h + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      try { localStorage.setItem("alert_log_h", String(Math.round(el.getBoundingClientRect().height))); } catch (_) {}
    });
  })();
  $("btnKiwoomFold").onclick = () => {
    const c = $("kiwoomPanel").classList.toggle("collapsed");
    $("btnKiwoomFold").textContent = c ? "▶" : "▼";
  };
  let sideOpen = true;
  try { if (localStorage.getItem("side_open") === "0") sideOpen = false; } catch (_) {}
  const applySide = () => {
    document.body.classList.toggle("side-collapsed", !sideOpen);
    $("btnSide").textContent = sideOpen ? "◀" : "▶";
  };
  $("btnSide").onclick = () => {
    sideOpen = !sideOpen;
    try { localStorage.setItem("side_open", sideOpen ? "1" : "0"); } catch (_) {}
    applySide();
  };
  applySide();
  // 사이드바 너비 조절 (좌측 경계 드래그, 240~700px, 저장됨)
  try {
    const w = parseInt(localStorage.getItem("side_w") || "", 10);
    if (w >= 240 && w <= 700) document.documentElement.style.setProperty("--side-w", w + "px");
  } catch (_) {}
  (() => {
    const bar = document.querySelector(".sidebar");
    let resizing = false, lastW = 380;
    bar.addEventListener("mousedown", e => {
      const r = bar.getBoundingClientRect();
      if (e.clientX - r.left <= 8) { resizing = true; e.preventDefault(); }
    });
    window.addEventListener("mousemove", e => {
      if (!resizing) return;
      lastW = Math.min(700, Math.max(240, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty("--side-w", lastW + "px");
    });
    window.addEventListener("mouseup", () => {
      if (!resizing) return;
      resizing = false;
      try { localStorage.setItem("side_w", String(lastW)); } catch (_) {}
    });
  })();
  const pineMap = [["tglPine", "master"], ["tglPineATR", "atr"], ["tglPineLR", "lr"], ["tglPineBBDC", "bbdc"], ["tglPineOsc", "osc"], ["tglPineRSI", "rsi"], ["tglPineATF", "atf"], ["tglPineMTF", "mtf"]];
  pineMap.forEach(([id, k]) => {
    $(id).onchange = e => {
      bundle.show[k] = e.target.checked;
      chart.dirty = true;
      if (k === "master" && e.target.checked) { ensureMTF(symbol, $("alertTF").value !== "chart" ? $("alertTF").value : tf); updatePineTable(true); }
      if (k === "mtf" || k === "master") updatePineTable(true);
    };
  });
  $("btnClearAlerts").onclick = () => { $("sigFeed").innerHTML = ""; fired.clear(); };

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
    loadPrevCloses(); // 지수 등 야후 종목도 등락률 표시
  })();
})();

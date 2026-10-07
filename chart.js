/* ChartEngine — HTML5 Canvas 기반 고성능 렌더링
 * 원칙: 캔들/지표는 DOM이 아닌 Canvas 픽셀 직접 렌더링. rAF + dirty-flag로 60fps 유지.
 * 지표: MA(5/20/60/100/200), Bollinger(n,k), PriceChannel(Donchian n)
 */
class ChartEngine {
  constructor(canvas, overlay) {
    this.cv = canvas; this.ov = overlay;
    this.ctx = canvas.getContext("2d");
    this.octx = overlay.getContext("2d");
    this.bars = [];
    this.tfSec = 15;
    this.view = { offset: 0, perRow: 9, volH: 0.18, oscH: 0.14, rsiH: 0.10 }; // 페인 비율 (드래그 조절)
    try {
      const s = JSON.parse(localStorage.getItem("pane_split") || "{}");
      ["volH", "oscH", "rsiH"].forEach(k => { if (s[k] > 0 && s[k] < 1) this.view[k] = s[k]; });
    } catch (_) {}
    this._gripHover = 0;
    this.yRange = null; // 수동 세로줌 (null=자동)
    this.padBars = 8; // 우측 여백 (봉 개수 단위)
    this.follow = true;
    this.show = { maShort: true, maLong: true, bb: true, bb60: true, pc: true, vol: true };
    this.maShort = [20, 50]; this.maLong = [100, 200]; // MA 기간 (설정 가능)
    this.bundle = null; // PineBundle (필수지표)
    this.ind = { pcLen: 60, bbN: 20, bbK: 2 };
    this.watermark = ""; // "005930 삼성전자" — 상/하단 흐릿 표시
    this.signal = null; // {barTime, pcTouch, bbTouch}
    this.mouse = null;
    this.dirty = true;
    this.fps = 0;
    this._bind();
    this._loop();
  }
  _bind() {
    const cv = this.cv;
    const resize = () => {
      const r = cv.parentElement.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const c of [this.cv, this.ov]) {
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
      }
      this.dpr = dpr; this.dirty = true;
    };
    new ResizeObserver(resize).observe(cv.parentElement);
    window.addEventListener("resize", resize); resize();

    let dragging = false, sx = 0, sy0 = 0, sOff = 0, gripDrag = 0, axisDrag = null, panY0 = null;
    const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
    const inAxis = (mx, my) => {
      const B = this._bounds;
      return !!(B && mx > B.plotW && my >= B.padT && my <= B.priceBottom && this._scale);
    };
    const gripAt = (mx, my) => {
      const B = this._bounds;
      if (!B || mx > B.plotW) return 0;
      for (let i = 0; i < B.grips.length; i++) {
        if (Math.abs(my - B.grips[i]) <= 7) return i + 1;
      }
      return 0;
    };
    cv.addEventListener("mousedown", e => {
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const g = gripAt(mx, my);
      if (g) { gripDrag = g; return; }
      if (inAxis(mx, my)) { // 가격축 드래그 = 세로 스케일
        axisDrag = { y0: my, hi: this._scale.hi, lo: this._scale.lo };
        return;
      }
      dragging = true; sx = e.clientX; sy0 = e.clientY; sOff = this.view.offset;
      panY0 = this._scale ? { hi: this._scale.hi, lo: this._scale.lo, priceH: this._scale.priceH } : null;
      this.follow = false; this.onFollowChange && this.onFollowChange(false);
    });
    window.addEventListener("mouseup", () => {
      if (gripDrag) {
        try { localStorage.setItem("pane_split", JSON.stringify({ volH: this.view.volH, oscH: this.view.oscH, rsiH: this.view.rsiH })); } catch (_) {}
      }
      dragging = false; gripDrag = 0; axisDrag = null;
    });
    window.addEventListener("mousemove", e => {
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      this.mouse = { x: mx, y: my, w: r.width, h: r.height };
      if (axisDrag && this._scale) {
        // 아래로 끌면 압축(범위 확대), 위로 끌면 확대(범위 축소), 중심 고정
        const dy = my - axisDrag.y0;
        const span0 = axisDrag.hi - axisDrag.lo;
        const c = (axisDrag.hi + axisDrag.lo) / 2;
        const span = clamp(span0 * (1 + dy / 200), span0 * 0.02, span0 * 30);
        this.yRange = { hi: c + span / 2, lo: c - span / 2 };
        this.dirty = true;
      } else if (gripDrag && this._bounds) {
        const B = this._bounds;
        if (gripDrag === 1) this.view.volH = clamp((B.volBottom - my) / B.plotH, 0.02, 0.6);
        if (gripDrag === 2) this.view.oscH = clamp((B.oscBottom - my) / B.plotH, 0.02, 0.5);
        if (gripDrag === 3) this.view.rsiH = clamp((B.rsiBottom - my) / B.plotH, 0.02, 0.4);
        this.dirty = true;
      } else if (dragging) {
        const B = this._bounds;
        const minOff = B ? -Math.max(10, Math.floor(B.plotW / this.view.perRow)) : -200;
        this.view.offset = Math.max(minOff, Math.round(sOff + (e.clientX - sx) / this.view.perRow));
        if (panY0 && panY0.priceH > 0) { // 상하 드래그 = 잡은 쪽으로 따라옴
          const dPrice = ((e.clientY - sy0) / panY0.priceH) * (panY0.hi - panY0.lo);
          this.yRange = { hi: panY0.hi + dPrice, lo: panY0.lo + dPrice };
        }
        this.dirty = true;
      } else {
        const hov = gripAt(mx, my);
        if (hov !== this._gripHover) { this._gripHover = hov; this.dirty = true; }
      }
      cv.style.cursor = (gripDrag || axisDrag || (!dragging && (this._gripHover || inAxis(mx, my)))) ? "ns-resize" : "";
    });
    cv.addEventListener("mouseleave", () => { this.mouse = null; this._gripHover = 0; cv.style.cursor = ""; });
    cv.addEventListener("wheel", e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this._vZoom(e); // Ctrl+스크롤 = 세로 줌
      else this.view.perRow = Math.min(40, Math.max(3, this.view.perRow * (e.deltaY > 0 ? 0.89 : 1.12)));
      this.dirty = true;
    }, { passive: false });
    cv.addEventListener("dblclick", () => { // 세로줌 리셋
      this.yRange = null;
      if (this.bundle) { this.bundle.oscZoom = 1; this.bundle.rsiZoom = 1; }
      this.dirty = true;
    });
  }
  _vZoom(e) {
    const r = this.cv.getBoundingClientRect();
    const my = e.clientY - r.top;
    const cl = (v, a, b) => Math.min(b, Math.max(a, v));
    // MACD/RSI 페인 위면 해당 스트립 세로 확대
    if (this.bundle && this._regions) {
      const R = this._regions;
      if (my >= R.oscTop && my < R.oscBottom && R.oscBottom > R.oscTop) {
        this.bundle.oscZoom = cl((this.bundle.oscZoom || 1) * (e.deltaY > 0 ? 0.89 : 1.12), 0.3, 5);
        return;
      }
      if (my >= R.rsiTop && my < R.rsiBottom && R.rsiBottom > R.rsiTop) {
        this.bundle.rsiZoom = cl((this.bundle.rsiZoom || 1) * (e.deltaY > 0 ? 0.89 : 1.12), 0.3, 5);
        return;
      }
    }
    // 가격창 세로 줌 (마우스 가격 고정)
    const S = this._scale;
    if (!S || !S.priceH) return;
    const f = e.deltaY > 0 ? 1.12 : 0.89;
    const p = S.hi - ((my - S.padT) / S.priceH) * (S.hi - S.lo);
    this.yRange = { hi: p + (S.hi - p) * f, lo: p - (p - S.lo) * f };
  }
  setBars(bars, tfSec) { this.bars = bars; this.tfSec = tfSec; this.view.offset = 0; this.signal = null; this.yRange = null; this.dirty = true; }
  applyTick(tick) {
    if (!this.bars.length) return null;
    let t;
    if (this.tfSec === 604800) { const d = new Date(tick.time); const day = (d.getDay() + 6) % 7; d.setHours(0, 0, 0, 0); t = Math.floor((d.getTime() - day * 86400000) / 1000); }
    else if (this.tfSec === 2592000) { const d = new Date(tick.time); t = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1).getTime() / 1000); }
    else t = Math.floor(tick.time / 1000 / this.tfSec) * this.tfSec;
    const last = this.bars[this.bars.length - 1];
    let cur;
    if (t > last.time) {
      cur = { time: t, open: last.close, high: tick.price, low: tick.price, close: tick.price, volume: tick.volume || 1 };
      this.bars.push(cur);
      if (this.bars.length > 20000) this.bars.splice(0, this.bars.length - 20000);
    } else if (t === last.time) {
      last.close = tick.price;
      if (tick.price > last.high) last.high = tick.price;
      if (tick.price < last.low) last.low = tick.price;
      last.volume += (tick.volume || 1) * 0.2;
      cur = last;
    } else { return null; }
    this.dirty = true;
    this.onTickApplied && this.onTickApplied(cur);
    return cur;
  }
  ma(n) {
    const out = new Array(this.bars.length).fill(null);
    let s = 0;
    for (let i = 0; i < this.bars.length; i++) {
      s += this.bars[i].close;
      if (i >= n) s -= this.bars[i - n].close;
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  bb(n, k) {
    n = n || this.ind.bbN; k = k == null ? this.ind.bbK : k;
    const mid = new Array(this.bars.length).fill(null), up = new Array(this.bars.length).fill(null), lo = new Array(this.bars.length).fill(null);
    let s = 0, s2 = 0;
    for (let i = 0; i < this.bars.length; i++) {
      const c = this.bars[i].close;
      s += c; s2 += c * c;
      if (i >= n) { const o = this.bars[i - n].close; s -= o; s2 -= o * o; }
      if (i >= n - 1) {
        const m = s / n;
        const v = Math.max(0, s2 / n - m * m);
        const sd = Math.sqrt(v);
        mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
      }
    }
    return { mid, up, lo };
  }
  // 프라이스채널(돈치안): n봉 중 최고고가 / 최저저가
  priceChannel(n) {
    n = n || this.ind.pcLen;
    const up = new Array(this.bars.length).fill(null), lo = new Array(this.bars.length).fill(null), mid = new Array(this.bars.length).fill(null);
    for (let i = n - 1; i < this.bars.length; i++) {
      let h = -Infinity, l = Infinity;
      for (let j = i - n + 1; j <= i; j++) {
        if (this.bars[j].high > h) h = this.bars[j].high;
        if (this.bars[j].low < l) l = this.bars[j].low;
      }
      up[i] = h; lo[i] = l; mid[i] = (h + l) / 2;
    }
    return { up, lo, mid };
  }
  // 얼럿 판정용 최신값
  lastValues() {
    const n = this.bars.length;
    if (!n) return null;
    const bb = this.bb(), pc = this.priceChannel();
    const i = n - 1;
    return {
      bar: this.bars[i],
      close: this.bars[i].close,
      low: this.bars[i].low,
      bbLow: bb.lo[i], bbMid: bb.mid[i], bbUp: bb.up[i],
      pcLow: pc.lo[i], pcMid: pc.mid[i], pcUp: pc.up[i],
    };
  }
  _geom() {
    const W = this.cv.width / this.dpr, H = this.cv.height / this.dpr;
    const padR = 84, padB = 22, padT = 10;
    return { W, H, padR, padB, padT, plotW: W - padR, plotH: H - padB - padT };
  }
  _visible() {
    const { plotW } = this._geom();
    const count = Math.max(10, Math.floor(plotW / this.view.perRow));
    const barSlots = Math.max(5, count - this.padBars); // 우측 여백 확보
    const rawEnd = this.bars.length - this.view.offset; // offset<0이면 미래 빈공간
    const end = Math.min(this.bars.length, rawEnd);
    const emptyRight = Math.max(0, rawEnd - end);
    const start = Math.max(0, end - (barSlots - emptyRight));
    return { start, end, count };
  }
  _loop() {
    let frames = 0, t0 = performance.now();
    const step = () => {
      requestAnimationFrame(step); // 루프를 먼저 예약 — 예외가 나도 절대 죽지 않음
      try {
        const now = performance.now();
        frames++;
        if (now - t0 >= 500) { this.fps = Math.round(frames * 1000 / (now - t0)); frames = 0; t0 = now; this.onFps && this.onFps(this.fps); }
        if (this.dirty) { this.dirty = false; this.render(); this.renderOverlay(); }
        else if (this.mouse) this.renderOverlay();
      } catch (e) {
        if (!this._errLogged || this._errLogged !== e.message) {
          this._errLogged = e.message;
          console.error("[chart]", e);
          this.onError && this.onError(e);
        }
      }
    };
    requestAnimationFrame(step);
  }
  render() {
    const { ctx, dpr } = { ctx: this.ctx, dpr: this.dpr };
    const { W, H, padR, padB, padT, plotW, plotH } = this._geom();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, W, H);
    // 워터마크 — 종목번호+종목명을 상/하단에 흐릿하게
    if (this.watermark) {
      ctx.save();
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 42px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(this.watermark, plotW / 2, padT + plotH * 0.24);
      ctx.fillText(this.watermark, plotW / 2, padT + plotH * 0.76);
      ctx.restore();
      ctx.textAlign = "left";
    }
    if (!this.bars.length) return;
    const { start, end } = this._visible();
    const slice = this.bars.slice(start, end);
    if (!slice.length) return;
    let hi = -Infinity, lo = Infinity, vmax = 0;
    slice.forEach(b => { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); vmax = Math.max(vmax, b.volume); });
    // 지표선도 스케일에 포함 (잘림 방지)
    const bb = this.bb(), pc = this.priceChannel();
    for (let i = start; i < end; i++) {
      [bb.up[i], bb.lo[i], pc.up[i], pc.lo[i]].forEach(v => {
        if (v != null) { if (v > hi) hi = v; if (v < lo) lo = v; }
      });
    }
    const pad = (hi - lo) * 0.08 || 1;
    hi += pad; lo -= pad;
    this._auto = { hi, lo };
    if (this.yRange) { hi = this.yRange.hi; lo = this.yRange.lo; }
    let volH = this.show.vol ? plotH * this.view.volH : 0;
    let oscH = (this.bundle && this.bundle.show.master && this.bundle.show.osc) ? plotH * this.view.oscH : 0;
    let rsiH = (this.bundle && this.bundle.show.master && this.bundle.show.osc && this.bundle.show.rsi) ? plotH * this.view.rsiH : 0;
    let priceH = plotH - volH - oscH - rsiH;
    if (priceH < 120) { // 가격창 최소 확보 — 페인 축소
      const tot = volH + oscH + rsiH;
      const k = tot > 0 ? Math.max(0, plotH - 120) / tot : 0;
      volH *= k; oscH *= k; rsiH *= k;
      priceH = plotH - volH - oscH - rsiH;
    }
    const y = p => padT + (1 - (p - lo) / (hi - lo)) * priceH;
    const x = i => (i + 0.5) * this.view.perRow;
    this._scale = { hi, lo, y, x, start, end, priceH, volH, oscH, rsiH, padT, plotW, plotH, perRow: this.view.perRow, H, padR };

    ctx.strokeStyle = "#1e2a44"; ctx.fillStyle = "#7d8aa3"; ctx.font = "10px system-ui"; ctx.lineWidth = 1;
    // 데이터 범위에 맞는 눈금 간격 (0.01/0.02/0.05/0.1/…/0.5/1/2/5…) — 약 10줄
    const rawStep = (hi - lo) / 10;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const norm = rawStep / mag;
    const gStep = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    let gl = 0;
    for (let p = Math.ceil((lo - 1e-9) / gStep) * gStep; p <= hi + gStep * 1e-6; p += gStep, gl++) {
      if (gl > 200) break; // 무한루프 방지용 안전장치 (정상은 ~15줄)
      const yy = Math.round(y(p)) + 0.5;
      const ly = Math.min(padT + plotH - 5, Math.max(padT + 9, yy + 4)); // 위아래 잘림 방지
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillText(fmtPrice(p), plotW + 6, ly);
    }
    ctx.textAlign = "center";
    const stepN = Math.max(1, Math.round(90 / this.view.perRow));
    for (let i = start; i < end; i += stepN) {
      ctx.fillText(fmtTime(this.bars[i].time, this.tfSec), x(i - start), H - 6);
    }
    ctx.textAlign = "left";

    if (this.show.vol) {
      const vy = h => padT + priceH + (1 - h / (vmax || 1)) * (volH - 4);
      slice.forEach((b, k) => {
        ctx.fillStyle = b.close >= b.open ? "#26a69a55" : "#ef535055";
        const bw = Math.max(1, this.view.perRow * 0.6);
        ctx.fillRect(x(k) - bw / 2, vy(b.volume), bw, (volH - 4) - (vy(b.volume) - (padT + priceH)));
      });
      // 거래량 20일선
      const vma = new Array(this.bars.length).fill(null);
      let vs = 0;
      for (let i = 0; i < this.bars.length; i++) {
        vs += this.bars[i].volume;
        if (i >= 20) vs -= this.bars[i - 20].volume;
        if (i >= 19) vma[i] = vs / 20;
      }
      ctx.strokeStyle = "#ffb300"; ctx.lineWidth = 1.4; ctx.beginPath();
      let vst = false;
      for (let i = start; i < end; i++) {
        if (vma[i] == null) continue;
        const xx = x(i - start), yy = vy(vma[i]);
        if (!vst) { ctx.moveTo(xx, yy); vst = true; } else ctx.lineTo(xx, yy);
      }
      ctx.stroke(); ctx.lineWidth = 1;
    }
    // 캔들 — DOM 없이 Canvas 직접 렌더링
    slice.forEach((b, k) => {
      const cx = x(k), bw = Math.max(1, this.view.perRow * 0.65);
      const up = b.close >= b.open;
      ctx.strokeStyle = up ? "#26a69a" : "#ef5350";
      ctx.fillStyle = up ? "#26a69a" : "#ef5350";
      ctx.beginPath(); ctx.moveTo(cx, y(b.high)); ctx.lineTo(cx, y(b.low)); ctx.stroke();
      const yo = y(b.open), yc = y(b.close);
      const top = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(cx - bw / 2, top, bw, hh);
    });

    const drawLine = (arr, color, width, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = width || 1.2;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      let s = false;
      for (let i = start; i < end; i++) {
        if (arr[i] == null) continue;
        const xx = x(i - start), yy = y(arr[i]);
        if (!s) { ctx.moveTo(xx, yy); s = true; } else ctx.lineTo(xx, yy);
      }
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };

    // MA: 단기/장기 (기간 설정 가능) + 우측 라벨 — 겹쳐도 구분되게 실선/점선 교대
    const maTags = [];
    const drawMA = (arr, n, color, width, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
      ctx.beginPath();
      let started = false, li = -1;
      for (let i = start; i < end; i++) {
        if (arr[i] == null) continue;
        const xx = x(i - start), yy = y(arr[i]);
        if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
        li = i;
      }
      ctx.stroke(); ctx.lineWidth = 1; ctx.setLineDash([]);
      if (li >= 0) maTags.push({ y: y(arr[li]), txt: "MA" + n, color });
    };
    if (this.show.maShort) {
      const pal = ["#2962ff", "#ffb300", "#e5c07b", "#7cb342", "#ba68c8", "#4dd0e1"];
      this.maShort.forEach((n, k) => drawMA(this.ma(n), n, pal[k % pal.length], k === 0 ? 2 : 1.6, k === 0 ? [] : [6, 3]));
    }
    if (this.show.maLong) {
      const pal = ["#00e5ff", "#ff6d00", "#f48fb1", "#aed581"];
      this.maLong.forEach((n, k) => drawMA(this.ma(n), n, pal[k % pal.length], k === 0 ? 2 : 1.6, k === 0 ? [] : [6, 3]));
    }
    if (maTags.length) {
      ctx.font = "10px system-ui";
      maTags.sort((a, b) => a.y - b.y);
      for (let k = 1; k < maTags.length; k++) {
        if (maTags[k].y - maTags[k - 1].y < 13) maTags[k].y = maTags[k - 1].y + 13;
      }
      maTags.forEach(t => {
        const yy = Math.min(padT + priceH - 8, Math.max(padT + 8, t.y));
        const tw = ctx.measureText(t.txt).width;
        const xx = plotW - tw - 12;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(xx - 3, yy - 9, tw + 6, 13);
        ctx.fillStyle = t.color;
        ctx.fillText(t.txt, xx, yy + 2);
      });
    }
    // Bollinger (2배 굵게)
    if (this.show.bb) {
      drawLine(bb.mid, "#78909c", 3);
      drawLine(bb.up, "#78909c88", 3, [5, 4]);
      drawLine(bb.lo, "#78909c88", 3, [5, 4]);
    }
    // Bollinger (60, 2) 추가 — 진한 회색, 가늘게
    if (this.show.bb60) {
      const b60 = this.bb(60, 2);
      drawLine(b60.mid, "#61616188", 1);
      drawLine(b60.up, "#757575", 1, [5, 4]);
      drawLine(b60.lo, "#757575", 1);
    }
    // Price Channel (5배 굵게)
    if (this.show.pc) {
      drawLine(pc.up, "#e5c07baa", 6);
      drawLine(pc.mid, "#ffd54fdd", 5, [3, 3]);
      drawLine(pc.lo, "#e5c07baa", 6);
      // PC 하단값 축 태그 (항상 인지 가능)
      const pv = pc.lo[pc.lo.length - 1];
      if (pv != null) {
        ctx.font = "11px system-ui";
        const txt = "PC " + fmtPrice(pv);
        const yy = Math.min(padT + priceH - 9, Math.max(padT, y(pv) - 9));
        ctx.fillStyle = "#e5c07b";
        ctx.fillRect(plotW + 1, yy, padR - 1, 18);
        ctx.fillStyle = "#000";
        ctx.fillText(txt, plotW + 6, yy + 13);
      }
      // PC 상단값 축 태그
      const ph = pc.up[pc.up.length - 1];
      if (ph != null) {
        ctx.font = "11px system-ui";
        const txt = "PC " + fmtPrice(ph);
        const yy = Math.min(padT + priceH - 9, Math.max(padT, y(ph) - 9));
        ctx.fillStyle = "#e5c07b88";
        ctx.fillRect(plotW + 1, yy, padR - 1, 18);
        ctx.fillStyle = "#000";
        ctx.fillText(txt, plotW + 6, yy + 13);
      }
    }
    // 필수지표(Pine 포팅) 오버레이 (예외 격리 — 번들 오류가 차트를 죽이지 않음)
    if (this.bundle && this.bundle.show.master) {
      try {
        this.bundle.draw(ctx, this._scale);
        this.bundle.drawMTF(ctx, this._scale);
        this.bundle.drawOsc(ctx, this._scale);
        this.bundle.drawRSI(ctx, this._scale);
        this.bundle.drawInfo(ctx, this._scale);
      } catch (e) {
        if (!this._bundleErr || this._bundleErr !== e.message) {
          this._bundleErr = e.message;
          console.error("[bundle]", e);
          this.onError && this.onError(new Error("필수지표: " + e.message));
        }
      }
    }
    // 페인 구분선 핸들 (드래그로 크기 조절)
    {
      const grips = [];
      if (volH > 0) grips.push(padT + priceH);
      if (oscH > 0) grips.push(padT + priceH + volH);
      if (rsiH > 0) grips.push(padT + priceH + volH + oscH);
      this._bounds = { grips, plotW, priceBottom: padT + priceH, volBottom: padT + priceH + volH, oscBottom: padT + priceH + volH + oscH, rsiBottom: padT + plotH, plotH, padT };
      this._regions = { oscTop: padT + priceH + volH, oscBottom: padT + priceH + volH + oscH, rsiTop: padT + priceH + volH + oscH, rsiBottom: padT + plotH };
      grips.forEach((gy, gi) => {
        const hov = this._gripHover === gi + 1;
        ctx.fillStyle = hov ? "#2962ff" : "#54627a99";
        const cx0 = plotW / 2 - 30;
        for (let d = 0; d < 6; d++) { ctx.beginPath(); ctx.arc(cx0 + d * 12, gy, hov ? 2.6 : 1.8, 0, Math.PI * 2); ctx.fill(); }
      });
    }

    // 얼럿 터치 마커 (마지막 바)
    if (this.signal) {
      const li = this.bars.length - 1;
      if (li >= start && li < end) {
        const b = this.bars[li];
        if (this.signal.bbTouch) {
          ctx.fillStyle = "#ffeb3b";
          ctx.beginPath(); ctx.arc(x(li - start), y(b.low) + 10, 5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#000"; ctx.font = "bold 8px system-ui"; ctx.fillText("B", x(li - start) - 3, y(b.low) + 13);
        }
        if (this.signal.pcTouch) {
          ctx.fillStyle = "#ff9800";
          ctx.beginPath(); ctx.arc(x(li - start), y(b.low) + 22, 5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "#000"; ctx.font = "bold 8px system-ui"; ctx.fillText("P", x(li - start) - 3, y(b.low) + 25);
        }
        ctx.font = "11px system-ui";
      }
    }

    const last = this.bars[this.bars.length - 1];
    const ly = y(last.close), upc = last.close >= last.open;
    ctx.setLineDash([4, 3]); ctx.strokeStyle = upc ? "#26a69a" : "#ef5350";
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = upc ? "#26a69a" : "#ef5350";
    ctx.fillRect(plotW + 1, ly - 9, padR - 1, 18);
    ctx.fillStyle = "#fff"; ctx.fillText(fmtPrice(last.close), plotW + 6, ly + 4);
  }
  renderOverlay() {
    const c = this.octx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const { W, H } = this._geom();
    c.clearRect(0, 0, W, H);
    if (!this.mouse || !this._scale) return;
    const { plotW, plotH, padT } = this._geom();
    const { hi, lo, priceH } = this._scale;
    const mx = Math.min(this.mouse.x, plotW), my = this.mouse.y;
    c.strokeStyle = "#54627a"; c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(mx, 0); c.lineTo(mx, plotH); c.stroke();
    c.beginPath(); c.moveTo(0, my); c.lineTo(plotW, my); c.stroke();
    c.setLineDash([]);
    const { start, end } = this._visible();
    const bi = start + Math.floor(mx / this.view.perRow);
    if (bi >= start && bi < end) this.onHover && this.onHover(this.bars[bi]);
    // 마우스 위치 가격 (차트 y() 매핑과 동일한 역함수)
    const price = hi - ((my - padT) / priceH) * (hi - lo);
    c.fillStyle = "#33415e";
    c.fillRect(plotW + 1, my - 9, 83, 18);
    c.fillStyle = "#fff"; c.font = "11px system-ui";
    c.fillText(fmtPrice(price), plotW + 6, my + 4);
    // 시간축 호버 라벨 (마우스 위치 시간 강조)
    if (bi >= start && bi < end && this.bars[bi]) {
      const txt = fmtTime(this.bars[bi].time, this.tfSec);
      c.font = "11px system-ui";
      const tw = c.measureText(txt).width;
      const bx = Math.min(Math.max(mx, tw / 2 + 4), plotW - tw / 2 - 4);
      c.fillStyle = "#2962ff";
      c.fillRect(bx - tw / 2 - 6, H - 18, tw + 12, 16);
      c.fillStyle = "#fff"; c.textAlign = "center";
      c.fillText(txt, bx, H - 6);
      c.textAlign = "left";
    }
  }
}

function fmtPrice(p) {
  if (p == null || isNaN(p)) return "—";
  if (p >= 10000) return p.toLocaleString("ko-KR", { maximumFractionDigits: 0 });
  if (p >= 1000) return p.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
  return p.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}
function fmtTime(ts, tfSec) {
  const d = new Date(ts * 1000);
  const M = String(d.getMonth() + 1).padStart(2, "0"), D = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0"), ss = String(d.getSeconds()).padStart(2, "0");
  if (tfSec < 60) return `${hh}:${mm}:${ss}`;
  if (tfSec < 86400) return `${M}/${D} ${hh}:${mm}`;
  return `${d.getFullYear()}-${M}-${D}`;
}

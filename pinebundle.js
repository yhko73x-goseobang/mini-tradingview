/* pinebundle.js — 필수지표모음.txt(Pine v6) 포팅
 * 그룹: ATR채널 / 선형회귀채널 / BB·돈치안 / RSI·MACD·다이버전스 / MTF신호·테이블
 * 통째 ON/OFF(master) + 그룹별 ON/OFF. 멀티TF는 리샘플(5m/15m/4H) + 별도봉(H1/D1/US100)으로 재현.
 * Pine request.security(D/W)는 H1/D1 봉 별도 조회로 대체. 4H 선형회귀(100)는 H1 300봉=75개로 부족 → 해당 조건만 제외.
 */
class PineBundle {
  constructor() {
    this.show = { master: true, atr: true, lr: true, bbdc: true, osc: true, rsi: true, mtf: true, atf: true };
    this.mt = { h1: [], d1: [], us: [] };
    this.oscZoom = 1; this.rsiZoom = 1; // Ctrl+스크롤 스트립 세로 확대
    this.tfSec = 60; this.tfLabel = "1m";
    this.cache = null; this.mtfCache = null;
    this._logged4h = false;
  }
  // ================= 기초 함수 =================
  static smaArr(v, n) {
    const o = new Array(v.length).fill(null); let s = 0;
    for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; }
    return o;
  }
  static emaArr(v, len) {
    const o = new Array(v.length).fill(null); if (v.length < len) return o;
    const k = 2 / (len + 1); let s = 0;
    for (let i = 0; i < len; i++) s += v[i];
    let p = s / len; o[len - 1] = p;
    for (let i = len; i < v.length; i++) { p = v[i] * k + p * (1 - k); o[i] = p; }
    return o;
  }
  static rmaArr(v, len) {
    const o = new Array(v.length).fill(null); if (v.length < len) return o;
    let s = 0; for (let i = 0; i < len; i++) s += v[i];
    let p = s / len; o[len - 1] = p;
    for (let i = len; i < v.length; i++) { p = (v[i] + p * (len - 1)) / len; o[i] = p; }
    return o;
  }
  static stdevArr(v, len) {
    const o = new Array(v.length).fill(null); let s = 0, s2 = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i]; s2 += v[i] * v[i];
      if (i >= len) { s -= v[i - len]; s2 -= v[i - len] * v[i - len]; }
      if (i >= len - 1) { const m = s / len; o[i] = Math.sqrt(Math.max(0, s2 / len - m * m)); }
    }
    return o;
  }
  static atrArr(h, l, c, len) {
    const tr = h.map((hh, i) => i === 0 ? hh - l[0] : Math.max(hh - l[i], Math.abs(hh - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    return PineBundle.rmaArr(tr, len);
  }
  static rsiArr(c, len) {
    const o = new Array(c.length).fill(null); if (c.length <= len) return o;
    let g = 0, lo = 0;
    for (let i = 1; i <= len; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else lo -= d; }
    g /= len; lo /= len;
    o[len] = lo === 0 ? 100 : 100 - 100 / (1 + g / lo);
    for (let i = len + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (len - 1) + Math.max(d, 0)) / len;
      lo = (lo * (len - 1) + Math.max(-d, 0)) / len;
      o[i] = lo === 0 ? 100 : 100 - 100 / (1 + g / lo);
    }
    return o;
  }
  static macdArr(c, f, s, sig) {
    const ef = PineBundle.emaArr(c, f), es = PineBundle.emaArr(c, s);
    const m = c.map((_, i) => (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]);
    const valid = m.map(v => v == null ? 0 : v);
    const sgRaw = PineBundle.emaArr(valid, sig);
    const sg = m.map((v, i) => v == null ? null : sgRaw[i]);
    const h = m.map((v, i) => (v == null || sg[i] == null) ? null : v - sg[i]);
    return { m, sg, h };
  }
  // Adaptive Trend Flow (Pine 03 이식: EMA10/20 + stdevTrailing + 강도 그라데이션)
  static emaSkipNull(v, len) {
    const o = new Array(v.length).fill(null);
    const k = 2 / (len + 1);
    let buf = [], p = null;
    for (let i = 0; i < v.length; i++) {
      if (v[i] == null) { o[i] = null; continue; }
      if (p == null) {
        buf.push(v[i]);
        if (buf.length >= len) { p = buf.reduce((a, b) => a + b, 0) / len; o[i] = p; }
      } else { p = v[i] * k + p * (1 - k); o[i] = p; }
    }
    return o;
  }
  static atfFull(typ, close, sens, lenA, smoothLen) {
    lenA = lenA || 10; smoothLen = smoothLen || 14;
    const n = typ.length;
    const fast = PineBundle.emaSkipNull(typ, lenA);
    const slow = PineBundle.emaSkipNull(typ, lenA * 2);
    const basis = typ.map((_, i) => (fast[i] == null || slow[i] == null) ? null : (fast[i] + slow[i]) / 2);
    const vol = PineBundle.stdevArr(typ, lenA);
    const svol = PineBundle.emaSkipNull(vol, smoothLen);
    const upper = typ.map((_, i) => (basis[i] == null || svol[i] == null) ? null : basis[i] + svol[i] * sens);
    const lower = typ.map((_, i) => (basis[i] == null || svol[i] == null) ? null : basis[i] - svol[i] * sens);
    const trend = new Array(n).fill(0), level = new Array(n).fill(null);
    const longX = [], shortX = [];
    const inten = new Array(n).fill(0);
    let tr = 0, lv = NaN, it = 0, pv = 0;
    for (let i = 0; i < n; i++) {
      if (basis[i] == null || upper[i] == null || lower[i] == null || close[i] == null) continue;
      if (tr === 0) { tr = close[i] > basis[i] ? 1 : -1; lv = tr === 1 ? lower[i] : upper[i]; }
      else if (tr === 1) { if (close[i] < lower[i]) { tr = -1; lv = upper[i]; } else lv = lower[i]; }
      else { if (close[i] > upper[i]) { tr = 1; lv = lower[i]; } else lv = upper[i]; }
      if (tr !== pv) { it = 0; pv = tr; }
      it = Math.min(it + 1, 20);
      trend[i] = tr; level[i] = lv; inten[i] = it;
      if (i > 0 && close[i - 1] != null && level[i - 1] != null) {
        if (close[i - 1] <= level[i - 1] && close[i] > lv) longX.push(i);
        if (close[i - 1] >= level[i - 1] && close[i] < lv) shortX.push(i);
      }
    }
    return { basis, upper, lower, trend, level, longX, shortX, inten };
  }
  // 선형회귀 채널 (Pine get_channel / f_get_lr_* 이식)
  static linregChArr(c, len, devlen) {
    const n = c.length;
    const mid = new Array(n).fill(null), top = new Array(n).fill(null), bot = new Array(n).fill(null), slopeA = new Array(n).fill(null);
    const hf = Math.floor(len / 2), corr = (1 - len % 2) / 2;
    for (let i = len - 1; i < n; i++) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let x = 0; x < len; x++) { const yv = c[i - len + 1 + x]; sx += x; sy += yv; sxx += x * x; sxy += x * yv; }
      const dn = len * sxx - sx * sx; if (!dn) continue;
      const slope = (len * sxy - sx * sy) / dn;
      const mean = sy / len;
      const intercept = mean - slope * hf + corr * slope;
      const endy = intercept + slope * (len - 1);
      let dev = 0;
      for (let x = 0; x < len; x++) { const yv = c[i - len + 1 + x]; const fit = slope * (len - x) + intercept; dev += (yv - fit) * (yv - fit); }
      dev = Math.sqrt(dev / len);
      mid[i] = mean; top[i] = endy + dev * devlen; bot[i] = endy - dev * devlen; slopeA[i] = slope;
    }
    return { mid, top, bot, slope: slopeA };
  }
  static highestArr(v, len) {
    const o = new Array(v.length).fill(null);
    for (let i = len - 1; i < v.length; i++) { let m = -Infinity; for (let j = i - len + 1; j <= i; j++) if (v[j] > m) m = v[j]; o[i] = m; }
    return o;
  }
  static lowestArr(v, len) {
    const o = new Array(v.length).fill(null);
    for (let i = len - 1; i < v.length; i++) { let m = Infinity; for (let j = i - len + 1; j <= i; j++) if (v[j] < m) m = v[j]; o[i] = m; }
    return o;
  }
  static resample(bars, targetSec) {
    if (!bars.length || targetSec <= 0) return [];
    const out = []; let cur = null;
    for (const b of bars) {
      const t = Math.floor(b.time / targetSec) * targetSec;
      if (!cur || cur.time !== t) { if (cur) out.push(cur); cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }; }
      else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume; }
    }
    if (cur) out.push(cur);
    return out;
  }
  static crossOver(a, b, i) { return i > 0 && a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i]; }
  static crossUnder(a, b, i) { return i > 0 && a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] >= b[i - 1] && a[i] < b[i]; }
  // 피벗 + 다이버전스 (Regular/Hidden × Bull/Bear)
  static divergence(c, h, l, osc, lbL, lbR) {
    const n = c.length, ev = [];
    const isPH = (j) => { if (j < lbL || j + lbR >= n) return false; for (let k = j - lbL; k <= j + lbR; k++) if (h[k] > h[j]) return false; return true; };
    const isPL = (j) => { if (j < lbL || j + lbR >= n) return false; for (let k = j - lbL; k <= j + lbR; k++) if (l[k] < l[j]) return false; return true; };
    let lastPH = -1, lastPL = -1, prevPH = -1, prevPL = -1;
    const inR = (a, b) => { const d = a - b; return d >= 5 && d <= 60; };
    for (let i = lbL + lbR; i < n; i++) {
      const j = i - lbR;
      if (isPH(j)) { prevPH = lastPH; lastPH = j; }
      if (isPL(j)) { prevPL = lastPL; lastPL = j; }
      if (isPL(j) && prevPL >= 0 && osc[j] != null && osc[prevPL] != null && inR(j, prevPL)) {
        if (l[j] < l[prevPL] && osc[j] > osc[prevPL]) ev.push({ i: j, type: "bull" });
        if (l[j] > l[prevPL] && osc[j] < osc[prevPL]) ev.push({ i: j, type: "hiddenBull" });
      }
      if (isPH(j) && prevPH >= 0 && osc[j] != null && osc[prevPH] != null && inR(j, prevPH)) {
        if (h[j] > h[prevPH] && osc[j] < osc[prevPH]) ev.push({ i: j, type: "bear" });
        if (h[j] < h[prevPH] && osc[j] > osc[prevPH]) ev.push({ i: j, type: "hiddenBear" });
      }
    }
    return ev;
  }

  // ================= 차트TF 연산 =================
  compute(bars, tfSec) {
    this.tfSec = tfSec || this.tfSec;
    const n = bars.length;
    if (!n) { this.cache = null; return null; }
    const c = bars.map(b => b.close), h = bars.map(b => b.high), l = bars.map(b => b.low);
    const ema5 = PineBundle.emaArr(c, 5), atr14 = PineBundle.atrArr(h, l, c, 14);
    const sh = (base, k) => base.map((v, i) => (v == null || atr14[i] == null) ? null : v + atr14[i] * k);
    const sl = (base, k) => base.map((v, i) => (v == null || atr14[i] == null) ? null : v - atr14[i] * k);
    const atr = {
      up2: sh(ema5, 5), lo2: sl(ema5, 5),
      up3: sh(ema5, 5.5), lo3: sl(ema5, 5.5),
      up15: sh(ema5, 1.5), lo15: sl(ema5, 1.5),
    };
    const lr = PineBundle.linregChArr(c, 100, 2.0);
    // BB (20/2.0, BB60) + 돈치안 멀티
    const bbM = PineBundle.smaArr(c, 20), bbS = PineBundle.stdevArr(c, 20);
    const bb = {
      up: bbM.map((m, i) => m == null ? null : m + 2 * bbS[i]),
      lo: bbM.map((m, i) => m == null ? null : m - 2 * bbS[i]),
      mid: bbM,
    };
    const bb60m = PineBundle.smaArr(c, 60), bb60s = PineBundle.stdevArr(c, 60);
    const bb60 = { up: bb60m.map((m, i) => m == null ? null : m + 2 * bb60s[i]), mid: bb60m };
    const dc = {
      up4: PineBundle.highestArr(h, 4), lo26: PineBundle.lowestArr(l, 26),
      up60: PineBundle.highestArr(h, 60), lo60: PineBundle.lowestArr(l, 60),
      up200: PineBundle.highestArr(h, 200), lo200: PineBundle.lowestArr(l, 200),
      lo4999: PineBundle.lowestArr(l, Math.min(4999, n)),
    };
    dc.mid = dc.up60.map((u, i) => (u == null || dc.lo60[i] == null) ? null : (u + dc.lo60[i]) / 2);
    // RSI + 어댑티브 스케일 오실레이터 (Pine 그대로)
    const rsi = PineBundle.rsiArr(c, 14);
    const macd = PineBundle.macdArr(c, 12, 26, 9);
    // 5m/15m MACD (Pine 기본 OFF였으나 요청으로 표시)
    const subMacd = (tsec) => {
      if (!(tfSec < tsec && tsec % tfSec === 0)) return null;
      const mb = PineBundle.resample(bars, tsec);
      if (!mb || mb.length < 35) return null;
      return { tsec, bars: mb, ...PineBundle.macdArr(mb.map(b => b.close), 12, 26, 9) };
    };
    const m5 = subMacd(300), m15 = subMacd(900);
    const absH = macd.h.map(v => v == null ? 0 : Math.abs(v));
    const momMax = PineBundle.highestArr(macd.h.map(v => v == null ? -Infinity : v), 50);
    const momMin = PineBundle.lowestArr(macd.h.map(v => v == null ? Infinity : v), 50);
    const macdMax = PineBundle.highestArr(macd.m.map(v => v == null ? -Infinity : v), 50);
    const macdMin = PineBundle.lowestArr(macd.m.map(v => v == null ? Infinity : v), 50);
    const midMom = PineBundle.highestArr(absH, 50);
    const sma50 = PineBundle.smaArr(c, 50);
    const osc = c.map((_, i) => {
      if (rsi[i] == null || momMax[i] == null || macdMax[i] == null || midMom[i] == null || sma50[i] == null) return null;
      const momR = momMax[i] - momMin[i], macdR = macdMax[i] - macdMin[i];
      const px = sma50[i], mult = px <= 1000 ? 50 : px <= 5000 ? 5 : 1;
      const ratio = (macdR > 0 && momR > 0) ? (momR / macdR) * 0.85 * mult : 1;
      const rscale = midMom[i] > 0 ? (midMom[i] / 50) * 0.9 : 1;
      return (rsi[i] - 50) * rscale * ratio;
    });
    const div = PineBundle.divergence(c, h, l, osc, 5, 5);
    // MACD 히스토그램 양전환(매수)/음전환(매도) 신호
    const macdSig = [];
    for (let i = 1; i < n; i++) {
      if (macd.h[i] == null || macd.h[i - 1] == null) continue;
      if (macd.h[i - 1] <= 0 && macd.h[i] > 0) macdSig.push({ i, type: "buy" });
      else if (macd.h[i - 1] >= 0 && macd.h[i] < 0) macdSig.push({ i, type: "sell" });
    }
    // Adaptive Trend Flow (민감도 0.5 / Slow 2.0)
    const typ = bars.map(b => (b.high + b.low + b.close) / 3);
    const atf = PineBundle.atfFull(typ, c, 0.5);
    const atfSlow = PineBundle.atfFull(typ, c, 2.0);
    // 강력 매수/매도 (BB하단 < DC하단)
    const sig = [];
    for (let i = 1; i < n; i++) {
      const strongBuy = bb.lo[i] != null && dc.lo60[i] != null && bb.lo[i] < dc.lo60[i] && !(c[i] > bb.mid[i]);
      const strongSell = bb.up[i] != null && dc.up60[i] != null && bb.up[i] > dc.up60[i] && !(c[i] < bb.mid[i]);
      const prevBuy = bb.lo[i - 1] != null && dc.lo60[i - 1] != null && bb.lo[i - 1] < dc.lo60[i - 1] && !(c[i - 1] > bb.mid[i - 1]);
      const prevSell = bb.up[i - 1] != null && dc.up60[i - 1] != null && bb.up[i - 1] > dc.up60[i - 1] && !(c[i - 1] < bb.mid[i - 1]);
      if (strongBuy && !prevBuy) sig.push({ i, type: "strongBuy", price: dc.lo60[i] });
      if (strongSell && !prevSell) sig.push({ i, type: "strongSell", price: dc.up60[i] });
      // 숏: 회귀상단 + 하락기울기
      if (lr.top[i] != null && lr.slope[i] != null && c[i] >= lr.top[i] && lr.slope[i] < 0) sig.push({ i, type: "short", price: dc.up60[i] });
    }
    // RSI 매수 마커 (RSI≤25)
    const rsiBuy = rsi.map((v, i) => (v != null && v <= 25 ? i : -1)).filter(i => i >= 0);
    // 5m/15m 선형회귀 (Pine show_5m/show_15m 기본 OFF지만 돌파 배경색은 동작 → 태그+틴트만)
    const subLR = (tsec) => {
      if (!(tfSec < tsec && tsec % tfSec === 0)) return null;
      const mb = PineBundle.resample(bars, tsec);
      if (!mb || mb.length < 100) return null;
      const cc = mb.map(b => b.close);
      const ch = PineBundle.linregChArr(cc, 100, 2.0);
      const li = mb.length - 1, ev = [];
      for (let i = Math.max(1, mb.length - 12); i < mb.length; i++) {
        if (PineBundle.crossOver(cc, ch.bot, i)) ev.push({ time: mb[i].time, txt: "5B", col: "#00c853" });
        if (PineBundle.crossOver(cc, ch.top, i)) ev.push({ time: mb[i].time, txt: "5T", col: "#009688" });
        if (PineBundle.crossUnder(cc, ch.top, i)) ev.push({ time: mb[i].time, txt: "5T↓", col: "#9c27b0" });
        if (PineBundle.crossUnder(cc, ch.bot, i)) ev.push({ time: mb[i].time, txt: "5B↓", col: "#ff5252" });
      }
      return {
        top: ch.top[li], bot: ch.bot[li],
        overB: PineBundle.crossOver(cc, ch.bot, li),
        overT: PineBundle.crossOver(cc, ch.top, li) || PineBundle.crossUnder(cc, ch.top, li),
        ev,
      };
    };
    const lr5 = subLR(300), lr15 = subLR(900);
    if (lr15) lr15.ev.forEach(e => { e.txt = e.txt.replace("5", "15"); });
    this.cache = { bars, atr, lr, lr5, lr15, bb, bb60, dc, rsi, macd, m5, m15, osc, div, sig, rsiBuy, macdSig, atf, atfSlow };
    return this.cache;
  }

  // ================= MTF 연산 (H1/D1/US100) =================
  computeMTF() {
    const out = { h1: null, d1: null, usRsi: null, usBuy: false };
    const pack = (bars) => {
      if (!bars || bars.length < 61) return null;
      const c = bars.map(b => b.close), h = bars.map(b => b.high), l = bars.map(b => b.low);
      const m20 = PineBundle.smaArr(c, 20), sd = PineBundle.stdevArr(c, 20);
      const lr = PineBundle.linregChArr(c, Math.min(100, bars.length), 2.0);
      const bbM = m20, bbL20 = m20.map((m, i) => m == null ? null : m - 1.95 * sd[i]);
      const bbU20 = m20.map((m, i) => m == null ? null : m + 1.95 * sd[i]);
      const bbL19 = m20.map((m, i) => m == null ? null : m - 1.9 * sd[i]);
      const dcU = PineBundle.highestArr(h, 60), dcL = PineBundle.lowestArr(l, 60);
      const sig = [];
      for (let i = 1; i < bars.length; i++) {
        const cnd1 = dcL[i] != null && l[i] <= dcL[i] && PineBundle.crossOver(c, dcL, i);
        const cnd2 = bbL20[i] != null && l[i] <= bbL20[i] && PineBundle.crossOver(c, bbL20, i);
        const cnd3 = lr.bot[i] != null && l[i] <= lr.bot[i] && PineBundle.crossOver(c, lr.bot, i);
        const cnd4 = bbL19[i] != null && PineBundle.crossOver(c, bbL19, i);
        if (cnd1 || cnd2 || cnd3 || cnd4) sig.push(i);
      }
      const li = bars.length - 1;
      return { dcU: dcU[li], dcL: dcL[li], bbL20: bbL20[li], bbU20: bbU20[li], bbM: bbM[li], lrBot: lr.bot[li], lrTop: lr.top[li], sigIdx: sig };
    };
    if (this.mt.h1.length) {
      out.h1 = pack(this.mt.h1);
      const f4 = PineBundle.resample(this.mt.h1, 14400);
      this._lastF4 = f4;
      out.h4 = f4.length >= 61 ? pack(f4) : null;
      if (!out.h4 && !this._logged4h) { this._logged4h = true; }
    }
    if (this.mt.d1.length) out.d1 = pack(this.mt.d1);
    if (this.mt.us.length) {
      const uc = this.mt.us.map(b => b.close);
      const uh = this.mt.us.map(b => b.high), ul = this.mt.us.map(b => b.low);
      const ur = PineBundle.rsiArr(uc, 14);
      out.usRsi = ur[ur.length - 1];
      out.usBuy = out.usRsi != null && out.usRsi <= 30;
      const utyp = this.mt.us.map((b, i) => (uh[i] + ul[i] + uc[i]) / 3);
      out.usATF = PineBundle.atfFull(utyp, uc, 0.4);
      if (this.mt.us.length >= 100) {
        const ch = PineBundle.linregChArr(uc, 100, 2.0);
        const li = uc.length - 1;
        out.usLR = { top: ch.top[li], bot: ch.bot[li], close: uc[li] };
      }
    }
    this.mtfCache = out;
    return out;
  }

  // ================= 그리기 =================
  _line(ctx, arr, x, y, start, end, color, w, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = w || 1; ctx.setLineDash(dash || []);
    ctx.beginPath(); let s = false;
    for (let i = start; i < end; i++) {
      if (arr[i] == null) continue;
      const xx = x(i - start), yy = y(arr[i]);
      if (!s) { ctx.moveTo(xx, yy); s = true; } else ctx.lineTo(xx, yy);
    }
    ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
  }
  _fill(ctx, a1, a2, x, y, start, end, color) {
    const pts = [];
    for (let i = start; i < end; i++) {
      if (a1[i] == null || a2[i] == null) continue;
      pts.push([x(i - start), y(a1[i]), y(a2[i])]);
    }
    if (pts.length < 2) return;
    ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    pts.forEach(p => ctx.lineTo(p[0], p[1]));
    for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], pts[k][2]);
    ctx.closePath(); ctx.fill();
  }
  draw(ctx, S) {
    if (!this.show.master || !this.cache) return;
    const { x, y, start, end } = S;
    const C = this.cache, sh = this.show;
    ctx.save();
    // ATR 채널 (1.5×만 표시 — 5/5.5는 너무 넓어서 제외, US100 채우기 계산용 값은 유지)
    if (sh.atr) {
      this._line(ctx, C.atr.up15, x, y, start, end, "#ff525055", 1);
      this._line(ctx, C.atr.lo15, x, y, start, end, "#26a69a55", 1);
    }
    // 선형회귀 채널
    if (sh.lr) {
      this._line(ctx, C.lr.top, x, y, start, end, "#ffa200", 2);
      this._line(ctx, C.lr.bot, x, y, start, end, "#ffa200", 2);
      this._line(ctx, C.lr.mid, x, y, start, end, "#4eafff88", 1, [4, 3]);
      // 우측 라벨 T/B/회귀
      const li = C.bars.length - 1;
      const rtag = (val, txt, bgc) => {
        if (val == null) return;
        ctx.font = "10px system-ui"; ctx.textAlign = "left";
        ctx.fillStyle = bgc; ctx.fillRect(S.plotW + 2, y(val) - 8, 60, 14);
        ctx.fillStyle = "#fff"; ctx.fillText(txt, S.plotW + 6, y(val) + 3);
      };
      rtag(C.lr.top[li], "T", "#ffa200");
      rtag(C.lr.bot[li], "B", "#ffa200");
      rtag(C.lr.mid[li], "회귀", "#4eafff");
      // 5m/15m 돌파 틴트 + 태그 + 이벤트
      [["lr5", "5"], ["lr15", "15"]].forEach(([k, pre]) => {
        const L = C[k];
        if (!L) return;
        if (L.overB) { ctx.fillStyle = "#ffff0040"; ctx.fillRect(0, S.padT, S.plotW, S.priceH); }
        if (L.overT) { ctx.fillStyle = "#01030a88"; ctx.fillRect(0, S.padT, S.plotW, S.priceH); }
        rtag(L.top, pre + "T", "#fac473");
        rtag(L.bot, pre + "B", "#c07300");
      });
      const markEv = (evArr) => {
        ctx.font = "bold 10px system-ui"; ctx.textAlign = "center";
        (evArr || []).forEach(e => {
          let ci = -1;
          for (let k2 = end - 1; k2 >= start; k2--) {
            const b = C.bars[k2];
            if (e.time >= b.time && e.time < b.time + this.tfSec) { ci = k2; break; }
          }
          if (ci < 0) return;
          ctx.fillStyle = e.col;
          ctx.fillText(e.txt, x(ci - start), y(C.bars[ci].low) + 48);
        });
      };
      if (C.lr5) markEv(C.lr5.ev);
      if (C.lr15) markEv(C.lr15.ev);
    }
    // BB·돈치안 (Pine 스타일)
    if (sh.bbdc) {
      this._line(ctx, C.dc.up60, x, y, start, end, "#f2ff0088", 4);
      this._line(ctx, C.dc.lo60, x, y, start, end, "#f2ff0088", 4);
      this._line(ctx, C.bb.up, x, y, start, end, "#ffffff", 2);
      this._line(ctx, C.bb.lo, x, y, start, end, "#ffffff", 2);
      this._line(ctx, C.bb.mid, x, y, start, end, "#ffffffaa", 1);
      this._line(ctx, C.bb60.up, x, y, start, end, "#ffb84e88", 1);
      // BB하단 < DC하단 강력구간 채우기
      const cond = C.bars.map((b, i) => (C.bb.lo[i] != null && C.dc.lo60[i] != null && C.bb.lo[i] < C.dc.lo60[i] && !(b.close > C.bb.mid[i])) ? 1 : null);
      const up = cond.map((v, i) => v ? C.bb.lo[i] : null), lo = cond.map((v, i) => v ? C.dc.lo60[i] : null);
      this._fill(ctx, up, lo, x, y, start, end, "#00ff0844");
      // PC 하단선 아래 한줄 라벨: BW/DC폭 + 일간 변동 (Pine combinedBbwDcTxt + rangeTxt01)
      {
        const li = C.bars.length - 1, last = C.bars[li];
        const bbw = (C.bb.mid[li] && C.bb.up[li] != null) ? ((C.bb.up[li] - C.bb.lo[li]) / C.bb.mid[li]) * 100 : null;
        const dcW = (C.dc.lo60[li] && C.dc.up60[li] != null) ? ((C.dc.up60[li] - C.dc.lo60[li]) / C.dc.lo60[li]) * 100 : null;
        const f1 = (v) => v == null ? "—" : v.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
        let txt = `BW ${bbw == null ? "—" : bbw.toFixed(1) + "%"},   DC ${dcW == null ? "—" : dcW.toFixed(1) + "%"} ( ${f1(C.dc.lo200[li])} / ${f1(C.dc.lo60[li])} ~ ${f1(C.dc.up60[li])} )`;
        let txt2 = "";
        const d1 = this.mt.d1;
        if (d1 && d1.length >= 2 && last) {
          const today = d1[d1.length - 1], prev = d1[d1.length - 2];
          const dr = today.high - today.low;
          const tv = today.low > 0 ? (dr / today.low) * 100 : 0;
          const cp = dr > 0 ? ((last.close - today.low) / dr) * 100 : 50;
          const pos = Math.max(0, Math.min(2, Math.round((cp / 100) * 2)));
          const prog = ["─", "─", "─"]; prog[pos] = "●";
          txt2 = `${prog.join("")} (${cp.toFixed(1)}%) 일간 ${tv.toFixed(1)}% (${f1(dr)})`;
        }
        ctx.font = "11px system-ui";
        const line = (txt2 ? txt2 + "   " : "") + txt;
        const tw = ctx.measureText(line).width;
        const endX = x(Math.max(start, end - 1) - start); // 마지막 캔들에 딱 맞춤
        const xx = Math.max(4, endX - tw), yy = y(C.dc.lo60[li] != null ? C.dc.lo60[li] : last.low) + 20;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(xx - 4, yy - 12, tw + 8, 17);
        ctx.fillStyle = "#ffffff"; ctx.textAlign = "left";
        ctx.fillText(line, xx, yy);
        ctx.textAlign = "left";
      }
    }
    // RSI·MACD 마커 + 다이버전스 + 배경틴트
    if (sh.osc && this.mtfCache) {
      const M = this.mtfCache;
      const rsiLast = C.rsi[C.rsi.length - 1];
      const buyMain = rsiLast != null && rsiLast <= 25;
      const buyUs = !!M.usBuy;
      if (buyMain || buyUs) {
        ctx.fillStyle = buyMain && buyUs ? "#bfff0014" : buyMain ? "#00ff0814" : "#0080ff14";
        ctx.fillRect(0, S.padT, S.plotW, S.priceH);
      }
      // US100 천장/바닥 겹침 채우기 (차트 ATR밴드 구간 + US100 조건)
      if (M.usLR) {
        const uBot = M.usLR.close < M.usLR.bot, uTop = M.usLR.close > M.usLR.top;
        if (uBot) this._fill(ctx, C.atr.lo2, C.atr.lo3, x, y, start, end, "#0000ff4d");
        if (uTop) this._fill(ctx, C.atr.up2, C.atr.up3, x, y, start, end, M.usLR.close > (C.atr.up2[C.atr.up2.length - 1] || 0) ? "#ff000099" : "#0000ff80");
      }
      // RSI B 마커 (하단)
      ctx.font = "bold 10px system-ui"; ctx.textAlign = "center";
      C.rsiBuy.forEach(i => {
        if (i < start || i >= end) return;
        const xx = x(i - start), yy = y(C.bars[i].low);
        ctx.fillStyle = "#00ff22"; ctx.beginPath(); ctx.arc(xx, yy + 12, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#00ff22"; ctx.fillText("B", xx, yy + 26);
      });
      // US100 ■ 마커
      if (buyUs && C.bars.length) {
        const li = C.bars.length - 1;
        if (li >= start && li < end) {
          const xx = x(li - start), yy = y(C.bars[li].low);
          ctx.fillStyle = "#00b7ff"; ctx.fillRect(xx - 5, yy + 18, 10, 10);
          ctx.fillStyle = "#00b7ff"; ctx.fillText("■", xx, yy + 42);
        }
      }
      // 다이버전스 라벨
      const dvTxt = { bull: ["Bull", "#00c853"], hiddenBull: ["H Bull", "#00c853"], bear: ["Bear", "#ff5252"], hiddenBear: ["H Bear", "#ff5252"] };
      C.div.forEach(d => {
        if (d.i < start || d.i >= end) return;
        const [txt, col] = dvTxt[d.type];
        const xx = x(d.i - start);
        const yy = d.type.includes("ull") ? y(C.bars[d.i].low) + 36 : y(C.bars[d.i].high) - 24;
        ctx.fillStyle = col; ctx.fillText(txt, xx, yy);
      });
      // MACD 매수▲/매도▼
      C.macdSig.forEach(s => {
        if (s.i < start || s.i >= end) return;
        const xx = x(s.i - start);
        if (s.type === "buy") {
          ctx.fillStyle = "#00e676";
          ctx.beginPath(); ctx.moveTo(xx, y(C.bars[s.i].low) + 26); ctx.lineTo(xx - 5, y(C.bars[s.i].low) + 34); ctx.lineTo(xx + 5, y(C.bars[s.i].low) + 34); ctx.closePath(); ctx.fill();
        } else {
          ctx.fillStyle = "#ff1744";
          ctx.beginPath(); ctx.moveTo(xx, y(C.bars[s.i].high) - 26); ctx.lineTo(xx - 5, y(C.bars[s.i].high) - 34); ctx.lineTo(xx + 5, y(C.bars[s.i].high) - 34); ctx.closePath(); ctx.fill();
        }
      });
    }
    // Adaptive Trend Flow (trailing 레벨 점선 + 상단 추세 도트 + L1/S1/L2/S2)
    if (sh.atf && C.atf) {
      const A = C.atf, AS = C.atfSlow;
      this._line(ctx, A.level, x, y, start, end, "#ffffff55", 1, [2, 2]);
      // 상단 추세 도트 (정보 스트립 아래 레인 — 겹침 방지)
      const dotY = Math.max(S.padT + 30, (this._infoBottom || S.padT + 22) + 6);
      for (let i = start; i < end; i++) {
        if (!A.trend[i]) continue;
        const a = 0.35 + 0.25 * ((A.inten[i] || 0) / 20);
        ctx.fillStyle = A.trend[i] === 1 ? `rgba(0,165,8,${a.toFixed(2)})` : `rgba(248,53,86,${a.toFixed(2)})`;
        ctx.beginPath(); ctx.arc(x(i - start), dotY, 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.font = "bold 10px system-ui"; ctx.textAlign = "center";
      const lab = (idxArr, txt, col, above) => {
        idxArr.forEach(i => {
          if (i < start || i >= end) return;
          const xx = x(i - start);
          ctx.fillStyle = col;
          ctx.fillText(txt, xx, above ? y(C.bars[i].high) - 40 : y(C.bars[i].low) + 58);
        });
      };
      lab(A.longX, "L1", "#0ffd17", false);
      lab(A.shortX, "S1", "#ce0202", true);
      if (AS) {
        lab(AS.longX, "L2", "#08ff11", false);
        lab(AS.shortX, "S2", "#960000", true);
      }
      // US100 ATF 전환 마커 (시간 매칭)
      const M = this.mtfCache;
      if (M && M.usATF && this.mt.us.length) {
        const markU = (idxArr, ch, col) => {
          (idxArr || []).forEach(gi => {
            const mb = this.mt.us[gi]; if (!mb) return;
            let found = -1;
            for (let k = start; k < end; k++) {
              const b = C.bars[k];
              if (mb.time >= b.time && mb.time < b.time + this.tfSec) { found = k; break; }
            }
            if (found < 0) return;
            ctx.fillStyle = col;
            ctx.fillText(ch, x(found - start), y(C.bars[found].low) + 70);
          });
        };
        markU(M.usATF.longX.slice(-6), "◇L", "#00e5ff");
        markU(M.usATF.shortX.slice(-6), "◇S", "#ff9100");
      }
    }
    // 신호 마커 (강력매수 분할/화살표, 숏●)
    if (sh.mtf) {
      ctx.font = "bold 11px system-ui"; ctx.textAlign = "center";
      C.sig.forEach(s => {
        if (s.i < start || s.i >= end) return;
        const xx = x(s.i - start);
        if (s.type === "strongBuy") {
          const yy = y(C.bars[s.i].low);
          ctx.fillStyle = "#ffffff"; ctx.fillText("분할", xx, yy + 40);
          ctx.fillStyle = "#00ff08"; ctx.fillText("▲", xx, yy + 52);
        } else if (s.type === "strongSell") {
          const yy = y(C.bars[s.i].high);
          ctx.fillStyle = "#ff0000"; ctx.fillText("▼", xx, yy - 14);
        } else if (s.type === "short") {
          const ref = C.dc.up60[s.i] != null ? C.dc.up60[s.i] : C.bars[s.i].high;
          ctx.fillStyle = "#ff0000"; ctx.font = "12px system-ui"; ctx.fillText("●", xx, y(ref) - 10); ctx.font = "bold 11px system-ui";
        }
      });
    }
    ctx.restore();
    ctx.textAlign = "left";
  }
  // MTF 선 (D/4H) + 우측 라벨
  drawMTF(ctx, S) {
    if (!this.show.master || !this.show.mtf || !this.mtfCache) return;
    const { x, y, start, end, plotW } = S;
    const M = this.mtfCache, C = this.cache;
    if (!C) return;
    ctx.save();
    ctx.font = "10px system-ui";
    const tag = (val, txt, col) => {
      if (val == null) return;
      ctx.fillStyle = col;
      ctx.fillRect(plotW + 2, y(val) - 8, 70, 14);
      ctx.fillStyle = "#fff"; ctx.textAlign = "left";
      ctx.fillText(txt, plotW + 6, y(val) + 3);
    };
    if (M.d1) {
      const bars = C.bars;
      const mapD = (v) => { const arr = new Array(bars.length).fill(v); return arr; };
      // D선은 수평 직선으로 표시 (당일 값)
      this._line(ctx, mapD(M.d1.dcU), x, y, start, end, "#f2ff0088", 3);
      this._line(ctx, mapD(M.d1.dcL), x, y, start, end, "#f2ff0088", 3);
      this._line(ctx, mapD(M.d1.bbU20), x, y, start, end, "#ff2424", 2);
      this._line(ctx, mapD(M.d1.bbL20), x, y, start, end, "#ff0000", 2);
      this._line(ctx, mapD(M.d1.bbM), x, y, start, end, "#4eafff", 2);
      this._line(ctx, mapD(M.d1.lrTop), x, y, start, end, "#ffa200", 2);
      this._line(ctx, mapD(M.d1.lrBot), x, y, start, end, "#ffa200", 2);
      tag(M.d1.dcU, "High D", "#ffa200"); tag(M.d1.dcL, "Lowest D", "#ffa200");
      tag(M.d1.bbU20, "Upp B D", "#ff0000"); tag(M.d1.bbM, "Bas B D", "#4eafff"); tag(M.d1.bbL20, "Low B D", "#ff0000");
      tag(M.d1.lrTop, "Top D", "#ffa200"); tag(M.d1.lrBot, "Bot D", "#ffa200");
    }
    if (M.h1 && M.h4) {
      const bars = C.bars;
      const mapH = (v) => new Array(bars.length).fill(v);
      this._line(ctx, mapH(M.h4.bbU20), x, y, start, end, "#ff4800", 1);
      this._line(ctx, mapH(M.h4.bbL20), x, y, start, end, "#ff4800", 1);
      this._line(ctx, mapH(M.h4.bbM), x, y, start, end, "#00e1ff", 1);
      tag(M.h4.bbU20, "Upp B 4H", "#ff4800"); tag(M.h4.bbM, "Bas B 4H", "#00e1ff"); tag(M.h4.bbL20, "Low B 4H", "#ff4800");
    }
    // 1/4/D 신호 문자 (MTF 시간 → 차트 봉 매칭)
    ctx.textAlign = "center"; ctx.font = "bold 11px system-ui";
    const tfSec = this.tfSec;
    const sameDay = (a, b) => { const da = new Date(a * 1000), db = new Date(b * 1000); return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate(); };
    const mark = (series, idxArr, ch, col, isDaily) => {
      (idxArr || []).forEach(gi => {
        const mb = series[gi]; if (!mb) return;
        let ci = -1;
        for (let k = start; k < end; k++) {
          const b = C.bars[k];
          const hit = isDaily ? sameDay(b.time, mb.time) : (mb.time >= b.time && mb.time < b.time + tfSec);
          if (hit) { ci = k; if (!isDaily) break; }
        }
        if (ci < 0) return;
        ctx.fillStyle = col;
        ctx.fillText(ch, x(ci - start), S.padT + S.priceH - 12);
      });
    };
    if (M.h1 && M.h1.sigIdx) mark(this.mt.h1, M.h1.sigIdx, "1", "#ffffff", false);
    if (M.h4 && M.h4.sigIdx) mark(this._lastF4 || [], M.h4.sigIdx, "4", "#00ff08", false);
    if (M.d1 && M.d1.sigIdx) mark(this.mt.d1, M.d1.sigIdx, "D", "#ffffff", true);
    ctx.restore();
    ctx.textAlign = "left";
  }
  // 오실레이터 스트립 (차트TF MACD)
  drawOsc(ctx, S) {
    if (!this.show.master || !this.show.osc || !this.cache) return;
    const { x, start, end, plotW, padT, plotH, priceH, volH, oscH } = S;
    if (!oscH) return;
    const C = this.cache;
    const top = padT + priceH + (volH || 0), hh = oscH - 6;
    let mx = 0.000001;
    for (let i = start; i < end; i++) {
      const h = C.macd.h[i]; if (h == null) continue;
      const a = Math.abs(h); if (a > mx) mx = a;
      const m = C.macd.m[i]; if (m != null && Math.abs(m) > mx) mx = Math.abs(m);
    }
    const midY = top + hh / 2;
    // Ctrl+스크롤 확대 반영 (선언을 사용보다 먼저)
    const effMx = mx / (this.oscZoom || 1);
    [C.m5, C.m15].forEach(M => {
      if (!M) return;
      ["h", "m"].forEach(k => (M[k] || []).forEach(v => { if (v != null && Math.abs(v) > mx) mx = Math.abs(v); }));
    });
    ctx.save();
    ctx.strokeStyle = "#787b8688"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(plotW, midY); ctx.stroke();
    ctx.setLineDash([]);
    const bw = Math.max(1, S.perRow * 0.55);
    for (let i = start; i < end; i++) {
      const h = C.macd.h[i]; if (h == null) continue;
      const prev = i > 0 ? C.macd.h[i - 1] : h;
      const col = h >= 0 ? (h > prev ? "#26a69a" : "#b2dfdb") : (h > prev ? "#ffcdd2" : "#ff5252");
      ctx.fillStyle = col;
      const bh = Math.max(1, Math.abs(h) / effMx * (hh / 2 - 2));
      const xx = x(i - start);
      ctx.fillRect(xx - bw / 2, h >= 0 ? midY - bh : midY, bw, bh);
    }
    const line = (arr, col, w) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); let s = false;
      for (let i = start; i < end; i++) {
        if (arr[i] == null) continue;
        const xx = x(i - start), yy = midY - (arr[i] / effMx) * (hh / 2 - 2);
        if (!s) { ctx.moveTo(xx, yy); s = true; } else ctx.lineTo(xx, yy);
      }
      ctx.stroke(); ctx.lineWidth = 1;
    };
    line(C.macd.m, "#2196f3", 1.5); line(C.macd.sg, "#ff6d00", 1.5);
    // 5m/15m MACD 희미 오버레이 (뒤쪽)
    const over = (M, isArea) => {
      if (!M) return;
      const tmap = new Map();
      M.bars.forEach((b, i) => tmap.set(b.time, i));
      const at = (arr, i) => {
        const bt = Math.floor(C.bars[i].time / M.tsec) * M.tsec;
        const mi = tmap.get(bt);
        return mi == null ? null : arr[mi];
      };
      if (isArea) {
        ctx.beginPath(); let s = false, firstX = 0;
        for (let i = start; i < end; i++) {
          const h = at(M.h, i); if (h == null) continue;
          const xx = x(i - start), yy = midY - (h / effMx) * (hh / 2 - 2);
          if (!s) { ctx.moveTo(xx, midY); ctx.lineTo(xx, yy); firstX = xx; s = true; }
          else ctx.lineTo(xx, yy);
        }
        if (s) {
          const lastX = x(end - 1 - start);
          ctx.lineTo(lastX, midY); ctx.closePath();
          ctx.fillStyle = "rgba(38,166,154,0.12)"; ctx.fill();
        }
      } else {
        for (let i = start; i < end; i++) {
          const h = at(M.h, i); if (h == null) continue;
          const bh = Math.max(1, Math.abs(h) / effMx * (hh / 2 - 2));
          const xx = x(i - start);
          ctx.fillStyle = h >= 0 ? "rgba(38,166,154,0.30)" : "rgba(239,83,80,0.30)";
          ctx.fillRect(xx - bw / 2, h >= 0 ? midY - bh : midY, bw, bh);
        }
      }
      const tline = (arr, col) => {
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = 0.6; ctx.beginPath(); let s = false;
        for (let i = start; i < end; i++) {
          const v = at(arr, i); if (v == null) continue;
          const xx = x(i - start), yy = midY - (v / effMx) * (hh / 2 - 2);
          if (!s) { ctx.moveTo(xx, yy); s = true; } else ctx.lineTo(xx, yy);
        }
        ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1;
      };
      tline(M.m, "#2196f3"); tline(M.sg, "#ff9800");
    };
    over(C.m15, true); over(C.m5, false);
    ctx.restore();
  }
  // RSI 별도 스트립 (0~100 표준)
  drawRSI(ctx, S) {
    if (!this.show.master || !this.show.osc || !this.show.rsi || !this.cache) return;
    const { x, start, end, plotW, padT, priceH, volH, oscH, rsiH } = S;
    if (!rsiH) return;
    const C = this.cache;
    const top = padT + priceH + (volH || 0) + (oscH || 0), hh = rsiH - 6;
    const z = this.rsiZoom || 1;
    const yR = v => { const vv = Math.min(100, Math.max(0, 50 + (v - 50) * z)); return top + (1 - vv / 100) * hh; };
    ctx.save();
    ctx.strokeStyle = "#787B8688"; ctx.setLineDash([3, 3]);
    [70, 30].forEach(lv => { ctx.beginPath(); ctx.moveTo(0, yR(lv)); ctx.lineTo(plotW, yR(lv)); ctx.stroke(); });
    ctx.setLineDash([]);
    ctx.strokeStyle = "#787B8644";
    ctx.beginPath(); ctx.moveTo(0, yR(50)); ctx.lineTo(plotW, yR(50)); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.beginPath();
    let started = false, prevCol = "";
    const colOf = (v) => v > 70 ? "#ff52bd" : v >= 50 ? "#fffb00" : v >= 30 ? "#ababac" : "#00ff08";
    for (let i = start; i < end; i++) {
      const v = C.rsi[i]; if (v == null) { started = false; continue; }
      const col = colOf(v);
      if (!started || col !== prevCol) {
        if (started) ctx.stroke();
        ctx.strokeStyle = col; ctx.beginPath();
        const px = i > start && C.rsi[i - 1] != null ? x(i - 1 - start) : x(i - start);
        const py = i > start && C.rsi[i - 1] != null ? yR(C.rsi[i - 1]) : yR(v);
        ctx.moveTo(px, py); started = true; prevCol = col;
      }
      ctx.lineTo(x(i - start), yR(v));
    }
    if (started) ctx.stroke();
    ctx.lineWidth = 1;
    // 현재값은 마지막 봉 위치에 크게 표시
    let li2 = -1;
    for (let i = end - 1; i >= start; i--) { if (C.rsi[i] != null) { li2 = i; break; } }
    if (li2 >= 0) {
      const rv = C.rsi[li2];
      const xx = x(li2 - start), yy = yR(rv);
      const txt = rv.toFixed(1);
      ctx.font = "bold 12px system-ui";
      const tw = ctx.measureText(txt).width;
      const lx = Math.min(xx + 8, plotW - tw - 8);
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(lx - 3, yy - 17, tw + 6, 16);
      ctx.fillStyle = colOf(rv);
      ctx.textAlign = "left";
      ctx.fillText(txt, lx, yy - 4);
    }
    ctx.restore();
  }
  // 정보 라벨 스트립 (테이블 대신 캔버스 좌상단 칩)
  drawInfo(ctx, S) {
    if (!this.show.master || !this.show.mtf || !this.lastTable) return;
    const d = this.lastTable;
    const f = (v) => v == null ? "—" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
    const pct = (v) => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    const chips = [
      `전일 ${f(d.prevClose)} (${pct(d.yChg)})`,
      `시/고/저 ${f(d.open)}/${f(d.high)}/${f(d.low)}`,
      `BBW ${d.bbw == null ? "—" : d.bbw.toFixed(2) + "%"}`,
      `DC60 ${d.dcW == null ? "—" : d.dcW.toFixed(2) + "%"}`,
      `MA200 ${pct(d.disp200)}`,
      `MA100 ${pct(d.disp100)}`,
      `RSI ${d.rsi == null ? "—" : d.rsi.toFixed(1)}`,
    ];
    const pos = Math.round(d.curPos || 0), filled = Math.round(pos / 100 * 10);
    chips.push(`일간 ${"●".repeat(filled)}${"─".repeat(10 - filled)} ${pos}%`);
    ctx.save();
    ctx.font = "13px system-ui";
    const maxX = Math.floor(S.plotW * 0.62); // 우측 배너 영역 비움
    const lines = []; let cur = [], w = 0;
    chips.forEach(ch => {
      const cw = ctx.measureText(ch).width + 22;
      if (w + cw > maxX && cur.length) { lines.push({ items: cur, w }); cur = []; w = 0; }
      cur.push({ ch, cw }); w += cw + 8;
    });
    if (cur.length) lines.push({ items: cur, w });
    let yy = S.padT + 4;
    lines.slice(0, 2).forEach(L => {
      let xx = 6;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(2, yy, Math.min(L.w, maxX), 21);
      L.items.forEach(it => {
        ctx.fillStyle = "#d5dce8";
        ctx.textAlign = "left";
        ctx.fillText(it.ch, xx + 11, yy + 15);
        xx += it.cw + 8;
      });
      yy += 24;
    });
    this._infoBottom = yy; // ATF 도트 레인 기준
    ctx.restore();
    ctx.restore();
    ctx.textAlign = "left";
  }
  // 일간 테이블용 데이터
  tableData() {
    const d1 = this.mt.d1, C = this.cache;
    if (!d1 || d1.length < 2 || !C || !C.bars.length) return null;
    const last = C.bars[C.bars.length - 1];
    const today = d1[d1.length - 1], prev = d1[d1.length - 2];
    const c = C.bars.map(b => b.close);
    const m200 = PineBundle.smaArr(c, Math.min(200, c.length));
    const m100 = PineBundle.smaArr(c, Math.min(100, c.length));
    const d200 = d1.map(b => b.close);
    const dM200 = PineBundle.smaArr(d200, Math.min(200, d200.length));
    const dM100 = PineBundle.smaArr(d200, Math.min(100, d200.length));
    const yChg = prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;
    const bb = C.bb, bi = C.bars.length - 1;
    const bbw = (bb.mid[bi] && bb.up[bi] != null) ? ((bb.up[bi] - bb.lo[bi]) / bb.mid[bi]) * 100 : null;
    const dcW = (C.dc.lo60[bi] != null && C.dc.up60[bi] != null) ? ((C.dc.up60[bi] - C.dc.lo60[bi]) / C.dc.lo60[bi]) * 100 : null;
    const rsi = C.rsi[bi];
    return {
      prevClose: prev.close, open: today.open, high: today.high, low: today.low, yChg,
      bbw, dcW,
      disp200: dM200[dM200.length - 1] ? ((last.close - dM200[dM200.length - 1]) / dM200[dM200.length - 1]) * 100 : null,
      disp100: dM100[dM100.length - 1] ? ((last.close - dM100[dM100.length - 1]) / dM100[dM100.length - 1]) * 100 : null,
      rsi, hist: C.macd.h[bi],
      dRange: today.high - today.low,
      curPos: (today.high - today.low) > 0 ? ((last.close - today.low) / (today.high - today.low)) * 100 : 50,
    };
  }
}

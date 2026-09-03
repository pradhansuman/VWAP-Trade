/* ============================================================================
 * VWAP Precision Signals — core engine (framework-free, node-testable)
 * Mirrors the Pine Script v5 indicator rule-for-rule.
 * Candles: [{ t: ms, o, h, l, c, v }] oldest → newest.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var DEFAULTS = {
    reset: 'Day',        // 'Day' | 'Week' | 'Month'
    bandMult2: 2.0,      // outer sigma band
    holdBars: 12,        // how long an R1/R3 event keeps its score
    pivotK: 5,           // swing-low strength (bars each side)
    touchPct: 0.15,      // R3 touch zone (% of level)
    bigMult: 3.0,        // big bar = volume > bigMult × SMA50(volume)
    divThr: 0.15,        // R4 divergence trigger (%)
    w: [0.25, 0.30, 0.20, 0.25],
    buyAt: 0.35,
    sellAt: -0.35,
    manualAnchor: null   // ms timestamp or null (auto swing lows)
  };

  function sessionKey(t, reset) {
    var d = new Date(t);
    if (reset === 'Week') {
      var dow = d.getUTCDay();                       // 0 Sun … 6 Sat
      var monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((dow + 6) % 7)));
      return monday.getTime();
    }
    if (reset === 'Month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function sma(arr, i, len) {
    var from = Math.max(0, i - len + 1), n = i - from + 1, s = 0;
    for (var k = from; k <= i; k++) s += arr[k];
    return n > 0 ? s / n : 0;
  }

  function pivotLows(lows, k) {
    // returns map: confirmedAtBarIndex -> pivotBarIndex
    var out = {};
    for (var i = k; i < lows.length - k; i++) {
      var isPivot = true;
      for (var j = i - k; j <= i + k; j++) {
        if (j !== i && lows[j] < lows[i]) { isPivot = false; break; }
        if (j < i && lows[j] === lows[i]) { isPivot = false; break; } // tie → keep earliest
      }
      if (isPivot) out[i + k] = i;
    }
    return out;
  }

  function clampNum(x, fallback) {
    return (typeof x === 'number' && isFinite(x)) ? x : fallback;
  }

  /* Computes per-bar series + latest composite verdict. */
  function analyze(candles, userOpts) {
    var opts = Object.assign({}, DEFAULTS, userOpts || {});
    var n = candles.length;
    if (!n) return { empty: true, verdict: 'WAIT', score: 0, confidence: 0, rules: [] };

    var closes = [], highs = [], lows = [], vols = [], vReal = false;
    for (var i = 0; i < n; i++) {
      var c = candles[i];
      closes.push(clampNum(c.c, NaN));
      highs.push(clampNum(c.h, NaN));
      lows.push(clampNum(c.l, NaN));
      var v = clampNum(c.v, 0);
      if (v > 0) vReal = true;
      vols.push(v);
    }

    // ---- R1 / session VWAP + sigma (same math as the Pine script) ----
    var vwap = [], sig = [], cumPV = 0, cumV = 0, cumP2V = 0, lastSes = NaN, prevClose = [], sessionOf = [];
    var curSes = null;
    for (i = 0; i < n; i++) {
      var key = sessionKey(candles[i].t, opts.reset);
      if (key !== curSes) {
        if (curSes !== null && isFinite(lastSes)) prevClose[i] = lastSes;
        curSes = key;
        cumPV = 0; cumV = 0; cumP2V = 0;
      }
      sessionOf[i] = curSes;
      var tp = (highs[i] + lows[i] + closes[i]) / 3;
      var v = vReal ? vols[i] : 1;
      cumPV += tp * v; cumV += v; cumP2V += tp * tp * v;
      var vw = cumV > 0 ? cumPV / cumV : tp;
      var variance = Math.max(cumP2V / cumV - vw * vw, 0);
      vwap.push(vw);
      sig.push(Math.sqrt(variance));
      if (prevClose[i] === undefined) prevClose[i] = i > 0 ? prevClose[i - 1] : NaN;
      lastSes = vw;
    }

    // ---- R2 / anchored VWAP (Pine parity: accumulates from bar 0, re-anchors on events) ----
    var pivots = pivotLows(lows, opts.pivotK);
    var anchorIdx = 0, mIdx = -1;
    if (opts.manualAnchor) {
      for (i = 0; i < n; i++) if (candles[i].t >= opts.manualAnchor) { mIdx = i; break; }
    }
    var aCumPV = 0, aCumV = 0, aVwap = [], aStart = 0;
    for (i = 0; i < n; i++) {
      var doReset = false;
      if (!opts.manualAnchor && pivots[i] !== undefined) { aStart = pivots[i]; doReset = true; }
      if (opts.manualAnchor && i === mIdx) { aStart = i; doReset = true; }
      if (doReset) { aCumPV = 0; aCumV = 0; }
      var tp2 = (highs[i] + lows[i] + closes[i]) / 3;
      var v2 = vReal ? vols[i] : 1;
      aCumPV += tp2 * v2; aCumV += v2;
      aVwap.push(aCumPV / aCumV);
      anchorIdx = aStart;
    }

    // ---- R4 / T-Size VWAP (big bars only, per session) ----
    var bigVwap = [], tCumPV2 = 0, tCumV2 = 0, curSes2 = null;
    for (i = 0; i < n; i++) {
      var key2 = sessionOf[i];
      if (key2 !== curSes2) { curSes2 = key2; tCumPV2 = 0; tCumV2 = 0; }
      var v3 = vols[i], s = sma(vols, i, 50);
      var isBig = vReal && v3 > opts.bigMult * s;
      var tp3 = (highs[i] + lows[i] + closes[i]) / 3;
      if (isBig) { tCumPV2 += tp3 * v3; tCumV2 += v3; }
      bigVwap.push(tCumV2 > 0 ? tCumPV2 / tCumV2 : NaN);
    }

    // ---- Per-bar z-score, divergence ----
    var z = [], divg = [];
    for (i = 0; i < n; i++) {
      var sg = Math.max(sig[i], closes[i] * 1e-9, 1e-9);
      z.push((closes[i] - vwap[i]) / sg);
      divg.push(isFinite(bigVwap[i]) ? (bigVwap[i] - vwap[i]) / vwap[i] : NaN);
    }

    // ---- Rule scores ----
    var r1 = [], r2 = [], r3 = [], r4 = [], events = [];
    var r1s = 0, r1a = 9999, r3s = 0, r3a = 9999;
    var ext = [];
    for (i = 0; i < n; i++) {
      var zP = i > 0 ? z[i - 1] : NaN, zN = z[i];
      var buyEvt = isFinite(zP) && zP <= -opts.bandMult2 && zN > -opts.bandMult2;
      var sellEvt = isFinite(zP) && zP >= opts.bandMult2 && zN < opts.bandMult2;
      ext.push(Math.abs(zN) >= opts.bandMult2);
      if (buyEvt) { r1s = 1; r1a = 0; events.push({ i: i, rule: 'R1', dir: 1, label: 'Snap-back inside lower band' }); }
      else if (sellEvt) { r1s = -1; r1a = 0; events.push({ i: i, rule: 'R1', dir: -1, label: 'Fade back inside upper band' }); }
      else { r1a++; if (r1a > opts.holdBars) r1s = 0; }
      r1.push(r1s);

      var av = aVwap[i];
      r2.push(isFinite(av) ? (closes[i] > av ? 1 : closes[i] < av ? -1 : 0) : 0);
      if (i > 0 && isFinite(av) && isFinite(aVwap[i - 1])) {
        if (closes[i - 1] > aVwap[i - 1] && closes[i] < av) events.push({ i: i, rule: 'R2', dir: -1, label: 'Lost anchored VWAP' });
        if (closes[i - 1] < aVwap[i - 1] && closes[i] > av) events.push({ i: i, rule: 'R2', dir: 1, label: 'Reclaimed anchored VWAP' });
      }

      var pc = prevClose[i];
      // "visit then react": previous bar was near the wall, current bar crosses it
      var nearWall = i > 0 && isFinite(pc) && Math.abs(closes[i - 1] - pc) <= pc * opts.touchPct / 100;
      var r3Buy = nearWall && isFinite(pc) && isFinite(prevClose[i - 1]) &&
        sessionOf[i] === sessionOf[i - 1] &&
        closes[i - 1] < prevClose[i - 1] && closes[i] > pc;
      var r3Sell = nearWall && isFinite(pc) && isFinite(prevClose[i - 1]) &&
        sessionOf[i] === sessionOf[i - 1] &&
        closes[i - 1] > prevClose[i - 1] && closes[i] < pc;
      if (r3Buy) { r3s = 1; r3a = 0; events.push({ i: i, rule: 'R3', dir: 1, label: 'Wall touched + reclaimed' }); }
      else if (r3Sell) { r3s = -1; r3a = 0; events.push({ i: i, rule: 'R3', dir: -1, label: 'Wall touched + rejected' }); }
      else { r3a++; if (r3a > opts.holdBars) r3s = 0; }
      r3.push(r3s);

      var d = divg[i], dP = i > 0 ? divg[i - 1] : NaN;
      var up = isFinite(d) && d >= opts.divThr / 100;
      var dn = isFinite(d) && d <= -opts.divThr / 100;
      r4.push(up ? 1 : dn ? -1 : 0);
      if (up && !(isFinite(dP) && dP >= opts.divThr / 100)) events.push({ i: i, rule: 'R4', dir: 1, label: 'Big players above the crowd' });
      if (dn && !(isFinite(dP) && dP <= -opts.divThr / 100)) events.push({ i: i, rule: 'R4', dir: -1, label: 'Big players heading for the exit' });
    }

    // ---- Verdict at the last CLOSED bar (index n-2 when a forming bar exists) ----
    var evalIdx = n - 1;
    if (typeof root !== 'undefined' && root.__LAST_BAR_FORMING__) evalIdx = n - 2;
    if (evalIdx < 0) evalIdx = 0;

    var scores = [r1[evalIdx] || 0, r2[evalIdx] || 0, r3[evalIdx] || 0, r4[evalIdx] || 0];
    var score = opts.w[0] * scores[0] + opts.w[1] * scores[1] + opts.w[2] * scores[2] + opts.w[3] * scores[3];
    var verdict = score >= opts.buyAt ? 'BUY' : score <= opts.sellAt ? 'SELL' : 'WAIT';
    var confidence = Math.min(100, Math.round(Math.abs(score) / 0.6 * 100));

    // ---- Trade idea (arithmetic, not advice) ----
    var idea = null;
    var px = closes[evalIdx];
    var lookLo = Math.min.apply(null, lows.slice(Math.max(0, evalIdx - 9), evalIdx + 1));
    var lookHi = Math.max.apply(null, highs.slice(Math.max(0, evalIdx - 9), evalIdx + 1));
    var pcNow = prevClose[evalIdx];
    if (verdict === 'BUY') {
      var stop = Math.min(lookLo, vwap[evalIdx] - opts.bandMult2 * sig[evalIdx]);
      var target = isFinite(pcNow) && pcNow > px ? pcNow : vwap[evalIdx] + opts.bandMult2 * sig[evalIdx];
      idea = { side: 'BUY', entry: px, stop: stop, target: target, rr: (target - px) / Math.max(px - stop, 1e-9) };
    } else if (verdict === 'SELL') {
      var stop2 = Math.max(lookHi, vwap[evalIdx] + opts.bandMult2 * sig[evalIdx]);
      var target2 = isFinite(pcNow) && pcNow < px ? pcNow : vwap[evalIdx] - opts.bandMult2 * sig[evalIdx];
      idea = { side: 'SELL', entry: px, stop: stop2, target: target2, rr: (px - target2) / Math.max(stop2 - px, 1e-9) };
    }

    // ---- Rule readings (plain English, for the UI cards) ----
    var avNow = aVwap[evalIdx];
    var dNow = divg[evalIdx];
    var pcTxt = isFinite(pcNow) ? pcNow : null;
    var rules = [
      {
        id: 'R1', name: 'Time-Based VWAP', score: scores[0],
        z: z[evalIdx], vwap: vwap[evalIdx],
        state: Math.abs(z[evalIdx]) >= opts.bandMult2 ? 'extended' : scores[0] > 0 ? 'bullish' : scores[0] < 0 ? 'bearish' : 'neutral',
        reading: Math.abs(z[evalIdx]) >= opts.bandMult2
          ? 'Price is ' + Math.abs(z[evalIdx]).toFixed(1) + 'σ from VWAP — stretched. Wait for the snap-back; do not chase.'
          : scores[0] > 0 ? 'Just snapped back inside the lower band — reversion long is live.'
          : scores[0] < 0 ? 'Just faded back inside the upper band — reversion short is live.'
          : 'Price is near VWAP (' + z[evalIdx].toFixed(1) + 'σ). No edge right now.'
      },
      {
        id: 'R2', name: 'Anchored VWAP', score: scores[1],
        anchorIdx: anchorIdx, vwap: avNow,
        state: scores[1] > 0 ? 'bullish' : scores[1] < 0 ? 'bearish' : 'neutral',
        reading: !isFinite(avNow) ? 'No anchor yet.'
          : anchorIdx === 0 && !opts.manualAnchor ? (scores[1] > 0 ? 'Above the from-start average — no swing-low anchor confirmed yet.' : 'Below the from-start average — no swing-low anchor confirmed yet.')
          : scores[1] > 0 ? 'Price is above the swing-low anchor — trend has fuel.'
          : 'Price fell below the swing-low anchor — warning: the trend may be running out of steam.'
      },
      {
        id: 'R3', name: 'Previous VWAP Close', score: scores[2],
        level: pcTxt, vwap: pcTxt,
        state: scores[2] > 0 ? 'bullish' : scores[2] < 0 ? 'bearish' : 'neutral',
        reading: pcTxt === null ? 'No previous session close yet.'
          : scores[2] > 0 ? 'Old VWAP close visited and reclaimed — the wall held as support.'
          : scores[2] < 0 ? 'Old VWAP close visited and rejected — the wall is acting as resistance.'
          : 'Price is ' + (Math.abs(px - pcTxt) / pcTxt * 100).toFixed(2) + '% away from yesterday\'s VWAP close. Price likes to re-visit it.'
      },
      {
        id: 'R4', name: 'T-Size VWAP', score: scores[3],
        div: isFinite(dNow) ? dNow * 100 : null, vwap: bigVwap[evalIdx],
        state: !isFinite(bigVwap[evalIdx]) ? 'na' : scores[3] > 0 ? 'bullish' : scores[3] < 0 ? 'bearish' : 'neutral',
        reading: !isFinite(bigVwap[evalIdx]) ? (vReal ? 'No big-volume bars this session yet.' : 'Symbol reports no volume — use futures or a stock chart.')
          : scores[3] > 0 ? 'Big players\' average is ' + (dNow * 100).toFixed(2) + '% above the crowd — quiet accumulation.'
          : scores[3] < 0 ? 'Big players\' average is ' + (Math.abs(dNow) * 100).toFixed(2) + '% below the crowd — distribution clue.'
          : 'Big money and the crowd agree (Δ ' + (dNow * 100).toFixed(2) + '%). No early clue.'
      }
    ];

    return {
      empty: false, evalIdx: evalIdx, n: n,
      series: { vwap: vwap, sig: sig, up2: vwap.map(function (x, k) { return x + opts.bandMult2 * sig[k]; }), lo2: vwap.map(function (x, k) { return x - opts.bandMult2 * sig[k]; }), aVwap: aVwap, bigVwap: bigVwap, prevClose: prevClose, z: z, divg: divg },
      score: score, verdict: verdict, confidence: confidence,
      rules: rules, idea: idea, events: events.filter(function (e) { return e.i <= evalIdx && e.i > evalIdx - opts.holdBars * 2; }),
      hasVolume: vReal, sessionOf: sessionOf,
      forecast: forecast(candles, {})
    };
  }

  /* ---- 12-bar projection: similar-pattern matching + volatility context.
   * Finds the k historical windows whose last-m returns most resemble the
   * current shape (z-scored, so only pattern matters), averages what price
   * did over the next h bars, and reports the percentile band. Deterministic;
   * no randomness. This is statistics, not a prediction of the future. ---- */
  function forecast(candles, opts) {
    var o = Object.assign({ m: 4, h: 12, k: 15, volLookback: 120 }, opts || {});
    var n = candles.length;
    if (n < o.m + o.h + 40) return null;
    var closes = [], i, j;
    for (i = 0; i < n; i++) closes.push(candles[i].c);
    var r = [0];
    for (i = 1; i < n; i++) r.push(closes[i] / closes[i - 1] - 1);
    var lastClosed = n - 2;                     // last bar is forming
    if (lastClosed < o.m + 2) return null;
    function shape(arr) {
      var mean = 0;
      for (var a = 0; a < arr.length; a++) mean += arr[a];
      mean /= arr.length;
      var v = 0;
      for (var b = 0; b < arr.length; b++) v += (arr[b] - mean) * (arr[b] - mean);
      var sd = Math.sqrt(v / arr.length) || 1e-9;
      return arr.map(function (x) { return (x - mean) / sd; });
    }
    var cur = shape(r.slice(lastClosed - o.m + 1, lastClosed + 1));
    var cands = [];
    for (i = o.m; i <= lastClosed - o.h; i++) {
      var zs = shape(r.slice(i - o.m + 1, i + 1));
      var d2 = 0;
      for (j = 0; j < o.m; j++) d2 += (zs[j] - cur[j]) * (zs[j] - cur[j]);
      cands.push({ i: i, d: Math.sqrt(d2) });
    }
    cands.sort(function (a, b) { return a.d - b.d; });
    var matches = cands.slice(0, o.k);
    if (!matches.length) return null;
    var paths = matches.map(function (m0) {
      var out = [], cum = 0;
      for (j = 1; j <= o.h; j++) {
        cum += r[m0.i + j] || 0;
        out.push(Math.exp(cum) - 1);
      }
      return out;
    });
    function pct(arr, p) {
      var s = arr.slice().sort(function (a, b) { return a - b; });
      var idx = (s.length - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
      return s[lo] + (s[hi] - s[lo]) * (idx - lo);
    }
    var median = [], p10 = [], p90 = [];
    for (j = 0; j < o.h; j++) {
      var col = paths.map(function (p) { return p[j]; });
      median.push(pct(col, 0.5)); p10.push(pct(col, 0.1)); p90.push(pct(col, 0.9));
    }
    var p0 = closes[n - 1];
    var upCount = paths.filter(function (p) { return p[o.h - 1] > 0; }).length;
    var vv = r.slice(Math.max(1, n - 1 - o.volLookback), n - 1).filter(function (x) { return isFinite(x); });
    var mu = vv.reduce(function (a, b) { return a + b; }, 0) / vv.length;
    var sd = Math.sqrt(vv.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / vv.length);
    return {
      m: o.m, h: o.h, k: matches.length, p0: p0,
      medianPct: median[o.h - 1] * 100, upCount: upCount,
      median: median.map(function (x) { return p0 * Math.exp(x); }),
      lo: p10.map(function (x) { return p0 * Math.exp(x); }),
      hi: p90.map(function (x) { return p0 * Math.exp(x); }),
      volMu: mu, volSd: sd
    };
  }

  var API = { analyze: analyze, forecast: forecast, defaults: DEFAULTS, sessionKey: sessionKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.VWAPEngine = API;
})(typeof window !== 'undefined' ? window : globalThis);

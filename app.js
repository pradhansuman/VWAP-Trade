/* ============================================================================
 * VWAP Precision Signals — app layer (DOM, data, charts)
 * ==========================================================================*/
(function () {
  'use strict';
  var E = window.VWAPEngine;

  /* ---------------- helpers ---------------- */
  function $(s, p) { return (p || document).querySelector(s); }
  function $$(s, p) { return Array.prototype.slice.call((p || document).querySelectorAll(s)); }
  function fmt(x, dp) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    return Number(x).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtPrice(asset, x) { return fmt(x, asset.dp); }
  function timeStr(t, tz) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(t));
  }
  function hhmm(t, tz) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ---------------- asset config ---------------- */
  var ASSETS = {
    nifty: {
      key: 'nifty', name: 'Nifty 50', code: '^NSEI', tz: 'Asia/Kolkata', dp: 2,
      refreshSec: 300, interval: '15m', legend: 'NSE · 15-minute bars', unit: 'pts'
    },
    banknifty: {
      key: 'banknifty', name: 'Bank Nifty', code: '^NSEBANK', tz: 'Asia/Kolkata', dp: 2,
      refreshSec: 300, interval: '15m', legend: 'NSE · 15-minute bars', unit: 'pts'
    },
    sensex: {
      key: 'sensex', name: 'Sensex', code: '^BSESN', tz: 'Asia/Kolkata', dp: 2,
      refreshSec: 300, interval: '15m', legend: 'BSE · 15-minute bars', unit: 'pts'
    },
    btc: {
      key: 'btc', name: 'Bitcoin', code: 'BTCUSDT', tz: 'UTC', dp: 2,
      refreshSec: 60, interval: '5m', legend: 'Binance · 5-minute bars', unit: 'USDT'
    }
  };
  var KEYS = ['nifty', 'banknifty', 'sensex', 'btc'];

  /* ---------------- state ---------------- */
  var state = {
    mode: 'live',
    data: {},          // key -> { candles, source, fetchedAt, stale }
    countdown: {},     // key -> seconds left
    result: {},        // key -> engine result
    hidden: {},        // key -> {seriesName:bool}
    opt: {},           // key -> option-desk state (indices only)
    demoOpt: {},       // key -> synthetic option state (demo mode)
    authOk: false,     // Upstox connected (server-side auth)
    prevVerdict: {},   // key -> last verdict (for flip alerts)
    alertSeen: {},     // dedupe set for ticker
    seenQueue: [],
    demoSeed: { nifty: 20260902, banknifty: 777, sensex: 555, btc: 21 },
    timers: { demo: null, tick: null }
  };

  /* ---------------- theme ---------------- */
  function safeLS(fn) { try { return fn(); } catch (e) { return null; } }
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    safeLS(function () { localStorage.setItem('vwap-theme', t); });
    $$('#themeSeg button').forEach(function (b) {
      var on = b.dataset.theme === t;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    redrawAll();
  }

  /* ================= DATA LAYER ================= */

  function fetchJSON(url, timeoutMs) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs || 12000);
    return fetch(url, ctl ? { signal: ctl.signal } : {})
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(timer); });
  }

  function fetchBTC() {
    var hosts = ['https://api.binance.com', 'https://api1.binance.com', 'https://data-api.binance.vision'];
    var path = '/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1000';
    var i = 0;
    function tryNext() {
      if (i >= hosts.length) return Promise.reject(new Error('All Binance endpoints unreachable'));
      var host = hosts[i++];
      return fetchJSON(host + path, 10000).then(function (rows) {
        if (!Array.isArray(rows) || rows.length < 50) throw new Error('Unexpected payload');
        var candles = rows.map(function (r) {
          return { t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] };
        }).filter(function (c) { return isFinite(c.c) && isFinite(c.h) && isFinite(c.l); });
        return { candles: candles, source: 'Binance · BTCUSDT · 5m' };
      }).catch(function (err) {
        if (i >= hosts.length) throw err;
        return tryNext();
      });
    }
    return tryNext();
  }

  function fetchYahoo(a) {
    var u1 = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(a.code) + '?interval=' + a.interval + '&range=5d';
    var u2 = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(a.code) + '?interval=' + a.interval + '&range=5d';
    var attempts = [
      { name: 'Yahoo (via relay)', url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u1), wrap: false },
      { name: 'Yahoo (via relay)', url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u1), wrap: false },
      { name: 'Yahoo (via relay)', url: 'https://api.allorigins.win/get?url=' + encodeURIComponent(u2), wrap: true },
      { name: 'Yahoo (via relay)', url: 'https://corsproxy.io/?url=' + encodeURIComponent(u2), wrap: false }
    ];
    var i = 0;
    function tryNext() {
      if (i >= attempts.length) return Promise.reject(new Error('Nifty feed unreachable — Yahoo and its public relays all failed. Use Demo, or retry in a minute.'));
      var a = attempts[i++];
      return fetchJSON(a.url, 12000).then(function (json) {
        if (a.wrap && json && json.contents) json = JSON.parse(json.contents);
        var res = json && json.chart && json.chart.result && json.chart.result[0];
        if (!res || !res.timestamp || !res.timestamp.length) throw new Error('Unexpected payload');
        var q = res.indicators.quote[0];
        var candles = [];
        for (var k = 0; k < res.timestamp.length; k++) {
          var c = q.close[k], h = q.high[k], l = q.low[k], o = q.open[k], v = q.volume ? q.volume[k] : 0;
          if ([c, h, l, o].some(function (x) { return x === null || !isFinite(x); })) continue;
          candles.push({ t: res.timestamp[k] * 1000, o: o, h: h, l: l, c: c, v: (v || 0) });
        }
        if (candles.length < 50) throw new Error('Too few bars returned');
        return { candles: candles, source: a.name + ' · ' + a.code + ' · ' + a.interval };
      }).catch(function (err) {
        if (i >= attempts.length) throw err;
        return tryNext();
      });
    }
    return tryNext();
  }

  /* ---------------- demo generator ---------------- */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function demoCandles(key) {
    var a = ASSETS[key];
    var cfg = {
      nifty: { base: 24800, vol: 0.0013, n: 480, step: 15 * 60000, bigK: 3.8, baseV: 90000 },
      banknifty: { base: 51500, vol: 0.0018, n: 480, step: 15 * 60000, bigK: 3.8, baseV: 60000 },
      sensex: { base: 81000, vol: 0.0012, n: 480, step: 15 * 60000, bigK: 3.8, baseV: 50000 },
      btc: { base: 68000, vol: 0.0021, n: 900, step: 5 * 60000, bigK: 4.5, baseV: 120 }
    }[key];
    var rnd = mulberry32(state.demoSeed[key]);
    var px = cfg.base, vol = cfg.vol, n = cfg.n, step = cfg.step;
    var out = [], drift = 0, regime = 0, w = 0;
    var t0 = Date.now() - n * step;
    for (var i = 0; i < n; i++) {
      if (rnd() < 0.02) regime = (rnd() - 0.5) * 2;
      w = w * 0.995 + regime * vol * 0.5;               // bounded trend state
      w = Math.max(-0.10, Math.min(0.10, w));           // stay within ±10% of base
      var anchor = cfg.base * Math.exp(w);
      var o = px;
      var shock = (rnd() + rnd() + rnd() - 1.5) * vol;
      var c = o + (anchor - o) * 0.35 + o * shock * 0.7;
      var wick = Math.abs(shock) * o * (0.6 + rnd());
      var h = Math.max(o, c) + wick * rnd();
      var l = Math.min(o, c) - wick * rnd();
      var v = cfg.baseV * (0.4 + rnd() * 1.2);
      if (rnd() < 0.045) v *= cfg.bigK * (0.7 + rnd()); // big-player bursts
      out.push({ t: t0 + i * step, o: o, h: h, l: l, c: c, v: v });
      px = c;
    }
    return { candles: out, source: 'Demo · synthetic ' + a.code };
  }

  function stepDemo() {
    KEYS.forEach(function (key) {
      var d = state.data[key];
      if (!d || !d.demo) return;
      var cs = d.candles;
      var step = key === 'btc' ? 5 * 60000 : 15 * 60000;
      var last = cs[cs.length - 1];
      var vol = key === 'btc' ? 0.0011 : 0.0007;
      var c = last.c * (1 + (Math.random() - 0.5) * vol * 2);
      var h = Math.max(last.o, c) * (1 + Math.random() * vol);
      var l = Math.min(last.o, c) * (1 - Math.random() * vol);
      var nb = { t: last.t + step, o: last.c, h: h, l: l, c: c, v: last.v * (0.5 + Math.random()) };
      if (Math.random() < 0.06) nb.v *= 4;
      cs.push(nb);
      if (cs.length > 1100) cs.shift();
      // synthetic option-desk walk + option call alerts
      if (key !== 'btc' && state.demoOpt[key]) {
        var o = state.demoOpt[key];
        o.prevCeAsk = o.ce.ask; o.prevPeAsk = o.pe.ask;
        var jump = function () {
          var mag = Math.random() < 0.25 ? 2.5 : 0.5;
          return mag * (Math.random() - 0.45) * 0.06;
        };
        o.ce.ask = Math.max(5, o.ce.ask * (1 + jump()));
        o.pe.ask = Math.max(5, o.pe.ask * (1 + jump()));
        o.ce.ltp = o.ce.ask * 0.985;
        o.pe.ltp = o.pe.ask * 0.985;
        evaluateOptionAlerts(key, o.atm, o.expiry, o.ce, o.pe, o.prevCeAsk, o.prevPeAsk);
        state.opt[key] = { status: 'ok', expiry: o.expiry, spot: c, atm: o.atm, rows: [{ strike: o.atm, ce: o.ce, pe: o.pe }], updatedAt: Date.now() };
      }
      renderAsset(key);
    });
  }

  /* ================= ANALYSIS ================= */
  function analyze(key) {
    var d = state.data[key];
    if (!d) return null;
    window.__LAST_BAR_FORMING__ = true;
    return E.analyze(d.candles, {});
  }

  /* ================= RENDERING ================= */

  function setState(key, kind, payload) {
    var box = $('#state-' + key);
    var body = $('#panel-' + key);
    body.classList.remove('is-loading', 'has-error');
    if (kind === 'loading') {
      body.classList.add('is-loading');
      box.innerHTML = '';
      box.appendChild(el('div', 'skel-block'));
      box.appendChild(el('div', 'load-note', 'Loading ' + ASSETS[key].name + ' data…'));
      box.hidden = false;
      setTimeout(function () {
        var note = $('.load-note', box);
        if (note && state.data[key] === undefined) note.textContent = 'Still trying — the free feed can be slow. You can switch to Demo below.';
      }, 15000);
    } else if (kind === 'error') {
      body.classList.add('has-error');
      box.innerHTML = '';
      var card = el('div', 'error-card');
      card.setAttribute('role', 'alert');
      card.appendChild(el('div', 'error-title', 'Feed unavailable'));
      card.appendChild(el('p', 'error-cause', payload && payload.message ? String(payload.message) : 'Network error.'));
      var actions = el('div', 'error-actions');
      var retry = el('button', 'btn btn-outline', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () { loadAsset(key, true); });
      var demoBtn = el('button', 'btn btn-ghost', 'Load demo data');
      demoBtn.type = 'button';
      demoBtn.addEventListener('click', function () { startDemo(); });
      actions.appendChild(retry); actions.appendChild(demoBtn);
      card.appendChild(actions);
      box.appendChild(card);
      box.hidden = false;
    } else {
      box.hidden = true;
      box.innerHTML = '';
    }
  }

  function sessionChange(candles, sessionOf) {
    var last = sessionOf[sessionOf.length - 1];
    for (var i = sessionOf.length - 1; i >= 0; i--) {
      if (sessionOf[i] !== last) return candles[i + 1].o;
    }
    return candles[0].o;
  }

  function ruleStateChip(r) {
    var map = { bullish: ['BULLISH', 'chip-bull'], bearish: ['BEARISH', 'chip-bear'], extended: ['EXTENDED', 'chip-warn'], neutral: ['NEUTRAL', 'chip-flat'], na: ['N/A', 'chip-flat'] };
    var m = map[r.state] || map.neutral;
    return '<span class="chip ' + m[1] + '">' + m[0] + '</span>';
  }

  function renderAsset(key) {
    var a = ASSETS[key];
    var d = state.data[key];
    var res = state.result[key] = analyze(key);
    if (!d || !res || res.empty) return;
    setState(key, 'ok');   // data arrived — clear loading/error state

    var root = $('#panel-' + key);
    var live = d.candles[d.candles.length - 1];

    // price header
    $('#price-' + key).textContent = fmtPrice(a, live.c);
    var dayRef = sessionChange(d.candles, res.sessionOf);
    var chg = (live.c - dayRef) / dayRef * 100;
    var chgEl = $('#chg-' + key);
    chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '% session';
    chgEl.className = 'delta ' + (chg >= 0 ? 'up' : 'down');

    // verdict
    var badge = $('#badge-' + key);
    badge.textContent = res.verdict;
    badge.className = 'signal-badge ' + (res.verdict === 'BUY' ? 'sig-buy' : res.verdict === 'SELL' ? 'sig-sell' : 'sig-wait');
    $('#confv-' + key).textContent = res.confidence + '%';
    $('#confbar-' + key).style.width = Math.max(4, res.confidence) + '%';
    $('#score-' + key).textContent = (res.score >= 0 ? '+' : '') + res.score.toFixed(2);

    // rule cards
    var wrap = $('#rules-' + key);
    wrap.innerHTML = '';
    res.rules.forEach(function (r) {
      var card = el('div', 'rule-card rule-' + r.state);
      var head = el('div', 'rule-head');
      head.appendChild(el('span', 'rule-id', r.id));
      head.appendChild(el('span', 'rule-name', r.name));
      head.insertAdjacentHTML('beforeend', ruleStateChip(r));
      card.appendChild(head);
      card.appendChild(el('p', 'rule-reading', r.reading));
      var meta = el('div', 'rule-meta');
      var bits = [];
      if (r.id === 'R1') bits.push('VWAP ' + fmtPrice(a, r.vwap), 'z ' + (isFinite(r.z) ? r.z.toFixed(2) : '—'));
      if (r.id === 'R2') bits.push('Anchor VWAP ' + fmtPrice(a, r.vwap));
      if (r.id === 'R3') bits.push('Level ' + fmtPrice(a, r.level));
      if (r.id === 'R4') bits.push(r.div != null && isFinite(r.div) ? 'Δ ' + r.div.toFixed(2) + '% vs crowd' : 'no big-bar data');
      meta.textContent = bits.join(' · ');
      card.appendChild(meta);
      wrap.appendChild(card);
    });

    // trade plan strip
    var plan = $('#plan-' + key);
    plan.innerHTML = '';
    var cells;
    if (res.idea) {
      cells = [
        ['Signal', res.idea.side, res.idea.side === 'BUY' ? 'up' : 'down'],
        ['Entry', fmtPrice(a, res.idea.entry), ''],
        ['Stop', fmtPrice(a, res.idea.stop), 'down'],
        ['Target', fmtPrice(a, res.idea.target), 'up'],
        ['Reward:Risk', res.idea.rr.toFixed(2) + ' : 1', '']
      ];
    } else {
      cells = [['Signal', 'WAIT', ''], ['Entry', '—', ''], ['Stop', '—', ''], ['Target', '—', ''], ['Reward:Risk', '—', '']];
    }
    cells.forEach(function (c) {
      var cell = el('div', 'plan-cell');
      cell.appendChild(el('span', 'k', c[0]));
      var v = el('span', 'v ' + c[2], c[1]);
      cell.appendChild(v);
      plan.appendChild(cell);
    });

    // meta line
    var lastEvent = res.events.length ? res.events[res.events.length - 1] : null;
    var ago = lastEvent ? Math.max(0, res.evalIdx - lastEvent.i) : null;
    $('#meta-' + key).innerHTML = '';
    var src = el('span', '', d.source + (d.stale ? ' · update failed — data from ' + timeStr(d.fetchedAt, a.tz) : ''));
    $('#meta-' + key).appendChild(src);
    if (lastEvent) {
      $('#meta-' + key).appendChild(el('span', 'meta-dot', '·'));
      $('#meta-' + key).appendChild(el('span', '', 'last trigger: ' + lastEvent.label + ' (' + ago + ' bars ago)'));
    }

    // ticker alerts are option-driven now (see refreshOptionDesk / demo path)

    // projection summary line
    var projEl = $('#proj-' + key);
    if (projEl) {
      var f = res.forecast;
      projEl.textContent = f
        ? 'Projection · next ' + f.h + ' bars: median ' + (f.medianPct >= 0 ? '+' : '') + f.medianPct.toFixed(2) + '% · 80% band ' + ((f.lo[f.h - 1] / f.p0 - 1) * 100).toFixed(2) + '%…' + ((f.hi[f.h - 1] / f.p0 - 1) * 100).toFixed(2) + '% · ' + f.upCount + ' of ' + f.k + ' similar ' + f.m + '-bar setups closed higher — statistical, not a promise.'
        : '';
    }

    drawChart(key);
    renderOptionDesk(key);
    maybeRefreshOptions(key, false);
  }

  /* ================= CHART ================= */

  var SERIES = [
    { id: 'price', label: 'Candles', color: 'var(--ink)' },
    { id: 'proj', label: 'Projection', color: '#F0B90B' },
    { id: 'vwap', label: 'Session VWAP', color: '#F0B90B' },
    { id: 'band', label: '±2σ band', color: 'rgba(132,142,156,.55)' },
    { id: 'avwap', label: 'Anchored VWAP', color: '#1EAEDB' },
    { id: 'tsize', label: 'T-Size VWAP', color: '#FFD000' },
    { id: 'prev', label: 'Prev VWAP close', color: '#848E9C' }
  ];

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawChart(key, canvasOverride, barCount) {
    var a = ASSETS[key];
    var d = state.data[key], res = state.result[key];
    if (!d || !res || res.empty) return;
    var canvas = canvasOverride || $('#chart-' + key);
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var W = Math.max(320, rect.width), H = Math.max(180, rect.height);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var show = state.hidden[key] || {};
    var n = d.candles.length;
    var fh = (!show.proj && res.forecast) ? res.forecast.h : 0;
    var count = Math.min(barCount || Math.max(60, Math.min(170, Math.floor(W / 7))), n);
    var from = n - count;
    var total = count + fh;   // candle slots + projection steps
    var s = res.series;

    var min = Infinity, max = -Infinity;
    for (var i = from; i < n; i++) {
      [d.candles[i].l, d.candles[i].h, s.vwap[i], s.up2[i], s.lo2[i]].forEach(function (v) {
        if (isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
      });
      if (!show.avwap && isFinite(s.aVwap[i])) { if (s.aVwap[i] < min) min = s.aVwap[i]; if (s.aVwap[i] > max) max = s.aVwap[i]; }
      if (!show.prev && isFinite(s.prevClose[i])) { if (s.prevClose[i] < min) min = s.prevClose[i]; if (s.prevClose[i] > max) max = s.prevClose[i]; }
      if (!show.tsize && isFinite(s.bigVwap[i])) { if (s.bigVwap[i] < min) min = s.bigVwap[i]; if (s.bigVwap[i] > max) max = s.bigVwap[i]; }
    }
    if (fh) {
      res.forecast.hi.forEach(function (v) { if (isFinite(v)) { if (v < min) min = v; if (v > max) max = v; } });
      res.forecast.lo.forEach(function (v) { if (isFinite(v)) { if (v < min) min = v; if (v > max) max = v; } });
    }
    var pad = (max - min) * 0.06 || 1;
    min -= pad; max += pad;

    var padL = 6, padR = 62, padT = 8, padB = 22;
    var iw = W - padL - padR, ih = H - padT - padB;
    function X(i) { return padL + (i - from) / Math.max(total - 1, 1) * iw; }
    function Y(v) { return padT + (1 - (v - min) / (max - min)) * ih; }

    var ink = cssVar('--ink') || '#EAECEF';
    var grid = cssVar('--chart-grid') || 'rgba(132,142,156,.18)';
    var muted = cssVar('--ink-muted') || '#848E9C';

    ctx.clearRect(0, 0, W, H);
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

    // grid + y labels
    var rows = 4;
    for (var g = 0; g <= rows; g++) {
      var gy = padT + ih * g / rows;
      var gv = max - (max - min) * g / rows;
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + iw, gy); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(fmt(gv, a.dp), padL + iw + 6, gy);
    }
    // x labels
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    var xt = 5;
    for (var t = 0; t <= xt; t++) {
      var xi = from + Math.round((total - 1) * t / xt);
      if (xi > n - 1) xi = n - 1;
      ctx.fillText(hhmm(d.candles[xi].t, a.tz), X(xi), H - 6);
    }

    // band fill
    if (!show.band) {
      ctx.beginPath();
      for (i = from; i < n; i++) { var x = X(i), y = Y(s.up2[i]); i === from ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
      for (i = n - 1; i >= from; i--) { ctx.lineTo(X(i), Y(s.lo2[i])); }
      ctx.closePath();
      ctx.fillStyle = 'rgba(132,142,156,.08)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(132,142,156,.4)';
      ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath();
      for (i = from; i < n; i++) { var x2 = X(i), y2 = Y(s.up2[i]); i === from ? ctx.moveTo(x2, y2) : ctx.lineTo(x2, y2); }
      ctx.stroke();
      ctx.beginPath();
      for (i = from; i < n; i++) { var x3 = X(i), y3 = Y(s.lo2[i]); i === from ? ctx.moveTo(x3, y3) : ctx.lineTo(x3, y3); }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function line(arr, color, width, dash) {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      var started = false;
      for (i = from; i < n; i++) {
        var v = arr[i];
        if (!isFinite(v)) { started = false; continue; }
        var x = X(i), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (!show.prev) line(s.prevClose, muted, 1, [2, 3]);
    if (!show.avwap) line(s.aVwap, '#1EAEDB', 1.6);
    if (!show.tsize && res.hasVolume) line(s.bigVwap, '#FFD000', 1.4, [5, 3]);
    if (!show.vwap) line(s.vwap, '#F0B90B', 2);
    if (!show.price) {
      var slot = iw / Math.max(total - 1, 1);
      var bw = Math.max(1.5, Math.min(9, slot * 0.62));
      for (i = from; i < n; i++) {
        var cd = d.candles[i];
        var upC = cd.c >= cd.o;
        var cx = X(i);
        ctx.strokeStyle = upC ? '#0ECB81' : '#F6465D';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx, Y(cd.h)); ctx.lineTo(cx, Y(cd.l)); ctx.stroke();
        var yO = Y(cd.o), yC = Y(cd.c);
        var bodyTop = Math.min(yO, yC), bodyH = Math.max(Math.abs(yC - yO), 1);
        ctx.fillStyle = upC ? 'rgba(14,203,129,.85)' : 'rgba(246,70,93,.85)';
        ctx.fillRect(cx - bw / 2, bodyTop, bw, bodyH);
        if (bw > 2.5) ctx.strokeRect(cx - bw / 2, bodyTop, bw, bodyH);
      }
      // last price chip
      var lastV = d.candles[n - 1].c;
      var ly = Math.min(Math.max(Y(lastV), padT + 8), padT + ih - 8);
      ctx.fillStyle = lastV >= d.candles[from].c ? '#0ECB81' : '#F6465D';
      ctx.fillRect(padL + iw + 2, ly - 8, padR - 6, 16);
      ctx.fillStyle = '#0B0E11';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(fmt(lastV, a.dp), padL + iw + 6, ly);
    }

    // projection: cone + median path to the right of "now"
    if (fh) {
      var f = res.forecast;
      var slot2 = iw / Math.max(total - 1, 1);
      var xNow = X(n - 1) + slot2 / 2;
      ctx.strokeStyle = 'rgba(132,142,156,.45)';
      ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(xNow) + 0.5, padT); ctx.lineTo(Math.round(xNow) + 0.5, padT + ih); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(X(n - 1), Y(f.p0));
      for (i = 0; i < f.h; i++) ctx.lineTo(X(n + i), Y(f.hi[i]));
      for (i = f.h - 1; i >= 0; i--) ctx.lineTo(X(n + i), Y(f.lo[i]));
      ctx.closePath();
      ctx.fillStyle = 'rgba(240,185,11,.07)';
      ctx.fill();
      ctx.strokeStyle = ink; ctx.lineWidth = 1.4; ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(X(n - 1), Y(f.p0));
      for (i = 0; i < f.h; i++) ctx.lineTo(X(n + i), Y(f.median[i]));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    canvas.__chart = { key: key, from: from, count: count, total: total, padL: padL, padR: padR, padT: padT, padB: padB, iw: iw, ih: ih, min: min, max: max, W: W, H: H, big: !!barCount };
  }

  function bindCrosshair(canvas, tipEl) {
    canvas.addEventListener('mousemove', function (ev) {
      var cfg = canvas.__chart;
      if (!cfg) return;
      var rect = canvas.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var idx = cfg.from + Math.round((mx - cfg.padL) / cfg.iw * (cfg.total - 1));
      var d = state.data[cfg.key];
      if (!d || idx < 0 || idx >= d.candles.length) { tipEl.hidden = true; return; }
      var a = ASSETS[cfg.key], res = state.result[cfg.key], s = res.series;
      var c = d.candles[idx];
      tipEl.hidden = false;
      tipEl.innerHTML =
        '<b>' + timeStr(c.t, a.tz) + '</b><br>' +
        'O ' + fmt(c.o, a.dp) + ' · H ' + fmt(c.h, a.dp) + '<br>' +
        'L ' + fmt(c.l, a.dp) + ' · C ' + fmt(c.c, a.dp) + '<br>' +
        'VWAP ' + fmt(s.vwap[idx], a.dp) + ' (z ' + s.z[idx].toFixed(2) + ')<br>' +
        'Anch ' + (isFinite(s.aVwap[idx]) ? fmt(s.aVwap[idx], a.dp) : '—') +
        ' · T-Size ' + (isFinite(s.bigVwap[idx]) ? fmt(s.bigVwap[idx], a.dp) : '—');
      var tx = Math.min(mx + 14, cfg.W - 190);
      var ty = Math.min(my + 12, cfg.H - 92);
      tipEl.style.left = tx + 'px';
      tipEl.style.top = ty + 'px';
    });
    canvas.addEventListener('mouseleave', function () { tipEl.hidden = true; });
  }

  /* ---------------- focus modal ---------------- */
  var modal = null, lastFocus = null;
  function openFocus(key) {
    var a = ASSETS[key];
    lastFocus = document.activeElement;
    var ov = $('#focusModal');
    ov.hidden = false;
    $('#focusTitle').textContent = a.name + ' — ' + a.code;
    var cv = $('#focusCanvas');
    var tip = $('#focusTip');
    cv.style.width = '100%';
    cv.style.height = '62vh';
    drawChart(key, cv, 420);
    bindOnce(cv, tip);
    modal = key;
    $('#focusClose').focus();
  }
  function closeFocus() {
    if (!modal) return;
    $('#focusModal').hidden = true;
    modal = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  var bound = new WeakSet();
  function bindOnce(cv, tip) {
    if (bound.has(cv)) return;
    bound.add(cv);
    bindCrosshair(cv, tip);
    var rz;
    window.addEventListener('resize', function () {
      if (modal && cv && !$('#focusModal').hidden) {
        clearTimeout(rz);
        rz = setTimeout(function () { drawChart(modal, cv, 420); }, 120);
      }
    });
  }

  /* ================= DATA FLOW ================= */

  function fetchUpstoxCandles(key) {
    var a = ASSETS[key];
    var und = encodeURIComponent(UNDERLYING[key]);
    var today = new Date().toISOString().slice(0, 10);
    var fromD = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10);
    // v3 intraday = today's 30m bars; v3 historical = previous days. Stitch both.
    return proxyFetch('/historical-candle/intraday/' + und + '/minutes/30')
      .then(function (j1) { return (j1.data && j1.data.candles) || []; })
      .then(function (todayRows) {
        return proxyFetch('/historical-candle/' + und + '/minutes/30/' + today + '/' + fromD)
          .then(function (j2) {
            var hist = (j2.data && j2.data.candles) || [];
            var all = hist.concat(todayRows);
            if (all.length < 50) throw new Error('too few Upstox candles');
            var seen = {}, candles = [];
            all.forEach(function (r) {
              var t = Date.parse(r[0]);
              if (!isFinite(t) || seen[t]) return;
              seen[t] = 1;
              candles.push({ t: t, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] || 0 });
            });
            candles.sort(function (x, y) { return x.t - y.t; });
            if (candles.length < 50) throw new Error('too few Upstox candles after merge');
            return { candles: candles, source: 'Upstox · ' + a.code + ' · 30m' };
          });
      });
  }

  function loadAsset(key, manual) {
    var a = ASSETS[key];
    setState(key, 'loading');
    var fetcher;
    if (key === 'btc') fetcher = fetchBTC();
    else if (state.authOk) fetcher = fetchUpstoxCandles(key).catch(function () { return fetchYahoo(a); });
    else fetcher = fetchYahoo(a);
    return fetcher.then(function (r) {
      state.data[key] = { candles: r.candles, source: r.source, fetchedAt: Date.now(), stale: false, demo: false };
      state.countdown[key] = a.refreshSec;
      renderAsset(key);
      maybeRefreshOptions(key, false);
      if (manual) flashStatus(a.name + ' updated');
    }).catch(function (err) {
      if (state.data[key] && state.data[key].candles) {
        state.data[key].stale = true;
        state.countdown[key] = ASSETS[key].refreshSec * 2;
        renderAsset(key);
        flashStatus(a.name + ' update failed — retrying with backoff');
      } else {
        setState(key, 'error', { message: err && err.message ? err.message : 'Network unreachable — the browser could not reach the data feed.' });
      }
    });
  }

  function loadAll(manual) {
    KEYS.forEach(function (k) { loadAsset(k, manual); });
  }

  function resetAlerts() {
    alertFeed.splice(0, alertFeed.length);
    state.alertSeen = {};
    state.seenQueue = [];
    rebuildTicker();
  }

  function startDemo() {
    stopLiveTimers();
    state.mode = 'demo';
    state.demoOpt = {};
    resetAlerts();
    syncModeUI();
    KEYS.forEach(function (k) {
      var r = demoCandles(k);
      state.data[k] = { candles: r.candles, source: r.source + ' · DEMO', fetchedAt: Date.now(), stale: false, demo: true };
    });
    // seed synthetic option desks for the three indices
    var STRIDE = { nifty: 50, banknifty: 100, sensex: 100 };
    var OPTBASE = { nifty: { ce: 185, pe: 178 }, banknifty: { ce: 460, pe: 445 }, sensex: { ce: 395, pe: 385 } };
    ['nifty', 'banknifty', 'sensex'].forEach(function (k) {
      var spot = state.data[k].candles[state.data[k].candles.length - 1].c;
      var atm = Math.round(spot / STRIDE[k]) * STRIDE[k];
      var ob = OPTBASE[k];
      state.demoOpt[k] = { atm: atm, expiry: 'demo-weekly', ce: { ltp: ob.ce, ask: ob.ce * 1.005 }, pe: { ltp: ob.pe, ask: ob.pe * 1.005 } };
    });
    KEYS.forEach(function (k) { renderAsset(k); });
    state.timers.demo = setInterval(stepDemo, 4000);
    flashStatus('Demo mode — synthetic data, animated. Switch back to LIVE anytime.');
  }

  function goLive() {
    stopLiveTimers();
    state.mode = 'live';
    state.demoOpt = {};
    resetAlerts();
    syncModeUI();
    loadAll(false);
  }

  function stopLiveTimers() {
    if (state.timers.demo) { clearInterval(state.timers.demo); state.timers.demo = null; }
  }

  function redrawAll() {
    KEYS.forEach(function (k) { if (state.data[k]) drawChart(k); });
  }

  /* ================= UPSTOX OPTION DESK (buyer) ================= */
  var PROXY = 'https://vwap-optproxy.suman20.workers.dev/proxy?url=';
  var UNDERLYING = {
    nifty: 'NSE_INDEX|Nifty 50',
    banknifty: 'NSE_INDEX|Nifty Bank',
    sensex: 'BSE_INDEX|SENSEX'
  };
  var LOT = { nifty: 75, banknifty: 35, sensex: 20 };
  var IV_GUESS = { nifty: 0.12, banknifty: 0.15, sensex: 0.12 };
  var EXPIRY_DOW = { nifty: 2, banknifty: 2, sensex: 4 }; // Tue / Tue / Thu — verify on the exchange site

  var AUTH = 'https://vwap-optproxy.suman20.workers.dev';
  function pollAuthStatus() {
    return fetch(AUTH + '/status').then(function (r) { return r.json(); }).then(function (j) {
      var was = state.authOk;
      state.authOk = !!j.authorized;
      var dot = $('#tokenDot');
      if (dot) dot.className = 'dot ' + (state.authOk ? 'dot-live' : 'dot-demo');
      var lbl = $('#tokenLabel');
      if (lbl) lbl.textContent = state.authOk ? 'Upstox connected' : 'Connect Upstox';
      if (!was && state.authOk) {
        flashStatus('Upstox connected — loading live option premiums. Tokens renew automatically now.');
        KEYS.forEach(function (k) { maybeRefreshOptions(k, true); });
        rebuildTicker();
      }
      return state.authOk;
    }).catch(function () { state.authOk = false; return false; });
  }

  function proxyFetch(path, opts) {
    var init = { method: (opts && opts.method) || 'GET', headers: { Accept: 'application/json' } };
    if (opts && opts.body) {
      init.body = JSON.stringify(opts.body);
      init.headers['Content-Type'] = 'application/json';
    }
    return fetch(PROXY + encodeURIComponent('https://api.upstox.com/v2' + path), init)
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 401) throw new Error('not-connected');
          if (!r.ok || j.status === 'error') throw new Error((j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status));
          return j;
        });
      });
  }

  function extractQuote(q, instrumentKey) {
    var d = (q && q.data) || {};
    var want = String(instrumentKey);
    var wantColon = want.replace('|', ':');
    if (d[wantColon]) return normQuote(d[wantColon]);
    for (var k in d) {
      var v = d[k];
      if (v && (v.instrument_token === want || v.instrument_token === wantColon)) return normQuote(v);
    }
    var suffix = want.split(':').slice(1).join(':');
    for (var k2 in d) {
      if (k2.split(':').slice(1).join(':') === suffix) return normQuote(d[k2]);
    }
    return null;
  }
  function normQuote(x) {
    if (!x || x.last_price == null) return null;
    var ask = x.depth && x.depth.sell && x.depth.sell[0] ? x.depth.sell[0].price : null;
    return { ltp: x.last_price, ask: ask != null ? ask : x.last_price };
  }
  function stepGuess(strikes) {
    var gaps = [];
    for (var i = 1; i < strikes.length; i++) gaps.push(strikes[i] - strikes[i - 1]);
    gaps.sort(function (a, b) { return a - b; });
    return gaps[Math.floor(gaps.length / 2)] || 100;
  }

  function maybeRefreshOptions(key, force) {
    if (key === 'btc') return;
    if (!state.authOk) { renderOptionDesk(key); return; }
    var st = state.opt[key];
    if (st && st.fetching) return;
    if (!force && st && st.status === 'ok' && st.updatedAt && Date.now() - st.updatedAt < 60000) return;
    refreshOptionDesk(key);
  }

  function refreshOptionDesk(key) {
    var st = state.opt[key] = state.opt[key] || {};
    st.fetching = true; st.status = 'loading'; st.error = null;
    renderOptionDesk(key);
    var und = UNDERLYING[key];

    // Upstox: GET /v2/option/contract?instrument_key=<underlying> returns the flat
    // contract list (works on all plans). Premiums then come from market-quote.
    function fetchChain() {
      return proxyFetch('/option/contract?instrument_key=' + encodeURIComponent(und))
        .then(function (j) {
          var list = (j.data && (j.data.items || j.data)) || [];
          if (!Array.isArray(list) || !list.length) throw new Error('no option contracts returned');
          var today = new Date().toISOString().slice(0, 10);
          var expiries = [];
          list.forEach(function (c) { if (c.expiry && expiries.indexOf(c.expiry) < 0) expiries.push(c.expiry); });
          expiries.sort();
          var expiry = expiries.find(function (e) { return e >= today; }) || expiries[0];
          var calls = [], puts = [];
          list.forEach(function (c) {
            if (c.expiry !== expiry) return;
            var type = c.instrument_type || String(c.tradingsymbol || '').slice(-2);
            if (type === 'CE') calls.push({ strike_price: c.strike_price, instrument_key: c.instrument_key, lot_size: c.lot_size });
            else if (type === 'PE') puts.push({ strike_price: c.strike_price, instrument_key: c.instrument_key, lot_size: c.lot_size });
          });
          if (!calls.length) throw new Error('no calls in contract list for expiry ' + expiry);
          return { calls: calls, puts: puts, expiry: expiry, embedded: false };
        });
    }

    function chainQuote(entry) {
      if (!entry) return null;
      var md = entry.option_market_data || {};
      var ask = md.ask_price != null ? md.ask_price : (md.ask != null ? md.ask : null);
      var ltp = md.ltp != null ? md.ltp : null;
      if (ltp == null && ask == null) return null;
      return { ltp: ltp != null ? ltp : ask, ask: ask != null ? ask : ltp };
    }

    return fetchChain()
      .then(function (chain) {
        var calls = chain.calls, puts = chain.puts;
        var strikes = calls.map(function (c) { return +c.strike_price; }).sort(function (a, b) { return a - b; });
        st.expiry = chain.expiry;
        return proxyFetch('/market-quote/quotes?instrument_key=' + encodeURIComponent(und))
          .then(function (q) {
            var spot = extractQuote(q, und);
            if (!spot) throw new Error('no spot quote returned');
            st.spot = spot.ltp;
            var atm = strikes.reduce(function (best, s) { return Math.abs(s - spot.ltp) < Math.abs(best - spot.ltp) ? s : best; }, strikes[0]);
            st.atm = atm;
            var stepv = stepGuess(strikes);
            var wanted = strikes.filter(function (s) { return Math.abs(s - atm) <= 2 * stepv; }).slice(0, 5);
            function entryFor(arr, s) {
              for (var i = 0; i < arr.length; i++) if (+arr[i].strike_price === s) return arr[i];
              return null;
            }
            var rows, quoteDone;
            st.lot = (calls[0] && calls[0].lot_size) || LOT[key];
            if (chain.embedded) {
              rows = wanted.map(function (s) {
                return { strike: s, ce: chainQuote(entryFor(calls, s)), pe: chainQuote(entryFor(puts, s)) };
              });
              quoteDone = Promise.resolve(null);
            } else {
              rows = wanted.map(function (s) {
                var c = entryFor(calls, s), p = entryFor(puts, s);
                return { strike: s, ceKey: c && c.instrument_key, peKey: p && p.instrument_key };
              });
              var keys = [];
              rows.forEach(function (r) { if (r.ceKey) keys.push(r.ceKey); if (r.peKey) keys.push(r.peKey); });
              quoteDone = proxyFetch('/market-quote/quotes?instrument_key=' + encodeURIComponent(keys.join(',')))
                .then(function (q2) {
                  rows.forEach(function (r) { r.ce = extractQuote(q2, r.ceKey); r.pe = extractQuote(q2, r.peKey); });
                });
            }
            return quoteDone.then(function () {
              var atmRow = rows.filter(function (r) { return r.strike === atm; })[0];
              if (atmRow) {
                evaluateOptionAlerts(key, atm, st.expiry, atmRow.ce, atmRow.pe, st.prevCeAsk, st.prevPeAsk);
                if (atmRow.ce && atmRow.ce.ask != null) st.prevCeAsk = atmRow.ce.ask;
                if (atmRow.pe && atmRow.pe.ask != null) st.prevPeAsk = atmRow.pe.ask;
              }
              st.rows = rows; st.status = 'ok'; st.updatedAt = Date.now();
            });
          });
      })
      .catch(function (e) {
        st.status = 'error';
        st.error = e.message === 'not-connected'
          ? 'Upstox not connected — click “Connect Upstox” in the top bar (one-time). Tokens renew automatically afterwards.'
          : e.message === 'token-expired'
          ? 'Upstox session expired — click “Connect Upstox” again to re-authorize.'
          : 'Option feed error: ' + e.message;
      })
      .then(function () { st.fetching = false; renderOptionDesk(key); });
  }

  function erf(x) {
    var s = x < 0 ? -1 : 1; x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function bsATM(spot, days, iv) {
    var T = Math.max(days, 0.03) / 365, r = 0.065, s = iv;
    var d1 = (Math.log(spot / spot) + (r + s * s / 2) * T) / (s * Math.sqrt(T));
    var d2 = d1 - s * Math.sqrt(T);
    var nd = function (x) { return 0.5 * (1 + erf(x / Math.SQRT2)); };
    var ce = spot * nd(d1) - spot * Math.exp(-r * T) * nd(d2);
    var pe = ce - (spot - spot * Math.exp(-r * T));
    return { ce: Math.max(ce, 0.05), pe: Math.max(pe, 0.05) };
  }
  function daysToExpiry(key) {
    var d = (EXPIRY_DOW[key] - new Date().getDay() + 7) % 7;
    return d === 0 ? 0.3 : d;
  }

  function renderOptionDesk(key) {
    var box = $('#opt-' + key);
    if (!box) return;
    var a = ASSETS[key];
    var st = state.opt[key] || {};
    var html = '<div class="opt-head"><span class="k">Option desk · buyer</span>';
    if (st.expiry) html += '<span class="opt-chip">expiry ' + st.expiry + '</span>';
    if (st.status === 'loading') html += '<span class="opt-chip">loading…</span>';
    html += '</div>';

    if (st.status === 'ok' && st.rows) {
      var atmRow = st.rows.filter(function (r) { return r.strike === st.atm; })[0];
      var lot = st.lot || LOT[key];
      html += '<div class="opt-spot">Spot ' + fmt(st.spot, a.dp) + ' · ATM ' + fmt(st.atm, 0) + '</div>';
      if (atmRow) {
        html += '<div class="opt-cards">';
        ['ce', 'pe'].forEach(function (side) {
          var q = atmRow[side];
          var name = side.toUpperCase();
          html += '<div class="opt-card ' + (side === 'ce' ? 'opt-ce' : 'opt-pe') + '">' +
            '<span class="k">BUY ' + name + ' ' + fmt(st.atm, 0) + '</span>' +
            '<span class="v">' + (q ? '₹' + fmt(q.ask, 1) : '—') + '</span>' +
            '<span class="s">' + (q ? 'ask · ltp ₹' + fmt(q.ltp, 1) + ' · per lot ₹' + fmt(q.ask * lot, 0) : 'no quote') + '</span>' +
            '</div>';
        });
        html += '</div>';
      }
      html += '<table class="opt-strip"><thead><tr><th>Strike</th><th>CE ask</th><th>PE ask</th></tr></thead><tbody>';
      st.rows.forEach(function (r) {
        var atmMark = r.strike === st.atm ? ' class="atm"' : '';
        html += '<tr' + atmMark + '><td>' + fmt(r.strike, 0) + (r.strike === st.atm ? ' •' : '') + '</td><td>' + (r.ce ? fmt(r.ce.ask, 1) : '—') + '</td><td>' + (r.pe ? fmt(r.pe.ask, 1) : '—') + '</td></tr>';
      });
      html += '</tbody></table>';
      html += '<div class="opt-note">Buyer pays the ask' + (st.expiry === 'demo-weekly' ? ' · demo data' : '') + '. Lot size ' + lot + ' (verify on the exchange). Updated ' + (st.updatedAt ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(st.updatedAt) : '—') + '.</div>';
    } else if (!state.authOk) {
      var spotNow = state.data[key] ? state.data[key].candles[state.data[key].candles.length - 1].c : null;
      if (spotNow) {
        var est = bsATM(spotNow, daysToExpiry(key), IV_GUESS[key]);
        html += '<div class="opt-note">Upstox not connected — click <b>Connect Upstox</b> (top bar) once; tokens renew automatically afterwards. Theoretical Black–Scholes estimate for the ' + fmt(spotNow, 0) + ' ATM strike (assumed IV ' + Math.round(IV_GUESS[key] * 100) + '%, ~' + (daysToExpiry(key) < 1 ? 'expiry day' : Math.round(daysToExpiry(key)) + 'd to expiry') + '):' +
          ' <b class="up">CE ≈ ₹' + est.ce.toFixed(1) + '</b> · <b class="down">PE ≈ ₹' + est.pe.toFixed(1) + '</b>.</div>';
      } else {
        html += '<div class="opt-note">Waiting for price data — the theoretical estimate appears once the index feed loads.</div>';
      }
    } else if (st.status === 'error') {
      html += '<div class="opt-note opt-err">' + st.error + '</div>';
    } else if (st.status === 'loading') {
      html += '<div class="opt-note">Fetching option chain from Upstox…</div>';
    }
    box.innerHTML = html;
  }

  /* ================= LIVE ALERT TICKER (option buy/sell calls) ================= */
  var ALERT_PCT = 2.5;      // minimum ask move (%) to fire an alert
  var AGGRESSIVE_PCT = 6;   // above this the wording says AGGRESSIVE
  var alertFeed = [];

  function evaluateOptionAlerts(key, atm, expiry, ce, pe, prevCeAsk, prevPeAsk) {
    var a = ASSETS[key];
    function side(opt, name, prev) {
      if (!opt || opt.ask == null || prev == null || !isFinite(prev)) return;
      var chg = (opt.ask - prev) / prev * 100;
      if (chg >= ALERT_PCT) {
        var agg = chg >= AGGRESSIVE_PCT ? 'AGGRESSIVE ' : '';
        pushAlert(key, agg + 'BUYING ' + fmt(atm, 0) + ' ' + name + ' · ask ₹' + fmt(opt.ask, 1) + ' (+' + chg.toFixed(1) + '%)', Date.now(), 'opt|' + key + '|' + name + '|' + atm + '|' + Math.round(chg * 10), 'up');
      } else if (chg <= -ALERT_PCT) {
        pushAlert(key, 'SELLING ' + fmt(atm, 0) + ' ' + name + ' · ask ₹' + fmt(opt.ask, 1) + ' (' + chg.toFixed(1) + '%)', Date.now(), 'opt|' + key + '|' + name + '|' + atm + '|' + Math.round(chg * 10), 'down');
      }
    }
    side(ce, 'CE', prevCeAsk);
    side(pe, 'PE', prevPeAsk);
  }

  function pushAlert(key, text, t, i, cls) {
    var a = ASSETS[key];
    var id = key + '|' + (i == null ? text : i) + '|' + text;
    if (state.alertSeen[id]) return;
    state.alertSeen[id] = 1;
    state.seenQueue.push(id);
    if (state.seenQueue.length > 80) delete state.alertSeen[state.seenQueue.shift()];
    alertFeed.unshift({ asset: a.name, text: text, time: t ? hhmm(t, a.tz) : '', cls: cls || '' });
    if (alertFeed.length > 24) alertFeed.pop();
    rebuildTicker();
  }
  function rebuildTicker() {
    var track = $('#tickerTrack');
    if (!track) return;
    if (!alertFeed.length) {
      track.innerHTML = '<span class="tick-item">' +
        (state.authOk
          ? 'Live call alerts armed — watching Nifty, Bank Nifty and Sensex option desks. An alert fires when ATM call/put asks move by ' + ALERT_PCT + '%+.'
          : 'Waiting for live option data — click “Connect Upstox” once to stream buy/sell call alerts (Nifty, Bank Nifty, Sensex).') +
        '</span>';
      track.style.animation = 'none';
      return;
    }
    track.style.animation = '';
    var group = alertFeed.map(function (a) {
      return '<span class="tick-item"><b>' + a.asset + '</b><span class="' + a.cls + '">' + a.text + '</span>' + (a.time ? '<span class="tick-time">' + a.time + '</span>' : '') + '</span>';
    }).join('');
    track.innerHTML = group + group; // duplicated for the seamless loop
  }

  function syncModeUI() {
    $$('#modeSeg button').forEach(function (b) {
      var on = b.dataset.mode === state.mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $('#liveDot').className = 'dot ' + (state.mode === 'live' ? 'dot-live' : 'dot-demo');
    $('#modeLabel').textContent = state.mode === 'live' ? 'LIVE FEEDS' : 'DEMO · SYNTHETIC';
  }

  var statusTimer = null;
  function flashStatus(msg) {
    var s = $('#statusMsg');
    s.textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { s.textContent = defaultStatus(); }, 6000);
  }
  function defaultStatus() {
    return state.mode === 'live' ? 'Live feeds on — BTC every 60s, Nifty every 5 min.' : 'Demo mode — animated synthetic bars.';
  }

  /* ================= INIT ================= */

  function buildLegend(key) {
    var wrap = $('#legend-' + key);
    wrap.innerHTML = '';
    SERIES.forEach(function (sr) {
      if (sr.id === 'tsize' && key === 'nifty') { /* still shown; becomes N/A when no volume */ }
      var b = el('button', 'lg' + (state.hidden[key] && state.hidden[key][sr.id] ? ' off' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', state.hidden[key] && state.hidden[key][sr.id] ? 'false' : 'true');
      b.style.setProperty('--lg-c', sr.color);
      b.appendChild(el('span', 'lg-swatch'));
      b.appendChild(document.createTextNode(sr.label));
      b.addEventListener('click', function () {
        state.hidden[key] = state.hidden[key] || {};
        state.hidden[key][sr.id] = !state.hidden[key][sr.id];
        b.classList.toggle('off', state.hidden[key][sr.id]);
        b.setAttribute('aria-pressed', state.hidden[key][sr.id] ? 'false' : 'true');
        drawChart(key);
      });
      wrap.appendChild(b);
    });
  }

  function init() {
    // theme
    var saved = safeLS(function () { return localStorage.getItem('vwap-theme'); }) || 'dark';
    setTheme(saved);
    $$('#themeSeg button').forEach(function (b) {
      b.addEventListener('click', function () { setTheme(b.dataset.theme); });
    });

    // mode
    $$('#modeSeg button').forEach(function (b) {
      b.addEventListener('click', function () { b.dataset.mode === 'live' ? goLive() : startDemo(); });
    });
    syncModeUI();

    // refresh
    $('#refreshBtn').addEventListener('click', function () {
      if (state.mode === 'live') loadAll(true); else startDemo();
    });

    // upstox connect (one-time OAuth in a new tab; tokens auto-renew server-side)
    $('#tokenBtn').addEventListener('click', function () {
      window.open(AUTH + '/login', '_blank', 'noopener');
      flashStatus('Complete the Upstox consent in the new tab — this is one-time only.');
    });
    pollAuthStatus();
    setInterval(pollAuthStatus, 30000);
    window.addEventListener('focus', pollAuthStatus);
    rebuildTicker();
    KEYS.forEach(function (k) { renderOptionDesk(k); });

    // focus modal
    $('#focusClose').addEventListener('click', closeFocus);
    $('#focusModal').addEventListener('click', function (e) { if (e.target === $('#focusModal')) closeFocus(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeFocus(); });
    KEYS.forEach(function (k) {
      $('#expand-' + k).addEventListener('click', function () { openFocus(k); });
    });

    // crosshairs
    KEYS.forEach(function (k) {
      bindCrosshair($('#chart-' + k), $('#tip-' + k));
    });

    // legends + first paint
    KEYS.forEach(function (k) { buildLegend(k); });

    // clock
    setInterval(function () {
      var now = new Date();
      $('#clockIST').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
      $('#clockUTC').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
    }, 1000);

    // countdown / auto refresh
    setInterval(function () {
      if (state.mode !== 'live') return;
      KEYS.forEach(function (k) {
        if (!state.data[k] || state.data[k].demo) return;
        state.countdown[k] = (state.countdown[k] || ASSETS[k].refreshSec) - 1;
        var cdEl = $('#cd-' + k);
        if (cdEl) cdEl.textContent = state.countdown[k] > 0 ? state.countdown[k] + 's' : 'now';
        if (state.countdown[k] <= 0) loadAsset(k, false);
      });
    }, 1000);

    // resize redraw
    var rzT;
    window.addEventListener('resize', function () {
      clearTimeout(rzT);
      rzT = setTimeout(function () { KEYS.forEach(function (k) { if (state.data[k]) drawChart(k); }); }, 150);
    });

    // pine copy / download
    var pine = window.PINE_SOURCE || '';
    $('#copyPine').addEventListener('click', function () {
      function done(ok) {
        var b = $('#copyPine');
        b.textContent = ok ? 'Copied ✓' : 'Copy failed — select the code manually';
        setTimeout(function () { b.textContent = 'Copy Pine Script'; }, 2500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pine).then(function () { done(true); }, function () { done(false); });
      } else { done(false); }
    });
    $('#dlPine').addEventListener('click', function () {
      var blob = new Blob([pine], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var aEl = document.createElement('a');
      aEl.href = url;
      aEl.download = 'vwap-precision-signals.pine';
      document.body.appendChild(aEl);
      aEl.click();
      aEl.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    });

    // anchor nav (native jump, no smooth-scroll scripting)
    $$('.nav a').forEach(function (a) {
      a.addEventListener('click', function () {
        $$('.nav a').forEach(function (x) { x.classList.remove('active'); });
        a.classList.add('active');
      });
    });

    // pine code box (collapsed by default for performance)
    $('#pineCode').textContent = pine;
    $('#pineToggle').addEventListener('click', function () {
      var box = $('#pineCodeWrap');
      var openNow = !box.hidden;
      box.hidden = openNow;
      $('#pineToggle').setAttribute('aria-expanded', openNow ? 'false' : 'true');
      $('#pineToggle').textContent = openNow ? 'Show the full Pine Script' : 'Hide the Pine Script';
    });

    // go — resolve Upstox auth first so index candles use it on the very first load
    pollAuthStatus().then(function () { loadAll(false); });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

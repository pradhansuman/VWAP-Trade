# VWAP Precision Signals — Nifty 50 & Bitcoin

A self-contained trading signal desk that scores **Nifty 50** and **Bitcoin** against four VWAP rules and shows a BUY / SELL / WAIT verdict with confidence, per-rule readings, a trade-plan strip (entry / stop / target / reward-risk), and interactive charts. Ships with the matching **Pine Script v5 indicator** for TradingView.

> Educational tool — not financial advice. Signals describe where price has traded, not what happens next.

## Run it

No build step, no dependencies:

- **Simplest:** double-click `index.html` (works from `file://`).
- **Or serve it:** `python3 -m http.server 8000` in this folder → open `http://localhost:8000`.
- **Or deploy:** upload the folder to any static host. Entry point: `index.html`.

Data loads client-side from public endpoints:
- **Bitcoin** — Binance public market data, BTCUSDT 5-minute bars (3 host fallbacks), auto-refresh 60s.
- **Nifty 50 / Bank Nifty / Sensex** — Upstox 30-minute candles from your connected account (primary); Yahoo Finance public quotes via CORS relays as fallback; auto-refresh 5 min. The NSE spot index publishes no volume, so **Rule 4 reads N/A there** — use NIFTY futures on TradingView for the full four-rule read.
- If a feed is slow or blocked, the panel shows a loading skeleton, then a "Feed unavailable" card with **Retry** and **Load demo data** (clearly labeled synthetic data, animated, for exploring the logic). A stale feed downgrades to a warning with 2× backoff instead of blanking out.

## Files

| File | Purpose |
|---|---|
| `index.html` | The desk — layout, sections, copy |
| `styles.css` | Theme (dark/light), all component states |
| `engine.js` | The four-rule signal engine (same math as the Pine script) |
| `app.js` | Data fetching, fallbacks, rendering, canvas charts, interactions |
| `pine-embed.js` | Generated copy of the Pine source shown on the page (do not edit by hand) |
| `vwap-precision-signals.pine` | The TradingView indicator — the canonical Pine source |

## The four rules (and the composite)

1. **Time-Based VWAP (R1, 25%)** — session VWAP with ±1σ/±2σ bands. A snap-back from outside the 2σ band to inside scores ±1 and holds 12 bars. Never chases an extended move.
2. **Anchored VWAP (R2, 30%)** — VWAP from the last confirmed swing low (5-bar pivots). Above it: trend has fuel. Below it: warning, trend may be running out of steam.
3. **Previous VWAP Close (R3, 20%)** — yesterday's final VWAP as a wall. A visit that stays inside a 0.15% touch zone and then crosses the level scores ±1.
4. **T-Size VWAP (R4, 25%)** — VWAP of "big player" bars only (volume > 3× the 50-bar average). When their average drifts ≥ 0.15% from the crowd's VWAP, that's the early clue.

**Verdict:** weighted sum of the four votes (each −1..+1), evaluated on the latest **closed** bar. Score ≥ +0.35 → BUY, ≤ −0.35 → SELL, otherwise WAIT. Confidence = |score| ÷ 0.6, capped at 100%. Trade idea: entry = last close, stop = beyond the 10-bar extreme or the 2σ band (whichever is wider), target = the previous VWAP close if it's in the trade's direction, else the opposite 2σ band.

## Modify it

- **Thresholds & weights** — `DEFAULTS` at the top of `engine.js` (`bandMult2`, `holdBars`, `pivotK`, `touchPct`, `bigMult`, `divThr`, weights `w`, verdict levels `buyAt`/`sellAt`). Keep the Pine inputs in sync if you change defaults.
- **Symbols / intervals / refresh** — the `ASSETS` config near the top of `app.js`.
- **Colors & theme** — CSS variables at the top of `styles.css` (`--accent`, `--good`, `--bad`, `--bg`, `--surface`).
- **Copy & sections** — `index.html`; the rules explainer and scoring table live there as plain HTML.
- **Pine indicator inputs** — everything is an input in TradingView (session reset, bands, pivot strength, touch zone, big-bar multiple, divergence trigger, signal hold).

## Live option call alerts (ticker)

The scrolling ticker at the top streams **buy/sell pressure alerts on ATM calls and puts** for Nifty, Bank Nifty and Sensex — it fires when the option ask moves **2.5%+ between refreshes** ("AGGRESSIVE" above 6%), e.g. `NIFTY 50 · BUYING 24,800 CE · ask ₹212 (+4.2%)`. Alerts come from Upstox quotes only; without a token the ticker shows an enable note instead of pretending. VWAP rule events are intentionally not on the ticker.

## Candles & 12-bar projection

Charts render real OHLC **candlesticks** plus a forward **projection**: the engine z-scores the last 4 closed bars' returns, finds the 15 most similar historical windows, and plots the median of what price did over the next 12 bars with an 80% percentile cone — annotated with how many of those setups continued up. This is transparent pattern statistics plus recent volatility, **not** a prediction of the future; treat it as context, and the on-chart line says so.

## Verification

- `engine.js`: 32 unit checks pass (session envelope invariants, band ordering, anchor reset semantics, no-volume fallback, week/month resets, tiny history, empty input, idea sanity).
- Headless Chrome (1440px and 390px): zero console/page errors; both panels render 4 rule cards each; hover crosshair tooltip, chart focus modal (open/Escape), Live/Demo switch, dark/light theme, Pine copy/download all verified; no horizontal overflow at 390px.
- Live feeds verified end-to-end from this machine (Binance direct; Nifty via relay). Relay availability varies by network — Demo mode is always available.

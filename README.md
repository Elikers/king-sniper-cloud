# King Sniper: Hyperliquid charts + Discord alerts (for trading on INVO)

- Live charts for BTCUSDC.P, ETHUSDC.P, SOLUSDC.P, HYPEUSDC.P, ZECUSDC.P (add any other Hyperliquid perp with "+ Add market")
- Timeframes: 1m 2m 3m 5m 10m 15m 30m 45m 1h 2h 3h 4h 1D 1W
- The King Sniper Smart Filter indicator: signals, TP/SL lines, filter dashboard, stats, best PHT hours
- Discord alerts: BUY, SELL, FLIP, TP1, TP2, TP3, SL, trailing stop

It does **not** connect to your INVO account and does **not** place orders.

## 1. Quick look (charts only, nothing to install)

Double-click `king-sniper-chart.html`. It needs internet. It sends no Discord alerts.

## 2. Start the website and the Discord alerts

1. Install **Node.js 22 or newer** from https://nodejs.org (nothing else to install).
2. Unzip this folder.
3. Test Discord: open a terminal in the folder and run `node server/index.js --test-alert`.
   A message marked "TEST" should appear in your channel.
4. Start: double-click `start.bat` (Windows), or run `./start.sh` (Mac / Linux).
5. Open http://localhost:8080

The first start downloads history and takes a few minutes (Hyperliquid limits download speed).
Discord then receives "King Sniper alerts are online" with any trades already open.

**Alerts are sent only while this program is running.** For 24/7 alerts keep the computer awake
or run it on an always-on server (VPS). With Docker:

    docker build -t king-sniper .
    docker run -d --restart always --env-file .env -e HOST=0.0.0.0 -p 8080:8080 -v ks-data:/app/data king-sniper

Free hosting plans that "sleep" when idle will miss signals.

### Open from your phone
Set `HOST=0.0.0.0` in `.env`, restart, and open `http://<computer-ip>:8080` on the same Wi-Fi.
The website has no password, so do not expose it publicly without protection.

## 3. Settings (`config.json`, restart after editing)

| Key | Meaning |
|---|---|
| `symbols` | Markets to send alerts for |
| `timeframes` | Charts to send alerts for. Default `15m`, `1h`, `4h`. Adding short ones means many more messages |
| `tpSlAlerts` | `"live"`: as soon as price touches. `"close"`: only when the bar closes |
| `startupMessage` | Post the "online" message on start |
| `maxAlertAgeSeconds` | Older BUY/SELL signals (after downtime) are skipped; older exits are marked DELAYED |
| `settings` | Indicator inputs, same names as the Pine script, e.g. `"mode": "Custom", "minPassIn": 9` |

`mode` is `"High win-rate"` (default, as in your script), `"Max win-rate"` or `"Custom"`.
The "Settings" button on the website changes only what that browser's chart shows.

## 4. How alerts behave

- BUY / SELL fire only after a bar closes, a few seconds later.
- One trade at a time per market and timeframe (same as the script).
- In `live` mode a TP can be announced and the bar can later also touch the stop. The indicator
  counts the stop first, and a follow-up message reports it.

## 5. Differences from TradingView

The website cannot run Pine code. `public/shared/engine.js` is a JavaScript conversion of
`indicator/king_sniper_smart_filter.pine`. **If you change the Pine script, this file must be changed too.**

It has not been compared with TradingView on live data. Before relying on it, add the script to a
`HYPERLIQUID:BTCUSDC.P` chart and compare several signals on 15m and 1h. Occasional differences can come from:
- the amount of history loaded (Hyperliquid's API serves at most 5000 candles per interval; 2m and 10m
  have about 2500, 45m and 3h about 1660), which affects drawdown pauses and statistics;
- higher timeframe on 2m and 45m charts, where bars cross a higher-timeframe boundary;
- exact "mintick" and candle values.

## 6. Keep the webhook private

It is stored in `.env`. Anyone who has it can post in your channel. Do not upload `.env` anywhere public.
If it leaks: Discord → Channel settings → Integrations → Webhooks → delete it, create a new one,
and put the new URL in `.env`.

## Tests

`node --test --test-force-exit test/engine.test.js test/alerts.test.js` (offline, uses a fake exchange and a fake webhook).

Signals and statistics are simulations without fees, slippage or funding. Not financial advice.
Independent tool, not affiliated with Invo or Hyperliquid.

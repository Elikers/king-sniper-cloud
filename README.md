# King Sniper: Hyperliquid charts + Discord alerts (for trading on INVO)

- Live charts for BTCUSDC.P, ETHUSDC.P, SOLUSDC.P, HYPEUSDC.P, ZECUSDC.P (add any other Hyperliquid perp with "+ Add market")
- Discord alerts that run **in the cloud, with no computer or terminal on** (section 2), for any Hyperliquid perp you list in `symbols.txt`
- Timeframes: 1m 2m 3m 5m 10m 15m 30m 45m 1h 2h 3h 4h 1D 1W
- The King Sniper Smart Filter indicator: signals, TP/SL lines, filter dashboard, stats, best PHT hours
- Discord alerts: BUY, SELL, FLIP, TP1, TP2, TP3, SL, trailing stop

It does **not** connect to your INVO account and does **not** place orders.

## 1. Quick look (charts only, nothing to install)

Double-click `king-sniper-chart.html`. It needs internet. It sends no Discord alerts.

## 2. Discord alerts without a computer (GitHub, free)

GitHub wakes the program up every 5 minutes on its own servers. Each run catches up on every bar that
closed, sends the alerts, saves where it stopped and shuts down. Your PC can be off.

**One-time setup (about 10 minutes)**

1. Make a free account at https://github.com and create a new **public** repository (public repositories get
   unlimited free run time; private ones only get 2,000 minutes a month, which is not enough for every 5 minutes).
2. Upload everything in this folder to it (Add file > Upload files). Do **not** upload your `.env` file.
   Make sure the hidden `.github` folder went up too. If it did not, use Add file > Create new file, type
   `.github/workflows/alerts.yml` as the name, and paste in the contents of that file. Do the same for `markets.yml`.
3. Put the webhook in as a secret: repository Settings > Secrets and variables > Actions > New repository secret.
   Name `DISCORD_WEBHOOK_URL`, value is your Discord webhook URL. It stays hidden, even in a public repository.
4. Open the Actions tab, click "I understand my workflows, go ahead and enable them" if it asks, pick
   **King Sniper alerts** > Run workflow, tick "Only send a test message", and run it. A "TEST" message should
   show up in Discord.
5. Run **King Sniper alerts** once more with the box unticked. The first run downloads history and posts
   "King Sniper alerts are online". After that it runs by itself every 5 minutes.

**Adding or removing a market (any `...USDC.P` on Hyperliquid)**

Actions > **Add or remove markets** > Run workflow > choose add, type the names (`DOGEUSDC.P, SUI, kPEPE`),
run. It checks each name against Hyperliquid, refuses ones that do not exist, and updates `symbols.txt`.
The next 5-minute run picks it up and posts a message that it is watching the new market. It also works
from the GitHub phone app. You can also edit `symbols.txt` by hand (one market per line).

**What to expect**

- GitHub's schedule is not exact. A run is usually 1 to 10 minutes late and now and then later. BUY / SELL
  alerts that arrive up to 15 minutes after the bar closed are still sent and marked DELAYED
  (`cloudMaxAlertAgeSeconds` in `config.json`); later ones are skipped.
- TP / stop alerts are found from the 1-minute candles each run, so they arrive within one run, not the second
  price touches. If you need them instantly, use the always-on server below.
- GitHub pauses scheduled runs in repositories with no activity for 60 days. Each run re-enables its own
  schedule, which should prevent that. If alerts ever stop, check the Actions tab for a "disabled" notice.
- Want it closer to every minute? Create a free job at https://cron-job.org that calls GitHub's workflow
  "dispatches" API for `alerts.yml` every 1 or 2 minutes (it needs a GitHub token with Actions write access).

## 3. Always-on alternative (your own computer or a server)

This is the original way, and it still works. It also gives you the website and instant TP / stop alerts.

1. Install **Node.js 22 or newer** from https://nodejs.org (nothing else to install).
2. Unzip this folder.
3. Test Discord: open a terminal in the folder and run `node server/index.js --test-alert`.
   A message marked "TEST" should appear in your channel.
4. Start: double-click `start.bat` (Windows), or run `./start.sh` (Mac / Linux).
5. Open http://localhost:8080

The first start downloads history and takes a few minutes (Hyperliquid limits download speed).
Discord then receives "King Sniper alerts are online" with any trades already open.

In this mode alerts are sent only while this program is running. For 24/7 alerts keep the computer awake
or run it on an always-on server (VPS). With Docker:

    docker build -t king-sniper .
    docker run -d --restart always --env-file .env -e HOST=0.0.0.0 -p 8080:8080 -v ks-data:/app/data king-sniper

Free hosting plans that "sleep" when idle will miss signals.

### Open from your phone
Set `HOST=0.0.0.0` in `.env`, restart, and open `http://<computer-ip>:8080` on the same Wi-Fi.
The website has no password, so do not expose it publicly without protection.

## 4. Settings (`config.json`)

| Key | Meaning |
|---|---|
| `symbols.txt` | Markets to send alerts for (separate file, one per line) |
| `timeframes` | Charts to send alerts for. Default `15m`, `1h`, `4h`. Adding short ones means many more messages |
| `tpSlAlerts` | `"live"`: as soon as price touches. `"close"`: only when the bar closes |
| `startupMessage` | Post the "online" message on start |
| `maxAlertAgeSeconds` | Always-on server: older BUY/SELL signals (after downtime) are skipped; older exits are marked DELAYED |
| `cloudMaxAlertAgeSeconds` | Same, for the GitHub mode. Default 900 (15 minutes) because GitHub's schedule can run late |
| `settings` | Indicator inputs, same names as the Pine script, e.g. `"mode": "Custom", "minPassIn": 9` |

`mode` is `"High win-rate"` (default, as in your script), `"Max win-rate"` or `"Custom"`.
The "Settings" button on the website changes only what that browser's chart shows.

## 5. How alerts behave

- BUY / SELL fire only after a bar closes, a few seconds later.
- One trade at a time per market and timeframe (same as the script).
- In `live` mode a TP can be announced and the bar can later also touch the stop. The indicator
  counts the stop first, and a follow-up message reports it.

## 6. Differences from TradingView

The website cannot run Pine code. `public/shared/engine.js` is a JavaScript conversion of
`indicator/king_sniper_smart_filter.pine`. **If you change the Pine script, this file must be changed too.**

It has not been compared with TradingView on live data. Before relying on it, add the script to a
`HYPERLIQUID:BTCUSDC.P` chart and compare several signals on 15m and 1h. Occasional differences can come from:
- the amount of history loaded (Hyperliquid's API serves at most 5000 candles per interval; 2m and 10m
  have about 2500, 45m and 3h about 1660), which affects drawdown pauses and statistics;
- higher timeframe on 2m and 45m charts, where bars cross a higher-timeframe boundary;
- exact "mintick" and candle values.

## 7. Keep the webhook private

On your computer it is in `.env`; on GitHub it is in the repository secret. Anyone who has it can post in your channel. Never upload `.env` anywhere public.
If it leaks: Discord → Channel settings → Integrations → Webhooks → delete it, create a new one,
and put the new URL in `.env` and in the GitHub secret.

## Tests

`npm test` (`node --test --test-force-exit test/engine.test.js test/alerts.test.js test/once.test.js`; offline, uses a fake exchange and a fake webhook).

Signals and statistics are simulations without fees, slippage or funding. Not financial advice.
Independent tool, not affiliated with Invo or Hyperliquid.

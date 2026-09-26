# Polymarket Perps Volume Bot

![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)
![Tests](https://img.shields.io/badge/tests-131%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Default](https://img.shields.io/badge/default-dry%20run-orange)

A maker-only trading bot for **Polymarket Perps** (BTC-USD and ETH-USD). It generates real trading volume at the **lowest possible cost per $1**, for example to build volume for points or a better fee tier without paying heavy taker fees.

It places post-only orders at the best bid and ask, so it only trades with other people. It exits positions cheaply and stops itself when a risk limit is hit. A local dashboard shows everything it does.

> **Safe by default:** the bot starts in **dry run**, using real market data and simulated fills. It sends nothing to the exchange until you switch on live mode in **two** places and type `yes`.

---

## Contents
1. [Features](#features)
2. [Quick start: dry run in 5 minutes](#quick-start-dry-run-in-5-minutes)
3. [Going live, step by step](#going-live-step-by-step)
4. [Everyday use](#everyday-use)
5. [Settings you'll actually change](#settings-youll-actually-change)
6. [Running 24/7 on a server](#running-247-on-a-server)
7. [Troubleshooting](#troubleshooting)
8. [How it trades](#how-it-trades)
9. [Full reference](#full-reference)
10. [Project structure](#project-structure)
11. [Disclaimer](#disclaimer) · [License](#license)

---

## Features
- **Maker-only quoting:** post-only orders at the best bid and ask. The bot never crosses the spread except to exit a position.
- **Two strategies:**
  - `join` (default) sits at the top of the book.
  - `fair` rests a ladder of orders around a fair price taken from Binance, Bybit and OKX.
- **Cheap exits:** positions are first closed passively at maker fee, with a capped taker exit as the last resort.
- **Risk controls:** daily loss stop, daily cost budget, position caps, a liquidation-distance guard, stale-data and disconnect guards, and the exchange's auto-cancel ("dead-man's switch").
- **Key safety:** the bot signs with a **proxy key that can't withdraw**, never with your main wallet key. The code contains no withdraw or transfer operations, and secrets are redacted from logs.
- **Crash-safe:** state is saved atomically. After a restart, the bot re-syncs orders and positions from the exchange.
- **Dashboard:** a read-only web page showing P&L, volume, cost breakdown, quotes, positions and warnings.
- **Detailed reports:** every fill and quote is logged to CSV, and each cost (maker fees, taker fees, funding, slippage) is reported separately.

---

## Quick start: dry run in 5 minutes

Dry run needs **no wallet, no keys and no money**. It's the best way to see how the bot behaves.

### 1. Install Node.js
Install **Node.js 20 or newer** from [nodejs.org](https://nodejs.org), then check it:
```bash
node --version
```
This should print `v20.x` or higher.

### 2. Download the bot
```bash
git clone https://github.com/Cryptonomad34/polymarket-perps-volume-bot.git
cd polymarket-perps-volume-bot
```
If you don't use git, click **Code → Download ZIP** on GitHub and unzip it instead.

### 3. Install dependencies
```bash
npm ci
```
The versions are pinned exactly. To also verify the packages' registry signatures, run `npm audit signatures`.

### 4. Create your config
```bash
cp config.example.json config.json
```
On Windows Command Prompt, use `copy config.example.json config.json` instead.

The defaults are sensible, so you don't need to change anything for a dry run.

### 5. Start the bot
```bash
node bot.mjs
```
You should see `volume-bot starting in DRY mode`. After that, log lines appear as the bot quotes and gets simulated fills. Stop it with **Ctrl+C**.

### 6. Open the dashboard (optional)
In a **second terminal**, in the same folder:
```bash
npm run dashboard
```
Then open **http://localhost:5174** in your browser.

Let the dry run go for a while, ideally a few hours. Watch `cost_per_$1` in the dashboard or in `logs/summary.csv`.

---

## Going live, step by step

> ⚠️ Live mode trades real money with leverage. Start with a small balance and read the [Disclaimer](#disclaimer).

### Step 1: Fund your Polymarket Perps account
Deposit a small amount of **pUSD** into your Polymarket Perps account. $50–$100 is enough to start with the default settings.

### Step 2: Create proxy credentials
The bot trades through a **proxy key**. This is a separate key that your main wallet authorises for a limited time (for example 30 days). The proxy can place and cancel orders but **cannot withdraw**, so your main wallet's private key never goes near the bot.

1. Create a proxy for your account.
   - It's registered with a `CreateProxy` message that your main wallet signs.
   - Use Polymarket's official client SDK (`@polymarket/client`) to do this.
   - Polymarket returns a proxy **secret**. Keep the proxy's private key, its address, the secret and the expiry time.
2. Copy the template and fill in your values:
   ```bash
   mkdir credentials
   cp .env.example credentials/perps.env
   ```
   Open `credentials/perps.env` and fill in all five values. Each one is explained inside the file.
3. Check that `config.json` points to that file:
   ```json
   "envFile": "credentials/perps.env"
   ```
   Or set the environment variable `PERPS_ENV_FILE` to the file's path instead.

🔒 `credentials/` and `*.env` are already in `.gitignore`. **Never commit or share this file.**

When the proxy is close to expiring, the bot refuses to start and tells you. It needs at least 24 hours left. Create a new proxy and update the file.

### Step 3: Run the tests
```bash
npm test
npm run test:signing
```
`npm test` runs 131 unit tests with no network access. `npm run test:signing` checks that the bot's signatures match the official SDK. Both must pass.

### Step 4: Live smoke test
Open `config.json` and set:
```json
"mode": "live"
```
Then run:
```bash
node bot.mjs --live --smoke
```
The bot shows your account, proxy, balance and settings, then asks you to type `yes`. It then:
1. places a $10 post-only order 3% away from the price, checks it's open, and cancels it;
2. places a second one and lets the exchange's auto-cancel remove it within about 15 seconds.

If both steps pass, signing, orders and the safety switch all work.

### Step 5: Go live, small
```bash
node bot.mjs --live
```
Check the startup summary and type `yes`. Before the first trade, the bot:
1. cancels any open orders on BTC-USD and ETH-USD;
2. sets leverage (default 10x isolated);
3. takes the exchange's current positions as the truth;
4. starts quoting.

> **Important:** the bot treats BTC-USD and ETH-USD on this account as **its own**. It will manage and close any position you already hold there. Don't trade these two markets by hand while it runs.

Live mode needs **both** `"mode": "live"` in `config.json` **and** the `--live` flag. If only one is set, the bot starts in dry run and logs why.

---

## Everyday use

| I want to… | Command |
|---|---|
| Dry run (safe test) | `node bot.mjs` |
| Trade live | `node bot.mjs --live` (with `"mode": "live"` in config) |
| Run the live smoke test | `node bot.mjs --live --smoke` |
| Use another config file | `node bot.mjs --config my-config.json` |
| Open the dashboard | `npm run dashboard`, then http://localhost:5174 |
| View a saved run | `node dashboard.mjs --logs runs/<folder>` |
| Clear today's stop (not the loss stop) | `node bot.mjs --live --clear-stop` |
| Run the tests | `npm test` and `npm run test:signing` |

### Stopping the bot
Any of these cancels the bot's open orders, saves its state and a summary, and exits cleanly:
- press **Ctrl+C**;
- send `SIGTERM` (for example from a process manager);
- create an empty file named `control/STOP`. This works well on a server; the bot deletes the file on exit.

Open **positions stay open** when you stop. The next start picks them up and manages them. To go back to testing, just run without `--live`.

### When a risk limit trips
The bot cancels its orders, closes positions, and **stops trading for the rest of the UTC day**. The log line starts with `STOPPED for the rest of the UTC day: <reason>`.
- The stop is saved, so restarting the same day doesn't bypass it.
- If the process keeps running, trading resumes by itself at 00:00 UTC.
- `--clear-stop` clears stops caused by stale data, disconnects or API errors. It **never** clears the daily loss stop.

---

## Settings you'll actually change

All settings live in `config.json`. The bot checks it at startup, and any mistake stops it with a clear message. These are the ones worth knowing first:

| Setting | Default | What it does | Tip |
|---|---|---|---|
| `quote.notionalUsd` | 25 | size of each order in USD (10–40) | bigger orders mean more volume and more risk |
| `inventory.maxNotionalUsd` | 80 | maximum position per market | keep it a few times `notionalUsd` |
| `budget.dailyCostUsd` | 10 | daily cost budget; after that, the bot only reduces positions | set it **below** `risk.dailyLossUsd` |
| `risk.dailyLossUsd` | 10 | hard stop for the day at this loss | your real "max I can lose today" |
| `leverage.value` | 10 | leverage set on each market | lower means safer |
| `strategy.mode` | `"join"` | `"join"` or `"fair"` | see below |

**Fair mode** (`"strategy": { "mode": "fair" }`) needs `"reference": { "mode": "gate" }` and the `fair` section, both already in `config.example.json`.
- Instead of chasing the best price, the bot rests orders at fixed distances from a fair price taken from Binance, Bybit and OKX. That keeps its place in the queue.
- Run `node tools/check-venues.mjs` first. Only list the venues that show updates from your machine in `reference.venues`.
- Always try it in dry run first.

Every setting is listed under [Full reference](#full-reference).

---

## Running 24/7 on a server

1. Do a small live run on your own computer first.
2. Copy the bot folder and your `credentials/perps.env` to a Linux server (VPS). Then lock down the credentials file:
   ```bash
   chmod 600 credentials/perps.env
   ```
3. Run the bot under a process manager so it restarts after a crash. For example, with [pm2](https://pm2.keymetrics.io/):
   ```bash
   npm install -g pm2
   pm2 start bot.mjs --name volume-bot -- --live
   pm2 logs volume-bot
   ```
   The first live start asks you to type `yes`, so do that start in a normal terminal, then switch to pm2.
4. **Never open the dashboard port to the internet.** Use an SSH tunnel from your PC instead:
   ```bash
   ssh -L 5174:127.0.0.1:5174 user@your-server
   ```
   Then open http://localhost:5174 on your PC.

---

## Troubleshooting

| Message or problem | What to do |
|---|---|
| `--live given but config.mode is "dry"` | Set `"mode": "live"` in `config.json`. |
| `config.mode is "live" but --live was not given` | Add `--live` to the command. |
| `No credentials file` | Set `envFile` in `config.json`, or `PERPS_ENV_FILE`, to your `.env` path. |
| `Credentials file is missing: …` | One of the five values in your `.env` is empty. |
| `PERPS_PROXY_PRIVATE_KEY does not belong to PERPS_PROXY_ADDRESS` | The key and address don't match. Recheck both. |
| `Proxy expires … need at least 24 h` | Create a new proxy and update the `.env`. |
| Config error at startup | The message names the exact key. Compare it with `config.example.json`. |
| `another volume-bot is already running` | Only one bot can trade an account at a time. Stop the other one first (a leftover lock from a crash is removed automatically). |
| Fair mode never quotes | Run `node tools/check-venues.mjs` and only list venues that show updates in `reference.venues`. |
| Dashboard shows "not running" | Start the bot. The dashboard only reads `logs/`. |

---

## How it trades

**Quoting** (`src/strategy.mjs`)
- One post-only order at the best bid and one at the best ask, per market. The bid never reaches the bot's own ask, even one still being cancelled.
- It re-quotes only when the best price has moved and stayed moved for `debounceMs`, and no faster than `minReplaceMs`. Small flickers don't waste the rate limit.
- It stops quoting the side that would push the position past `inventory.maxNotionalUsd`.
- Once the day's cost budget is spent, it only quotes the side that reduces the position.

**Fair mode** (`src/fairvalue.mjs` + `src/ladder.mjs`) replaces the above with a resting ladder.
- The ladder is priced from a fair value: the median of Binance, Bybit and OKX, adjusted for Polymarket's order-book imbalance.
- Safe orders are never re-priced, so they keep their queue position.
- An order is pulled only when fair value comes within `fair.cancelEdgeBps` of it, checked on every reference tick.
- The current position shifts fair value, instead of switching one side off.

**Exits** (`src/flatten.mjs`) are the main cost lever. An exit starts when the position is too big, older than `maxPositionAgeSec`, or within `liqDistancePct` of liquidation:
1. **Passive exit:** a reduce-only post-only order at the best exit price for `passiveSec`, re-pegged as the price moves. This exits at maker fee.
2. **One extension:** if the price has moved in the bot's favour and the position isn't losing, it keeps waiting for `extendSec`, once.
3. **Taker exit:** a reduce-only IOC order with its price capped at `iocSlippageBps` beyond the best price. It retries until flat.

Total hold time is capped at `maxHoldSec`. Being close to liquidation skips straight to step 3.

---

## Full reference

<details>
<summary><b>All config settings</b></summary>

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"dry"` | `"live"` only takes effect together with `--live` |
| `markets` | BTC-USD, ETH-USD | only these two are supported |
| `envFile` | `credentials/perps.env` | path to the proxy `.env` (relative to this folder); `PERPS_ENV_FILE` overrides it |
| `quote.notionalUsd` | 25 | size of each quote in USD (10–40) |
| `quote.debounceMs` | 300 | the new best price must hold this long before re-joining |
| `quote.minReplaceMs` | 250 | minimum time between replaces on one side |
| `quote.maxPlacesPerMinute` | 300 | the bot's own order-placement budget (cancels cost 0 on the exchange) |
| `strategy.mode` | `"join"` | `"join"`: join the best bid/ask. `"fair"`: resting ladder around fair value (needs `reference.mode: "gate"` and the `fair` section) |
| `fair.edgeBps` / `.levelStepBps` | 1 / 1 | level *i* rests at fair ± (edgeBps + *i* × levelStepBps) |
| `fair.levels` | 2 | resting orders per side |
| `fair.cancelEdgeBps` | 0.3 | pull an order once fair value is this close (must be < edgeBps) |
| `fair.maxDistanceBps` | 6 | pull an order this far from fair value |
| `fair.imbalanceWeight` | 0.5 | share of Polymarket's microprice-vs-mid gap added to fair value |
| `fair.skewBps` | 1.5 | fair value shift at a full `inventory.maxNotionalUsd` position |
| `fair.maxDeviationBps` | 15 | no fair value if it is further than this from Polymarket's mid |
| `reference.venues` | `["binance"]` | reference venues (`binance`, `bybit`, `okx`); the signal is the median of the fresh ones |
| `inventory.maxNotionalUsd` | 80 | per-market position cap |
| `flatten.maxPositionAgeSec` | 60 | position age that triggers an exit |
| `flatten.passiveSec` | 15 | length of the passive-exit window |
| `flatten.extendSec` | 10 | the single extension on a favourable move |
| `flatten.maxHoldSec` | 120 | hard cap on how long a position is held |
| `flatten.iocSlippageBps` | 5 | IOC limit distance beyond the best price |
| `flatten.iocRetryMs` | 1000 | spacing between IOC attempts |
| `flatten.liqDistancePct` | 4 | exit when liquidation is closer than this |
| `budget.dailyCostUsd` | 10 | daily all-in cost (fees + funding − trading P&L); after that, reduce-only quoting |
| `risk.dailyLossUsd` | 10 | stop when net P&L for the day is ≤ −this amount |
| `risk.maxConsecutiveErrors` | 3 | real (Fatal) API errors in a row before stopping |
| `risk.staleMs` | 5000 | market data older than this counts as stale (that market's quotes are cancelled) |
| `risk.staleGraceSec` | 30 | stop if data stays stale this long |
| `risk.reconnectGraceSec` | 30 | stop if the WebSocket isn't back within this time |
| `risk.maxDisconnectsPerDay` | 3 | disconnects allowed per UTC day; the next one stops trading |
| `leverage.value` / `.cross` | 10 / false | set on each market at live start |
| `autoCancel.enabled` | true | exchange dead-man's switch (live only) |
| `autoCancel.aheadSec` / `.rearmSec` | 15 / 5 | armed 15 s ahead, re-armed every 5 s |
| `autoCancel.pollSec` | 60 | how often the fire count is checked; the bot stops when few fires remain |
| `sim.latencyMs` | 80 | simulated order and cancel latency |
| `sim.startingEquityUsd` | 200 | informational |
| `report.summaryEveryMin` | 15 | how often the summary is written |
| `log.level` | `"info"` | debug, info, warn or error |

</details>

<details>
<summary><b>Logs and reports (<code>logs/</code>)</b></summary>

| File | Content |
|---|---|
| `bot-YYYY-MM-DD.log` | structured JSON-lines log; rotates at 10 MB and daily, keeps 14 files; secrets are redacted |
| `fills.csv` | every fill: mode, side, price, qty, maker/taker, fee, intent, decision mid, slippage ($ and bps), position after, realized P&L |
| `quotes.csv` | every place, cancel and reject, with mode and reason |
| `summary.csv` | written every `summaryEveryMin` and on exit (columns below) |
| `state-dry.json`, `state-live.json` | what the bot last believed; never contains secrets |
| `smoke-*.json` | smoke-test results |

The `runs/` folder has saved dry-run experiments that you can open with `node dashboard.mjs --logs runs/<folder>`.

</details>

<details>
<summary><b>Cost metrics (<code>summary.csv</code>)</b></summary>

| Column | Meaning |
|---|---|
| `maker_fees`, `taker_fees` | fees paid (negative is a rebate) |
| `funding` | funding paid (+) or received (−) while holding a position |
| `slippage` | fill price vs the mid when the bot decided to act, signed against the bot; maker fills usually come out negative because they earn about half the spread |
| `inventory_drift` | what the position did after the fill (`trading_pnl + slippage`); this is the adverse-selection cost |
| `trading_pnl` | realized + unrealized P&L, marked to the mid |
| `net_cost` | `fees + funding − trading_pnl`, the all-in cost (= −net P&L) |
| **`cost_per_$1`** | **`net_cost / gross_volume`, the headline number** (also `cost_per_$1M_volume`) |
| `budget_used` | today's all-in cost, compared with `budget.dailyCostUsd` |
| `margin_used`, `max_drawdown`, `min_liq_distance_pct` | risk context |
| `avg_flatten_slippage_bps` | average slippage of exit fills |
| `projected_days_to_$1M_tier`, `projected_cost_to_$1M_tier` | today's pace extrapolated to $1M volume (the $1M tier lowers fees from 1.25/4 to 1.00/3.7 bps) |

To judge a change, use per-fill markout (`node tools/markout.mjs`) rather than one day's cost, because short windows are dominated by which way the market moved.

</details>

<details>
<summary><b>Crash recovery</b></summary>

`logs/state-<mode>.json` is rewritten atomically after every material change. It holds today's cost and P&L components, the client-order-id counter, an open-order snapshot, positions (dry run), the disconnect count and the stop reason.

On restart:
- the order-id counter jumps forward by 1000, so a client order id is never reused;
- a corrupt state file is moved aside;
- a new UTC day resets the daily counters;
- **live:** open orders, positions and fills are re-read from the exchange, which is the source of truth;
- a second instance is blocked by `control/.lock`.

</details>

<details>
<summary><b>Error handling</b></summary>

| Class | Examples | Handling | Counts toward the 3-strikes stop? |
|---|---|---|---|
| RateLimited | 429, `action_rate_limited`, `ip_rate_limited` | back off (honours `Retry-After`), retry | no |
| Maintenance | cancel-only window, `order_in_flight` | pause new orders for 5 s | no |
| Indeterminate | 503, 500, timeouts | the exact same signed order is resent (same client order id, so no duplicate), then looked up | no |
| PostOnlyReject | a post-only order would cross | re-quote on the next tick | no |
| Fatal | anything else | logged | **yes** |

</details>

<details>
<summary><b>Known limits</b></summary>

- **Simulated fills are an estimate.** Queue position is modelled from public data. During your first small live run, run a dry-run copy side by side and compare the two `summary.csv` files.
- **Maker/taker in live mode:** WebSocket fills don't say which side you were, so the order type decides (IOC = taker). REST fills, which do say, are used to reconcile.
- **Fee rates:** the fee schedule currently lists only an "equity" category, so those rates are used for crypto (this is logged). In live mode, the real fee on each fill is recorded.
- **Auto-cancel fire limit:** the bot reads the real daily limit from the exchange and never assumes a value.

</details>

---

## Project structure
```
bot.mjs               entry point (dry run / live / smoke test)
dashboard.mjs         read-only web dashboard (127.0.0.1:5174)
config.example.json   starting config: copy to config.json
.env.example          credentials template: copy to credentials/perps.env
src/
  strategy.mjs        join-mode quoting
  fairvalue.mjs       fair value from Binance / Bybit / OKX
  ladder.mjs          fair-mode resting ladder
  flatten.mjs         cheap exit logic
  risk.mjs            loss stop, budgets and guards
  engine.mjs          main loop
  exec/live.mjs       real exchange execution
  exec/sim.mjs        simulated fills for dry run
  signing.mjs         order signing (matches the official SDK)
  env.mjs             loads and protects credentials
  state.mjs           crash-safe state
tools/                analysis helpers (markout, venue checks, recorders)
test/                 unit tests (npm test)
runs/                 saved dry-run experiments
```

---

## Disclaimer
This is experimental software, **not financial advice**. Trading perpetual futures with leverage can lose more than you expect, and bugs, exchange changes or market moves can cause losses. Run it in dry mode first, start small, never trade money you can't afford to lose, and use it at your own risk. This project is not affiliated with Polymarket.

## License
[MIT](LICENSE)

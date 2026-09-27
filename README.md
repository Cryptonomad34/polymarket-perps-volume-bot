# Polymarket Perps Volume Bot

![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)
![Tests](https://img.shields.io/badge/tests-132%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-live%20trading-red)

A production-ready, maker-only trading bot for **Polymarket Perps** (BTC-USD and ETH-USD). It generates real trading volume at the **lowest possible cost per $1**, for example It build volume without paying heavy taker fees.

It places post-only orders at the best bid and ask, so it only trades with other people. It exits positions cheaply and stops itself when a risk limit is hit. A local dashboard shows everything it does.

**Setup takes about 10 minutes.** A built-in setup page creates your trading key using your browser wallet, and the bot finds it automatically.

---

## Contents
1. [Features](#features)
2. [Setup: live in 10 minutes](#setup-live-in-10-minutes)
3. [Everyday use](#everyday-use)
4. [Settings you'll actually change](#settings-youll-actually-change)
5. [Running 24/7 on a server](#running-247-on-a-server)
6. [Managing your trading key](#managing-your-trading-key)
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
- **Key safety:** the bot trades with a **proxy key that can't withdraw**, created by the built-in setup page. Your main wallet's private key never touches the bot, the code contains no withdraw or transfer operations, and secrets are redacted from logs.
- **Crash-safe:** state is saved atomically. After a restart, the bot re-syncs orders and positions from the exchange.
- **Dashboard:** a read-only web page showing P&L, volume, cost breakdown, quotes, positions and warnings.
- **Detailed reports:** every fill and quote is logged to CSV, and each cost (maker fees, taker fees, funding, slippage) is reported separately.

---

## Setup: live in 10 minutes

> ⚠️ This bot trades real money with leverage. Start with a small balance and read the [Disclaimer](#disclaimer).

**You need:**
- **Node.js 20 or newer** from [nodejs.org](https://nodejs.org). Check it with `node --version`.
- A browser wallet (Rabby, MetaMask, ...) holding the wallet you use for Polymarket.
- A small **pUSD** balance in your Polymarket Perps account. $50–$100 is enough for the default settings.

### Step 1: Download and install
```bash
git clone https://github.com/Cryptonomad34/polymarket-perps-volume-bot.git
cd polymarket-perps-volume-bot
npm ci
```
If you don't use git, click **Code → Download ZIP** on GitHub, unzip it, open a terminal in that folder and run `npm ci`.

### Step 2: Create your config
```bash
cp config.example.json config.json
```
On Windows Command Prompt, use `copy config.example.json config.json` instead.

The defaults are sensible for a small account. The ones worth checking are listed under [Settings you'll actually change](#settings-youll-actually-change).

### Step 3: Create your trading key
```bash
npm run setup
```
Open **http://localhost:5173** in the browser where your wallet is installed. Then:
1. Click **Connect wallet** and choose the wallet you use on Polymarket.
2. Under **Create a proxy**, pick how many days it should last (1–30), then click **Create proxy**.
3. Your wallet asks you to sign a `CreateProxy` message. Check that its `addr` matches the proxy address shown on the page, then sign.
4. The page shows **"Proxy created"** and **"API check: confirmed active"**.

The key is saved in the `credentials/` folder, and the bot finds it automatically. Close the setup tool with **Ctrl+C**.

🔒 The key never goes into the browser. It **can trade but cannot withdraw**. `credentials/` is git-ignored: never share or upload it. The setup page never asks you to sign a withdrawal. If a wallet prompt says `Withdraw`, reject it.

### Step 4: Smoke test
```bash
node bot.mjs --smoke
```
The bot shows your account, balance and settings, and asks you to type `yes`. It then:
1. places a $10 post-only order 3% away from the price, checks it's open, and cancels it;
2. places a second one and lets the exchange's auto-cancel remove it within about 15 seconds.

If both pass, your key, signing, orders and the safety switch all work.

### Step 5: Start trading
```bash
node bot.mjs
```
Check the summary and type `yes`. Before the first trade, the bot:
1. cancels any open orders on BTC-USD and ETH-USD;
2. sets leverage (default 10x isolated);
3. takes the exchange's current positions as the truth;
4. starts quoting.

To watch it, run `npm run dashboard` in a **second terminal** and open **http://localhost:5174**.

> **Important:** the bot treats BTC-USD and ETH-USD on this account as **its own**. It will manage and close any position you already hold there. Don't trade these two markets by hand while it runs.

### Optional: practice run first
```bash
node bot.mjs --dry
```
This uses real market data with simulated fills. It needs no key and places nothing, so it's useful for trying new settings safely.

---

## Everyday use

| I want to… | Command |
|---|---|
| Start trading | `node bot.mjs` (asks for `yes`) |
| Start trading without the prompt (servers) | `node bot.mjs --yes` |
| Run the smoke test | `node bot.mjs --smoke` |
| Open the dashboard | `npm run dashboard`, then http://localhost:5174 |
| Create, renew or revoke the trading key | `npm run setup`, then http://localhost:5173 |
| Try settings without trading | `node bot.mjs --dry` |
| Use another config file | `node bot.mjs --config my-config.json` |
| Clear today's stop (not the loss stop) | `node bot.mjs --clear-stop` |
| Run the tests | `npm test` and `npm run test:signing` |

### Stopping the bot
Any of these cancels the bot's open orders, saves its state and a summary, and exits cleanly:
- press **Ctrl+C**;
- send `SIGTERM` (for example `pm2 stop volume-bot`);
- create an empty file named `control/STOP`. This works well on a server; the bot deletes the file on exit.

Open **positions stay open** when you stop. The next start picks them up and manages them.

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
- Try new settings with `node bot.mjs --dry` before trading them.

Every setting is listed under [Full reference](#full-reference).

---

## Running 24/7 on a server

1. Get the bot running on your own computer first (steps 1–5 above).
2. Copy the bot folder, **including `credentials/` and `config.json`**, to a Linux server (VPS). Then lock down the key:
   ```bash
   chmod 700 credentials && chmod 600 credentials/*.env
   ```
3. Run it under a process manager so it restarts after a crash. With [pm2](https://pm2.keymetrics.io/):
   ```bash
   npm install -g pm2
   pm2 start bot.mjs --name volume-bot -- --yes
   pm2 save
   pm2 logs volume-bot
   ```
   `--yes` skips the `yes` prompt, which a process manager can't answer. The bot still prints the full startup summary to the log.
4. **Never open the dashboard port to the internet.** Use an SSH tunnel from your PC instead:
   ```bash
   ssh -L 5174:127.0.0.1:5174 user@your-server
   ```
   Then open http://localhost:5174 on your PC.

---

## Managing your trading key

- **Renew:** keys last 1–30 days. The bot refuses to start with less than 24 hours left. Run `npm run setup`, create a new key, and restart the bot; it picks the newest valid key by itself. On a server, copy the new file from `credentials/` across.
- **Revoke:** in `npm run setup`, paste the proxy address under **Revoke a proxy** and sign. The key stops working immediately, and its file is renamed to `*.REVOKED.env`.
- **See active keys:** the **Saved and active proxies** section lists the keys on this computer and the ones Polymarket has active.
- **Use a specific key:** set `PERPS_ENV_FILE=/path/to/file.env`, or `"envFile"` in `config.json`. Otherwise the newest unexpired `credentials/proxy-0x….env` is used. `.env.example` documents the file format if you create one by hand.

---

## Troubleshooting

| Message or problem | What to do |
|---|---|
| `No credentials found` | Run `npm run setup` and create a key (Step 3). |
| `Proxy expires … need at least 24 h` | Create a new key with `npm run setup`. |
| `live mode needs an interactive terminal` | You're running under pm2 or similar. Add `--yes`. |
| Setup page says `No wallet found` | Open http://localhost:5173 in the browser that has your wallet extension. |
| `Signature is from 0x…, not 0x…` | Your wallet signed with a different account. Switch to the connected account and try again. |
| `Credentials file is missing: …` | A hand-made `.env` is missing a value. Compare it with `.env.example`. |
| `PERPS_PROXY_PRIVATE_KEY does not belong to PERPS_PROXY_ADDRESS` | A hand-made `.env` has a key and address that don't match. |
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
| `mode` | `"live"` | optional; `"dry"` makes every start a practice run. The `--dry` / `--live` flags override it |
| `markets` | BTC-USD, ETH-USD | only these two are supported |
| `envFile` | auto | optional path to the key file (relative to this folder); by default the newest unexpired `credentials/proxy-0x….env` is used; `PERPS_ENV_FILE` overrides both |
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
| `sim.latencyMs` | 80 | simulated order and cancel latency (`--dry` only) |
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
| `state-live.json`, `state-dry.json` | what the bot last believed; never contains secrets |
| `smoke-*.json` | smoke-test results |

The `runs/` folder has saved practice-run experiments that you can open with `node dashboard.mjs --logs runs/<folder>`.

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

- **Practice-run fills are an estimate.** In `--dry`, queue position is modelled from public data, so compare against a small live run before trusting simulated numbers.
- **Maker/taker in live mode:** WebSocket fills don't say which side you were, so the order type decides (IOC = taker). REST fills, which do say, are used to reconcile.
- **Fee rates:** the fee schedule currently lists only an "equity" category, so those rates are used for crypto (this is logged). In live mode, the real fee on each fill is recorded.
- **Auto-cancel fire limit:** the bot reads the real daily limit from the exchange and never assumes a value.

</details>

---

## Project structure
```
bot.mjs               entry point (live / smoke test / --dry practice run)
dashboard.mjs         read-only web dashboard (127.0.0.1:5174)
config.example.json   starting config: copy to config.json
setup/                key setup page (npm run setup, 127.0.0.1:5173)
.env.example          key file format, for creating one by hand
src/
  strategy.mjs        join-mode quoting
  fairvalue.mjs       fair value from Binance / Bybit / OKX
  ladder.mjs          fair-mode resting ladder
  flatten.mjs         cheap exit logic
  risk.mjs            loss stop, budgets and guards
  engine.mjs          main loop
  exec/live.mjs       real exchange execution
  exec/sim.mjs        simulated fills for --dry
  signing.mjs         order signing (matches the official SDK)
  env.mjs             loads and protects credentials
  state.mjs           crash-safe state
tools/                analysis helpers (markout, venue checks, recorders)
test/                 unit tests (npm test)
runs/                 saved practice-run experiments
```

---

## Disclaimer
This is experimental software, **not financial advice**. Trading perpetual futures with leverage can lose more than you expect, and bugs, exchange changes or market moves can cause losses. Start small, never trade money you can't afford to lose, and use it at your own risk. This project is not affiliated with Polymarket.

## License
[MIT](LICENSE)

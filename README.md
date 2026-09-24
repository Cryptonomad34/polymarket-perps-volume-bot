# volume-bot

This bot generates real trading volume on Polymarket Perps (BTC-USD, ETH-USD) at the lowest total cost it can. It joins the best bid and best ask with post-only orders, trades only with other people, and exits positions cheaply.

The number to judge it by is **cost per $1 of volume**.

- **Dry run is the default.** `node bot.mjs` uses real market data and simulated fills. It signs nothing and sends nothing.
- **Live needs two switches to agree:** the `--live` flag and `"mode": "live"` in `config.json`. You then type `yes` at a confirmation prompt.
- **It signs with a Polymarket proxy key only** (from `../proxy-tool`), never your wallet key. The proxy key can't withdraw, and this code contains no withdraw or transfer operations.

---

## Setup

Requires Node 20 or later.

```bash
cd volume-bot
npm ci                      # exact-pinned: viem 2.55.19, @msgpack/msgpack 3.1.3, ws 8.21.3
npm audit signatures        # verify registry signatures
cp config.example.json config.json
```

For live mode, point `envFile` in `config.json` (or the environment variable `PERPS_ENV_FILE`) at the `.env` file that `proxy-tool` created. Dry run doesn't need credentials.

## Run

| What | Command |
|---|---|
| Dry run | `node bot.mjs` |
| Live | set `"mode": "live"` in `config.json`, then `node bot.mjs --live` |
| Live smoke test | `node bot.mjs --live --smoke` |
| Another config | `node bot.mjs --config other.json` |
| Tests | `npm test` (unit tests, no network) and `npm run test:signing` (compares signatures with the official SDK) |

If the `--live` flag and `config.mode` disagree, the bot starts in **dry run** and logs why.

### Starting live
Before any real request, the bot prints:
- the account and proxy (with the proxy's expiry)
- equity and fee tier
- leverage, quote size and inventory caps
- the daily cost budget and loss stop
- auto-cancel settings and any existing positions

It then waits for you to type `yes`. After that it:
1. cancels open orders on BTC and ETH;
2. sets leverage (default 10x isolated, checked against the instrument's max and risk tier);
3. adopts the exchange's positions as the truth;
4. starts trading.

**Note:** the bot treats BTC-USD and ETH-USD on this account as its own. It will manage and flatten any position you already hold there. It pauses quoting on an instrument if it sees orders there that it didn't place.

### Stopping
Any of the following cancels the bot's open orders, saves state and a summary, and exits:
- Ctrl+C
- `SIGTERM`
- creating a file named `control/STOP` (the bot deletes it on exit)

Open positions stay open. The next start manages them, since exchange state is re-synced on startup. To go back to testing, run without `--live`; no config change is needed.

### When a risk limit trips
The bot cancels its orders, flattens positions with a capped IOC order, and **stops trading for the rest of the UTC day**. The log line starts with `STOPPED for the rest of the UTC day: <reason>`.

- The stop is saved, so restarting the same day doesn't bypass it.
- Trading resumes by itself at 00:00 UTC if the process is still running.
- `--clear-stop` clears a stop caused by stale data, disconnects or API errors. It never clears the daily loss stop.

## Dashboard
A read-only web dashboard for tracking the bot. It never places, cancels or signs anything. Run it in a second terminal while the bot runs:

```bash
npm run dashboard            # or: node dashboard.mjs   -> http://localhost:5174
```

- **What it shows:**
  - status (trading, stopped with reason, or not running)
  - equity and its change since the start of the UTC day (live mode)
  - today's net P&L, volume and cost per $1M
  - cost breakdown: maker fees, taker fees, funding, slippage, inventory drift and the budget bar
  - live quote ladder with own spread for each market, and open positions with liquidation price
  - a realized P&L chart and recent fills
  - quoting activity and back-off reasons
  - recent warnings and errors, and the bot's settings
- **Refresh:** every 10 s.
- **Where the data comes from:** it reads `logs/` (state, fills, quotes, summaries). In live mode it also calls read-only account endpoints (portfolio, open orders) with the proxy credentials. Secrets never reach the browser, and it listens on `127.0.0.1` only.
- **Options:**
  - `--mode dry|live` overrides the mode from `config.json`.
  - `--logs runs/<folder>` views a saved run.
  - `--port N` uses another port.
- **On a VPS:** don't open the port to the internet. Use an SSH tunnel instead: `ssh -L 5174:127.0.0.1:5174 user@vps`, then open http://localhost:5174 on your PC.

## How it trades

**Quoting** (`src/strategy.mjs`)
- One post-only order at the best bid and one at the best ask, per market. The bid never reaches our own ask, including an ask that's still being cancelled.
- It replaces a quote only when the best price has moved and stayed moved for `debounceMs`, and no faster than `minReplaceMs`. Sub-tick flicker doesn't use up rate limits.
- It stops quoting the side that would push the position beyond `inventory.maxNotionalUsd`.
- Once the day's cost budget is spent, it quotes only the side that reduces the position.

**Fair mode** (`strategy.mode: "fair"`, `src/fairvalue.mjs` + `src/ladder.mjs`) replaces the above with a resting ladder priced from a fair value (median of Binance, Bybit and OKX plus Polymarket's book imbalance). Safe orders are never re-priced, so they keep their queue position; an order is pulled only when fair value comes within `fair.cancelEdgeBps` of it, checked on every reference tick. Inventory shifts fair value instead of switching a side off. See `OPERATIONS.md`, "Fair mode".

**Flattening** (`src/flatten.mjs`) is the main cost lever. It starts when the position exceeds the cap, is older than `maxPositionAgeSec`, or is within `liqDistancePct` of liquidation:
1. **Passive exit:** a reduce-only post-only order at the best exit price for `passiveSec`, re-pegged when the best price moves. This exits at maker fee.
2. **One extension:** if the mid has moved in our favour by at least one tick and the position isn't losing, it keeps the passive exit for `extendSec`, once.
3. **Taker exit:** a reduce-only IOC with its limit capped at `iocSlippageBps` beyond the best price. It retries every `iocRetryMs` until flat.
- Total hold is capped at `maxHoldSec`. Being close to liquidation skips straight to step 3.
- Every flatten fill logs the decision mid, fill price and slippage.
- Before any flatten order, all of that instrument's quotes are cancelled and confirmed gone.

## Config reference (`config.json`)
The config is checked at startup. Unknown keys, missing keys, wrong types and out-of-range values stop the bot with a specific message.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"dry"` | `"live"` only takes effect together with `--live` |
| `markets` | BTC-USD, ETH-USD | only these two are supported |
| `envFile` | — | path to the proxy `.env` (relative to this folder); `PERPS_ENV_FILE` overrides it |
| `quote.notionalUsd` | 25 | size of each quote in USD (10–40) |
| `quote.debounceMs` | 300 | the new best price must hold this long before re-joining |
| `quote.minReplaceMs` | 250 | minimum time between replaces on one side |
| `quote.maxPlacesPerMinute` | 300 | the bot's own order-placement budget (cancels cost 0 on the exchange) |
| `strategy.mode` | `"join"` | `"join"`: join the best bid/ask. `"fair"`: resting ladder around fair value (needs `reference.mode: "gate"` and the `fair` section). Optional; older configs load as join |
| `fair.edgeBps` / `.levelStepBps` | 1 / 1 | level *i* rests at fair ± (edgeBps + *i* × levelStepBps) |
| `fair.levels` | 2 | resting orders per side |
| `fair.cancelEdgeBps` | 0.3 | pull an order once fair value is this close (must be < edgeBps) |
| `fair.maxDistanceBps` | 6 | pull an order this far from fair value |
| `fair.imbalanceWeight` | 0.5 | share of Polymarket's microprice-vs-mid gap added to fair value |
| `fair.skewBps` | 1.5 | fair value shift at a full `inventory.maxNotionalUsd` position |
| `fair.maxDeviationBps` | 15 | no fair value if it is further than this from Polymarket's mid |
| `reference.venues` | `["binance"]` | reference venues (`binance`, `bybit`, `okx`); the signal is the median of the fresh ones |
| `inventory.maxNotionalUsd` | 80 | per-market position cap |
| `flatten.maxPositionAgeSec` | 60 | position age that triggers flattening |
| `flatten.passiveSec` | 15 | length of the passive-exit window |
| `flatten.extendSec` | 10 | the single extension on a favourable move |
| `flatten.maxHoldSec` | 120 | hard cap on how long a position is held |
| `flatten.iocSlippageBps` | 5 | IOC limit distance beyond the best price |
| `flatten.iocRetryMs` | 1000 | spacing between IOC attempts |
| `flatten.liqDistancePct` | 4 | flatten when liquidation is closer than this |
| `budget.dailyCostUsd` | 10 | daily all-in cost (fees + funding − trading P&L); after that, reduce-only quoting. Keep it below `risk.dailyLossUsd` so the bot winds down before the hard stop |
| `risk.dailyLossUsd` | 10 | stop when net P&L for the day is ≤ −this amount |
| `risk.maxConsecutiveErrors` | 3 | real (Fatal) API errors in a row before stopping |
| `risk.staleMs` | 5000 | market data older than this counts as stale (that instrument's quotes are cancelled) |
| `risk.staleGraceSec` | 30 | stop if data stays stale this long |
| `risk.reconnectGraceSec` | 30 | stop if the WebSocket isn't back within this time |
| `risk.maxDisconnectsPerDay` | 3 | disconnects allowed per UTC day; the next one stops trading |
| `leverage.value` / `.cross` | 10 / false | set on each instrument at live start |
| `autoCancel.enabled` | true | exchange dead-man's switch (live only) |
| `autoCancel.aheadSec` / `.rearmSec` | 15 / 5 | armed 15 s ahead, re-armed every 5 s |
| `autoCancel.pollSec` | 60 | how often the fire count is checked; the bot stops when few fires remain |
| `sim.latencyMs` | 80 | simulated order and cancel latency |
| `sim.startingEquityUsd` | 200 | informational |
| `report.summaryEveryMin` | 15 | how often the summary is written |
| `log.level` | `"info"` | debug, info, warn or error |

## Logs and reports (`logs/`)
| File | Content |
|---|---|
| `bot-YYYY-MM-DD.log` | structured JSON-lines log; rotates at 10 MB and daily, keeps 14 files; secrets are redacted |
| `fills.csv` | every fill: `mode`, side, price, qty, maker/taker, fee, intent, decision mid, slippage ($ and bps), position after, realized P&L |
| `quotes.csv` | every place, cancel and reject, with `mode` and reason |
| `summary.csv` | every `summaryEveryMin` and on exit (columns below) |
| `state-dry.json`, `state-live.json` | what the bot last believed (see below). No secrets: saving refuses keys that look like one |
| `smoke-*.json` | smoke-test results |

## Cost metrics
Every component is reported **separately** in `summary.csv`:

| Column | Meaning |
|---|---|
| `maker_fees`, `taker_fees` | fees paid (negative would be a rebate) |
| `funding` | funding paid (+) or received (−) while holding inventory |
| `slippage` | for each fill, fill price vs the mid when the bot decided to act, signed against us. Maker fills at the touch usually come out negative, because they earn about half the spread |
| `inventory_drift` | what the position did after the fill: `trading_pnl + slippage`. This is the adverse-selection cost |
| `trading_pnl` | realized + unrealized P&L, marked to the mid |
| `net_cost` | `fees + funding − trading_pnl`, the all-in cost (= −net P&L) |
| **`cost_per_$1`** | **`net_cost / gross_volume`, the headline number** (and `cost_per_$1M_volume`) |
| `budget_used` | all-in cost today: `fees + funding − trading_pnl` (= `net_cost`), compared with `budget.dailyCostUsd` |
| `margin_used`, `max_drawdown`, `min_liq_distance_pct` | risk context |
| `avg_flatten_slippage_bps` | average slippage of flatten fills |
| `projected_days_to_$1M_tier`, `projected_cost_to_$1M_tier` | today's pace extrapolated to $1M of volume. The $1M tier only lowers fees from 1.25/4 to 1.00/3.7 bps |

The daily loss stop uses `trading_pnl − fees − funding`, so inventory drift is covered by the loss stop even though it isn't part of the cost budget.

## Crash recovery
`logs/state-<mode>.json` is rewritten atomically after every material change. It holds:
- today's cost and P&L components
- the client-order-id counter
- open-order snapshot, positions (dry run)
- disconnect count and stop reason

On restart:
- The order-id counter jumps forward by 1000, so a client order id is never reused.
- A corrupt state file is moved aside.
- A new UTC day resets the daily counters.
- **Live:** open orders, positions and fills are re-read from the exchange, which is the source of truth. State only supplies what the exchange can't, such as slippage vs the decision mid.
- A second instance is blocked by `control/.lock`.

## Error handling
| Class | Examples | Handling | Counts toward the 3-strikes stop? |
|---|---|---|---|
| RateLimited | 429, `action_rate_limited`, `ip_rate_limited` | back off (honours `Retry-After` and `Poly-RateLimit-*`), retry | no |
| Maintenance | cancel-only window, `order_in_flight` | pause new orders for 5 s | no |
| Indeterminate | 503 `service_unavailable`, 500, timeouts | the **exact same signed body** is resent (same client order id, so no duplicate order), then looked up by client order id | no |
| PostOnlyReject | a post-only order would cross | re-quote on the next tick | no |
| Fatal | anything else | logged | **yes** |

## Verification checklist (before going live)
1. `npm test` and `npm run test:signing` both pass.
2. Dry run for 24 h or more.
   - Check `summary.csv`: maker fees, taker fees, funding and slippage are separate numbers.
   - Set `risk.dailyLossUsd` to `0.5` and confirm the bot stops with `STOPPED ... daily loss stop`.
   - Kill the process with `taskkill /F` or `kill -9`, restart it, and confirm `state: restored` shows today's numbers carried over.
3. **Live smoke test** (needs pUSD in the Perps account): `node bot.mjs --live --smoke` with `mode: live`.
   - Confirm the prompt shows the right account and needs `yes`.
   - It places a $10 post-only order 3% from the mid, checks it's open, and cancels it.
   - It places a second one and arms auto-cancel **without re-arming**. The exchange should cancel it within 15 s, and `triggered` should rise by exactly one.
4. **Simulator calibration:** during the first small live run, run a dry-run copy of this folder side by side on the same machine. Compare fills per hour, maker/taker mix and slippage in the two `summary.csv` files before trusting dry-run numbers.
5. Small live run on your PC. Then copy `volume-bot/` and its `.env` to the VPS, run `chmod 600` on the `.env`, and run it under a process manager.

## Known limits
- **Simulator fills are an estimate.** The queue position is modelled from public data, and the bot's own orders aren't in the public book. Step 4 is how you check it.
- **Maker/taker in live mode:** WebSocket fills don't say whether we were maker or taker, so the order type decides (IOC = taker). REST fills, which do say, are used for reconciliation.
- **Fee rates:** the fee schedule currently lists only an "equity" category, so those rates are used for crypto (this is logged). In live mode, the actual fee on each fill is what's recorded.
- **Auto-cancel fire limit:** the docs say 1000 fires a day. The bot reads the real `daily_limit` from `GET /v1/account/auto-cancel` and never assumes a value.

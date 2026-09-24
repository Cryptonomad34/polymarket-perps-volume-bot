# runs/ — archived dry-run experiments (22 Sep 2026)

**Every fill in these folders is simulated.** They were produced by `node bot.mjs` without
`--live`, so `mode` is `dry` in every CSV row and the fills came from `src/exec/sim.mjs`, not
from the exchange.

That matters more than it sounds. A simulated fill happens whenever the book trades through
our price, which is a *model* of adverse selection, not a measurement of it. Markout computed
on this data says how the model behaves, not how toxic the real flow is. Do not quote numbers
from here as results about the live bot.

`tools/markout.mjs` and `tools/gate-value.mjs` both default to `--mode live` and will ignore
these rows unless you pass `--mode dry` explicitly. That default is deliberate.

| Folder | What was being tested |
|---|---|
| `run1-baseline-15min` | baseline behaviour |
| `run2-filters-off-25min` / `run2-filters-on-25min` | `quote.adverse.enabled` A/B |
| `run3-exits-current-10min` / `run3-exits-makerfirst-10min` | taker exit vs maker-first exit |

A caution about the A/Bs: each pair is 10–25 minutes long, and cost per $1M over such a window
is dominated by which way the market happened to move, not by the change. The same change was
later measured at +33% better over 39 minutes and −13% worse over 145 minutes of live trading.
Use per-fill markout, not cost per $1M, to judge anything (see `tools/markout.mjs`).

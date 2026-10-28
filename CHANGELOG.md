# Changelog

All notable changes to JP Quant. The project was built in numbered steps (see [STORY.md](STORY.md)). This public
repository starts at v1.0.0 with a fresh history.

**Last closed step:** 31 (the decision point of the first research stretch; the plan B steps 41B, 41C and 49 followed).

## [1.0.1] — 2026-10-28

### Changed

- README results table: the verdict comes first, with a note that net Sharpe alone is misleading.
- The demo shows the study's real experiment registry: the criteria funnel ends at 0 approved candidate strategies.
  The synthetic registry is only used by the tests.
- The demo's plan B card is filled from the plan B bot replay and links to its page.
- Public replay window: the warm-up is inside the data and the run ends one candle before the last one, so the first
  reconciliation falls inside the period and no position ends without its stop. The ETH/EUR data gap is deliberate,
  and the page says so.
- The dashboard is in English and Spanish: English by default on GitHub Pages, with a language switch. The CSP and the
  hashed page script are unchanged.
- Roadmap: the plan B bot already exists in paper (v1.0); v1.1 is its automatic run with real money, after its own
  safety checks.

### Known issues

- An exit order that fails to fill leaves the position without a protective stop until the next candle
  ([#1](https://github.com/juliuspani/jp-quant/issues/1)). Backtest and paper only; it will be fixed with the steps
  that complete Execution.

## [1.0.0] — 2026-10-28

First public release.

### Added

- **One-command demo:** `npm run demo` runs a deterministic replay on synthetic prices through Strategy → Risk →
  Execution. It then serves the read-only dashboard on `127.0.0.1` and opens it. `--static` writes the page published
  on GitHub Pages.
- **"Replay en marcha" card** in the dashboard: the equity curve against buy-and-hold BTC, with trades and the orders
  stopped by Risk appearing over time. It is animated by the page's single hashed script, and the page has no network
  access.
- **Plan B bot** (`npm run demo:dca`): weekly purchases and band rebalancing in paper, every order sized and signed by
  Risk. Each position keeps a protective stop, which is only cancelled after Risk approves its replacement.
- `scripts/record-demo.ts` records the README GIF and the social preview, always from the synthetic demo.
- GitHub Actions: `check:all` and the secret scan on every push and pull request; the demo deployed to GitHub Pages.
- README, STORY, CONTRIBUTING, licence (MIT), issue templates and an English guide to the documentation.

### Included from the research platform

- Deterministic event-driven backtester with the real Risk and Execution engines, decimal accounting and costs.
- Append-only experiment registry with a hash chain, analytics (Deflated Sharpe, PBO, block bootstrap, regimes) and
  the frozen-criteria evaluator.
- The research record: experiments EXP-0001 to EXP-0030 with their reports and outputs. The decision point concluded
  that no strategy qualifies.

### Not included

- Market data. Kraken's terms do not allow redistribution; the scripts to download and capture it are included.
- The private working log (`PROGRESS.md`, `docs/progress/`) and the private git history.

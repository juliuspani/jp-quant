# Changelog

All notable changes to JP Quant. The project was built in numbered steps (see [STORY.md](STORY.md)). This public
repository starts at v1.0.0 with a fresh history.

**Last closed step:** 31 (the decision point of the first research stretch; the plan B steps 41B, 41C and 49 followed).

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

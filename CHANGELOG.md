# Changelog

All notable changes to JP Quant. The project was built in numbered steps (see [STORY.md](STORY.md)). This public
repository starts at v1.0.0 with a fresh history.

**Last closed step:** 31 (the decision point of the first research stretch; the plan B steps 41B, 41C and 49 followed).

"Plan B" is the old name of the **Autopilot** (passive DCA & rebalancing); entries before 1.1.0 keep it.

## [Unreleased]

### Added

- **The seal as a file:** `docs/assets/seal.svg` and `docs/assets/seal-512.png` (512 × 512, transparent). It is the seal
  in the header of the demo, generated from the first commit, and `npm run sello -- --salida <file.svg> --transparente`
  exports it. The pinned fingerprints of the seal and the demo do not change.
- **A logo in the README:** the seal, centred above the title.
- **Open Graph and Twitter Card tags** on the published pages, with a 1200 × 627 preview image.
- **A link to [From Zero to Repo](https://github.com/juliuspani/from-zero-to-repo)** in the project story: the working
  method behind this project, as a beginner template.

## [1.1.0] — 2026-10-28

What you can do now: test your own strategy, honestly, with one command.

### Added

- **`npm run test-strategy`:** your strategy and your candles go through the same pipeline as the project's own
  research. That means:
  - automatic walk-forward with purging and embargo, and costs;
  - Deflated Sharpe with your own number of tests, PBO and 1,000 random-trade controls;
  - the 15 frozen criteria.

  You get a local HTML report with a plain verdict (*looks like a real edge*, *indistinguishable from luck* or *not
  enough data*) and why.
- **Your runs stay apart:** they go to a local registry (`sandbox-runs/`) that counts your own tests. They never touch
  the official registry, its N or the frozen criteria, and tests check this.
- **A strategy template** (`examples/my-strategy.ts`), a deliberate no-edge example (`examples/coin-flip.ts`) and
  synthetic example candles, so nothing needs to be downloaded.
- **CSV import** with line-numbered error messages.
- **`npm run fetch-candles`:** optional public Kraken candles, with no API key, for your own use.
- **"Luck or edge?" is back in the demo,** as a clearly labelled synthetic illustration next to the real control figures
  of EXP-0027 and EXP-0028.

### Changed

- **"Plan B" is now the Autopilot** (passive DCA & rebalancing): `npm run demo:autopilot` (`demo:dca` kept as an alias)
  and `/autopilot/` demo pages. It is still paper only.
- **Registry sphere:** family labels no longer overlap, and the English page shows readable family names.
- **README reorganised:** quick start in five steps, what you get, how it works, results, safety, the project story and
  the roadmap.
- **GIF** re-recorded at 25 fps.
- **Roadmap:** the Autopilot's real-money run moves to v1.2.

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

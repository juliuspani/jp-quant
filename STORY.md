# The story of JP Quant

*By Julián Paniagua Sánchez-Brunete*

## What I wanted

I wanted a small crypto trading system for myself: spot only, no leverage, strict risk limits and paper trading by
default. Above all, I did not want to fool myself with a pretty backtest. The project was first called "Inversor JP".
It started as a trading bot and ended as a research platform, because the research said there was nothing to trade.

## How it was built

Over four weeks (2026-09-30 to 2026-10-28, 265 commits in the private repository) I built it with AI coding agents.
I wrote and approved the rules; the agent wrote the code within them. It worked like this:

- **A constitution first.** Before the first line of the new code there was [CLAUDE.md](CLAUDE.md), loaded in every
  session. It holds the non-negotiable rules (Strategy → Risk → Execution, paper by default, no withdrawals, point-in-time
  data, costs in every backtest, a locked final test). It also lists the mandatory stops where the agent has to ask me:
  real money, the final test, accounts, payments and changes to the frozen criteria.
- **Rules enforced by machines, not by memory.** Custom ESLint rules forbid floating point in money modules and the
  wall clock in deterministic ones. `dependency-cruiser` enforces the module boundaries. Hooks block the agent from
  reading secrets, skipping git hooks or deleting things recursively. A pre-commit hook runs every check. 15 safety
  invariants are tied to tests or written manual procedures.
- **Domain knowledge as skills.** Four project skills hold the detailed procedures: quant research, trading risk,
  exchange execution and the engineering standard. The agent loads them before touching those areas.
- **Read-only reviewers.** Four consultant agents (quant, execution and risk, security, software) can read the code but
  cannot run commands or change files. I asked for them at specific steps, and their findings went into ADRs.
- **Small numbered steps.** Each step ended with every check green, a short summary and a stop until I approved it.
  Every non-trivial decision went into an ADR, 48 of them. Long steps were split, with a handoff note between sessions.

The order mattered. First the rules, the enforcement and the skills. Then the architecture, the invariants and the
configuration guard. Then the historical data pipeline, the deterministic replay engine, Risk and Execution, the
experiment registry, the feature engine, the backtester, the reference strategies, the analytics and, finally, the
frozen promotion criteria.

## What the research found

Two classic strategies from the literature were tested: Donchian trend following and RSI(2) mean reversion. The data
was Kraken EUR pairs, in ten walk-forward folds from 2017 to 2026. The criteria had been fixed in advance: a Deflated
Sharpe of at least 0.95, a drawdown of at most 10 %, at least 100 trades, and stress, regime, stability and random-control
tests.

- An internal quant audit (2026-10-20) found a real bug in the first round: candles arriving at the same instant were
  evaluated one by one, so the risk engine saw stale prices. It was fixed and the experiments were re-run, and the
  failed runs still count towards the number of tests.
- I changed the criteria once, after seeing the first round. That is exactly what the method warns against, so it is
  written down ([ADR 0030](docs/adr/0030-criterios-congelados.md), decision 9). Both strategies fail under either
  version.
- **Trend following** looked good on the surface: a net Sharpe of 1.47, beating buy-and-hold BTC on Sharpe and Calmar,
  and above the 99.9th percentile of its random control. It still failed five criteria. Its Deflated Sharpe was 0.48
  with 153 tests in its family, its drawdown was 20.5 % and it made only 79 trades. It also fell short in the 2020 crash
  and the 2022 bear market. Most of its profit came from 2017 and from ETH.
- **Mean reversion** failed seven criteria. Its Sharpe could not be told apart from zero, and its sign flipped when one
  parameter moved by half.
- **The backtest is reproducible.** Re-running the trend experiment (EXP-0030 against EXP-0027) gave byte-for-byte
  identical journals in all ten folds, with the same verdict. Only the family's test count changed (153 to 183), because
  re-running a test counts as another test, so its Deflated Sharpe dropped from 0.48 to 0.44.

On 2026-10-22 I stopped active trading development. The plan B was a passive approach, documented but not recommended:
buy-and-hold or regular purchases (DCA). This repository includes a paper-only DCA and rebalancing bot as an example of
the execution system. It is not a recommendation.

## What I learned

- **Negative results are results.** The pipeline did its job: it turned an attractive Sharpe of 1.47 into a clear "no".
- **Count everything.** The global number of tests is what deflates the Sharpe ratio. Pre-registering every run,
  including failed and repeated ones, is what makes that number honest.
- **Agents need guard rails more than instructions.** The rules that held were the ones a machine checks: lint rules,
  boundary rules, hooks, tests tied to invariants and a pre-commit that cannot be skipped.
- **Write decisions down.** The ADRs, and the one where I changed the criteria after seeing results, matter more than
  any single number.

This is not financial advice. Nothing here promises returns.

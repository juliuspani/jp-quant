# Guide to the documentation

The project's documentation is in Spanish, the working language of the person who built it. This page explains what
each document is for, in English.

## Start here

| Document | What it covers |
|---|---|
| [../README.md](../README.md) | Overview, demo, safety principles, methodology and results |
| [../STORY.md](../STORY.md) | How the project was built with AI agents, and what the research found |
| [../CLAUDE.md](../CLAUDE.md) | The constitution every agent session loaded: non-negotiable rules and mandatory stops |
| [../ARCHITECTURE.md](../ARCHITECTURE.md) | Modules, event flow, boundaries between modules and the designed capital guard |
| [../SECURITY_AND_TRADING_INVARIANTS.md](../SECURITY_AND_TRADING_INVARIANTS.md) | 15 safety invariants, each tied to a test or a manual procedure |
| [../STRATEGY_RESEARCH.md](../STRATEGY_RESEARCH.md) | The strategy families studied and why |
| [../DATA.md](../DATA.md) | Data sources, licences, survivorship bias and download rules |

## Research

| Document | What it covers |
|---|---|
| [PROMOTION_CRITERIA.md](PROMOTION_CRITERIA.md) | The frozen criteria a strategy has to pass, with their SHA-256 checked by tests |
| [PRE_LIVE_GATE.md](PRE_LIVE_GATE.md) | The gate that would come before any real money (never reached) |
| [DECISION_POINT.md](DECISION_POINT.md) | Step 31: the result per strategy, every failing criterion and the plan B |
| [research/experiments/](research/experiments/) | The experiment registry (`registry.jsonl`), one report per experiment and their outputs |
| [research/](research/) | Earlier research notes: strategies, data sources, infrastructure and exchanges |
| [audits/](audits/) | The internal quant audit of the first round |

## Decisions and process

| Document | What it covers |
|---|---|
| [adr/](adr/) | 48 architecture decision records (context, decision, alternatives and consequences) |
| [enforcement.md](enforcement.md) | How the rules are enforced: lint rules, boundary rules, hooks and pre-commit |
| [CONSULTANTS.md](CONSULTANTS.md) | The four read-only review agents and when they are used |
| [DEPENDENCIES.md](DEPENDENCIES.md) | Every dependency with its reason, licence and checks |
| [CCXT.md](CCXT.md) | What the exchange library is used for and what the project does itself |
| [REFERENCE_SYSTEMS.md](REFERENCE_SYSTEMS.md) | Open-source trading systems consulted as references |
| [../.claude/skills/](../.claude/skills/) | The detailed procedures for research, risk, execution and engineering |

## Words you will see

| Spanish | English |
|---|---|
| paso | step (the project was built in numbered steps) |
| tramo | stretch of the plan, or walk-forward fold in research |
| la persona | the human owner, who approves every step |
| test final | the locked final (out-of-sample) test |
| criterios congelados | frozen promotion criteria |
| `RECHAZADA` | rejected |
| diario | journal (the replay's event log) |
| ficha | run card (the metadata a dashboard page is built from) |

## Private records

The documents mention `PROGRESS.md` and `docs/progress/` (history, decisions and the plan's renumbering map). They are
the private working log of the project and are not published. Where a document cites them, the text around the
citation carries the relevant decision.

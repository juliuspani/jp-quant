# Contributing

Thanks for your interest. JP Quant is a personal research project. Changes are held to the project's own rules
([CLAUDE.md](CLAUDE.md) §2 and the [engineering standard](.claude/skills/trading-project-engineer/SKILL.md)).

- **Open an issue first** for anything beyond a small fix, using the bug or proposal template.
- **One change per pull request**, with its tests. `npm run check:all` and `npm run secrets` must pass; CI runs both.
- **No new dependency** unless it meets all of these: a permissive licence, active maintenance, an exact version at
  least 7 days old, no install scripts, and an entry in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) with its reason.
- **The safety rules are not negotiable.**
  - Every order goes Strategy → Risk → Execution.
  - Spot only, with no leverage and no withdrawals.
  - Paper by default, and fail closed.

  Pull requests that weaken any of these will be closed, and so will those that relax a lint, boundary or test rule to
  get through.
- **Research changes** follow [quant-research](.claude/skills/quant-research/SKILL.md):
  - pre-register the experiment in the registry before running it;
  - use realistic costs;
  - keep the final test locked.

  Never add market data in a pull request: its licence does not allow redistribution.
- **Never commit secrets** or environment files. If you find a security problem, open an issue without the details and
  ask for a private channel.
- **If you use Claude Code here:** `.claude/settings.json` runs `scripts/claude-guard.ts` as a hook before every tool call,
  so it executes code from this repository on your machine. Review it, and any pull request that changes it, before you
  trust the folder. The settings ask before any `git push` and only allow `npm ci --ignore-scripts`.

Code comments and documentation are in Spanish; English is fine in issues and pull requests.

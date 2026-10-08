# OKF Sync Map

## Canonical authority

Keep this hierarchy intact:

1. `docs/` — the bundle itself is the source of truth for product decisions
2. `src/` — source of truth for what has actually been built
3. `AGENTS.md`, `README.md` — repo conventions and entry points

`docs/backlog/` sits below all of them. It is working context, never authority.

## Current topology

### Root

- `docs/index.md` — root navigation; holds `okf_version: 0.2`
- `docs/log.md` — dated change log

### plan/

- `docs/plan/index.md`
- `docs/plan/ai-usage-dashboard-implementation-plan.md` — scope, provider contracts, milestones
- `docs/plan/ai-usage-dashboard-implementation-prompt.md` — historical agent brief (read-only record)

### discovery/

- `docs/discovery/index.md`
- `docs/discovery/m0-discovery.md` — re-probed baseline, gate evidence, fixed decisions

### operations/

- `docs/operations/index.md`
- `docs/operations/setup.md` — install, credentials, timer, troubleshooting
- `docs/operations/production-checkout.md` — maintainer deploy and rollback runbook for the production checkout

### backlog/

- `docs/backlog/index.md` — status rules, authority boundary, writing rules
- `docs/backlog/template.md` — brief skeleton carrying the minimal backlog frontmatter
- Briefs carry minimal OKF v0.2 frontmatter (`type: Backlog Brief`, `title`); they stay working context
- `docs/backlog/ready-for-agent/`
- `docs/backlog/needs-triage/`
- `docs/backlog/ready-for-human/`
- `docs/backlog/archive/`

### agents/

- `docs/agents/index.md`
- `docs/agents/issue-tracker.md` — where issues live and how briefs link to them
- `docs/agents/triage-labels.md` — triage roles and their backlog folders
- `docs/agents/domain.md` — single-context layout; decisions stay in `docs/log.md`

### assets/

- `docs/assets/` — images referenced by the bundle and the README, such as the demo-data
  screenshot; not concept pages

## Change to document map

| Change                                               | Documents to touch                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider gate passes live or regresses               | `discovery/m0-discovery.md` first, plus `log.md`; plan annotation only if scope is affected                                                          |
| Scope or contract decision                           | `plan/ai-usage-dashboard-implementation-plan.md` first, then `discovery/m0-discovery.md` if a fixed decision or deviation is affected, plus `log.md` |
| Setup, credentials, timer, or troubleshooting change | `operations/setup.md`, plus `log.md` when existing installs are affected                                                                             |
| New durable knowledge with no home                   | new concept page with frontmatter, linked from `docs/index.md`, plus `log.md`                                                                        |
| Bundle format or OKF version change                  | `docs/index.md` (`okf_version`), the validator in `.agents/skills/okf-sync/scripts/`, `SKILL.md`, this map, plus `log.md`                            |
| Review output or idea that is not yet a decision     | a brief under `backlog/needs-triage/` — not a canonical document                                                                                     |
| Brief becomes an accepted contract                   | fold into the canonical document that owns it, `git mv` the file to `backlog/archive/`, plus `log.md`                                                |
| Agent skill configuration change                     | `agents/` pages, plus the `## Agent skills` block in `AGENTS.md` and `log.md`                                                                        |
| Repo structure, tooling, or commands change          | `AGENTS.md` and `README.md`; the bundle only if it changes how agents traverse `docs/`                                                               |

## Update checklist

### When bundle content changes

- Read the target document before editing.
- Keep frontmatter intact, and adopt a v0.2 family (`sources`, `generated`, `verified`, `status`, `stale_after`) only when it is true.
- Append an entry to `docs/log.md` under the right date heading with the right label.
- Check whether the `docs/index.md` summary line is still accurate.

### When a document is added or removed

- Add or remove the line in `docs/index.md`.
- Add a `Creation` entry to `docs/log.md`.
- Check whether `AGENTS.md` entry guidance should reference it.

### When backlog placement changes

- Verify the Open Questions rule before anything lands in `ready-for-agent/`.
- Use `git mv` between status folders.
- Log promotions to `ready-for-agent/` and moves to `archive/`; intermediate triage churn does
  not need a log entry.

## Known drift risks

- The plan's machine baseline table is a dated observation (2026-09-12); `m0-discovery.md`
  is the current truth for versions and gate status.
- `ai-usage-dashboard-implementation-prompt.md` describes the build as future work. The
  build is done — the prompt is a historical record, not an instruction to re-run.
- DeepSeek and OpenRouter cards render `unavailable` until keys are saved in the dashboard's
  Settings dialog; that is intended behavior, not a fault. Keys live in the database (plan §3.5),
  never in `collector.env`. See `docs/operations/setup.md` §4.

# OKF Sync Map

## Canonical authority

Keep this hierarchy intact:

1. `docs/` — the bundle itself is the source of truth for product decisions
2. `src/` — source of truth for what has actually been built
3. `AGENTS.md`, `README.md` — repo conventions and entry points

`docs/backlog/` sits below all of them. It is working context, never authority.

## Current topology

### Root

- `docs/index.md` — root navigation; holds `okf_version`
- `docs/log.md` — dated change log

### plan/

- `docs/plan/index.md`
- `docs/plan/AI_Usage_Dashboard_Implementation_Plan.md` — scope, provider contracts, milestones
- `docs/plan/AI_Usage_Dashboard_Implementation_Prompt.md` — historical agent brief (read-only record)

### discovery/

- `docs/discovery/index.md`
- `docs/discovery/M0_DISCOVERY.md` — re-probed baseline, gate evidence, fixed decisions

### operations/

- `docs/operations/index.md`
- `docs/operations/SETUP.md` — install, credentials, timer, troubleshooting

### backlog/

- `docs/backlog/index.md` — status rules, authority boundary, writing rules
- `docs/backlog/template.md` — brief skeleton
- `docs/backlog/ready-for-agent/`
- `docs/backlog/needs-triage/`
- `docs/backlog/ready-for-human/`
- `docs/backlog/archive/`

## Change to document map

| Change                                               | Documents to touch                                                                                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider gate passes live or regresses               | `discovery/M0_DISCOVERY.md` first, plus `log.md`; plan annotation only if scope is affected                                                          |
| Scope or contract decision                           | `plan/AI_Usage_Dashboard_Implementation_Plan.md` first, then `discovery/M0_DISCOVERY.md` if a fixed decision or deviation is affected, plus `log.md` |
| Setup, credentials, timer, or troubleshooting change | `operations/SETUP.md`, plus `log.md` when existing installs are affected                                                                             |
| New durable knowledge with no home                   | new concept page with frontmatter, linked from `docs/index.md`, plus `log.md`                                                                        |
| Review output or idea that is not yet a decision     | a brief under `backlog/needs-triage/` — not a canonical document                                                                                     |
| Brief becomes an accepted contract                   | fold into the canonical document that owns it, `git mv` the file to `backlog/archive/`, plus `log.md`                                                |
| Repo structure, tooling, or commands change          | `AGENTS.md` and `README.md`; the bundle only if it changes how agents traverse `docs/`                                                               |

## Update checklist

### When bundle content changes

- Read the target document before editing.
- Keep frontmatter intact.
- Append an entry to `docs/log.md` under the right date heading with the right label.
- Check whether the `docs/index.md` summary line is still accurate.

### When a document is added or removed

- Add or remove the line in `docs/index.md`.
- Add a `Creation` entry to `docs/log.md`.
- Check whether `AGENTS.md` task branches should list it.

### When backlog placement changes

- Verify the Open Questions rule before anything lands in `ready-for-agent/`.
- Use `git mv` between status folders.
- Log promotions to `ready-for-agent/` and moves to `archive/`; intermediate triage churn does
  not need a log entry.

## Known drift risks

- The plan's machine baseline table is a dated observation (2026-09-12); `M0_DISCOVERY.md`
  is the current truth for versions and gate status.
- `AI_Usage_Dashboard_Implementation_Prompt.md` describes the build as future work. The
  build is done — the prompt is a historical record, not an instruction to re-run.
- DeepSeek and OpenRouter cards render `unavailable` until keys are provisioned; that is
  intended behavior, not a fault. See the
  `docs/backlog/archive/provision-provider-credentials.md` brief.

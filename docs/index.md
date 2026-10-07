---
okf_version: '0.1'
---

# AI Usage Dashboard — Knowledge Bundle

A localhost-first dashboard answering three questions on one screen: how much
subscription quota is left, how much prepaid credit is left, and whether any
provider is worth switching away from right now. This bundle follows
[Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

# Plan

- [Plan](plan/index.md) - Product authority: implementation plan (scope, provider
  contracts, milestones M0–M6) and the original implementation prompt, kept as a
  historical record.

# Discovery

- [Discovery](discovery/index.md) - Re-probed machine baseline, per-provider gate
  evidence (all five provider gates live-verified), fixed decisions, and deviations from the plan.

# Operations

- [Operations](operations/index.md) - Install, per-provider setup, scheduler (user
  systemd on Linux, launchd on macOS), config reference, troubleshooting, and the
  maintainer production-checkout runbook.

# Agents

- [Agents](agents/index.md) - Configuration the engineering agent skills read: issue
  tracker, triage labels, and domain docs layout.

# Backlog

- [Backlog](backlog/index.md) - Triaged work briefs. Working context, not source of
  truth — it never overrides the canonical documents above.
- [Brief Template](backlog/template.md) - Skeleton for new backlog briefs.

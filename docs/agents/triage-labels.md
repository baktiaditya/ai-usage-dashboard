---
type: Agent Configuration
title: Triage labels
description: The label strings this repo uses for the five canonical triage roles.
---

# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

Three roles share their name with a `docs/backlog/` status folder: `needs-triage`, `ready-for-agent`, `ready-for-human`.
A brief for an issue labelled `needs-info` stays in `needs-triage/`; one labelled `wontfix` moves to `archive/`.
Only `wontfix` exists on GitHub today; `/triage` creates the other four on first use.

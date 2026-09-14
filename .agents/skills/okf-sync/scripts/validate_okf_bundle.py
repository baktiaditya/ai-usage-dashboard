#!/usr/bin/env python3
"""Validate the AI Usage Dashboard OKF bundle.

The bundle root is `docs/` itself — there is no nested `docs/okf/`. Links between
bundle documents are relative to the file that contains them.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[4]
BUNDLE_DIR = ROOT / "docs"
ROOT_INDEX = BUNDLE_DIR / "index.md"
LOG_FILE = BUNDLE_DIR / "log.md"

BACKLOG_DIR = BUNDLE_DIR / "backlog"
BACKLOG_STATUS_DIRS = ("ready-for-agent", "needs-triage", "ready-for-human", "archive")

RELATIVE_LINK_RE = re.compile(r"\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)")
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)
KEBAB_CASE_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*\.md$")
REQUIRED_FRONTMATTER_KEYS = ("type", "title", "description")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_frontmatter(path: Path) -> dict | None:
    match = FRONTMATTER_RE.match(read_text(path))
    if not match:
        return None
    data = yaml.safe_load(match.group(1))
    return data if isinstance(data, dict) else None


def bundle_markdown_files() -> list[Path]:
    return sorted(BUNDLE_DIR.rglob("*.md"))


def is_backlog(path: Path) -> bool:
    return BACKLOG_DIR in path.parents


def is_concept(path: Path) -> bool:
    """Concept pages carry frontmatter. Index pages, the log, and backlog working
    documents do not."""
    if path.name == "index.md" or path == LOG_FILE:
        return False
    return not is_backlog(path)


def errors_for_file(path: Path) -> list[str]:
    errors: list[str] = []
    rel = path.relative_to(ROOT)

    for link_target in RELATIVE_LINK_RE.findall(read_text(path)):
        if link_target.startswith("/"):
            errors.append(f"{rel}: root-relative link {link_target}; use a relative path")
            continue
        if not (path.parent / link_target).exists():
            errors.append(f"{rel}: broken link {link_target}")

    if not is_concept(path):
        return errors

    frontmatter = parse_frontmatter(path)
    if frontmatter is None:
        errors.append(f"{rel}: missing YAML frontmatter")
        return errors

    for key in REQUIRED_FRONTMATTER_KEYS:
        if key not in frontmatter:
            errors.append(f"{rel}: frontmatter missing `{key}`")

    return errors


def backlog_errors() -> list[str]:
    """Enforce the rules stated in docs/backlog/index.md."""
    errors: list[str] = []
    if not BACKLOG_DIR.exists():
        return errors

    index = BACKLOG_DIR / "index.md"
    template = BACKLOG_DIR / "template.md"
    for required in (index, template):
        if not required.exists():
            errors.append(f"{required.relative_to(ROOT)}: missing required file")

    for status in BACKLOG_STATUS_DIRS:
        if not (BACKLOG_DIR / status).is_dir():
            errors.append(f"docs/backlog/{status}: missing status directory")

    for path in sorted(BACKLOG_DIR.rglob("*.md")):
        rel = path.relative_to(ROOT)
        parts = path.relative_to(BACKLOG_DIR).parts

        if len(parts) == 1:
            if path.name not in ("index.md", "template.md"):
                errors.append(f"{rel}: brief must live in a status directory")
            continue

        if parts[0] not in BACKLOG_STATUS_DIRS:
            errors.append(f"{rel}: unknown backlog status directory `{parts[0]}`")
        if not KEBAB_CASE_RE.match(path.name):
            errors.append(f"{rel}: brief file name must be lowercase-kebab-case.md")
        if FRONTMATTER_RE.match(read_text(path)):
            errors.append(f"{rel}: briefs are working documents and carry no frontmatter")

        # A brief is only ready for an agent once nothing is left open.
        if parts[0] == "ready-for-agent":
            section = re.search(
                r"^##\s+Open Questions\s*$(.*?)(?=^##\s|\Z)",
                read_text(path),
                re.MULTILINE | re.DOTALL,
            )
            if section and section.group(1).strip():
                errors.append(
                    f"{rel}: ready-for-agent brief still has Open Questions; "
                    "move it to needs-triage/ or ready-for-human/"
                )

    return errors


def topology_errors() -> list[str]:
    """Every top-level bundle folder must appear in the topology the sync skill reads.

    The skill trees and the sync map are hand-written; a folder added to `docs/`
    without them leaves the skill working from a stale picture of the bundle.
    """
    errors: list[str] = []
    folders = sorted(p.name for p in BUNDLE_DIR.iterdir() if p.is_dir())
    surfaces = (
        (ROOT / ".agents/skills/okf-sync/SKILL.md", r"^\s+{}/\s"),
        (ROOT / ".claude/skills/okf-sync/SKILL.md", r"^\s+{}/\s"),
        (ROOT / ".agents/skills/okf-sync/references/repo-sync-map.md", r"^###\s+{}/\s*$"),
    )
    for surface, pattern in surfaces:
        if not surface.exists():
            errors.append(f"{surface.relative_to(ROOT)}: missing required file")
            continue
        text = read_text(surface)
        for folder in folders:
            if not re.search(pattern.format(re.escape(folder)), text, re.MULTILINE):
                errors.append(
                    f"{surface.relative_to(ROOT)}: bundle folder `docs/{folder}/` is not listed"
                )
    return errors


def validate() -> list[str]:
    if not BUNDLE_DIR.exists():
        return [f"{BUNDLE_DIR.relative_to(ROOT)}: directory not found"]

    errors: list[str] = []

    for required in (ROOT_INDEX, LOG_FILE):
        if not required.exists():
            errors.append(f"{required.relative_to(ROOT)}: missing required file")

    if ROOT_INDEX.exists():
        frontmatter = parse_frontmatter(ROOT_INDEX)
        if frontmatter is None:
            errors.append(f"{ROOT_INDEX.relative_to(ROOT)}: missing YAML frontmatter")
        elif "okf_version" not in frontmatter:
            errors.append(f"{ROOT_INDEX.relative_to(ROOT)}: missing okf_version")

    for path in bundle_markdown_files():
        errors.extend(errors_for_file(path))

    errors.extend(backlog_errors())
    errors.extend(topology_errors())

    return errors


def main() -> int:
    errors = validate()
    if errors:
        print("OKF bundle validation failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print("OKF bundle is valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Validate the AI Usage Dashboard OKF v0.2 bundle.

The bundle root is `docs/` itself — there is no nested `docs/okf/`. The format is
Open Knowledge Format v0.2:

    https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md

Conformance (§11) requires parseable frontmatter with a non-empty `type` on every
non-reserved markdown file, plus §8/§9 structure for `index.md` and `log.md`. The
frontmatter families from §5 (`sources`, `generated`, `verified`, `status`,
`stale_after`) and the `Attested Computation` contract from §10 are validated when
present. This repo keeps two local conventions stricter than the spec: links are
relative to the containing file (never bundle-root-absolute), and canonical concept
pages must also carry `title` and `description`.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[4]
BUNDLE_DIR = ROOT / "docs"
ROOT_INDEX = BUNDLE_DIR / "index.md"
LOG_FILE = BUNDLE_DIR / "log.md"

BACKLOG_DIR = BUNDLE_DIR / "backlog"
BACKLOG_STATUS_DIRS = ("ready-for-agent", "needs-triage", "ready-for-human", "archive")
BACKLOG_BRIEF_TYPE = "Backlog Brief"

OKF_VERSION = "0.2"
STATUS_VALUES = ("draft", "stable", "deprecated")

RELATIVE_LINK_RE = re.compile(r"\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)")
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n?", re.DOTALL)
KEBAB_CASE_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*\.md$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)
ACTOR_RE = re.compile(r"^(?:human:[^\s/]+|process:[^\s/]+|[A-Za-z0-9_.-]+/[^\s/]+)$")
COMPUTATION_HEADING_RE = re.compile(r"^#\s+Computation\s*$", re.MULTILINE)
NEXT_HEADING_RE = re.compile(r"^#{1,6}\s+\S", re.MULTILINE)

REQUIRED_CANONICAL_KEYS = ("title", "description")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def split_frontmatter(text: str) -> tuple[dict | None, str]:
    """Return (frontmatter mapping or None, body)."""
    match = FRONTMATTER_RE.match(text)
    if not match:
        return None, text
    data = yaml.safe_load(match.group(1))
    frontmatter = data if isinstance(data, dict) else None
    return frontmatter, text[match.end() :]


def parse_frontmatter(path: Path) -> dict | None:
    return split_frontmatter(read_text(path))[0]


def bundle_markdown_files() -> list[Path]:
    return sorted(BUNDLE_DIR.rglob("*.md"))


def is_backlog(path: Path) -> bool:
    return BACKLOG_DIR in path.parents


def is_timestamp(value: object) -> bool:
    """Every OKF timestamp is ISO 8601 with an explicit UTC offset (§5)."""
    if isinstance(value, datetime):
        return value.tzinfo is not None
    return isinstance(value, str) and bool(TIMESTAMP_RE.fullmatch(value))


def is_actor(value: object) -> bool:
    """The actor convention: `<producer>/<version>`, `human:<id>`, `process:<id>` (§7)."""
    return isinstance(value, str) and bool(ACTOR_RE.fullmatch(value))


def window_errors(prefix: str, value: object) -> list[str]:
    if not isinstance(value, dict):
        return [f"{prefix}: must be a mapping with `from` and `to`"]
    errors: list[str] = []
    for key in ("from", "to"):
        if key not in value:
            errors.append(f"{prefix}: missing `{key}`")
        elif not is_timestamp(value[key]):
            errors.append(f"{prefix}: `{key}` must be an ISO 8601 datetime with a UTC offset")
    return errors


def source_errors(rel: Path, entry: object, index: int) -> list[str]:
    prefix = f"{rel}: sources[{index}]"
    if not isinstance(entry, dict):
        return [f"{prefix}: each source must be a mapping with a `resource`"]
    errors: list[str] = []
    resource = entry.get("resource")
    if not isinstance(resource, str) or not resource.strip():
        errors.append(f"{prefix}: missing `resource`")
    for key in ("id", "title"):
        if key in entry and not isinstance(entry[key], str):
            errors.append(f"{prefix}: `{key}` must be a string")
    if "author" in entry and (
        not isinstance(entry["author"], str) or not entry["author"].strip()
    ):
        errors.append(f"{prefix}: `author` must be an actor string")
    if "usage_count" in entry and (
        not isinstance(entry["usage_count"], int) or isinstance(entry["usage_count"], bool)
    ):
        errors.append(f"{prefix}: `usage_count` must be an integer")
    if "last_modified" in entry and not is_timestamp(entry["last_modified"]):
        errors.append(f"{prefix}: `last_modified` must be an ISO 8601 datetime with a UTC offset")
    if "usage_window" in entry:
        errors.extend(window_errors(f"{prefix}: usage_window", entry["usage_window"]))
    return errors


def verified_errors(rel: Path, value: object) -> list[str]:
    """`verified` is a list of `{ by, at }` events; a bare mapping is a one-element list (§5.2)."""
    entries = value if isinstance(value, list) else [value]
    errors: list[str] = []
    for index, entry in enumerate(entries):
        prefix = f"{rel}: verified[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{prefix}: must be a `{{ by, at }}` mapping")
            continue
        if not is_actor(entry.get("by")):
            errors.append(
                f"{prefix}: `by` must be an actor "
                "(human:<id>, process:<id>, or <producer>/<version>)"
            )
        if not is_timestamp(entry.get("at")):
            errors.append(f"{prefix}: `at` must be an ISO 8601 datetime with a UTC offset")
    return errors


def has_computation_body(body: str) -> bool:
    match = COMPUTATION_HEADING_RE.search(body)
    if not match:
        return False
    section = body[match.end() :]
    next_heading = NEXT_HEADING_RE.search(section)
    if next_heading:
        section = section[: next_heading.start()]
    return "```" in section or re.search(r"^ {4}\S", section, re.MULTILINE) is not None


def computation_errors(rel: Path, frontmatter: dict, body: str) -> list[str]:
    """The Attested Computation contract (§10)."""
    errors: list[str] = []
    runtime = frontmatter.get("runtime")
    if not isinstance(runtime, str) or not runtime.strip():
        errors.append(f"{rel}: Attested Computation requires a non-empty `runtime`")

    parameters = frontmatter.get("parameters")
    if parameters is not None:
        if not isinstance(parameters, list):
            errors.append(f"{rel}: `parameters` must be a list of `{{ name, type, required }}`")
        else:
            for index, parameter in enumerate(parameters):
                prefix = f"{rel}: parameters[{index}]"
                if not isinstance(parameter, dict):
                    errors.append(f"{prefix}: must be a `{{ name, type, required }}` mapping")
                    continue
                for key in ("name", "type"):
                    if not isinstance(parameter.get(key), str) or not parameter[key].strip():
                        errors.append(f"{prefix}: `{key}` is required")
                if not isinstance(parameter.get("required"), bool):
                    errors.append(f"{prefix}: `required` must be a boolean")

    for key in ("executor", "attester"):
        block = frontmatter.get(key)
        if block is None:
            continue
        if not isinstance(block, dict):
            errors.append(f"{rel}: `{key}` must be a mapping with a `resource`")
            continue
        resource = block.get("resource")
        if not isinstance(resource, str) or not resource.strip():
            errors.append(f"{rel}: `{key}.resource` names the run code and is required")
        if key == "executor" and "receipt" in block:
            receipt = block["receipt"]
            if not isinstance(receipt, list) or not all(
                isinstance(field, str) and field.strip() for field in receipt
            ):
                errors.append(f"{rel}: `executor.receipt` must be a list of field names")

    if "computation" in frontmatter and not isinstance(frontmatter["computation"], str):
        errors.append(f"{rel}: `computation` must be a path (§6.2)")

    if not frontmatter.get("computation") and not has_computation_body(body):
        errors.append(
            f"{rel}: provide the computation as a `# Computation` body fence "
            "or a `computation` path"
        )

    return errors


def family_errors(rel: Path, frontmatter: dict, body: str) -> list[str]:
    """Validate the provenance, trust, and lifecycle families when present (§5)."""
    errors: list[str] = []

    status = frontmatter.get("status")
    if status is not None and status not in STATUS_VALUES:
        errors.append(f"{rel}: `status` must be one of {', '.join(STATUS_VALUES)}")

    if "stale_after" in frontmatter and not is_timestamp(frontmatter["stale_after"]):
        errors.append(f"{rel}: `stale_after` must be an ISO 8601 datetime with a UTC offset")

    generated = frontmatter.get("generated")
    if generated is not None:
        if not isinstance(generated, dict):
            errors.append(f"{rel}: `generated` must be a `{{ by, at }}` mapping")
        else:
            if not is_actor(generated.get("by")):
                errors.append(
                    f"{rel}: `generated.by` must be an actor "
                    "(human:<id>, process:<id>, or <producer>/<version>)"
                )
            if "at" in generated and not is_timestamp(generated["at"]):
                errors.append(
                    f"{rel}: `generated.at` must be an ISO 8601 datetime with a UTC offset"
                )

    if "verified" in frontmatter:
        errors.extend(verified_errors(rel, frontmatter["verified"]))

    if "usage_window" in frontmatter:
        errors.extend(window_errors(f"{rel}: usage_window", frontmatter["usage_window"]))

    sources = frontmatter.get("sources")
    if sources is not None:
        if not isinstance(sources, list):
            errors.append(f"{rel}: `sources` must be a list of source entries")
        else:
            for index, entry in enumerate(sources):
                errors.extend(source_errors(rel, entry, index))

    tags = frontmatter.get("tags")
    if tags is not None and (
        not isinstance(tags, list)
        or not all(isinstance(tag, str) and tag.strip() for tag in tags)
    ):
        errors.append(f"{rel}: `tags` must be a list of strings")

    if frontmatter.get("type") == "Attested Computation":
        errors.extend(computation_errors(rel, frontmatter, body))

    return errors


def concept_errors(path: Path) -> list[str]:
    rel = path.relative_to(ROOT)
    frontmatter, body = split_frontmatter(read_text(path))
    if frontmatter is None:
        return [f"{rel}: missing YAML frontmatter"]

    errors: list[str] = []
    concept_type = frontmatter.get("type")
    if not isinstance(concept_type, str) or not concept_type.strip():
        errors.append(f"{rel}: frontmatter `type` is required")

    if is_backlog(path):
        if concept_type != BACKLOG_BRIEF_TYPE:
            errors.append(f"{rel}: backlog briefs must declare `type: {BACKLOG_BRIEF_TYPE}`")
        title = frontmatter.get("title")
        if not isinstance(title, str) or not title.strip():
            errors.append(f"{rel}: frontmatter `title` is required")
    else:
        for key in REQUIRED_CANONICAL_KEYS:
            if key not in frontmatter:
                errors.append(f"{rel}: frontmatter missing `{key}`")

    errors.extend(family_errors(rel, frontmatter, body))
    return errors


def errors_for_file(path: Path) -> list[str]:
    errors: list[str] = []
    rel = path.relative_to(ROOT)

    for link_target in RELATIVE_LINK_RE.findall(read_text(path)):
        if link_target.startswith("/"):
            errors.append(f"{rel}: root-relative link {link_target}; use a relative path")
            continue
        if not (path.parent / link_target).exists():
            errors.append(f"{rel}: broken link {link_target}")

    # Reserved filenames are validated centrally in validate().
    if path.name == "index.md" or path == LOG_FILE:
        return errors

    errors.extend(concept_errors(path))
    return errors


def root_index_errors() -> list[str]:
    rel = ROOT_INDEX.relative_to(ROOT)
    frontmatter = parse_frontmatter(ROOT_INDEX)
    if frontmatter is None:
        return [f"{rel}: missing YAML frontmatter"]
    errors: list[str] = []
    if set(frontmatter) != {"okf_version"}:
        errors.append(f"{rel}: root index frontmatter may carry only `okf_version` (§8)")
    if str(frontmatter.get("okf_version")) != OKF_VERSION:
        errors.append(f"{rel}: okf_version must be '{OKF_VERSION}'")
    return errors


def log_errors() -> list[str]:
    rel = LOG_FILE.relative_to(ROOT)
    text = read_text(LOG_FILE)
    errors: list[str] = []
    if FRONTMATTER_RE.match(text):
        errors.append(f"{rel}: log files carry no frontmatter")
    dates = re.findall(r"^##\s+(\S+)\s*$", text, re.MULTILINE)
    for date in dates:
        if not DATE_RE.fullmatch(date):
            errors.append(f"{rel}: date heading `{date}` must be ISO 8601 YYYY-MM-DD")
    if dates != sorted(dates, reverse=True):
        errors.append(f"{rel}: date headings must be newest first")
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
        errors.extend(root_index_errors())
    if LOG_FILE.exists():
        errors.extend(log_errors())

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

    print(f"OKF v{OKF_VERSION} bundle is valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

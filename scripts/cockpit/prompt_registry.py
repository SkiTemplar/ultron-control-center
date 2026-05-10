"""ULTRON v14.5 META-PROMPTER — Phase 3 prompt versioning.

Adds and tracks iteration metadata on prompt markdown files. Each registered
prompt carries YAML frontmatter:

  ---
  prompt_name: my-prompt
  iteration: 3
  superseded_by: ""
  created_at: "2026-05-08T18:30:00+00:00"
  last_eval_at: ""
  ---

When a prompt is improved (Phase 1+) the previous text is preserved at
`~/.ultron/.tmp/prompt-history/<name>-iterN.md` so callers can diff.

CLI:
  prompt_registry.py init <path> [--name X]   # add frontmatter if missing
  prompt_registry.py list                     # registered prompts
  prompt_registry.py version <name>            # iteration history
  prompt_registry.py diff <name> --from N --to M
  prompt_registry.py bump <path> [--rationale ...]  # increment iteration + snapshot
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# ── Paths ──────────────────────────────────────────────────────────────────────


def _user_home() -> Path:
    return Path.home()


def _history_dir() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "prompt-history"


def _registry_index() -> Path:
    return _user_home() / ".ultron" / ".tmp" / "prompt-registry.json"


# ── Frontmatter parsing ────────────────────────────────────────────────────────


_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_FM_KEYS = ("prompt_name", "iteration", "superseded_by", "created_at", "last_eval_at")


@dataclass
class PromptMeta:
    prompt_name: str
    iteration: int
    superseded_by: str = ""
    created_at: str = ""
    last_eval_at: str = ""

    def to_yaml_lines(self) -> list[str]:
        return [
            f"prompt_name: {self.prompt_name}",
            f"iteration: {self.iteration}",
            f"superseded_by: \"{self.superseded_by}\"",
            f"created_at: \"{self.created_at}\"",
            f"last_eval_at: \"{self.last_eval_at}\"",
        ]


def _parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Return (meta_dict, body). meta_dict is empty if no frontmatter."""
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    fm_text = m.group(1)
    rest = text[m.end():]
    meta: dict[str, Any] = {}
    for line in fm_text.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        k, _, v = line.partition(":")
        v = v.strip().strip('"').strip("'")
        meta[k.strip()] = v
    if "iteration" in meta:
        try:
            meta["iteration"] = int(meta["iteration"])
        except ValueError:
            meta["iteration"] = 1
    return meta, rest


def _emit_frontmatter(meta: PromptMeta, body: str) -> str:
    fm = "\n".join(meta.to_yaml_lines())
    return f"---\n{fm}\n---\n{body if body.startswith(chr(10)) else chr(10) + body}"


# ── Public API ─────────────────────────────────────────────────────────────────


def init_prompt(path: Path, name: str | None = None) -> PromptMeta:
    """Add minimal frontmatter to a prompt file if missing.

    No-ops if the file already has prompt_name + iteration; returns the existing
    meta in that case.
    """
    text = path.read_text(encoding="utf-8")
    meta_dict, body = _parse_frontmatter(text)
    if meta_dict.get("prompt_name") and meta_dict.get("iteration"):
        return PromptMeta(
            prompt_name=str(meta_dict["prompt_name"]),
            iteration=int(meta_dict["iteration"]),
            superseded_by=str(meta_dict.get("superseded_by", "")),
            created_at=str(meta_dict.get("created_at", "")),
            last_eval_at=str(meta_dict.get("last_eval_at", "")),
        )
    meta = PromptMeta(
        prompt_name=name or path.stem,
        iteration=1,
        superseded_by="",
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        last_eval_at="",
    )
    new_text = _emit_frontmatter(meta, body)
    _atomic_write(path, new_text)
    _index_register(meta, path)
    return meta


def bump_iteration(
    path: Path,
    *,
    new_body: str | None = None,
    rationale: str = "",
) -> PromptMeta:
    """Increment iteration. Snapshot the previous version under prompt-history/.

    If new_body is supplied, replaces the body (frontmatter regenerated). If not,
    only the iteration counter advances — useful for marking eval rounds.
    """
    text = path.read_text(encoding="utf-8")
    meta_dict, body = _parse_frontmatter(text)
    if not meta_dict.get("prompt_name"):
        meta = init_prompt(path)
        body = path.read_text(encoding="utf-8").split("---\n", 2)[2]
    else:
        meta = PromptMeta(
            prompt_name=str(meta_dict["prompt_name"]),
            iteration=int(meta_dict.get("iteration", 1)),
            superseded_by=str(meta_dict.get("superseded_by", "")),
            created_at=str(meta_dict.get("created_at", "")),
            last_eval_at=str(meta_dict.get("last_eval_at", "")),
        )

    # Snapshot previous iteration body (full frontmatter + body) for diffs
    history = _history_dir()
    history.mkdir(parents=True, exist_ok=True)
    snap = history / f"{meta.prompt_name}-iter{meta.iteration}.md"
    if not snap.exists():
        snap.write_text(text, encoding="utf-8")

    # Bump
    meta.iteration += 1
    meta.created_at = meta.created_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    final_body = new_body if new_body is not None else body
    new_text = _emit_frontmatter(meta, final_body)
    _atomic_write(path, new_text)
    _index_register(meta, path, rationale=rationale)
    return meta


def list_registered() -> list[dict[str, Any]]:
    idx = _registry_index()
    if not idx.exists():
        return []
    try:
        return json.loads(idx.read_text(encoding="utf-8")).get("entries", [])
    except (OSError, json.JSONDecodeError):
        return []


def history_for(name: str) -> list[Path]:
    h = _history_dir()
    if not h.exists():
        return []
    return sorted(h.glob(f"{name}-iter*.md"))


def diff_iterations(name: str, *, from_iter: int, to_iter: int) -> str:
    h = _history_dir()
    a = h / f"{name}-iter{from_iter}.md"
    b = h / f"{name}-iter{to_iter}.md"
    if not a.exists() or not b.exists():
        return f"missing snapshots: {a.exists()=} {b.exists()=}"
    return "".join(difflib.unified_diff(
        a.read_text(encoding="utf-8").splitlines(keepends=True),
        b.read_text(encoding="utf-8").splitlines(keepends=True),
        fromfile=str(a.name), tofile=str(b.name), lineterm="",
    ))


# ── Internals ──────────────────────────────────────────────────────────────────


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def _index_register(meta: PromptMeta, path: Path, *, rationale: str = "") -> None:
    idx_path = _registry_index()
    idx_path.parent.mkdir(parents=True, exist_ok=True)
    if idx_path.exists():
        try:
            data = json.loads(idx_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {"entries": []}
    else:
        data = {"entries": []}
    entries = [e for e in data.get("entries", []) if e.get("path") != str(path)]
    entries.append({
        "path": str(path),
        **asdict(meta),
        "rationale": rationale,
        "registered_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    data["entries"] = entries
    _atomic_write(idx_path, json.dumps(data, indent=2, ensure_ascii=False))


# ── CLI ────────────────────────────────────────────────────────────────────────


def _cmd_init(args: argparse.Namespace) -> int:
    p = Path(args.path)
    if not p.exists():
        print(f"ERROR: not found: {p}", file=sys.stderr)
        return 2
    meta = init_prompt(p, name=args.name or None)
    print(json.dumps(asdict(meta), indent=2))
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    print(json.dumps({"entries": list_registered()}, indent=2, ensure_ascii=False))
    return 0


def _cmd_version(args: argparse.Namespace) -> int:
    snaps = history_for(args.name)
    payload = {
        "name": args.name,
        "snapshots": [str(s) for s in snaps],
        "count": len(snaps),
    }
    print(json.dumps(payload, indent=2))
    return 0


def _cmd_diff(args: argparse.Namespace) -> int:
    out = diff_iterations(args.name, from_iter=args.from_iter, to_iter=args.to_iter)
    print(out)
    return 0 if out.strip() else 1


def _cmd_bump(args: argparse.Namespace) -> int:
    p = Path(args.path)
    if not p.exists():
        print(f"ERROR: not found: {p}", file=sys.stderr)
        return 2
    new_body = None
    if args.from_file:
        new_body = Path(args.from_file).read_text(encoding="utf-8")
    meta = bump_iteration(p, new_body=new_body, rationale=args.rationale or "")
    print(json.dumps(asdict(meta), indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prompt_registry.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="add minimal frontmatter to a prompt file")
    p_init.add_argument("path")
    p_init.add_argument("--name", default="")
    p_init.set_defaults(func=_cmd_init)

    p_list = sub.add_parser("list", help="list registered prompts")
    p_list.set_defaults(func=_cmd_list)

    p_ver = sub.add_parser("version", help="iteration history for a prompt name")
    p_ver.add_argument("name")
    p_ver.set_defaults(func=_cmd_version)

    p_diff = sub.add_parser("diff", help="unified diff between two iterations")
    p_diff.add_argument("name")
    p_diff.add_argument("--from", dest="from_iter", type=int, required=True)
    p_diff.add_argument("--to", dest="to_iter", type=int, required=True)
    p_diff.set_defaults(func=_cmd_diff)

    p_bump = sub.add_parser("bump", help="bump iteration counter (snapshots prev)")
    p_bump.add_argument("path")
    p_bump.add_argument("--from-file", help="replace body with this file's content")
    p_bump.add_argument("--rationale", default="")
    p_bump.set_defaults(func=_cmd_bump)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

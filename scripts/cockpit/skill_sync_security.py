"""ULTRON v14 Sprint 5-C — Skill Prompt-Injection Scanner.

Scans installed skills' SKILL.md (frontmatter + body) and returns a
SecurityVerdict (`allow` | `warn` | `quarantine` | `block`) by running
ten regex/heuristic rules (PI001-PI010) against the content.

DESIGN INVARIANTS
-----------------
1. Pure stdlib + optional pyyaml fallback. No network, no subprocess.
2. Decision aggregation:
   - any block finding   -> block
   - any quarantine (no block)  -> quarantine
   - any warn (no quarantine/block) -> warn
   - else -> allow
3. Trusted-source downgrade: shifts decision down one level
   (warn -> allow, quarantine -> warn) but NEVER overrides `block`.
4. Quarantine moves the skill dir to ~/.ultron/quarantine/<name>-<sha1>/
   and writes an ALERT (severity=blocking) via the alerts bus.
5. NO popups, NO console flash. Hooks call this with --quiet --json.
6. Adversarial-test friendly: each rule is an isolated method; tests
   exercise positive (catch attack) and negative (don't false-positive).
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

# Cockpit path injection so sibling modules import cleanly when called as
# a hook child or via uv run.
_COCKPIT_DIR = Path(__file__).resolve().parent
if str(_COCKPIT_DIR) not in sys.path:
    sys.path.insert(0, str(_COCKPIT_DIR))

try:
    import alerts as _alerts  # type: ignore[import-not-found]
except Exception:  # noqa: BLE001 — alerts bus is optional during checks
    _alerts = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ULTRON_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".ultron"
CLAUDE_HOME = Path(os.environ.get("USERPROFILE", os.path.expanduser("~"))) / ".claude"
SKILLS_ROOT = CLAUDE_HOME / "skills"
QUARANTINE_DIR = ULTRON_HOME / "quarantine"
TRUST_CONFIG = ULTRON_HOME / "config" / "skill-trust.yaml"

# ---------------------------------------------------------------------------
# Severity / decision ladder
# ---------------------------------------------------------------------------

SEV_LOW = "low"
SEV_MEDIUM = "medium"
SEV_HIGH = "high"
SEV_CRITICAL = "critical"

# Each severity maps to a default decision; aggregate per scan picks the
# strongest decision present.
_SEV_TO_DECISION = {
    SEV_LOW: "allow",
    SEV_MEDIUM: "warn",
    SEV_HIGH: "quarantine",
    SEV_CRITICAL: "block",
}

_DECISION_RANK = {"allow": 0, "warn": 1, "quarantine": 2, "block": 3}
_DECISION_BY_RANK = {v: k for k, v in _DECISION_RANK.items()}


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SecurityFinding:
    rule_id: str
    severity: str
    pattern_name: str
    excerpt: str
    line_number: int | None = None
    # WHY: F06 exception-mechanism — waived findings stay visible in audits
    # but are excluded from decision aggregation.
    waived: bool = False
    waived_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SecurityVerdict:
    skill_path: str
    decision: str
    findings: list[SecurityFinding]
    confidence: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "skill_path": self.skill_path,
            "decision": self.decision,
            "confidence": self.confidence,
            "findings": [f.to_dict() for f in self.findings],
        }


# ---------------------------------------------------------------------------
# Trust loader
# ---------------------------------------------------------------------------

_TRUST_CACHE: dict[str, Any] | None = None


def _parse_trust_yaml_fallback(text: str) -> dict[str, Any]:
    """Tiny parser for the exact schema we ship in skill-trust.yaml.

    Supports `trusted_sources` (list of strings), `local_skill_root` (scalar),
    and `exceptions` (list of mappings — each waiver block on contiguous
    indented lines). Mapping values may be lists (waived_rules: [...]).
    """
    out: dict[str, Any] = {}
    section: str | None = None
    cur_excep: dict[str, Any] | None = None
    for raw in text.splitlines():
        line = raw.rstrip("\n")
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if indent == 0:
            # flush pending exception block
            if cur_excep is not None:
                out.setdefault("exceptions", []).append(cur_excep)
                cur_excep = None
            if stripped.endswith(":"):
                section = stripped[:-1].strip()
                if section == "exceptions":
                    out[section] = []
                else:
                    out[section] = []
                continue
            if ":" in stripped:
                k, _, v = stripped.partition(":")
                v = v.strip().strip('"').strip("'")
                out[k.strip()] = v
                section = None
            continue
        # Inside `exceptions:` section we parse mapping blocks.
        if section == "exceptions":
            if stripped.startswith("-"):
                # flush previous block if any, start new one
                if cur_excep is not None:
                    out.setdefault("exceptions", []).append(cur_excep)
                cur_excep = {}
                rest = stripped.lstrip("-").strip()
                if rest and ":" in rest:
                    k, _, v = rest.partition(":")
                    cur_excep[k.strip()] = _coerce_yaml_scalar(v.strip())
                continue
            if cur_excep is not None and ":" in stripped:
                k, _, v = stripped.partition(":")
                cur_excep[k.strip()] = _coerce_yaml_scalar(v.strip())
            continue
        # Plain list under a list-typed section.
        if section and stripped.startswith("-"):
            val = stripped.lstrip("-").strip().strip('"').strip("'")
            target = out.get(section)
            if isinstance(target, list):
                target.append(val)
    # flush trailing exception block
    if cur_excep is not None:
        out.setdefault("exceptions", []).append(cur_excep)
    return out


def _coerce_yaml_scalar(s: str) -> Any:
    """Coerce a YAML scalar into bool / list / string. Used by the fallback."""
    s = s.strip()
    if not s:
        return ""
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1]
        out = []
        for piece in inner.split(","):
            p = piece.strip().strip('"').strip("'")
            if p:
                out.append(p)
        return out
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    low = s.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    return s


def load_trust_config(path: Path | None = None) -> dict[str, Any]:
    """Return merged trust config. Cached per-process.

    `path` defaults to module-level TRUST_CONFIG via attribute lookup so
    monkeypatched test fixtures take effect (passing the default in the
    signature would bind it at function-definition time).
    """
    global _TRUST_CACHE
    if path is None:
        path = TRUST_CONFIG
    if _TRUST_CACHE is not None:
        return _TRUST_CACHE
    defaults = {
        "trusted_sources": [],
        "local_skill_root": str(ULTRON_HOME / "skills"),
        # Bulk waivers applied to *all* skills coming from trusted_sources.
        # Drops the listed rule_ids from the decision-affecting set without
        # requiring per-skill SHA1 entries. Only `warn`-class rules belong
        # here; `block`-class rules must keep per-skill explicit waivers.
        "trusted_source_waivers": [],
    }
    if not path.exists():
        _TRUST_CACHE = defaults
        return defaults
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        _TRUST_CACHE = defaults
        return defaults
    parsed: dict[str, Any] = {}
    try:
        import yaml  # type: ignore[import-not-found]
        loaded = yaml.safe_load(text)
        parsed = loaded if isinstance(loaded, dict) else {}
    except ImportError:
        parsed = _parse_trust_yaml_fallback(text)
    except Exception:
        parsed = {}
    merged = {**defaults, **parsed}
    if not isinstance(merged.get("trusted_sources"), list):
        merged["trusted_sources"] = []
    if not isinstance(merged.get("trusted_source_waivers"), list):
        merged["trusted_source_waivers"] = []
    _TRUST_CACHE = merged
    return merged


def _is_trusted_source(source: str | None, skill_path: Path,
                       trust_config: dict[str, Any] | None = None) -> bool:
    """True iff source matches the trust config OR skill lives under
    local_skill_root.
    """
    cfg = trust_config or load_trust_config()
    local_root = cfg.get("local_skill_root", "")
    if local_root:
        try:
            # F28 fix: expand ~ and env vars so the YAML can use portable
            # paths like ~/.claude/skills instead of hardcoded user paths.
            expanded = os.path.expanduser(os.path.expandvars(str(local_root)))
            lr = Path(expanded).resolve()
            sp = skill_path.resolve()
            if lr in sp.parents or sp == lr:
                return True
        except (OSError, ValueError):
            pass
    if not source:
        return False
    sources = cfg.get("trusted_sources") or []
    src_low = source.strip().lower()
    return any(src_low == str(s).strip().lower() for s in sources)


def _lookup_provenance_source(skill_name: str) -> str | None:
    """F01 + F-MaxDual-R2-Cnew2 fix: return a TRUSTED source label for
    *skill_name* from the provenance ledger, or None if no trusted
    record exists.

    Trust comes ONLY from out-of-band metadata:
      1. ``source_url`` populated by a trusted installer (currently never
         set automatically — reserved for future signed-fetch paths) AND
         ``trust_level == "trusted"``.
      2. ``source_kind == "local"`` set by the path check at install time.

    The frontmatter-derived ``declared_source`` is NEVER consulted —
    that field is informational only. Returning None falls back to the
    "untrusted" branch in scan_skill, which preserves the strict scan.
    """
    try:
        import skill_provenance as _prov  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001
        return None
    try:
        state = _prov._load_state()  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        return None
    record = (state.get("skills") or {}).get(skill_name)
    if not isinstance(record, dict):
        return None
    trust = record.get("trust_level")
    src_url = record.get("source_url")
    if (trust == "trusted"
            and isinstance(src_url, str) and src_url.strip()):
        return src_url
    kind = record.get("source_kind")
    if kind == "local":
        return "local"
    return None


def _exception_for(skill_name: str, sha1: str,
                    trust_config: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """F06 fix: return the active exception block for *skill_name* iff
    *sha1* matches the recorded `skill_md_sha1`. Returns None otherwise.
    """
    cfg = trust_config or load_trust_config()
    raw = cfg.get("exceptions") or []
    if not isinstance(raw, list):
        return None
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        if entry.get("skill_name") != skill_name:
            continue
        recorded = str(entry.get("skill_md_sha1") or "").strip()
        if not recorded or recorded != sha1:
            continue
        return entry
    return None


# ---------------------------------------------------------------------------
# Frontmatter parser (resilient — never raises)
# ---------------------------------------------------------------------------

def _split_frontmatter(text: str) -> tuple[str, str]:
    """Return (frontmatter_block, body). Empty FM if missing."""
    if not text.startswith("---"):
        return "", text
    end = text.find("\n---", 3)
    if end == -1:
        return "", text
    return text[3:end].lstrip("\n"), text[end + 4:].lstrip("\n")


def _parse_frontmatter(fm_text: str) -> dict[str, Any] | None:
    """Best-effort YAML parse of the frontmatter block. Returns dict or None."""
    if not fm_text.strip():
        return None
    try:
        import yaml  # type: ignore[import-not-found]
        out = yaml.safe_load(fm_text)
        return out if isinstance(out, dict) else None
    except ImportError:
        # Stdlib fallback: only top-level scalar key:value pairs.
        out: dict[str, Any] = {}
        for raw in fm_text.splitlines():
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if line.startswith(" "):  # nested — skip in fallback
                continue
            if ":" not in line:
                continue
            k, _, v = line.partition(":")
            out[k.strip()] = v.strip().strip('"').strip("'")
        return out or None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Rules — each returns list[SecurityFinding]
# ---------------------------------------------------------------------------

# PI001 — Direct prompt injection markers
_PI001_PATTERNS = (
    re.compile(
        r"(?i)\bignore\s+(?:all\s+)?(?:previous|prior|earlier|above)\s+"
        r"(?:instructions|prompts?|messages?)\b"
    ),
    re.compile(r"(?i)\bdisregard\s+(?:the\s+)?system\s+prompt\b"),
    re.compile(
        r"(?i)\b(?:you\s+are\s+now|new\s+instructions?|"
        r"override\s+your\s+(?:system|previous))\b"
    ),
)

# PI002 — Hidden HTML comments with directives
_PI002_PATTERN = re.compile(
    r"<!--[\s\S]*?(?:instruction|system|prompt|ignore|override)[\s\S]*?-->",
    re.IGNORECASE,
)

# PI003 — Zero-width / RTL override / homoglyph attacks
_PI003_CHARS = ("​", "‌", "‍", "⁠", "﻿", "‮")

# PI004 — Long base64 blobs that aren't data: URIs (threshold: 60 chars)
_PI004_PATTERN = re.compile(r"(?<!data:)(?<!data:image/[a-z]{3};base64,)[A-Za-z0-9+/]{60,}={0,2}")
_PI004_DATA_URI = re.compile(r"data:[a-z/+\-]+;base64,[A-Za-z0-9+/]+=*", re.IGNORECASE)

# PI005 — Embedded shell commands inside YAML frontmatter VALUES
_PI005_SHELL_TOKEN = re.compile(
    r"(?:^|[;|`]|&&|\|\||\$\(|\$\{)\s*"
    r"(rm|curl|wget|powershell|cmd|sh|bash|nc|ncat|chmod|chown|sudo|eval|exec|kill|del)\b",
    re.IGNORECASE,
)

# PI006 — Frontmatter top-level whitelist
# Genesis update 2026-05-06: expanded with fields that show up in legitimate
# third-party skills (Anthropic claude-plugins-official, addyosmani/agent-skills,
# Apifox/aliyun marketplaces). Each addition was observed firing PI006 on
# skills USER intentionally installed; expanding the whitelist cuts ~200
# noise warnings without weakening the rule's purpose (catching novel keys
# that smell like prompt-injection vectors).
_PI006_WHITELIST = frozenset({
    # Original spec
    "name", "description", "type", "source", "triggers", "tags", "license",
    "version", "author", "deprecated", "deprecation_reason", "dependencies",
    "last_updated", "model", "color",
    # KTP fields already accepted by ULTRON's manifest
    "kind", "category", "tier", "tools", "allowed-tools", "allowed_tools",
    # Common third-party documentation fields (Genesis expansion)
    "last_verified", "tested_with", "tested_on", "platform", "os",
    "language", "languages", "framework", "frameworks",
    # Backfill telemetry fields (added by frontmatter_backfill.py)
    "token_est", "layer",
    # Routing hint — persona keyword expansion for ZTMSI
    "routing_hint",
    # Plugin / marketplace metadata
    "plugin", "marketplace", "repo", "homepage", "url",
    "summary", "examples", "metadata", "keywords",
    # Activation hints (some plugins use these in addition to triggers)
    "activation", "trigger_when", "skip_when",
    # Versioning + status
    "schema_version", "status", "stability", "ready",
})

# PI007 — Tool-call injection in description
_PI007_PATTERNS = (
    re.compile(
        r"(?i)\b(?:use|invoke|run|execute|call)\s+(?:the\s+)?"
        r"(?:bash|shell|powershell|terminal)\b"
    ),
    re.compile(r"(?i)<tool_use\b"),
    re.compile(r"(?i)<function_call\b"),
)

# PI008 — URL/IP exfiltration
_PI008_BAD_HOSTS = (
    "webhook.site",
    "requestbin",
    "ngrok.io",
    ".onion",
)
_PI008_RAW_GHUSER = re.compile(
    r"raw\.githubusercontent\.com/([A-Za-z0-9_.\-]+)/",
    re.IGNORECASE,
)
_PI008_RAW_TRUSTED_USERS = ("anthropics", "anthropic")
# Non-private IPv4 — RFC1918 and other private blocks are excluded so we don't
# false-positive on docs that show 192.168.x.x examples.
_PI008_PUBLIC_IP = re.compile(
    r"\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)"
    r"(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b"
)
_PI008_PRIVATE_PREFIXES = ("10.", "127.", "169.254.", "192.168.")


def _is_private_ip(ip: str) -> bool:
    if ip.startswith(_PI008_PRIVATE_PREFIXES):
        return True
    # 172.16.0.0–172.31.255.255
    if ip.startswith("172."):
        try:
            second = int(ip.split(".")[1])
            return 16 <= second <= 31
        except (ValueError, IndexError):
            return False
    return False


# PI009 — Excessive permissions
_PI009_DANGEROUS_TOOLS = ("bash", "write", "edit")

# PI010 — Encoded payloads
_PI010_HEX_RUN = re.compile(r"(?:\\x[0-9a-fA-F]{2}){20,}")
_PI010_URL_ENC = re.compile(r"(?:%[0-9a-fA-F]{2}){34,}")  # ~100 chars worth
_PI010_UNICODE_ESC = re.compile(r"(?:\\u[0-9a-fA-F]{4}){20,}")


def _excerpt(text: str, start: int, end: int, ctx: int = 40, cap: int = 200) -> str:
    """Trim excerpt to ≤ cap chars centered on the match. ASCII-safe."""
    a = max(0, start - ctx)
    b = min(len(text), end + ctx)
    snippet = text[a:b].replace("\n", " ").replace("\r", " ")
    if len(snippet) > cap:
        snippet = snippet[:cap]
    return snippet.strip()


def _line_no(text: str, idx: int) -> int:
    return text.count("\n", 0, idx) + 1


def _scan_pi001(text: str) -> list[SecurityFinding]:
    found: list[SecurityFinding] = []
    for rx in _PI001_PATTERNS:
        for m in rx.finditer(text):
            found.append(SecurityFinding(
                rule_id="PI001",
                severity=SEV_CRITICAL,
                pattern_name="direct_prompt_injection",
                excerpt=_excerpt(text, m.start(), m.end()),
                line_number=_line_no(text, m.start()),
            ))
    return found


def _scan_pi002(text: str) -> list[SecurityFinding]:
    found: list[SecurityFinding] = []
    for m in _PI002_PATTERN.finditer(text):
        found.append(SecurityFinding(
            rule_id="PI002",
            severity=SEV_HIGH,
            pattern_name="hidden_html_comment_directive",
            excerpt=_excerpt(text, m.start(), m.end()),
            line_number=_line_no(text, m.start()),
        ))
    return found


def _scan_pi003(text: str) -> list[SecurityFinding]:
    found: list[SecurityFinding] = []
    for ch in _PI003_CHARS:
        idx = text.find(ch)
        if idx == -1:
            continue
        found.append(SecurityFinding(
            rule_id="PI003",
            severity=SEV_HIGH,
            pattern_name=f"zero_width_or_rtl:{hex(ord(ch))}",
            excerpt=_excerpt(text, idx, idx + 1),
            line_number=_line_no(text, idx),
        ))
    return found


def _scan_pi004(text: str) -> list[SecurityFinding]:
    # Mask out legitimate data: URIs first to avoid false positives.
    masked = _PI004_DATA_URI.sub(lambda m: " " * (m.end() - m.start()), text)
    found: list[SecurityFinding] = []
    for m in _PI004_PATTERN.finditer(masked):
        found.append(SecurityFinding(
            rule_id="PI004",
            severity=SEV_MEDIUM,
            pattern_name="long_base64_blob",
            excerpt=_excerpt(text, m.start(), m.end(), ctx=10, cap=200),
            line_number=_line_no(text, m.start()),
        ))
    return found


def _scan_pi005(fm: dict[str, Any] | None, fm_text: str) -> list[SecurityFinding]:
    """Walk frontmatter VALUES (not keys) for shell-command tokens.

    Tool-name fields (`tools`, `allowed-tools`, `allowed_tools`) are skipped
    here — they're handled by PI009 (excessive-permissions audit). Otherwise
    plugin/skill files that legitimately declare `tools: Bash, Write` would
    trip a critical PI005 finding from the leading "Bash" token.
    """
    if not fm:
        return []
    found: list[SecurityFinding] = []
    # `name` is a pure identifier — many legitimate skills are named
    # "powershell-X" / "bash-Y" which would trip the shell-verb regex.
    # `tools`/`allowed-tools` are tool-name lists; PI009 audits those.
    _PI005_SKIP_KEYS = {"name", "tools", "allowed-tools", "allowed_tools"}

    def walk(node: Any, path: str = "", top_key: str | None = None) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                # Track the top-level frontmatter key so nested values inherit
                # the skip decision (e.g. tools could be a list of strings).
                effective_top = top_key if top_key is not None else (
                    str(k) if isinstance(k, str) else None
                )
                walk(v, f"{path}.{k}" if path else str(k), effective_top)
        elif isinstance(node, list):
            for i, item in enumerate(node):
                walk(item, f"{path}[{i}]", top_key)
        elif isinstance(node, str):
            if top_key in _PI005_SKIP_KEYS:
                return
            for m in _PI005_SHELL_TOKEN.finditer(node):
                found.append(SecurityFinding(
                    rule_id="PI005",
                    severity=SEV_CRITICAL,
                    pattern_name=f"shell_in_frontmatter_value:{path}",
                    excerpt=node[:200],
                    line_number=_line_no(fm_text, max(fm_text.find(node), 0))
                    if node and node in fm_text else None,
                ))

    walk(fm)
    return found


def _scan_pi006(fm: dict[str, Any] | None) -> list[SecurityFinding]:
    if not fm:
        return []
    found: list[SecurityFinding] = []
    for k in fm.keys():
        if not isinstance(k, str):
            continue
        if k not in _PI006_WHITELIST:
            found.append(SecurityFinding(
                rule_id="PI006",
                severity=SEV_MEDIUM,
                pattern_name="non_whitelisted_frontmatter_key",
                excerpt=f"key={k}",
                line_number=None,
            ))
    return found


def _scan_pi007(text: str, fm: dict[str, Any] | None) -> list[SecurityFinding]:
    """Tool-call injection in description (or anywhere in body, defensively)."""
    targets: list[tuple[str, int]] = []
    if fm and isinstance(fm.get("description"), str):
        targets.append((fm["description"], 0))
    targets.append((text, 0))
    found: list[SecurityFinding] = []
    seen_excerpts: set[str] = set()
    for blob, _ofs in targets:
        for rx in _PI007_PATTERNS:
            for m in rx.finditer(blob):
                exc = _excerpt(blob, m.start(), m.end())
                if exc in seen_excerpts:
                    continue
                seen_excerpts.add(exc)
                found.append(SecurityFinding(
                    rule_id="PI007",
                    severity=SEV_HIGH,
                    pattern_name="tool_call_injection",
                    excerpt=exc,
                    line_number=_line_no(blob, m.start()),
                ))
    return found


def _scan_pi008(text: str, fm: dict[str, Any] | None) -> list[SecurityFinding]:
    found: list[SecurityFinding] = []
    desc = ""
    if fm and isinstance(fm.get("description"), str):
        desc = fm["description"]
    blobs = (text, desc)
    seen: set[str] = set()
    for blob in blobs:
        if not blob:
            continue
        low = blob.lower()
        for needle in _PI008_BAD_HOSTS:
            idx = low.find(needle)
            if idx != -1:
                key = f"host:{needle}"
                if key in seen:
                    continue
                seen.add(key)
                found.append(SecurityFinding(
                    rule_id="PI008",
                    severity=SEV_HIGH,
                    pattern_name=f"exfil_host:{needle}",
                    excerpt=_excerpt(blob, idx, idx + len(needle)),
                    line_number=_line_no(blob, idx),
                ))
        # raw.githubusercontent under a non-anthropics path
        for m in _PI008_RAW_GHUSER.finditer(blob):
            user = m.group(1).lower()
            if user in _PI008_RAW_TRUSTED_USERS:
                continue
            key = f"rawgh:{user}"
            if key in seen:
                continue
            seen.add(key)
            found.append(SecurityFinding(
                rule_id="PI008",
                severity=SEV_HIGH,
                pattern_name=f"raw_github_untrusted:{user}",
                excerpt=_excerpt(blob, m.start(), m.end()),
                line_number=_line_no(blob, m.start()),
            ))
        # Public IP literals
        for m in _PI008_PUBLIC_IP.finditer(blob):
            ip = m.group(0)
            if _is_private_ip(ip):
                continue
            key = f"ip:{ip}"
            if key in seen:
                continue
            seen.add(key)
            found.append(SecurityFinding(
                rule_id="PI008",
                severity=SEV_HIGH,
                pattern_name=f"public_ip_literal:{ip}",
                excerpt=_excerpt(blob, m.start(), m.end()),
                line_number=_line_no(blob, m.start()),
            ))
    return found


def _scan_pi009(fm: dict[str, Any] | None, trusted: bool) -> list[SecurityFinding]:
    if not fm or trusted:
        return []
    # Accept both `tools:` and the plugin `allowed-tools:` syntax.
    raw = (fm.get("tools") or fm.get("allowed-tools") or fm.get("allowed_tools") or "")
    items: list[str] = []
    if isinstance(raw, str):
        items = [t.strip() for t in re.split(r"[,\s]+", raw) if t.strip()]
    elif isinstance(raw, list):
        items = [str(t).strip() for t in raw if isinstance(t, (str, int, float))]
    found: list[SecurityFinding] = []
    for it in items:
        if it.lower() in _PI009_DANGEROUS_TOOLS:
            found.append(SecurityFinding(
                rule_id="PI009",
                severity=SEV_MEDIUM,
                pattern_name=f"untrusted_dangerous_tool:{it}",
                excerpt=f"tools={items}",
                line_number=None,
            ))
    return found


def _scan_pi010(text: str) -> list[SecurityFinding]:
    found: list[SecurityFinding] = []
    for rx, label in (
        (_PI010_HEX_RUN, "hex_escape_run"),
        (_PI010_URL_ENC, "url_encoded_blob"),
        (_PI010_UNICODE_ESC, "unicode_escape_run"),
    ):
        for m in rx.finditer(text):
            found.append(SecurityFinding(
                rule_id="PI010",
                severity=SEV_MEDIUM,
                pattern_name=label,
                excerpt=_excerpt(text, m.start(), m.end(), ctx=10, cap=200),
                line_number=_line_no(text, m.start()),
            ))
    return found


# PI012 — Embedded system-prompt directives in SKILL body (not frontmatter)
_PI012_PATTERNS = re.compile(
    r"(?:^|\s)(?:You are\b|SYSTEM\s*:|<\s*system\s*>|<\s*/\s*system\s*>)",
    re.IGNORECASE | re.MULTILINE,
)


def _scan_pi012(body: str) -> list[SecurityFinding]:
    found: list[SecurityFinding] = []
    for m in _PI012_PATTERNS.finditer(body):
        found.append(SecurityFinding(
            rule_id="PI012",
            severity=SEV_HIGH,
            pattern_name="embedded_system_prompt",
            excerpt=_excerpt(body, m.start(), m.end()),
            line_number=_line_no(body, m.start()),
        ))
    return found


# ── PI013: encoded prompt-injection payloads ────────────────────────────────
# Reportes públicos 2026 confirman vectores via Morse + zero-width Unicode chars.
# El atacante esconde instrucciones en encoding que la IA decodifica al leer.

# Morse: secuencia de >=20 chars que solo son dots/dashes/spaces/slashes (separadores
# Morse). Coloquial "I.O.U." no matchea — los separadores Morse son `/` o múltiples
# espacios. Patrón ancho mínimo evita que "..." (elipsis) o "--" (dash) den FP.
_PI013_MORSE = re.compile(
    r"(?:[.\-]{1,8}[\s/]+){4,}[.\-]{1,8}"
)

# Zero-width Unicode chars usados para esconder texto invisible:
#   U+200B ZERO WIDTH SPACE
#   U+200C ZERO WIDTH NON-JOINER
#   U+200D ZERO WIDTH JOINER
#   U+2060 WORD JOINER
#   U+FEFF ZERO WIDTH NO-BREAK SPACE (BOM)
# Threshold: ≥3 ocurrencias en el body es señal de uso intencional (no copy-paste
# accidental). Una sola es ignorable, varias son siempre adversariales.
_PI013_ZWSP_CHARS = "​‌‍⁠﻿"
_PI013_ZWSP_RE = re.compile(f"[{_PI013_ZWSP_CHARS}]")


def _scan_pi013(body: str) -> list[SecurityFinding]:
    """Detecta payloads codificados (Morse + zero-width Unicode)."""
    found: list[SecurityFinding] = []

    # Morse: solo si la línea tiene mucha densidad de dot-dash y poco texto normal
    for m in _PI013_MORSE.finditer(body):
        # Heurística anti-FP: el bloque debe tener >50% chars Morse legítimos
        # (dot, dash, slash, space) en una ventana de 30+ chars.
        chunk = m.group(0)
        if len(chunk) < 20:
            continue
        morse_chars = sum(1 for c in chunk if c in ".-/ \t")
        if morse_chars / len(chunk) < 0.85:
            continue
        found.append(SecurityFinding(
            rule_id="PI013",
            severity=SEV_HIGH,
            pattern_name="morse_payload",
            excerpt=_excerpt(body, m.start(), m.end(), cap=120),
            line_number=_line_no(body, m.start()),
        ))

    # Zero-width chars: cuenta total. ≥3 es bandera roja.
    zwsp_count = len(_PI013_ZWSP_RE.findall(body))
    if zwsp_count >= 3:
        first = _PI013_ZWSP_RE.search(body)
        found.append(SecurityFinding(
            rule_id="PI013",
            severity=SEV_HIGH,
            pattern_name="zero_width_chars",
            excerpt=f"{zwsp_count} zero-width chars detected (U+200B/200C/200D/2060/FEFF)",
            line_number=_line_no(body, first.start()) if first else None,
        ))

    return found


# ---------------------------------------------------------------------------
# Decision aggregation
# ---------------------------------------------------------------------------

def _aggregate_decision(findings: list[SecurityFinding]) -> str:
    rank = 0
    for f in findings:
        d = _SEV_TO_DECISION.get(f.severity, "allow")
        rank = max(rank, _DECISION_RANK[d])
    return _DECISION_BY_RANK[rank]


def _downgrade(decision: str, local_owned: bool = False) -> str:
    """Trusted-source downgrade: shifts one level.

    F28: for skills under `local_skill_root` (user-owned), allow downgrading
    `block -> quarantine` too — the user is responsible for their own skills
    and doesn't want them silently dropped from the registry. For other
    trusted sources (third-party marketplaces), `block` is still terminal.
    """
    if decision == "block":
        return "quarantine" if local_owned else "block"
    rank = _DECISION_RANK.get(decision, 0)
    return _DECISION_BY_RANK[max(0, rank - 1)]


def _confidence(findings: list[SecurityFinding]) -> float:
    """Heuristic 0..1: more findings + higher severity -> higher confidence.

    A single critical -> 0.95; multiple highs -> ~0.85; warns alone -> 0.6.
    """
    if not findings:
        return 1.0  # confident allow
    weight = 0.0
    for f in findings:
        weight += {SEV_LOW: 0.1, SEV_MEDIUM: 0.3, SEV_HIGH: 0.55,
                   SEV_CRITICAL: 0.85}.get(f.severity, 0.1)
    # Squash to (0, 1)
    if weight >= 1.0:
        return 0.95
    return round(0.5 + weight / 2.0, 3)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def scan_skill(skill_path: Path, source: str | None = None) -> SecurityVerdict:
    """Scan a skill directory (or SKILL.md path). Returns a SecurityVerdict.

    `source` may be the marketplace owner / repo (e.g. "anthropics") for
    trust evaluation. If None, the skill is treated as untrusted unless its
    path is under `local_skill_root`.
    """
    skill_path = Path(skill_path)
    if skill_path.is_file():
        skill_dir = skill_path.parent
        skill_md = skill_path
    else:
        skill_dir = skill_path
        skill_md = skill_path / "SKILL.md"

    findings: list[SecurityFinding] = []
    text = ""
    fm_text = ""
    fm: dict[str, Any] | None = None

    try:
        if skill_md.exists():
            text = skill_md.read_text(encoding="utf-8", errors="replace")
            fm_text, _body = _split_frontmatter(text)
            fm = _parse_frontmatter(fm_text) if fm_text else None
    except OSError:
        # If we cannot read, treat as suspect — surface a finding.
        findings.append(SecurityFinding(
            rule_id="PI000",
            severity=SEV_HIGH,
            pattern_name="unreadable_skill_md",
            excerpt=str(skill_md),
        ))

    trust_cfg = load_trust_config()
    trusted = _is_trusted_source(source, skill_dir, trust_cfg)

    # F01 fix: NEVER trust frontmatter `source` field — a malicious skill
    # could declare itself trusted by writing `source: anthropics`. Trust
    # comes only from external metadata: `skill-provenance.json` (recorded
    # at install time) or path under `local_skill_root`.
    if not source and not trusted:
        prov_src = _lookup_provenance_source(skill_dir.name)
        if prov_src:
            trusted = _is_trusted_source(prov_src, skill_dir, trust_cfg)

    # If the SKILL.md frontmatter declared a `source`, log a low-severity
    # finding so audits see the spoofing attempt but it has NO effect on
    # the trust decision.
    if fm and isinstance(fm.get("source"), str) and fm["source"].strip():
        # F-MaxDual-R2-M3: promote PI011 to MEDIUM. A skill that
        # declares `source: anthropics` is making a spoofing attempt
        # against the trust system; that's security-relevant signal,
        # not low-noise.
        findings.append(SecurityFinding(
            rule_id="PI011",
            severity=SEV_MEDIUM,
            pattern_name="frontmatter_source_ignored",
            excerpt=f"source={fm['source']!r}",
            line_number=None,
        ))

    if text:
        findings.extend(_scan_pi001(text))
        findings.extend(_scan_pi002(text))
        findings.extend(_scan_pi003(text))
        findings.extend(_scan_pi004(text))
        findings.extend(_scan_pi005(fm, fm_text))
        findings.extend(_scan_pi006(fm))
        findings.extend(_scan_pi007(text, fm))
        findings.extend(_scan_pi008(text, fm))
        findings.extend(_scan_pi009(fm, trusted))
        findings.extend(_scan_pi010(text))
        findings.extend(_scan_pi012(_body))
        findings.extend(_scan_pi013(_body))

    # F06 fix: apply exception waivers — drop matching findings from the
    # decision-affecting set, but keep them in the verdict's findings list
    # with `waived=True` so audits see what was downgraded and why.
    cur_sha1 = ""
    try:
        if skill_md.exists():
            h = hashlib.sha1(usedforsecurity=False)
            with skill_md.open("rb") as fh:
                for chunk in iter(lambda: fh.read(65536), b""):
                    h.update(chunk)
            cur_sha1 = h.hexdigest()
    except OSError:
        cur_sha1 = ""
    excep = _exception_for(skill_dir.name, cur_sha1, trust_cfg) if cur_sha1 else None
    waived_rules: set[str] = set()
    if excep:
        rules_raw = excep.get("waived_rules") or []
        if isinstance(rules_raw, list):
            waived_rules = {str(r) for r in rules_raw}
    if waived_rules:
        new_findings: list[SecurityFinding] = []
        for f in findings:
            if f.rule_id in waived_rules:
                new_findings.append(SecurityFinding(
                    rule_id=f.rule_id,
                    severity=f.severity,
                    pattern_name=f.pattern_name,
                    excerpt=f.excerpt,
                    line_number=f.line_number,
                    waived=True,
                    waived_reason=str(excep.get("reason") or ""),
                ))
            else:
                new_findings.append(f)
        findings = new_findings

    # Bulk waiver from trusted_sources: scope-wide downgrade of by-design
    # patterns (PI012 embedded_system_prompt, PI009 dangerous-tool refs)
    # without requiring 165+ per-skill SHA1 entries for community skills.
    # Never overrides block decisions — _downgrade preserves block.
    if trusted:
        bulk_rules_raw = trust_cfg.get("trusted_source_waivers") or []
        bulk_waived = {str(r) for r in bulk_rules_raw if isinstance(bulk_rules_raw, list)}
        if bulk_waived:
            rebuilt: list[SecurityFinding] = []
            for f in findings:
                if (not f.waived) and f.rule_id in bulk_waived:
                    rebuilt.append(SecurityFinding(
                        rule_id=f.rule_id,
                        severity=f.severity,
                        pattern_name=f.pattern_name,
                        excerpt=f.excerpt,
                        line_number=f.line_number,
                        waived=True,
                        waived_reason="trusted_source_waiver",
                    ))
                else:
                    rebuilt.append(f)
            findings = rebuilt

    decisive_findings = [f for f in findings if not f.waived]
    raw_decision = _aggregate_decision(decisive_findings)
    # F28: detect if this is a user-owned skill (under local_skill_root) so
    # the downgrade can be slightly more permissive (block -> quarantine).
    local_owned = False
    try:
        local_root = trust_cfg.get("local_skill_root", "") if trust_cfg else ""
        if local_root:
            expanded = os.path.expanduser(os.path.expandvars(str(local_root)))
            lr = Path(expanded).resolve()
            sp = Path(skill_dir).resolve()
            local_owned = lr in sp.parents or sp == lr
    except (OSError, ValueError):
        local_owned = False
    final_decision = _downgrade(raw_decision, local_owned) if trusted else raw_decision
    return SecurityVerdict(
        skill_path=str(skill_dir),
        decision=final_decision,
        findings=findings,
        confidence=_confidence(decisive_findings),
    )


def scan_all_installed(skills_root: Path | None = None) -> list[SecurityVerdict]:
    """Scan every skill directory in ~/.claude/skills/. Empty list if root absent.

    F01 fix: when scanning the full registry we look up each skill's
    provenance record so trust decisions never depend on the SKILL.md's
    own frontmatter `source` field.
    """
    root = skills_root or SKILLS_ROOT
    if not root.exists():
        return []
    out: list[SecurityVerdict] = []
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return []
    for d in entries:
        if not d.is_dir():
            continue
        if d.name.startswith(".") or d.name in ("__pycache__",):
            continue
        if not (d / "SKILL.md").exists():
            continue
        try:
            # source=None forces scan_skill to consult provenance/path-trust.
            out.append(scan_skill(d, source=None))
        except Exception:  # noqa: BLE001 — one bad skill must not crash sweep
            continue
    return out


def quarantine(skill_path: Path) -> Path:
    """Move skill_path to ~/.ultron/quarantine/<name>-<sha1>/. Returns dest path.

    NOTE: irreversible from this function; user must rescue manually if a
    false-positive occurred. We always write a `quarantine_meta.json` next
    to the moved skill so provenance is preserved.
    """
    skill_path = Path(skill_path)
    if not skill_path.exists():
        raise FileNotFoundError(f"skill_path does not exist: {skill_path}")
    QUARANTINE_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(str(skill_path).encode("utf-8"),
                          usedforsecurity=False).hexdigest()[:10]
    dst = QUARANTINE_DIR / f"{skill_path.name}-{digest}"
    if dst.exists():
        # Append a counter so retries don't collide.
        i = 1
        while True:
            cand = QUARANTINE_DIR / f"{skill_path.name}-{digest}-{i}"
            if not cand.exists():
                dst = cand
                break
            i += 1
    shutil.move(str(skill_path), str(dst))
    meta = {
        "moved_at": _dt.datetime.now(_dt.timezone.utc)
            .replace(tzinfo=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "original_path": str(skill_path),
        "reason": "skill_sync_security quarantine",
    }
    try:
        (dst / "quarantine_meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        pass

    if _alerts is not None:
        try:
            _alerts.write_dedupe(
                "blocking",
                "skill_sync_security",
                f"Skill quarantined: {skill_path.name} -> {dst}",
                dedupe_tag=f"quarantine:{skill_path.name}",
                window_seconds=3600,
                tags=["security", "quarantine"],
            )
        except Exception:  # noqa: BLE001 — alerts write must never block quarantine
            pass
    return dst


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _print_verdict_human(v: SecurityVerdict) -> None:
    print(f"path: {v.skill_path}")
    print(f"decision: {v.decision}  (confidence={v.confidence})")
    if not v.findings:
        print("  no findings")
        return
    for f in v.findings:
        ln = f.line_number if f.line_number is not None else "?"
        print(f"  [{f.severity.upper():<8}] {f.rule_id} {f.pattern_name}  line={ln}")
        print(f"    excerpt: {f.excerpt[:160]}")


def _cli_scan(args: argparse.Namespace) -> int:
    verdict = scan_skill(Path(args.path), source=args.source)
    if args.json:
        print(json.dumps(verdict.to_dict(), ensure_ascii=False, indent=2))
    else:
        _print_verdict_human(verdict)
    return 0 if verdict.decision == "allow" else (
        1 if verdict.decision == "warn" else 2
    )


def _cli_audit_all(args: argparse.Namespace) -> int:
    verdicts = scan_all_installed()
    if args.json:
        out = {
            "generated_at": _dt.datetime.now(_dt.timezone.utc)
                .replace(tzinfo=None).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "total_scanned": len(verdicts),
            "by_decision": {
                "allow": sum(1 for v in verdicts if v.decision == "allow"),
                "warn": sum(1 for v in verdicts if v.decision == "warn"),
                "quarantine": sum(1 for v in verdicts if v.decision == "quarantine"),
                "block": sum(1 for v in verdicts if v.decision == "block"),
            },
            "verdicts": [v.to_dict() for v in verdicts],
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0
    print(f"Audit-all: scanned {len(verdicts)} skill(s).")
    for v in verdicts:
        if v.decision == "allow":
            continue
        print(f"  [{v.decision.upper():<10}] {Path(v.skill_path).name} "
              f"({len(v.findings)} finding(s))")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="skill_sync_security.py",
        description="ULTRON skill prompt-injection scanner (S5-C).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="Scan one skill (path or SKILL.md).")
    s.add_argument("path")
    s.add_argument("--source", default=None,
                   help="Marketplace/owner identifier for trust evaluation.")
    s.add_argument("--json", action="store_true")
    s.set_defaults(func=_cli_scan)

    a = sub.add_parser("audit-all", help="Scan every skill in ~/.claude/skills/.")
    a.add_argument("--json", action="store_true")
    a.set_defaults(func=_cli_audit_all)

    ns = p.parse_args(argv)
    return ns.func(ns)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
ULTRON v13.0 — Secrets Manager (Sprint 3 F1).

CLI for the Windows Credential Manager + DPAPI hybrid secret store. Designed
to work alongside the existing PowerShell `secrets-loader.ps1` which reads
secrets at shell startup; this module manages writes + audit + lifecycle.

Why this design (no Doppler, no Vault, no SaaS):
    - Native Windows Credential Manager + DPAPI is FREE, OS-level encrypted,
      per-user scoped. Zero third-party dependency. Zero subscription risk.
    - Tokens flow into env vars on shell start (via secrets-loader.ps1) so
      MCP configs can use ${env:GITHUB_TOKEN} without ever putting plaintext
      on disk.
    - Audit subcommand scans disk for known secret-shaped strings → catches
      regression to plaintext.

Security boundary: this is per-user encryption. An attacker who gains code
execution as your user can decrypt anything you can. The protection is
against (a) git leaks, (b) backup leaks, (c) over-the-shoulder reads,
(d) post-mortem disk recovery. NOT against active malware running as you.

CLI:
    secrets_manager.py audit            # scan disk for plaintext secrets
    secrets_manager.py list             # list keys in Credential Manager (no values)
    secrets_manager.py store --key X --value Y     # add/update credential
    secrets_manager.py delete --key X   # remove credential
    secrets_manager.py status           # show what's loaded vs what's expected

Common keys (convention):
    ULTRON_GITHUB_PAT          → $env:GITHUB_TOKEN + $env:GITHUB_PERSONAL_ACCESS_TOKEN
    ULTRON_OPENAI_KEY          → $env:OPENAI_API_KEY
    ULTRON_ANTHROPIC_KEY       → $env:ANTHROPIC_API_KEY
    ULTRON_GEMINI_KEY          → $env:GEMINI_API_KEY
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ultron_paths import (
    CLAUDE_CREDENTIALS, CLAUDE_HOME, CODEX_HOME, GEMINI_HOME, USER_HOME,
)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# ─── Convention: expected secrets ─────────────────────────────────────────────

EXPECTED_SECRETS = {
    "ULTRON_GITHUB_PAT":     ("GITHUB_TOKEN, GITHUB_PERSONAL_ACCESS_TOKEN", "required"),
    "ULTRON_OPENAI_KEY":     ("OPENAI_API_KEY", "optional — only if using OpenAI direct API"),
    "ULTRON_ANTHROPIC_KEY":  ("ANTHROPIC_API_KEY", "optional — CC uses OAuth, only for SDK builds"),
    "ULTRON_GEMINI_KEY":     ("GEMINI_API_KEY", "optional — Gemini CLI uses OAuth by default"),
}


# ─── Disk audit — scan for plaintext secret patterns ──────────────────────────

# Tight high-confidence patterns — same set as gitleaks-vault config.
SECRET_PATTERNS = (
    (re.compile(r"\bghp_[A-Za-z0-9_]{36,}"),                 "github-pat-classic"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}"),           "github-pat-fine"),
    (re.compile(r"\bgho_[A-Za-z0-9_]{36,}"),                  "github-oauth"),
    (re.compile(r"\bghs_[A-Za-z0-9_]{36,}"),                  "github-server"),
    (re.compile(r"\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}"), "openai-key"),
    (re.compile(r"\bsk-ant-(?:oat|api|ort)[0-9]+-[A-Za-z0-9_-]{30,}"),  "anthropic-key"),
    (re.compile(r"\bsbp_[A-Za-z0-9]{40,}"),                   "supabase-pat"),
    (re.compile(r"\bsbp_oauth_[A-Za-z0-9]{30,}"),             "supabase-oauth"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{35}"),                  "google-api-key"),
    (re.compile(r"\bya29\.[A-Za-z0-9_-]{30,}"),               "google-oauth"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                     "aws-access-key"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),           "slack-token"),
    (re.compile(r"\blin_api_[A-Za-z0-9]{32,}"),               "linear-api"),
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "private-key-pem"),
)


# Files known to legitimately contain auth tokens — skipped by default audit
# unless --include-known-tokens is passed.
KNOWN_TOKEN_FILES = {
    CLAUDE_CREDENTIALS,                # CC's own OAuth cache (managed by CC)
    CODEX_HOME / "auth.json",          # Codex CLI OAuth (managed by codex login)
    GEMINI_HOME / "oauth_creds.json",  # Gemini OAuth (managed by gemini auth)
}

# Directories we always skip for performance + relevance.
SKIP_DIRS = frozenset({
    ".git", ".obsidian", "node_modules", "__pycache__", ".venv", "venv",
    ".cache", "Library", "Logs", "Temp",  # Unity caches
    "DerivedData",  # iOS
    "_archive", "v6.x-legacy",
    ".tmp.driveupload", ".tmp.drivedownload",  # ephemeral, auto-purged
    "marketplaces",  # third-party CC plugins — their content is upstream's problem
    "plugins",       # CC plugin trees (third-party docs may include example PEMs)
})

# Skip current active session JSONL — Claude's transcripts naturally contain
# strings we discussed (including redacted tokens). They're not leaks; the
# tokens are dead post-rotation. Heuristic: skip JSONLs modified in last hour.
import time as _time
_RECENT_FILE_CUTOFF = _time.time() - 3600

# File extensions worth scanning (text formats). Skip binaries.
SCANNED_EXTENSIONS = frozenset({
    ".json", ".toml", ".yaml", ".yml", ".env", ".md", ".txt",
    ".jsonl", ".cfg", ".conf", ".ini",
    ".ps1", ".sh", ".bash", ".zsh", ".cmd", ".bat",
    ".py", ".js", ".ts", ".tsx", ".jsx",
})

# Maximum file size to scan (bytes). Larger files are skipped.
MAX_SCAN_BYTES = 5 * 1024 * 1024  # 5 MB


def cmd_audit(args) -> int:
    """Scan home dir for plaintext secrets. Skips known-token files unless
    --include-known-tokens is passed.

    Exit codes:
        0 = no leaks found
        1 = leaks found (count printed to stderr)
        2 = scan failed
    """
    roots = [
        USER_HOME / ".ultron",
        USER_HOME / ".ultron-vault",
        USER_HOME / ".claude",
        USER_HOME / ".codex",
        USER_HOME / ".gemini",
    ]
    findings: list[tuple[Path, str, str]] = []  # (file, pattern, snippet)
    files_scanned = 0
    files_skipped = 0

    print(f"[secrets-audit] scanning {len(roots)} roots...")
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            # skip known token files unless --include
            if p.resolve() in {f.resolve() for f in KNOWN_TOKEN_FILES if f.exists()}:
                if not args.include_known_tokens:
                    files_skipped += 1
                    continue
            # skip dirs
            if any(part in SKIP_DIRS for part in p.parts):
                files_skipped += 1
                continue
            if p.suffix not in SCANNED_EXTENSIONS:
                files_skipped += 1
                continue
            try:
                stat_info = p.stat()
                if stat_info.st_size > MAX_SCAN_BYTES:
                    files_skipped += 1
                    continue
                # Skip current/recent CC session JSONLs — they contain strings
                # we DISCUSSED (e.g. redacted tokens in our conversation about
                # secrets), not actual unrotated leaks. Pass --include-recent
                # to override.
                if (p.suffix == ".jsonl"
                    and stat_info.st_mtime > _RECENT_FILE_CUTOFF
                    and not args.include_recent):
                    files_skipped += 1
                    continue
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                files_skipped += 1
                continue
            files_scanned += 1
            for pattern, label in SECRET_PATTERNS:
                for m in pattern.finditer(text):
                    snippet = _redact(m.group(0))
                    findings.append((p, label, snippet))

    print(f"[secrets-audit] scanned={files_scanned} skipped={files_skipped} "
          f"findings={len(findings)}")

    if findings:
        # Group by file
        by_file: dict[Path, list[tuple[str, str]]] = {}
        for p, label, snippet in findings:
            by_file.setdefault(p, []).append((label, snippet))
        print(f"\n[secrets-audit] LEAKS FOUND ({len(findings)} total in {len(by_file)} file(s)):")
        for p in sorted(by_file):
            rel = _short(p)
            for label, snippet in by_file[p]:
                print(f"  ✗ {label:<22} {rel}: {snippet}")
        if args.json:
            out = [{"file": str(p), "label": label, "snippet": snippet}
                   for p, label, snippet in findings]
            print()
            print(json.dumps(out, indent=2, ensure_ascii=False))
        return 1

    print("[secrets-audit] ✓ no plaintext secrets found in scanned files")
    return 0


def _redact(s: str) -> str:
    if len(s) <= 12:
        return s[:4] + "***"
    return s[:6] + "***" + s[-4:]


def _short(p: Path) -> str:
    try:
        return str(p.relative_to(USER_HOME))
    except ValueError:
        return str(p)


# ─── Credential Manager CLI (cmdkey wrapper) ──────────────────────────────────

def _cmdkey(*args) -> tuple[int, str]:
    """Run cmdkey, return (returncode, stdout+stderr)."""
    try:
        r = subprocess.run(["cmdkey", *args], capture_output=True, text=True, timeout=10)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return 1, str(e)


def cmd_list(args) -> int:
    """List ULTRON_* credentials in Credential Manager (no values shown)."""
    rc, out = _cmdkey("/list")
    if rc != 0:
        print("[secrets-manager] cmdkey failed:", out, file=sys.stderr)
        return 2
    # Parse output. Locale-aware: English "Target:", Spanish "Destino:".
    # Format variants:
    #   "    Target: LegacyGeneric:target=ULTRON_GITHUB_PAT"
    #   "    Destino: LegacyGeneric:target=ULTRON_GITHUB_PAT"
    #   "    Destino: ULTRON_GITHUB_PAT"   (direct, no prefix)
    seen = set()
    for line in out.splitlines():
        line = line.strip()
        if (line.startswith("Target:") or line.startswith("Destino:")) and "ULTRON_" in line:
            # Strip "Target:"/"Destino:" prefix, then any "*:target=" or similar
            tgt = line.split(":", 1)[1].strip()
            if "=" in tgt:
                tgt = tgt.split("=", 1)[-1].strip()
            seen.add(tgt)
    if not seen:
        print("[secrets-manager] no ULTRON_* credentials in Credential Manager")
        return 0
    print(f"[secrets-manager] {len(seen)} ULTRON credential(s):")
    for k in sorted(seen):
        meta = EXPECTED_SECRETS.get(k, ("?", "custom"))
        print(f"  ✓ {k:<28} → {meta[0]:<35} [{meta[1]}]")
    return 0


def cmd_store(args) -> int:
    """Store/update a credential in Credential Manager."""
    if not args.key.startswith("ULTRON_"):
        print(f"[secrets-manager] WARN: key '{args.key}' does not start with ULTRON_ "
              f"— won't be picked up by secrets-loader.ps1 by convention.",
              file=sys.stderr)
    user = args.user or "ultron"
    rc, out = _cmdkey(f"/generic:{args.key}", f"/user:{user}", f"/pass:{args.value}")
    if rc != 0:
        print(f"[secrets-manager] cmdkey store failed: {out}", file=sys.stderr)
        return 1
    print(f"[secrets-manager] ✓ stored {args.key}")
    return 0


def cmd_delete(args) -> int:
    """Remove a credential from Credential Manager."""
    rc, out = _cmdkey(f"/delete:{args.key}")
    if rc != 0:
        print(f"[secrets-manager] cmdkey delete failed: {out}", file=sys.stderr)
        return 1
    print(f"[secrets-manager] ✓ deleted {args.key}")
    return 0


def cmd_status(args) -> int:
    """Show coverage: what's expected vs what's stored vs what's loaded."""
    # What's stored — locale-aware (Target: / Destino:)
    rc, out = _cmdkey("/list")
    stored = set()
    if rc == 0:
        for line in out.splitlines():
            line = line.strip()
            if (line.startswith("Target:") or line.startswith("Destino:")) and "ULTRON_" in line:
                tgt = line.split(":", 1)[1].strip()
                if "=" in tgt:
                    tgt = tgt.split("=", 1)[-1].strip()
                stored.add(tgt)

    print(f"\n{'='*70}")
    print("ULTRON Secrets Status")
    print(f"{'='*70}\n")
    print(f"{'Key':<28} {'Stored':<8} {'Loaded':<8} Notes")
    print("-" * 70)
    for key, (env_names, status) in EXPECTED_SECRETS.items():
        is_stored = "✓" if key in stored else "✗"
        # Check if env var is loaded
        import os
        first_env = env_names.split(",")[0].strip()
        is_loaded = "✓" if os.environ.get(first_env) else "✗"
        print(f"{key:<28} {is_stored:<8} {is_loaded:<8} {status}")

    custom = stored - set(EXPECTED_SECRETS)
    if custom:
        print(f"\nCustom (not in expected list): {sorted(custom)}")

    missing_required = [k for k, (_, status) in EXPECTED_SECRETS.items()
                        if status == "required" and k not in stored]
    if missing_required:
        print(f"\n⚠ MISSING REQUIRED: {missing_required}")
        print(f"  Run: secrets_manager.py store --key <X> --value <secret>")
        return 1
    return 0


# ─── CLI ───────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(prog="secrets_manager",
                                description="ULTRON v13.0 Secrets Manager (Win Cred Mgr + DPAPI)")
    sub = p.add_subparsers(dest="cmd", required=True)

    sa = sub.add_parser("audit", help="Scan disk for plaintext secret patterns")
    sa.add_argument("--include-known-tokens", action="store_true",
                    help="Also scan .credentials.json + auth.json + oauth_creds.json")
    sa.add_argument("--include-recent", action="store_true",
                    help="Also scan JSONLs modified in last hour (current sessions)")
    sa.add_argument("--json", action="store_true", help="JSON output")
    sa.set_defaults(func=cmd_audit)

    sl = sub.add_parser("list", help="List ULTRON_* keys in Credential Manager (no values)")
    sl.set_defaults(func=cmd_list)

    ss = sub.add_parser("store", help="Add/update a credential")
    ss.add_argument("--key", required=True, help="e.g. ULTRON_GITHUB_PAT")
    ss.add_argument("--value", required=True, help="The secret string")
    ss.add_argument("--user", default="ultron", help="cmdkey /user (default: ultron)")
    ss.set_defaults(func=cmd_store)

    sd = sub.add_parser("delete", help="Remove a credential")
    sd.add_argument("--key", required=True)
    sd.set_defaults(func=cmd_delete)

    sst = sub.add_parser("status", help="Show stored vs loaded vs expected")
    sst.set_defaults(func=cmd_status)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

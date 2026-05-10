"""ULTRON — wrapper limpio sobre `gemini` CLI.

Razón: el MCP `gemini` se cuelga en degraded por rate-limit del modelo Pro
en la API key plana. El CLI usa OAuth de Google y tiene cuota mucho más
generosa, así que es el canal canónico para Gemini desde scripts.

Salidas: stdout = la respuesta limpia. stderr = diagnostics. Exit 0 ok.

Uso:
    # prompt corto inline
    uv run python gemini_cli.py "¿qué año es?"

    # prompt largo desde archivo
    uv run python gemini_cli.py --file prompt.md

    # forzar modelo
    uv run python gemini_cli.py --model gemini-3.1-flash-lite "..."

    # JSON output (id, model, timing, response)
    uv run python gemini_cli.py --json "..."
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Líneas de stderr que el CLI imprime siempre y queremos filtrar
_NOISE_PATTERNS = [
    r"Warning: 256-color support not detected",
    r"^En C:\\.*gemini\.ps1: ",
    r"^\+ ",
    r"^\s*\+\s*\~",
    r"\+ CategoryInfo\s+:",
    r"\+ FullyQualifiedErrorId\s+:",
    r"Ripgrep is not available",
    r'Skill ".*" from .* is overriding',
    r"^\s*$",
]
_NOISE_RE = re.compile("|".join(_NOISE_PATTERNS), re.IGNORECASE)


def _strip_noise(text: str) -> str:
    keep = [ln for ln in text.splitlines() if not _NOISE_RE.search(ln)]
    return "\n".join(keep).strip()


def call_gemini(prompt: str, model: str | None = None,
                timeout_s: int = 120) -> dict:
    """Lanza `gemini -p <prompt>` y devuelve dict con response/timing/error.

    En Windows el `gemini` shim es un .ps1, así que usamos shell=True para
    que el resolver de Windows aplique extensiones (PATHEXT). En otros OS
    el ejecutable es nativo y shell=False.
    """
    if not shutil.which("gemini"):
        return {"ok": False, "error": "gemini CLI not in PATH",
                "response": "", "model": model, "elapsed_ms": 0}

    is_windows = sys.platform == "win32"
    if is_windows:
        # Pasamos prompt vía stdin para evitar quoting mess en cmd.exe
        cmd = "gemini"
        if model:
            cmd += f' --model "{model}"'
    else:
        args = ["gemini"]
        if model:
            args.extend(["--model", model])

    started = time.monotonic()
    try:
        if is_windows:
            proc = subprocess.run(
                cmd, input=prompt, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
                timeout=timeout_s, shell=True,
            )
        else:
            proc = subprocess.run(
                args, input=prompt, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
                timeout=timeout_s,
            )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timeout after {timeout_s}s",
                "response": "", "model": model,
                "elapsed_ms": int((time.monotonic() - started) * 1000)}

    elapsed_ms = int((time.monotonic() - started) * 1000)
    response = _strip_noise(proc.stdout)
    stderr_clean = _strip_noise(proc.stderr)

    return {
        "ok": proc.returncode == 0 and bool(response),
        "error": stderr_clean if proc.returncode != 0 else "",
        "response": response,
        "model": model or "default",
        "elapsed_ms": elapsed_ms,
        "exit": proc.returncode,
    }


def main() -> int:
    p = argparse.ArgumentParser(prog="gemini_cli", description=__doc__)
    p.add_argument("prompt", nargs="?", default=None,
                   help="Prompt inline (alternativa a --file)")
    p.add_argument("--file", type=Path, default=None,
                   help="Lee el prompt desde archivo")
    p.add_argument("--model", type=str, default=None,
                   help="Modelo override (default: el que use el CLI)")
    p.add_argument("--timeout", type=int, default=120, help="Segundos")
    p.add_argument("--json", action="store_true",
                   help="Output como JSON estructurado")
    args = p.parse_args()

    if args.file:
        if not args.file.exists():
            print(f"[gemini_cli] file not found: {args.file}", file=sys.stderr)
            return 2
        prompt = args.file.read_text(encoding="utf-8")
    elif args.prompt:
        prompt = args.prompt
    else:
        prompt = sys.stdin.read()

    if not prompt.strip():
        print("[gemini_cli] empty prompt", file=sys.stderr)
        return 2

    result = call_gemini(prompt, model=args.model, timeout_s=args.timeout)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        if result["ok"]:
            print(result["response"])
        else:
            print(f"[gemini_cli] error: {result['error']}", file=sys.stderr)

    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())

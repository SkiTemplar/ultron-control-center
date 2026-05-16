#!/usr/bin/env python3
"""
ULTRON GENESIS TUI - Interactive cockpit interface (textual library).
Version is sourced from SKILL.md frontmatter via cockpit_base.read_ultron_version().

Theme: Onyx dark. 6 views accessible via sidebar:
    Projects · Skills · Personas · News · Scheduler · Health

Run:
    ultron tui     OR     ultron     (no args opens TUI)

Keyboard:
    1-6        switch view directly
    Tab/S-Tab  cycle focus
    Enter      activate selected
    /          search/filter current view
    q          quit
    ?          help modal

ULTRON does NOT auto-commit. Git status is read-only.
AI calls go through CLIs (claude/codex/gemini), never the API directly.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from rich.markup import escape as _markup_escape

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import (  # noqa: E402
    Cockpit, COCKPIT_DIR, PROJECTS_JSON,
    DEADLINES_JSON, NEWS_DIR, NEWS_ALERTS,
    read_ultron_version,
)

ULTRON_VERSION = read_ultron_version()

# Root of the ULTRON skill directory (where references/ lives)
ULTRON_ROOT = Path.home() / ".claude" / "skills" / "ultron"

try:
    from textual import work
    from textual.app import App, ComposeResult
    from textual.binding import Binding
    from textual.containers import Horizontal, Vertical, ScrollableContainer
    from textual.screen import ModalScreen
    from textual.widgets import (
        Header, Footer, Static, DataTable, Button, Input, Markdown,
    )
    from textual.reactive import reactive
except ImportError:
    print("ERROR: textual not installed. Run: pip install textual rich")
    sys.exit(1)


# ── Theme & CSS ──────────────────────────────────────────────────────────────

TUI_CSS = """
/* v11.1.0 Onyx palette — deep blacks, restrained accents.
   Replaces tokyo-night (#1a1b26 + vibrant blues) with #0a0a0a + monochrome
   greys + single amber/cyan accent for state changes. Inspired by Onyx
   Boox / Warp default. */
Screen {
    background: #0a0a0a;
    color: #d4d4d4;
}

#sidebar {
    width: 24;
    border-right: thick #2a2a2a;
    background: #060606;
    padding: 1;
}

#main {
    padding: 1 2;
    background: #0a0a0a;
}

.nav-item {
    padding: 0 1;
    color: #a0a0a0;
}

.nav-item.active {
    background: #1f1f1f;
    color: #ffd089;
    text-style: bold;
}

#header-info {
    background: #060606;
    color: #8aa8a0;
    padding: 0 1;
    height: 1;
}

#status-bar {
    background: #060606;
    color: #d4d4d4;
    padding: 0 2;
    height: 1;
    border-bottom: solid #1a1a1a;
}

DataTable {
    background: #0a0a0a;
}

DataTable > .datatable--header {
    background: #1a1a1a;
    color: #ffd089;
    text-style: bold;
}

DataTable > .datatable--cursor {
    background: #2a2a2a;
}

Button {
    background: #1a1a1a;
    color: #d4d4d4;
    border: none;
    margin: 0 1;
}

Button:hover {
    background: #2a2a2a;
    color: #ffd089;
}

Button.primary {
    background: #2a2a2a;
    color: #ffd089;
    text-style: bold;
}

Button.success {
    background: #1f2a1f;
    color: #9eca7e;
}

Button.warning {
    background: #2a2418;
    color: #e0a868;
}

Static.title {
    color: #ffd089;
    text-style: bold;
    margin: 1 0;
}

Static.subtitle {
    color: #8aa8a0;
    margin: 0 0 1 0;
}

.muted {
    color: #555555;
}

.warning {
    color: #e0a868;
}

.error {
    color: #d77878;
}

.success {
    color: #9eca7e;
}

ModalScreen {
    align: center middle;
}

#modal-box {
    width: 60%;
    height: auto;
    max-height: 80%;
    background: #0a0a0a;
    border: thick #2a2a2a;
    padding: 2;
}

#term-output {
    height: 18;
    border: solid #2a2a2a;
    overflow-y: scroll;
    margin: 1 0;
    padding: 0 1;
    background: #050505;
}

#term-input {
    margin: 1 0 0 0;
}
"""


# ── Data loaders ─────────────────────────────────────────────────────────────

def load_projects() -> list[dict]:
    return Cockpit.read_json(PROJECTS_JSON, default={"projects": []}).get("projects", [])


def load_activity(days: int = 7) -> list[dict]:
    return []  # legacy stub — activity log retired


def load_vault_summary() -> dict:
    return {}  # legacy stub — auth-vault retired


# ── Helper: subprocess wrappers (CLI only, never API) ────────────────────────

_CREATE_NO_WINDOW = 0x08000000  # Windows PROCESS_CREATION flag — no console flash


def run_ps_hidden(cmd: str, cwd: str | None = None) -> None:
    """Run a PowerShell command silently (no visible window, no console flash).
    Use for sync/background operations that don't need user interaction.
    """
    if os.name != "nt":
        return
    subprocess.Popen(
        ["powershell", "-NoProfile", "-WindowStyle", "Hidden",
         "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd],
        cwd=cwd,
        creationflags=_CREATE_NO_WINDOW,
    )


def open_in_terminal(cmd: str, cwd: str | None = None) -> None:
    """Open a new Windows Terminal / cmd window running cmd at cwd.
    For interactive AI sessions (claude, gemini, codex). Always visible.
    For silent background scripts use run_ps_hidden() instead.
    """
    if cmd == "claude":
        cmd = "claude --dangerously-skip-permissions"
    elif cmd == "gemini":
        cmd = "gemini --yolo"
    if os.name == "nt":
        try:
            # Try Windows Terminal first
            subprocess.Popen(["wt.exe", "-d", cwd or ".", "cmd", "/k", cmd])
        except FileNotFoundError:
            subprocess.Popen(["cmd.exe", "/c", "start", "cmd", "/k", cmd], cwd=cwd)


def launch_with_prompt(prompt: str, cwd: str | None = None,
                       cli: str = "claude") -> None:
    """Copy prompt to clipboard and open a new AI terminal. User pastes + completes.

    cli: "claude" | "gemini" | "codex" — which AI CLI to open.
    """
    if os.name == "nt":
        safe = prompt.replace("'", "''")
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-WindowStyle", "Hidden",
                 "-NonInteractive", "-Command",
                 f"Set-Clipboard -Value '{safe}'"],
                capture_output=True, timeout=5,
                creationflags=_CREATE_NO_WINDOW,
            )
        except Exception:
            pass
    if cli == "claude":
        open_in_terminal("claude --dangerously-skip-permissions", cwd=cwd)
    elif cli == "gemini":
        open_in_terminal("gemini", cwd=cwd)
    elif cli == "codex":
        open_in_terminal("codex", cwd=cwd)
    else:
        open_in_terminal(cli, cwd=cwd)


def _newsletter_md_to_html(md: str, date: str) -> str:
    """Convert Gemini markdown newsletter to ULTRON-themed HTML."""
    import html as _html
    import re as _re

    def md_line_to_html(line: str) -> str:
        if line.startswith("### "):
            return f"<h3>{_html.escape(line[4:])}</h3>"
        if line.startswith("## "):
            return f"<h2>{_html.escape(line[3:])}</h2>"
        if line.startswith("# "):
            return f"<h1>{_html.escape(line[2:])}</h1>"
        if line.startswith("- "):
            text = _re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>",
                           _html.escape(line[2:]))
            return f"<li>{text}</li>"
        if line.strip() == "":
            return ""
        text = _re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", _html.escape(line))
        return f"<p>{text}</p>"

    body_parts = []
    in_ul = False
    for line in md.splitlines():
        is_li = line.startswith("- ")
        if is_li and not in_ul:
            body_parts.append("<ul>")
            in_ul = True
        elif not is_li and in_ul:
            body_parts.append("</ul>")
            in_ul = False
        h = md_line_to_html(line)
        if h:
            body_parts.append(h)
    if in_ul:
        body_parts.append("</ul>")
    body = "\n".join(body_parts)

    return f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ULTRON Newsletter — {date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,700;0,900;1,700&display=swap" rel="stylesheet">
<style>
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:#0a0e17;color:#c9d1d9;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.75}}
.wrapper{{max-width:680px;margin:0 auto;padding:0 0 60px}}
.header{{background:linear-gradient(135deg,#0d1117 0%,#161b22 50%,#0d1117 100%);border-bottom:3px solid #ffd089;padding:44px 40px 36px;text-align:center}}
.header-eyebrow{{font-family:'Inter',sans-serif;font-size:10px;letter-spacing:5px;text-transform:uppercase;color:#ffd089;margin-bottom:10px;opacity:.65}}
.header-title{{font-family:'Playfair Display',Georgia,serif;font-size:42px;font-weight:900;color:#ffd089;line-height:1.05;margin-bottom:14px}}
.header-meta{{font-family:'Inter',sans-serif;font-size:11px;color:#8aa8a0;letter-spacing:2px;text-transform:uppercase}}
.content{{padding:0 40px}}
h1{{font-family:'Playfair Display',Georgia,serif;font-size:26px;font-weight:700;color:#ffd089;margin-top:44px;margin-bottom:12px;padding-bottom:10px;border-bottom:2px solid #ffd089;line-height:1.2}}
h2{{font-family:'Inter',sans-serif;font-size:11px;font-weight:600;color:#8aa8a0;text-transform:uppercase;letter-spacing:3px;margin-top:36px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #21262d}}
h3{{font-family:'Inter',sans-serif;font-size:15px;font-weight:600;color:#e0a868;margin-top:22px;margin-bottom:6px}}
p{{margin:10px 0;color:#c9d1d9}}
ul{{padding-left:18px;margin:8px 0 14px}}
li{{margin:7px 0;color:#c9d1d9}}
strong{{color:#e0a868;font-weight:600}}
a{{color:#58a6ff;text-decoration:none}}
a:hover{{text-decoration:underline}}
.footer{{margin-top:56px;padding:24px 40px;border-top:1px solid #21262d;text-align:center;font-family:'Inter',sans-serif;font-size:10px;color:#484f58;letter-spacing:1.5px;text-transform:uppercase}}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="header-eyebrow">⌬ Ultron Intelligence</div>
    <div class="header-title">Daily Briefing</div>
    <div class="header-meta">{date} &nbsp;·&nbsp; Gemini 3.1 Pro &nbsp;·&nbsp; ULTRON v11</div>
  </div>
  <div class="content">
{body}
  </div>
  <div class="footer">ULTRON v11 &nbsp;·&nbsp; Generado por Gemini 3.1 Pro Preview &nbsp;·&nbsp; {date}</div>
</div>
</body>
</html>"""


def trigger_scheduled_task(task_name: str) -> bool:
    """Run a Task Scheduler task NOW."""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", f"Start-ScheduledTask -TaskName {task_name}"],
            capture_output=True, timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def disable_task(task_name: str) -> bool:
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", f"Disable-ScheduledTask -TaskName {task_name}"],
            capture_output=True, timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def enable_task(task_name: str) -> bool:
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", f"Enable-ScheduledTask -TaskName {task_name}"],
            capture_output=True, timeout=10,
        )
        return result.returncode == 0
    except Exception:
        return False


def get_scheduled_tasks() -> list[dict]:
    """Return [{name, state, last_run, next_run, last_result}, ...] for Ultron* tasks.

    Defensively handles null LastRunTime / NextRunTime (when task has never run).
    """
    if os.name != "nt":
        return []
    try:
        ps = """
$tasks = Get-ScheduledTask -TaskName 'Ultron*' -ErrorAction SilentlyContinue
if (-not $tasks) { Write-Output '[]'; exit }
$out = foreach ($t in $tasks) {
    $info = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
    $lastRun = if ($info -and $info.LastRunTime) { $info.LastRunTime.ToString('o') } else { '' }
    $nextRun = if ($info -and $info.NextRunTime) { $info.NextRunTime.ToString('o') } else { '' }
    $lastResult = if ($info) { $info.LastTaskResult } else { $null }
    [pscustomobject]@{
        name = $t.TaskName
        state = $t.State.ToString()
        last_run = $lastRun
        next_run = $nextRun
        last_result = $lastResult
    }
}
$out | ConvertTo-Json -Depth 3 -Compress
"""
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=15, encoding="utf-8",
        )
        if result.returncode != 0:
            return []
        stdout = (result.stdout or "").strip()
        if not stdout:
            return []
        # Strip BOM if present
        if stdout.startswith("﻿"):
            stdout = stdout[1:]
        data = json.loads(stdout)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return [data]
        return []
    except Exception:
        return []


def get_git_status_short(project_path: str) -> dict:
    """Returns {branch, ahead, behind, dirty} or empty dict if not a git repo."""
    out = {"branch": None, "ahead": 0, "behind": 0, "dirty": False}
    try:
        # Branch name
        r = subprocess.run(
            ["git", "-C", project_path, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return {}
        out["branch"] = r.stdout.strip()
        # Dirty?
        r = subprocess.run(
            ["git", "-C", project_path, "status", "--porcelain"],
            capture_output=True, text=True, timeout=5,
        )
        out["dirty"] = bool(r.stdout.strip())
        # Ahead/behind vs upstream
        r = subprocess.run(
            ["git", "-C", project_path, "rev-list", "--left-right", "--count", "HEAD...@{u}"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip():
            parts = r.stdout.strip().split()
            if len(parts) == 2:
                out["ahead"], out["behind"] = int(parts[0]), int(parts[1])
    except Exception:
        return out
    return out


# ── Newsletter template (Gemini 3-edition shared prompt) ──────────────────────

# Template + audit prompts live next to the source file so they ship with
# the skill checkout; not in `~/.ultron/cockpit/` (runtime data dir).
_SKILL_COCKPIT_DIR = Path(__file__).resolve().parent
NEWSLETTER_TEMPLATE_PATH = _SKILL_COCKPIT_DIR / "templates" / "newsletter.md.tmpl"

NEWSLETTER_EDITIONS: dict[str, dict] = {
    "tech": {
        "edition_name": "ULTRON Times",
        "header_logo": "⌬ ULTRON Times",
        "tagline": "AI · Tech · Dev · Security · Daily Brief",
        "accent": "amber #ffd089",
        "topics": (
            "- AI Research: papers notables del día (arxiv cs.AI/cs.CL/cs.SE, "
            "HuggingFace papers, DeepMind, Anthropic, OpenAI research)\n"
            "- AI Industry: lanzamientos de modelos, APIs, agents, benchmarks; "
            "movimientos de OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Meta AI\n"
            "- Dev Tooling & Agents: Claude Code, Cursor, Codex CLI, Gemini CLI, "
            "Windsurf, Cline, Aider, MCP servers, IDE integrations\n"
            "- Tech Platforms: cloud (AWS/Azure/GCP What's New), Vercel, Cloudflare, "
            "GitHub releases, framework majors (Next.js, React, Vue, Svelte), "
            "language releases (Python, Node, Rust, Go)\n"
            "- Security & Regulation: CVEs críticos (CVSS≥7), supply chain, "
            "prompt injection, AI safety advisories, EU AI Act, FTC, regulators\n"
            "- Markets & Funding: rounds, IPOs, layoffs, M&A en AI/Tech\n"
            "- GitHub Trending: top repos AI/dev del día (top 5)"
        ),
        "sources": (
            "Blogs oficiales (Anthropic, OpenAI, Google AI, DeepMind, Meta AI, Mistral); "
            "arxiv cs.AI/cs.CL/cs.SE; HuggingFace papers; "
            "GitHub Trending + GitHub Blog; Hacker News front page (top 30); "
            "TechCrunch, The Verge, Ars Technica, The Information; "
            "Cloudflare Blog, Vercel Blog, AWS What's New, Azure updates, GCP releases; "
            "Microsoft DevBlogs, JetBrains releases, Mozilla Hacks; "
            "NVD CVEs (últimos 7d), GitHub Advisory DB; "
            "Reuters Tech, Bloomberg Tech, FT Tech para markets/funding"
        ),
        "sections": (
            "AI Research · AI Industry · Dev Tooling & Agents · "
            "Tech Platforms · Security & Regulation · Markets & Funding · GitHub Trending"
        ),
        "min_news": 25,
        "output_suffix": "",
        "breaking_banner_block": (
            "- BREAKING BANNER (si hay): franja roja con 🚨 noticia urgente\n"
        ),
    },
}


def build_newsletter_prompt(edition_key: str,
                              today: str | None = None,
                              weekday: str | None = None) -> str:
    """Render the shared newsletter template for the AI/Tech edition.

    Raises KeyError if `edition_key` is not in NEWSLETTER_EDITIONS, and
    FileNotFoundError if the template file is missing — both are
    surfaced to the user via the TUI notify rather than silenced.
    """
    cfg = NEWSLETTER_EDITIONS[edition_key]
    if today is None:
        today = datetime.now().strftime("%Y-%m-%d")
    if weekday is None:
        weekday = datetime.now().strftime("%A")
    tmpl = NEWSLETTER_TEMPLATE_PATH.read_text(encoding="utf-8")
    return tmpl.format(today=today, weekday=weekday, **cfg)


# ── Audit prompts (Kirkardo TUI buttons) ────────────────────────────────────

AUDIT_PROMPTS_DIR = _SKILL_COCKPIT_DIR / "tui" / "prompts"

# (filename, label, cost-tag, cli).
# cli: "claude" if Claude orchestrates peers (Triple/MaxTriple/Dual+orchestrator),
#      "codex"  if the prompt is a pure Codex task (botón 9).
AUDIT_BUTTONS: list[tuple[str, str, str, str]] = [
    ("01-memoria.md",          "Memoria",            "ULTRA TRIPLE",      "claude"),
    ("02-skill-network.md",    "Skill Network",      "ULTRA TRIPLE",      "claude"),
    ("03-vault.md",            "Vault",              "ULTRA TRIPLE",      "claude"),
    ("04-hooks.md",            "Hooks",              "HIGH DUAL --codex", "claude"),
    ("05-cockpit.md",          "Cockpit",            "ULTRA TRIPLE",      "claude"),
    ("06-self-improve.md",     "Self-improve",       "HIGH DUAL",         "claude"),
    ("07-skills.md",           "Personas",           "ULTRA TRIPLE",      "claude"),
    ("08-todo-sistema.md",     "Todo el sistema",    "MAXTRIPLE",         "claude"),
    ("09-prompt-clipboard.md", "Prompt Clipboard",   "MINIDUAL --codex",  "codex"),
]


def _load_audit_prompt(filename: str) -> str | None:
    """Read audit prompt .md and extract the first fenced code block.
    Substitutes `{TODAY}` with the current date so OUTPUT paths stay fresh.

    Path containment: the resolved path must stay inside AUDIT_PROMPTS_DIR.
    Today every caller passes a literal filename, but this guards future
    callers (and any user-influenced filename) against `..` traversal.
    """
    if not isinstance(filename, str) or "/" in filename or "\\" in filename:
        return None
    path = (AUDIT_PROMPTS_DIR / filename).resolve()
    try:
        path.relative_to(AUDIT_PROMPTS_DIR.resolve())
    except ValueError:
        return None
    if not path.exists():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    lines = text.splitlines()
    start = end = -1
    for i, line in enumerate(lines):
        if line.strip().startswith("```"):
            if start == -1:
                start = i
            else:
                end = i
                break
    if start == -1 or end == -1:
        body = text.strip()
    else:
        body = "\n".join(lines[start + 1:end]).strip()
    if not body:
        return None
    return body.replace("{TODAY}", datetime.now().strftime("%Y-%m-%d"))


class RecallModal(ModalScreen):
    """v14.8 P6 — Interactive vault recall modal.

    Capital `R` from any view opens this. Type a query, press Enter, see top-3
    semantic hits from the v14.6 hybrid retriever (BM25 + Qdrant vectors via
    RRF). Esc to close. The modal runs the retriever in a background thread
    so the TUI stays responsive while embedding (~50-100ms warm).
    """

    BINDINGS = [Binding("escape", "dismiss", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Static("[b cyan]🔎 ULTRON Recall[/b cyan]", classes="title")
            yield Static(
                "[dim]Búsqueda semántica + BM25 sobre 268+ notas del vault. "
                "Enter para ejecutar, Esc para cerrar.[/dim]",
                classes="subtitle",
            )
            yield Input(placeholder="¿Qué buscas?", id="recall-input")
            yield Static("", id="recall-results")
            with Horizontal(classes="button-row"):
                yield Button("Cerrar", id="recall-close", variant="default")

    def on_mount(self) -> None:
        try:
            self.query_one("#recall-input", Input).focus()
        except Exception:
            pass

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "recall-close":
            self.dismiss()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = (event.value or "").strip()
        if not text:
            return
        try:
            results = self.query_one("#recall-results", Static)
            results.update("[yellow]Buscando…[/yellow]")
        except Exception:
            return
        self._run_query(text)

    @work(thread=True, exclusive=True)
    def _run_query(self, text: str) -> None:
        """Background-thread call to hybrid_retriever; result formatted to Static."""
        import subprocess as _sp
        _SP_HIDDEN = _sp.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        venv_py = (
            Path.home() / ".claude" / "skills" / "ultron"
            / ".venv" / "Scripts" / "python.exe"
        )
        if not venv_py.exists():
            venv_py = Path(sys.executable)
        script = COCKPIT_DIR / "hybrid_retriever.py"
        if not script.exists():
            self.app.call_from_thread(
                self._render_results, "[red]hybrid_retriever.py missing[/red]"
            )
            return
        try:
            proc = _sp.run(
                [str(venv_py), str(script), "query", text, "--top", "3"],
                capture_output=True, text=True, timeout=20,
                creationflags=_SP_HIDDEN, encoding="utf-8",
            )
        except _sp.TimeoutExpired:
            self.app.call_from_thread(
                self._render_results, "[red]Timeout — Qdrant down?[/red]"
            )
            return
        if proc.returncode != 0:
            self.app.call_from_thread(
                self._render_results,
                f"[red]Error exit {proc.returncode}[/red]\n{proc.stderr[:200]}",
            )
            return
        try:
            data = json.loads(proc.stdout)
        except json.JSONDecodeError:
            self.app.call_from_thread(
                self._render_results, "[red]Invalid JSON from retriever[/red]"
            )
            return
        rows = data.get("results", [])
        if not rows:
            self.app.call_from_thread(
                self._render_results, "[yellow]Sin resultados[/yellow]"
            )
            return
        out_lines = []
        for i, r in enumerate(rows, 1):
            path = r.get("path", "?")
            score = r.get("score", 0.0)
            snippet = (r.get("snippet") or "").replace("\n", " ").strip()
            if len(snippet) > 180:
                snippet = snippet[:180] + "…"
            short_path = "…" + path[-60:] if len(path) > 60 else path
            out_lines.append(
                f"[b]{i}.[/b] [cyan]{_markup_escape(short_path)}[/cyan] "
                f"[dim](score {score:.3f})[/dim]"
            )
            if snippet:
                out_lines.append(f"   [dim]{_markup_escape(snippet)}[/dim]")
        self.app.call_from_thread(self._render_results, "\n".join(out_lines))

    def _render_results(self, body: str) -> None:
        try:
            self.query_one("#recall-results", Static).update(body)
        except Exception:
            pass


class DeleteProjectModal(ModalScreen):
    """Tecla `d` con project seleccionado — confirmación antes de borrar del registry."""
    BINDINGS = [Binding("escape", "dismiss", "Cancel")]

    def __init__(self, project_id: str) -> None:
        super().__init__()
        self.project_id = project_id

    def compose(self) -> ComposeResult:
        with Vertical(id="modal-box"):
            yield Static("[b red]Delete Project[/b red]", classes="title")
            yield Static(
                f"[yellow]¿Eliminar [b]{_markup_escape(self.project_id)}[/b] del registry?[/yellow]\n"
                "[dim]Solo se elimina del registry — no borra archivos del disco.[/dim]",
                classes="subtitle")
            with Horizontal(classes="button-row"):
                yield Button("Confirmar", id="del-confirm", variant="error")
                yield Button("Cancelar", id="del-cancel", variant="default")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "del-confirm":
            self._do_delete()
        else:
            self.dismiss()

    @work(thread=True, exclusive=True)
    def _do_delete(self) -> None:
        script = Path(__file__).parent / "project_editor.py"
        cmd = [sys.executable, str(script), "delete", self.project_id, "--yes"]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True,
                               timeout=15, encoding="utf-8")
            ok = r.returncode == 0
            msg = ((r.stdout or "") + (r.stderr or "")).strip()
            self.app.call_from_thread(self._finish, ok, msg)
        except Exception as e:
            self.app.call_from_thread(self._finish, False, str(e))

    def _finish(self, ok: bool, msg: str) -> None:
        if ok:
            self.app.notify(f"Deleted: {self.project_id}", severity="information")
            self.dismiss()
        else:
            self.app.notify(f"Delete failed: {msg[:120]}", severity="error")
            self.dismiss()


# ── Usage week reset config ──────────────────────────────────────────────────

USAGE_CONFIG_PATH = COCKPIT_DIR / "usage-config.json"

# Python's datetime.weekday(): Mon=0 .. Sun=6
_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday",
                  "Friday", "Saturday", "Sunday"]
_WEEKDAY_SHORT = {"mon": 0, "tue": 1, "wed": 2, "thu": 3,
                  "fri": 4, "sat": 5, "sun": 6,
                  "lun": 0, "mar": 1, "mie": 2, "mié": 2,
                  "jue": 3, "vie": 4, "sab": 5, "sáb": 5, "dom": 6}

USAGE_CONFIG_DEFAULTS = {
    "weekday": 4,   # Friday
    "hour": 3,      # 03:00
    "minute": 0,
}


def load_usage_config() -> dict[str, int]:
    """Read the weekly-reset config; fall back to Friday 03:00 on any
    error. Returns a dict with keys ``weekday`` (0=Mon..6=Sun),
    ``hour`` (0-23), ``minute`` (0-59).
    """
    try:
        raw = json.loads(USAGE_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(USAGE_CONFIG_DEFAULTS)
    out = dict(USAGE_CONFIG_DEFAULTS)
    for key in ("weekday", "hour", "minute"):
        v = raw.get(key)
        # Reject bool subclass — `isinstance(True, int)` is True in Python.
        if isinstance(v, bool) or not isinstance(v, int):
            continue
        upper = 6 if key == "weekday" else (23 if key == "hour" else 59)
        if 0 <= v <= upper:
            out[key] = v
    return out


def save_usage_config(weekday: int, hour: int, minute: int) -> None:
    payload = {"weekday": int(weekday), "hour": int(hour), "minute": int(minute)}
    USAGE_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = USAGE_CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(tmp, USAGE_CONFIG_PATH)


def parse_reset_input(text: str) -> tuple[int, int, int] | None:
    """Parse free-form input like 'Friday 03:00', 'fri 3', 'vie 03:00',
    '4 3 0'. Returns (weekday, hour, minute) or None.

    Rejects unexpected separators (period, slash, dash) so 'Friday 3.00'
    fails loudly instead of silently coercing to 03:00.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    if re.search(r"[./\-]", text):
        return None
    parts = re.split(r"[\s,:]+", text.strip().lower())
    parts = [p for p in parts if p]
    if not parts:
        return None
    # weekday
    weekday: int | None = None
    if parts[0].isdigit() and len(parts[0]) <= 1:
        v = int(parts[0])
        if 0 <= v <= 6:
            weekday = v
    if weekday is None:
        for prefix, idx in _WEEKDAY_SHORT.items():
            if parts[0].startswith(prefix):
                weekday = idx
                break
    if weekday is None:
        return None
    # hour + minute (remaining)
    hour, minute = 0, 0
    if len(parts) >= 2 and parts[1].isdigit():
        h = int(parts[1])
        if 0 <= h <= 23:
            hour = h
        else:
            return None
    if len(parts) >= 3 and parts[2].isdigit():
        m = int(parts[2])
        if 0 <= m <= 59:
            minute = m
        else:
            return None
    return weekday, hour, minute


def compute_week_window(now: datetime,
                        weekday: int, hour: int, minute: int
                        ) -> tuple[datetime, datetime]:
    """Given the current time and a weekly anchor (weekday+hour+minute),
    return the (start, end) datetimes of the active 7-day window.
    """
    days_since = (now.weekday() - weekday) % 7
    start = now.replace(hour=hour, minute=minute, second=0, microsecond=0) \
               - timedelta(days=days_since)
    if now < start:
        start -= timedelta(days=7)
    return start, start + timedelta(days=7)


class UsageResetConfigModal(ModalScreen):
    """Modal: edit the weekly-usage reset day + hour. Default Fri 03:00."""

    BINDINGS = [Binding("escape", "dismiss", "Cancel")]

    def __init__(self) -> None:
        super().__init__()
        self._cfg = load_usage_config()

    def compose(self) -> ComposeResult:
        cur_day = _WEEKDAY_NAMES[self._cfg["weekday"]]
        cur_str = f"{cur_day} {self._cfg['hour']:02d}:{self._cfg['minute']:02d}"
        with Vertical(id="modal-box"):
            yield Static("[b]Usage — Weekly Reset[/b]", classes="title")
            yield Static(
                "[dim]Día y hora cuando empieza la semana de Anthropic.\n"
                "Formatos: 'Friday 03:00' · 'fri 3' · 'vie 03:00' · '4 3 0'[/dim]",
                classes="subtitle")
            yield Static(f"  Actual: [cyan]{cur_str}[/cyan]")
            yield Input(value=cur_str, id="usage-reset-input",
                         placeholder="Friday 03:00")
            with Horizontal(classes="button-row"):
                yield Button("Guardar", id="usage-save", variant="primary")
                yield Button("Cancelar", id="usage-cancel", variant="default")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "usage-cancel":
            self.dismiss(False)
            return
        if event.button.id == "usage-save":
            inp = self.query_one("#usage-reset-input", Input)
            parsed = parse_reset_input(inp.value)
            if not parsed:
                self.app.notify("Formato inválido. Ej: 'Friday 03:00'",
                                 severity="error")
                return
            weekday, hour, minute = parsed
            try:
                save_usage_config(weekday, hour, minute)
            except OSError as exc:
                self.app.notify(f"Save failed: {exc}", severity="error")
                return
            self.app.notify(
                f"Reset configurado: {_WEEKDAY_NAMES[weekday]} "
                f"{hour:02d}:{minute:02d}",
                severity="information")
            self.dismiss(True)


# ── Main App ─────────────────────────────────────────────────────────────────

class UltronTUI(App):
    """ULTRON GENESIS — terminal interface to all cockpit subsystems."""

    CSS = TUI_CSS
    TITLE = f"ULTRON GENESIS {ULTRON_VERSION}"
    SUB_TITLE = "AI ops · Genesis cockpit"

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        # Views (1-5 + u/v/f)
        Binding("1", "view_projects",      "Projects"),
        Binding("2", "view_news",          "News"),
        Binding("3", "view_scheduler",     "Scheduler"),
        Binding("4", "view_health",        "System"),
        Binding("5", "view_mcps",          "MCPs"),
        Binding("6", "view_usage",         "Usage"),
        Binding("7", "view_autoupdater",   "AutoUpd"),
        Binding("8", "view_changelog",     "Changelog"),
        Binding("9", "view_skills_market", "Skills"),
        Binding("0", "view_inventory",     "Inventory"),
        # Project actions
        Binding("r", "refresh",        "Refresh"),
        Binding("R", "open_recall",       "Recall", show=True),
        Binding("s", "system_snapshot",   "Snapshot", show=False),
        Binding("v", "system_validate",   "Validate", show=False),
        Binding("i", "system_reindex",    "Reindex", show=False),
        Binding("o", "open_selected",  "Open"),
        Binding("d", "delete_project", "Delete"),
        # AI sessions
        Binding("c", "claude_here",    "Claude"),
        Binding("g", "session_gemini", "Gemini"),
        Binding("x", "session_codex",  "Codex"),
        # Meta (clipboard)
        Binding("k", "kirkardo_audit", "Kirkardo"),
        Binding("n", "new_skill",      "NewSkill"),
    ]

    current_view: reactive[str] = reactive("")

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield Static("", id="status-bar")
        with Horizontal():
            with Vertical(id="sidebar"):
                yield Static("[b]⌬ ULTRON[/b]", id="logo")
                yield Static(f"[dim]GENESIS {ULTRON_VERSION}[/dim]")
                yield Static("")
                yield Static("[b]VIEWS[/b]", classes="muted")
                yield Static(" 1 › Projects",    id="nav-projects",      classes="nav-item active")
                yield Static(" 2 ⌬ News",        id="nav-news",          classes="nav-item")
                yield Static(" 3 › Scheduler",   id="nav-scheduler",     classes="nav-item")
                yield Static(" 4 ⚡ System",      id="nav-health",        classes="nav-item")
                yield Static(" 5 › MCPs",        id="nav-mcps",          classes="nav-item")
                yield Static(" 6 › Usage",       id="nav-usage",         classes="nav-item")
                yield Static(" 7 ↻ AutoUpd",     id="nav-autoupdater",   classes="nav-item")
                yield Static(" 8 › Changelog",   id="nav-changelog",     classes="nav-item")
                yield Static(" 9 # Skills",      id="nav-skills-market", classes="nav-item")
                yield Static(" 0 ⌬ Inventory",   id="nav-inventory",     classes="nav-item")
                yield Static("")
                yield Static("[b]PROYECTO[/b]", classes="muted")
                yield Static("[dim]o[/dim]  Open in IDE")
                yield Static("[dim]d[/dim]  Delete")
                yield Static("")
                yield Static("[b]AI SESSIONS[/b]", classes="muted")
                yield Static("[dim]c[/dim]  Claude")
                yield Static("[dim]g[/dim]  Gemini")
                yield Static("[dim]x[/dim]  Codex")
                yield Static("")
                yield Static("[b]MEJORAS[/b]", classes="muted")
                yield Static("[dim]k[/dim]  Kirkardo 💬")
                yield Static("[dim]n[/dim]  Nueva skill 💬")
                yield Static("")
                yield Static("[dim]r[/dim] Refresh   [dim]q[/dim] Quit")
                yield Static("[dim]💬 = prompt al clipboard[/dim]", classes="muted")
            with Vertical(id="main"):
                yield ScrollableContainer(id="content")
        yield Footer()

    def on_mount(self) -> None:
        self._refresh_status_bar()
        self.action_view_projects()
        # v10.5.1: refresh status bar every 30s so cron updates / pending
        # proposals / gaming detection bubble up without manual reload.
        self.set_interval(30.0, self._refresh_status_bar)

    def _refresh_status_bar(self) -> None:
        """Composite live status: cron count, pending proposals, activity 24h,
        gaming/pause state. Rendered in one line below the header."""
        try:
            bar = self.query_one("#status-bar", Static)
        except Exception:
            return
        parts: list[str] = []

        # Cron jobs (cached check — schtasks call is ~50ms)
        try:
            r = subprocess.run(["schtasks", "/Query", "/FO", "CSV", "/NH"],
                               capture_output=True, text=True, timeout=5,
                               encoding="utf-8", errors="replace")
            if r.returncode == 0:
                n = sum(1 for ln in r.stdout.splitlines()
                        if "Ultron" in ln or "ULTRON" in ln)
                parts.append(f"[#9eca7e]●[/#9eca7e] {n} cron")
        except Exception:
            parts.append("[#d77878]●[/#d77878] cron?")

        # Pending L2 proposals
        try:
            pending = 0
            actionable = 0
            proposals_dir = COCKPIT_DIR / "proposals"
            if proposals_dir.exists():
                for f in proposals_dir.glob("*.json"):
                    if f.stem.endswith(".applied"):
                        continue
                    try:
                        d = json.loads(f.read_text(encoding="utf-8"))
                        if d.get("status") == "consumed":
                            continue
                        n = sum(1 for p in d.get("proposals", [])
                                if p.get("old_string")
                                and p.get("false_positive_risk") in (None, "none", "low"))
                        if n:
                            pending += 1
                            actionable += n
                    except (OSError, json.JSONDecodeError):
                        continue
            if actionable:
                parts.append(f"[#e0a868]⚠[/#e0a868] {actionable} patches pending")
            else:
                parts.append("[#555]—[/#555] no pending")
        except Exception:
            pass

        # Gaming / pause state
        try:
            sys.path.insert(0, str(Path(__file__).parent))
            from should_run import gaming_or_paused
            skip, why = gaming_or_paused()
            if skip:
                parts.append(f"[#e0a868]⏸[/#e0a868] {why[:40]}")
        except Exception:
            pass

        # News freshness — check newsletter HTML or ULTRON Times HTML
        try:
            today_str = f"{datetime.now():%Y-%m-%d}"
            news_today = (
                (NEWS_DIR / f"newsletter-{today_str}.html").exists()
                or any((Path.home() / ".ultron" / "news").glob(f"news_{today_str.replace('-','')}*.html"))
            )
            if news_today:
                parts.append("[#9eca7e]⌬[/#9eca7e] news today")
            else:
                parts.append("[#555]⌬[/#555] news stale")
        except Exception:
            pass

        bar.update("  ".join(parts))

    # ── View navigation ──────────────────────────────────────────────────────

    def _set_active_nav(self, view_name: str) -> None:
        for w in self.query(".nav-item"):
            w.remove_class("active")
        try:
            self.query_one(f"#nav-{view_name}", Static).add_class("active")
        except Exception:
            pass
        self.current_view = view_name

    # v12 "Brain Update": idempotent view switches — serialized via _switching_view
    # flag. Antes era race condition (mount sobre mount mid-flight → DuplicateIds).
    # Pulsar la misma tecla 2x es no-op. Para refrescar la activa, usar 'r'.
    _switching_view: bool = False

    def _switch_view_safe(self, view_name: str, renderer) -> None:
        """Single guarded entry point for all view switches.

        Drops re-entries (same view OR another switch in flight) so that the
        sync `_clear_content` can never overlap with a still-pending mount.
        """
        if self.current_view == view_name or self._switching_view:
            return
        self._switching_view = True
        try:
            self._set_active_nav(view_name)
            renderer()
        finally:
            self._switching_view = False

    def action_view_projects(self) -> None:
        self._switch_view_safe("projects", self._render_projects)

    def action_view_news(self) -> None:
        self._switch_view_safe("news", self._render_news)

    def action_view_scheduler(self) -> None:
        self._switch_view_safe("scheduler", self._render_scheduler)

    def action_view_health(self) -> None:
        self._switch_view_safe("health", self._render_health)

    def action_open_recall(self) -> None:
        """Capital R → push RecallModal (interactive vault search)."""
        self.push_screen(RecallModal())

    def action_system_snapshot(self) -> None:
        """Re-collect snapshot then re-render System view."""
        self._refresh_snapshot()
        self._switch_view_safe("health", self._render_health)

    def action_system_validate(self) -> None:
        """Run end-to-end validator then surface its report on System."""
        self._run_validator()
        self._switch_view_safe("health", self._render_health)

    def action_system_reindex(self) -> None:
        """Incremental sync of both Qdrant collections then refresh view."""
        self._reindex_collections()
        self._refresh_snapshot()
        self._switch_view_safe("health", self._render_health)

    def _reindex_collections(self) -> None:
        """Run embed_vault index + embed_skills index. Best-effort; ~30-60s
        cold, <2s incremental warm. Notifies on completion."""
        import subprocess as _sp
        _SP_HIDDEN = _sp.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        venv_py = (
            Path.home() / ".claude" / "skills" / "ultron"
            / ".venv" / "Scripts" / "python.exe"
        )
        if not venv_py.exists():
            venv_py = Path(sys.executable)
        for script_name in ("embed_vault.py", "embed_skills.py"):
            script = COCKPIT_DIR / script_name
            if not script.exists():
                continue
            try:
                _sp.run(
                    [str(venv_py), str(script), "index"],
                    capture_output=True, text=True, timeout=120,
                    creationflags=_SP_HIDDEN,
                )
            except Exception:
                pass

    def action_view_mcps(self) -> None:
        self._switch_view_safe("mcps", self._render_mcps)

    def action_view_autoupdater(self) -> None:
        self._switch_view_safe("autoupdater", self._render_autoupdater)

    def action_view_changelog(self) -> None:
        self._switch_view_safe("changelog", self._render_changelog)

    def action_view_usage(self) -> None:
        self._switch_view_safe("usage", self._render_usage)

    def action_view_skills_market(self) -> None:
        self._switch_view_safe("skills-market", self._render_skills_market)

    def action_delete_project(self) -> None:
        proj = self._get_selected_project()
        if not proj:
            self.notify("Select a project first (1 view + arrows)", severity="warning")
            return
        self.push_screen(DeleteProjectModal(proj.get("id", "")))

    def action_kirkardo_audit(self) -> None:
        """k key — open Claude + copy Kirkardo audit prompt (full system audit)."""
        launch_with_prompt(
            "Ultron, /high kirkardo audit del sistema ULTRON hoy"
        )
        self.notify("💬 Prompt copiado: kirkardo audit ULTRON", severity="information")

    def action_session_gemini(self) -> None:
        """g key — spawn interactive Gemini session in current cwd."""
        proj = self._get_selected_project()
        cwd = proj.get("path") if proj else None
        open_in_terminal("gemini", cwd=cwd)
        self.notify("Gemini session abierta", severity="information")

    def action_session_codex(self) -> None:
        """x key — spawn interactive Codex session in current cwd."""
        proj = self._get_selected_project()
        cwd = proj.get("path") if proj else None
        open_in_terminal("codex", cwd=cwd)
        self.notify("Codex session abierta", severity="information")

    def action_new_skill(self) -> None:
        """n key — open Claude + copy new skill prompt."""
        launch_with_prompt("Ultron, /high crea una nueva skill llamada: ")
        self.notify("💬 Prompt copiado: crear skill nueva", severity="information")

    def _launch_audit(self, n: int) -> None:
        """Dispatch audit button N: load prompt from disk, copy to clipboard,
        open the configured CLI (claude/codex)."""
        if not (1 <= n <= len(AUDIT_BUTTONS)):
            return
        filename, label, _cost, cli = AUDIT_BUTTONS[n - 1]
        prompt = _load_audit_prompt(filename)
        if not prompt:
            self.notify(f"Prompt vacío o no encontrado: {filename}",
                         severity="error")
            return
        launch_with_prompt(prompt, cli=cli)
        self.notify(
            f"💬 Audit {n} · {label} → clipboard ({cli.upper()})",
            severity="information")

    # ── Renderers ────────────────────────────────────────────────────────────

    def _clear_content(self):
        """Remove all children synchronously to avoid DuplicateIds when re-rendering."""
        content = self.query_one("#content", ScrollableContainer)
        # remove_children() is synchronous and clears the ID registry properly
        try:
            content.remove_children()
        except Exception:
            for child in list(content.children):
                try:
                    child.remove()
                except Exception:
                    pass
        return content

    def _render_projects(self):
        content = self._clear_content()
        projects = load_projects()
        active = [p for p in projects if p.get("status") in ("active", "auto-detected", "manual")]

        # v10.6.2: sort by usage (samples last 7d) DESC, fall back to
        # last_active for projects with no activity yet. Matches the dashboard
        # rule and surfaces the projects USER actually touches.
        from collections import Counter as _Counter
        activity = load_activity(days=7)
        usage = _Counter(e.get("project_id") for e in activity
                         if e.get("project_id"))
        active.sort(
            key=lambda p: (
                usage.get(p.get("id", ""), 0),
                p.get("last_active") or "0000",
            ),
            reverse=True,
        )

        content.mount(Static(f"[b]Projects[/b] [dim]({len(active)} active of {len(projects)} total · sorted by usage 7d)[/dim]", classes="title"))
        content.mount(Static("[dim]Select with ↑↓, then 'o' open · 'c' claude · 'g' gemini · 'x' codex · 'k' kirkardo[/dim]", classes="subtitle"))

        table = DataTable(cursor_type="row", zebra_stripes=True)
        table.add_columns("ID", "Name", "IDE", "Use 7d", "Last Active", "Tags")
        for p in active[:40]:
            n = usage.get(p.get("id", ""), 0)
            table.add_row(
                p.get("id", "?"),
                p.get("name", "?")[:30],
                p.get("ide", "?"),
                str(n) if n else "·",
                p.get("last_active", "—"),
                ", ".join(dict.fromkeys(p.get("tags", []) + p.get("auto_tags", [])))[:30],
            )
        content.mount(table)

    def _render_news(self):
        """v10.6.3 News UX redesign: structured summary, no wall of text.

        Layout:
          1. Status line  — when generated · item counts · breaking count
          2. TL;DR (5 bullets from Gemini summarizer if present)
          3. Breaking changes (compact list, top 5)
          4. Top 10 highlights (curated from digest)
          5. Quick links to research + magazine + ALERTS files
          6. Action buttons
        """
        content = self._clear_content()
        today = datetime.now().strftime("%Y-%m-%d")
        trending_dir = NEWS_DIR.parent / "trending"
        digest_candidates = [
            NEWS_DIR / f"{today}.html",
            NEWS_DIR / f"{today}.md",
            trending_dir / f"{today}.md",
            NEWS_DIR / f"newsletter-{today}.html",
        ]
        digest = next((p for p in digest_candidates if p.exists()), digest_candidates[-1])
        research = (NEWS_DIR / f"research-{today}.html") if (NEWS_DIR / f"research-{today}.html").exists() \
                   else NEWS_DIR / f"research-{today}.md"
        football_html = NEWS_DIR / f"newsletter-{today}-football.html"
        space_html = NEWS_DIR / f"newsletter-{today}-space.html"

        # ── 1. Title + status line ─────────────────────────────────────────
        content.mount(Static("[b]⌬ News[/b]", classes="title"))

        # Parse digest for stats
        digest_text = ""
        try:
            if digest.exists():
                digest_text = digest.read_text(encoding="utf-8")
        except OSError:
            pass
        item_count = breaking_count = 0
        generated_str = ""
        tldr_block = ""
        breaking_lines: list[str] = []
        items_by_source: dict[str, list[str]] = {}
        if digest_text:
            import re as _re
            digest_is_html = digest.suffix == ".html" and "<html" in digest_text[:200].lower()
            if digest_is_html:
                # Parse newsletter HTML: <h2 class="section-title"> sections + <h3> card headlines
                item_count = len(_re.findall(r'<div class="card">', digest_text))
                generated_str = today
                # Hero headline as TL;DR
                hero_m = _re.search(
                    r'class="hero"[^>]*>.*?<h2[^>]*>([^<]+)</h2>.*?<p[^>]*>([^<]+)</p>',
                    digest_text, _re.DOTALL,
                )
                if hero_m:
                    hero_title = hero_m.group(1).strip()
                    hero_desc = hero_m.group(2).strip()[:120]
                    tldr_block = f"- {hero_title} — {hero_desc}"
                # Per-section card headlines
                for sec_m in _re.finditer(
                    r'<h2[^>]*class="section-title"[^>]*>([^<]+)</h2>', digest_text
                ):
                    sec_title = sec_m.group(1).strip()
                    sec_start = sec_m.end()
                    next_sec = _re.search(r'<h2[^>]*class="section-title"', digest_text[sec_start:])
                    sec_end = sec_start + next_sec.start() if next_sec else len(digest_text)
                    sec_html = digest_text[sec_start:sec_end]
                    items = [f"- {h.group(1).strip()}"
                             for h in _re.finditer(r'<h3[^>]*>([^<]+)</h3>', sec_html)]
                    if items:
                        items_by_source[sec_title] = items[:2]
            else:
                # Legacy markdown digest format
                # Header: "_Generated 2026-04-28T10:34 | 25 items | 0 new since last run_"
                m = _re.search(r"Generated\s+(\S+)\s*\|\s*(\d+)\s*items?\s*\|\s*(\d+)\s*new", digest_text)
                if m:
                    generated_str = m.group(1)
                    item_count = int(m.group(2))
                # Pull TL;DR section if present (also accept Hot Today as fallback)
                tldr_match = _re.search(
                    r"##\s*TL;DR\s*\n\n((?:- .+\n?)+)",
                    digest_text,
                )
                if not tldr_match:
                    tldr_match = _re.search(
                        r"##\s*Hot Today\s*\n\n((?:- .+\n?)+)",
                        digest_text,
                    )
                if tldr_match:
                    tldr_block = tldr_match.group(1).strip()
                # Pull breaking changes lines
                br_section = _re.search(
                    r"##\s*Breaking changes\s*\n\n((?:- .+\n?)+)",
                    digest_text,
                )
                if br_section:
                    breaking_lines = [
                        ln for ln in br_section.group(1).splitlines() if ln.startswith("- ")
                    ]
                    breaking_count = len(breaking_lines)
                # Per-source highlights (top 1-2 per source)
                for src_match in _re.finditer(
                    r"###\s*([^\n]+)\n((?:- .+\n?)+)", digest_text
                ):
                    src = src_match.group(1).strip()
                    lines = [ln for ln in src_match.group(2).splitlines()
                             if ln.startswith("- ")]
                    if lines:
                        items_by_source[src] = lines[:2]

        # Status line
        alerts_count = 0
        alerts_lines: list[str] = []
        try:
            if NEWS_ALERTS.exists():
                raw = NEWS_ALERTS.read_text(encoding="utf-8", errors="replace")
                alerts_lines = [ln for ln in raw.splitlines() if ln.startswith("- ")]
                alerts_count = len(alerts_lines)
        except OSError:
            pass
        status_parts = []
        if generated_str:
            status_parts.append(f"[#9eca7e]●[/#9eca7e] {_markup_escape(generated_str[:16])}")
        else:
            status_parts.append("[#d77878]●[/#d77878] no digest today")
        status_parts.append(f"{item_count} items")
        if breaking_count:
            status_parts.append(f"[#e0a868]⚠ {breaking_count} breaking[/#e0a868]")
        if alerts_count:
            status_parts.append(f"[#d77878]🚨 {alerts_count} alerts pending[/#d77878]")
        if research.exists():
            status_parts.append("[#8aa8a0]🔬 research today[/#8aa8a0]")
        content.mount(Static("  ·  ".join(status_parts), classes="subtitle"))

        # ── 2. TL;DR ───────────────────────────────────────────────────────
        content.mount(Static(""))
        if tldr_block:
            content.mount(Static("[b #ffd089]Hot Today[/b #ffd089]"))
            # Render top 5 items with veracidad scores extracted
            for ln in tldr_block.splitlines()[:5]:
                if not ln.startswith("- "):
                    continue
                ver_m = _re.search(r'_\(veracidad:\s*(\d+)/10\)_', ln)
                ver_str = ""
                if ver_m:
                    v = int(ver_m.group(1))
                    color = "#9eca7e" if v >= 8 else "#e0a868" if v >= 6 else "#d77878"
                    ver_str = f" [{color}]v{v}[/{color}]"
                    ln = _re.sub(r'\s*_\(veracidad:[^)]+\)_', '', ln)
                clean = _re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', ln[2:]).strip()
                clean = _re.sub(r'\*\*\[([^\]]+)\]\*\*\s*', r'[\1] ', clean)
                clean = clean.replace('🆕', '').strip()
                content.mount(Static(f"  {_markup_escape(clean[:105])}{ver_str}"))
        else:
            content.mount(Static("[dim]Sin noticias hoy — presiona '⟳ Refresh now' "
                                  "para obtener el digest de hoy.[/dim]", classes="muted"))

        # ── 3. Breaking changes (compact) ──────────────────────────────────
        if breaking_lines:
            content.mount(Static(""))
            content.mount(Static(f"[b red]⚠ Breaking ({len(breaking_lines)})[/b red]"))
            for ln in breaking_lines[:5]:
                # Extract veracidad, strip markdown
                ver_m = _re.search(r'_\(veracidad:\s*(\d+)/10\)_', ln)
                ver_str = f" [#8aa8a0](v{ver_m.group(1)})[/#8aa8a0]" if ver_m else ""
                clean = _re.sub(r'\s*_\(veracidad:[^)]+\)_', '', ln[2:])
                clean = _re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', clean)
                clean = _re.sub(r'\*\*(.+?)\*\*', r'\1', clean).strip()
                content.mount(Static(f"  {_markup_escape(clean[:100])}{ver_str}"))
            if len(breaking_lines) > 5:
                content.mount(Static(
                    f"  [dim]+{len(breaking_lines)-5} more in ALERTS log[/dim]",
                    classes="muted"))

        # ── 3b. ALERTS inline (security/system alerts from news pipeline) ────
        if alerts_lines:
            import re as _re  # noqa: F811 — may already be imported above
            try:
                from news_alerts import status as _alerts_status
                _astat = _alerts_status()
                _stale = _astat.get("stale", 0)
            except Exception:
                _stale = 0
            content.mount(Static(""))
            content.mount(Static(f"[b red]🚨 ALERTS ({len(alerts_lines)})[/b red]"))
            for ln in alerts_lines[:5]:
                clean = _re.sub(r'\*\*([^*]+)\*\*', r'\1', ln[2:]).strip()
                clean = _re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', clean)
                content.mount(Static(f"  [#d77878]{_markup_escape(clean[:110])}[/#d77878]"))
            if len(alerts_lines) > 5:
                content.mount(Static(f"  [dim]+{len(alerts_lines)-5} más en ALERTS.md[/dim]",
                                      classes="muted"))
            # Lifecycle buttons
            if _stale > 0:
                content.mount(Button(
                    f"🧹 Purgar {_stale} alertas viejas (>7d) → archivo",
                    id="news-alerts-purge", variant="warning"))
            content.mount(Button(
                "📦 Archivar todo y limpiar ALERTS.md",
                id="news-alerts-clear", variant="default"))

        # ── 4. Top items per source (compact, no wall of text) ─────────────
        if items_by_source:
            content.mount(Static(""))
            content.mount(Static("[b]Top items per source[/b]"))
            for src, lines in list(items_by_source.items())[:6]:
                content.mount(Static(f"[#8aa8a0]› {_markup_escape(src)}[/#8aa8a0]"))
                for ln in lines:
                    # Extract veracidad score if present: _(veracidad: 7/10)_
                    ver_m = _re.search(r'_\(veracidad:\s*(\d+)/10\)_', ln)
                    ver_str = ""
                    if ver_m:
                        v = int(ver_m.group(1))
                        color = "#9eca7e" if v >= 8 else "#e0a868" if v >= 6 else "#d77878"
                        ver_str = f" [{color}]v{v}[/{color}]"
                        ln = _re.sub(r'\s*_\(veracidad:[^)]+\)_', '', ln)
                    # Strip markdown links [Title](URL) → Title
                    clean = _re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', ln[2:]).strip()
                    # Strip **[Source]** prefix (already shown in header)
                    clean = _re.sub(r'^\*\*\[[^\]]+\]\*\*\s*', '', clean).strip()
                    # Strip 🆕 badges
                    clean = clean.replace('🆕', '').strip()
                    content.mount(Static(f"  {_markup_escape(clean[:100])}{ver_str}"))

        # Research section removed — content integrated into newsletter prompt (v12.2)

        # ── 6. Editions status + generate buttons ──────────────────────────
        content.mount(Static(""))
        content.mount(Static("[b]Ediciones de hoy[/b]"))
        content.mount(Static("[dim]💬 = copia prompt al portapapeles y abre terminal Gemini[/dim]",
                              classes="muted"))
        _EDITIONS = [
            (NEWS_DIR / f"newsletter-{today}.html", "📰 Tech/AI", "news-create-newsletter"),
        ]
        for ed_path, ed_label, ed_btn_id in _EDITIONS:
            if ed_path.exists():
                age_h = (datetime.now().timestamp() - ed_path.stat().st_mtime) / 3600
                content.mount(Static(
                    f"  [#9eca7e]✓ {ed_label}[/#9eca7e]  "
                    f"[dim]{age_h:.1f}h ago · {ed_path.stat().st_size // 1024}KB[/dim]"))
            else:
                content.mount(Button(f"💬 Generar {ed_label} → Gemini",
                                      id=ed_btn_id, variant="primary"))

        # ── 7. Historic archive list (más reciente arriba) ────────────────
        content.mount(Static(""))
        content.mount(Static("[b #ffd089]▌ Archive — clicka para abrir[/b #ffd089]"))
        archive: list[tuple[float, Path, str]] = []  # (mtime, path, label)
        for f in NEWS_DIR.glob("newsletter-*.html"):
            archive.append((f.stat().st_mtime, f, "Newsletter"))
        for f in NEWS_DIR.glob("research-*.html"):
            archive.append((f.stat().st_mtime, f, "Research"))
        if trending_dir.exists():
            for f in trending_dir.glob("*.md"):
                archive.append((f.stat().st_mtime, f, "Trending"))
        archive.sort(reverse=True)
        if not archive:
            content.mount(Static("[dim]Archive vacío[/dim]", classes="muted"))
        else:
            for i, (mt, fpath, label) in enumerate(archive[:15]):
                age_days = (datetime.now().timestamp() - mt) / 86400
                age_str = (f"{age_days:.0f}d" if age_days >= 1
                            else f"{age_days * 24:.1f}h")
                size_kb = fpath.stat().st_size / 1024
                btn_label = (f"[{label}] {fpath.stem}  · {age_str} ago "
                              f"· {size_kb:.0f}KB")
                content.mount(Button(btn_label,
                                      id=f"archive-open-{i}",
                                      variant="default"))
        # Stash the archive list so the button handler can resolve i → path
        self._news_archive = [str(p) for _, p, _ in archive[:15]]

    def _do_create_newsletter(self) -> None:
        try:
            prompt = build_newsletter_prompt("tech")
        except (FileNotFoundError, KeyError) as exc:
            self.notify(f"Newsletter template error: {exc}", severity="error")
            return
        launch_with_prompt(prompt, cli="gemini")
        self.notify("💬 Newsletter Tech/AI → Gemini", severity="information")

    def _do_alerts_purge(self) -> None:
        """Move alerts older than NEWS_ALERTS_TTL_DAYS to archive."""
        try:
            from news_alerts import purge_stale
            purged, kept = purge_stale()
        except Exception as exc:
            self.notify(f"Purge alerts failed: {exc}", severity="error")
            return
        if purged:
            self.notify(f"🧹 {purged} alertas viejas archivadas · {kept} activas",
                         severity="information")
            self._switch_view_safe("news", self._render_news)
        else:
            self.notify("Sin alertas viejas para purgar", severity="information")

    def _do_alerts_clear(self) -> None:
        """Archive everything and wipe ALERTS.md."""
        try:
            from news_alerts import archive_then_clear
            n = archive_then_clear()
        except Exception as exc:
            self.notify(f"Clear alerts failed: {exc}", severity="error")
            return
        self.notify(f"📦 {n} sección(es) archivadas · ALERTS.md limpio",
                     severity="information")
        self._switch_view_safe("news", self._render_news)

    def _render_skills_market(self):
        """f key — Skills view (v12 Brain Update): categorized by layer.

        Layer 0 — Meta orchestrators (ultron, skill-creator, consolidate-memory, mcp-builder)
        Layer 1 — Personalidades (14 specialists)
        Layer 2 — Subskills agrupadas (engineering · security · testing · ui · game · workflow · misc)
        """
        content = self._clear_content()
        content.mount(Static("[b]⬡ Skills Map[/b]", classes="title"))
        content.mount(Static("[dim]Layer 0 Meta · Layer 1 Personalidades · Layer 2 Subskills[/dim]",
                              classes="subtitle"))

        # ── Categorías canónicas (v12) ───────────────────────────────────────
        LAYER0_META = {"ultron", "skill-creator", "consolidate-memory", "mcp-builder"}
        LAYER1_PERSONAS = {
            "terry-davis", "gamedev-engineer", "mike-tyson", "jordan-belfort", "einstein",
            "novalbos", "personal-assistant", "windows-admin", "profesor-fisica", "tio-gilito", "warren",
            "repo-evaluator", "manolo-lama", "tolkien",
            # backwards-compat aliases (deprecated stubs)
            "don-claudio", "pana", "alfred",
        }
        LAYER2_CATEGORIES = {
            "Engineering": {"focused-fix", "performance-profiler", "tech-debt-tracker",
                            "api-design-reviewer", "modern-python", "ask-questions-first"},
            "Security":    {"differential-review", "sharp-edges", "insecure-defaults",
                            "supply-chain-risk-auditor", "security-review",
                            "audit-context-building", "variant-analysis", "trailmark"},
            "Testing":     {"property-based-testing", "mutation-testing", "webapp-testing",
                            "spec-to-code-compliance"},
            "Database/API":{"database-schema-designer", "dimensional-analysis"},
            "UI/Design":   {"frontend-design", "ui-ux-pro-max", "theme-factory", "mike-tyson"},
            "Game":        {"ue5-dev", "unreal-engine"},
            "AI Platform": {"claude-api", "second-opinion", "skill-improver", "news-publisher"},
            # v12 FASE D: Workflow plugins (namespaced — always available in Claude Code,
            # not installed locally under ~/.claude/skills/).
            "Workflow":    {"superpowers:systematic-debugging",
                            "superpowers:test-driven-development",
                            "superpowers:writing-plans",
                            "superpowers:executing-plans",
                            "pr-review-toolkit:review-pr",
                            "feature-dev:feature-dev",
                            "commit-commands:commit",
                            "code-review:code-review",
                            "skill-creator:skill-creator"},
        }

        skills_dir = Path.home() / ".claude" / "skills"
        installed: set[str] = set()
        if skills_dir.exists():
            installed = {
                d.name for d in skills_dir.iterdir()
                if d.is_dir() and (d / "SKILL.md").exists()
            }

        # ── Registry drift indicator ─────────────────────────────────────────
        _meta = {".git", ".system", ".claude", "__pycache__"}
        def _scan_reg(p: Path) -> set[str]:
            if not p.exists():
                return set()
            return {d.name for d in p.iterdir()
                    if d.is_dir() and d.name not in _meta and not d.name.startswith(".")}
        _claude_set  = _scan_reg(Path.home() / ".claude"  / "skills")
        _codex_set   = _scan_reg(Path.home() / ".codex"   / "skills")
        _agents_set  = _scan_reg(Path.home() / ".agents"  / "skills")
        _missing_codex  = len(_claude_set - _codex_set)
        _missing_agents = len(_claude_set - _agents_set)
        _pending_count  = len(list((Path.home() / ".ultron" / "pending-sync").glob("*.json"))) \
                          if (Path.home() / ".ultron" / "pending-sync").exists() else 0
        if _missing_codex or _missing_agents or _pending_count:
            _drift_msg = (
                f"[yellow]⚠ Drift:[/yellow]  "
                + (f"Codex missing {_missing_codex}  " if _missing_codex else "")
                + (f"Agents missing {_missing_agents}  " if _missing_agents else "")
                + (f"Pending {_pending_count}" if _pending_count else "")
            )
        else:
            _drift_msg = "[#9eca7e]✓ All registries in sync[/#9eca7e]"
        content.mount(Static(_drift_msg))
        content.mount(Button("🔄 Sync registries now", id="skills-registry-sync", variant="warning"
                             if (_missing_codex or _missing_agents or _pending_count) else "default"))

        def _is_present(name: str) -> bool:
            # Namespaced plugins (foo:bar) are always available in Claude Code,
            # they don't live under ~/.claude/skills/ as a local directory.
            return (":" in name) or (name in installed)

        def _fmt_skill(name: str) -> str:
            if ":" in name:
                return (f"[#7090b8]◆[/#7090b8] [cyan]{_markup_escape(name)}[/cyan] "
                        f"[dim](plugin)[/dim]")
            mark = "[#9eca7e]✓[/#9eca7e]" if name in installed else "[#666666]·[/#666666]"
            return f"{mark} [cyan]{_markup_escape(name)}[/cyan]"

        # ── Layer 0 — Meta ───────────────────────────────────────────────────
        content.mount(Static(""))
        l0_present = sorted(LAYER0_META & installed)
        l0_missing = sorted(LAYER0_META - installed)
        content.mount(Static(
            f"[b #ffd089]▌ Layer 0 — Meta ({len(l0_present)}/{len(LAYER0_META)})[/b #ffd089]"))
        for name in sorted(LAYER0_META):
            content.mount(Static(f"  {_fmt_skill(name)}"))

        # ── Layer 1 — Personalidades ─────────────────────────────────────────
        content.mount(Static(""))
        l1_present = sorted(LAYER1_PERSONAS & installed)
        content.mount(Static(
            f"[b #e0a868]▌ Layer 1 — Personalidades ({len(l1_present)}/{len(LAYER1_PERSONAS)})[/b #e0a868]"))
        # 2-column layout for personas
        sorted_personas = sorted(LAYER1_PERSONAS)
        for i in range(0, len(sorted_personas), 2):
            row = sorted_personas[i:i+2]
            cells = "  ".join(f"{_fmt_skill(n):<35}" for n in row)
            content.mount(Static(f"  {cells}"))

        # ── Layer 2 — Subskills por categoría ────────────────────────────────
        content.mount(Static(""))
        l2_categorized = set()
        for cat_skills in LAYER2_CATEGORIES.values():
            l2_categorized |= cat_skills
        l2_present_count = sum(1 for s in l2_categorized if _is_present(s))
        content.mount(Static(
            f"[b #8aa8a0]▌ Layer 2 — Subskills ({l2_present_count}/{len(l2_categorized)})[/b #8aa8a0]"))
        for cat_name, cat_skills in LAYER2_CATEGORIES.items():
            present_in_cat = sum(1 for s in cat_skills if _is_present(s))
            total_in_cat = len(cat_skills)
            content.mount(Static(
                f"  [#a0a0a0]{cat_name}[/#a0a0a0] [dim]({present_in_cat}/{total_in_cat})[/dim]"))
            for name in sorted(cat_skills):
                content.mount(Static(f"    {_fmt_skill(name)}"))

        # ── Layer 3 — Biblioteca (comunidad / uso esporádico) ────────────────
        LAYER3_CATEGORIES = {
            "Backend / Systems": {
                "backend-developer", "cli-developer", "cpp-pro", "csharp-developer",
                "django-developer", "dotnet-core-expert", "dotnet-framework-4.8-expert",
                "dwarf-expert", "elixir-expert", "embedded-systems", "fastapi-developer",
                "fintech-engineer", "golang-pro", "iot-engineer", "java-architect",
                "laravel-specialist", "legacy-modernizer", "microservices-architect",
                "payment-integration", "php-pro", "powershell-5.1-expert",
                "powershell-7-expert", "powershell-module-architect",
                "powershell-ui-architect", "prisma-expert", "python-pro",
                "rails-expert", "rust-engineer", "spring-boot-engineer",
                "symfony-specialist",
            },
            "Frontend / Mobile": {
                "android-kotlin", "angular-architect", "d3js-skill", "design-bridge",
                "electron-pro", "expo-react-native-expert", "flutter-expert",
                "frontend-developer", "fullstack-developer", "graphql-architect",
                "ios-simulator-skill", "javascript-pro", "kotlin-specialist",
                "material-3-expert", "mobile-app-developer", "mobile-developer",
                "nextjs-developer", "node-specialist", "parallel-web",
                "playwright-skill", "react-native-perf", "react-specialist",
                "seo-specialist", "shader-fundamentals", "swift-expert",
                "typescript-pro", "ui-designer", "ui-ux-tester", "ux-researcher",
                "vue-expert", "web-artifacts-builder", "web-asset-generator",
                "websocket-engineer", "wordpress-master",
            },
            "DevOps / Cloud": {
                "azure-infra-engineer", "build-engineer", "chaos-engineer",
                "ci-cd-debugger", "cloud-architect", "dependency-manager",
                "deployment-engineer", "devcontainer-setup", "devops-engineer",
                "devops-incident-responder", "docker-expert", "dockerfile-linter",
                "github-actions", "incident-responder", "it-ops-orchestrator",
                "kubernetes-specialist", "m365-admin", "network-engineer",
                "platform-engineer", "sre-engineer", "terraform-engineer",
                "terragrunt-expert", "windows-infra-admin",
            },
            "Data / ML": {
                "ai-engineer", "data-analyst", "data-engineer", "data-researcher",
                "data-scientist", "database-administrator", "database-lookup",
                "database-optimizer", "dask", "db-migration-safety",
                "exploratory-data-analysis", "hugging-science",
                "machine-learning-engineer", "matplotlib", "ml-engineer",
                "mlops-engineer", "nlp-engineer", "optimize-for-gpu", "polars",
                "postgres-pro", "pytorch-lightning", "quant-analyst",
                "reinforcement-learning-engineer", "scikit-learn", "sql-pro",
                "supabase", "supabase-postgres",
            },
            "Scientific / Bio": {
                "adaptyv", "aeon", "anndata", "arboreto", "astropy",
                "benchling-integration", "bgpt-paper-search", "biopython",
                "bioservices", "cellxgene-census", "cirq", "cobrapy", "datamol",
                "deepchem", "deeptools", "depmap", "dhdna-profiler", "diffdock",
                "dnanexus-integration", "esm", "etetoolkit", "flowio", "fluidsim",
                "geniml", "geomaster", "geopandas", "gget", "ginkgo-cloud-lab",
                "glycoengineering", "gtars", "histolab", "imaging-data-commons",
                "labarchive-integration", "lamindb", "latchbio-integration",
                "matchms", "matlab", "medchem", "molecular-dynamics", "molfeat",
                "neurokit2", "neuropixels-analysis", "networkx", "omero-integration",
                "open-notebook", "opentrons-integration", "pathml", "pennylane",
                "phylogenetics", "polars-bio", "primekg", "protocolsio-integration",
                "pufferlib", "pydeseq2", "pydicom", "pyhealth", "pylabrobot",
                "pymatgen", "pymc", "pymoo", "pyopenms", "pysam", "pytdc",
                "qiskit", "qutip", "rdkit", "rowan", "scanpy", "scikit-bio",
                "scikit-survival", "scvelo", "scvi-tools",
            },
            "AI / Agents": {
                "agentic-actions-auditor", "agent-installer", "agent-organizer",
                "ai-writing-auditor", "antivibe", "claude-in-chrome-troubleshooting",
                "claude-skills", "codebase-orchestrator", "consciousness-council",
                "context-manager", "designing-workflow-skills", "error-coordinator",
                "everything-claude-code", "generate-image", "get-available-resources",
                "hyperframes", "knowledge-synthesizer", "let-fate-decide",
                "llm-architect", "loki-mode", "mcp-developer", "modal",
                "multi-agent-coordinator", "prompt-engineer", "shannon",
                "skill-seekers", "superpowers", "task-distributor",
                "workflow-orchestrator",
            },
            "Security / Pen-test": {
                "accessibility-tester", "ad-security-reviewer",
                "burpsuite-project-parser", "compliance-auditor",
                "constant-time-analysis", "ffuf-skill", "firebase-apk-scanner",
                "iso-13485-certification", "license-engineer", "penetration-tester",
                "powershell-security-hardening", "seatbelt-sandboxer",
                "secure-workflow-guide", "security-auditor", "security-engineer",
                "semgrep-rule-creator", "semgrep-rule-variant-creator",
                "yara-rule-authoring",
            },
            "Blockchain / Crypto": {
                "algorand-vulnerability-scanner", "blockchain-developer",
                "cairo-vulnerability-scanner", "cosmos-vulnerability-scanner",
                "solana-vulnerability-scanner", "substrate-vulnerability-scanner",
                "token-integration-analyzer", "ton-vulnerability-scanner",
                "zeroize-audit",
            },
            "Code Quality": {
                "api-designer", "api-documenter", "architect-reviewer",
                "ask-questions-if-underspecified", "code-maturity-assessor",
                "code-reviewer", "code-review-excellence", "debug-buttercup",
                "debugger", "developer-first", "documentation-engineer",
                "entry-point-analyzer", "error-detective", "fp-check",
                "git-cleanup", "git-conflict-resolver", "git-workflow-manager",
                "openapi-validator", "performance-engineer", "performance-monitor",
                "qa-expert", "readme-generator", "refactoring-specialist",
                "test-automator", "testing-handbook-generator", "tooling-engineer",
            },
            "Research / Writing": {
                "audit-prep-assistant", "citation-management",
                "clinical-decision-support", "clinical-reports",
                "hypothesis-generation", "hypogenic", "literature-review",
                "paper-lookup", "paperzilla", "peer-review", "pyzotero",
                "research-analyst", "research-grants", "research-lookup",
                "scholar-evaluation", "scientific-brainstorming",
                "scientific-critical-thinking", "scientific-literature-researcher",
                "scientific-schematics", "scientific-visualization",
                "scientific-writing",
            },
            "Productivity / Biz": {
                "brand-guidelines", "business-analyst", "competitive-analyst",
                "content-marketer", "customer-success-manager", "dx-optimizer",
                "guidelines-advisor", "healthcare-admin", "internal-comms",
                "interpreting-culture-index", "legal-advisor", "market-researcher",
                "market-research-reports", "product-manager", "project-idea-validator",
                "project-manager", "risk-manager", "sales-engineer", "scrum-master",
                "search-specialist", "slack-expert", "slack-gif-creator",
                "technical-writer", "trend-analyst",
            },
            "Documents / Media": {
                "algorithmic-art", "canvas-design", "doc-coauthoring", "docx",
                "frontend-slides", "infographics", "latex-posters",
                "markdown-mermaid-writing", "markitdown", "pdf", "pptx",
                "pptx-posters", "scientific-slides", "xlsx",
            },
            "Game Dev": {
                "game-developer",
            },
        }

        l3_categorized: set[str] = set()
        for cat_skills in LAYER3_CATEGORIES.values():
            l3_categorized |= cat_skills
        l3_present_count = sum(1 for s in l3_categorized if _is_present(s))

        content.mount(Static(""))
        content.mount(Static(
            f"[b #6b7a8d]▌ Layer 3 — Biblioteca ({l3_present_count}/{len(l3_categorized)})[/b #6b7a8d]"))
        for cat_name, cat_skills in LAYER3_CATEGORIES.items():
            installed_in_cat = sorted(s for s in cat_skills if _is_present(s))
            if not installed_in_cat:
                continue
            content.mount(Static(
                f"  [#808080]{cat_name}[/#808080]"
                f" [dim]({len(installed_in_cat)}/{len(cat_skills)})[/dim]"))
            for i in range(0, len(installed_in_cat), 4):
                row = installed_in_cat[i:i+4]
                content.mount(Static(
                    "    " + "  ·  ".join(
                        f"[#9eca7e]{_markup_escape(s)}[/#9eca7e]" for s in row)))

        # ── Sin categorizar (truly uncategorized) ────────────────────────────
        all_known = LAYER0_META | LAYER1_PERSONAS | l2_categorized | l3_categorized
        truly_uncategorized = sorted(installed - all_known)
        if truly_uncategorized:
            content.mount(Static(""))
            content.mount(Static(
                f"[b #666666]▌ Sin categorizar ({len(truly_uncategorized)})[/b #666666]"))
            chunks = [truly_uncategorized[i:i+4] for i in range(0, len(truly_uncategorized), 4)]
            for chunk in chunks[:5]:
                content.mount(Static("  " + "  ·  ".join(
                    f"[#888888]{_markup_escape(s)}[/#888888]" for s in chunk)))
            if len(chunks) > 5:
                content.mount(Static(
                    f"  [dim]+{len(truly_uncategorized) - 20} más...[/dim]", classes="muted"))

        # ── Acciones (clipboard prompts) ────────────────────────────────────
        content.mount(Static(""))
        content.mount(Static("[b]Acciones:[/b]", classes="title"))
        content.mount(Static("[dim]💬 = copia prompt al portapapeles y abre terminal del AI indicado[/dim]",
                              classes="muted"))
        content.mount(Static(""))
        content.mount(Button("💬 Buscar Skills en GitHub",
                              id="skills-search-github", variant="default"))
        content.mount(Button("💬 Buscar Skills en GitHub (Codex)",
                              id="skills-search-codex", variant="default"))
        content.mount(Button("💬 Buscar Skills y ADD-ONS de Gemini",
                              id="skills-search-gemini", variant="primary"))
        content.mount(Static(""))
        content.mount(Button("🔄 Sincronizar skills",
                              id="skills-registry-sync-prompt", variant="warning"))
        content.mount(Button("⬆ Actualizar todas las Skills",
                              id="skills-update-all", variant="default"))
        content.mount(Button("✚ Crear nueva skill",
                              id="skills-create", variant="success"))

    @work(thread=True)
    def _do_discover_skills_gemini(self) -> None:
        """Ask Gemini 3.1 to find top community Claude Code skills, save to registry."""
        import shutil as _shutil
        import subprocess as _subprocess
        import json as _json
        self.app.call_from_thread(
            lambda: self.notify("Preguntando a Gemini por las mejores community skills...",
                                severity="information"))

        gemini_bin = _shutil.which("gemini")
        if not gemini_bin:
            self.app.call_from_thread(
                lambda: self.notify("gemini CLI no encontrado en PATH", severity="error"))
            return

        instruction = (
            "Eres un experto en Claude Code y su ecosistema de skills.\n"
            "Busca en internet y dame las TOP 10 community skills de Claude Code disponibles en GitHub.\n"
            "Para cada skill incluye:\n"
            "- nombre (slug kebab-case)\n"
            "- descripción en 1 línea\n"
            "- URL raw de SKILL.md en GitHub\n\n"
            "Responde SOLO con JSON válido, sin texto adicional, con este schema:\n"
            '{\"skills\": [{\"name\": \"skill-name\", \"description\": \"...\", '
            '\"raw_url\": \"https://...\", \"repo\": \"user/repo\"}]}'
        )

        try:
            r = _subprocess.run(
                [gemini_bin, "--approval-mode", "plan", "-m", "gemini-2.5-pro",
                 "-p", instruction],
                capture_output=True, text=True, timeout=120, encoding="utf-8",
            )
            output = (r.stdout or "").strip()
        except _subprocess.TimeoutExpired:
            self.app.call_from_thread(
                lambda: self.notify("Gemini timeout (120s)", severity="error"))
            return
        except Exception as e:
            msg = f"Error Gemini: {e}"
            self.app.call_from_thread(lambda m=msg: self.notify(m, severity="error"))
            return

        skills: list[dict] = []
        try:
            import re as _re
            json_match = _re.search(r'\{[\s\S]*\}', output)
            if json_match:
                data = _json.loads(json_match.group())
                skills = data.get("skills", [])
        except Exception:
            pass

        if not skills:
            raw_path = COCKPIT_DIR / "skills-gemini-raw.txt"
            raw_path.write_text(output or "(no output)", encoding="utf-8")
            self.app.call_from_thread(
                lambda: self.notify(
                    "Gemini sin JSON parseable — guardado en skills-gemini-raw.txt",
                    severity="warning"))
            return

        COCKPIT_DIR.mkdir(parents=True, exist_ok=True)
        registry_path = COCKPIT_DIR / "skills-registry.json"
        existing: dict = {"skills": []}
        try:
            if registry_path.exists():
                existing = _json.loads(registry_path.read_text(encoding="utf-8"))
        except Exception:
            pass
        existing_names = {s.get("name") for s in existing.get("skills", [])}
        new_to_install: list[dict] = []
        for sk in skills:
            if sk.get("name") and sk["name"] not in existing_names:
                sk["source"] = sk.get("repo", "gemini-discovery")
                sk["discovered"] = datetime.now().strftime("%Y-%m-%d")
                existing["skills"].append(sk)
                existing_names.add(sk["name"])
                if sk.get("raw_url"):
                    new_to_install.append(sk)
        existing["last_updated"] = datetime.now().isoformat()
        registry_path.write_text(
            _json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")

        count = len(skills)
        # AUTO-INSTALL: download SKILL.md for each newly-discovered skill that
        # has a raw_url. Then run brain_index update so the new skills are
        # immediately queryable. One-click discovery → install → register.
        installed = self._auto_install_skills(new_to_install)
        if installed:
            self._auto_register_skills_in_brain()

        msg = (f"Gemini encontró {count} skills — instaladas {installed}, "
                "registradas en BRAIN")
        self.app.call_from_thread(lambda m=msg: self.notify(m, severity="information"))
        self.app.call_from_thread(self._async_rerender_skills_market)

    def _auto_install_skills(self, skills: list[dict]) -> int:
        """Download SKILL.md for each entry that has a raw_url. Skips already-
        installed skills. Returns count installed.

        Refuses URLs that aren't https://raw.githubusercontent.com/* to avoid
        accidentally writing arbitrary content from a hostile prompt response.
        """
        if not skills:
            return 0
        import urllib.request as _urlreq
        import urllib.error as _urlerr
        skills_root = Path.home() / ".claude" / "skills"
        skills_root.mkdir(parents=True, exist_ok=True)
        installed = 0
        for sk in skills:
            name = sk.get("name", "").strip()
            url = sk.get("raw_url", "").strip()
            if not name or not url:
                continue
            # Defensive: only allow GitHub raw URLs.
            if not url.startswith("https://raw.githubusercontent.com/"):
                continue
            target_dir = skills_root / name
            target_md = target_dir / "SKILL.md"
            if target_md.exists():
                continue
            try:
                req = _urlreq.Request(url, headers={"User-Agent": "ULTRON-cockpit"})
                with _urlreq.urlopen(req, timeout=20) as resp:
                    body = resp.read().decode("utf-8", errors="replace")
            except (_urlerr.URLError, OSError, ValueError):
                continue
            if len(body) < 50 or "name:" not in body[:500].lower():
                # Sanity: SKILL.md must have at least a frontmatter name field
                continue
            target_dir.mkdir(parents=True, exist_ok=True)
            try:
                target_md.write_text(body, encoding="utf-8")
                installed += 1
            except OSError:
                pass
        return installed

    def _auto_register_skills_in_brain(self) -> None:
        """Run brain_index update so newly-installed skills become queryable."""
        import subprocess as _sp
        skill_root = Path.home() / ".ultron"
        brain_py = skill_root / "scripts" / "cockpit" / "brain_index.py"
        if not brain_py.exists():
            return
        try:
            _sp.run(
                ["uv", "run", "python", str(brain_py), "update"],
                capture_output=True, text=True, timeout=60,
            )
        except FileNotFoundError:
            try:
                _sp.run(
                    ["python", str(brain_py), "update"],
                    capture_output=True, text=True, timeout=60,
                )
            except Exception:
                pass
        except Exception:
            pass


    def _do_times_premium(self) -> None:
        """ULTRON Times premium: launches news_html_generator.py in a new
        terminal, which itself spawns a Gemini interactive session + holds
        the prompt on clipboard. Used to leverage gemini-3.1-pro (works in
        interactive sessions but fails headless with 429)."""
        skill_root = Path.home() / ".ultron"
        gen_py = skill_root / "scripts" / "cockpit" / "news_html_generator.py"
        if not gen_py.exists():
            self.notify(f"news_html_generator.py not found: {gen_py}",
                         severity="error")
            return
        cmd = f'uv run python "{gen_py}"'
        try:
            open_in_terminal(cmd, cwd=str(skill_root))
            self.notify("⌬ ULTRON Times — terminal abierto. Pega el HTML cuando Gemini "
                         "termine; el receiver lo procesa + abre browser.",
                         severity="information")
        except Exception as e:
            self.notify(f"No pude lanzar terminal: {e}", severity="error")

    def _do_run_research(self) -> None:
        today = datetime.now().strftime("%Y-%m-%d")
        prompt = (
            f"Genera el reporte de investigación semanal ULTRON para hoy {today}.\n\n"
            "Investiga en profundidad las novedades de esta semana en AI/dev:\n"
            "- Nuevos modelos y capacidades (benchmarks, precios, límites)\n"
            "- Cambios en APIs y tooling (Claude, OpenAI, Gemini, Codex, Cursor)\n"
            "- Papers relevantes y avances de investigación\n"
            "- Breaking changes que afecten mi setup (Claude Code, MCPs, skills)\n\n"
            "Para cada tema: resumen técnico (2-3 líneas), impacto práctico, "
            "acción recomendada (actualizar / explorar / ignorar).\n\n"
            f"Guarda el resultado en: ~/.ultron/cockpit/news/research-{today}.md"
        )
        launch_with_prompt(prompt, cli="gemini")
        self.notify("💬 Prompt research copiado → Gemini", severity="information")

    @work(thread=True)
    def _do_install_all_cached_skills(self) -> None:
        """Install all skills from skill_cache that aren't installed yet."""
        import shutil as _shutil
        cache_dir = Path.home() / ".ultron" / "skill_cache"
        skills_dir = Path.home() / ".claude" / "skills"
        if not cache_dir.exists():
            self.app.call_from_thread(
                lambda: self.notify("Cache vacío — busca skills primero", severity="warning"))
            return

        installed_count = 0
        skipped_count = 0
        for d in sorted(cache_dir.iterdir()):
            if not d.is_dir():
                continue
            dest = skills_dir / d.name
            if dest.exists():
                skipped_count += 1
                continue
            skill_md = d / "SKILL.md"
            if skill_md.exists():
                dest.mkdir(parents=True, exist_ok=True)
                _shutil.copy2(skill_md, dest / "SKILL.md")
                installed_count += 1

        msg = f"Instaladas {installed_count} skills ({skipped_count} ya existían)"
        self.app.call_from_thread(lambda m=msg: self.notify(m, severity="information"))
        self.app.call_from_thread(self._async_rerender_skills_market)

    def _render_scheduler(self):
        content = self._clear_content()
        content.mount(Static("[b]Scheduler[/b] [dim](Task Scheduler - Ultron* tasks)[/dim]", classes="title"))
        content.mount(Static("[dim]Enter = run now - r = refresh[/dim]", classes="subtitle"))

        tasks = get_scheduled_tasks()
        if not tasks:
            content.mount(Static(
                "[yellow]No Ultron tasks detected via PowerShell.[/yellow]\n"
                "If you ran 'ultron schedule install' and they ARE installed, this may be a "
                "PS subprocess issue. Workaround: open [cyan]taskschd.msc[/cyan] manually.\n\n"
                "To install fresh: [cyan]ultron schedule install[/cyan]",
                classes="warning",
            ))
            return

        table = DataTable(cursor_type="row", zebra_stripes=True)
        table.add_columns("Task", "State", "Last run", "Next run", "Result")
        for t in tasks:
            state = t.get("state", "?") or "?"
            last = t.get("last_run") or ""
            if last and "1999" in last:
                last = "never"
            elif last:
                last = last[:16].replace("T", " ")
            else:
                last = "never"
            next_run = (t.get("next_run") or "")[:16].replace("T", " ")
            if not next_run:
                next_run = "-"
            res = t.get("last_result")
            if res == 0:
                result = "OK"
            elif res in (None, 0x41303):
                result = "-"
            else:
                try:
                    result = f"0x{res:X}" if isinstance(res, int) else str(res)
                except Exception:
                    result = "?"
            table.add_row(
                str(t.get("name", "?")),
                state, last, next_run, result,
            )
        content.mount(table)

        content.mount(Static(""))
        content.mount(Static("[b]Configured schedules (from schedule-config.json):[/b]"))
        _freq_labels = {
            "on_login": "on login",
            "every_10_minutes": "every 10min",
            "once_per_day": "once/day",
            "every_hour": "every 1h",
            "once_per_weekday": "weekdays",
            "once_per_week_sunday": "weekly (Sun)",
        }
        sched_config_path = COCKPIT_DIR / "schedule-config.json"
        try:
            sched_cfg = json.loads(sched_config_path.read_text(encoding="utf-8-sig"))
            for task_name, cfg in sched_cfg.get("tasks", {}).items():
                enabled = cfg.get("enabled", True)
                delay = cfg.get("delay_minutes", 0)
                freq = _freq_labels.get(cfg.get("frequency", ""), cfg.get("frequency", "?"))
                status_icon = "[green]●[/green]" if enabled else "[dim]○[/dim]"
                content.mount(Static(
                    f"  {status_icon} {task_name:<32} login+{delay}min  {freq}"
                ))
        except (OSError, json.JSONDecodeError):
            content.mount(Static("[dim]schedule-config.json not found — run: ultron schedule install[/dim]"))
        content.mount(Static(""))
        content.mount(Static("[b]Edit config:[/b] [cyan]notepad ~\\.ultron\\cockpit\\schedule-config.json[/cyan]"))
        content.mount(Static("[b]Apply changes:[/b] [cyan]ultron schedule install[/cyan]"))

        # Action buttons
        content.mount(Static(""))
        content.mount(Static("[b]Actions:[/b]", classes="title"))
        content.mount(Static("[dim]💬 = copia prompt al portapapeles y abre terminal[/dim]",
                              classes="muted"))
        for btn in [
            Button("💬 Modificar schedule (Claude)", id="sched-edit", variant="primary"),
            Button("Install schedules (terminal)", id="sched-install", variant="warning"),
            Button("Status (terminal)", id="sched-status", variant="default"),
        ]:
            content.mount(btn)

    # ── Dashboard view (v14.8 P2C) ───────────────────────────────────────────

    def _refresh_snapshot(self) -> None:
        """Invoke system_snapshot.py refresh in-process. Best-effort."""
        try:
            import subprocess as _sp
            _SP_HIDDEN = _sp.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            script = COCKPIT_DIR / "system_snapshot.py"
            if not script.exists():
                return
            venv_py = (
                Path.home() / ".claude" / "skills" / "ultron"
                / ".venv" / "Scripts" / "python.exe"
            )
            if not venv_py.exists():
                venv_py = Path(sys.executable)
            _sp.run(
                [str(venv_py), str(script), "refresh", "--quiet", "--skip-doctor"],
                capture_output=True, text=True, timeout=15,
                creationflags=_SP_HIDDEN,
            )
        except Exception:
            pass

    def _run_validator(self) -> None:
        """Invoke validate_full_system.py run in-process. Best-effort."""
        try:
            import subprocess as _sp
            _SP_HIDDEN = _sp.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            script = COCKPIT_DIR / "validate_full_system.py"
            if not script.exists():
                return
            venv_py = (
                Path.home() / ".claude" / "skills" / "ultron"
                / ".venv" / "Scripts" / "python.exe"
            )
            if not venv_py.exists():
                venv_py = Path(sys.executable)
            _sp.run(
                [str(venv_py), str(script), "run", "--quiet"],
                capture_output=True, text=True, timeout=60,
                creationflags=_SP_HIDDEN,
            )
        except Exception:
            pass

    def _render_health(self):
        """⚡ System view — snapshot + validator + classic health checks.

        Top section: pre-computed system-snapshot.md (written every Stop hook
        + on demand). Mid section: last validator run, if any. Bottom
        section: classic disk/files/cron health from v10.x.
        Bindings: 's' refreshes snapshot, 'v' runs validator.
        """
        content = self._clear_content()
        content.mount(Static("[b]⚡ ULTRON System[/b]", classes="title"))
        content.mount(Static(
            "[dim]s = refresh snapshot · v = run validator · "
            "i = reindex Qdrant collections · R = recall modal · "
            "files: ~/.ultron/.tmp/system-snapshot.{json,md} · "
            "validate-last-run.md[/dim]"
        ))
        content.mount(Static(""))

        # ── Snapshot pane (from ~/.ultron/.tmp/system-snapshot.md)
        snap_md = Path.home() / ".ultron" / ".tmp" / "system-snapshot.md"
        if snap_md.exists():
            try:
                body = snap_md.read_text(encoding="utf-8")
                for line in body.splitlines():
                    if not line.strip():
                        content.mount(Static(""))
                        continue
                    if line.startswith("# "):
                        content.mount(Static(f"[b]{line[2:]}[/b]"))
                    elif line.startswith("## "):
                        content.mount(Static(f"[b cyan]{line[3:]}[/b cyan]"))
                    elif line.startswith("- "):
                        content.mount(Static(f"  {line[2:]}"))
                    else:
                        content.mount(Static(line))
            except OSError:
                content.mount(Static("[red]snapshot read error[/red]"))
        else:
            content.mount(Static(
                "[yellow]No snapshot yet. Press 's' to generate one.[/yellow]"
            ))

        # ── Validator pane
        content.mount(Static(""))
        content.mount(Static("[b cyan]── Last validator run ──[/b cyan]"))
        val_md = Path.home() / ".ultron" / ".tmp" / "validate-last-run.md"
        if val_md.exists():
            try:
                body = val_md.read_text(encoding="utf-8")
                for line in body.splitlines()[:30]:
                    if line.strip():
                        content.mount(Static(line))
            except OSError:
                content.mount(Static("[red]validator report read error[/red]"))
        else:
            content.mount(Static(
                "[dim]No validator run yet. Press 'v' to run it.[/dim]"
            ))

        # ── Classic health checks (disk / files / cron)
        # Cockpit dir size
        try:
            total = 0
            for p in COCKPIT_DIR.rglob("*"):
                if p.is_file():
                    total += p.stat().st_size
            mb = total / (1024 * 1024)
            color = "green" if mb < 50 else "yellow" if mb < 200 else "red"
            content.mount(Static(f"[b]Cockpit disk usage:[/b] [{color}]{mb:.1f} MB[/{color}]"))
        except Exception:
            content.mount(Static("[dim]Disk usage unavailable[/dim]"))

        # Files present
        critical = [
            (PROJECTS_JSON, "projects.json"),
            (NEWS_DIR, "news/"),
            (COCKPIT_DIR / "DASHBOARD.md", "DASHBOARD.md"),
        ]
        content.mount(Static(""))
        content.mount(Static("[b]Critical files:[/b]"))
        for path, name in critical:
            if path.exists():
                content.mount(Static(f"  [green]✓[/green] {name}"))
            else:
                content.mount(Static(f"  [red]✗[/red] {name} [dim](missing)[/dim]"))

        # Cron jobs summary
        tasks = get_scheduled_tasks()
        ready = sum(1 for t in tasks if t.get("state") == "Ready")
        total_t = len(tasks)
        content.mount(Static(""))
        content.mount(Static(f"[b]Scheduled tasks:[/b] [green]{ready}[/green] / [cyan]{total_t}[/cyan] Ready"))

        # CLIs: async to avoid UI freeze on cold-start CLIs (claude/codex/gemini can be slow)
        content.mount(Static(""))
        content.mount(Static("[b]CLI tools:[/b]"))
        content.mount(Static("[yellow]Checking CLIs...[/yellow]", id="health-cli-result"))
        self._check_clis_async()

        # Python environment
        content.mount(Static(""))
        content.mount(Static("[b]Python environment:[/b]"))
        try:
            r = subprocess.run(
                [sys.executable, "--version"],
                capture_output=True, text=True, timeout=5,
            )
            ver = (r.stdout or r.stderr or "").strip()[:80]
            content.mount(Static(f"  [green]✓[/green] {ver}"))
            content.mount(Static(f"  [dim]path: {sys.executable}[/dim]"))
        except Exception as e:
            content.mount(Static(f"  [red]✗[/red] {e}"))

        # Key files integrity
        content.mount(Static(""))
        content.mount(Static("[b]Key cockpit files:[/b]"))
        key_files = [
            (COCKPIT_DIR / "schedule-config.json", "schedule-config.json"),
            (COCKPIT_DIR / "apps.json", "apps.json"),
        ]
        for kpath, kname in key_files:
            if kpath.exists():
                content.mount(Static(f"  [green]✓[/green] {kname}"))
            else:
                content.mount(Static(f"  [red]✗[/red] {kname} [dim](missing)[/dim]"))

        # News freshness
        content.mount(Static(""))
        content.mount(Static("[b]News freshness:[/b]"))
        today_news_html = NEWS_DIR / f"newsletter-{datetime.now():%Y-%m-%d}.html"
        today_news_md = NEWS_DIR / f"{datetime.now():%Y-%m-%d}.md"
        if today_news_html.exists() or today_news_md.exists():
            name = today_news_html.name if today_news_html.exists() else today_news_md.name
            content.mount(Static(f"  [green]✓[/green] {name}"))
        else:
            content.mount(Static(f"  [yellow]![/yellow] Sin noticias hoy"))

        # Doctor section
        content.mount(Static(""))
        content.mount(Static("[b]Doctor[/b]"))
        content.mount(Static("[dim]Ejecuta health-check y muestra resultado aquí:[/dim]",
                              classes="muted"))
        content.mount(Static("[dim]— esperando —[/dim]", id="health-doctor-result"))
        content.mount(Button("▶ Run Doctor (inline)", id="health-doctor", variant="primary"))
        content.mount(Button("⎘ Full doctor in terminal", id="health-run", variant="default"))

    @work(thread=True, exclusive=True)
    def _check_clis_async(self) -> None:
        import shutil as _shutil
        npm_global = Path(os.environ.get("APPDATA", "")) / "npm"
        extra_paths = [str(npm_global)] if npm_global.exists() else []

        def _find_cli(name: str) -> str | None:
            found = _shutil.which(name)
            if found:
                return found
            for ext in (".cmd", ".ps1", ".exe", ""):
                for base in extra_paths:
                    candidate = Path(base) / f"{name}{ext}"
                    if candidate.exists():
                        return str(candidate)
            return None

        lines = []
        for cli in ("claude", "codex", "gemini", "git", "python"):
            cli_path = _find_cli(cli)
            if cli_path:
                try:
                    r = subprocess.run([cli_path, "--version"], capture_output=True,
                                       text=True, timeout=5)
                    ver = r.stdout.split("\n")[0][:60] if r.returncode == 0 else "(no version)"
                    lines.append(f"  [green]✓[/green] {cli:<10} [dim]{ver}[/dim]")
                except Exception as e:
                    lines.append(f"  [yellow]?[/yellow] {cli:<10} [dim]found but errored: {e}[/dim]")
            else:
                lines.append(f"  [red]✗[/red] {cli} [dim](not in PATH or %APPDATA%\\npm)[/dim]")

        self.call_from_thread(self._update_health_cli, "\n".join(lines))

    def _update_health_cli(self, text: str) -> None:
        try:
            self.query_one("#health-cli-result", Static).update(text)
        except Exception:
            pass

    @work(thread=True, exclusive=True)
    def _run_doctor_inline(self) -> None:
        """Run doctor.py --health-check and surface results inside TUI."""
        doctor_py = Path(__file__).parent / "doctor.py"
        try:
            r = subprocess.run(
                [sys.executable, str(doctor_py), "--health-check"],
                capture_output=True, text=True, timeout=60,
                cwd=str(doctor_py.parent),
            )
            raw = (r.stdout + r.stderr).strip()
            # Collapse ANSI/Rich markup: strip escape codes for clean display
            import re as _re
            clean = _re.sub(r'\x1b\[[0-9;]*m', '', raw)
            # Truncate to last 30 lines to fit TUI
            lines = clean.splitlines()
            if len(lines) > 30:
                lines = [f"[dim]... ({len(lines)-30} lines omitted) ...[/dim]"] + lines[-30:]
            exit_tag = (
                "[green]✓ OK[/green]" if r.returncode == 0
                else "[yellow]⚠ degraded[/yellow]" if r.returncode == 1
                else "[red]✗ error[/red]"
            )
            result = f"{exit_tag}  [dim]exit {r.returncode}[/dim]\n" + "\n".join(
                _markup_escape(ln) for ln in lines
            )
        except subprocess.TimeoutExpired:
            result = "[red]doctor timed out (>60s)[/red]"
        except Exception as e:
            result = f"[red]doctor error: {_markup_escape(str(e))}[/red]"
        self.call_from_thread(self._update_doctor_result, result)

    def _update_doctor_result(self, text: str) -> None:
        try:
            self.query_one("#health-doctor-result", Static).update(text)
        except Exception:
            pass

    # ── Actions on selection ─────────────────────────────────────────────────

    def _get_selected_project(self) -> dict | None:
        if self.current_view != "projects":
            return None
        try:
            tables = self.query(DataTable)
            for table in tables:
                if table.row_count == 0:
                    continue
                if table.cursor_row is None:
                    continue
                row = table.get_row_at(table.cursor_row)
                if not row:
                    continue
                project_id = str(row[0])
                for p in load_projects():
                    if p.get("id") == project_id:
                        return p
                break
        except Exception:
            return None
        return None

    def action_open_selected(self) -> None:
        if self.current_view != "projects":
            return
        proj = self._get_selected_project()
        if not proj:
            return
        # Use launch_project.py via subprocess
        script = Path(__file__).parent / "launch_project.py"
        subprocess.Popen([sys.executable, str(script), proj["id"]])

    def action_claude_here(self) -> None:
        proj = self._get_selected_project() if self.current_view == "projects" else None
        if proj:
            open_in_terminal("claude", cwd=proj.get("path"))
        else:
            open_in_terminal("claude")

    # ── Scheduler actions ────────────────────────────────────────────────────

    def _get_selected_task(self) -> str | None:
        if self.current_view != "scheduler":
            return None
        try:
            tables = self.query(DataTable)
            for table in tables:
                if table.row_count == 0 or table.cursor_row is None:
                    continue
                row = table.get_row_at(table.cursor_row)
                if row:
                    return str(row[0])
        except Exception:
            return None
        return None

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle action buttons across all views (v12.2)."""
        bid = event.button.id or ""
        ult = Path(__file__).parent / "ultron.ps1"
        ps_prefix = f'powershell -NoProfile -ExecutionPolicy Bypass -File "{ult}"'

        # ── AutoUpdater: Kirkardo audit buttons (1-9 from AUDIT_BUTTONS) ─────
        # Each button loads ~/.ultron/cockpit/tui/prompts/NN-*.md, copies the
        # fenced prompt to the clipboard, and launches the configured CLI
        # (claude orchestrates Triple/Dual; codex runs the pure --codex tasks).
        if bid.startswith("audit-"):
            try:
                n = int(bid.split("-", 1)[1])
            except (ValueError, IndexError):
                return
            self._launch_audit(n)
            return

        # ── Usage view ───────────────────────────────────────────────────────
        if bid == "usage-open":
            open_in_terminal("claude /usage")
            return
        if bid == "usage-edit-reset":
            def _after_close(saved: bool | None) -> None:
                if saved:
                    self._switch_view_safe("usage", self._render_usage)
            self.push_screen(UsageResetConfigModal(), _after_close)
            return

        # ── Scheduler actions ────────────────────────────────────────────────
        if bid == "sched-edit":
            launch_with_prompt("Ultron, modifica el schedule para que: ")
            self.notify("💬 Prompt copiado: modificar schedule", severity="information")
            return
        if bid == "sched-install":
            ult = Path(__file__).parent / "ultron.ps1"
            run_ps_hidden(f'& "{ult}" schedule install')
            self.notify("Schedule install lanzado en background", severity="information")
            return
        if bid == "sched-status":
            open_in_terminal(f'{ps_prefix} schedule status')
            return

        # ── MCPs actions ─────────────────────────────────────────────────────
        if bid == "mcp-list":
            open_in_terminal(f'{ps_prefix} mcp list')
            return
        if bid == "mcp-install":
            launch_with_prompt("Ultron, instala el MCP: ")
            self.notify("💬 Prompt copiado: instalar MCP", severity="information")
            return
        if bid == "mcp-uninstall":
            launch_with_prompt("Ultron, desinstala el MCP: ")
            self.notify("💬 Prompt copiado: desinstalar MCP", severity="information")
            return
        if bid == "mcp-validate":
            open_in_terminal(f'{ps_prefix} mcp list')
            return
        if bid == "mcp-scaffold":
            launch_with_prompt(
                "Ultron, /high diseña y crea un nuevo MCP server para: ")
            self.notify("💬 Prompt copiado: scaffold MCP (Claude)", severity="information")
            return

        # ── News view ────────────────────────────────────────────────────────
        if bid == "news-create-newsletter":
            self._do_create_newsletter()
        elif bid == "news-alerts-purge":
            self._do_alerts_purge()
        elif bid == "news-alerts-clear":
            self._do_alerts_clear()
        # Archive list (news view) — open file by index
        elif bid.startswith("archive-open-"):
            try:
                idx = int(bid.split("-")[-1])
                paths = getattr(self, "_news_archive", [])
                if 0 <= idx < len(paths):
                    import webbrowser as _wb
                    _wb.open(Path(paths[idx]).as_uri())
                    self.notify(f"Opened: {Path(paths[idx]).name}",
                                 severity="information")
                else:
                    self.notify("Archive index out of range", severity="warning")
            except (ValueError, OSError) as e:
                self.notify(f"Open failed: {e}", severity="error")

        # ── Skills market view ───────────────────────────────────────────────
        elif bid == "skills-registry-sync":
            ps = Path(__file__).parent / "ultron.ps1"
            run_ps_hidden(f'& "{ps}" skills registry propagate')
            self.notify("🔄 Sync lanzado en background — propagando skills a Codex + Agents", severity="information")
        elif bid == "skills-registry-sync-prompt":
            prompt = _load_audit_prompt("skills-registry-sync.md")
            if not prompt:
                self.notify("Prompt vacío o no encontrado: skills-registry-sync.md",
                             severity="error")
                return
            launch_with_prompt(prompt, cli="claude")
            self.notify("💬 Sync Registry prompt → portapapeles (abre Claude)", severity="information")
        elif bid == "skills-search-github":
            prompt = _load_audit_prompt("skills-search-github.md")
            if not prompt:
                self.notify("Prompt vacío o no encontrado: skills-search-github.md",
                             severity="error")
                return
            launch_with_prompt(prompt)
            self.notify("💬 Buscar Skills en GitHub → portapapeles (abre Claude)", severity="information")
        elif bid == "skills-update-all":
            prompt = _load_audit_prompt("skills-update-all.md")
            if not prompt:
                self.notify("Prompt vacío o no encontrado: skills-update-all.md",
                             severity="error")
                return
            launch_with_prompt(prompt)
            self.notify("💬 Actualizar Skills → portapapeles (abre Claude)", severity="information")
        elif bid == "skills-create":
            prompt = _load_audit_prompt("skills-create.md")
            if not prompt:
                self.notify("Prompt vacío o no encontrado: skills-create.md",
                             severity="error")
                return
            launch_with_prompt(prompt)
            self.notify("💬 Crear nueva skill → portapapeles (abre Claude)", severity="information")
        elif bid == "skills-search-codex":
            prompt = _load_audit_prompt("skills-search-codex.md")
            if not prompt:
                self.notify("Prompt vacío o no encontrado: skills-search-codex.md",
                             severity="error")
                return
            launch_with_prompt(prompt, cli="codex")
            self.notify("💬 Buscar skills GitHub → portapapeles (abre Codex)", severity="information")
        elif bid == "skills-search-gemini":
            prompt = _load_audit_prompt("skills-search-gemini.md")
            if not prompt:
                self.notify("Prompt vacío o no encontrado: skills-search-gemini.md",
                             severity="error")
                return
            launch_with_prompt(prompt, cli="gemini")
            self.notify("💬 Buscar Skills y ADD-ONS → portapapeles (abre Gemini)", severity="information")

        # ── Health view ──────────────────────────────────────────────────────
        elif bid == "health-doctor":
            self.notify("Running doctor --health-check...", severity="information")
            self._run_doctor_inline()
        elif bid == "health-run":
            ult = Path(__file__).parent / "ultron.ps1"
            open_in_terminal(
                f'powershell -NoProfile -ExecutionPolicy Bypass -File "{ult}" health'
            )
            self.notify("Full health check spawned in terminal", severity="information")

        # ── Changelog view ───────────────────────────────────────────────────
        elif bid == "changelog-open":
            changelog_path = ULTRON_ROOT / "references" / "changelog.md"
            if changelog_path.exists():
                open_in_terminal(f'notepad "{changelog_path}"')
            else:
                self.notify("changelog.md not found", severity="warning")

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if self.current_view == "scheduler":
            task = self._get_selected_task()
            if task and task.startswith("Ultron"):
                if trigger_scheduled_task(task):
                    self.notify(f"Triggered {task}", severity="information")
                else:
                    self.notify(f"Failed to trigger {task}", severity="error")

    # ── v10.4 New view renderers ────────────────────────────────────────────

    def _render_mcps(self):
        content = self._clear_content()
        content.mount(Static("[b]MCPs[/b] [dim](catalog + installed + scaffold)[/dim]",
                              classes="title"))
        content.mount(Static("[dim]ultron mcp list/install/uninstall/validate · scaffold (Sonnet)[/dim]",
                              classes="subtitle"))
        # Catalog
        catalog_path = COCKPIT_DIR / "mcp-catalog.json"
        try:
            cat = json.loads(catalog_path.read_text(encoding="utf-8-sig"))
            mcps = cat.get("mcps", [])
            content.mount(Static(f"[b]Catalog ({len(mcps)} MCPs)[/b]", classes="title"))
            table = DataTable(cursor_type="row", zebra_stripes=True)
            table.add_columns("ID", "Category", "Name", "Multi-acc")
            for m in mcps:
                table.add_row(
                    m.get("id", "?"),
                    m.get("category", "?"),
                    m.get("name", "?")[:30],
                    "yes" if m.get("multi_account") else "no",
                )
            content.mount(table)
        except (OSError, json.JSONDecodeError) as e:
            content.mount(Static(f"[yellow]Catalog read error: {e}[/yellow]"))
        # Installed
        settings_path = Path(os.environ.get("USERPROFILE", "~")) / ".claude" / "settings.json"
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8-sig"))
            installed = list(settings.get("mcpServers", {}).keys())
            content.mount(Static(""))
            content.mount(Static(f"[b]Installed ({len(installed)})[/b]", classes="title"))
            for s in installed:
                content.mount(Static(f"  ✓ {s}"))
        except (OSError, json.JSONDecodeError):
            content.mount(Static("[dim]No MCPs in settings.json[/dim]"))
        content.mount(Static(""))
        content.mount(Static("[b]Commands:[/b]"))
        content.mount(Static("  [cyan]ultron mcp install <id>[/cyan]    install from catalog"))
        content.mount(Static("  [cyan]ultron mcp scaffold <idea>[/cyan] scaffold new MCP server (Sonnet)"))
        content.mount(Static("  [cyan]ultron mcp validate <id>[/cyan]   JSON-RPC handshake test"))

        # Action buttons
        content.mount(Static(""))
        content.mount(Static("[b]Actions:[/b]", classes="title"))
        content.mount(Static("[dim]💬 = copia prompt al portapapeles y abre terminal Claude[/dim]",
                              classes="muted"))
        for btn in [
            Button("List instalados (terminal)", id="mcp-list", variant="primary"),
            Button("💬 Instalar MCP (Claude)", id="mcp-install", variant="warning"),
            Button("💬 Desinstalar MCP (Claude)", id="mcp-uninstall", variant="default"),
            Button("💬 Scaffold nuevo MCP (Claude /high)", id="mcp-scaffold", variant="default"),
        ]:
            content.mount(btn)

    def _render_usage(self) -> None:
        content = self._clear_content()
        now = datetime.now()

        cfg = load_usage_config()
        wd, h, m = cfg["weekday"], cfg["hour"], cfg["minute"]
        wd_name = _WEEKDAY_NAMES[wd]
        wd_short = wd_name[:3]
        week_start, week_end = compute_week_window(now, wd, h, m)
        week_total_s = timedelta(days=7).total_seconds()
        elapsed_s = (now - week_start).total_seconds()
        pct = elapsed_s / week_total_s * 100
        remaining = week_end - now
        rem_h = int(remaining.total_seconds() // 3600)
        rem_m = int((remaining.total_seconds() % 3600) // 60)

        # Bar (20 chars)
        filled = int(pct / 100 * 20)
        bar = "█" * filled + "░" * (20 - filled)

        content.mount(Static("[b]◎ Usage & Week Progress[/b]", classes="title"))
        content.mount(Static(""))
        content.mount(Static(
            f"[b]SEMANA ACTUAL[/b] [dim]({wd_short} {h:02d}:{m:02d} → "
            f"{wd_short} {h:02d}:{m:02d})[/dim]"))
        content.mount(Static(""))
        content.mount(Static(f"  Ahora      [b]{now.strftime('%a %d/%m/%Y %H:%M')}[/b]"))
        content.mount(Static(f"  Inicio     [dim]{week_start.strftime('%a %d/%m %H:%M')}[/dim]"))
        content.mount(Static(f"  Fin        [dim]{week_end.strftime('%a %d/%m %H:%M')}[/dim]"))
        content.mount(Static(""))

        pct_color = "#9eca7e" if pct <= 50 else ("#ffd089" if pct <= 80 else "#e0a868")
        content.mount(Static(f"  [{pct_color}]{bar}[/{pct_color}]  [{pct_color}]{pct:.1f}%[/{pct_color}] transcurrido"))
        content.mount(Static(f"  Quedan     [dim]{rem_h}h {rem_m}m[/dim]"))
        content.mount(Static(""))
        content.mount(Static("[dim]Si tu uso de Claude > % semana → vas bien.[/dim]"))
        content.mount(Static("[dim]Presiona 'r' para refrescar el contador.[/dim]"))
        content.mount(Static(""))
        content.mount(Static("[b]CONFIGURACIÓN[/b]"))
        content.mount(Static(
            f"  Reset semanal: [cyan]{wd_name} {h:02d}:{m:02d}[/cyan]"))
        content.mount(Button("✎ Cambiar día y hora del reset",
                              id="usage-edit-reset", variant="default"))
        content.mount(Static(""))
        content.mount(Static("[b]CLAUDE USAGE[/b]"))
        content.mount(Static(""))
        content.mount(Button("◎ Abrir claude /usage", id="usage-open", variant="primary"))

    def _render_autoupdater(self):
        content = self._clear_content()
        content.mount(Static("[b]Kirkardo — ULTRON System Review[/b]",
                              classes="title"))
        content.mount(Static("[dim]Prompt al clipboard → continúa conversación con Kirkardo[/dim]",
                              classes="subtitle"))

        # Audit history
        audits_dir = COCKPIT_DIR / "audits"
        if audits_dir.exists():
            audits = sorted(audits_dir.glob("*.md"),
                             key=lambda p: p.stat().st_mtime, reverse=True)
            content.mount(Static(""))
            content.mount(Static(f"[b]Audits recientes ({len(audits)})[/b]"))
            import re as _re
            # v13.1 fix: read from INDEX.json (built by audit_index.py) — single
            # source of truth for nota+veredicto, accepts both `nota:` and
            # `nota_global:` formats with or without `/10` suffix.
            import json as _json
            _index_path = audits_dir / "INDEX.json"
            _audit_meta = {}
            if _index_path.exists():
                try:
                    _idx = _json.loads(_index_path.read_text(encoding="utf-8"))
                    for _entry in _idx.get("audits", []):
                        _audit_meta[_entry["file"]] = _entry
                except Exception:
                    pass
            for a in audits[:10]:
                _meta = _audit_meta.get(a.name, {})
                nota = _meta.get("nota") or "?"
                if isinstance(nota, str) and nota.endswith("/10"):
                    nota = nota.rsplit("/", 1)[0]
                ver = _meta.get("veredicto") or "?"
                if isinstance(ver, str):
                    ver = ver[:30]
                # Fallback to old regex parse only if INDEX.json missing
                if nota == "?" and not _audit_meta:
                    head = a.read_text(encoding="utf-8")[:500]
                    m = (_re.search(r"^\s*(?:nota_global|nota)\s*:\s*([\d.]+)(?:\s*/\s*10)?\s*$",
                                     head, _re.MULTILINE)
                         or _re.search(r"\*\*([\d.]+)\s*/\s*10\*\*", head))
                    if m:
                        nota = m.group(1)
                mtime = datetime.fromtimestamp(a.stat().st_mtime)
                try:
                    nota_f = float(nota)
                except ValueError:
                    nota_f = 0.0
                color = "green" if nota_f >= 9.0 else "yellow" if nota_f >= 7.0 else "red"
                content.mount(Static(f"  {mtime.strftime('%Y-%m-%d %H:%M')}  "
                                      f"{a.stem:<32}  [{color}]nota={nota}/10[/{color}]  "
                                      f"[dim]{ver}[/dim]"))
        else:
            content.mount(Static("[dim]No audits yet — usa los botones para iniciar uno[/dim]"))

        # Action buttons — 9 Kirkardo audit prompts (loaded from
        # ~/.ultron/cockpit/tui/prompts/NN-*.md). Each button copies its
        # prompt to the clipboard and opens the right CLI (claude/codex).
        content.mount(Static(""))
        content.mount(Static("[b]Audits Kirkardo[/b]", classes="title"))
        content.mount(Static(
            "[dim]Cada botón copia su prompt al portapapeles y abre la CLI "
            "indicada. Triple/Dual usan Claude como orquestador; "
            "MINIDUAL --codex abre Codex directo.[/dim]",
            classes="subtitle"))
        content.mount(Static(""))

        # Map cost tag -> button variant (visual hint of token cost)
        variant_for_cost = {
            "MAXTRIPLE":         "error",     # red — highest cost
            "ULTRA TRIPLE":      "warning",   # amber — high cost
            "HIGH DUAL":         "primary",   # accent — medium
            "HIGH DUAL --codex": "primary",
            "MINIDUAL --codex":  "success",   # green — low cost
        }

        for n, (fname, label, cost, cli) in enumerate(AUDIT_BUTTONS, start=1):
            variant = variant_for_cost.get(cost, "default")
            cli_tag = f"[dim]({cli.upper()})[/dim]"
            content.mount(Button(
                f" {n}. {label}  ·  {cost}  {cli_tag} ",
                id=f"audit-{n}",
                variant=variant,
            ))
            # show source filename only in muted line below for traceability
            content.mount(Static(
                f"   [dim]→ ~/.ultron/cockpit/tui/prompts/{fname}[/dim]",
                classes="muted"))

        content.mount(Static(""))
        content.mount(Static(
            "[dim]Tip: 8 (Todo el sistema) consume el soft cap MaxTriple "
            "del día — confirma antes de pulsar.[/dim]",
            classes="muted"))

    def action_view_inventory(self) -> None:
        self._switch_view_safe("inventory", self._render_inventory)

    def _render_inventory(self) -> None:
        """Installed apps inventory (registry + winget). Cached 7 days."""
        content = self._clear_content()
        content.mount(Static("[b]Installed Apps Inventory[/b]", classes="title"))
        content.mount(Static("[dim]Windows registry (HKLM 64/32, HKCU) + winget[/dim]",
                             classes="subtitle"))

        cache_path = Path.home() / ".ultron" / ".tmp" / "inventory.json"
        refresh = True
        if cache_path.exists():
            try:
                age_s = datetime.now().timestamp() - cache_path.stat().st_mtime
                if age_s < 7 * 86400:
                    refresh = False
            except OSError:
                pass

        if refresh:
            content.mount(Static("[#e0a868]Scanning system… (~5-15s)[/#e0a868]"))
            try:
                installed_py = Path(__file__).parent / "installed_apps.py"
                proc = subprocess.run(
                    [sys.executable, str(installed_py), "--json"],
                    capture_output=True, text=True, timeout=120,
                    encoding="utf-8", errors="replace",
                )
                if proc.returncode != 0 and not proc.stdout:
                    content.mount(Static(f"[red]Scan failed:[/red] {proc.stderr[:200]}"))
                    return
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(proc.stdout, encoding="utf-8")
            except (subprocess.TimeoutExpired, OSError) as e:
                content.mount(Static(f"[red]Scan error:[/red] {e}"))
                return

        try:
            apps = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            content.mount(Static(f"[red]Cache unreadable:[/red] {e}"))
            return

        age_min = (datetime.now().timestamp() - cache_path.stat().st_mtime) / 60
        content.mount(Static(
            f"[dim]Total: {len(apps)} apps · cached {age_min:.0f} min ago · "
            f"auto-refresh every 7 days · [b]r[/b] forces refresh[/dim]"
        ))
        content.mount(Static(""))

        # Markdown table — Rich renders it nicely with auto column widths.
        rows = ["| Name | Version | Publisher | Source |", "|---|---|---|---|"]
        for a in apps:
            n = (a.get("name", "") or "")[:60].replace("|", "\\|")
            v = (a.get("version", "") or "")[:20].replace("|", "\\|")
            p = (a.get("publisher", "") or "")[:30].replace("|", "\\|")
            s = a.get("source", "") or ""
            rows.append(f"| {n} | {v} | {p} | {s} |")
        content.mount(Markdown("\n".join(rows)))

    def _render_changelog(self) -> None:
        content = self._clear_content()
        content.mount(Static("[b]Changelog[/b]", classes="title"))
        content.mount(Static("[dim]ULTRON version history[/dim]", classes="subtitle"))
        changelog_path = ULTRON_ROOT / "references" / "changelog.md"
        if not changelog_path.exists():
            content.mount(Static(""))
            content.mount(Static(f"[red]changelog.md not found:[/red] {changelog_path}"))
            return
        try:
            text = changelog_path.read_text(encoding="utf-8")
        except Exception as e:
            content.mount(Static(f"[red]Error reading changelog:[/red] {e}"))
            return
        content.mount(Static(""))
        content.mount(Markdown(text))
        content.mount(Static(""))
        content.mount(Button("Open changelog in editor", id="changelog-open", variant="default"))

    @work
    async def _refresh_current_view(self) -> None:
        """Async re-render that awaits DOM cleanup to avoid DuplicateIds on same-view refresh."""
        content = self.query_one("#content", ScrollableContainer)
        try:
            await content.remove_children()
        except Exception:
            pass
        method_name = f"_render_{self.current_view.replace('-', '_')}"
        method = getattr(self, method_name, None)
        if method:
            try:
                method()
            except Exception as exc:
                self.notify(f"Refresh error: {exc}", severity="error")
                return
        self.notify("Refreshed", severity="information")

    def action_refresh(self) -> None:
        self._refresh_current_view()

    async def _async_rerender_news(self) -> None:
        """Async news re-render for call_from_thread. Skipped if user navigated away."""
        if self.current_view != "news":
            return
        content = self.query_one("#content", ScrollableContainer)
        try:
            await content.remove_children()
        except Exception:
            pass
        self._render_news()

    async def _async_rerender_skills_market(self) -> None:
        """Async skills-market re-render for call_from_thread. Skipped if user navigated away."""
        if self.current_view != "skills-market":
            return
        content = self.query_one("#content", ScrollableContainer)
        try:
            await content.remove_children()
        except Exception:
            pass
        self._render_skills_market()

def main():
    app = UltronTUI()
    app.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
ULTRON Times — News HTML Generator (v14.2 "Tech/AI Focus Edition").

Flow:
1. Build prompt from a local newsletter SKILL.md template + section config
2. Inject --days, --theme, --notes, dedup block into the prompt
3a. [default]   Call Gemini CLI headless → capture stdout HTML → write file → autoopen
3b. [clipboard] Copy prompt to clipboard → user pastes into Gemini/Claude session

Sections: tech (default, the only built-in) + any registered custom section
in ~/.ultron/news_categories.json.

Usage:
    python news_html_generator.py                              # tech, 3 days
    python news_html_generator.py --days 7                    # last week
    python news_html_generator.py --theme "AI security week"  # focus topic
    python news_html_generator.py --notes "cover the Gemini 3 launch specifically"
    python news_html_generator.py --clipboard
    python news_html_generator.py --model gemini-2.5-flash
    python news_html_generator.py --no-open
    python news_html_generator.py --no-dedup                  # skip deduplication
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import webbrowser
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

sys.path.insert(0, str(Path(__file__).parent))
from cockpit_base import NEWS_DIR  # noqa: E402

SKILL_PATH = Path.home() / ".claude" / "skills" / "newsletter-publisher" / "SKILL.md"
NEWS_CATEGORIES_FILE = NEWS_DIR.parent / "news_categories.json"

DEFAULT_MODEL = "gemini-3.1-pro"
GEMINI_TIMEOUT_SEC = 600
DEDUP_DAYS = 7
DEDUP_MAX_URLS = 80
DEDUP_MIN_NEWS = 25

# ── Built-in section configs ───────────────────────────────────────────────────

BUILTIN_SECTIONS: dict[str, dict] = {
    "tech": {
        "label": "Tech & AI",
        "tagline": "AI · Tech · Dev · Security — Daily Brief",
        "accent": "#ffd089",
        "file_suffix": "",
        "sources": (
            "Blogs oficiales (Anthropic, OpenAI, Google AI, DeepMind, Meta AI, Mistral, xAI, DeepSeek); "
            "arxiv cs.AI/cs.CL/cs.SE; HuggingFace papers; "
            "GitHub trending + GitHub Blog; Hacker News front page (top 30); "
            "TechCrunch, The Verge, Ars Technica, The Information; "
            "Cloudflare Blog, Vercel Blog, AWS What's New, Azure updates, GCP releases; "
            "Microsoft DevBlogs, JetBrains releases, Mozilla Hacks; "
            "NVD CVEs (últimos 7d, CVSS≥7), GitHub Advisory DB; "
            "Reuters Tech, Bloomberg Tech, FT Tech para markets/funding; "
            "Release notes Unreal Engine / Unity / JetBrains"
        ),
        "focus_sections": (
            "1. HERO — noticia más impactante del día (AI / Tech / Security)\n"
            "2. AI RESEARCH (3-4): papers notables, benchmarks, evals, breakthroughs\n"
            "3. AI INDUSTRY (3-4): lanzamientos de modelos, APIs, agents, M&A AI\n"
            "4. DEV TOOLING & AGENTS (3-4): Claude Code, Codex, Cursor, Windsurf, "
            "Cline, Aider, MCP servers, IDE integrations\n"
            "5. TECH PLATFORMS (2-3): cloud (AWS/Azure/GCP), Vercel, Cloudflare, "
            "GitHub releases, framework majors, language releases\n"
            "6. SECURITY & REGULATION (2-3): CVEs críticos, supply chain, "
            "prompt injection, AI safety, EU AI Act, FTC, regulators\n"
            "7. MARKETS & FUNDING (1-2): rounds, IPOs, layoffs, M&A en AI/Tech\n"
            "8. GAME DEV CORNER (1 si hay): UE5, Unity, GAS, shaders\n"
            "9. THE BRIEF (8-12 one-liners con link)\n"
        ),
        "priority_note": (
            "PRIORIZA: herramientas que USER usa (Claude Code, UE5, Python, TypeScript, C#). "
            "Modelos AI nuevos. CVEs críticos. Tendencias de adopción de agentes AI. "
            "Cobertura horizontal: AI + Tech + Security; no solo AI."
        ),
        "min_news": DEDUP_MIN_NEWS,
    },
}


# ── Section loader ─────────────────────────────────────────────────────────────

def load_sections() -> dict[str, dict]:
    """Merge builtin sections with user-registered custom sections."""
    sections = dict(BUILTIN_SECTIONS)
    if NEWS_CATEGORIES_FILE.exists():
        try:
            data = json.loads(NEWS_CATEGORIES_FILE.read_text(encoding="utf-8"))
            for name, cfg in data.get("custom_sections", {}).items():
                if name not in sections:
                    sections[name] = cfg
        except (json.JSONDecodeError, OSError):
            pass
    return sections


def section_output_path(cfg: dict, date_str: str) -> Path:
    suffix = cfg.get("file_suffix", "")
    return NEWS_DIR / f"newsletter-{date_str}{suffix}.html"


def today_existing_editions(sections: dict, date_str: str) -> dict[str, Path]:
    """Return {label: path} for today's editions that already exist on disk."""
    existing: dict[str, Path] = {}
    for name, cfg in sections.items():
        p = section_output_path(cfg, date_str)
        if p.exists():
            existing[cfg["label"]] = p
    return existing


# ── Deduplication ──────────────────────────────────────────────────────────────

# Tracking-param strip list — avoids treating same article with utm_* as new.
_TRACKING_PARAMS = re.compile(
    r"[?&](utm_[a-z]+|fbclid|gclid|mc_[a-z]+|ref|ref_src|s|igshid|spm|src|"
    r"campaign_id|email_token|email_subject)=[^&]*",
    re.IGNORECASE,
)


def canonicalize_url(url: str) -> str:
    """Normalize URL for dedup — lowercase host, strip trackers, drop trailing slash."""
    url = url.strip()
    url = _TRACKING_PARAMS.sub("", url)
    # Collapse '?&' / '?' artifacts left after tracker strip
    url = re.sub(r"\?&", "?", url)
    url = re.sub(r"[?&]+$", "", url)
    # Lowercase scheme + host (path is case-sensitive)
    m = re.match(r"^(https?://)([^/]+)(/?.*)$", url, re.IGNORECASE)
    if m:
        url = m.group(1).lower() + m.group(2).lower() + m.group(3)
    # Drop trailing slash unless root
    if url.endswith("/") and url.count("/") > 3:
        url = url[:-1]
    return url


def normalize_title(title: str) -> str:
    """Normalize headline for dedup — lowercase, collapse whitespace, strip punctuation."""
    t = title.lower()
    t = re.sub(r"[^\w\s]", " ", t, flags=re.UNICODE)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def extract_article_urls(html: str) -> list[str]:
    """Extract external article URLs from newsletter HTML (canonicalized)."""
    found = re.findall(r'href="(https?://[^"]{15,300})"', html)
    skip_fragments = ("javascript:", "#", "mailto:", "file://", "localhost",
                      "twitter.com/intent", "facebook.com/sharer", "linkedin.com/share")
    out: list[str] = []
    for u in found:
        if any(s in u for s in skip_fragments):
            continue
        out.append(canonicalize_url(u))
    return out


def extract_article_titles(html: str) -> list[str]:
    """Extract headline-level titles (h1/h2/h3) from newsletter HTML."""
    titles = re.findall(r"<h[123][^>]*>(.+?)</h[123]>", html, re.DOTALL | re.IGNORECASE)
    out: list[str] = []
    for raw in titles:
        clean = re.sub(r"<[^>]+>", "", raw)  # strip nested tags (e.g. <a>)
        clean = re.sub(r"&\w+;", " ", clean)  # strip HTML entities
        clean = clean.strip()
        if 12 <= len(clean) <= 220:  # reject icons/badges + long blocks
            out.append(clean)
    return out


def load_recent_dedup_corpus(cfg: dict, days: int = DEDUP_DAYS) -> tuple[list[str], list[str], int]:
    """Return (urls, titles, file_count) from recent newsletters of this section.

    URLs and titles are deduplicated within the corpus. file_count is how many
    historic newsletter files contributed to the dedup set — surfaced in logs.
    """
    cutoff = datetime.now() - timedelta(days=days)
    suffix = cfg.get("file_suffix", "")
    pattern = f"newsletter-*{suffix}.html" if suffix else "newsletter-*.html"

    all_urls: list[str] = []
    all_titles: list[str] = []
    file_count = 0
    for f in NEWS_DIR.glob(pattern):
        # For tech (no suffix), skip section-specific files (they have extra suffixes)
        if not suffix and re.search(r"newsletter-\d{4}-\d{2}-\d{2}-.+\.html", f.name):
            continue
        try:
            mtime = datetime.fromtimestamp(f.stat().st_mtime)
        except OSError:
            continue
        if mtime < cutoff:
            continue
        try:
            html = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        all_urls.extend(extract_article_urls(html))
        all_titles.extend(extract_article_titles(html))
        file_count += 1

    seen_url: set[str] = set()
    urls_out: list[str] = []
    for u in all_urls:
        if u not in seen_url:
            seen_url.add(u)
            urls_out.append(u)

    seen_title: set[str] = set()
    titles_out: list[str] = []
    for t in all_titles:
        norm = normalize_title(t)
        if norm and norm not in seen_title:
            seen_title.add(norm)
            titles_out.append(t)

    return urls_out[:DEDUP_MAX_URLS], titles_out[:DEDUP_MAX_URLS], file_count


def load_recent_dedup_urls(cfg: dict, days: int = DEDUP_DAYS) -> list[str]:
    """Backward-compat shim — returns URLs only. Prefer load_recent_dedup_corpus."""
    urls, _titles, _count = load_recent_dedup_corpus(cfg, days=days)
    return urls


# ── Nav bar ────────────────────────────────────────────────────────────────────

def build_nav_instruction(existing: dict[str, Path], current_label: str) -> str:
    """Return prompt text instructing Gemini to add an edition navigation bar."""
    # All labels: existing + current (if not yet saved)
    all_labels = sorted({*existing.keys(), current_label})
    if len(all_labels) < 2:
        return ""

    items: list[str] = []
    for label in all_labels:
        if label == current_label:
            items.append(
                f'  <span style="color:#ffd089;font-family:\'JetBrains Mono\',monospace;'
                f'font-size:0.8rem;padding:0.3rem 0.8rem;border-radius:4px;'
                f'background:#1a1500;border:1px solid #ffd089;">{label}</span>'
            )
        elif label in existing:
            items.append(
                f'  <a href="{existing[label].name}" style="color:#888;text-decoration:none;'
                f'font-family:\'JetBrains Mono\',monospace;font-size:0.8rem;'
                f'padding:0.3rem 0.8rem;border-radius:4px;border:1px solid #2a2a2a;">'
                f'{label}</a>'
            )

    nav_html = (
        '<nav style="display:flex;gap:0.75rem;justify-content:center;'
        'padding:0.6rem 2rem;background:#0f0f0f;border-bottom:1px solid #2a2a2a;'
        'flex-wrap:wrap;">\n'
        + "\n".join(items)
        + "\n</nav>"
    )
    return (
        "\n\nNAVEGACIÓN DE EDICIONES — Insertar este bloque HTML exactamente "
        "después del cierre </header> y ANTES del HERO:\n"
        f"{nav_html}\n"
    )


# ── Prompt building ────────────────────────────────────────────────────────────

def load_base_template() -> str:
    """Extract PROMPT TEMPLATE block from the local newsletter SKILL.md."""
    if not SKILL_PATH.exists():
        return ""
    text = SKILL_PATH.read_text(encoding="utf-8")
    m = re.search(
        r"##\s*📝\s*PROMPT\s*TEMPLATE.*?\n```\s*\n(.+?)\n```",
        text, re.DOTALL,
    )
    return m.group(1).strip() if m else ""


def build_section_prompt(
    cfg: dict,
    days: int,
    theme: str | None,
    notes: str | None,
    dedup_urls: list[str],
    nav_instruction: str,
    dedup_titles: list[str] | None = None,
) -> str:
    date_str = datetime.now().strftime("%-d de %B de %Y") if sys.platform != "win32" \
        else datetime.now().strftime("%d de %B de %Y").lstrip("0")
    timeframe = f"últimas {days * 24}h / {days} días"
    min_news = cfg.get("min_news", DEDUP_MIN_NEWS)

    prompt = f"""Eres el redactor del ULTRON Times — edición {cfg['label']}.
Genera un newsletter HTML5 con la profundidad de un periódico digital profesional.
Diseño: auténtico periódico digital premium — artículos con lead paragraph, contexto e impacto real.

SECCIÓN: {cfg['label'].upper()}
Tagline: "{cfg['tagline']}"
Ventana: {timeframe}

ESTRUCTURA OBLIGATORIA (mínimo {min_news} noticias REALES):

{cfg['focus_sections']}
DISEÑO (mismo en todas las ediciones — paleta ULTRON Times):
- Background #0a0a0a · cards #131313 · hero #1a1a1a
- Text #e8e8e8 · muted #888 · accent principal para esta edición: {cfg['accent']}
- Inter/Segoe UI body, JetBrains Mono code/meta
- Headlines font-weight 700, hero h1 2.5rem, cards h2 1.25rem
- Mobile-first responsive @media (max-width: 768px)
- Border #2a2a2a entre secciones

HEADER:
- Logo "⌬ ULTRON Times" en {cfg['accent']}
- Tagline "{cfg['tagline']}"
- Fecha: {date_str}

{cfg['priority_note']}

FUENTES (busca activamente en internet):
{cfg['sources']}

EVITA:
- "Alguien dijo en Twitter" sin fuente verificable
- Marketing copy sin substancia ("revolutionary")
- Noticias >7 días presentadas como "today"
- Fillers — sé concreto o omite
- Hallucinations: 10 noticias reales > 15 inventadas

CALIDAD:
- Cada artículo cita SOURCE + LINK real (URL completa)
- Los leads son SUBSTANTIVOS: contexto + qué pasó + impacto
- Cero placeholders
- Total mínimo: {min_news} items con sustancia
"""

    # Navigation bar
    if nav_instruction:
        prompt += nav_instruction

    # Deduplication
    if dedup_urls or dedup_titles:
        prompt += (
            f"\n\nDEDUPLICACIÓN — No incluyas artículos ya cubiertos en ediciones de los "
            f"últimos {DEDUP_DAYS} días. Evita por URL canónica Y por título "
            "(misma noticia con titular ligeramente distinto cuenta como duplicado).\n"
        )
        if dedup_urls:
            prompt += f"\nURLs ya publicadas ({len(dedup_urls)}):\n"
            prompt += "\n".join(f"- {u}" for u in dedup_urls[:60])
            prompt += "\n"
        if dedup_titles:
            prompt += f"\nTitulares ya publicados ({len(dedup_titles)}):\n"
            prompt += "\n".join(f"- {t[:160]}" for t in dedup_titles[:60])
            prompt += "\n"

    # Theme override
    if theme:
        prompt += (
            f"\n\nTEMA ESPECIAL: \"{theme}\"\n"
            f"→ HERO: noticia más importante sobre este tema\n"
            f"→ Añadir sección \"{theme}\" antes de THE BRIEF\n"
            f"→ Resto de secciones: condensar si solapan con el tema\n"
        )

    # User notes
    if notes:
        prompt += f"\n\nNOTAS ADICIONALES DEL EDITOR:\n{notes}\n"

    prompt += (
        "\n\n[OUTPUT INSTRUCTION — CRITICAL]\n"
        "Imprime SOLO el HTML5 completo, desde <!DOCTYPE html> hasta </html>.\n"
        "NADA de markdown fences (no ```html). NADA de explicación previa.\n"
        "NADA después del </html>. Solo HTML directo, ready-to-render.\n"
    )
    return prompt


# ── Validation ────────────────────────────────────────────────────────────────

def validate_html(html: str) -> tuple[bool, str]:
    low = html.lower().strip()
    if not (low.startswith("<!doctype") or low.startswith("<html")):
        return False, "no empieza con <!DOCTYPE o <html>"
    if "</html>" not in low:
        return False, "falta </html> de cierre"
    if not any(tag in low for tag in ("<article", "<section", "<main")):
        return False, "no contiene <article>, <section>, ni <main>"
    size = len(html.encode("utf-8"))
    if size < 5_000:
        return False, f"HTML demasiado pequeño ({size}b, esperado >5KB)"
    if size > 1_000_000:
        return False, f"HTML demasiado grande ({size}b, esperado <1MB)"
    return True, "ok"


# ── Audit flags ───────────────────────────────────────────────────────────────

def extract_audit_flags(html: str) -> dict[str, list[str]]:
    m = re.search(r"<!--\s*AUDIT_FLAGS:\s*\n?(.+?)\n?\s*-->", html, re.DOTALL)
    if not m:
        return {}
    flags: dict[str, list[str]] = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        skill, topics_str = line.split(":", 1)
        skill = skill.strip()
        topics = [t.strip() for t in topics_str.split(",") if t.strip()]
        if skill and topics:
            flags[skill] = topics
    return flags


def write_audit_flags_file(flags: dict[str, list[str]]) -> Path | None:
    if not flags:
        return None
    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    date = datetime.now().strftime("%Y-%m-%d")
    flag_file = NEWS_DIR / f"audit-flags-{date}.md"
    lines = [
        f"# News Audit Flags — {date}", "",
        "_Generado por ULTRON Times news_html_generator.py._", "",
        "Skills que requieren revisión:", "",
    ]
    for skill, topics in sorted(flags.items()):
        lines.append(f"## `{skill}`")
        for t in topics:
            lines.append(f"- {t}")
        lines.append("")
    lines += ["---", "", "**Para repo-evaluator** — ejecutar audit:", "```bash"]
    for skill in sorted(flags.keys()):
        lines.append(f"ultron self-improve audit {skill} --quick")
    lines += ["```"]
    flag_file.write_text("\n".join(lines), encoding="utf-8")
    return flag_file


# ── Gemini / clipboard ────────────────────────────────────────────────────────

def _strip_code_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```\w*\s*\n", "", text, count=1).strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    return text


def copy_to_clipboard(text: str) -> bool:
    """Copy `text` to the Windows clipboard preserving UTF-8.

    Bug we're fixing: piping a UTF-8 string into PowerShell stdin via
    subprocess produces mojibake (ÔÇö, ├¡, ├▒, etc.) because PowerShell
    interprets stdin in the legacy OEM codepage by default, not UTF-8.
    Fix: drop the text into a temp file with a UTF-8 BOM and use
    Get-Content -Encoding UTF8 | Set-Clipboard, which reads explicitly
    as UTF-8.
    """
    import tempfile
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8-sig", suffix=".txt",
            delete=False, newline="",
        ) as tf:
            tf.write(text)
            tmp = tf.name
        # -LiteralPath avoids glob expansion on paths with [ ] etc.
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Get-Content -Raw -Encoding UTF8 -LiteralPath '{tmp}' | Set-Clipboard"],
            capture_output=True, timeout=10,
            creationflags=_WIN_HIDDEN,
        )
        return True
    except Exception:
        return False
    finally:
        if tmp:
            try:
                import os
                os.unlink(tmp)
            except OSError:
                pass


def call_gemini(prompt: str, out_path: Path, model: str) -> tuple[bool, str]:
    gemini_bin = shutil.which("gemini")
    if not gemini_bin:
        return False, "gemini CLI no encontrado en PATH"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = subprocess.run(
            [gemini_bin, "--approval-mode", "plan", "-m", model, "-p", prompt],
            capture_output=True, text=True, encoding="utf-8",
            timeout=GEMINI_TIMEOUT_SEC,
            creationflags=_WIN_HIDDEN,
        )
    except subprocess.TimeoutExpired:
        return False, f"timeout ({GEMINI_TIMEOUT_SEC}s)"
    except Exception as e:
        return False, f"exec error: {e}"

    if r.returncode != 0:
        err = r.stderr or ""
        if "429" in err or "RESOURCE_EXHAUSTED" in err:
            return False, "Gemini 429 capacity exhausted. Retry in ~1min or use --clipboard."
        return False, f"gemini exit {r.returncode}: {err[:300]}"

    html = _strip_code_fences(r.stdout or "")
    end_idx = html.lower().rfind("</html>")
    if end_idx > 0:
        html = html[:end_idx + len("</html>")]

    if len(html) < 1000 or "</html>" not in html.lower():
        return False, f"stdout sin HTML válido ({len(html)} chars). Usa --clipboard para modo manual."

    try:
        out_path.write_text(html, encoding="utf-8")
    except OSError as e:
        return False, f"write failed: {e}"
    return True, "stdout-capture"


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    sections = load_sections()
    section_names = list(sections.keys())

    p = argparse.ArgumentParser(
        prog="news_html_generator",
        description="ULTRON Times — Multi-section newsletter generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  ultron news                                 # tech, 3 días\n"
            "  ultron news --days 7                        # semana completa\n"
            "  ultron news --theme 'AI security week'      # sección especial\n"
            "  ultron news --clipboard                     # modo manual\n"
        ),
    )
    p.add_argument("--section", default="tech", choices=section_names,
                   help=f"Sección a generar (default: tech). Opciones: {', '.join(section_names)}")
    p.add_argument("--days", type=int, default=3,
                   help="Ventana de cobertura en días (default 3)")
    p.add_argument("--theme", default=None,
                   help="Tema especial — Hero y sección extra se centran aquí")
    p.add_argument("--notes", default=None,
                   help="Notas libres del editor")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help=f"Gemini model (default {DEFAULT_MODEL})")
    p.add_argument("--clipboard", action="store_true",
                   help="Copiar el prompt al portapapeles en lugar de llamar a Gemini")
    p.add_argument("--no-open", action="store_true",
                   help="No abrir en navegador tras generar")
    p.add_argument("--no-dedup", action="store_true",
                   help="Desactivar deduplicación de artículos anteriores")
    args = p.parse_args()

    cfg = sections[args.section]
    date_str = datetime.now().strftime("%Y-%m-%d")

    print("=" * 80)
    print(f"⌬  ULTRON Times — {cfg['label']} (v13.0)")
    print("=" * 80)

    # Check which other editions exist today (for nav bar)
    existing = today_existing_editions(sections, date_str)
    nav_instruction = build_nav_instruction(existing, cfg["label"])
    if nav_instruction:
        print(f"[nav] Ediciones hoy: {', '.join(existing.keys())} → añadiendo nav bar")

    # Deduplication
    dedup_urls: list[str] = []
    dedup_titles: list[str] = []
    if not args.no_dedup:
        dedup_urls, dedup_titles, dedup_files = load_recent_dedup_corpus(cfg, days=DEDUP_DAYS)
        if dedup_urls or dedup_titles:
            print(f"[dedup] lookback {DEDUP_DAYS}d · {dedup_files} newsletters → "
                  f"{len(dedup_urls)} URLs + {len(dedup_titles)} titulares se excluyen")

    prompt = build_section_prompt(
        cfg, args.days, args.theme, args.notes, dedup_urls, nav_instruction,
        dedup_titles=dedup_titles,
    )
    print(f"[prompt] sección={args.section} días={args.days}" +
          (f" · tema='{args.theme}'" if args.theme else "") +
          (f" · notas={len(args.notes)} chars" if args.notes else "") +
          (f" · dedup_urls={len(dedup_urls)}" if dedup_urls else "") +
          (f" · dedup_titles={len(dedup_titles)}" if dedup_titles else ""))

    # ── Clipboard mode ────────────────────────────────────────────────────────
    if args.clipboard:
        out_path = NEWS_DIR / section_output_path(cfg, date_str).name
        # Inject the explicit save instruction so Gemini writes the HTML
        # to the right path. Without this, Gemini guesses cwd root and
        # the newsletter ends up in C:\Users\<user>\ instead of
        # ~/.ultron/cockpit/news/.
        save_instruction = (
            "\n\n[SAVE INSTRUCTION — CRITICAL]\n"
            f"Save the final HTML to this exact ABSOLUTE path:\n"
            f"  {out_path}\n"
            "Use your file-write tool (e.g. write_file). Do NOT save to the\n"
            "current working directory root. The directory already exists.\n"
            "After saving, confirm with a single line: 'Saved to <path>'.\n"
        )
        full_prompt = prompt + save_instruction
        ok = copy_to_clipboard(full_prompt)
        if ok:
            print("[clipboard] ✓ Prompt copiado al portapapeles.")
            print(f"[clipboard] Gemini guardará el resultado en: {out_path}")
        else:
            print("[clipboard] ✗ No pude copiar. Imprimiendo prompt:\n")
            print(full_prompt)
        return 0

    # ── Gemini headless mode ──────────────────────────────────────────────────
    NEWS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = section_output_path(cfg, date_str)

    print(f"[gemini] Generando con {args.model} (timeout {GEMINI_TIMEOUT_SEC}s)…")
    print(f"[gemini] Output → {out_path}")
    ok, reason = call_gemini(prompt, out_path, args.model)

    if not ok:
        print(f"[error] {reason}")
        print("[tip] Prueba: --clipboard para modo manual, o --model gemini-2.5-flash")
        return 1

    html = out_path.read_text(encoding="utf-8")
    valid, vreason = validate_html(html)
    if not valid:
        print(f"[warn] HTML inválido: {vreason} (archivo guardado para inspección)")
        return 1

    print(f"[ok] HTML válido — {len(html):,} chars  ({reason})")

    flags = extract_audit_flags(html)
    if flags:
        flag_file = write_audit_flags_file(flags)
        print(f"[audit] {len(flags)} skill(s) flagged → {flag_file}")
        for skill, topics in flags.items():
            print(f"        {skill}: {', '.join(topics)}")
    else:
        print("[audit] Sin flags de skill hoy")

    if not args.no_open:
        try:
            webbrowser.open(out_path.as_uri())
            print(f"[browser] Abierto: {out_path}")
        except Exception:
            print(f"[browser] Abre manualmente: {out_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())

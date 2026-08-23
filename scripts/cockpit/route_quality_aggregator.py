#!/usr/bin/env python3
"""
ULTRON v12.4 — Route Quality Aggregator (N2 fix)

Reads ~/.ultron/sessions/*/routing.jsonl and populates route_quality.json
with observed skill-transition data (consecutive Skill tool calls = an edge).

Called from Stop hook to process the current day; or run manually.

Commands:
    aggregate           Process all unprocessed routing.jsonl files
    aggregate --today   Process only today's file
    status              Show edge coverage
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

SESSIONS_DIR   = Path.home() / ".ultron" / "sessions"
CACHE_DIR      = Path.home() / ".ultron" / "skill_cache"
QUALITY_FILE   = CACHE_DIR / "route_quality.json"
WATERMARK_FILE = CACHE_DIR / "aggregator_watermark.json"
# Log escrito por el hook JS vivo (routing-dispatcher.js, línea 37).
# Formato: {"ts":"...", "level":"info", "msg":"high_confidence_routing"|"medium_confidence_routing"|"low_confidence_skip"|"no_match",
#            "top":"persona:<id>"|"agent:<id>"|"skill:<id>", "score":<int>, "confidence":<float>,
#            "second":"...", ...}
# El viejo telemetry/dispatcher-events.jsonl (intent-dispatcher.py) ya no se escribe — ignorado.
DISPATCHER_LOG = Path.home() / ".claude" / "logs" / "routing-dispatcher.jsonl"

WINDOW_SECONDS = 600  # 10-min window: if two Skills are called within this, it's a transition

# A fallback is a transition A→B that walks BACK to fix something: the
# destination is a corrective skill, or A and B live in the same domain (a
# re-route within the same family). Corrective skills are matched by their bare
# name (after stripping any "agent:" prefix and plugin "ns:" namespace), so
# "superpowers:systematic-debugging", "agent:debugger" and "codex:adversarial-review"
# all classify correctly.
CORRECTOR_SKILLS: frozenset[str] = frozenset({
    "debugger",
    "focused-fix",
    "second-opinion",
    "repo-evaluator",
    "systematic-debugging",   # superpowers:systematic-debugging
    "adversarial-review",     # codex:adversarial-review
})

# Cross-referencing dispatcher suggestions against actual invocations: if the
# hook suggested route R but a DIFFERENT skill was invoked within this window,
# the routing decision was corrected.
CORRECTION_WINDOW_SECONDS = 120


def _bare_name(label: str) -> str:
    """Strip the 'agent:' node prefix and any plugin 'ns:' namespace.

    "agent:debugger"                    -> "debugger"
    "superpowers:systematic-debugging"  -> "systematic-debugging"
    "ultron"                            -> "ultron"
    """
    if label.startswith("agent:"):
        label = label[len("agent:"):]
    if ":" in label:
        label = label.rsplit(":", 1)[-1]
    return label


def _domain_of(label: str) -> str:
    """Return the domain/namespace of a node label for same-domain detection.

    Plugin-namespaced labels share a domain when their "ns:" prefix matches
    (e.g. "superpowers:brainstorming" and "superpowers:systematic-debugging"
    are both in the "superpowers" domain). Un-namespaced labels are their own
    domain.
    """
    core = label[len("agent:"):] if label.startswith("agent:") else label
    if ":" in core:
        return core.split(":", 1)[0]
    return core


def _is_fallback(from_label: str, to_label: str) -> bool:
    """A→B is a fallback when B is a corrective skill, or A and B share a
    plugin domain (a re-route inside the same family)."""
    if _bare_name(to_label) in CORRECTOR_SKILLS:
        return True
    dom_from = _domain_of(from_label)
    dom_to   = _domain_of(to_label)
    # Same-domain only counts for genuinely namespaced families (avoid treating
    # two unrelated bare skills as "same domain" just because they equal themselves).
    return dom_from == dom_to and (":" in from_label or ":" in to_label)

# Canonical names for Agent subagent_type values (handles plugin-namespaced variants)
_AGENT_CANONICAL: dict[str, str] = {
    "agent-skills:code-reviewer":         "code-reviewer",
    "agent-skills:README":                "README",
    "agent-skills:security-auditor":      "security-auditor",
    "agent-skills:test-engineer":         "test-engineer",
    "feature-dev:code-explorer":          "feature-dev-explorer",
    "feature-dev:code-architect":         "feature-dev-architect",
    "feature-dev:code-reviewer":          "feature-dev-reviewer",
    "pr-review-toolkit:code-reviewer":    "pr-code-reviewer",
    "pr-review-toolkit:code-simplifier":  "pr-code-simplifier",
    "pr-review-toolkit:comment-analyzer": "pr-comment-analyzer",
    "pr-review-toolkit:pr-test-analyzer": "pr-test-analyzer",
    "pr-review-toolkit:silent-failure-hunter": "pr-silent-failure-hunter",
    "pr-review-toolkit:type-design-analyzer":  "pr-type-analyzer",
    "superpowers:code-reviewer":          "superpowers-reviewer",
    "hookify:conversation-analyzer":      "hookify-analyzer",
}


def _canonical_agent(name: str) -> str:
    return _AGENT_CANONICAL.get(name, name)


def _empty_edge(from_s: str, to_s: str) -> dict:
    return {
        "from": from_s, "to": to_s,
        "runs": 0, "successes": 0, "fallbacks": 0, "corrections": 0,
        "avg_token_cost": 0, "avg_duration_sec": 0,
        "last_outcome": "unknown", "last_used": None,
    }


# ── I/O helpers ───────────────────────────────────────────────────────────────

def load_quality() -> dict:
    if QUALITY_FILE.exists():
        try:
            # utf-8-sig strips the UTF-8 BOM that PowerShell Set-Content adds by default
            return json.loads(QUALITY_FILE.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            print(f"[WARN] route_quality.json parse error (data lost): {exc}", file=sys.stderr)
        except OSError as exc:
            print(f"[WARN] route_quality.json read error: {exc}", file=sys.stderr)
    return {"version": "1.0", "updated": "", "edges": {}}


def save_quality(data: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    data["updated"] = datetime.now().isoformat()
    QUALITY_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8-sig"
    )


def load_watermark() -> dict:
    if WATERMARK_FILE.exists():
        try:
            return json.loads(WATERMARK_FILE.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[WARN] watermark load failed ({exc}), resetting — historical data may recount", file=sys.stderr)
    return {"processed": [], "last_run": None}


def save_watermark(w: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    WATERMARK_FILE.write_text(json.dumps(w, indent=2), encoding="utf-8")


def read_jsonl(path: Path) -> list[dict]:
    entries: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except OSError:
        pass
    return entries


# ── Core logic ────────────────────────────────────────────────────────────────

def _node_label(entry: dict) -> str:
    """Convert a routing entry into the canonical node label used in edge keys.

    Skill targets pass through (e.g. "ultron", "windows-admin").
    Agent targets get the "agent:" prefix + canonicalization (e.g. "agent:Explore",
    "agent:feature-dev-reviewer"). This namespacing prevents collisions when a
    Skill and Agent share a name (e.g. Skill "code-reviewer" vs Agent
    "agent-skills:code-reviewer" → "agent:code-reviewer").
    """
    tool   = entry.get("tool", "")
    target = (entry.get("target") or "").strip()
    if not target:
        return ""
    if tool == "Skill":
        return target
    if tool == "Agent":
        return "agent:" + _canonical_agent(target)
    return ""


def process_entries(entries: list[dict], quality: dict) -> int:
    """Find consecutive transitions across ALL tools (Skill + Agent) and increment
    edge counters.

    Open-world for both Skill→Skill and Agent→Agent (Auditor 3 finding —
    closed-world Skill seeding only covered 11/373 sources, dropping 95% of
    real transitions silently). Edges are namespaced: agent nodes get the
    "agent:" prefix to avoid collisions with same-named skills.

    Cross-tool transitions (Skill→Agent and Agent→Skill, the handoff between
    ULTRON and a delegated agent) are NOW captured — previously they were
    silently invisible because the per-tool split processed each list in
    isolation.

    Parallel-dispatch (3 Agent calls in <1s) collapses to a single edge from
    the previous step (since same-target consecutive calls are deduped via
    same_node guard).

    Dedup: each edge key counted at most once per session pass.

    Returns number of edges updated.
    """
    updated = 0

    # Group by session_id
    by_session: dict[str, list[dict]] = {}
    for e in entries:
        by_session.setdefault(e.get("session_id", "?"), []).append(e)

    for session_entries in by_session.values():
        # Single time-sorted list across BOTH tools — captures cross-tool transitions
        all_calls = sorted(
            (e for e in session_entries if e.get("tool") in ("Skill", "Agent")),
            key=lambda x: x.get("ts", ""),
        )

        seen_this_session: set[str] = set()
        prev_label: str = ""
        prev_ts:    str = ""

        for entry in all_calls:
            label = _node_label(entry)
            if not label:
                continue
            ts = entry.get("ts", "")

            # Skip self-loops (same node consecutively, including parallel dispatch)
            if not prev_label or label == prev_label:
                prev_label = label
                prev_ts    = ts
                continue

            # Time window check
            try:
                ta = datetime.fromisoformat(prev_ts)
                tb = datetime.fromisoformat(ts)
                if not (0 <= (tb - ta).total_seconds() <= WINDOW_SECONDS):
                    prev_label = label
                    prev_ts    = ts
                    continue
            except (ValueError, TypeError):
                prev_label = label
                prev_ts    = ts
                continue

            key = f"{prev_label}→{label}"
            if key not in seen_this_session:
                if key not in quality["edges"]:
                    quality["edges"][key] = _empty_edge(prev_label, label)
                edge = quality["edges"][key]
                edge["runs"] = edge.get("runs", 0) + 1
                is_fallback = _is_fallback(prev_label, label)
                if is_fallback:
                    # Re-route / corrective hop — count as a fallback, NOT a
                    # clean success, so route_quality reflects rework.
                    edge["fallbacks"]    = edge.get("fallbacks", 0) + 1
                    edge["last_outcome"] = "fallback"
                else:
                    edge["successes"]    = edge.get("successes", 0) + 1
                    edge["last_outcome"] = "success"
                edge["last_used"] = ts
                seen_this_session.add(key)
                updated += 1

            prev_label = label
            prev_ts    = ts

    return updated


# ── Corrections (dispatcher-suggested vs actually-invoked) ────────────────────

def _parse_ts(raw: str) -> datetime | None:
    """Parse a routing/telemetry timestamp. Telemetry uses a trailing 'Z'
    (UTC); routing.jsonl is naive local time. Returned datetimes are naive so
    they can be compared within the same source — corrections only ever compare
    telemetry-to-telemetry-aligned windows around a single invocation, so a
    consistent naive comparison is sufficient for proximity scoring."""
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "").strip())
    except (ValueError, TypeError):
        return None


def load_dispatcher_events() -> list[tuple[datetime, str]]:
    """Return sorted (ts, suggested_route) for dispatcher events that carry a
    concrete suggestion, reading the LIVE JS hook log.

    JS hook log format (routing-dispatcher.js @ ~/.claude/logs/routing-dispatcher.jsonl):
        {"ts":"...", "level":"info", "msg":"high_confidence_routing"|"medium_confidence_routing",
         "top":"persona:<id>"|"agent:<id>"|"skill:<id>", "score":<int>, "confidence":<float>}
    Only events with msg in {high_confidence_routing, medium_confidence_routing} carry an
    actionable suggestion — low_confidence_skip and no_match are noise for correction tracking.
    The "top" field maps directly to the candidate label emitted by formatCandidateLabel().
    """
    if not DISPATCHER_LOG.exists():
        return []
    events: list[tuple[datetime, str]] = []
    for ev in read_jsonl(DISPATCHER_LOG):
        msg = ev.get("msg", "")
        # Only routing decisions that actually produced a hint count.
        if msg not in ("high_confidence_routing", "medium_confidence_routing"):
            continue
        top = ev.get("top", "")
        if not top:
            continue
        ts = _parse_ts(ev.get("ts", ""))
        if ts is not None:
            events.append((ts, str(top)))
    events.sort(key=lambda x: x[0])
    return events


def _suggested_near(events: list[tuple[datetime, str]], when: datetime) -> str | None:
    """Most recent dispatcher suggestion within CORRECTION_WINDOW_SECONDS at or
    before `when`. Linear scan is fine for the event volumes involved."""
    best: str | None = None
    best_dt: datetime | None = None
    for ts, route in events:
        if ts > when:
            break
        if 0 <= (when - ts).total_seconds() <= CORRECTION_WINDOW_SECONDS:
            if best_dt is None or ts > best_dt:
                best_dt, best = ts, route
    return best


def annotate_corrections(entries: list[dict], quality: dict,
                         events: list[tuple[datetime, str]]) -> int:
    """Cross-reference dispatcher suggestions against actual invocations.

    When the hook suggested route R but a DIFFERENT skill T was invoked within
    the correction window, the routing was corrected. We bump `corrections` on
    the edge that LANDS on T (its predecessor → T), since that edge represents
    the path actually taken in place of the suggestion.

    No suggestion, or a suggestion that matches what was invoked, is not a
    correction. Dedup: each edge key bumped at most once per pass.
    """
    if not events:
        return 0

    bumped = 0
    seen: set[str] = set()

    by_session: dict[str, list[dict]] = {}
    for e in entries:
        by_session.setdefault(e.get("session_id", "?"), []).append(e)

    for session_entries in by_session.values():
        calls = sorted(
            (e for e in session_entries if e.get("tool") in ("Skill", "Agent")),
            key=lambda x: x.get("ts", ""),
        )
        prev_label = ""
        for entry in calls:
            label = _node_label(entry)
            if not label:
                continue
            when = _parse_ts(entry.get("ts", ""))
            if when is None or not prev_label or label == prev_label:
                prev_label = label
                continue

            suggested = _suggested_near(events, when)
            invoked_bare = _bare_name(label)
            # A correction = a concrete suggestion that differs from what ran.
            if suggested and _bare_name(suggested) != invoked_bare:
                key = f"{prev_label}→{label}"
                if key in quality["edges"] and key not in seen:
                    edge = quality["edges"][key]
                    edge["corrections"] = edge.get("corrections", 0) + 1
                    seen.add(key)
                    bumped += 1

            prev_label = label

    return bumped


# ── Commands ──────────────────────────────────────────────────────────────────

def aggregate(today_only: bool = False) -> None:
    if not SESSIONS_DIR.exists():
        print("No sessions directory — nothing to aggregate")
        return

    watermark    = load_watermark()
    processed    = set(watermark.get("processed", []))
    # Track which session_ids from today have already been counted (idempotency guard)
    today_processed_sids: set[str] = set(
        watermark.get("today_sessions", {}).get(
            datetime.now().strftime("%Y-%m-%d"), []
        )
    )
    quality      = load_quality()
    dispatcher_events = load_dispatcher_events()
    total_updated = 0
    total_corrections = 0
    newly_done: list[str] = []
    today_str = datetime.now().strftime("%Y-%m-%d")

    for day_dir in sorted(SESSIONS_DIR.iterdir()):
        if not day_dir.is_dir():
            continue
        if today_only and day_dir.name != today_str:
            continue

        routing_file = day_dir / "routing.jsonl"
        if not routing_file.exists():
            continue

        file_key = f"{day_dir.name}/routing.jsonl"
        is_today = day_dir.name == today_str

        # Past days: skip if already processed.
        if file_key in processed and not is_today:
            continue

        entries = read_jsonl(routing_file)

        if is_today:
            # Only process sessions not yet counted to prevent double-counting on same-day re-runs
            new_entries = [e for e in entries
                           if e.get("session_id", "?") not in today_processed_sids]
            n = process_entries(new_entries, quality)
            total_corrections += annotate_corrections(new_entries, quality, dispatcher_events)
            # Record all session_ids now present in today's file
            all_today_sids = {e.get("session_id", "?") for e in entries}
            watermark.setdefault("today_sessions", {})[today_str] = sorted(
                today_processed_sids | all_today_sids
            )
            # Prune today_sessions to last 14 days
            cutoff = (datetime.now() - timedelta(days=14)).strftime("%Y-%m-%d")
            watermark["today_sessions"] = {
                k: v for k, v in watermark["today_sessions"].items() if k >= cutoff
            }
        else:
            n = process_entries(entries, quality)
            total_corrections += annotate_corrections(entries, quality, dispatcher_events)
            newly_done.append(file_key)

        total_updated += n
        if n > 0:
            print(f"  {day_dir.name}: {n} edge update(s)")

    # Always save watermark
    watermark["processed"] = sorted(processed | set(newly_done))
    watermark["last_run"] = datetime.now().isoformat()
    save_watermark(watermark)

    # Save when either edges changed OR corrections were annotated onto
    # existing edges (corrections can land without any new edge in this pass).
    if total_updated > 0 or total_corrections > 0:
        save_quality(quality)
        print(f"Total: {total_updated} edge update(s), "
              f"{total_corrections} correction(s) written to route_quality.json")
    else:
        print("No skill-transition data found yet "
              "(edges populate when Skill tool is invoked consecutively in a session)")

    # Show current coverage
    edges = quality.get("edges", {})
    active     = sum(1 for e in edges.values() if e.get("runs", 0) > 0)
    fallbacks  = sum(e.get("fallbacks", 0) for e in edges.values())
    corrections = sum(e.get("corrections", 0) for e in edges.values())
    print(f"Coverage: {active}/{len(edges)} edges have real data "
          f"({fallbacks} fallback(s), {corrections} correction(s) recorded)")

    # Calidad del dispatcher: la medida que SI tiene datos cada dia.
    resumen = aggregate_dispatcher_quality(today_only)
    if "error" in resumen:
        print(f"Dispatcher: {resumen['error']}")
    else:
        dias = resumen.get("dias", {})
        if not dias:
            print("Dispatcher: sin decisiones registradas en la ventana")
        else:
            dia, d = next(reversed(dias.items()))
            sem = d["semantico"]
            print(f"Dispatcher {dia}: {d['decisiones']} decision(es) · "
                  f"resuelto {d['tasa_resuelto']:.0%} · sin ruta {d['tasa_sin_ruta']:.0%} · "
                  f"fallback semantico {sem['disparado']} "
                  f"(vacio {sem['vacio']}, score top1 {sem['score_top1_medio']})")



# ---------------------------------------------------------------------------
# Calidad del DISPATCHER (2026-08-23)
# ---------------------------------------------------------------------------
# Las aristas de arriba miden transiciones entre invocaciones reales de Skill /
# Agent, y su fuente (~/.ultron/sessions/*/routing.jsonl) no la escribe nadie:
# el fichero no existe, asi que este agregador llevaba desde el 2026-05-22
# corriendo en cada Stop — 64 veces solo el 2026-08-23, 532 ms cada una — para
# imprimir "No skill-transition data found yet" y no tocar route_quality.json.
#
# Lo que SI se escribe en cada prompt es el log del dispatcher v3, con la
# decision de routing y su confianza. Eso no dice que skill acabo usandose,
# pero si responde la pregunta util: cuantos prompts resuelve el matcher
# determinista, cuantos caen al fallback semantico, con que score, y cuantos se
# quedan sin ruta. Se agrega aparte para no mezclarlo con las aristas: son dos
# medidas distintas y confundirlas es como este fichero acabo mintiendo.

QUALITY_DISPATCHER_FILE = CACHE_DIR / "dispatcher_quality.json"

# Eventos del log que representan una DECISION de ruta (uno por prompt).
_DECISION_MSGS = {
    "high_confidence_routing": "alta",
    "medium_confidence_routing": "media",
    "low_confidence_skip": "baja_descartada",
    "no_match": "sin_ruta",
}


def aggregate_dispatcher_quality(today_only: bool = False) -> dict:
    """Resume las decisiones del dispatcher del log vivo.

    Devuelve (y persiste) el resumen del dia. `today_only` limita al dia en
    curso; sin el, agrega TODO el log, que es lo que se quiere en una pasada
    manual para ver la serie completa.
    """
    if not DISPATCHER_LOG.exists():
        return {"error": f"no existe {DISPATCHER_LOG}"}

    hoy = datetime.now().strftime("%Y-%m-%d")
    por_dia: dict[str, dict] = {}

    for raw in DISPATCHER_LOG.read_text(encoding="utf-8", errors="replace").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            ev = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        ts = str(ev.get("ts") or "")
        dia = ts[:10]
        if not dia:
            continue
        if today_only and dia != hoy:
            continue

        d = por_dia.setdefault(dia, {
            "fecha": dia,
            "decisiones": 0,
            "por_confianza": {},
            "top_rutas": {},
            "semantico": {"disparado": 0, "vacio": 0, "score_top1_suma": 0.0, "score_top1_n": 0},
            "latencia_ms": {"n": 0, "suma": 0, "max": 0},
        })

        msg = ev.get("msg")
        if msg in _DECISION_MSGS:
            d["decisiones"] += 1
            clase = _DECISION_MSGS[msg]
            d["por_confianza"][clase] = d["por_confianza"].get(clase, 0) + 1
            top = ev.get("top")
            if top:
                d["top_rutas"][top] = d["top_rutas"].get(top, 0) + 1
        elif msg == "semantic_fallback_triggered":
            d["semantico"]["disparado"] += 1
            top3 = ev.get("semantic_top3") or []
            if top3 and isinstance(top3[0], dict):
                score = top3[0].get("score")
                if isinstance(score, (int, float)):
                    d["semantico"]["score_top1_suma"] += float(score)
                    d["semantico"]["score_top1_n"] += 1
        elif msg == "semantic_fallback_empty":
            d["semantico"]["vacio"] += 1
        elif msg in ("v3_hook_complete", "v2_hook_complete"):
            ms = ev.get("total_elapsed_ms")
            if isinstance(ms, (int, float)):
                lat = d["latencia_ms"]
                lat["n"] += 1
                lat["suma"] += int(ms)
                lat["max"] = max(lat["max"], int(ms))

    # Derivados: medias y tasas, calculadas al final para no arrastrar redondeos.
    for d in por_dia.values():
        sem = d["semantico"]
        sem["score_top1_medio"] = (
            round(sem["score_top1_suma"] / sem["score_top1_n"], 4)
            if sem["score_top1_n"] else None
        )
        del sem["score_top1_suma"], sem["score_top1_n"]
        lat = d["latencia_ms"]
        lat["media"] = round(lat["suma"] / lat["n"]) if lat["n"] else None
        del lat["suma"]
        total = d["decisiones"] or 1
        conf = d["por_confianza"]
        d["tasa_resuelto"] = round(
            (conf.get("alta", 0) + conf.get("media", 0)) / total, 4
        )
        d["tasa_sin_ruta"] = round(conf.get("sin_ruta", 0) / total, 4)
        # Solo las 10 rutas mas frecuentes: la cola larga no aporta y engorda el fichero.
        d["top_rutas"] = dict(
            sorted(d["top_rutas"].items(), key=lambda kv: -kv[1])[:10]
        )

    salida = {
        "version": "1.0",
        "updated": datetime.now().isoformat(),
        "fuente": str(DISPATCHER_LOG),
        "dias": dict(sorted(por_dia.items())),
    }
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    QUALITY_DISPATCHER_FILE.write_text(
        json.dumps(salida, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return salida


def status() -> None:
    quality = load_quality()
    edges   = quality.get("edges", {})
    total   = len(edges)
    active  = sum(1 for e in edges.values() if e.get("runs", 0) > 0)
    pct     = int(100 * active / total) if total else 0
    print(f"Route quality: {active}/{total} edges with real data ({pct}%)")

    if active > 0:
        print("\nTop edges by runs:")
        top = sorted(edges.items(), key=lambda x: x[1].get("runs", 0), reverse=True)
        for key, edge in top[:10]:
            print(f"  {key}: runs={edge['runs']} success={edge.get('successes',0)} "
                  f"fallback={edge.get('fallbacks',0)} correction={edge.get('corrections',0)} "
                  f"last={(edge.get('last_used') or 'never')[:19]}")

    wm = load_watermark()
    print(f"\nLast aggregator run: {wm.get('last_run', 'never')}")
    print(f"Processed files:     {len(wm.get('processed', []))}")


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "aggregate":
        aggregate("--today" in sys.argv)
    elif cmd == "status":
        status()
    else:
        print(f"Unknown command: {cmd}. Use: aggregate [--today] | status")
        sys.exit(1)


if __name__ == "__main__":
    main()

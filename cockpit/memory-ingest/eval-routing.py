# Eval de routing: corre orchestrate por caso y mide accuracy@1 / @3
# (agentes + skills combinados). Uso: uv run python eval-routing.py [--bin PATH]
import json, subprocess, sys

BIN = r"C:\Users\USER\.ultron\control-center\src-tauri\target\release\ultron-memory.exe"
if "--bin" in sys.argv:
    BIN = sys.argv[sys.argv.index("--bin") + 1]

# Cada caso: prompt -> nombres aceptables (agente O skill) + intent esperado
CASES = [
    {"p": "arregla el bug de borrow checker en este codigo Rust", "exp": ["debugger", "error-detective", "rust-engineer"], "intent": "bug_fix"},
    {"p": "disena una interfaz bonita para el dashboard", "exp": ["frontend-developer", "react-specialist", "ui-designer", "mike-tyson", "ui-ux-pro-max", "accessibility-tester"], "intent": "ui_design"},
    {"p": "optimiza esta consulta SQL que va muy lenta", "exp": ["performance-engineer", "ultron-perf", "sql-pro", "postgres-pro"], "intent": "performance"},
    {"p": "escribe tests unitarios para el parser", "exp": ["test-automator", "qa-expert"], "intent": "testing"},
    {"p": "audita la seguridad de este endpoint de login", "exp": ["security-auditor", "penetration-tester", "ultron-security"], "intent": "security"},
    {"p": "como voy de finanzas? revisa mis gastos del mes", "exp": ["tio-gilito"], "intent": "memory"},
    {"p": "configura un pipeline de CI/CD con GitHub Actions", "exp": ["devops-engineer", "deployment-engineer", "kubernetes-specialist", "docker-expert"], "intent": "devops"},
    {"p": "refactoriza este modulo sin cambiar el comportamiento", "exp": ["refactoring-specialist", "ultron-refactor"], "intent": "refactor"},
    {"p": "documenta esta API en el README", "exp": ["documentation-engineer", "ultron-docs"], "intent": "docs"},
    {"p": "revisa la arquitectura y el acoplamiento del sistema", "exp": ["architect-reviewer", "ultron-arch"], "intent": "architecture_review"},
    {"p": "implementa netcode para mi juego en Unreal", "exp": ["unreal-engine-engineer", "cpp-pro", "don-claudio"], "intent": "game"},
    {"p": "escribe un shader de agua en GLSL", "exp": ["graphics-programmer", "shader-fundamentals"], "intent": "general"},
]

def names(ctx, key, n):
    return [x.get("name", "") for x in (ctx.get(key) or [])[:n]]

hit1 = hit3 = intent_ok = 0
print(f"{'CASO':40} {'@1':4} {'@3':4} top-3")
for c in CASES:
    try:
        r = subprocess.run([BIN, "orchestrate", c["p"]], capture_output=True, text=True, encoding="utf-8", timeout=60)
        ctx = json.loads(r.stdout.strip())
    except Exception as e:
        print(f"{c['p'][:40]:40} ERR {str(e)[:40]}")
        continue
    agents = names(ctx, "delegate_agents", 5)
    skills = names(ctx, "delegate_skills", 5)
    top1 = agents[0] if agents else ""
    top3 = (agents[:3] + skills[:3])
    exp = set(c["exp"])
    h1 = top1 in exp or (skills and skills[0] in exp)
    h3 = bool(exp & set(top3))
    io = ctx.get("route") == c["intent"]
    hit1 += h1; hit3 += h3; intent_ok += io
    mark1 = "OK" if h1 else "."
    mark3 = "OK" if h3 else "X"
    print(f"{c['p'][:40]:40} {mark1:4} {mark3:4} {', '.join(top3[:3])}")

n = len(CASES)
print("=" * 70)
print(f"intent OK: {intent_ok}/{n} ({100*intent_ok//n}%)")
print(f"accuracy@1: {hit1}/{n} ({100*hit1//n}%)")
print(f"accuracy@3: {hit3}/{n} ({100*hit3//n}%)  <- nota de routing")

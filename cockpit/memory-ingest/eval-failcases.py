# Re-eval de los 32 casos que FALLARON en la verificacion independiente.
# Mide cuantos pasan ahora (accuracy@1 agents, @3 agents+skills).
import json, subprocess, sys

BIN = r"C:\Users\USER\.ultron\control-center\src-tauri\target\release\ultron-memory.exe"
if "--bin" in sys.argv:
    BIN = sys.argv[sys.argv.index("--bin") + 1]
cases = json.load(open(r"C:\Users\USER\.ultron\cockpit\memory-ingest\verify-failcases.json", encoding="utf-8"))

def names(ctx, key, n):
    return [x.get("name", "") for x in (ctx.get(key) or [])[:n]]

h1 = h3 = 0
fails = []
for c in cases:
    try:
        r = subprocess.run([BIN, "orchestrate", c["p"]], capture_output=True, text=True, encoding="utf-8", timeout=60)
        ctx = json.loads(r.stdout.strip())
    except Exception as e:
        fails.append((c["p"][:45], "ERR")); continue
    agents = names(ctx, "delegate_agents", 5)
    skills = names(ctx, "delegate_skills", 5)
    exp = set(c["exp"])
    top1 = agents[0] if agents else ""
    top3 = agents[:3] + skills[:3]
    if top1 in exp:
        h1 += 1
    if exp & set(top3):
        h3 += 1
    else:
        fails.append((c["p"][:45], f"got {', '.join(top3[:3])}"))

n = len(cases)
print(f"Re-eval de {n} casos que ANTES fallaban (0% @3 por definicion):")
print(f"  accuracy@1: {h1}/{n} ({100*h1//n}%)")
print(f"  accuracy@3: {h3}/{n} ({100*h3//n}%)")
print(f"  recuperados (antes 0): {h3}/{n}")
if fails:
    print("  aun fallan @3:")
    for p, g in fails[:12]:
        print(f"    - {p} :: {g}")

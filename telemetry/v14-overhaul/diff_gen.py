import json
from pathlib import Path

base = Path(r"C:\Users\USER\.ultron\telemetry\v14-overhaul")
pre = json.loads((base / "sprint-0-baseline-pre.json").read_text(encoding="utf-8-sig"))
post = json.loads((base / "sprint-0-baseline-post.json").read_text(encoding="utf-8-sig"))

lines = ["# Sprint 0 Baseline Diff", "", "Generated: " + post["timestamp"], ""]
lines.append("| Metric | PRE | POST | Delta |")
lines.append("|--------|-----|------|-------|")
for k in pre:
    if k == "timestamp":
        continue
    pv, qv = pre.get(k), post.get(k)
    if isinstance(pv, (int, float)) and isinstance(qv, (int, float)):
        delta = qv - pv
        delta_str = f"{delta:+.2f}" if isinstance(pv, float) else f"{delta:+d}"
    elif isinstance(pv, list) and isinstance(qv, list):
        added = sorted(set(qv) - set(pv))
        removed = sorted(set(pv) - set(qv))
        bits = []
        if removed:
            bits.append(f"removed: {', '.join(removed)}")
        if added:
            bits.append(f"added: {', '.join(added)}")
        delta_str = "; ".join(bits) if bits else "(no change)"
    else:
        delta_str = "—"
    lines.append(f"| {k} | {pv} | {qv} | {delta_str} |")

out = base / "sprint-0-diff.md"
out.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(out.read_text(encoding="utf-8"))

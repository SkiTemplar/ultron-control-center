"""Extract last N user+assistant text turns from a Claude Code .jsonl session."""
import sys
import json
import io

# Force UTF-8 stdout
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

path = sys.argv[1]
n_turns = int(sys.argv[2]) if len(sys.argv) > 2 else 25

with open(path, "rb") as f:
    raw = f.read()

# Decode, split by newline
lines = raw.decode("utf-8", errors="ignore").split("\n")
lines = [l for l in lines if l.strip()]

turns = []  # list of (role, text)
for line in lines:
    try:
        obj = json.loads(line)
    except Exception:
        continue
    t = obj.get("type", "")
    if t not in ("user", "assistant"):
        continue
    msg = obj.get("message", {})
    content = msg.get("content", "")
    if isinstance(content, str):
        if content.strip():
            turns.append((t, content))
    elif isinstance(content, list):
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "text":
                txt = c.get("text", "")
                if txt.strip():
                    turns.append((t, txt))
            elif c.get("type") == "tool_use":
                name = c.get("name", "")
                ipt = c.get("input", {})
                # Compact tool use signature
                if name == "Bash":
                    cmd = ipt.get("command", "")[:120]
                    turns.append(("tool", f"Bash: {cmd}"))
                elif name in ("Edit", "Write"):
                    fp = ipt.get("file_path", "")
                    turns.append(("tool", f"{name}: {fp}"))
                elif name == "Skill":
                    sk = ipt.get("skill", "")
                    turns.append(("tool", f"Skill: {sk}"))
                elif name == "Agent":
                    desc = ipt.get("description", "")
                    st = ipt.get("subagent_type", "")
                    turns.append(("tool", f"Agent[{st}]: {desc}"))
                elif name == "TodoWrite":
                    todos = ipt.get("todos", [])
                    summary = "; ".join(
                        f"[{t.get('status','?')[0]}] {t.get('content','')[:60]}" for t in todos
                    )
                    turns.append(("tool", f"TodoWrite: {summary[:300]}"))

# Print last N turns
for role, text in turns[-n_turns:]:
    print(f"\n=== {role.upper()} ===")
    print(text[:1500])
    if len(text) > 1500:
        print(f"... [+{len(text)-1500} chars]")

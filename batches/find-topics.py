"""Find user messages and assistant key decisions about specific topics."""
import sys, json, io, re

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

path = sys.argv[1]
# Keywords to search (lowercase)
KEYWORDS = [
    "graphify", "grafify", "mem0", "claude-mem", "ralph", "ruflo", "rufo",
    "workday", "workdays", "ai router", "airouter", "ai-router",
    "detach", "ventana separada", "subagent", "bypass", "multi-model",
    "multi model", "multimodelo", "delegar",
]

with open(path, "rb") as f:
    raw = f.read()
lines = [l for l in raw.decode("utf-8", errors="ignore").split("\n") if l.strip()]

turns = []
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
    ts = obj.get("timestamp", "")
    if isinstance(content, str):
        if content.strip():
            turns.append((ts, t, content))
    elif isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                txt = c.get("text", "")
                if txt.strip():
                    turns.append((ts, t, txt))

# Filter to turns containing any keyword
hits = []
for ts, role, text in turns:
    low = text.lower()
    matched = [k for k in KEYWORDS if k in low]
    if matched:
        hits.append((ts, role, text, matched))

print(f"# Total user/assistant text turns: {len(turns)}")
print(f"# Turns with keyword hits: {len(hits)}\n")

for ts, role, text, matched in hits:
    print(f"\n=== [{ts}] {role.upper()} :: {','.join(matched)} ===")
    # First 1500 chars
    print(text[:2000])
    if len(text) > 2000:
        print(f"... [+{len(text)-2000} chars]")

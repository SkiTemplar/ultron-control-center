"""Smoke test for mcp_broker.is_safe_command — verify metachar rejection."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "cockpit"))
from mcp_broker import is_safe_command, validate_jsonrpc

cases = [
    (["node", "server.js"], True),
    (["node", "/abs/path.js"], True),
    (["node", "a;b"], False),
    (["node", "x|y"], False),
    (["node", "back`tick`"], False),
    (["node", "$dollar"], False),
    (["sh", "&&"], False),
]
fails = 0
for cmd, expect_ok in cases:
    ok, why = is_safe_command(cmd)
    status = "PASS" if ok == expect_ok else "FAIL"
    if status == "FAIL":
        fails += 1
    print(f"  [{status}] {str(cmd):<35} -> ok={ok} (expected {expect_ok})  {why}")

# JSON-RPC validation
print()
rpc_cases = [
    ('{"jsonrpc":"2.0","method":"tools/list","id":1}', True),
    ('not json', False),
    ('{"jsonrpc":"1.0","method":"x"}', False),
    ('{"method":"x"}', False),
    ('{"jsonrpc":"2.0"}', False),
]
for line, expect_ok in rpc_cases:
    ok, why = validate_jsonrpc(line)
    status = "PASS" if ok == expect_ok else "FAIL"
    if status == "FAIL":
        fails += 1
    print(f"  [{status}] rpc {line[:50]:<50} -> ok={ok}  {why}")

print()
print(f"Total fails: {fails}")
sys.exit(0 if fails == 0 else 1)

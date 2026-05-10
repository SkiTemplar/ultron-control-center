# Deadwood Scanner — Hand-labeled Corpus

Gold-standard expectations for the fixture set under
`tests/fixtures/deadwood/`. The scanner must reproduce these exactly
for the test suite to pass.

| Fixture | Line | Kind | Severity | Pattern | Notes |
|---|---|---|---|---|---|
| stub_with_sentinel.ps1 | 6-15 | sentinel | info | ULTRON-DEPRECATED | Valid sentinel — all 3 required fields present, remove-after in 2099. |
| stub_with_sentinel.ps1 | 12 | (suppressed) | — | — | "removed in v12.5" inside the deprecated case body — Phase 2 sentinel-aware suppression silences this heuristic. |
| expired_sentinel.py | 5-11 | sentinel | blocking | ULTRON-DEPRECATED | remove-after = 2020-01-01 < today → promotes to BLOCKING. |
| incomplete_sentinel.py | 2-7 | sentinel | warn | ULTRON-DEPRECATED | Missing `replaced-by` field. |
| unterminated.py | 2 | sentinel | warn | UNTERMINATED-DEPRECATED | Open marker without END. |
| heuristics.py | 5 | heuristic | info | dead_suffix | Function `foo_OLD` matches `_OLD\b`. |
| heuristics.py | 7 | heuristic | warn | removed_in_v | "removed in v1.2.3" on a real comment line (not in docstring). |
| heuristics.py | 10 | heuristic | warn | todo_remove | "TODO: remove this helper". |
| heuristics.py | 15 | heuristic | warn | legacy_marker | "LEGACY — kept around". |
| heuristics.py | 21 | heuristic | info | deprecated_word | "DEPRECATED" word in code (not docstring). |
| clean.py | — | — | — | — | No findings expected. |

## Suppressions verified

- `heuristics.py` lines 1-3 (module docstring): contain "removed in v1.0"
  and "DEPRECATED" but must NOT be flagged because of the docstring mask.
- `heuristics.py` line 6 (function docstring): "DEPRECATED" in here must
  also be suppressed.

## Severity decision matrix

| Condition | Severity |
|---|---|
| Sentinel valid + remove-after ≥ today | info |
| Sentinel missing required field | warn |
| Sentinel remove-after < today | blocking |
| Sentinel opened without END | warn |
| Heuristic confidence MED | warn |
| Heuristic confidence LOW | info |
| Cross-ref missing path | blocking |
| Cross-ref drift / stub | warn |

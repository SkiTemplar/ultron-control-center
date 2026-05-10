# Genesis-14.1 + v14.1.1 — Independent Code Review

Reviewer: Senior Code Reviewer (Claude Opus 4.7, 1M ctx)
Date: 2026-05-08
Scope: 8 commits 9b91494..501fa42 + minor 171c994/4d99589
Repo: `C:\Users\USER\.claude\skills\ultron`

## Executive summary

- **15 findings**: 0 BLOCKING · 4 HIGH · 6 MEDIUM · 5 LOW
- **Risk assessment: LOW** for production use; the sprint is well-tested (611+ green tests) and the new code is defensively written. No data-loss, security-critical, or correctness-fatal issues.
- **Recommendation: SHIP**, but file follow-up tickets for the HIGH-tier items below — most are robustness/UX rather than correctness.

The deadwood scanner, D17/D18 detectors, and clipboard-prompt repair are all solid. The Usage-reset feature is a well-scoped addition with thorough parametrized tests. Most findings fall into "edge cases the current callers never hit" and "stale documentation".

## BLOCKING (production-affecting)

None.

## HIGH (likely bug, should fix soon)

### H1 — `_xref_settings_hooks` regex truncates paths-with-spaces, can emit false-positive `HOOK_PATH_MISSING`

**File**: `scripts/cockpit/deadwood_scanner.py:372`

```python
path_token = re.compile(r"([A-Za-z]:\\[^\s\"']+|/[^\s\"']+|~[^\s\"']*)")
```

The Windows-path branch stops at the first whitespace inside `[^\s\"']+`. So a hook command like `python C:\Program Files\Python\python.exe foo.py` gets matched as `C:\Program` only. `Path("C:\\Program").exists()` is False → emits a BLOCKING `HOOK_PATH_MISSING` finding for a path that actually exists.

This is mitigated today because settings.json hook commands in this codebase wrap paths in double-quotes and the regex's `[^\s\"']+` correctly stops at the quote — so quoted paths never match in the first place. But the moment someone writes an unquoted command with a space-containing path, the scanner fires a spurious BLOCKING that gates the doctor exit code.

**Recommended fix**: detect quoted paths first via `r'"([A-Za-z]:\\[^"]+)"'` and `r"'([A-Za-z]:\\[^']+)'"`, fall back to the unquoted regex only outside string literals. Alternatively, validate the matched path exists OR contains `\`/`/` past the drive letter — if it's truncated to just `C:\Program`, skip rather than flag.

### H2 — `_check_deadwood` detail string leaks `tmp_path` absolute paths in non-home cases

**File**: `scripts/cockpit/doctor.py:1244-1247`

```python
try:
    rel = str(Path(entry.get("file", "?")).relative_to(Path.home()))
except (ValueError, TypeError):
    rel = str(entry.get("file", "?"))
```

`Path.home()` is the *real* home (not patched in `test_doctor_deadwood.py`'s `isolated_home` fixture, which only patches `USERPROFILE`/`HOME` env vars). So in production:

- File under home → relative path like `.claude/skills/ultron/...` — fine.
- File outside home (e.g. system tools, mounted shares) → absolute path leaks into Finding.id and Finding.summary.

Worse, the **module-level** path `DEADWOOD_JSON` uses `os.environ.get("USERPROFILE", os.path.expanduser("~"))` while D18's `_count_skills_on_disk` uses `Path.home()`. These two APIs have different fallback orders on Windows (`Path.home()` consults `USERPROFILE` → `HOMEDRIVE+HOMEPATH` → `HOME`; the env-var pattern only consults `USERPROFILE` → `expanduser`). If `USERPROFILE` is unset but `HOMEDRIVE+HOMEPATH` is set, the two diverge.

**Recommended fix**: pick one helper (`Path.home()` is simpler) and use it consistently. Add a `_HOME = Path.home()` module-level constant, replace both usages.

### H3 — Sync-all step 7 (deadwood) ignores exit code; crashed scanner silently feeds stale data to step 8

**File**: `scripts/cockpit/ultron.ps1:443-444`

```powershell
Write-Host "[7/8] deadwood scanner (refresh deadwood.json sidecar)..." ...
Invoke-Py "deadwood_scanner.py" @("--json", "--report", "--quiet")
```

(no `$rc = ...` capture)

If `deadwood_scanner.py` crashes (Python ImportError, OSError on the audit file write, etc.), `Invoke-Py` returns the non-zero exit code but step 7 ignores it. The sidecar is never refreshed. Step 8's `_check_deadwood` reads the **old** sidecar (still <24h, so no staleness warning) and reports a snapshot that no longer matches the current source tree. False-clean from doctor.

**Recommended fix**:

```powershell
$rc_dw = Invoke-Py "deadwood_scanner.py" @("--json", "--report", "--quiet")
if ($rc_dw -gt 2) {
    Write-Host "  [WARN] deadwood scanner crashed (exit $rc_dw); doctor may report stale data" -ForegroundColor Yellow
}
```

### H4 — `_load_audit_prompt` accepts arbitrary `filename`; trivial path traversal if any caller ever wires it to user input

**File**: `scripts/cockpit/tui.py:600-625`

```python
def _load_audit_prompt(filename: str) -> str | None:
    path = AUDIT_PROMPTS_DIR / filename
    if not path.exists():
        return None
    ...
```

Today every caller passes a hardcoded literal (`"01-memoria.md"`, etc.). But the helper has no path-containment check: `_load_audit_prompt("../../../../etc/passwd")` would succeed if that file existed. Defense-in-depth missing.

**Recommended fix**:

```python
path = (AUDIT_PROMPTS_DIR / filename).resolve()
try:
    path.relative_to(AUDIT_PROMPTS_DIR.resolve())
except ValueError:
    return None
```

This is HIGH (not LOW) because the same loader will likely grow user-input call sites as the prompt library expands — adding the guard now is cheaper than retrofitting it later.

## MEDIUM (smells, future tech debt)

### M1 — `_docstring_mask` only handles `.py`; PowerShell here-strings not masked

**File**: `scripts/cockpit/deadwood_scanner.py:239`

```python
doc_mask = _docstring_mask(lines) if path.suffix == ".py" else None
```

Heuristics fire inside PowerShell `@" ... "@` here-strings, JS template literals, and Python f-strings on a single line. Hit rate today is low (no `LEGACY` or `TODO: remove` strings inside here-strings in this codebase, confirmed by ad-hoc grep), but the architecture is asymmetric — the docstring-mask logic should generalize to language-aware string-literal masking.

**Recommended fix**: extend `_docstring_mask` to a `_string_literal_mask(lines, suffix)` that knows about `@"..."@` (PS), `'''...'''` and `"""..."""` (Py), template literals (JS/TS). Or accept the asymmetry as documented "Python-only" and rename the function.

### M2 — `load_usage_config` validation accepts `bool` as `int`

**File**: `scripts/cockpit/tui.py:704-708`

```python
if isinstance(v, int) and v == max(0, min(v, 6 if key == "weekday" else (...))):
    out[key] = v
```

`isinstance(True, int)` is True in Python. If `usage-config.json` contains `{"weekday": true, "hour": false, "minute": true}`, validation passes (True==1, False==0) and the config silently becomes Mon 00:01. The chance of this happening in practice is near-zero (JSON serializers don't emit bools where ints were originally written), but the validator is technically buggy.

**Recommended fix**: `if isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= max_for_key(key):` — also clearer than the embedded ternary.

### M3 — `parse_reset_input` silently coerces partial-numeric tokens to defaults

**File**: `scripts/cockpit/tui.py:744-756`

Input `"Friday 3.00"` (dot instead of colon) splits to `["friday", "3.00"]`. `parts[1].isdigit()` is False → hour stays at the default `0`. Returns `(4, 0, 0)` instead of failing or asking. The user thinks they set Friday 03:00, the system stored Friday 00:00. UX gap.

**Recommended fix**: when `parts[1]` is non-empty but non-digit, return `None` rather than silently using the default. Same for `parts[2]`.

### M4 — `_xref_health_expected_scripts` silently no-ops when `health.py` has a syntax error

**File**: `scripts/cockpit/deadwood_scanner.py:424-425`

```python
except (SyntaxError, ValueError):
    return []
```

If health.py becomes unparseable (someone introduces a syntax error during a refactor), the deadwood drift detector silently returns no findings. Combined with the fact that `health.py` self-reports green when run from CLI, an unparseable health.py could ship without either tool catching the regression.

**Recommended fix**: when `ast.parse` fails, emit a `HEALTH_PY_UNPARSEABLE` warning instead of returning []:

```python
except (SyntaxError, ValueError) as exc:
    return [Finding(file=str(health), kind="xref", severity="warn",
                    pattern="HEALTH_PY_UNPARSEABLE",
                    snippet=f"ast.parse failed: {exc}")]
```

### M5 — `_PS1_CASE` regex misses single-quoted and `default`/keyword cases

**File**: `scripts/cockpit/deadwood_scanner.py:314`

```python
_PS1_CASE = re.compile(r'^\s*"([\w-]+)"\s*\{')
```

Doesn't match `'auth' {`, `default {`, or wildcard `* {`. Today every case in `ultron.ps1` uses double-quoted strings, but the next contributor copying patterns from PS docs may mix styles, and the scanner will miss those stubs.

**Recommended fix**: extend to `r'^\s*("?)([\w-]+|default|\*)\1\s*\{'`. Or document the limitation in the module docstring.

### M6 — `tests/fixtures/deadwood-corpus.md` is out of sync with Phase 2 (heuristic suppression)

**File**: `tests/fixtures/deadwood-corpus.md:10`

The corpus claims `stub_with_sentinel.ps1` line 12 produces a `removed_in_v` heuristic warning. After Phase 2's sentinel-aware suppression, that heuristic is **suppressed** — the line is inside the `@ULTRON-DEPRECATED` block (lines 6-15). The corpus no longer matches reality.

Tests don't catch this because no test asserts on the corpus directly — it's documentation only. But it's a maintenance hazard: future contributors will assume the corpus is authoritative.

**Recommended fix**: regenerate the corpus from a live `_scan_one(stub_with_sentinel.ps1)` call. Or delete the corpus file; the test fixtures + tests are sufficient as gold-standard.

## LOW (style / nice-to-have)

### L1 — `_sentinel_mask` silently ignores stray `@ULTRON-DEPRECATED-END` markers

**File**: `scripts/cockpit/deadwood_scanner.py:217-234`

A close marker without a matching open is a no-op. Could be promoted to a WARN finding (`STRAY_DEPRECATED_END`).

### L2 — `_check_deadwood` summary leaks negative hours on clock skew

**File**: `scripts/cockpit/doctor.py:1205`

`f"Deadwood scan is {age_h:.1f}h old"` with `age_h < 0` (mtime in the future, e.g., after a clock-skew incident) prints `-3.0h old`. Cosmetic.

### L3 — `_PS1_STUB` body extraction includes trailing newlines from the *next* case

**File**: `scripts/cockpit/deadwood_scanner.py:340-343`

`end = min(next_start - 1, start + 20)` and `body = "\n".join(lines[start:end])`. The slice excludes the next case header but may include a closing brace and blank lines. Not a bug — the regex `removed in v...` only fires on actual content — but the body is slightly larger than necessary, and `start + 20` is a magic number. Consider `case_body_lookahead = 20` as a named constant.

### L4 — `_count_skills_on_disk` over-counts marketplace cache duplicates

**File**: `scripts/cockpit/doctor.py:1310-1312`

`plugin_dir.rglob("SKILL.md")` walks `plugins/cache/` too, double-counting marketplace SKILL.md files that exist in both the active install and the cache. The phase-6 audit already noted this. The detector would still warn (catalog is large) but with an inflated count.

Recommended: skip `cache/` and `**/_cache/`:

```python
for skill_md in plugin_dir.rglob("SKILL.md"):
    if "cache" in skill_md.parts:
        continue
    counts["plugin"] += 1
```

### L5 — `Finding.fields` is `dict` not `dict[str, Any]` (type hint precision)

**File**: `scripts/cockpit/deadwood_scanner.py:124`

Bare `dict` loses all generic info under `from __future__ import annotations`. Mostly cosmetic but affects mypy strictness.

## Tests review

### Coverage gaps

1. **D17 — non-standard severity values**: no test covers what happens when a deadwood entry has `severity: "warning"` (typo) or `severity: null`. Code uses `f.get("severity") == "blocking"/"warn"`, so unknown values are silently dropped — but no test pins this.

2. **D17 — non-dict entries in JSON list**: the filter `isinstance(f, dict)` is uncovered. A malformed entry (e.g., a stray string) is silently filtered. Worth a 1-line negative test.

3. **D18 — symlink loops in skills tree**: `rglob` follows symlinks (path-dependent on Python version). No test ensures loop tolerance.

4. **`_xref_settings_hooks` — paths with spaces**: H1 above is uncovered. Adding the test would have caught it.

5. **`_xref_health_expected_scripts` — unparseable health.py**: M4 above. No test for `ast.parse` failure path.

6. **`load_usage_config` — bool-as-int corruption**: M2 above. A malformed JSON like `{"weekday": true}` is silently accepted.

7. **`compute_week_window` — DST boundaries**: no test where `now` straddles a DST transition. `datetime.replace(hour=...)` plus `timedelta(days=...)` does not handle DST correctly because both inputs are naive. The current code is "good enough" for ULTRON's use case (rough weekly bar) but a test would document the contract.

### Brittleness / false-positive risk

- `test_d17_warn_findings_collapse_to_one_summary` checks `"removed_in_v" in warns[0].detail`. The `detail` string is `"Top patterns: " + ", ".join(sorted({...}))`. Test passes today because the set contains exactly two patterns. If the dict iteration order ever changed (e.g., Python 3.x dict semantics regression), the assertion holds since it just checks `in`. **Solid**.

- `test_audit_prompt_loads_with_content` parametrizes over `tui.AUDIT_BUTTONS`. Each prompt must contain all six section names. **However**, the test does substring matching — a prompt that says "INPUTS happen here" but doesn't actually structure inputs would still pass. False-positive risk if a future prompt is sloppy.

- `test_window_at_anchor_starts_now` asserts `s == datetime(2026, 5, 8, 3, 0)` — uses naive datetime. Brittle if anyone introduces tz-awareness.

### Determinism

- `test_run_scan_is_idempotent` only checks `(file, line_start, pattern, severity)` tuples are equal across runs. Doesn't pin field-dict equality. Sufficient for the determinism contract. ✓

- `test_render_markdown_groups_by_severity` checks ordering by `index()`. Solid.

## Cross-cutting observations

1. **Inconsistent home-path resolution**: `os.environ.get("USERPROFILE", os.path.expanduser("~"))` (deadwood_scanner, doctor module level) vs `Path.home()` (D18, D17 inside the detector). Pick one, document the choice. See H2.

2. **Magic numbers**: `SURFACE_LIMIT = 5` (doctor), `start + 20` (deadwood ps1 body lookahead), `200` (D18 default threshold). Most are named or rule-driven, but the `+20` is bare.

3. **Silent-failure pattern**: at least three places return `[]` rather than emit a warning when something is wrong (deadwood_scanner `_xref_health_expected_scripts` on parse error, deadwood_scanner `_iter_targets` on missing root, doctor `_check_deadwood` shape-malformed). For a *system-health* tool, "silence" is the wrong default — every silent return should at least log to a debug channel or emit an INFO finding.

4. **Spanish-mixed strings in user-facing error messages**: `"Prompt vacío o no encontrado: {filename}"`, `"Newsletter template error: {exc}"`. Inconsistent — pick one language for the TUI surface. Today Spanish dominates for user-facing text and English for log/debug; the new code mostly follows that, but `"Newsletter template error"` breaks the pattern.

5. **Dataclass `Finding` has two implementations**: one in `deadwood_scanner.py:115`, one in `doctor.py` (different fields). Both are called `Finding`. They share enough conceptual overlap that future maintainers will conflate them. Consider renaming one (`DeadwoodFinding` / `DoctorFinding`) or factoring a base class into `cockpit_base.py`.

6. **Test isolation**: `test_doctor_deadwood.py` patches env vars; `test_doctor_skill_truncation.py` patches `Path.home`. The two strategies should be unified — pick one fixture style and reuse across all doctor tests.

7. **Untested phase-2 sentinel-block-ends-EOF behavior**: when an `@ULTRON-DEPRECATED-END` is the last line of the file, `_sentinel_mask` correctly handles it (close inside the loop body). But there's no fixture for this exact case — the `unterminated.py` fixture covers the inverse. A 3-line `wrapped_at_eof.py` fixture would close the loop.

---

**Bottom line**: ship v14.1.1. Open follow-up issues for H1, H2, H3, H4. The sprint is in good shape — these are robustness refinements, not safety blockers.

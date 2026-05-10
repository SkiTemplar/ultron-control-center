# Deadwood Scanner — 2026-05-07 17:58

Total findings: **26**  (blocking=0, warn=11, info=15)

Findings by kind: heuristic=14, sentinel=6, xref=6.

## WARN (11)

- `.claude\skills\ultron\scripts\cockpit\health.py:L0` `[xref/HEALTH_EXPECTED_SCRIPTS_DRIFT]` 69 cockpit scripts not declared in EXPECTED_SCRIPTS
  - `{"missing_count": 69, "sample": ["_categorize_skills.py", "agent_manifest.py", "alerts.py", "apply_proposals.py", "audit_index.py", "audit_silent_exec.py", "audit_to_pending.py", "background_tasks.py", "brain_config.py", "brain_index.py"]}`
- `.claude\skills\ultron\scripts\cockpit\launch_project.py:L151` `[heuristic/removed_in_v]` pass  # activity.jsonl removed in v12.2
  - `{"confidence": "MED"}`
- `.claude\skills\ultron\scripts\cockpit\route_quality.py:L91` `[heuristic/removed_in_v]` # USER_signal removed in v12.5 (Auditor 3): field was 100% "unknown"
  - `{"confidence": "MED"}`
- `.claude\skills\ultron\scripts\cockpit\tui.py:L213` `[heuristic/removed_in_v]` return []  # activity.jsonl removed in v12.3
  - `{"confidence": "MED"}`
- `.claude\skills\ultron\scripts\cockpit\tui.py:L217` `[heuristic/removed_in_v]` return {}  # auth-vault removed in v12.3
  - `{"confidence": "MED"}`
- `.claude\skills\ultron\scripts\cockpit\tui.py:L708` `[heuristic/removed_in_v]` # Activity 24h — removed in v12.3 (activity.jsonl gone)
  - `{"confidence": "MED"}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L201` `[heuristic/removed_in_v]` # Auth vault and Usage blocks were removed in v12.5 (cockpit reorg dropped
  - `{"confidence": "MED"}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L372-384` `[xref/STUB_DISPATCH]` switch case "uninstall" body announces removal
  - `{"command": "uninstall", "sentinel_wrapped": false}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L373` `[heuristic/removed_in_v]` # list/enable/disable/edit/chat removed in v12.5 - schedule_editor.py
  - `{"confidence": "MED"}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L379` `[heuristic/removed_in_v]` Write-Host "(list/edit/chat were removed in v12.5 - edit schedule.json directly)" -ForegroundColor Gray
  - `{"confidence": "MED"}`
- `.claude\skills\ultron\scripts\cockpit\usage_report.py:L25` `[heuristic/removed_in_v]` # TELEMETRY_DIR removed in v12.5 (telemetry.py was dead pipeline)
  - `{"confidence": "MED"}`

## INFO (15)

- `.claude\skills\ultron\scripts\cockpit\auto_updater.py:L318-477` `[sentinel/ULTRON-DEPRECATED]` # @ULTRON-DEPRECATED:14.0.0
  - `{"owner": "USER", "reason": "not surfaced in TUI since v12.4 (Kirkardo clipboard prompts replaced this pipeline)", "remove-after": "2026-11-07", "replaced-by": "cockpit/tui/prompts/* clipboard prompts launched from the Skills tab", "version": "14.0.0"}`
- `.claude\skills\ultron\scripts\cockpit\auto_updater.py:L546-616` `[sentinel/ULTRON-DEPRECATED]` # @ULTRON-DEPRECATED:14.0.0
  - `{"owner": "USER", "reason": "not surfaced in TUI since v12.4 (Kirkardo clipboard prompts replaced this pipeline)", "remove-after": "2026-11-07", "replaced-by": "cockpit/tui/prompts/* clipboard prompts launched from the Skills tab", "version": "14.0.0"}`
- `.claude\skills\ultron\scripts\cockpit\deadwood_scanner.py:L82` `[heuristic/deprecated_word]` r"^\s*(?:#|//|--)+\s*@ULTRON-DEPRECATED:(?P<version>[\w.\-]+)\s*$"
  - `{"confidence": "LOW"}`
- `.claude\skills\ultron\scripts\cockpit\deadwood_scanner.py:L91` `[heuristic/deprecated_word]` r"^\s*(?:#|//|--)+\s*@ULTRON-DEPRECATED-END\s*$"
  - `{"confidence": "LOW"}`
- `.claude\skills\ultron\scripts\cockpit\deadwood_scanner.py:L166` `[heuristic/deprecated_word]` pattern="ULTRON-DEPRECATED",
  - `{"confidence": "LOW"}`
- `.claude\skills\ultron\scripts\cockpit\deadwood_scanner.py:L187` `[heuristic/deprecated_word]` pattern="UNTERMINATED-DEPRECATED",
  - `{"confidence": "LOW"}`
- `.claude\skills\ultron\scripts\cockpit\deadwood_scanner.py:L188` `[heuristic/deprecated_word]` snippet="open marker without matching @ULTRON-DEPRECATED-END",
  - `{"confidence": "LOW"}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L557-569` `[sentinel/ULTRON-DEPRECATED]` # @ULTRON-DEPRECATED:14.0.0
  - `{"owner": "USER", "reason": "auth_vault.py / auth_wizard.py / auth-vault.ps1 dropped in v12.5 cockpit reorg", "remove-after": "2026-11-07", "replaced-by": "Windows Credential Manager (cmdkey) or environment variables", "version": "14.0.0"}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L562-570` `[xref/STUB_DISPATCH]` switch case "auth" stub (already sentinel-annotated)
  - `{"command": "auth", "sentinel_wrapped": true}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L667-677` `[sentinel/ULTRON-DEPRECATED]` # @ULTRON-DEPRECATED:14.0.0
  - `{"owner": "USER", "reason": "usage_tracker.py dropped in v12.5 cockpit reorg", "remove-after": "2026-11-07", "replaced-by": "claude /usage (interactive native command)", "version": "14.0.0"}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L672-678` `[xref/STUB_DISPATCH]` switch case "usage" stub (already sentinel-annotated)
  - `{"command": "usage", "sentinel_wrapped": true}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L874-884` `[sentinel/ULTRON-DEPRECATED]` # @ULTRON-DEPRECATED:14.0.0
  - `{"owner": "USER", "reason": "usage_limits.py dropped in v12.5 cockpit reorg", "remove-after": "2026-11-07", "replaced-by": "claude /usage (window limits visible there)", "version": "14.0.0"}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L879-885` `[xref/STUB_DISPATCH]` switch case "limits" stub (already sentinel-annotated)
  - `{"command": "limits", "sentinel_wrapped": true}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L1048-1060` `[sentinel/ULTRON-DEPRECATED]` # @ULTRON-DEPRECATED:14.0.0
  - `{"owner": "USER", "reason": "telemetry.py + telemetry.db were dead pipeline (4 hand-typed rows ever, no automatic writer)", "remove-after": "2026-11-07", "replaced-by": "routing.jsonl + route_quality_aggregator.py + usage_report.py", "version": "14.0.0"}`
- `.claude\skills\ultron\scripts\cockpit\ultron.ps1:L1053-1061` `[xref/STUB_DISPATCH]` switch case "telemetry" stub (already sentinel-annotated)
  - `{"command": "telemetry", "sentinel_wrapped": true}`

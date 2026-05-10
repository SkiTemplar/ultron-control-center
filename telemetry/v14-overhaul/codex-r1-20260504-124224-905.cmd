@echo off
cd /d "C:\Users\USER\.claude\skills\ultron"
codex exec --sandbox read-only -m gpt-5.5 --output-schema "C:\Users\USER\.claude\skills\ultron\references\codex-duet-schema.json" -o "C:\Users\USER\.ultron\telemetry\v14-overhaul\codex-r1-20260504-124224-905.json" --json --skip-git-repo-check --ignore-user-config - < "C:\Users\USER\.ultron\telemetry\v14-overhaul\prompt-r1-20260504-124224-905.txt" > "C:\Users\USER\.ultron\telemetry\v14-overhaul\codex-r1-20260504-124224-905.jsonl" 2>> "C:\Users\USER\.ultron\telemetry\v14-overhaul\codex-r1-20260504-124224-905.err.txt"

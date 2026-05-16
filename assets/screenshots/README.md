# ULTRON — Screenshots

This directory holds the hero shots embedded in the main `README.md` /
`README.es.md`. Each file below is referenced by name from the README;
swap in real captures any time without touching the README itself.

## Slot reference

| Filename                       | Where it shows up        | What to capture |
| ------------------------------ | ------------------------ | --------------- |
| `dashboard.png`                | Quick start / hero       | The Dashboard tab with the Full Diagnostic grid + Maintenance panel visible. No personal alerts visible. |
| `skills-quarantined.png`       | Features / Security      | Skills tab with the Quarantined filter pill active and the Security panel of a real finding open. |
| `memory-graph.png`             | Architecture / Memory    | Memory tab on the Force graph with several clusters and the search box visible. |
| `plans-kanban.png` *(opt)*     | Features / Plans         | Plans tab kanban view with a couple of in-progress and resolved entries. |
| `settings-lifecycle.png` *(opt)* | App lifecycle         | Settings -> App lifecycle showing Update + Uninstall cards. |

## Capture guidelines

- **Window size**: 1440×900 or 1600×1000. Avoid tiny snapshots.
- **Theme**: dark (default ULTRON theme).
- **Privacy**: scrub anything with a real path under `C:\Users\<name>\` —
  rename the user folder with image-edit blur or temporarily install
  ULTRON under a generic user before capturing.
- **Format**: PNG. Crop tightly to the app window (no Windows chrome).
- **Naming**: keep the exact filenames above so the README references
  resolve.

## Pending

Slots are unfilled in the current release. The README links them with
`<!-- screenshot pending -->` HTML comments so missing files don't break
the page render — markdown renders the alt text in place.

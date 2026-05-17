# How to add a new AI button prompt

Every Control Center button that opens an AI session reads its prompt from a
single source: the button-prompts catalog in
`src-tauri/src/button_prompts.rs::build_defaults`. The Settings tab exposes
that catalog automatically so the user can tweak any prompt at runtime —
no recompile, no source edit.

Adding a new button is three steps:

---

## 1. Define the catalog entry

Open `src-tauri/src/button_prompts.rs` and add a `default_button(...)` line
inside `build_defaults()`:

```rust
default_button(
    "mytab.my_action",           // key — kebab-case, stable. namespace by tab.
    "MyTab · My action",          // label — shown in Settings list
    "MyTab / header MyAction",    // location — where the button physically lives
    "Spawns a Claude session that does X.",  // description — one liner
    "my_action",                  // zone — AI Router zone key (or "" to skip routing)
    &["foo", "bar"],              // vars — names of {var} placeholders
    "Do the thing with {foo} and {bar}. Read GUIDE.md first.",
),
```

The fields:

| Field           | Purpose                                                            |
|-----------------|--------------------------------------------------------------------|
| `key`           | Stable id. Convention: `<tab>.<action>` in kebab-case.             |
| `label`         | What Settings shows the user.                                      |
| `location`      | UX hint — "Skills / detail header", "Plans / row Resolve", etc.    |
| `description`   | One-line explanation of what the prompt does.                      |
| `zone`          | AI Router zone the button routes through. Empty string skips the router. |
| `vars`          | `{var}` placeholders the consumer must fill via `getPrompt(key, vars)`. |
| `prompt`        | Default prompt template. `{var}` substitutions happen at call time.|

---

## 2. Call `getPrompt` (or `resolveAndSpawn`) in the component

Replace the hardcoded string literal in the component with a catalog lookup:

```tsx
// Before:
await invoke("spawn_session", {
  provider: "claude",
  prompt: "Hardcoded prompt text...",
  cwd,
});

// After:
const { getPrompt } = await import("../lib/button-prompts");
const prompt = await getPrompt("mytab.my_action", { foo: "x", bar: "y" });
await invoke("spawn_session", { provider: "claude", prompt, cwd });
```

If your button also wants the AI Router to pick provider/model/agent, use
`resolveAndSpawn` instead — it loads the prompt AND routes the session in
one call:

```tsx
const { resolveAndSpawn } = await import("../lib/button-prompts");
const { resolved } = await resolveAndSpawn({
  key: "mytab.my_action",
  vars: { foo: "x", bar: "y" },
  cwd,
});
```

`resolveAndSpawn` honours the catalog entry's `zone`. When the zone is
`""`, the helper skips the router and falls back to `provider: "claude"`.

---

## 3. Confirm the Settings UI picks it up automatically

Open the Control Center → **Settings → Button prompts**. The catalog merges
the on-disk overrides (in `~/.ultron/cockpit/button-prompts.json`) on top of
the defaults at every read, so a new entry shows up the next time the panel
loads. Nothing else to wire up.

The user can:

- Edit the prompt inline → persisted as an override in the JSON file.
- Hit **Reset** → drops the override, falls back to the canonical default.
- Inspect `vars` / `zone` / `location` to understand what the prompt expects.

---

## Notes

- **Atomicity**: writes go through `tmp + rename`. A crash mid-save can never leave the catalog truncated.
- **Backward compatibility**: only overrides are persisted. Removing a key in code is safe — the override on disk becomes a no-op.
- **Variables**: every `{name}` placeholder in the prompt must appear in the `vars` slice. The helper does NOT auto-detect them at runtime; we rely on the catalog metadata so Settings can warn the user when an override is missing a placeholder.
- **Empty zone**: use `""` when the button intentionally bypasses the AI Router (e.g. a hardcoded `/usage` slash command that doesn't need provider/model selection).
- **Migration checklist** when promoting an existing hardcoded prompt:
  1. Add the catalog entry in `button_prompts.rs::build_defaults`.
  2. Replace the literal with `getPrompt(key, vars)`.
  3. Run `cargo check` and `tsc --noEmit` to confirm.
  4. Open the app, hit the button once, verify the session starts with the right prompt.
  5. Toggle the override in Settings, confirm the new text is used.

---

## Tests

`src-tauri/src/button_prompts.rs` ships three unit tests:

- `interpolation_replaces_vars` — sanity check on `{var}` substitution.
- `default_catalog_has_seed_entries` — every default entry has a non-empty prompt, `prompt == default_prompt`, `overridden == false`.
- `merge_overrides_overlays_default_atomic` — simulates the merge step without disk I/O.

Add a spot-check assertion to `default_catalog_has_seed_entries` if your
new key is critical (e.g. a default that ships in the wizard). Otherwise
the size assertion (`defaults.len() >= 10`) is enough.

---

## File reference

| Path                                                                       | Role                                          |
|----------------------------------------------------------------------------|-----------------------------------------------|
| `src-tauri/src/button_prompts.rs`                                          | Catalog defaults + merge logic.               |
| `src-tauri/src/commands/button_prompts.rs`                                 | Tauri commands exposed to the frontend.       |
| `src/lib/button-prompts.ts`                                                | TS helper: `getPrompt`, `resolveAndSpawn`.    |
| `src/components/Settings/ButtonPromptsSection.tsx`                         | Settings UI panel (auto-renders every entry). |
| `~/.ultron/cockpit/button-prompts.json`                                    | On-disk overrides (user-editable JSON).       |

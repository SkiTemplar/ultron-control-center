// v2.5.2 (wave 2): GeneralSection retired.
//
// The "General" sub-tab now renders <LifecyclePanel /> directly, which
// merges what used to be split across two tabs:
//   - Old "General" (autostart + welcome screen + hotkey editors)
//   - "App lifecycle" (autostart + rebuild + close)
//
// Hotkey editors other than the global open/hide combo were dropped per
// USER: only the "open ULTRON" hotkey survived. The single global
// hotkey editor was inlined into LifecyclePanel.tsx.
//
// This file is intentionally kept (empty stub) instead of deleted so any
// stale comment referencing it (e.g. Onboarding.tsx mentions "Settings →
// General") still resolves in git blame archaeology. Nothing imports it.

export {};

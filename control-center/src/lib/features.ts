// ULTRON Control Center — Feature toggles hook
//
// Mirrors the Rust `Features` struct in `src-tauri/src/features.rs`. The
// installer writes `~/.ultron/cockpit/features.json`; the backend reads it
// and we surface the result through `useFeatures()`.
//
// Cache strategy: we keep a module-level state + a Set of subscribers so
// multiple components can mount `useFeatures()` without each triggering an
// extra Tauri invoke and so a `saveFeatures()` followed by `refresh()`
// propagates to every consumer at once.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Features = {
  news: boolean;
  gaming: boolean;
  personal: boolean;
  schedules: boolean;
  self_improve: boolean;
  memory: boolean;
  plans: boolean;
  projects: boolean;
  mcps: boolean;
  skills: boolean;
  hooks: boolean;
  // v15.4 — wizard toggles surfaced in the sidebar.
  notifications: boolean;
  usage: boolean;
  sessions: boolean;
};

/** All toggles enabled — the safe default for a fresh install. */
export const ALL_ENABLED: Features = {
  news: true,
  gaming: true,
  personal: true,
  schedules: true,
  self_improve: true,
  memory: true,
  plans: true,
  projects: true,
  mcps: true,
  skills: true,
  hooks: true,
  notifications: true,
  usage: true,
  sessions: true,
};

// Module-level cache so multiple consumers share state.
let cached: Features = ALL_ENABLED;
let loaded = false;
let inflight: Promise<Features> | null = null;
const subscribers = new Set<(f: Features, loading: boolean) => void>();

function notify(loading: boolean) {
  subscribers.forEach((cb) => cb(cached, loading));
}

async function loadOnce(force = false): Promise<Features> {
  if (!force && loaded) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const f = (await invoke("read_features")) as Features;
      cached = { ...ALL_ENABLED, ...f };
      loaded = true;
      notify(false);
      return cached;
    } catch {
      // Backend unavailable — fall back to all-enabled so the sidebar
      // never goes empty.
      cached = ALL_ENABLED;
      loaded = true;
      notify(false);
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useFeatures(): {
  features: Features;
  loading: boolean;
  refresh: () => void;
} {
  const [features, setFeatures] = useState<Features>(cached);
  const [loading, setLoading] = useState<boolean>(!loaded);

  useEffect(() => {
    const cb = (f: Features, l: boolean) => {
      setFeatures(f);
      setLoading(l);
    };
    subscribers.add(cb);
    if (!loaded) {
      setLoading(true);
      loadOnce().catch(() => {});
    } else {
      setFeatures(cached);
      setLoading(false);
    }
    return () => {
      subscribers.delete(cb);
    };
  }, []);

  function refresh() {
    setLoading(true);
    notify(true);
    loadOnce(true).catch(() => {});
  }

  return { features, loading, refresh };
}

/**
 * Persist the toggle map and update the in-memory cache so subscribers
 * react immediately (no need to wait for a refresh round-trip).
 */
export async function saveFeatures(next: Features): Promise<void> {
  await invoke("save_features", { features: next });
  cached = { ...ALL_ENABLED, ...next };
  loaded = true;
  notify(false);
}

/** Keys that map 1:1 to a sidebar item. Used by Sidebar.tsx for filtering. */
export const FEATURE_KEYS: ReadonlyArray<keyof Features> = [
  "news",
  "gaming",
  "personal",
  "schedules",
  "self_improve",
  "memory",
  "plans",
  "projects",
  "mcps",
  "skills",
  "hooks",
  "notifications",
  "usage",
  "sessions",
] as const;

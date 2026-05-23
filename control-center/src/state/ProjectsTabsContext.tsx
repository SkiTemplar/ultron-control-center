// ULTRON Control Center 2.0 — Projects tabs global state
//
// React Context that owns the list of open tabs (Projects home + N projects),
// the current selection, and persistence to `~/.ultron/cockpit/open-tabs.json`
// via the `tabs_load` / `tabs_save` Tauri commands.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OpenTab } from "../types";

type TabsState = {
  tabs: OpenTab[];
  currentId: string;
  open: (tab: { id: string; title: string }) => void;
  close: (id: string) => void;
  select: (id: string) => void;
  reorder: (id: string, beforeId: string | null) => void;
  rename: (id: string, title: string) => void;
};

const Ctx = createContext<TabsState | null>(null);

const HOME_TAB: OpenTab = {
  id: "home",
  kind: "home",
  title: "Projects",
  order: 0,
};

export function ProjectsTabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<OpenTab[]>([HOME_TAB]);
  const [currentId, setCurrentId] = useState<string>("home");
  const persistTimer = useRef<number | null>(null);
  const hydrated = useRef(false);

  // Hydrate from disk on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = (await invoke("tabs_load")) as OpenTab[];
        if (cancelled) return;
        if (loaded && loaded.length > 0) {
          setTabs(loaded);
        }
      } catch {
        // Keep default HOME_TAB on failure.
      } finally {
        hydrated.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced persist on tabs change.
  useEffect(() => {
    if (!hydrated.current) return;
    if (persistTimer.current !== null) {
      window.clearTimeout(persistTimer.current);
    }
    persistTimer.current = window.setTimeout(() => {
      void invoke("tabs_save", { tabs });
    }, 300);
    return () => {
      if (persistTimer.current !== null) {
        window.clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
    };
  }, [tabs]);

  const open = useCallback(({ id, title }: { id: string; title: string }) => {
    setTabs((prev) => {
      if (prev.some((t) => t.id === id)) return prev;
      const order = prev.length;
      return [...prev, { id, kind: "project", title, order }];
    });
    setCurrentId(id);
  }, []);

  const close = useCallback(
    (id: string) => {
      if (id === "home") return; // home tab is fixed
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        return next.map((t, i) => ({ ...t, order: i }));
      });
      setCurrentId((cur) => {
        if (cur !== id) return cur;
        const next = tabs.filter((t) => t.id !== id);
        return next.length > 0 ? next[next.length - 1].id : "home";
      });
    },
    [tabs],
  );

  const select = useCallback((id: string) => {
    setCurrentId(id);
  }, []);

  const reorder = useCallback((id: string, beforeId: string | null) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const item = prev[idx];
      const without = prev.filter((t) => t.id !== id);
      let insertAt = beforeId
        ? without.findIndex((t) => t.id === beforeId)
        : without.length;
      if (insertAt === -1) insertAt = without.length;
      // Never allow placing anything before the home tab.
      if (beforeId === "home") insertAt = 1;
      if (insertAt === 0 && item.id !== "home") insertAt = 1;
      const next = [...without.slice(0, insertAt), item, ...without.slice(insertAt)];
      return next.map((t, i) => ({ ...t, order: i }));
    });
  }, []);

  const rename = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }, []);

  // Ctrl+Tab cycling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        setTabs((prev) => {
          if (prev.length <= 1) return prev;
          setCurrentId((cur) => {
            const idx = prev.findIndex((t) => t.id === cur);
            const dir = e.shiftKey ? -1 : 1;
            const next = (idx + dir + prev.length) % prev.length;
            return prev[next].id;
          });
          return prev;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<TabsState>(
    () => ({ tabs, currentId, open, close, select, reorder, rename }),
    [tabs, currentId, open, close, select, reorder, rename],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjectsTabs(): TabsState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjectsTabs must be inside ProjectsTabsProvider");
  return v;
}

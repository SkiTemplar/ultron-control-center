import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useRoutingTitle } from "../lib/button-prompts";

// News tab — lists the HTML newsletters generated in
// ~/.ultron/cockpit/news/. Each newsletter is a full-page artifact, so
// the tab itself just gives a list, summary, and "open in browser" /
// "open in viewer" actions. Inline preview shows the title + first
// paragraphs; the real read happens in a system browser.

export type NewsEntry = {
  filename: string;
  path: string;
  generated_at: string | null;
  size_bytes: number;
  title: string | null;
  excerpt: string | null;
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function dateFromName(name: string): string | null {
  // Names look like newsletter-2026-05-11.html — we surface the date.
  const m = name.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function News() {
  const [items, setItems] = useState<NewsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [showGen, setShowGen] = useState(false);
  const [genDays, setGenDays] = useState(3);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NewsEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const genSessionTitle = useRoutingTitle(
    "news.generate_with_ai",
    "Copies the prompt to the clipboard + opens a Gemini session in wt.exe (paste there with Ctrl+V).",
  );

  // Summary cache lives in localStorage so we don't burn LLM turns each
  // time the user revisits a newsletter. Keyed by absolute path.
  const SUMMARY_KEY = "ultron.cc.news_summaries.v1";
  const [summaries, setSummaries] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(SUMMARY_KEY);
      if (raw) return JSON.parse(raw) as Record<string, string>;
    } catch {}
    return {};
  });
  const [summarizing, setSummarizing] = useState(false);

  // Inline HTML body cache (in-memory only — newsletters can hit ~80 KB so
  // persisting in localStorage would balloon storage fast). Keyed by path.
  // `null` means we tried and failed; falsy means not yet loaded.
  const [htmlCache, setHtmlCache] = useState<Record<string, string | null>>({});
  const [htmlLoading, setHtmlLoading] = useState(false);
  const [htmlError, setHtmlError] = useState<string | null>(null);
  // View toggle per selection. Default to inline so the user immediately
  // sees the newsletter content (the original ask).
  const [viewMode, setViewMode] = useState<"inline" | "summary">("inline");

  async function load() {
    setLoading(true);
    try {
      const list = await invoke<NewsEntry[]>("list_news");
      setItems(list);
      setSelected((prev) => prev ?? list[0]?.path ?? null);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function summarize(path: string) {
    if (summaries[path] || summarizing) return;
    setSummarizing(true);
    setError(null);
    try {
      const r = (await invoke("summarize_news", { path })) as string;
      const next = { ...summaries, [path]: r };
      setSummaries(next);
      try {
        localStorage.setItem(SUMMARY_KEY, JSON.stringify(next));
      } catch {}
    } catch (e) {
      setError(String(e));
    } finally {
      setSummarizing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Fetch full HTML when the selected newsletter changes (inline view). We
  // cache aggressively per path so toggling Summary/Inline back and forth
  // doesn't re-read the file. If the read fails (>500 KB cap, missing
  // file, permission), we store `null` so the UI can fall back to excerpt.
  useEffect(() => {
    if (!selected) return;
    if (selected in htmlCache) return;
    let cancelled = false;
    setHtmlLoading(true);
    setHtmlError(null);
    invoke<string>("read_news_html", { path: selected })
      .then((body) => {
        if (cancelled) return;
        setHtmlCache((prev) => ({ ...prev, [selected]: body }));
      })
      .catch((e) => {
        if (cancelled) return;
        setHtmlCache((prev) => ({ ...prev, [selected]: null }));
        setHtmlError(String(e));
      })
      .finally(() => {
        if (!cancelled) setHtmlLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, htmlCache]);

  // @ts-expect-error retained as a callable for power-user JS console / future debugging
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function generate() {
    setGenerating(true);
    setError(null);
    setInfo(null);
    try {
      const r = (await invoke("generate_news", {
        theme: null,
        days: genDays,
      })) as { success: boolean; path: string | null; stderr: string };
      if (!r.success) {
        setError(r.stderr || "news_html_generator failed");
      } else {
        setInfo(r.path ? `Newsletter generated: ${r.path}` : "Newsletter generated.");
        setShowGen(false);
        await load();
        if (r.path) setSelected(r.path);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    setError(null);
    try {
      await invoke("delete_news", { path: pendingDelete.path });
      const wasSelected = selected === pendingDelete.path;
      setPendingDelete(null);
      await load();
      if (wasSelected) setSelected(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  function openExternalPath(p: string) {
    openPath(p).catch((e: unknown) => setError(String(e)));
  }

  const sel = items.find((i) => i.path === selected) ?? null;

  return (
    <div className="flex h-full">
      <div
        className="flex w-[44%] min-w-[420px] flex-col overflow-hidden border-r"
        style={{ borderColor: "var(--color-border)" }}
      >
        <header className="border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <h1 className="text-[18px] font-semibold leading-tight">News</h1>
              <p className="mt-1 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
                {items.length} newsletter{items.length === 1 ? "" : "s"} generated by ULTRON Times
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowGen(!showGen)}
              className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
              style={{
                background: showGen ? "var(--color-surface-3)" : "var(--color-accent)",
                color: showGen ? "var(--color-text)" : "var(--color-accent-text)",
                border: showGen ? "1px solid var(--color-border-strong)" : "none",
              }}
              title="Generate a new newsletter with Gemini"
            >
              {showGen ? "Close" : "Generate"}
            </button>
          </div>
          {showGen && (
            <div
              className="mt-3 rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <label
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Days
                </label>
                <input
                  type="number"
                  min={1}
                  max={14}
                  value={genDays}
                  onChange={(e) =>
                    setGenDays(Math.max(1, Math.min(14, parseInt(e.target.value, 10) || 1)))
                  }
                  className="w-14 rounded px-1.5 py-0.5 text-[12px] tabular-nums"
                  style={{
                    background: "var(--color-surface-1)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                    outline: "none",
                  }}
                />
              </div>
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    setGenerating(true);
                    setError(null);
                    setInfo(null);
                    try {
                      const r = (await invoke("generate_news_session", {
                        theme: null,
                        days: genDays,
                      })) as { success: boolean; stdout: string; stderr: string };
                      if (!r.success) {
                        setError(r.stderr || "session generator failed");
                      } else {
                        setInfo("Gemini session opened in wt.exe. The prompt is on your clipboard — press Ctrl+V there.");
                        setShowGen(false);
                      }
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setGenerating(false);
                    }
                  }}
                  disabled={generating}
                  className="rounded px-3 py-1 text-[12px] font-medium disabled:opacity-50"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                  title={genSessionTitle}
                >
                  {generating ? "Spawning Gemini..." : "Open Gemini session"}
                </button>
              </div>
              <p
                className="mt-2 text-[10.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Calls news_html_generator.py via uv. Reads the local newsletter
                template + skill and sends the prompt to the Gemini CLI; the
                response lands in cockpit/news/. May take 30s-2min.
              </p>
            </div>
          )}
          {info && (
            <div
              className="mt-2 rounded p-2 text-[11.5px]"
              style={{
                background: "rgba(63, 185, 80, 0.08)",
                border: "1px solid rgba(63, 185, 80, 0.22)",
                color: "var(--color-success)",
              }}
            >
              {info}
            </div>
          )}
        </header>
        <div className="flex-1 overflow-auto p-2">
          {loading && (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              Loading…
            </div>
          )}
          {error && (
            <div
              className="m-2 rounded p-3 text-[12px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
          {!loading && items.length === 0 && (
            <div
              className="m-2 rounded p-6 text-center text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              No newsletters yet. Run the news pipeline to generate one.
            </div>
          )}
          {items.map((n) => {
            const active = selected === n.path;
            const date = dateFromName(n.filename);
            return (
              <button
                key={n.path}
                type="button"
                onClick={() => setSelected(n.path)}
                className="block w-full rounded px-3 py-2 text-left transition-colors"
                style={{
                  background: active ? "var(--color-surface-3)" : "transparent",
                  border: `1px solid ${active ? "var(--color-border-strong)" : "transparent"}`,
                }}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className="text-[12.5px] font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {n.title ?? n.filename}
                  </span>
                  <span
                    className="ml-auto text-[10.5px] tabular-nums"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {date ?? n.generated_at ?? ""}
                  </span>
                </div>
                {n.excerpt && (
                  <div
                    className="mt-1 truncate text-[11.5px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {n.excerpt}
                  </div>
                )}
                <div
                  className="mt-1 text-[10.5px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  {formatBytes(n.size_bytes)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {sel ? (
          <div className="flex h-full flex-col overflow-hidden">
            <header
              className="flex items-center justify-between border-b px-5 py-4"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="min-w-0">
                <h2 className="truncate text-[15px] font-semibold">
                  {sel.title ?? sel.filename}
                </h2>
                <div
                  className="mt-1 truncate text-[10.5px]"
                  style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
                  title={sel.path}
                >
                  {sel.path}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => setPendingDelete(sel)}
                  className="rounded px-3 py-1.5 text-[12px] transition-colors"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-danger)",
                    border: "1px solid rgba(248, 81, 73, 0.32)",
                  }}
                  title="Delete this newsletter HTML file"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => openExternalPath(sel.path)}
                  className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
                  style={{
                    background: "var(--color-accent)",
                    color: "var(--color-accent-text)",
                  }}
                >
                  Open in browser
                </button>
              </div>
            </header>
            <div
              className="border-b px-5 py-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setViewMode("inline")}
                  className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors"
                  style={{
                    background:
                      viewMode === "inline"
                        ? "var(--color-surface-3)"
                        : "transparent",
                    color:
                      viewMode === "inline"
                        ? "var(--color-text)"
                        : "var(--color-text-tertiary)",
                    border: `1px solid ${viewMode === "inline" ? "var(--color-border-strong)" : "transparent"}`,
                  }}
                  title="Render the full HTML inside the app (no scripts)"
                >
                  Inline render
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("summary")}
                  className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors"
                  style={{
                    background:
                      viewMode === "summary"
                        ? "var(--color-surface-3)"
                        : "transparent",
                    color:
                      viewMode === "summary"
                        ? "var(--color-text)"
                        : "var(--color-text-tertiary)",
                    border: `1px solid ${viewMode === "summary" ? "var(--color-border-strong)" : "transparent"}`,
                  }}
                  title="AI summary + excerpt (plain text)"
                >
                  Summary
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              {viewMode === "inline" ? (
                <div className="flex h-full flex-col">
                  {htmlLoading && !htmlCache[sel.path] && (
                    <div
                      className="px-5 py-3 text-[11.5px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      Loading newsletter...
                    </div>
                  )}
                  {htmlCache[sel.path] ? (
                    <iframe
                      key={sel.path}
                      title={sel.title ?? sel.filename}
                      srcDoc={htmlCache[sel.path] as string}
                      sandbox="allow-same-origin"
                      referrerPolicy="no-referrer"
                      className="flex-1 w-full"
                      style={{
                        border: "none",
                        background: "#000",
                        minHeight: "80vh",
                      }}
                    />
                  ) : (
                    !htmlLoading && (
                      <div className="overflow-auto px-5 py-4">
                        {htmlError && (
                          <div
                            className="mb-3 rounded p-2 text-[11.5px]"
                            style={{
                              background: "rgba(248, 81, 73, 0.06)",
                              border: "1px solid rgba(248, 81, 73, 0.22)",
                              color: "var(--color-danger)",
                            }}
                          >
                            Inline render failed: {htmlError}. Falling back to
                            excerpt; use "Open in browser" for the full file.
                          </div>
                        )}
                        <p
                          className="text-[12px] leading-relaxed"
                          style={{ color: "var(--color-text-tertiary)" }}
                        >
                          {sel.excerpt ??
                            "No excerpt extracted yet. Open the file in a browser to read."}
                        </p>
                      </div>
                    )
                  )}
                </div>
              ) : (
                <div className="h-full overflow-auto px-5 py-4">
                  <p
                    className="text-[12px] leading-relaxed"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {sel.excerpt ??
                      "No excerpt extracted yet. Open the file in a browser to read."}
                  </p>

                  <div
                    className="mt-5 flex items-baseline justify-between gap-2 border-t pt-3"
                    style={{ borderColor: "var(--color-border)" }}
                  >
                    <h3
                      className="text-[11px] font-medium uppercase tracking-[0.06em]"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      AI summary
                    </h3>
                    <button
                      type="button"
                      onClick={() => summarize(sel.path)}
                      disabled={summarizing || !!summaries[sel.path]}
                      className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                      style={{
                        background: summaries[sel.path]
                          ? "var(--color-surface-2)"
                          : "var(--color-accent)",
                        color: summaries[sel.path]
                          ? "var(--color-text-tertiary)"
                          : "var(--color-accent-text)",
                        border: summaries[sel.path]
                          ? "1px solid var(--color-border)"
                          : "none",
                      }}
                      title={
                        summaries[sel.path]
                          ? "Already summarised (cached)"
                          : "Summarise with Claude (6 bullets + conclusion)"
                      }
                    >
                      {summarizing
                        ? "Summarising..."
                        : summaries[sel.path]
                          ? "Cached"
                          : "Summarise"}
                    </button>
                  </div>
                  {summaries[sel.path] ? (
                    <pre
                      className="mt-2 text-[12.5px] leading-relaxed"
                      style={{
                        color: "var(--color-text-secondary)",
                        whiteSpace: "pre-wrap",
                        fontFamily: "inherit",
                      }}
                    >
                      {summaries[sel.path]}
                    </pre>
                  ) : (
                    <p
                      className="mt-2 text-[11.5px]"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      Click Summarise to have Claude summarise this newsletter
                      in 6 bullets. The summary is cached locally so revisiting
                      it doesn't burn turns.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div
            className="flex h-full items-center justify-center text-[13px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Select a newsletter on the left to read.
          </div>
        )}
      </div>

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !deleteBusy && setPendingDelete(null)}
        >
          <div
            className="w-full max-w-[440px] rounded p-5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[14px] font-semibold">Delete newsletter</h3>
            <p
              className="mt-2 text-[12.5px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Delete the HTML file <b>{pendingDelete.filename}</b>? The
              deletion is permanent — use git to recover it if you need
              to.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px] font-medium"
                style={{
                  background: "var(--color-danger)",
                  color: "#fff",
                }}
              >
                {deleteBusy ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LEARN_SECTIONS, type LearnSection } from "../lib/learn-content";

// Learn — sección viva para dominar ULTRON (skills, agentes, comandos,
// prompting, memoria, AI routing, workflows, hooks, codegraph). El contenido
// vive en lib/learn-content.ts (generado por workflow + editable a mano).

export function Learn() {
  const sections = useMemo(
    () => [...LEARN_SECTIONS].sort((a, b) => a.order - b.order),
    [],
  );
  const [activeTopic, setActiveTopic] = useState<string | null>(
    sections[0]?.topic ?? null,
  );
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q) ||
        s.markdown.toLowerCase().includes(q),
    );
  }, [sections, query]);

  const active: LearnSection | null =
    sections.find((s) => s.topic === activeTopic) ?? sections[0] ?? null;

  if (!sections.length) {
    return (
      <div className="px-10 pt-8" style={{ color: "var(--color-text-secondary)" }}>
        <h1 className="text-xl font-semibold" style={{ color: "var(--color-text)" }}>
          Learn
        </h1>
        <p className="mt-3 text-sm">
          Aún no hay guías generadas. Ejecuta el workflow <code>learn-content</code>{" "}
          para poblar esta sección.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-0 pt-8" style={{ height: "calc(100vh - 0px)" }}>
      <LearnStyles />
      {/* Rail de temas */}
      <nav
        className="shrink-0 overflow-y-auto px-4"
        style={{
          width: 280,
          borderRight: "1px solid var(--color-border)",
        }}
      >
        <div className="mb-3 px-1">
          <h1 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
            Learn
          </h1>
          <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            Domar a ULTRON: técnicas, comandos y flujos.
          </p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar en las guías…"
          className="mb-3 w-full rounded px-2.5 py-1.5 text-[12px] outline-none"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        />
        <ul className="flex flex-col gap-1 pb-8">
          {filtered.map((s) => {
            const isActive = active && s.topic === active.topic;
            return (
              <li key={s.topic}>
                <button
                  type="button"
                  onClick={() => setActiveTopic(s.topic)}
                  className="w-full rounded px-2.5 py-2 text-left transition-colors"
                  style={{
                    background: isActive ? "var(--color-surface-3)" : "transparent",
                    border: isActive
                      ? "1px solid var(--color-border-strong)"
                      : "1px solid transparent",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[15px]">{s.icon}</span>
                    <span
                      className="text-[12.5px] font-medium"
                      style={{ color: "var(--color-text)" }}
                    >
                      {s.title}
                    </span>
                  </div>
                  <div
                    className="mt-0.5 pl-[23px] text-[11px] leading-snug"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {s.summary}
                  </div>
                </button>
              </li>
            );
          })}
          {!filtered.length && (
            <li
              className="px-2 py-3 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Sin resultados para “{query}”.
            </li>
          )}
        </ul>
      </nav>

      {/* Contenido */}
      <main className="flex-1 overflow-y-auto px-10 pb-16">
        {active && (
          <article className="learn-md mx-auto" style={{ maxWidth: 820 }}>
            <div className="mb-4 flex items-center gap-2.5">
              <span className="text-[24px]">{active.icon}</span>
              <h1
                className="text-2xl font-semibold"
                style={{ color: "var(--color-text)" }}
              >
                {active.title}
              </h1>
            </div>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {active.markdown}
            </ReactMarkdown>
          </article>
        )}
      </main>
    </div>
  );
}

// Estilos del markdown renderizado, alineados con los tokens del tema.
function LearnStyles() {
  return (
    <style>{`
      .learn-md { color: var(--color-text-secondary); font-size: 13.5px; line-height: 1.7; }
      .learn-md h2 { color: var(--color-text); font-size: 18px; font-weight: 600; margin: 1.6em 0 0.6em; padding-bottom: 0.3em; border-bottom: 1px solid var(--color-border); }
      .learn-md h3 { color: var(--color-text); font-size: 15px; font-weight: 600; margin: 1.3em 0 0.4em; }
      .learn-md h4 { color: var(--color-text); font-size: 13.5px; font-weight: 600; margin: 1.1em 0 0.3em; }
      .learn-md p { margin: 0.6em 0; }
      .learn-md a { color: var(--color-accent, #58a6ff); text-decoration: none; }
      .learn-md a:hover { text-decoration: underline; }
      .learn-md strong { color: var(--color-text); }
      .learn-md ul, .learn-md ol { margin: 0.5em 0; padding-left: 1.4em; }
      .learn-md li { margin: 0.25em 0; }
      .learn-md code { font-family: var(--font-mono, monospace); font-size: 12px; background: var(--color-surface-3); padding: 0.12em 0.4em; border-radius: 4px; }
      .learn-md pre { background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: 8px; padding: 0.9em 1em; overflow-x: auto; margin: 0.8em 0; }
      .learn-md pre code { background: transparent; padding: 0; font-size: 12px; line-height: 1.55; }
      .learn-md blockquote { border-left: 3px solid var(--color-border-strong); margin: 0.8em 0; padding: 0.2em 0 0.2em 1em; color: var(--color-text-tertiary); }
      .learn-md table { border-collapse: collapse; margin: 0.9em 0; width: 100%; font-size: 12.5px; }
      .learn-md th, .learn-md td { border: 1px solid var(--color-border); padding: 0.45em 0.7em; text-align: left; vertical-align: top; }
      .learn-md th { background: var(--color-surface-2); color: var(--color-text); font-weight: 600; }
      .learn-md hr { border: none; border-top: 1px solid var(--color-border); margin: 1.4em 0; }
    `}</style>
  );
}

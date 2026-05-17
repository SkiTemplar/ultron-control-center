// Dependency-free markdown renderer extracted from SkillRichView so other
// tabs (Personal, future ones) can render `profile.md`-style notes without
// pulling react-markdown.
//
// Supports: headings h1..h4, paragraphs, ul/ol lists, fenced code blocks,
// blockquotes, hr, GFM pipe tables, inline `code`, **bold**, *italic*, and
// [text](url) links. No HTML pass-through, no nested lists.
//
// Why dependency-free: the bundle does not import any markdown package and
// the formats we render (SKILL.md, profile.md, sample.md) are constrained
// commonmark subsets. Adding marked / react-markdown would balloon the
// bundle and we only need headings, lists, code, links, bold/italic,
// blockquote, tables.

import { Fragment, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Inline tokenizer.
// ---------------------------------------------------------------------------

export function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let buf = "";
  let k = 0;

  const flush = () => {
    if (buf.length > 0) {
      out.push(<Fragment key={`${keyBase}-t-${k++}`}>{buf}</Fragment>);
      buf = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        out.push(
          <code
            key={`${keyBase}-c-${k++}`}
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              padding: "1px 5px",
              borderRadius: 3,
              fontSize: "0.92em",
            }}
          >
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }

    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        flush();
        out.push(
          <strong key={`${keyBase}-b-${k++}`}>{text.slice(i + 2, end)}</strong>,
        );
        i = end + 2;
        continue;
      }
    }

    if (ch === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        out.push(
          <em key={`${keyBase}-i-${k++}`}>{text.slice(i + 1, end)}</em>,
        );
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const close = text.indexOf("](", i + 1);
      if (close !== -1) {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          flush();
          out.push(
            <a
              key={`${keyBase}-a-${k++}`}
              href={text.slice(close + 2, urlEnd)}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--color-accent)", textDecoration: "underline" }}
            >
              {text.slice(i + 1, close)}
            </a>,
          );
          i = urlEnd + 1;
          continue;
        }
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Block tokenizer.
// ---------------------------------------------------------------------------

export type TableAlign = "left" | "right" | "center" | null;

export type MdBlock =
  | { kind: "h"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lang: string; content: string }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; aligns: TableAlign[]; rows: string[][] };

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      buf += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

function isSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

function parseAligns(line: string): TableAlign[] {
  return splitTableRow(line).map((c) => {
    const t = c.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

export function tokenizeMarkdown(md: string): MdBlock[] {
  const lines = md.split(/\r?\n/);
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim();
      const collected: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        collected.push(lines[i]);
        i += 1;
      }
      out.push({ kind: "code", lang, content: collected.join("\n") });
      i += 1;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push({
        kind: "h",
        level: h[1].length as 1 | 2 | 3 | 4,
        text: h[2].trim(),
      });
      i += 1;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const collected: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        collected.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push({ kind: "quote", text: collected.join(" ") });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      out.push({ kind: "ul", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      out.push({ kind: "ol", items });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = parseAligns(lines[i + 1]);
      while (aligns.length < header.length) aligns.push(null);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        const cells = splitTableRow(lines[j]);
        while (cells.length < header.length) cells.push("");
        if (cells.length > header.length) cells.length = header.length;
        rows.push(cells);
        j += 1;
      }
      out.push({ kind: "table", header, aligns, rows });
      i = j;
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const collected: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|```|---+\s*$)/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1]))
    ) {
      collected.push(lines[i]);
      i += 1;
    }
    out.push({ kind: "p", text: collected.join(" ") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block renderer.
// ---------------------------------------------------------------------------

export function renderBlocks(blocks: MdBlock[]): ReactNode {
  return blocks.map((b, idx) => {
    const k = `b-${idx}`;
    switch (b.kind) {
      case "h": {
        const cls = {
          1: "text-[17px] font-semibold mt-5 mb-2",
          2: "text-[15px] font-semibold mt-4 mb-2",
          3: "text-[13px] font-semibold mt-3 mb-1.5 uppercase tracking-wide",
          4: "text-[12px] font-semibold mt-2 mb-1",
        }[b.level];
        const inner = renderInline(b.text, k);
        const style = { color: "var(--color-text)" };
        if (b.level === 1) return <h1 key={k} className={cls} style={style}>{inner}</h1>;
        if (b.level === 2) return <h2 key={k} className={cls} style={style}>{inner}</h2>;
        if (b.level === 3) return <h3 key={k} className={cls} style={style}>{inner}</h3>;
        return <h4 key={k} className={cls} style={style}>{inner}</h4>;
      }
      case "p":
        return (
          <p
            key={k}
            className="my-2 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {renderInline(b.text, k)}
          </p>
        );
      case "ul":
        return (
          <ul
            key={k}
            className="my-2 ml-4 list-disc space-y-1 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {b.items.map((it, j) => (
              <li key={`${k}-${j}`}>{renderInline(it, `${k}-${j}`)}</li>
            ))}
          </ul>
        );
      case "ol":
        return (
          <ol
            key={k}
            className="my-2 ml-4 list-decimal space-y-1 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {b.items.map((it, j) => (
              <li key={`${k}-${j}`}>{renderInline(it, `${k}-${j}`)}</li>
            ))}
          </ol>
        );
      case "code":
        return (
          <pre
            key={k}
            className="my-3 overflow-auto rounded p-3 text-[11.5px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            {b.lang && (
              <div
                className="mb-2 text-[10px] uppercase tracking-wide"
                style={{ color: "var(--color-text-faint)" }}
              >
                {b.lang}
              </div>
            )}
            <code>{b.content}</code>
          </pre>
        );
      case "quote":
        return (
          <blockquote
            key={k}
            className="my-2 border-l-2 pl-3 text-[12.5px] italic leading-relaxed"
            style={{
              borderColor: "var(--color-border-strong)",
              color: "var(--color-text-tertiary)",
            }}
          >
            {renderInline(b.text, k)}
          </blockquote>
        );
      case "hr":
        return (
          <hr
            key={k}
            className="my-4"
            style={{ borderColor: "var(--color-border)" }}
          />
        );
      case "table": {
        const alignFor = (a: TableAlign): "left" | "right" | "center" =>
          a === "right" ? "right" : a === "center" ? "center" : "left";
        return (
          <div
            key={k}
            className="my-3 overflow-x-auto rounded"
            style={{
              border: "1px solid var(--color-border)",
              background: "var(--color-surface-2)",
            }}
          >
            <table
              className="w-full text-[12px]"
              style={{ borderCollapse: "collapse" }}
            >
              <thead>
                <tr style={{ background: "var(--color-surface-3)" }}>
                  {b.header.map((h, hi) => (
                    <th
                      key={`${k}-th-${hi}`}
                      className="px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.04em]"
                      style={{
                        color: "var(--color-text-tertiary)",
                        textAlign: alignFor(b.aligns[hi] ?? null),
                        borderRight:
                          hi < b.header.length - 1
                            ? "1px solid var(--color-border)"
                            : "none",
                      }}
                    >
                      {renderInline(h, `${k}-th-${hi}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr
                    key={`${k}-tr-${ri}`}
                    style={{ borderTop: "1px solid var(--color-border)" }}
                  >
                    {row.map((cell, ci) => (
                      <td
                        key={`${k}-td-${ri}-${ci}`}
                        className="px-3 py-1.5"
                        style={{
                          color: "var(--color-text-secondary)",
                          textAlign: alignFor(b.aligns[ci] ?? null),
                          verticalAlign: "top",
                          borderRight:
                            ci < row.length - 1
                              ? "1px solid var(--color-border)"
                              : "none",
                        }}
                      >
                        {renderInline(cell, `${k}-td-${ri}-${ci}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Convenience component — parse + render a markdown string in one go.
// ---------------------------------------------------------------------------

export function Markdown({ source }: { source: string }) {
  const blocks = tokenizeMarkdown(source);
  return <div>{renderBlocks(blocks)}</div>;
}

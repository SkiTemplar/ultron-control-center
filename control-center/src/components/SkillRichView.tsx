// Renders a SKILL.md document with the YAML frontmatter parsed into a rich
// pinned header (chips for tools, badges for visibility, link to source) and
// the markdown body rendered with a small, dependency-free renderer.
//
// Why dependency-free: the rest of the app does not pull a markdown package
// and a SKILL.md is a constrained format (frontmatter + commonmark subset).
// Adding marked/react-markdown would balloon the bundle and we only need
// headings, lists, code, links, bold/italic, blockquote. If we ever need
// HTML pass-through, swap to a real parser.

import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Frontmatter parsing — tolerates flat key/value, inline lists, and block
// scalars (foo: |). Rejected: nested maps, anchors. SKILL.md never needs
// them.
// ---------------------------------------------------------------------------

export type Frontmatter = {
  name?: string;
  description?: string;
  // YAML key from Claude Code skill spec — `allowed-tools` / `allowedTools` /
  // `tools` are all recognised. Stored normalised here.
  allowedTools?: string[];
  // Per spec: when true, model cannot autoinvoke this skill — only user can.
  disableModelInvocation?: boolean;
  // Anthropic skills sometimes carry these:
  visibility?: string;
  category?: string;
  tags?: string[];
  // Catch-all so we can still surface keys we didn't model explicitly.
  extra: Record<string, string | string[]>;
};

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): { fm: Frontmatter | null; body: string } {
  const m = raw.match(FM_RE);
  if (!m) return { fm: null, body: raw };
  const block = m[1];
  const body = raw.slice(m[0].length);

  const fm: Frontmatter = { extra: {} };
  const lines = block.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const km = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!km) { i += 1; continue; }
    const key = km[1];
    let value = km[2];

    // Block scalar (foo: | / foo: >) — collect indented lines until dedent.
    if (value === "|" || value === ">") {
      const collected: string[] = [];
      i += 1;
      while (i < lines.length && /^\s{2,}/.test(lines[i])) {
        collected.push(lines[i].replace(/^\s{2,}/, ""));
        i += 1;
      }
      assignKey(fm, key, value === ">" ? collected.join(" ") : collected.join("\n"));
      continue;
    }

    // Inline list — `foo: [a, b, c]` or `foo: a, b, c`.
    if (/^\[.*\]$/.test(value)) {
      const inner = value.slice(1, -1).trim();
      const parts = inner ? inner.split(",").map((s) => stripQuotes(s.trim())).filter(Boolean) : [];
      assignKey(fm, key, parts);
      i += 1;
      continue;
    }

    // Block list — value empty, followed by `- foo` lines.
    if (value === "" || value === null) {
      const collected: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        collected.push(stripQuotes(lines[j].replace(/^\s*-\s+/, "").trim()));
        j += 1;
      }
      if (collected.length > 0) {
        assignKey(fm, key, collected);
        i = j;
        continue;
      }
    }

    assignKey(fm, key, stripQuotes(value));
    i += 1;
  }

  return { fm, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function assignKey(fm: Frontmatter, key: string, value: string | string[]) {
  const lowered = key.toLowerCase();
  if (lowered === "name") {
    fm.name = Array.isArray(value) ? value.join(", ") : value;
    return;
  }
  if (lowered === "description") {
    fm.description = Array.isArray(value) ? value.join(" ") : value;
    return;
  }
  if (lowered === "allowed-tools" || lowered === "allowedtools" || lowered === "tools") {
    // Per spec the value may be either a comma-separated list ("Read, Grep")
    // or whitespace-separated ("Read Grep"). Both shapes get normalised.
    let arr: string[];
    if (Array.isArray(value)) {
      arr = value;
    } else if (value.includes(",")) {
      arr = value.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      arr = value.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    }
    fm.allowedTools = arr;
    return;
  }
  if (lowered === "disable-model-invocation" || lowered === "disablemodelinvocation") {
    const v = Array.isArray(value) ? value[0] : value;
    fm.disableModelInvocation = String(v).toLowerCase() === "true";
    return;
  }
  if (lowered === "visibility") {
    fm.visibility = Array.isArray(value) ? value[0] : value;
    return;
  }
  if (lowered === "category") {
    fm.category = Array.isArray(value) ? value[0] : value;
    return;
  }
  if (lowered === "tags") {
    fm.tags = Array.isArray(value) ? value : value.split(",").map((s) => s.trim()).filter(Boolean);
    return;
  }
  fm.extra[key] = value;
}

// ---------------------------------------------------------------------------
// Tiny markdown renderer — block-level. Inline formatting handled per line.
// ---------------------------------------------------------------------------

function renderInline(text: string, keyBase: string): ReactNode[] {
  // Tokenise: backtick code, **bold**, *italic*, [text](url). Naive but
  // deterministic and good enough for SKILL.md prose.
  const out: ReactNode[] = [];
  let i = 0;
  let buf = "";
  let k = 0;

  const flush = () => {
    if (buf.length > 0) {
      out.push(buf);
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

type TableAlign = "left" | "right" | "center" | null;

type Block =
  | { kind: "h"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; lang: string; content: string }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; aligns: TableAlign[]; rows: string[][] };

// GFM pipe-table detection. A row is any line that contains at least one
// unescaped `|`. The separator row must be all dashes/colons/pipes/whitespace
// with one cell per column. We strip the leading/trailing `|` if present so
// both `| a | b |` and `a | b` parse the same.
function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  // Split on unescaped pipes — backslash-escape support keeps `\|` literal.
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

function tokenize(md: string): Block[] {
  const lines = md.split(/\r?\n/);
  const out: Block[] = [];
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

    // GFM pipe table — header row, separator row (---), then ≥0 data rows.
    // The header line must contain a pipe and the next line must be a valid
    // separator. We don't try to support tables without a separator (GFM
    // requires it).
    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const header = splitTableRow(line);
      const aligns = parseAligns(lines[i + 1]);
      // Pad align list to header length.
      while (aligns.length < header.length) aligns.push(null);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        const cells = splitTableRow(lines[j]);
        // Normalise row to header column count.
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

    // Paragraph — collect non-blank, non-block-starter lines.
    const collected: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}\s|>\s?|\s*[-*+]\s+|\s*\d+\.\s+|```|---+\s*$)/.test(lines[i]) &&
      // Don't merge a pipe-table header into the previous paragraph.
      !(lines[i].includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1]))
    ) {
      collected.push(lines[i]);
      i += 1;
    }
    out.push({ kind: "p", text: collected.join(" ") });
  }
  return out;
}

function renderBlocks(blocks: Block[]): ReactNode {
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
// Frontmatter card
// ---------------------------------------------------------------------------

function ToolChip({ tool }: { tool: string }) {
  // Tool names often look like `Bash(git status:*)`. We split the wrapper
  // function name from the guard so the user can quickly tell which built-in
  // tool is in scope.
  const m = tool.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\((.*)\))?$/);
  const name = m?.[1] ?? tool;
  const guard = m?.[2];
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px]"
      style={{
        background: "var(--color-surface-3)",
        color: "var(--color-text-secondary)",
        border: "1px solid var(--color-border-strong)",
      }}
      title={tool}
    >
      <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
        {name}
      </span>
      {guard && (
        <span
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          {guard.length > 28 ? `${guard.slice(0, 26)}…` : guard}
        </span>
      )}
    </span>
  );
}

function FrontmatterCard({ fm }: { fm: Frontmatter }) {
  const extras = Object.entries(fm.extra ?? {}).filter(([, v]) => {
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === "string" && v.length > 0;
  });

  return (
    <div
      className="rounded p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div
        className="text-[10px] font-medium uppercase tracking-[0.06em]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Frontmatter
      </div>

      {fm.description && (
        <p
          className="mt-2 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {fm.description}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {fm.visibility && (
          <span
            className="rounded px-1.5 py-px text-[10.5px]"
            style={{
              background: "rgba(63, 185, 80, 0.08)",
              color: "var(--color-success)",
              border: "1px solid rgba(63, 185, 80, 0.22)",
            }}
            title="visibility"
          >
            {fm.visibility}
          </span>
        )}
        {fm.disableModelInvocation && (
          <span
            className="rounded px-1.5 py-px text-[10.5px]"
            style={{
              background: "rgba(210, 153, 34, 0.08)",
              color: "var(--color-warn)",
              border: "1px solid rgba(210, 153, 34, 0.22)",
            }}
            title="Model cannot auto-invoke this skill — user-only"
          >
            user-only
          </span>
        )}
        {fm.category && (
          <span
            className="rounded px-1.5 py-px text-[10.5px]"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="category"
          >
            {fm.category}
          </span>
        )}
        {fm.tags?.map((t) => (
          <span
            key={`tag-${t}`}
            className="rounded px-1.5 py-px text-[10.5px]"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-tertiary)",
            }}
          >
            {t}
          </span>
        ))}
      </div>

      {fm.allowedTools && fm.allowedTools.length > 0 && (
        <div className="mt-3">
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Allowed tools · {fm.allowedTools.length}
          </div>
          <div className="flex flex-wrap gap-1">
            {fm.allowedTools.map((t) => (
              <ToolChip key={t} tool={t} />
            ))}
          </div>
        </div>
      )}

      {extras.length > 0 && (
        <div className="mt-3">
          <div
            className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Other
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
            {extras.map(([k, v]) => (
              <ExtraRow key={k} k={k} v={v} />
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function ExtraRow({ k, v }: { k: string; v: string | string[] }) {
  return (
    <>
      <dt
        style={{
          fontFamily: "var(--font-mono)",
          color: "var(--color-text-tertiary)",
        }}
      >
        {k}
      </dt>
      <dd style={{ color: "var(--color-text-secondary)" }}>
        {Array.isArray(v) ? v.join(", ") : v}
      </dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function SkillRichView({ raw }: { raw: string }) {
  const { fm, body } = parseFrontmatter(raw);
  const blocks = tokenize(body);

  return (
    <div className="space-y-4">
      {fm && <FrontmatterCard fm={fm} />}
      <div>{renderBlocks(blocks)}</div>
    </div>
  );
}

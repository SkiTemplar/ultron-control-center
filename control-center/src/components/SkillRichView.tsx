// Renders a SKILL.md document with the YAML frontmatter parsed into a rich
// pinned header (chips for tools, badges for visibility, link to source) and
// the markdown body rendered with a small, dependency-free renderer.
//
// Markdown tokenizer + renderer live in lib/markdown so other tabs (Personal,
// Changelog) share the same implementation without duplicating ~400 LOC of
// inline parsing logic.

import { tokenizeMarkdown, renderBlocks } from "../lib/markdown";

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

// Markdown tokenizer + renderer imported from lib/markdown above.


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
  const blocks = tokenizeMarkdown(body);

  return (
    <div className="space-y-4">
      {fm && <FrontmatterCard fm={fm} />}
      <div>{renderBlocks(blocks)}</div>
    </div>
  );
}

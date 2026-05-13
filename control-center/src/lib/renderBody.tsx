import { Fragment, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Minimal "markdown-lite" renderer for changelog bodies.
//
// Detects:
//   - Blank lines  → paragraph break
//   - Lines starting with "- " or "* "  → bullet list
//   - Backtick-quoted inline code: `path/to/file.ts`, `command`
//
// Designed for ndjson bodies written without explicit markdown but with
// natural prose conventions. Does NOT try to be a full markdown engine.
// ---------------------------------------------------------------------------

function renderInline(text: string): ReactNode[] {
  // Split by backtick groups, alternate code / text
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length >= 2) {
      return (
        <code
          key={i}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.92em",
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            padding: "1px 5px",
            borderRadius: 3,
          }}
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{p}</Fragment>;
  });
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "ul"; items: string[] };

function parseBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  const rawLines = body.replace(/\r\n/g, "\n").split("\n");

  let buf: string[] = [];
  let bullets: string[] = [];
  let inBullets = false;

  const flushBuf = () => {
    if (buf.length > 0) {
      blocks.push({ kind: "p", lines: buf });
      buf = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length > 0) {
      blocks.push({ kind: "ul", items: bullets });
      bullets = [];
    }
    inBullets = false;
  };

  for (const line of rawLines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      flushBuf();
      flushBullets();
      continue;
    }

    const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushBuf();
      inBullets = true;
      bullets.push(bulletMatch[1]);
      continue;
    }

    if (inBullets) {
      flushBullets();
    }
    buf.push(trimmed);
  }
  flushBuf();
  flushBullets();
  return blocks;
}

export function RenderBody({ body }: { body: string }) {
  const blocks = parseBlocks(body);
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => {
        if (b.kind === "ul") {
          return (
            <ul
              key={i}
              className="space-y-1 pl-4"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {b.items.map((it, j) => (
                <li
                  key={j}
                  className="relative text-[12.5px] leading-relaxed"
                  style={{ listStyle: "none" }}
                >
                  <span
                    className="absolute -left-3 top-[7px] inline-block h-1 w-1 rounded-full"
                    style={{ background: "var(--color-text-tertiary)" }}
                  />
                  {renderInline(it)}
                </li>
              ))}
            </ul>
          );
        }
        // paragraph: join lines with single space (commit-style)
        const text = b.lines.join(" ");
        return (
          <p
            key={i}
            className="text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {renderInline(text)}
          </p>
        );
      })}
    </div>
  );
}

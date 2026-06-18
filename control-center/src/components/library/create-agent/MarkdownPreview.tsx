import { useMemo } from "react";

export function MarkdownPreview({ source }: { source: string }) {
  const blocks = useMemo(() => renderBlocks(source), [source]);
  return <div className="space-y-2">{blocks}</div>;
}

function renderBlocks(src: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = src.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded p-2 font-mono text-[11.5px]"
          style={{ background: "var(--color-surface-3)" }}
        >
          {code.join("\n")}
        </pre>,
      );
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(
        <h2 key={key++} className="text-sm font-semibold">
          {line.slice(2)}
        </h2>,
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(
        <h3 key={key++} className="text-xs font-semibold uppercase tracking-wide">
          {line.slice(3)}
        </h3>,
      );
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      out.push(
        <h4 key={key++} className="text-xs font-semibold">
          {line.slice(4)}
        </h4>,
      );
      i++;
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*]\s/, ""));
        i++;
      }
      out.push(
        <ul key={key++} className="ml-4 list-disc space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      out.push(
        <ol key={key++} className="ml-4 list-decimal space-y-0.5">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const paragraph: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !/^[-*]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    out.push(
      <p key={key++} className="text-xs">
        {renderInline(paragraph.join(" "))}
      </p>,
    );
  }
  return out;
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, idx) => {
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code
          key={idx}
          className="rounded px-1 font-mono text-[11.5px]"
          style={{ background: "var(--color-surface-3)" }}
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    return <span key={idx}>{p}</span>;
  });
}

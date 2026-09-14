// Settings/api-keys/TutorialDisclosure.tsx — "¿Cómo la consigo?" bajo cada
// campo de clave.

import { handleExternalClick } from "../../../lib/openExternal";
import type { KeyTutorial } from "./types";

interface TutorialDisclosureProps {
  tutorial: KeyTutorial;
}

export function TutorialDisclosure({ tutorial }: TutorialDisclosureProps) {
  return (
    <details className="mt-1.5">
      <summary
        className="cursor-pointer select-none text-[11px] transition-colors"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        ¿Cómo la consigo?
      </summary>
      <div
        className="mt-2 rounded p-2.5 text-[11.5px] leading-relaxed"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-secondary)",
        }}
      >
        <ol className="ml-4 list-decimal space-y-0.5">
          {tutorial.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <p className="mt-2">
          <span className="font-medium" style={{ color: "var(--color-text)" }}>
            Para qué la usa ULTRON:
          </span>{" "}
          {tutorial.usedFor}
        </p>
        <p className="mt-1">
          <span className="font-medium" style={{ color: "var(--color-text)" }}>
            Si falta:
          </span>{" "}
          {tutorial.ifMissing}
        </p>
        <p className="mt-1.5">
          <a
            href={tutorial.sourceUrl}
            target="_blank"
            onClick={handleExternalClick}
            rel="noopener noreferrer"
            style={{ color: "var(--color-accent)" }}
          >
            Fuente: {tutorial.sourceLabel} ↗
          </a>
        </p>
      </div>
    </details>
  );
}

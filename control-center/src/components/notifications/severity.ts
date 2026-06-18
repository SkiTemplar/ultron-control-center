import type { SevStyle } from "./types";

export function severityStyle(sev: string): SevStyle {
  switch (sev) {
    case "critical":
    case "blocking":
      return {
        color: "var(--color-danger)",
        bg: "rgba(248, 81, 73, 0.06)",
        ring: "rgba(248, 81, 73, 0.20)",
        label: "critical",
        key: "critical",
        weight: 2,
      };
    case "warn":
      return {
        color: "var(--color-warn)",
        bg: "rgba(210, 153, 34, 0.05)",
        ring: "rgba(210, 153, 34, 0.18)",
        label: "warn",
        key: "warn",
        weight: 1,
      };
    case "info":
    default:
      return {
        color: "var(--color-text-tertiary)",
        bg: "transparent",
        ring: "var(--color-border)",
        label: "info",
        key: "info",
        weight: 0,
      };
  }
}

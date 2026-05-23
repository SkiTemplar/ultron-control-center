// ULTRON Control Center 2.0 — Shared inline SVG icons for the Projects workspace.
//
// We avoid lucide-react to keep bundle size small (the rest of the codebase
// follows the same convention; see Projects.tsx for prior art). 14×14 stroked
// paths matching the Lucide visual language unless noted.

type IconProps = { size?: number; className?: string };

const base = (size?: number) => ({
  width: size ?? 14,
  height: size ?? 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export function Folder({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 19a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function FolderOpen({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 14L4 19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2l-2-5" />
      <path d="M20 9V7a2 2 0 0 0-2-2h-7l-2-3H4a2 2 0 0 0-2 2v12" />
    </svg>
  );
}

export function Home({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />
    </svg>
  );
}

export function X({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function AlertTriangle({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function Plus({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function Save({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

export function Play({ size, className }: IconProps) {
  return (
    <svg
      width={size ?? 14}
      height={size ?? 14}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

export function RefreshCw({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function ExternalLink({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

export function Layers({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

export function Bot({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="11" width="18" height="10" rx="2" />
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" />
      <line x1="16" y1="16" x2="16" y2="16" />
    </svg>
  );
}

export function Kanban({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 5v11" />
      <path d="M12 5v6" />
      <path d="M18 5v14" />
    </svg>
  );
}

export function Terminal({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function Notebook({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 4h13a2 2 0 0 1 2 2v14H7a3 3 0 0 1-3-3z" />
      <path d="M8 4v16" />
      <path d="M12 8h4" />
      <path d="M12 12h4" />
    </svg>
  );
}

export function History({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 3 3 8 8 8" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function Pin({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14l-1.5-3L19 5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2l1.5 9z" />
    </svg>
  );
}

export function PinOff({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <line x1="2" y1="2" x2="22" y2="22" />
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14l-1.5-3L19 5a2 2 0 0 0-2-2H9" />
    </svg>
  );
}

// P5 — Small inline SVG icons used by the library modals. We avoid
// pulling in lucide-react (rest of the codebase follows the same
// convention).

import { base, type IconProps } from "../icons";

export {
  Search,
  Loader,
  X,
  Plus,
  ExternalLink,
  Check,
  AlertTriangle,
  ChevronRight,
  Terminal,
  ChevronDown,
  Save,
} from "../icons";

export function Github({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

export function Download({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// v2.1 — icons used by the Library shell + Catalog.
export function Sparkle({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3 13.5 9 19 10.5 13.5 12 12 18 10.5 12 5 10.5 10.5 9z" />
      <path d="M19 16v4" />
      <path d="M17 18h4" />
    </svg>
  );
}

export function Bot({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M12 8V4" />
      <circle cx="12" cy="3" r="1" />
      <circle cx="9" cy="13" r="1" />
      <circle cx="15" cy="13" r="1" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  );
}

export function BookOpen({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2 5h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z" />
      <path d="M22 5h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z" />
    </svg>
  );
}

export function Compass({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16 8 14 14 8 16 10 10 16 8" />
    </svg>
  );
}

export function Folder({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// Creator modal icons (added for Skill/Agent/MCP v2 wizards).
export function ChevronLeft({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

export function Eye({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function FileText({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  );
}

export function Code({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

export function Sparkles({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
      <path d="M19 14v3" />
      <path d="M17.5 15.5h3" />
      <path d="M5 17v3" />
      <path d="M3.5 18.5h3" />
    </svg>
  );
}

export function Clipboard({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    </svg>
  );
}

// v2.3 — icons for the Commands sub-tab + tree-view nav.

export function Edit({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function FileCode({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <polyline points="10 13 8 15 10 17" />
      <polyline points="14 13 16 15 14 17" />
    </svg>
  );
}

export function Grid({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

export function ListTree({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M21 12h-9" />
      <path d="M21 18h-7" />
      <path d="M21 6h-11" />
      <path d="M5 21V5a1 1 0 0 1 1-1h2" />
      <path d="M5 12h5" />
      <path d="M5 18h7" />
    </svg>
  );
}

// v2.6 — "blocks" view mode icon. Stack of three offset rectangles —
// communicates "tiles drilled into more tiles" without depending on Lucide.
export function Boxes({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5l-5-3-4.03 1.92Z" />
      <path d="m7 16.5-4.74-2.85" />
      <path d="m7 16.5 5-3" />
      <path d="M7 16.5v5.17" />
      <path d="M12 13.91V9a2 2 0 0 0-.97-1.71L8.03 5.49a2 2 0 0 0-2.06 0L3 7.29A2 2 0 0 0 2 9v.5" />
      <path d="M17 8a2 2 0 0 0-2-2h-3" />
      <path d="m22 17.65-5 3-5-3" />
      <path d="m22 11.65-5 3" />
    </svg>
  );
}

// v2.6 — generic chevron back arrow for breadcrumb / drill-up.
export function ArrowLeft({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

// v2.6 — sparkles icon used by "Edit with AI" button on the rule detail pane.
// Distinct from the existing `Sparkles` (kept) — this one is a single 4-pointed
// twinkle that pairs better with action buttons.
export function Wand({ size, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="m21 21-7-7" />
      <path d="M14 14 9 9" />
      <path d="M3 3l3 3" />
      <path d="M6 6 3 9" />
      <path d="m12 3 1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
    </svg>
  );
}

// v2.6 — save floppy icon for the inline rule editor.

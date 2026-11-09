// Iconos SVG en línea (trazo de 1,5 px, heredan el color del texto).

import type { ReactNode } from "react";

function Svg({ children, size = 14, label }: { children: ReactNode; size?: number; label?: string }) {
  return (
    <svg
      className="svg-i"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {children}
    </svg>
  );
}

export const IconGear = () => <Svg><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M12.4 3.6l-1.3 1.3M4.9 11.1l-1.3 1.3" /></Svg>;
export const IconClose = () => <Svg size={12}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
export const IconPlus = () => <Svg size={12}><path d="M8 3v10M3 8h10" /></Svg>;
export const IconSplit = () => <Svg><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M8 3v10" /></Svg>;
export const IconTerminal = () => <Svg><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M4.5 6.5l2 1.5-2 1.5M8.5 10h3" /></Svg>;
export const IconChat = () => <Svg><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></Svg>;
export const IconChevron = () => <Svg size={12}><path d="M6 4l4 4-4 4" /></Svg>;
export const IconChevronDown = () => <Svg size={12}><path d="M4 6l4 4 4-4" /></Svg>;
export const IconCopy = () => <Svg size={12}><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" /><path d="M10.5 5V3.5A1 1 0 009.5 2.5h-6a1 1 0 00-1 1v6a1 1 0 001 1H5" /></Svg>;
export const IconCheck = () => <Svg size={12}><path d="M3 8.5l3 3 7-7" /></Svg>;
export const IconBranch = () => <Svg size={12}><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.5 4" /></Svg>;
export const IconPanel = () => <Svg><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></Svg>;
export const IconList = () => <Svg><path d="M3 4h10M3 8h10M3 12h10" /></Svg>;
export const IconPalette = () => <Svg><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5v11" /><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" /></Svg>;
export const IconStop = () => <Svg size={12}><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" /></Svg>;
export const IconSend = () => <Svg size={12}><path d="M2.5 8h10M9 4.5L12.5 8 9 11.5" /></Svg>;
export const IconAt = () => <Svg size={12}><circle cx="8" cy="8" r="2.5" /><path d="M10.5 8v1a2 2 0 004 0V8A6.5 6.5 0 108 14.5" /></Svg>;
export const IconSlash = () => <Svg size={12}><path d="M10.5 2.5l-5 11" /></Svg>;
export const IconClip = () => <Svg size={12}><path d="M12.5 7.5l-5 5a3 3 0 01-4.2-4.2l5.5-5.5a2 2 0 012.8 2.8L6.2 11a1 1 0 01-1.4-1.4L9.5 5" /></Svg>;
export const IconFile = () => <Svg size={12}><path d="M4 1.5h5l3 3v10H4z" /><path d="M9 1.5v3h3" /></Svg>;
export const IconExpand = () => <Svg size={12}><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" /></Svg>;
export const IconRefresh = () => <Svg size={12}><path d="M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3" /></Svg>;
export const IconSpark = () => <Svg size={12}><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M12 4l-1.8 1.8M5.8 10.2L4 12" /></Svg>;
export const IconMic = () => <Svg size={12}><rect x="6" y="2" width="4" height="8" rx="2" /><path d="M4 8a4 4 0 0 0 8 0M8 12v2" /></Svg>;
export const IconAgent = () => <Svg size={12}><circle cx="8" cy="5" r="2.5" /><path d="M3 14c.6-3 2.6-4.5 5-4.5s4.4 1.5 5 4.5" /></Svg>;
export const IconBookmark = () => <Svg size={12}><path d="M4.5 2h7v12L8 11.4 4.5 14z" /></Svg>;

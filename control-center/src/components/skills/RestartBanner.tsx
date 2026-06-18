export interface RestartBannerProps {
  visible: boolean;
}

export function RestartBanner({ visible }: RestartBannerProps) {
  if (!visible) return null;
  return (
    <div
      className="flex items-center gap-2 rounded-md px-3 py-2 text-xs"
      style={{
        background: "rgba(234, 179, 8, 0.08)",
        border: "1px solid rgba(234, 179, 8, 0.30)",
        color: "var(--color-warn, #ca8a04)",
      }}
    >
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: "var(--color-warn, #ca8a04)" }}
      />
      Restart Claude Code to apply skill changes.
    </div>
  );
}

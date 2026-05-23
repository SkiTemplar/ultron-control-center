export default function ProjectContext(_props: {
  projectId: string;
  projectPath: string;
}) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
      Context · pending (sub-commit 8)
    </div>
  );
}

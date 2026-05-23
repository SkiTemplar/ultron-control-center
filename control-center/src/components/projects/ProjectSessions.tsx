export default function ProjectSessions(_props: {
  projectId: string;
  projectPath: string;
}) {
  return (
    <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
      Sessions · pending (sub-commit 9)
    </div>
  );
}

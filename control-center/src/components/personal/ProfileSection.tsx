// Profile.md panel — renders the user's free-form profile note as styled
// markdown (Markdown component from lib/markdown), shows a friendly empty
// state when seeded or below a meaningful-content threshold, and offers a
// modal raw editor for power users.
//
// Why a modal and not inline-edit-in-place: the rendered view is the primary
// surface — most sessions are read-only ("what does ULTRON know about me?")
// and the editor is only opened occasionally. A modal keeps the read view
// distraction-free and gives the textarea full height when editing.

import { useEffect, useState } from "react";

import { Markdown } from "../../lib/markdown";

import {
  formatBytes,
  formatRel,
  meaningfulProfileChars,
} from "./types";
import type { PersonalProfile } from "./types";

type Props = {
  profile: PersonalProfile | null;
  draft: string;
  setDraft: (v: string) => void;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
  info: string | null;
  onSave: () => Promise<void> | void;
};

// Below this many characters of *real* (non-template) prose, profile.md is
// considered effectively empty and we surface the empty-state instead of
// rendering. Tuned just above the length of a fully-blank section template.
const PROFILE_EMPTY_THRESHOLD = 50;

export function ProfileSection({
  profile,
  draft,
  setDraft,
  loading,
  saving,
  dirty,
  error,
  info,
  onSave,
}: Props) {
  const [editorOpen, setEditorOpen] = useState(false);

  // Close the editor on Escape so the user can quickly bail without losing
  // unsaved edits (the draft stays in state — the modal just hides).
  useEffect(() => {
    if (!editorOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditorOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorOpen]);

  const meaningful = meaningfulProfileChars(profile?.content ?? "");
  const looksEmpty = profile == null || profile.seeded || meaningful < PROFILE_EMPTY_THRESHOLD;

  return (
    <section
      className="flex flex-1 flex-col gap-2 overflow-hidden rounded p-4"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold leading-tight">Your profile</h2>
          <p
            className="mt-0.5 text-[10.5px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            Free-form text that skills load as persistent context.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {profile && !looksEmpty && (
            <span
              className="text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
              title={profile.path}
            >
              {formatBytes(profile.size_bytes)} · {formatRel(profile.last_modified)}
            </span>
          )}
          <button
            type="button"
            onClick={() => setEditorOpen(true)}
            disabled={loading}
            className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: looksEmpty
                ? "var(--color-accent)"
                : "var(--color-surface-2)",
              color: looksEmpty
                ? "var(--color-accent-text)"
                : "var(--color-text)",
              border: looksEmpty
                ? "1px solid var(--color-accent)"
                : "1px solid var(--color-border-strong)",
            }}
          >
            {looksEmpty ? "Add profile" : "Edit profile"}
          </button>
        </div>
      </div>

      {error && (
        <div
          className="rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {info && (
        <div
          className="rounded p-2 text-[11px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {info}
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto rounded p-4 pr-3"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        {loading ? (
          <p
            className="text-[12px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            Loading...
          </p>
        ) : looksEmpty ? (
          <ProfileEmptyState onAdd={() => setEditorOpen(true)} />
        ) : (
          <Markdown source={profile!.content} />
        )}
      </div>

      {editorOpen && (
        <ProfileEditorModal
          draft={draft}
          setDraft={setDraft}
          saving={saving}
          dirty={dirty}
          seeded={profile?.seeded ?? false}
          onSave={async () => {
            await onSave();
            setEditorOpen(false);
          }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </section>
  );
}

function ProfileEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 py-4">
      <div
        className="text-[13px] font-semibold"
        style={{ color: "var(--color-text)" }}
      >
        No profile yet.
      </div>
      <p
        className="text-[12.5px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Add here what ULTRON should know about you between sessions — skills
        load it automatically from{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
          ~/.ultron/personal/profile.md
        </span>
        .
      </p>

      <div
        className="w-full rounded p-3"
        style={{
          background: "var(--color-surface-1)",
          border: "1px dashed var(--color-border-strong)",
        }}
      >
        <div
          className="mb-1.5 text-[10.5px] uppercase tracking-wide"
          style={{ color: "var(--color-text-faint)" }}
        >
          Examples of what to include
        </div>
        <ul
          className="ml-4 list-disc space-y-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <li>Current role / occupation and the domains you spend most time in.</li>
          <li>Favorite stack and tools you avoid.</li>
          <li>Ongoing projects and relevant deadlines.</li>
          <li>Hobbies, interests, useful personal context.</li>
          <li>How you prefer ULTRON to talk to you (tone, language, length).</li>
        </ul>
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
        style={{
          background: "var(--color-accent)",
          color: "var(--color-accent-text)",
        }}
      >
        Add profile
      </button>
    </div>
  );
}

function ProfileEditorModal({
  draft,
  setDraft,
  saving,
  dirty,
  seeded,
  onSave,
  onClose,
}: {
  draft: string;
  setDraft: (v: string) => void;
  saving: boolean;
  dirty: boolean;
  seeded: boolean;
  onSave: () => Promise<void> | void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-6"
      style={{ background: "rgba(0, 0, 0, 0.55)" }}
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col gap-3 rounded p-4"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
          maxHeight: "85vh",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-semibold leading-tight">
              Edit profile.md
            </h3>
            <p
              className="mt-0.5 text-[10.5px]"
              style={{
                color: "var(--color-text-faint)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ~/.ultron/personal/profile.md
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[14px]"
            style={{
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
            aria-label="Close editor"
          >
            ×
          </button>
        </div>

        {seeded && (
          <div
            className="rounded p-2 text-[11px] leading-relaxed"
            style={{
              background: "rgba(210, 153, 34, 0.08)",
              border: "1px solid rgba(210, 153, 34, 0.30)",
              color: "var(--color-warn)",
            }}
          >
            You're viewing a template. Edit and press <strong>Save</strong>{" "}
            to create your real profile.
          </div>
        )}

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="flex-1 rounded p-3 text-[12px] leading-relaxed"
          style={{
            fontFamily: "var(--font-mono)",
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: `1px solid ${
              dirty ? "var(--color-warn)" : "var(--color-border)"
            }`,
            outline: "none",
            resize: "none",
            minHeight: 360,
          }}
          autoFocus
        />

        <div className="flex items-center justify-between gap-2">
          <span
            className="text-[10.5px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            {draft.length.toLocaleString()} chars · {draft.split("\n").length}{" "}
            lines
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded px-3 py-1.5 text-[11.5px] transition-colors"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {dirty ? "Discard" : "Close"}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || saving}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              {saving ? "Saving..." : dirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

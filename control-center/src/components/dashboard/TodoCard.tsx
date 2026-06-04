// Dashboard To-Do card (fullize 2026-06-01: side-panel, visual-only).
//
// On the Dashboard the To-Do is a read-leaning side panel: it lists tasks and
// lets you tick them off (dark custom checkboxes), but adding/removing happens
// in Notes (button in the header). Shares the localStorage store in
// lib/todos.ts, so anything added in Notes shows up here live.

import { useEffect, useState } from "react";
import { loadTodos, onTodosUpdated, toggleTodo, type TodoItem } from "../../lib/todos";
import { Card, SmallButton } from "./Card";

interface TodoCardProps {
  onOpenNotes?: () => void;
}

// Dark, custom checkbox — the native <input type=checkbox> renders a light OS
// control that clashes with the dark UI. This is a square toggle that fills
// with the accent colour + a check glyph when done.
function DarkCheck({ done, onToggle, label }: { done: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={done ? "Marcar como pendiente" : "Marcar como hecha"}
      aria-pressed={done}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] transition-colors"
      style={{
        background: done ? "var(--color-success)" : "var(--color-surface-1)",
        border: `1px solid ${done ? "var(--color-success)" : "var(--color-border-strong)"}`,
      }}
    >
      {done && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0b1a0b" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
      <span className="sr-only">{label}</span>
    </button>
  );
}

export function TodoCard({ onOpenNotes }: TodoCardProps) {
  const [todos, setTodos] = useState<TodoItem[]>(() => loadTodos());

  useEffect(() => onTodosUpdated(() => setTodos(loadTodos())), []);

  const pending = todos.filter((t) => !t.done);

  return (
    <Card
      title="To-Do"
      subtitle={
        todos.length > 0
          ? `${pending.length} pendiente${pending.length === 1 ? "" : "s"}`
          : undefined
      }
      action={
        <SmallButton onClick={onOpenNotes} size="md" title="Gestionar en Notes">
          Notes
        </SmallButton>
      }
    >
      {todos.length === 0 ? (
        <div className="text-[13px]" style={{ color: "var(--color-text-faint)" }}>
          Sin tareas. Añádelas desde Notes.
        </div>
      ) : (
        <ul className="space-y-2">
          {todos.slice(0, 10).map((t) => (
            <li key={t.id} className="flex items-center gap-2.5 text-[13px]">
              <DarkCheck done={t.done} onToggle={() => setTodos(toggleTodo(t.id))} label={t.text} />
              <span
                className="flex-1 truncate"
                title={t.text}
                style={{
                  color: t.done ? "var(--color-text-faint)" : "var(--color-text)",
                  textDecoration: t.done ? "line-through" : "none",
                }}
              >
                {t.text}
              </span>
            </li>
          ))}
          {todos.length > 10 && (
            <li className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
              +{todos.length - 10} más en Notes
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

// Simple To-Do card (fullize 2026-06-01). Shares the localStorage-backed
// store in lib/todos.ts with the Notes To-Do panel — add here, see it there.
// KISS: text + check + delete. Nothing extra.

import { useEffect, useRef, useState } from "react";
import {
  addTodo,
  clearDone,
  loadTodos,
  onTodosUpdated,
  removeTodo,
  toggleTodo,
  type TodoItem,
} from "../../lib/todos";
import { Card, SmallButton } from "./Card";

interface TodoCardProps {
  onOpenNotes?: () => void;
}

export function TodoCard({ onOpenNotes }: TodoCardProps) {
  const [todos, setTodos] = useState<TodoItem[]>(() => loadTodos());
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => onTodosUpdated(() => setTodos(loadTodos())), []);

  function submit() {
    if (!draft.trim()) return;
    setTodos(addTodo(draft));
    setDraft("");
    inputRef.current?.focus();
  }

  const pending = todos.filter((t) => !t.done);
  const doneCount = todos.length - pending.length;

  return (
    <Card
      title="To-Do"
      subtitle={pending.length > 0 ? `${pending.length} pendiente${pending.length === 1 ? "" : "s"}` : undefined}
      action={
        <SmallButton onClick={onOpenNotes} size="md" title="Abrir Notes">
          Notes
        </SmallButton>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Nueva tarea…"
            className="flex-1 rounded-md px-2.5 py-1.5 text-[13px] outline-none"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          />
          <SmallButton onClick={submit} size="md" title="Añadir tarea">
            +
          </SmallButton>
        </div>

        {todos.length === 0 && (
          <div className="text-[13px]" style={{ color: "var(--color-text-faint)" }}>
            Sin tareas. Añade una arriba.
          </div>
        )}

        {todos.length > 0 && (
          <ul className="space-y-1.5">
            {todos.slice(0, 8).map((t) => (
              <li key={t.id} className="group flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={t.done}
                  onChange={() => setTodos(toggleTodo(t.id))}
                  className="h-3.5 w-3.5 shrink-0 cursor-pointer"
                />
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
                <button
                  type="button"
                  onClick={() => setTodos(removeTodo(t.id))}
                  title="Borrar"
                  className="shrink-0 px-1 text-[12px] opacity-0 transition-opacity group-hover:opacity-100"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        {(todos.length > 8 || doneCount > 0) && (
          <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--color-text-faint)" }}>
            <span>{todos.length > 8 ? `+${todos.length - 8} más` : ""}</span>
            {doneCount > 0 && (
              <button
                type="button"
                onClick={() => setTodos(clearDone())}
                className="px-1 hover:underline"
                style={{ color: "var(--color-text-tertiary)" }}
                title="Quitar las completadas"
              >
                Limpiar {doneCount} hechas
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

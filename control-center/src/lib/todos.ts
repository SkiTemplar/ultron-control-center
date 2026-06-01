// Simple shared To-Do store (fullize 2026-06-01).
//
// "Tan sencillo como Notas, nada extraño": un to-do plano persistido en
// localStorage y compartido por la card del Dashboard y el panel de Notes.
// Sin backend, sin rebuild. Cualquier cambio emite `ultron-todos-updated`
// para que ambas vistas se re-rendericen en vivo.

const STORAGE_KEY = "ultron.todos.v1";
const UPDATED_EVENT = "ultron-todos-updated";

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
}

function makeId(): string {
  // Crypto-backed when available; falls back to a counter-ish string.
  // (Date.now is fine here — this is runtime UI state, not a workflow.)
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `todo-${Date.now().toString(36)}-${rand}`;
}

export function loadTodos(): TodoItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is TodoItem =>
        !!t &&
        typeof (t as TodoItem).id === "string" &&
        typeof (t as TodoItem).text === "string" &&
        typeof (t as TodoItem).done === "boolean",
    );
  } catch {
    return [];
  }
}

function persist(todos: TodoItem[]): TodoItem[] {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  } catch {
    /* storage full / unavailable — keep in-memory only */
  }
  window.dispatchEvent(new CustomEvent(UPDATED_EVENT));
  return todos;
}

export function addTodo(text: string): TodoItem[] {
  const trimmed = text.trim();
  if (!trimmed) return loadTodos();
  const next: TodoItem = {
    id: makeId(),
    text: trimmed,
    done: false,
    createdAt: Date.now(),
  };
  return persist([next, ...loadTodos()]);
}

export function toggleTodo(id: string): TodoItem[] {
  return persist(
    loadTodos().map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
  );
}

export function removeTodo(id: string): TodoItem[] {
  return persist(loadTodos().filter((t) => t.id !== id));
}

export function clearDone(): TodoItem[] {
  return persist(loadTodos().filter((t) => !t.done));
}

/** Subscribe to cross-view updates. Returns an unsubscribe fn. */
export function onTodosUpdated(handler: () => void): () => void {
  window.addEventListener(UPDATED_EVENT, handler);
  // Cross-tab/window sync (other webviews writing the same key).
  const storageHandler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) handler();
  };
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(UPDATED_EVENT, handler);
    window.removeEventListener("storage", storageHandler);
  };
}

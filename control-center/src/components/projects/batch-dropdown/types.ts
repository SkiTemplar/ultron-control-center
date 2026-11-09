// Domain types (mirrors Rust structs) + component props for BatchDropdown.

export type BatchEntry = {
  name: string;
  path: string;
  size_bytes: number;
  modified_epoch: number;
};

export type BatchRunResult = {
  success: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
};

/** Respuesta de `batch_read_script`: el script que se enseña antes de ejecutar. */
export type BatchScriptPreview = {
  name: string;
  path: string;
  size_bytes: number;
  content: string;
  too_large: boolean;
};

/** Revisión previa a ejecutar: sin un script en `ready` no se lanza nada. */
export type BatchRunReview = {
  name: string;
  queueEntry: BatchQueueEntry | null;
} & (
  | { status: "loading" }
  | { status: "ready"; script: BatchScriptPreview }
  | { status: "error"; message: string }
);

export type BatchQueueReason = "rejected" | "ai_cannot_execute" | "failed";

/** "auto" = runnable with one click; "manual" = human out-of-band action. */
export type BatchKind = "auto" | "manual";

export type BatchQueueEntry = {
  id: string;
  name: string;
  path: string;
  reason: BatchQueueReason;
  kind: BatchKind;
  description: string | null;
  created_at: string;
  last_error: string | null;
  attempts: number;
};

/** Respuesta de `batches_list_queue`: la cola y, si falló, el error del drenaje. */
export type BatchQueueListing = {
  entries: BatchQueueEntry[];
  drain_error?: string | null;
};

export type BatchToast = {
  kind: "ok" | "err";
  title: string;
  body: string;
};

export type BatchDropdownProps = {
  onResult?: (toast: BatchToast) => void;
  headerStyle?: boolean;
  cardStyle?: boolean;
};

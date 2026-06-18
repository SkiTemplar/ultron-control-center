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

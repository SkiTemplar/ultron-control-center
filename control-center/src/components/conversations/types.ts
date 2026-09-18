// Tipos del navegador de conversaciones.
//
// Espejo exacto de `commands::sessions_sub::session_transcript` (Rust). Si
// cambias un campo alli, cambialo aqui: el canal IPC no valida el esquema.

/** Un turno legible del transcript. Mirror de `TranscriptTurn`. */
export type TranscriptTurn = {
  /** Indice de linea en el `.jsonl` (base 0). Key estable para React. */
  line: number;
  /** "user" | "assistant" | "tool" | "system" | "other". */
  role: string;
  timestamp: string | null;
  text: string | null;
  model: string | null;
  /** Herramientas invocadas en el turno ("Bash", "Edit", …). */
  tools: string[];
  /** true si `text` se recorto por tamano del turno. */
  truncated: boolean;
};

/** Una pagina de transcript. Mirror de `TranscriptPage`. */
export type TranscriptPage = {
  session_id: string;
  path: string;
  /** Lineas no vacias del fichero (no turnos: ver el modulo Rust). */
  total_lines: number;
  offset: number;
  /** Lineas consumidas por esta pagina. El siguiente offset = offset + esto. */
  returned_lines: number;
  has_more: boolean;
  /** true si la pagina se corto por presupuesto de caracteres, no por limit. */
  char_capped: boolean;
  turns: TranscriptTurn[];
};

/** Cubos temporales de la lista, en el orden en que se muestran. */
export type DateBucket =
  | "Hoy"
  | "Ayer"
  | "Últimos 7 días"
  | "Últimos 30 días"
  | "Más antiguo"
  | "Sin fecha";

export const BUCKET_ORDER: DateBucket[] = [
  "Hoy",
  "Ayer",
  "Últimos 7 días",
  "Últimos 30 días",
  "Más antiguo",
  "Sin fecha",
];

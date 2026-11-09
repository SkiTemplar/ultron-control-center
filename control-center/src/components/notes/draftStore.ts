// Borradores de Notes por slug en localStorage. El texto en edición vive en el
// estado del componente, y App.tsx solo monta la pestaña activa: sin esto,
// cambiar de pestaña lo perdía sin aviso.

const DRAFT_PREFIX = "ultron.notes.draft.";

export function saveDraft(slug: string, body: string): void {
  window.localStorage.setItem(DRAFT_PREFIX + slug, body);
}

export function loadDraft(slug: string): string | null {
  return window.localStorage.getItem(DRAFT_PREFIX + slug);
}

export function clearDraft(slug: string): void {
  window.localStorage.removeItem(DRAFT_PREFIX + slug);
}

/** Primer slug de `slugs` con un borrador pendiente, o `null` si no hay ninguno. */
export function firstDraftSlug(slugs: readonly string[]): string | null {
  return slugs.find((slug) => loadDraft(slug) !== null) ?? null;
}

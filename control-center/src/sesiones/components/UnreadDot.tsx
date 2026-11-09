// Marca de «respuesta nueva sin leer» de una sesión (pestañas y barra lateral; ver unread.ts).

export function UnreadDot() {
  return <span className="unread-dot" role="img" aria-label="Respuesta nueva sin leer" title="Respuesta nueva sin leer" data-testid="unread-dot" />;
}

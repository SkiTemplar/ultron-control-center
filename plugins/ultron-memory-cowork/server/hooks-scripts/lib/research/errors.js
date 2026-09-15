'use strict';

/**
 * lib/research/errors.js — tipos de error explicitos del nucleo de investigacion.
 *
 * Mandamiento 11 (no-op silencioso): cada fallo de red o de datos se propaga
 * con un tipo reconocible en vez de devolver null/[] en silencio. El CLI y el
 * MCP deciden como mostrarlo, pero nunca lo tragan aqui.
 */

class ResearchError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'ResearchError';
    if (cause) this.cause = cause;
  }
}

/** Error HTTP con status explicito (4xx/5xx tras agotar reintentos si aplica). */
class HttpError extends ResearchError {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status ?? null;
    this.url = url ?? null;
    this.body = body ?? null;
  }
}

/** DOI, sesion o recurso que la fuente confirma que NO existe (404 limpio). */
class NotFoundError extends ResearchError {
  constructor(message, { resource } = {}) {
    super(message);
    this.name = 'NotFoundError';
    this.resource = resource ?? null;
  }
}

/** Se agoto el tiempo de espera de la peticion (AbortController). */
class TimeoutError extends ResearchError {
  constructor(message, { url, timeoutMs } = {}) {
    super(message);
    this.name = 'TimeoutError';
    this.url = url ?? null;
    this.timeoutMs = timeoutMs ?? null;
  }
}

module.exports = { ResearchError, HttpError, NotFoundError, TimeoutError };

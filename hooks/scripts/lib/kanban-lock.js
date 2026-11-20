'use strict';

/**
 * lib/kanban-lock.js — nombres historicos del lock de kanban.json.
 *
 * La implementacion vive en lib/file-lock.js desde que projects.json usa el
 * mismo protocolo (auditoria 2026-11-08, #12). Este modulo solo conserva la API
 * que importan kanban-auto.js, scripts/kanban.mjs y scripts/lib/portfolio-board.mjs:
 * acquireBoardLock/withBoardLock son acquireFileLock/withFileLock.
 */

const fileLock = require('./file-lock');

module.exports = {
  LOCK_SUFFIX: fileLock.LOCK_SUFFIX,
  LOCK_TIMEOUT_MS: fileLock.LOCK_TIMEOUT_MS,
  LOCK_STALE_MS: fileLock.LOCK_STALE_MS,
  lockPathFor: fileLock.lockPathFor,
  acquireBoardLock: fileLock.acquireFileLock,
  withBoardLock: fileLock.withFileLock,
  renameWithRetry: fileLock.renameWithRetry,
};

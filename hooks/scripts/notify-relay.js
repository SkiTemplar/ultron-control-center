#!/usr/bin/env node
// hooks/scripts/notify-relay.js — Notification hook (iter-10, FASE 6).
//
// Relay each Claude Code notification (idle prompt, permission request, etc.)
// to a rolling scratch log so the operator has a single place to review what
// the session has been asking for:
//   ~/.ultron/.tmp/notifications.log
//
// ADEMAS (2026-06-24): emite una notificacion de escritorio NO INVASIVA
// (toast nativo de Windows 11 via WinRT ToastNotificationManager, con fallback
// a BurntToast si esta instalado) + un sonido suave del sistema. El toast NO
// roba foco ni minimiza la ventana activa (a diferencia de un MessageBox/Popup
// modal). PowerShell se lanza DETACHED (spawn + unref, sin esperar su salida),
// de modo que el hook retorna en milisegundos y nunca cuelga la sesion.
//
// writer_path = NONE. Pure local append to a scratch log; never touches
// brain.db / Qdrant / the sidecar. No governed memory is written.
//
// NO-OP-SAFE: any failure exits 0 silently. A failed Notification hook must
// never break the harness.
//
// Opt-out: CLAUDE_NO_HOOKS=1 or NOTIFY_RELAY_DISABLED=1.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { observe, logHookError } = require('./lib/hook-obs');
observe('notify-relay');

const HOME = os.homedir();
const TMP_DIR = path.join(HOME, '.ultron', '.tmp');
const LOG_PATH = path.join(TMP_DIR, 'notifications.log');
const LOG_MAX_BYTES = 1 * 1024 * 1024;
const NOTIFY_WAV = 'C:\\Windows\\Media\\Windows Notify.wav';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function projectName(cwd) {
  try {
    return path.basename(cwd || process.cwd()).replace(/^\.+/, '') || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function rotateLogIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size < LOG_MAX_BYTES) return;
    try {
      fs.unlinkSync(LOG_PATH + '.1');
    } catch (_) {}
    fs.renameSync(LOG_PATH, LOG_PATH + '.1');
  } catch (_) {}
}

// Build a PowerShell script (string) that: plays a soft system sound
// (non-blocking) and shows a NON-INVASIVE desktop toast. Strategy: native
// WinRT toast first (no install needed on Win10/11), BurntToast as fallback.
// Everything wrapped in try/catch so PowerShell never errors out. Strings are
// embedded as PS single-quoted literals (doubling any embedded quote) so the
// notification text cannot break the script or inject code.
function psLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function buildNotifyScript(title, body) {
  const t = psLiteral(title);
  const b = psLiteral(body);
  const wav = psLiteral(NOTIFY_WAV);
  // AppId = the Start Menu shortcut GUID for Windows PowerShell. Using a
  // registered AppId lets the toast render with a proper title in Win10/11.
  const appId = "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'";
  return [
    '$ErrorActionPreference=' + psLiteral('SilentlyContinue') + ';',
    // Soft sound — Play() is asynchronous (non-blocking).
    'try{(New-Object System.Media.SoundPlayer ' + wav + ').Play()}catch{}',
    // Native WinRT toast (preferred: no foreground steal, lands in Action Center).
    'try{',
    '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;',
    '[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]>$null;',
    '$x=New-Object Windows.Data.Xml.Dom.XmlDocument;',
    '$x.LoadXml(' + psLiteral(
      '<toast><visual><binding template="ToastGeneric"><text>{T}</text><text>{B}</text></binding></visual></toast>'
    ) + '.Replace(' + psLiteral('{T}') + ',' + t + ').Replace(' + psLiteral('{B}') + ',' + b + '));',
    '$n=New-Object Windows.UI.Notifications.ToastNotification $x;',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(' + appId + ').Show($n)',
    '}catch{',
    // Fallback: BurntToast (only if module is present). Still non-invasive.
    'try{if(Get-Module -ListAvailable -Name BurntToast){Import-Module BurntToast -ErrorAction Stop;New-BurntToastNotification -Text ' + t + ',' + b + '}}catch{}',
    '}',
  ].join('');
}

// Fire a detached PowerShell process for the toast+sound and return
// immediately. We never read its stdout/stderr and never wait on it, so the
// hook stays fast (<<1s) and a slow/absent PowerShell can't hang the session.
function fireDesktopNotification(title, body) {
  try {
    const script = buildNotifyScript(title, body);
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-ExecutionPolicy', 'Bypass',
        '-Command', script,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.on('error', () => {}); // PowerShell missing -> swallow, fail-safe
    child.unref(); // do not keep the event loop alive waiting on it
  } catch (_) {
    // any spawn failure is non-fatal — the log append already succeeded
  }
}

// Campana del terminal (BEL \x07) — el aviso "te toca" que Focus Assist NO
// puede silenciar: lo renderiza el EMULADOR (Windows Terminal via bellStyle:
// audible/flash), no el sistema de notificaciones del SO. El stdout del hook
// va pipeado al harness (no al TTY), asi que se escribe directo en la consola
// adjunta (CONOUT$); en headless (sin consola) falla en silencio, fail-safe.
// Opt-out estilo Claude Code `terminalBell`: NOTIFY_RELAY_BELL=0.
function ringTerminalBell() {
  if (process.env.NOTIFY_RELAY_BELL === '0') return;
  try {
    if (process.stdout.isTTY) {
      process.stdout.write('\x07');
      return;
    }
    const fd = fs.openSync('\\\\.\\CONOUT$', 'w');
    try {
      fs.writeSync(fd, '\x07');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    // sin consola adjunta (cron/headless) -> no hay campana que tocar
  }
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1' || process.env.NOTIFY_RELAY_DISABLED === '1') {
    return;
  }

  const raw = readStdin();
  let stdin = {};
  try {
    stdin = raw ? JSON.parse(raw) : {};
  } catch (_) {
    stdin = {};
  }

  const cwd = stdin.cwd || process.cwd();
  const message = stdin.message || stdin.title || stdin.notification || '(sin mensaje)';
  const ts = new Date().toISOString();
  const line = `[${ts}] [${projectName(cwd)}] ${String(message).replace(/\s+/g, ' ').slice(0, 300)}`;

  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch (_) {
    // scratch append failure is non-fatal
  }

  // Campana del terminal primero (inmediata, inmune a Focus Assist)…
  ringTerminalBell();
  // …y el toast no-invasivo + sonido suave: "te toca contestar".
  fireDesktopNotification(
    'ULTRON — te toca',
    String(message).replace(/\s+/g, ' ').slice(0, 180)
  );
}

try {
  main();
} catch (e) {
  // cat9.5: deja rastro del fallo top-level sin romper el fail-safe.
  logHookError('notify-relay', e);
}
process.exitCode = 0;

// Diagnostics — static catalogs (COMMON_ERRORS, FIX_CATALOG, KNOWN_ERRORS, etc.)
//
// 2026-10-18: textos visibles en español. Los `id`, `kind` y `category` son
// identificadores (backend, historial y filtros) y no se traducen; el nombre
// visible de las categorías sale de COMMON_ERROR_CATEGORY_LABELS y CATEGORY_LABELS.

import type { CommonError, CommonErrorCategory, Fix, FixCategory, KnownError } from "./types";

// ---------------------------------------------------------------------------
// COMMON_ERRORS catalog — 13 errores reconocibles con check + fix
// ---------------------------------------------------------------------------

export const COMMON_ERRORS: CommonError[] = [
  {
    id: "claude-login-expired",
    category: "AI / Claude",
    severity: "critical",
    title: "La sesión de Claude Code ha caducado",
    symptom: "La terminal pide autenticarse («authentication required») o las sesiones lanzadas fallan al momento.",
    checkId: "claude-login-expired",
    primaryFixKind: null,
    primaryFixLabel: "Ejecutar claude /login en una terminal",
    extraFixes: [],
  },
  {
    id: "ai-router-no-keys",
    category: "AI / Claude",
    severity: "warning",
    title: "Router de IA: no hay proveedores configurados",
    symptom: "El Router de IA cae al modo solo Claude; nunca se enruta a Codex ni a Gemini.",
    checkId: "ai-router-no-keys",
    primaryFixKind: null,
    primaryFixLabel: "Abrir Ajustes > Claves API",
    extraFixes: [],
  },
  {
    id: "node-not-found",
    category: "AI / Claude",
    severity: "critical",
    title: "Node.js no está en el PATH",
    symptom: "Claude Code CLI no se puede instalar ni actualizar; los comandos de npm fallan.",
    checkId: "node-not-found",
    primaryFixKind: null,
    primaryFixLabel: "Instalar Node.js (nodejs.org)",
    extraFixes: [],
  },
  {
    id: "network-unreachable",
    category: "Network",
    severity: "critical",
    title: "Red inaccesible",
    symptom: "Todos los proveedores de IA agotan el tiempo de espera; las llamadas a la API fallan con ECONNREFUSED o ERR_NETWORK.",
    checkId: "network-unreachable",
    primaryFixKind: "pc-flush-dns",
    primaryFixLabel: "Vaciar la caché DNS",
    extraFixes: [
      { kind: "pc-renew-ip", label: "Renovar la IP" },
      { kind: "pc-net-reset-all", label: "Restablecer toda la red" },
      { kind: "pc-network-troubleshooter", label: "Solucionador de problemas de red" },
    ],
  },
  {
    id: "port-1420-in-use",
    category: "System",
    severity: "warning",
    title: "El puerto 1420 está ocupado",
    symptom: "Control Center no arranca y da EADDRINUSE; puede que haya otra instancia abierta.",
    checkId: "port-1420-in-use",
    primaryFixKind: null,
    primaryFixLabel: "Cerrar el proceso que usa el puerto 1420",
    extraFixes: [
      { kind: "pc-task-manager", label: "Abrir el Administrador de tareas" },
    ],
  },
  {
    id: "gh-cli-missing",
    category: "System",
    severity: "warning",
    title: "Falta el CLI gh",
    symptom: "Las operaciones de GitHub de los flujos fallan; no se reconoce el comando «gh».",
    checkId: "gh-cli-missing",
    primaryFixKind: null,
    primaryFixLabel: "scoop install gh",
    extraFixes: [],
  },
  {
    id: "tauri-capabilities-denied",
    category: "System",
    severity: "warning",
    title: "Problema con las capabilities de Tauri",
    symptom: "Los comandos de shell fallan sin avisar, los diálogos de ficheros no se abren y hay errores de permisos en los logs.",
    checkId: "tauri-capabilities-denied",
    primaryFixKind: null,
    primaryFixLabel: "Revisar capabilities/default.json",
    extraFixes: [
      { kind: "pc-event-viewer", label: "Abrir el Visor de eventos" },
    ],
  },
  {
    id: "qdrant-binary-missing",
    category: "AI / Claude",
    severity: "info",
    title: "No se encuentra el binario de Qdrant",
    symptom: "El recall denso (vectores E5 en Qdrant) no está disponible. Solo importa con el denso encendido: con ULTRON_DENSE=0 el recall es sparse con FTS5 y Qdrant no hace falta.",
    checkId: "qdrant-binary-missing",
    primaryFixKind: null,
    primaryFixLabel: "Descargar qdrant.exe",
    extraFixes: [],
  },
  {
    id: "plugins-out-of-date",
    category: "Plugins",
    severity: "info",
    title: "Puede que los plugins estén desactualizados",
    symptom: "Los hooks de los plugins no se disparan; las funciones de los plugins se comportan de forma rara.",
    checkId: "plugins-out-of-date",
    primaryFixKind: null,
    primaryFixLabel: "Buscar actualizaciones de los plugins",
    extraFixes: [],
  },
  {
    id: "hooks-misconfigured",
    category: "Plugins",
    severity: "warning",
    title: "Hooks mal configurados",
    symptom: "Los hooks PostToolUse o Stop no se disparan; el autoformato o el vigilante de coste no actúan.",
    checkId: "hooks-misconfigured",
    primaryFixKind: null,
    primaryFixLabel: "Abrir ~/.claude/settings.json",
    extraFixes: [],
  },
  {
    id: "ultron-disk-usage",
    category: "Storage",
    severity: "info",
    title: ".ultron ocupa mucho disco",
    symptom: "La carpeta ~/.ultron ha crecido mucho; se acumulan diagnósticos, sesiones o logs antiguos.",
    checkId: "ultron-disk-usage",
    primaryFixKind: "pc-clear-temp",
    primaryFixLabel: "Vaciar %TEMP%",
    extraFixes: [
      { kind: "pc-disk-cleanup", label: "Liberar espacio en disco" },
    ],
  },
  {
    id: "projects-json-missing",
    category: "Storage",
    severity: "critical",
    title: "projects.json falta o está corrupto",
    symptom: "La pestaña Proyectos sale vacía; Control Center dice que no hay proyectos en cada arranque.",
    checkId: "projects-json-missing",
    primaryFixKind: null,
    primaryFixLabel: "Abrir la carpeta cockpit",
    extraFixes: [
      { kind: "pc-event-viewer", label: "Abrir el Visor de eventos" },
    ],
  },
  {
    id: "git-uncommitted-cockpit",
    category: "Git",
    severity: "info",
    title: "Cambios sin commit en cockpit",
    symptom: "El kanban o los datos de proyectos han cambiado en local pero no tienen commit en git.",
    checkId: "git-uncommitted-cockpit",
    primaryFixKind: null,
    primaryFixLabel: "Abrir una terminal para hacer el commit",
    extraFixes: [],
  },
];

export const COMMON_ERROR_CATEGORIES: CommonErrorCategory[] = [
  "AI / Claude",
  "Network",
  "Storage",
  "Plugins",
  "System",
  "Git",
];

/** Nombre visible de cada categoría de errores comunes. */
export const COMMON_ERROR_CATEGORY_LABELS: Record<CommonErrorCategory, string> = {
  "AI / Claude": "IA / Claude",
  Network: "Red",
  Storage: "Almacenamiento",
  Plugins: "Plugins",
  System: "Sistema",
  Git: "Git",
};

// ---------------------------------------------------------------------------
// FIX_CATALOG (Windows PC fixes)
// ---------------------------------------------------------------------------

export const FIX_CATALOG: Record<string, Fix> = {
  "pc-flush-dns": { kind: "pc-flush-dns", label: "Vaciar la caché DNS", detail: "ipconfig /flushdns: borra la caché local del resolvedor DNS.", category: "network" },
  "pc-renew-ip": { kind: "pc-renew-ip", label: "Renovar la IP", detail: "ipconfig /release && /renew: libera y vuelve a pedir la concesión DHCP.", category: "network" },
  "pc-reset-network": { kind: "pc-reset-network", label: "Restablecer TCP/IP", detail: "netsh int ip reset: restablece la pila TCP/IP de Windows. Conviene reiniciar.", category: "network", confirm: { title: "¿Restablecer la pila TCP/IP?", message: "Corta la conexión actual y después conviene reiniciar. ¿Continuar?" } },
  "pc-winsock-reset": { kind: "pc-winsock-reset", label: "Restablecer Winsock", detail: "netsh winsock reset: devuelve el catálogo de Winsock a los valores por defecto. Conviene reiniciar.", category: "network", confirm: { title: "¿Restablecer Winsock?", message: "Puede que haya que volver a registrar algunos LSP de terceros. ¿Continuar?" } },
  "pc-reset-firewall": { kind: "pc-reset-firewall", label: "Restablecer el firewall", detail: "netsh advfirewall reset: devuelve el Firewall de Windows a los valores por defecto.", category: "network", confirm: { title: "¿Restablecer el Firewall de Windows?", message: "Quita todas las reglas personalizadas de entrada y salida. ¿Continuar?" } },
  "pc-flush-arp": { kind: "pc-flush-arp", label: "Vaciar la caché ARP", detail: "netsh interface ip delete arpcache: borra la tabla ARP local.", category: "network" },
  "pc-net-reset-all": { kind: "pc-net-reset-all", label: "Restablecer toda la red", detail: "release + flushdns + renew + reinicio de Winsock + reinicio de TCP/IP, en ese orden. Conviene reiniciar.", category: "network", confirm: { title: "¿Restablecer toda la red?", message: "Libera el DHCP, vacía la caché DNS, renueva la IP y después restablece Winsock y TCP/IP. Conviene reiniciar al terminar. ¿Continuar?" } },
  "pc-network-troubleshooter": { kind: "pc-network-troubleshooter", label: "Solucionador de problemas de red", detail: "Lanza el asistente de diagnóstico del adaptador de red de Windows.", category: "network" },
  "pc-network-connections": { kind: "pc-network-connections", label: "Conexiones de red", detail: "Abre ncpa.cpl: la lista clásica de adaptadores.", category: "network" },
  "pc-open-hosts": { kind: "pc-open-hosts", label: "Abrir el fichero hosts", detail: "Abre C:\\Windows\\System32\\drivers\\etc\\hosts en el Bloc de notas.", category: "network" },
  "pc-restart-spooler": { kind: "pc-restart-spooler", label: "Reiniciar la cola de impresión", detail: "Restart-Service Spooler: arregla colas de impresión colgadas y caídas del spooler.", category: "services" },
  "pc-restart-audio": { kind: "pc-restart-audio", label: "Reiniciar el servicio de audio", detail: "Restart-Service Audiosrv + AudioEndpointBuilder.", category: "services" },
  "pc-restart-bluetooth": { kind: "pc-restart-bluetooth", label: "Reiniciar Bluetooth", detail: "Restart-Service bthserv: servicio de compatibilidad con Bluetooth.", category: "services" },
  "pc-restart-wsearch": { kind: "pc-restart-wsearch", label: "Reiniciar Windows Search", detail: "Restart-Service WSearch: arregla la búsqueda del menú Inicio.", category: "services" },
  "pc-restart-bits": { kind: "pc-restart-bits", label: "Reiniciar BITS", detail: "Restart-Service BITS: Servicio de transferencia inteligente en segundo plano.", category: "services" },
  "pc-restart-wuauserv": { kind: "pc-restart-wuauserv", label: "Reiniciar el servicio de actualizaciones", detail: "Restart-Service wuauserv: servicio de Windows Update.", category: "services" },
  "pc-restart-time": { kind: "pc-restart-time", label: "Reiniciar el servicio de hora", detail: "Restart-Service w32time + w32tm /resync: corrige el desfase del reloj.", category: "services" },
  "pc-services-mmc": { kind: "pc-services-mmc", label: "Abrir services.msc", detail: "Lanza la consola de administración de servicios.", category: "services" },
  "pc-repair-wu": { kind: "pc-repair-wu", label: "Reparar Windows Update", detail: "Para wuauserv y BITS, vacía SoftwareDistribution y los vuelve a arrancar.", category: "update", confirm: { title: "¿Reparar Windows Update?", message: "Para los servicios de Windows Update, borra SoftwareDistribution y los vuelve a arrancar. ¿Continuar?" } },
  "pc-reset-wu-components": { kind: "pc-reset-wu-components", label: "Restablecer los componentes de WU", detail: "Para wuauserv, bits, cryptsvc y msiserver, vacía SoftwareDistribution y catroot2 y los vuelve a arrancar.", category: "update", confirm: { title: "¿Restablecer los componentes de Windows Update?", message: "Para wuauserv, bits, cryptsvc y msiserver y después vacía SoftwareDistribution y catroot2. ¿Continuar?" } },
  "pc-wu-troubleshooter": { kind: "pc-wu-troubleshooter", label: "Solucionador de problemas de WU", detail: "Lanza el asistente de diagnóstico de Windows Update (msdt).", category: "update" },
  "pc-windows-update": { kind: "pc-windows-update", label: "Abrir Windows Update", detail: "Abre ms-settings:windowsupdate.", category: "update" },
  "pc-wsreset": { kind: "pc-wsreset", label: "Restablecer la caché de Store", detail: "wsreset.exe: borra la caché de Microsoft Store.", category: "update" },
  "pc-reregister-store-apps": { kind: "pc-reregister-store-apps", label: "Volver a registrar las apps de Store", detail: "Get-AppxPackage | Add-AppxPackage: vuelve a registrar todas las aplicaciones de Microsoft Store.", category: "update", confirm: { title: "¿Volver a registrar todas las apps de Store?", message: "Recorre cada paquete AppX instalado y lo vuelve a registrar. Tarda unos minutos. ¿Continuar?" } },
  "pc-sfc": { kind: "pc-sfc", label: "Ejecutar SFC", detail: "sfc /scannow: comprueba y restaura los ficheros del sistema. Abre una consola nueva.", category: "storage" },
  "pc-dism": { kind: "pc-dism", label: "Reparar con DISM", detail: "DISM /Online /Cleanup-Image /RestoreHealth: repara el almacén de componentes.", category: "storage" },
  "pc-chkdsk": { kind: "pc-chkdsk", label: "Ejecutar chkdsk (análisis)", detail: "chkdsk C: /scan: análisis de solo lectura de la unidad del sistema.", category: "storage" },
  "pc-clear-temp": { kind: "pc-clear-temp", label: "Vaciar %TEMP%", detail: "Borra todo lo que hay en %TEMP%. Los ficheros bloqueados se saltan.", category: "storage", confirm: { title: "¿Borrar los ficheros temporales?", message: "Borra para siempre el contenido de %TEMP%. ¿Continuar?" } },
  "pc-disk-cleanup": { kind: "pc-disk-cleanup", label: "Liberar espacio en disco", detail: "Lanza cleanmgr.exe.", category: "storage" },
  "pc-disk-management": { kind: "pc-disk-management", label: "Administración de discos", detail: "Abre diskmgmt.msc: gestor de particiones y volúmenes.", category: "storage" },
  "pc-restart-explorer": { kind: "pc-restart-explorer", label: "Reiniciar el Explorador", detail: "Cierra y vuelve a lanzar explorer.exe. Arregla fallos de la barra de tareas y del shell.", category: "shell", confirm: { title: "¿Reiniciar el Explorador?", message: "Cierra las ventanas del Explorador de archivos que estén abiertas. La barra de tareas parpadeará. ¿Continuar?" } },
  "pc-mdsched": { kind: "pc-mdsched", label: "Diagnóstico de memoria", detail: "Lanza mdsched.exe: programa una comprobación de la RAM en el próximo reinicio.", category: "diagnostic" },
  "pc-power-troubleshooter": { kind: "pc-power-troubleshooter", label: "Solucionador de problemas de energía", detail: "Lanza el asistente de diagnóstico de energía de Windows.", category: "diagnostic" },
  "pc-audio-troubleshooter": { kind: "pc-audio-troubleshooter", label: "Solucionador de problemas de audio", detail: "Lanza el asistente de diagnóstico de reproducción de audio.", category: "diagnostic" },
  "pc-bluetooth-troubleshooter": { kind: "pc-bluetooth-troubleshooter", label: "Solucionador de problemas de Bluetooth", detail: "Lanza el asistente de diagnóstico de Bluetooth.", category: "diagnostic" },
  "pc-search-troubleshooter": { kind: "pc-search-troubleshooter", label: "Solucionador de problemas de búsqueda", detail: "Lanza el asistente de diagnóstico de búsqueda e indexación.", category: "diagnostic" },
  "pc-event-viewer": { kind: "pc-event-viewer", label: "Abrir el Visor de eventos", detail: "Lanza eventvwr.msc para inspeccionar más a fondo.", category: "diagnostic" },
  "pc-reliability-monitor": { kind: "pc-reliability-monitor", label: "Monitor de confiabilidad", detail: "perfmon /rel: registro diario de estabilidad del sistema.", category: "diagnostic" },
  "pc-resource-monitor": { kind: "pc-resource-monitor", label: "Monitor de recursos", detail: "resmon.exe: CPU, memoria, disco y red por proceso.", category: "diagnostic" },
  "pc-perfmon": { kind: "pc-perfmon", label: "Monitor de rendimiento", detail: "perfmon.exe: gráfica completa de contadores.", category: "diagnostic" },
  "pc-task-manager": { kind: "pc-task-manager", label: "Administrador de tareas", detail: "Lanza taskmgr.exe.", category: "diagnostic" },
  "pc-device-manager": { kind: "pc-device-manager", label: "Administrador de dispositivos", detail: "Lanza devmgmt.msc.", category: "system" },
  "pc-gpupdate": { kind: "pc-gpupdate", label: "gpupdate /force", detail: "Fuerza la actualización de las directivas de grupo.", category: "system" },
  "pc-computer-management": { kind: "pc-computer-management", label: "Administración de equipos", detail: "Abre compmgmt.msc: la consola MMC completa.", category: "system" },
  "pc-task-scheduler": { kind: "pc-task-scheduler", label: "Programador de tareas", detail: "Abre taskschd.msc.", category: "system" },
  "pc-programs-features": { kind: "pc-programs-features", label: "Programas y características", detail: "Abre appwiz.cpl: la lista de software instalado.", category: "system" },
  "pc-power-options": { kind: "pc-power-options", label: "Opciones de energía", detail: "Abre powercfg.cpl.", category: "system" },
  "pc-sound-settings": { kind: "pc-sound-settings", label: "Configuración de sonido", detail: "Abre mmsys.cpl: dispositivos de reproducción y grabación.", category: "system" },
  "pc-windows-security": { kind: "pc-windows-security", label: "Seguridad de Windows", detail: "Abre windowsdefender:.", category: "system" },
  "pc-recovery": { kind: "pc-recovery", label: "Opciones de recuperación", detail: "Abre ms-settings:recovery.", category: "system" },
  "pc-system-restore": { kind: "pc-system-restore", label: "Restaurar sistema", detail: "Lanza rstrui.exe.", category: "system" },
};

export const CATEGORY_LABELS: Record<FixCategory, string> = {
  network: "Red",
  services: "Servicios",
  update: "Windows Update / Store",
  storage: "Almacenamiento e integridad",
  shell: "Shell",
  diagnostic: "Herramientas de diagnóstico",
  system: "Sistema y administración",
};

export const CATEGORY_ORDER: FixCategory[] = [
  "network", "services", "update", "storage", "shell", "diagnostic", "system",
];

// ---------------------------------------------------------------------------
// Known Windows Event IDs
// ---------------------------------------------------------------------------

export const KNOWN_ERRORS: Record<number, KnownError> = {
  41: { description: "Kernel-Power: el sistema se reinició sin apagarse bien (cuelgue, corte de luz o driver bloqueado).", fixes: ["pc-mdsched", "pc-power-troubleshooter", "pc-reliability-monitor", "pc-event-viewer", "pc-device-manager", "pc-sfc", "pc-dism", "pc-chkdsk"], severity: "critical" },
  1001: { description: "Windows Error Reporting: una aplicación o un driver falló y WER lo registró.", fixes: ["pc-event-viewer", "pc-reliability-monitor", "pc-sfc", "pc-dism", "pc-restart-explorer"], severity: "error" },
  6008: { description: "Apagado inesperado: el apagado anterior no fue limpio (reinicio forzado, pantallazo azul o corte de luz).", fixes: ["pc-mdsched", "pc-chkdsk", "pc-power-troubleshooter", "pc-reliability-monitor", "pc-event-viewer"], severity: "critical" },
  7000: { description: "Un servicio no pudo arrancar: Windows no consiguió lanzarlo.", fixes: ["pc-services-mmc", "pc-event-viewer", "pc-sfc", "pc-dism"], severity: "error" },
  7001: { description: "Un servicio depende de otro que no arrancó: se ha roto una cadena de dependencias.", fixes: ["pc-services-mmc", "pc-event-viewer"], severity: "error" },
  7011: { description: "Tiempo de espera de un servicio: Windows dejó de esperar su respuesta (30 s por defecto).", fixes: ["pc-services-mmc", "pc-restart-explorer"], severity: "warning" },
  7031: { description: "Un servicio se cayó y el SCM está intentando recuperarlo.", fixes: ["pc-services-mmc", "pc-event-viewer", "pc-restart-wsearch", "pc-restart-bits"], severity: "warning" },
  4625: { description: "Inicio de sesión fallido: contraseña incorrecta, cuenta caducada o bloqueada.", fixes: ["pc-event-viewer", "pc-gpupdate"], severity: "warning" },
  1000: { description: "Error de aplicación: un proceso de usuario se cayó (bucket AppCrash).", fixes: ["pc-event-viewer", "pc-sfc", "pc-dism", "pc-clear-temp", "pc-restart-explorer"], severity: "error" },
  10010: { description: "El servidor DCOM no se registró en DCOM dentro del tiempo exigido.", fixes: ["pc-event-viewer", "pc-services-mmc", "pc-sfc"], severity: "warning" },
  372: { description: "Error de la cola de impresión: el servicio spooler ha entrado en un estado de error.", fixes: ["pc-restart-spooler", "pc-services-mmc", "pc-clear-temp"], severity: "error" },
  20: { description: "Fallo al instalar una actualización de Windows Update (WUA).", fixes: ["pc-repair-wu", "pc-reset-wu-components", "pc-restart-wuauserv", "pc-restart-bits", "pc-windows-update", "pc-wu-troubleshooter", "pc-sfc"], severity: "error" },
  25: { description: "Fallo al descargar una actualización de Windows Update.", fixes: ["pc-repair-wu", "pc-restart-bits", "pc-restart-wuauserv", "pc-network-troubleshooter", "pc-flush-dns"], severity: "warning" },
  7034: { description: "Un servicio terminó de forma inesperada. El SCM registra la caída; revisa el servicio de origen.", fixes: ["pc-services-mmc", "pc-event-viewer", "pc-restart-wsearch", "pc-restart-bits", "pc-sfc"], severity: "error" },
  7: { description: "El disco tiene un bloque defectuoso: puede estar empezando a fallar el hardware.", fixes: ["pc-chkdsk", "pc-event-viewer", "pc-reliability-monitor", "pc-disk-management"], severity: "critical" },
  219: { description: "Un driver no se instaló bien: seguramente falta o es incompatible.", fixes: ["pc-device-manager", "pc-event-viewer", "pc-sfc"], severity: "warning" },
  153: { description: "Se reintentó una operación de E/S tras agotar el tiempo: posibles problemas de disco.", fixes: ["pc-chkdsk", "pc-event-viewer", "pc-disk-management"], severity: "warning" },
  10016: { description: "Permiso DCOM denegado: no se concedió la activación local.", fixes: ["pc-event-viewer", "pc-services-mmc", "pc-gpupdate"], severity: "warning" },
  1003: { description: "BugCheck: el sistema se cayó y generó un volcado del kernel (pantallazo azul).", fixes: ["pc-mdsched", "pc-reliability-monitor", "pc-event-viewer", "pc-sfc", "pc-dism", "pc-device-manager"], severity: "critical" },
  1002: { description: "Aplicación bloqueada: un proceso dejó de responder a Windows.", fixes: ["pc-event-viewer", "pc-reliability-monitor", "pc-clear-temp", "pc-restart-explorer"], severity: "warning" },
};

export const GENERIC_FIXES = ["pc-event-viewer", "pc-reliability-monitor", "pc-services-mmc", "pc-sfc", "pc-dism", "pc-network-troubleshooter"];

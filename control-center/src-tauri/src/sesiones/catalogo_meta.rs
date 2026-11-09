// sesiones/catalogo_meta.rs — Metadatos estáticos de los comandos `/`
// (contrato de estabilidad, §2.3-§2.4 y cambio de diseño del 2026-10-08:
// todos los slash commands desde el chat).
//
// `BUILTIN_META`: integrados de Claude Code 2.1.293 (revisados contra la
// tabla del inventario). `MOD_META`: comandos de los mods de ULTRON (dos
// tests de `tests_catalogo.rs` fallan si un mod registra uno sin entrada).
// Clases: `prompt` (abre turno), `local` (imprime texto), `menu` (abre un
// menú o diálogo de la TUI: bloque de menú en el chat), `exit` (cierra la
// CLI) y `unsupported` solo con imposibilidad real, con su nota.
//
// Propiedad: WP-ESTADO.

use crate::sesiones::types::CommandKind;
use CommandKind::{Exit as X, Local as L, Menu as M, Prompt as P, Unsupported as U};

/// Metadatos de un comando.
#[derive(Debug, Clone, Copy)]
pub struct Meta {
    pub nombre: &'static str,
    pub desc: &'static str,
    pub hint: Option<&'static str>,
    /// Clase sin argumentos.
    pub kind: CommandKind,
    /// Clase con argumentos (`/model <id>` es `local`, `/model` es `menu`).
    pub con_args: CommandKind,
    pub needs_args: bool,
    pub immediate: bool,
    pub aliases: &'static [&'static str],
    pub nota: Option<&'static str>,
    /// Mod que registra el comando (solo en `MOD_META`).
    pub plugin: Option<&'static str>,
}

const fn m(
    nombre: &'static str,
    desc: &'static str,
    kind: CommandKind,
    con_args: CommandKind,
) -> Meta {
    Meta {
        nombre,
        desc,
        hint: None,
        kind,
        con_args,
        needs_args: false,
        immediate: false,
        aliases: &[],
        nota: None,
        plugin: None,
    }
}

impl Meta {
    const fn hint(self, h: &'static str) -> Self {
        Self {
            hint: Some(h),
            ..self
        }
    }
    const fn inm(self) -> Self {
        Self {
            immediate: true,
            ..self
        }
    }
    const fn args(self) -> Self {
        Self {
            needs_args: true,
            ..self
        }
    }
    const fn alias(self, a: &'static [&'static str]) -> Self {
        Self { aliases: a, ..self }
    }
    const fn nota(self, n: &'static str) -> Self {
        Self {
            nota: Some(n),
            ..self
        }
    }
    const fn de(self, plugin: &'static str) -> Self {
        Self {
            plugin: Some(plugin),
            ..self
        }
    }

    /// Clase efectiva según haya argumentos.
    pub fn kind_para(&self, args: &str) -> CommandKind {
        if args.trim().is_empty() {
            self.kind
        } else {
            self.con_args
        }
    }

    pub fn responde_a(&self, nombre: &str) -> bool {
        self.nombre == nombre || self.aliases.contains(&nombre)
    }
}

const SEGUNDO_PLANO: &str =
    "Las sesiones en segundo plano desconectarían la ventana de ULTRON Sessions";
const DISPOSICION: &str = "La disposición de la TUI la fija ULTRON Sessions para poder leerla";

/// Integrados de Claude Code 2.1.293.
pub const BUILTIN_META: &[Meta] = &[
    m("add-dir", "Añade un directorio de trabajo", M, L)
        .hint("<ruta>")
        .inm(),
    m("advisor", "Modelo asesor de la sesión", M, L).hint("[modelo|off]"),
    m("agents", "Agentes de Claude Code", M, M),
    m("artifacts", "Artefactos de la sesión", M, M),
    m("auto-mode-setup", "Configura el modo auto", M, M),
    m("autocompact", "Umbral de compactación automática", M, L).hint("[auto|n]"),
    m("background", "Pasa la sesión a segundo plano", U, U)
        .alias(&["bg"])
        .nota(SEGUNDO_PLANO),
    m("batch", "Tareas en lote", P, P),
    m("branch", "Bifurca la conversación", L, L).hint("[nombre]"),
    m(
        "btw",
        "Pregunta rápida sin interrumpir la conversación",
        M,
        M,
    )
    .hint("<pregunta>")
    .inm(),
    m("cd", "Cambia el directorio de trabajo", L, L)
        .hint("<ruta>")
        .args(),
    m("chrome", "Integración con Chrome", M, M),
    m("claude-api", "Ayuda con la API de Claude", P, P),
    m(
        "clear",
        "Empieza una conversación nueva (vacía el contexto)",
        L,
        L,
    )
    .alias(&["new", "reset"]),
    m("code-review", "Revisa una pull request o los cambios", P, P).alias(&["review"]),
    m("color", "Color de la sesión", M, M),
    m(
        "compact",
        "Resume la conversación para liberar contexto",
        P,
        P,
    )
    .hint("[instrucciones]"),
    m("config", "Ajustes de Claude Code", M, L)
        .alias(&["settings"])
        .hint("[clave=valor]"),
    m("context", "Uso de la ventana de contexto", L, L).hint("[all]"),
    m("copy", "Copia la última respuesta", M, L).hint("[n]"),
    m("dataviz", "Visualización de datos", P, P),
    m("debug", "Depura un problema", P, P),
    m("deep-research", "Investigación a fondo", P, P),
    m("design", "Diseño de interfaz", P, P),
    m("design-login", "Inicia sesión en Claude Design", M, M),
    m("design-sync", "Sincroniza con Claude Design", M, M),
    m("desktop", "Continúa la sesión en Claude Desktop", U, U)
        .nota("Movería la sesión fuera de ULTRON Sessions"),
    m("diff", "Diff de los cambios", M, M),
    m("doctor", "Diagnóstico de la instalación", M, M),
    m("effort", "Nivel de effort del modelo", M, L)
        .hint("[low|medium|high|xhigh|max|auto]")
        .inm(),
    m("exit", "Cierra Claude Code", X, X).alias(&["quit"]),
    m("export", "Exporta la conversación", M, L).hint("[fichero]"),
    m("fast", "Modo rápido", L, L).hint("[on|off]").inm(),
    m("feedback", "Envía comentarios", M, M)
        .alias(&["bug"])
        .inm(),
    m(
        "fewer-permission-prompts",
        "Reduce las peticiones de permiso",
        P,
        P,
    ),
    m("focus", "Modo foco de la TUI", U, U).nota(DISPOSICION),
    m("fork", "Bifurca a una sesión en segundo plano", U, U).nota(SEGUNDO_PLANO),
    m(
        "goal",
        "Fija un objetivo que Claude comprueba antes de parar",
        P,
        P,
    )
    .hint("<objetivo>"),
    m("heapdump", "Volcado de memoria de la CLI", L, L),
    m("help", "Ayuda y lista de comandos", M, M),
    m("hooks", "Configuración de hooks", M, M),
    m("ide", "Integración con el IDE", M, M),
    m("import", "Importa ajustes de otra herramienta", M, L).hint("[--yes] [--dry-run]"),
    m("init", "Crea un CLAUDE.md para el proyecto", P, P),
    m("insights", "Informe de uso de la sesión", P, P),
    m("install-github-app", "Instala la app de GitHub", M, M),
    m("install-slack-app", "Instala la app de Slack", M, M),
    m("keybindings", "Atajos de teclado de la TUI", M, M),
    m("list-agents", "Lista de agentes", M, M),
    m("login", "Inicia sesión en la cuenta de Claude", M, M),
    m("logout", "Cierra la sesión de la cuenta de Claude", M, M),
    m("loop", "Repite una tarea", P, P),
    m("mcp", "Servidores MCP", M, L).hint("[reconnect|enable|disable <servidor>]"),
    m("memory", "CLAUDE.md y memoria", M, M),
    m("mobile", "Continúa en el móvil", M, M),
    m("model", "Modelo de la sesión", M, L)
        .hint("[modelo]")
        .inm(),
    m("output-style", "Estilo de salida", M, L).hint("[estilo]"),
    m("passes", "Pases de invitación", M, M),
    m("permissions", "Reglas de permisos de herramientas", M, M)
        .alias(&["allowed-tools"])
        .inm(),
    m("plan", "Modo plan", L, P).hint("[descripción]"),
    m("plugin", "Plugins de Claude Code", M, L).hint("[list|install|enable|disable …]"),
    m("powerup", "Mejoras de la cuenta", M, M),
    m("privacy-settings", "Ajustes de privacidad", M, M),
    m("radio", "Radio", M, M),
    m(
        "rate-limit-options",
        "Opciones al llegar al límite de uso",
        M,
        M,
    ),
    m("recap", "Resumen de una línea de la sesión", L, L),
    m("release-notes", "Novedades de la versión", M, M),
    m(
        "reload-plugins",
        "Activa los cambios pendientes de plugins",
        L,
        L,
    ),
    m("reload-skills", "Recarga las skills", L, L),
    m("remote-control", "Control remoto de la sesión", M, M),
    m("remote-env", "Entorno remoto", M, M),
    m("rename", "Renombra la conversación", L, L).hint("[nombre]"),
    m("resume", "Reanuda una conversación anterior", M, L)
        .alias(&["continue"])
        .hint("[sesión]"),
    m(
        "rewind",
        "Vuelve a un punto anterior de la conversación",
        M,
        M,
    )
    .alias(&["checkpoint", "undo"]),
    m("run", "Ejecuta una tarea", P, P),
    m("sandbox", "Ajustes del sandbox", M, M),
    m(
        "scroll-speed",
        "Velocidad de desplazamiento de la TUI",
        M,
        M,
    ),
    m(
        "security-review",
        "Revisión de seguridad de los cambios",
        P,
        P,
    ),
    m("setup-bedrock", "Configura Amazon Bedrock", M, M),
    m("setup-vertex", "Configura Google Vertex", M, M),
    m("simplify", "Simplifica el código cambiado", P, P),
    m("skill-doctor", "Diagnóstico de skills", M, M),
    m("skills", "Skills disponibles", M, M),
    m("slides", "Presentaciones", P, P),
    m("status", "Estado de la sesión, la cuenta y el modelo", M, M).inm(),
    m("statusline", "Línea de estado de la TUI", M, M),
    m("stickers", "Pegatinas", M, M),
    m("stop", "Detiene la sesión en segundo plano", U, U).nota(SEGUNDO_PLANO),
    m("subtask", "Lanza una subtarea", P, P).hint("<tarea>"),
    m("tasks", "Tareas en segundo plano", M, M)
        .alias(&["bashes"])
        .inm(),
    m("teleport", "Trae una sesión web a esta terminal", M, M),
    m("terminal-setup", "Configura la terminal", M, M),
    m("theme", "Tema de la TUI", M, M),
    m("tui", "Disposición de la TUI", U, U).nota(DISPOSICION),
    m("update-config", "Actualiza la configuración", P, P),
    m("upgrade", "Mejora el plan", M, M),
    m("usage", "Coste de la sesión y uso del plan", M, M)
        .alias(&["cost", "stats"])
        .inm(),
    m("usage-credits", "Créditos de uso", M, M),
    m("verify", "Verifica los cambios", P, P),
    m("vim", "Modo vim de la caja de entrada", U, U)
        .nota("El modo vim cambiaría cómo recibe la TUI el texto del chat"),
    m("voice", "Dictado por voz de la TUI", U, U).nota("Voz: botón Voz o Ctrl+Espacio"),
    m("web-setup", "Configura Claude en la web", M, M),
    m("workflows", "Workflows de la sesión", M, M),
];

/// Comandos de los mods de ULTRON (`$.command.register`).
pub const MOD_META: &[Meta] = &[
    m("adjuntar", "", M, M).inm().de("ultron-adjuntar"),
    m("captura", "", L, L).inm().de("ultron-adjuntar"),
    m("citar", "", U, U)
        .inm()
        .de("ultron-adjuntar")
        .nota("La selección con el ratón no existe en la TUI oculta: cita desde el chat"),
    m("agentes", "", M, M).inm().de("ultron-agentes"),
    m("codex", "", M, L).inm().de("ultron-codex"),
    m("codex-write", "", L, L).inm().de("ultron-codex"),
    m("codex-review", "", L, L).inm().de("ultron-codex"),
    m("contexto", "", M, M).inm().de("ultron-contexto"),
    m("git", "", M, M).inm().de("ultron-git"),
    m("socratico", "", L, L).inm().de("ultron-hud"),
    m("uso", "", M, M).inm().de("ultron-uso"),
    m("papercut", "", L, L).inm().de("ultron-papercut"),
    m("checkpoints", "", L, L).inm().de("ultron-checkpoint"),
    m("checkpoint-diff", "", L, L).inm().de("ultron-checkpoint"),
    m("entregas", "", L, L).inm().de("ultron-entregas"),
    m("compilar", "", L, L).inm().de("ultron-atajos"),
    m("probar", "", L, L).inm().de("ultron-atajos"),
    m("arrancar", "", L, L).inm().de("ultron-atajos"),
    m("relevo", "", L, L).de("ultron-relevo"),
    m("permisos", "", L, L).de("ultron-permisos"),
    m("mejorar", "", L, L)
        .de("ultron-mejorar")
        .nota("Lo resuelve el composer de ULTRON Sessions"),
];

/// Metadatos de un integrado por nombre o alias.
pub fn builtin(nombre: &str) -> Option<&'static Meta> {
    BUILTIN_META.iter().find(|m| m.responde_a(nombre))
}

/// Metadatos de un comando de mod por nombre.
pub fn de_mod(nombre: &str) -> Option<&'static Meta> {
    MOD_META.iter().find(|m| m.responde_a(nombre))
}

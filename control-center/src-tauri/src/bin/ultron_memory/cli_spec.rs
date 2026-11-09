//! Contrato de flags de cada subcomando de `ultron-memory` y la puerta que lo
//! aplica antes de despachar.
//!
//! Auditoría 2026-10-23: `sweep --help` y `stale --help` EJECUTABAN escrituras
//! masivas (deprecar los ACTIVE de baja confianza, pasar a stale los de 180
//! días), porque esos brazos no rechazaban flags desconocidos y su modo por
//! defecto escribe. Ahora `run()` llama a [`preflight`] antes de tocar nada:
//! `--help`/`-h` devuelven la ayuda del subcomando sin ejecutarlo, y cualquier
//! `--flag` fuera de la lista del subcomando es un error.

use crate::cli_args::reject_unknown_flags;

/// Flag global: lo leen `run()` y varios subcomandos.
const GLOBAL_FLAGS: &[&str] = &["--project"];

/// Flags y uso de un subcomando. `key` es el nombre tal cual o, en los que
/// tienen sub-subcomando (`inbox`, `deprecations`), `"<cmd> <sub>"`.
pub(crate) struct Spec {
    pub key: &'static str,
    pub flags: &'static [&'static str],
    pub usage: &'static str,
}

const fn spec(key: &'static str, flags: &'static [&'static str], usage: &'static str) -> Spec {
    Spec { key, flags, usage }
}

/// Subcomandos con sub-subcomando: la clave de [`SPECS`] incluye el segundo
/// argumento.
const NESTED: &[&str] = &["inbox", "deprecations"];

pub(crate) const SPECS: &[Spec] = &[
    spec("resume", &[], "resume [--project X]"),
    spec("orchestrate", &["--sparse"], "orchestrate <prompt> [--sparse] [--project X]"),
    spec("trace", &["--cross", "--all-projects"], "trace <query> [--cross|--all-projects] [--project X]"),
    spec(
        "recall",
        &["--cross", "--all-projects", "--diagnostic"],
        "recall <query> [--cross|--all-projects] [--diagnostic] [--project X]",
    ),
    spec("stats", &[], "stats"),
    spec(
        "backfill-projects",
        &["--apply", "--min-score", "--min-share", "--knn", "--llm", "--llm-min-conf"],
        "backfill-projects [--apply] [--min-score F] [--min-share F] [--knn N] [--llm] [--llm-min-conf F]",
    ),
    spec("curate", &["--id", "--title", "--apply"], "curate --id <id> [--project P] [--title T] [--apply]"),
    spec("reassign-project", &["--from", "--to", "--apply"], "reassign-project --from A --to B [--apply]"),
    spec(
        "hubs",
        &["--prompts", "--threshold", "--min-count", "--apply", "--with-penalty"],
        "hubs [--prompts 200] [--threshold 0.2] [--min-count 5] [--apply] [--with-penalty]",
    ),
    spec("reindex", &[], "reindex"),
    spec("catalog", &["--agents", "--skills"], "catalog [--agents|--skills]"),
    spec("eval", &["--golden", "--summary"], "eval [--golden [<path>]] [--summary] [--project X]"),
    spec("eval-full", &[], "eval-full [--project X]"),
    spec("reconcile", &["--fix", "--dry-run"], "reconcile [--fix [--dry-run]]"),
    spec("candidate", &[], "candidate  (candidato JSON por stdin)"),
    spec("supersede", &["--old"], "supersede --old <id>  (item nuevo JSON por stdin)"),
    spec("capture", &["--session"], "capture [--session <id>] [--project X]  (transcript por stdin)"),
    spec("provenance", &["--id"], "provenance --id <id|prefix>"),
    spec("warmup", &[], "warmup"),
    spec("doctor", &[], "doctor"),
    spec("forget", &["--id", "--dry-run", "--reason"], "forget --id <id|prefix> [--dry-run] [--reason R]"),
    spec(
        "archive",
        &["--type", "--older-than-days", "--dry-run", "--reason"],
        "archive --type <T> [--older-than-days 14] [--dry-run] [--reason R]",
    ),
    spec(
        "deprecate",
        &["--id", "--type", "--dry-run", "--reason"],
        "deprecate (--id <id|prefix> | --type <T> [--project P]) [--dry-run] [--reason R]",
    ),
    spec(
        "stale",
        &["--older-than-days", "--dry-run", "--reason"],
        "stale [--older-than-days 180] [--dry-run] [--reason R]",
    ),
    spec("fts-rebuild", &[], "fts-rebuild"),
    spec("secret-backfill", &["--dry-run"], "secret-backfill [--dry-run]"),
    spec("pii-backfill", &["--dry-run"], "pii-backfill [--dry-run]"),
    spec("scrub-secrets", &["--dry-run"], "scrub-secrets [--dry-run]"),
    spec("gc", &["--days", "--dry-run"], "gc [--days 90] [--dry-run]"),
    spec("sweep", &["--below", "--dry-run", "--reason"], "sweep [--below 0.55] [--dry-run] [--reason R]"),
    spec("dedupe", &["--dry-run", "--reason"], "dedupe [--dry-run] [--reason R]"),
    spec("deprecations apply", &["--dry-run"], "deprecations apply [--dry-run]"),
    spec("golden-remap", &[], "golden-remap"),
    spec("reindex-skills-lazy", &[], "reindex-skills-lazy"),
    spec("skill-query", &["--top"], "skill-query <prompt> [--top N]"),
    spec("skill-judge", &[], "skill-judge <prompt>"),
    spec("serve", &[], "serve"),
    spec("serve-ping", &[], "serve-ping"),
    spec("inbox list", &[], "inbox list"),
    spec("inbox approve-clean", &[], "inbox approve-clean"),
    spec("inbox approve-all", &[], "inbox approve-all"),
    spec("inbox drain", &["--dry-run", "--auto"], "inbox drain [--auto] [--dry-run]"),
    spec("inbox approve", &["--id"], "inbox approve --id <candidate-id>"),
    spec("inbox reject", &["--id", "--reason"], "inbox reject --id <candidate-id> [--reason R]"),
    spec("inbox auto-approve", &[], "inbox auto-approve <on|off>"),
    spec("version", &[], "version"),
];

/// Clave de [`SPECS`] para un argv completo (`argv[0]` es el binario).
fn spec_key(args: &[String]) -> String {
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    if NESTED.contains(&cmd) {
        let sub = args.get(2).map(String::as_str).unwrap_or("");
        format!("{cmd} {sub}")
    } else {
        cmd.to_string()
    }
}

fn find(key: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|s| s.key == key)
}

fn is_help_flag(a: &str) -> bool {
    a == "--help" || a == "-h"
}

/// Ayuda en JSON (la salida normal del binario): uso y flags del subcomando
/// pedido, o de todos si no se reconoce.
fn help_json(key: &str) -> serde_json::Value {
    match find(key) {
        Some(s) => serde_json::json!({
            "help": true,
            "subcommand": s.key,
            "usage": format!("ultron-memory {}", s.usage),
            "flags": s.flags.iter().chain(GLOBAL_FLAGS).collect::<Vec<_>>(),
            "executed": false,
        }),
        None => serde_json::json!({
            "help": true,
            "usage": SPECS
                .iter()
                .map(|s| format!("ultron-memory {}", s.usage))
                .collect::<Vec<_>>(),
            "executed": false,
        }),
    }
}

/// Puerta previa al despacho. `Ok(Some(ayuda))`: se pidió ayuda y NO se ejecuta
/// nada. `Ok(None)`: los flags son válidos para el subcomando (o el subcomando
/// no existe y lo rechaza el despachador). `Err`: hay un flag desconocido.
pub(crate) fn preflight(args: &[String]) -> Result<Option<serde_json::Value>, String> {
    let key = spec_key(args);
    if args.iter().skip(1).any(|a| is_help_flag(a))
        || args.get(1).map(String::as_str) == Some("help")
    {
        return Ok(Some(help_json(&key)));
    }
    let Some(s) = find(&key) else {
        return Ok(None);
    };
    let allowed: Vec<&str> = s.flags.iter().chain(GLOBAL_FLAGS).copied().collect();
    reject_unknown_flags(args, &allowed).map(|()| None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Subcomandos cuyo modo por defecto (o alguna rama) escribe en brain.db,
    /// Qdrant o los ficheros de ajustes. Cada uno debe tratar `--help` como
    /// ayuda y rechazar un typo de `--dry-run` sin ejecutarse.
    const WRITERS: &[&[&str]] = &[
        &["sweep"],
        &["stale"],
        &["forget", "--id", "abc"],
        &["deprecate", "--type", "fact"],
        &["archive", "--type", "agent_note"],
        &["gc"],
        &["dedupe"],
        &["fts-rebuild"],
        &["secret-backfill"],
        &["pii-backfill"],
        &["scrub-secrets"],
        &["deprecations", "apply"],
        &["curate", "--id", "abc"],
        &["reassign-project", "--from", "a", "--to", "b"],
        &["backfill-projects"],
        &["hubs"],
        &["reindex"],
        &["reindex-skills-lazy"],
        &["catalog"],
        &["reconcile", "--fix"],
        &["candidate"],
        &["supersede", "--old", "abc"],
        &["capture"],
        &["inbox", "approve-all"],
        &["inbox", "approve-clean"],
        &["inbox", "drain"],
        &["inbox", "approve", "--id", "abc"],
        &["inbox", "reject", "--id", "abc"],
        &["inbox", "auto-approve", "on"],
    ];

    fn argv(parts: &[&str], extra: &str) -> Vec<String> {
        std::iter::once("ultron-memory")
            .chain(parts.iter().copied())
            .chain(std::iter::once(extra))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn help_no_ejecuta_ningun_subcomando_que_escribe() {
        for parts in WRITERS {
            for flag in ["--help", "-h"] {
                let out = preflight(&argv(parts, flag))
                    .unwrap_or_else(|e| panic!("{parts:?} {flag}: {e}"))
                    .unwrap_or_else(|| panic!("{parts:?} {flag} se despacharía"));
                assert_eq!(out["executed"], false, "{parts:?}");
                assert!(out["usage"].is_string(), "{parts:?}: ayuda propia");
            }
        }
    }

    // Caso negativo: un typo de `--dry-run` no puede pasar como si no estuviera
    // (el modo por defecto de estos subcomandos escribe).
    #[test]
    fn un_flag_desconocido_se_rechaza_en_todo_subcomando_que_escribe() {
        for parts in WRITERS {
            let err = preflight(&argv(parts, "--dryrun"))
                .expect_err(&format!("{parts:?} --dryrun debe fallar"));
            assert!(err.contains("--dryrun"), "{parts:?}: {err}");
        }
    }

    #[test]
    fn flags_validos_pasan_la_puerta() {
        let ok: &[&[&str]] = &[
            &["sweep", "--below", "0.4", "--dry-run"],
            &[
                "stale",
                "--older-than-days",
                "30",
                "--dry-run",
                "--project",
                "ultron",
            ],
            &["inbox", "drain", "--auto", "--dry-run"],
            &["recall", "qdrant", "--cross", "--diagnostic"],
            &["eval", "--golden", "ruta.json", "--summary"],
        ];
        for parts in ok {
            let args: Vec<String> = std::iter::once("ultron-memory")
                .chain(parts.iter().copied())
                .map(str::to_string)
                .collect();
            assert_eq!(preflight(&args), Ok(None), "{parts:?}");
        }
    }

    #[test]
    fn todo_subcomando_del_despachador_tiene_contrato() {
        // Mismo listado que los brazos de `run()`, `maintenance_command` e
        // `inbox_command`: un subcomando nuevo sin entrada en SPECS no tendría
        // ni ayuda ni rechazo de flags.
        let despachados = [
            "resume",
            "orchestrate",
            "trace",
            "recall",
            "stats",
            "backfill-projects",
            "curate",
            "reassign-project",
            "hubs",
            "reindex",
            "catalog",
            "eval",
            "eval-full",
            "reconcile",
            "candidate",
            "supersede",
            "capture",
            "provenance",
            "warmup",
            "doctor",
            "forget",
            "archive",
            "deprecate",
            "stale",
            "fts-rebuild",
            "secret-backfill",
            "pii-backfill",
            "scrub-secrets",
            "gc",
            "sweep",
            "dedupe",
            "deprecations apply",
            "golden-remap",
            "reindex-skills-lazy",
            "skill-query",
            "skill-judge",
            "serve",
            "serve-ping",
            "inbox list",
            "inbox approve-clean",
            "inbox approve-all",
            "inbox drain",
            "inbox approve",
            "inbox reject",
            "inbox auto-approve",
            "version",
        ];
        for key in despachados {
            assert!(find(key).is_some(), "{key} sin entrada en SPECS");
        }
        assert_eq!(SPECS.len(), despachados.len());
    }

    #[test]
    fn un_texto_libre_que_empieza_por_guiones_no_es_un_flag() {
        let args: Vec<String> = [
            "ultron-memory",
            "orchestrate",
            "--no es un flag, es un prompt",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        assert_eq!(preflight(&args), Ok(None));
    }
}

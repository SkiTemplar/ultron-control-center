// Destacados — descubrir repositorios de skills, agentes y MCP, y aplicarlos.
//
// 2026-09-22. Antes esta pantalla se llamaba "Catalog" y tenía seis pestañas
// (Trending/Skills/Agents/Rules/MCPs/Repos) que resolvían todas por la CLI
// `gh`, ausente en esta máquina: las seis devolvían el mismo banner rojo en
// cada montaje. Dos cambios de fondo:
//
//   * Se agrupa por FUENTE (oficiales / en alza / mejor valorados / skills /
//     agentes / MCP / búsqueda libre) y no por topic de GitHub. Un topic no es
//     una taxonomía: `claude-agents` tiene 130 repos en todo GitHub, así que
//     su pestaña salía casi vacía aunque `gh` hubiera funcionado.
//   * Cada tarjeta tiene dos acciones reales: "Ver qué trae" (manifiesto +
//     avisos de seguridad, sin escribir nada) y desde ahí "Aplicar". El botón
//     "Integrar con IA" se queda como tercera vía.
//
// Se conserva lo que ya funcionaba: la barra de filtros y el analizador de
// repos locales, que iba por Rust+Node y nunca tocó `gh`.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  analyzeLocalRepo,
  reposBuscar,
  reposDetalle,
} from "../../lib/library-client";
import type {
  AnalyzeRepoResult,
  DetalleRepo,
  FuenteRepos,
  RepoHit,
  RespuestaBusqueda,
} from "../../types";
import { getPrompt } from "../../lib/button-prompts";
import { InstallConfirmModal } from "./InstallConfirmModal";
import {
  desde,
  estadoPantalla,
  filtrarHits,
  segundosHastaReinicio,
  type FiltrosDestacados,
} from "./destacados-helpers";
import {
  AlertTriangle,
  Check,
  Clipboard,
  Compass,
  Eye,
  Folder,
  Github,
  Loader,
  Search,
  Sparkles,
  X,
} from "./icons";

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------

const FUENTES: { id: FuenteRepos; label: string; hint: string }[] = [
  {
    id: "oficiales",
    label: "Oficiales",
    hint: "Repos de referencia verificados. No gastan la cuota de búsqueda.",
  },
  {
    id: "en_alza",
    label: "En alza",
    hint: "Creados en los últimos 6 meses, ordenados por estrellas/día. GitHub no publica API de trending: esto es una aproximación.",
  },
  {
    id: "mejor_valorados",
    label: "Mejor valorados",
    hint: "Más estrellas entre los que siguen vivos (push en 90 días).",
  },
  { id: "skills", label: "Skills", hint: "topic:agent-skills" },
  { id: "agentes", label: "Agentes", hint: "topic:claude-code-agents" },
  { id: "mcps", label: "MCP", hint: "topic:mcp-server" },
  {
    id: "libre",
    label: "Búsqueda libre",
    hint: "Escribe y pulsa Enter: admite calificadores de GitHub (stars:>100, language:rust…).",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function repoUrl(hit: RepoHit): string {
  return hit.html_url ?? `https://github.com/${hit.full_name}`;
}

// `desde`, `segundosHastaReinicio`, `filtrarHits` y `estadoPantalla` viven en
// destacados-helpers.ts: son puras y se prueban ahí sin montar React.

// ---------------------------------------------------------------------------
// FilterBar
// ---------------------------------------------------------------------------

type FilterState = FiltrosDestacados;

type FilterBarProps = {
  filters: FilterState;
  allTopics: string[];
  onFiltersChange: (f: FilterState) => void;
};

function FilterBar({ filters, allTopics, onFiltersChange }: FilterBarProps) {
  function update(partial: Partial<FilterState>) {
    onFiltersChange({ ...filters, ...partial });
  }

  function toggleTopic(t: string) {
    const next = filters.topics.includes(t)
      ? filters.topics.filter((x) => x !== t)
      : [...filters.topics, t];
    update({ topics: next });
  }

  const hasActive = filters.minStars > 0 || filters.topics.length > 0;

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t px-6 py-2 text-[11.5px]"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <label className="flex items-center gap-1.5" style={{ color: "var(--color-text-secondary)" }}>
        <span className="shrink-0">Mín ★</span>
        <input
          type="number"
          min={0}
          value={filters.minStars}
          onChange={(e) => update({ minStars: Math.max(0, Number(e.target.value)) })}
          className="w-16 rounded border px-1.5 py-0.5 text-[11px] outline-none"
          style={{
            background: "var(--color-surface-2)",
            borderColor: "var(--color-border-strong)",
            color: "var(--color-text)",
          }}
        />
      </label>

      {/* Chips de topic. Antes nunca se pintaban: `gh` había dejado caer el
          campo `topics` de su --json y la lista siempre salía vacía. */}
      {allTopics.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span style={{ color: "var(--color-text-tertiary)" }}>Topic:</span>
          {allTopics.slice(0, 10).map((t) => {
            const active = filters.topics.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTopic(t)}
                className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors"
                style={{
                  background: active ? "var(--color-accent)" : "var(--color-surface-3)",
                  color: active ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${active ? "var(--color-accent)" : "var(--color-border)"}`,
                }}
              >
                {t}
              </button>
            );
          })}
        </div>
      )}

      {hasActive && (
        <button
          type="button"
          onClick={() => onFiltersChange({ minStars: 0, topics: [] })}
          className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px]"
          style={{
            color: "var(--color-text-secondary)",
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <X size={10} /> Quitar filtros
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocalRepoAnalyzer (iter-10) — wires `analyze_local_repo`
// ---------------------------------------------------------------------------
//
// Escanea un repo YA en disco buscando skills/agentes y lanza la MISMA
// integración post-instalación que un install de GitHub (refresco del catálogo
// de routing + candidato de memoria gobernada). Read-only: no copia nada.

function LocalRepoAnalyzer() {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeRepoResult | null>(null);

  async function pickFolder() {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Selecciona el repo local a analizar",
      });
      if (typeof picked === "string") setPath(picked);
    } catch (e) {
      setError(String(e));
    }
  }

  async function analyze() {
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await analyzeLocalRepo(p);
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const integration = result?.integration;

  return (
    <div
      className="border-t px-6 py-3 text-[12px]"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="mb-2 flex items-center gap-2" style={{ color: "var(--color-text-secondary)" }}>
        <Folder size={14} />
        <span className="font-medium">Analizar repo local</span>
        <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          Escanea skills/agentes ya en disco y los integra al catálogo + memoria (read-only).
        </span>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void analyze(); }}
          placeholder="Ruta del repo (o usa Examinar…)"
          className="flex-1 rounded-md border px-2.5 py-1.5 text-[12px] outline-none"
          style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border-strong)", color: "var(--color-text)", fontFamily: "var(--font-mono)" }}
        />
        <button
          type="button"
          onClick={() => void pickFolder()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11.5px] disabled:opacity-60"
          style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-2)", color: "var(--color-text)" }}
        >
          <Folder size={12} /> Examinar…
        </button>
        <button
          type="button"
          onClick={() => void analyze()}
          disabled={busy || !path.trim()}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-60"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)", border: "1px solid var(--color-border-strong)" }}
        >
          {busy ? <><Loader size={12} className="animate-spin" /> Analizando…</> : <><Sparkles size={12} /> Analizar</>}
        </button>
      </div>

      {error && (
        <div
          className="mt-2 rounded-md border p-2 text-[11.5px]"
          style={{ background: "rgba(248, 81, 73, 0.06)", borderColor: "rgba(248, 81, 73, 0.22)", color: "var(--color-danger)" }}
        >
          <div className="flex items-center gap-1.5 font-medium"><AlertTriangle size={12} /> Fallo al analizar</div>
          <div className="mt-0.5" style={{ color: "var(--color-text-secondary)" }}>{error}</div>
        </div>
      )}

      {result && integration && (
        <div
          className="mt-2 rounded-md border p-2.5 text-[11.5px]"
          style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border-strong)", color: "var(--color-text)" }}
        >
          <div className="mb-1 flex items-center gap-1.5 font-medium" style={{ color: "var(--color-success)" }}>
            <Check size={12} /> Analizado
          </div>
          <div className="space-y-1" style={{ color: "var(--color-text-secondary)" }}>
            <div>
              <span style={{ color: "var(--color-text-tertiary)" }}>Ruta: </span>
              <span style={{ fontFamily: "var(--font-mono)" }}>{result.repo_path}</span>
            </div>
            <div>
              <span style={{ color: "var(--color-text-tertiary)" }}>Skills/agentes detectados ({result.assets.length}): </span>
              {result.assets.length > 0 ? (
                <span className="flex flex-wrap gap-1 pt-1">
                  {result.assets.map((a) => (
                    <span
                      key={a}
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)", border: "1px solid var(--color-border)", fontFamily: "var(--font-mono)" }}
                    >
                      {a}
                    </span>
                  ))}
                </span>
              ) : (
                <span style={{ color: "var(--color-text-tertiary)" }}>(ninguno)</span>
              )}
            </div>
            <div>
              <span style={{ color: "var(--color-text-tertiary)" }}>Catálogo: </span>
              {integration.registry_synced
                ? `sincronizado (${integration.newly_detected} nuevos detectados)`
                : "no sincronizado"}
            </div>
            <div>
              <span style={{ color: "var(--color-text-tertiary)" }}>Candidato de memoria: </span>
              {integration.memory_candidate_id
                ? <span style={{ fontFamily: "var(--font-mono)" }}>{integration.memory_candidate_id}</span>
                : "ninguno"}
            </div>
            {integration.warnings.length > 0 && (
              <ul className="list-inside list-disc pt-0.5" style={{ color: "var(--color-warning, var(--color-text-tertiary))" }}>
                {integration.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Destacados
// ---------------------------------------------------------------------------

export function Catalog() {
  const [fuente, setFuente] = useState<FuenteRepos>("oficiales");
  // `query` filtra en local sobre lo ya traído; `appliedQuery` es lo último
  // que se mandó a GitHub. Separados para que teclear no gaste cuota.
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [resp, setResp] = useState<RespuestaBusqueda | null>(null);
  const [hitsLoading, setHitsLoading] = useState(false);
  const [hitsError, setHitsError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<Record<string, "copied">>({});
  const [aiState, setAiState] = useState<Record<string, "launching" | "launched">>({});
  const [refreshTick, setRefreshTick] = useState(0);
  // Solo el boton Refrescar salta la cache. Sin esta bandera, una vez pulsado
  // TODOS los cambios de fuente posteriores gastarian cuota: con 10 consultas
  // por minuto sin token, eso seca la aplicacion en dos clics.
  const forzar = useRef(false);

  // "Ver qué trae": una llamada por tarjeta, a petición del usuario.
  const [detalleDe, setDetalleDe] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<DetalleRepo | null>(null);
  const [detalleError, setDetalleError] = useState<string | null>(null);

  const [filters, setFilters] = useState<FilterState>({ minStars: 0, topics: [] });

  const hits = resp?.hits ?? [];
  const allTopics = Array.from(new Set(hits.flatMap((h) => h.topics))).sort();
  const textNeedle = query.trim().toLowerCase();
  const filteredHits = filtrarHits(hits, query, filters);

  const runSearch = useCallback(
    async (refrescar: boolean) => {
      setHitsLoading(true);
      setHitsError(null);
      try {
        const r = await reposBuscar(
          fuente,
          fuente === "libre" ? appliedQuery : null,
          30,
          refrescar,
        );
        setResp(r);
      } catch (e) {
        // Aquí sólo llegan los fallos de verdad (sin red, comando caído): la
        // cuota agotada viaja DENTRO de la respuesta, que es otro estado.
        setHitsError(String(e));
        setResp(null);
      } finally {
        setHitsLoading(false);
      }
    },
    [fuente, appliedQuery],
  );

  const submitSearch = useCallback(() => {
    if (fuente === "libre") setAppliedQuery(query.trim());
  }, [query, fuente]);

  useEffect(() => {
    void runSearch(forzar.current);
    forzar.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fuente, appliedQuery, refreshTick]);

  // ---------------------------------------------------------------------------
  // Acciones por tarjeta
  // ---------------------------------------------------------------------------

  async function copyToClipboard(hit: RepoHit) {
    const url = repoUrl(hit);
    try {
      await navigator.clipboard.writeText(url);
      setCopyState((s) => ({ ...s, [hit.full_name]: "copied" }));
      setTimeout(() => {
        setCopyState((s) => {
          const next = { ...s };
          delete next[hit.full_name];
          return next;
        });
      }, 1500);
    } catch {
      /* no-op */
    }
  }

  /** Lee el árbol del repo y enseña el manifiesto. No escribe nada. */
  async function verQueTrae(hit: RepoHit) {
    setDetalleDe(hit.full_name);
    setDetalleError(null);
    try {
      const d = await reposDetalle(hit.owner, hit.name);
      setDetalle(d);
    } catch (e) {
      setDetalleError(`${hit.full_name}: ${String(e)}`);
    } finally {
      setDetalleDe(null);
    }
  }

  // "Integrar con IA" — abre una sesión de Claude con el análisis del repo. El
  // prompt delimita el texto del repositorio y lo declara DATO, no
  // instrucciones, y la sesión no puede escribir sin OK explícito.
  async function integrateWithAi(hit: RepoHit) {
    const url = repoUrl(hit);
    try {
      const meta = [
        `- Repositorio: ${hit.full_name}`,
        `- URL: ${url}`,
        hit.description ? `- Descripción: ${hit.description}` : null,
        `- Estrellas: ${hit.stars}`,
        hit.language ? `- Lenguaje principal: ${hit.language}` : null,
        hit.topics.length > 0 ? `- Topics: ${hit.topics.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      const prompt = await getPrompt("catalog.integrate_with_ai", {
        repo: hit.full_name,
        url,
        meta,
      });
      setAiState((s) => ({ ...s, [hit.full_name]: "launching" }));
      await invoke("spawn_session", {
        provider: "claude",
        prompt,
        cwd: null,
        flags: { dangerouslySkipPermissions: false },
      });
      setAiState((s) => ({ ...s, [hit.full_name]: "launched" }));
      setTimeout(() => {
        setAiState((s) => {
          const next = { ...s };
          delete next[hit.full_name];
          return next;
        });
      }, 2000);
    } catch (e) {
      setAiState((s) => {
        const next = { ...s };
        delete next[hit.full_name];
        return next;
      });
      setHitsError(`No se pudo lanzar la sesión de IA: ${String(e)}`);
    }
  }

  const cuota = resp?.cuota;
  const esperaCuota = segundosHastaReinicio(cuota?.reinicio_epoch ?? null);
  const fuenteActual = FUENTES.find((f) => f.id === fuente);
  // Un solo sitio decide qué pantalla se ve, y está probado aparte.
  const estado = estadoPantalla({
    cargando: hitsLoading,
    error: hitsError,
    resp,
    visibles: filteredHits.length,
  });

  return (
    <div className="flex h-full flex-col" style={{ background: "var(--color-surface)" }}>
      {/* CABECERA */}
      <div
        className="sticky top-0 z-10 border-b"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div className="px-6 py-4">
          <div className="flex items-center gap-3">
            <Compass size={18} className="shrink-0" />
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitSearch(); }}
                placeholder={
                  fuente === "libre"
                    ? "Escribe y pulsa Enter para preguntar a GitHub…"
                    : "Filtra lo que ya está en pantalla (no gasta cuota)…"
                }
                className="w-full rounded-md border py-2.5 pl-9 pr-9 text-sm outline-none"
                style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border-strong)", color: "var(--color-text)" }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 hover:opacity-70"
                  style={{ color: "var(--color-text-tertiary)" }}
                  title="Borrar el texto del filtro"
                  aria-label="Borrar el texto del filtro"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={submitSearch}
              disabled={hitsLoading || fuente !== "libre"}
              className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-text)", border: "1px solid var(--color-border-strong)" }}
              title={
                fuente === "libre"
                  ? "Manda la consulta a GitHub"
                  : "Esta fuente ya trae su lista: para preguntar a GitHub con tus palabras, cambia a «Búsqueda libre»"
              }
            >
              {hitsLoading ? <><Loader size={13} className="animate-spin" /> Buscando</> : <><Search size={13} /> Buscar</>}
            </button>
            <button
              type="button"
              onClick={() => {
                forzar.current = true;
                setRefreshTick((n) => n + 1);
              }}
              disabled={hitsLoading}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs disabled:opacity-60"
              style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface-2)", color: "var(--color-text)" }}
              title="Vuelve a preguntar a GitHub saltándose la caché (gasta una consulta)"
            >
              Refrescar
            </button>
          </div>

          {/* Selector de fuente */}
          <div className="mt-3 flex flex-wrap gap-1">
            {FUENTES.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFuente(f.id)}
                className="rounded-md px-3 py-1.5 text-[12.5px] transition-colors"
                style={{
                  background: fuente === f.id ? "var(--color-surface-3)" : "transparent",
                  color: fuente === f.id ? "var(--color-text)" : "var(--color-text-secondary)",
                  border: `1px solid ${fuente === f.id ? "var(--color-border-strong)" : "var(--color-border)"}`,
                }}
                title={f.hint}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Qué se está viendo y qué queda de cuota */}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
            {fuenteActual && <span>{fuenteActual.hint}</span>}
            {resp?.consulta && (
              <span style={{ fontFamily: "var(--font-mono)" }}>{resp.consulta}</span>
            )}
            {resp?.desde_cache && <span>· servido de caché</span>}
            {cuota && cuota.restantes !== null && (
              <span title={cuota.con_token ? "Con GITHUB_TOKEN: 30 búsquedas/min" : "Sin token: 10 búsquedas/min para TODA la aplicación"}>
                · cuota {cuota.recurso}: {cuota.restantes}
                {cuota.limite !== null ? `/${cuota.limite}` : ""}
                {cuota.con_token ? "" : " (sin token)"}
              </span>
            )}
          </div>
        </div>

        {hits.length > 0 && (
          <FilterBar filters={filters} allTopics={allTopics} onFiltersChange={setFilters} />
        )}

        <LocalRepoAnalyzer />
      </div>

      {/* CUERPO */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {/* Estado: sin red / fallo del comando */}
        {estado === "error" && (
          <div
            className="mb-3 rounded-md border p-3 text-[12.5px]"
            style={{ background: "rgba(248, 81, 73, 0.06)", borderColor: "rgba(248, 81, 73, 0.22)", color: "var(--color-danger)" }}
          >
            <div className="mb-1 flex items-center gap-2 font-medium">
              <AlertTriangle size={13} /> No se pudo hablar con GitHub
            </div>
            <div className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>{hitsError}</div>
            <button
              type="button"
              onClick={() => {
                forzar.current = true;
                setRefreshTick((n) => n + 1);
              }}
              className="mt-2 rounded border px-2 py-1 text-[11px]"
              style={{ borderColor: "var(--color-border-strong)", color: "var(--color-text)" }}
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Estado: cuota agotada — distinto de "sin red" y de "sin resultados" */}
        {estado === "cuota" && (
          <div
            className="mb-3 rounded-md border p-3 text-[12.5px]"
            style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border-strong)", color: "var(--color-text)" }}
          >
            <div className="mb-1 flex items-center gap-2 font-medium">
              <AlertTriangle size={13} /> Cuota de GitHub agotada
            </div>
            <div className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
              {cuota?.con_token
                ? "Son 30 búsquedas por minuto."
                : "Sin token son 10 búsquedas por minuto para toda la aplicación. Pon un GITHUB_TOKEN en Ajustes → API Keys para subir a 30."}
              {esperaCuota !== null && ` Se reinicia en ${Math.ceil(esperaCuota)} s.`}
            </div>
          </div>
        )}

        {/* Avisos de la respuesta (parcialidad, dato viejo, listas vacías) */}
        {estado !== "cuota" && (resp?.avisos.length ?? 0) > 0 && (
          <div
            className="mb-3 rounded-md border p-2.5 text-[11.5px]"
            style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
          >
            <ul className="list-inside list-disc space-y-0.5">
              {resp?.avisos.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </div>
        )}

        {detalleError && (
          <div
            className="mb-3 rounded-md border p-2.5 text-[11.5px]"
            style={{ background: "rgba(248, 81, 73, 0.06)", borderColor: "rgba(248, 81, 73, 0.22)", color: "var(--color-danger)" }}
          >
            No se pudo leer el repositorio: {detalleError}
          </div>
        )}

        {/* Estado: cargando */}
        {estado === "cargando" && (
          <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            <Loader size={13} className="animate-spin" />
            Cargando {fuenteActual?.label.toLowerCase()}…
          </div>
        )}

        {/* Estado: vacío */}
        {estado === "vacio" && (
          <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            Esta fuente no ha devuelto nada. Prueba otra o pásate a «Búsqueda libre».
          </p>
        )}

        {filteredHits.length > 0 && (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {filteredHits.map((hit) => {
              const copied = copyState[hit.full_name] === "copied";
              const aiBusy = aiState[hit.full_name];
              const viendo = detalleDe === hit.full_name;
              return (
                <li
                  key={hit.full_name}
                  className="flex h-[248px] flex-col rounded-md border p-3 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    borderColor: "var(--color-border-strong)",
                    color: "var(--color-text)",
                  }}
                >
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Github size={12} className="shrink-0 text-[var(--color-text-tertiary)]" />
                    <span className="font-medium">{hit.name}</span>
                    <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}>
                      {hit.owner}
                    </span>
                    <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text-secondary)" }} title="Estrellas">
                      ★ {formatStars(hit.stars)}
                    </span>
                    {hit.language && (
                      <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)" }}>
                        {hit.language}
                      </span>
                    )}
                  </div>

                  {/* Señales: lo que la API REST sí devuelve y `gh` no daba */}
                  <div className="mb-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
                    {hit.stars_per_day !== null && (
                      <span title="Estrellas por día desde que se creó">
                        {hit.stars_per_day.toFixed(1)} ★/día
                      </span>
                    )}
                    {desde(hit.pushed_at) && <span>push {desde(hit.pushed_at)}</span>}
                    <span>{hit.license ?? "sin licencia"}</span>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {hit.description && (
                      <p className="mb-1.5 line-clamp-2 text-[11.5px] leading-snug" style={{ color: "var(--color-text-secondary)" }}>
                        {hit.description}
                      </p>
                    )}
                    {hit.topics.length > 0 && (
                      <div className="flex flex-wrap gap-1 overflow-hidden" style={{ maxHeight: "3rem" }}>
                        {hit.topics.slice(0, 5).map((t) => (
                          <span
                            key={t}
                            className="rounded px-1.5 py-0.5 text-[9.5px]"
                            style={{ background: "var(--color-surface-3)", color: "var(--color-text-tertiary)", border: "1px solid var(--color-border)" }}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="mt-2 flex flex-col gap-1.5 text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                    <span className="truncate" style={{ fontFamily: "var(--font-mono)" }} title={hit.full_name}>
                      {hit.full_name}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {/* Ver qué trae — manifiesto + avisos, sin escribir nada */}
                      <button
                        type="button"
                        onClick={() => void verQueTrae(hit)}
                        disabled={viendo}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-medium disabled:opacity-60"
                        style={{
                          color: "var(--color-accent-text)",
                          background: "var(--color-accent)",
                          border: "1px solid var(--color-border-strong)",
                          fontSize: "10.5px",
                        }}
                        title="Lee el árbol del repo y enseña qué trae y qué se escribiría. No instala nada."
                      >
                        {viendo ? (
                          <><Loader size={11} className="animate-spin" /> Leyendo…</>
                        ) : (
                          <><Eye size={11} /> Ver qué trae</>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => void integrateWithAi(hit)}
                        disabled={!!aiBusy}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-medium disabled:opacity-60"
                        style={{
                          color: aiBusy ? "var(--color-success)" : "var(--color-text)",
                          background: aiBusy ? "rgba(63, 185, 80, 0.12)" : "var(--color-surface-3)",
                          border: aiBusy ? "1px solid rgba(63, 185, 80, 0.30)" : "1px solid var(--color-border)",
                          fontSize: "10.5px",
                        }}
                        title="Lanza una sesión de IA que lo analiza y te pide el OK antes de instalar"
                      >
                        {aiBusy === "launching" ? (
                          <><Loader size={11} className="animate-spin" /> Lanzando…</>
                        ) : aiBusy === "launched" ? (
                          <><Check size={11} /> Lanzado</>
                        ) : (
                          <><Sparkles size={11} /> Integrar con IA</>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => void copyToClipboard(hit)}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 font-medium"
                        style={{
                          color: copied ? "var(--color-success)" : "var(--color-text)",
                          background: copied ? "rgba(63, 185, 80, 0.12)" : "var(--color-surface-3)",
                          border: copied ? "1px solid rgba(63, 185, 80, 0.30)" : "1px solid var(--color-border)",
                          fontSize: "10.5px",
                        }}
                        title="Copiar la URL del repo al portapapeles"
                      >
                        {copied ? <Check size={11} /> : <Clipboard size={11} />}
                        {copied ? "¡Copiado!" : "Copiar"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Vacío por filtros locales, que es otra cosa que "sin resultados" */}
        {estado === "vacio-por-filtros" && (
          <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {textNeedle
              ? `Nada contiene «${query.trim()}». Borra el texto o pásate a «Búsqueda libre» para preguntar a GitHub.`
              : "Ningún resultado pasa los filtros. Ajusta el mínimo de estrellas o el topic."}
          </p>
        )}
      </div>

      {/* El manifiesto y la aplicación reutilizan el modal de instalación */}
      {detalle && (
        <InstallConfirmModal
          detalle={detalle}
          onClose={() => setDetalle(null)}
          onInstalled={() => setDetalle(null)}
        />
      )}
    </div>
  );
}

export default Catalog;

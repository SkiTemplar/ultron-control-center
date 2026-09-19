// Control Center — Memory -> Retrato (2026-09-16).
//
// Qué sabe mar.ia del usuario: resumen, afirmaciones por bloque con sus
// fuentes, proyectos, opinión y trato. El retrato lo genera
// scripts/memory-portrait.mjs (claude -p Sonnet) en
// cockpit/memory-portrait/portrait.json; se regenera solo cada 7 días desde
// el SessionStart y a mano con el botón.
//
// Backend (src-tauri/src/commands/memory/portrait.rs):
//   - memory_portrait_get() -> Portrait | null
//   - memory_portrait_mark({ claimId, state }) -> Portrait
//   - memory_portrait_regenerate() -> "started"
// Descartar una afirmación también depreca sus fuentes de brain.db
// (memory_item_deprecate, reversible): así la basura sale de la memoria y no
// solo del retrato.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Card, SmallButton } from "./dashboard/Card";

type ClaimState = "none" | "confirmed" | "discarded";

interface Claim {
  id: string;
  texto: string;
  fuentes: string[];
  estado: ClaimState;
}

interface Block {
  id: string;
  titulo: string;
  afirmaciones: Claim[];
}

interface Project {
  nombre: string;
  que_es: string;
  estado: string;
}

export interface Portrait {
  generated_at: string;
  model: string;
  stats?: Record<string, number>;
  resumen: string;
  bloques: Block[];
  proyectos: Project[];
  opinion: string;
  trato: string;
}

const POLL_MS = 5000;
const POLL_MAX_MS = 6 * 60 * 1000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES");
}

/** Ids de brain.db citados como "mem:<id>" en las fuentes de una afirmación. */
export function memorySourceIds(fuentes: string[]): string[] {
  return fuentes.filter((f) => f.startsWith("mem:")).map((f) => f.slice(4)).filter(Boolean);
}

export function MemoryPortrait() {
  const [portrait, setPortrait] = useState<Portrait | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const p = (await invoke("memory_portrait_get")) as Portrait | null;
      setPortrait(p);
      setError(null);
      return p;
    } catch (e) {
      setError(errMsg(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, [load]);

  const regenerate = useCallback(async () => {
    const before = portrait?.generated_at ?? null;
    setRegenerating(true);
    setNotice(null);
    try {
      await invoke("memory_portrait_regenerate");
    } catch (e) {
      setRegenerating(false);
      setNotice(`No se pudo lanzar la regeneración: ${errMsg(e)}`);
      return;
    }
    const started = Date.now();
    pollRef.current = window.setInterval(async () => {
      const p = await load();
      const done = p !== null && p.generated_at !== before;
      const timedOut = Date.now() - started > POLL_MAX_MS;
      if (done || timedOut) {
        if (pollRef.current !== null) window.clearInterval(pollRef.current);
        pollRef.current = null;
        setRegenerating(false);
        setNotice(done ? "Retrato actualizado." : "La regeneración no terminó en 6 min: revisa logs/memory-portrait.log.");
      }
    }, POLL_MS);
  }, [portrait, load]);

  const mark = useCallback(async (claim: Claim, state: ClaimState) => {
    try {
      const updated = (await invoke("memory_portrait_mark", { claimId: claim.id, state })) as Portrait;
      setPortrait(updated);
      if (state === "discarded") {
        const ids = memorySourceIds(claim.fuentes);
        const results = await Promise.allSettled(
          ids.map((id) => invoke("memory_item_deprecate", { id, reason: "retrato: afirmación descartada por el usuario" })),
        );
        const failed = results.filter((r) => r.status === "rejected").length;
        setNotice(
          ids.length === 0
            ? "Afirmación descartada (sin fuentes de brain.db que deprecar)."
            : `Afirmación descartada; ${ids.length - failed}/${ids.length} fuente(s) deprecadas en brain.db.`,
        );
      }
    } catch (e) {
      setNotice(`No se pudo marcar: ${errMsg(e)}`);
    }
  }, []);

  if (loading) {
    return <div className="p-5 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>Cargando retrato...</div>;
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold" style={{ color: "var(--color-text)" }}>
            Retrato
          </h1>
          <p className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            {portrait
              ? `Generado ${formatDate(portrait.generated_at)} · ${portrait.model}` +
                (portrait.stats
                  ? ` · ${portrait.stats.memorias_personales ?? 0} memorias personales, ${portrait.stats.ficheros ?? 0} ficheros`
                  : "")
              : "Todavía no hay retrato generado."}
            {" "}Se actualiza solo cada 7 días.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SmallButton onClick={() => setShowDiscarded((v) => !v)} disabled={!portrait}>
            {showDiscarded ? "Ocultar descartadas" : "Ver descartadas"}
          </SmallButton>
          <SmallButton variant="accent" onClick={() => void regenerate()} disabled={regenerating}>
            {regenerating ? "Regenerando... (1-3 min)" : "Regenerar"}
          </SmallButton>
        </div>
      </div>

      {(notice || error) && (
        <div
          className="px-3 py-2 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: `1px solid ${error ? "var(--color-danger)" : "var(--color-border)"}`,
            color: "var(--color-text-secondary)",
          }}
        >
          {error ?? notice}
        </div>
      )}

      {portrait && (
        <>
          <Card title="Resumen" empty={portrait.resumen ? null : "Sin resumen."}>
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--color-text)" }}>
              {portrait.resumen}
            </p>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Qué opino de ti" empty={portrait.opinion ? null : "Sin opinión."}>
              <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
                {portrait.opinion}
              </p>
            </Card>
            <Card title="Cómo me tratas" empty={portrait.trato ? null : "Sin datos."}>
              <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
                {portrait.trato}
              </p>
            </Card>
          </div>

          {portrait.bloques.map((b) => {
            const visibles = b.afirmaciones.filter((a) => showDiscarded || a.estado !== "discarded");
            return (
              <Card key={b.id} title={b.titulo} subtitle={`${visibles.length} afirmaciones`} empty={visibles.length ? null : "Nada todavía."}>
                <div className="flex flex-col gap-1.5">
                  {visibles.map((a) => (
                    <ClaimRow key={a.id} claim={a} onMark={(s) => void mark(a, s)} />
                  ))}
                </div>
              </Card>
            );
          })}

          <Card title="Proyectos" subtitle={`${portrait.proyectos.length}`} empty={portrait.proyectos.length ? null : "Sin proyectos."}>
            <div className="flex flex-col gap-1">
              {portrait.proyectos.map((p) => (
                <div key={p.nombre} className="flex items-baseline gap-2 text-[12px]">
                  <span className="font-medium" style={{ color: "var(--color-text)" }}>{p.nombre}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>{p.estado}</span>
                  <span style={{ color: "var(--color-text-secondary)" }}>{p.que_es}</span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function ClaimRow({ claim, onMark }: { claim: Claim; onMark: (s: ClaimState) => void }) {
  const tone =
    claim.estado === "confirmed"
      ? "var(--color-success)"
      : claim.estado === "discarded"
        ? "var(--color-danger)"
        : "var(--color-border)";
  return (
    <div
      className="flex flex-wrap items-start gap-2 px-3 py-2"
      style={{ background: "var(--color-surface-2)", borderLeft: `2px solid ${tone}` }}
    >
      <div className="min-w-0 flex-1">
        <p
          className="text-[12.5px]"
          style={{
            color: "var(--color-text)",
            textDecoration: claim.estado === "discarded" ? "line-through" : "none",
          }}
        >
          {claim.texto}
        </p>
        {claim.fuentes.length > 0 && (
          <p className="mt-0.5 truncate text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }} title={claim.fuentes.join("\n")}>
            {claim.fuentes.map((f) => (f.startsWith("mem:") ? f.slice(0, 12) : f.split("/").pop())).join(" · ")}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        {claim.estado !== "none" ? (
          <SmallButton onClick={() => onMark("none")}>Quitar marca</SmallButton>
        ) : (
          <>
            <SmallButton onClick={() => onMark("confirmed")} title="Se conserva en las próximas regeneraciones">
              Confirmar
            </SmallButton>
            <SmallButton
              onClick={() => onMark("discarded")}
              title="No vuelve al retrato y depreca sus fuentes de brain.db (reversible)"
            >
              Descartar
            </SmallButton>
          </>
        )}
      </div>
    </div>
  );
}

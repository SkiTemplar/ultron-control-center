// System → Turn Off — apagado programado del PC.
//
// El plazo lo cumple Windows (`shutdown.exe`), no un timer de la app: por
// eso el plan persiste en ~/.ultron/cockpit/turn-off.json y, al reabrir el
// Control Center, este panel repinta el estado real consultando
// `turn_off_status` en vez de asumir que no hay nada programado.
//
// Backend: src-tauri/src/commands/system_ops/turn_off.rs
//   turn_off_schedule(hours) / turn_off_cancel() / turn_off_status()
// Acción pesada (apaga el PC) → UI pesimista: el toggle solo refleja
// `active` una vez el backend confirma, nunca de forma optimista.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TurnOffState } from "../../../types/system";
import { formatCountdown, MAX_HOURS, MIN_HOURS, secondsUntil, validateHours } from "./turnOffFormat";

const POLL_INTERVAL_MS = 1000;
const DEFAULT_HOURS = "1";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Error inesperado.";
}

function nowEpochSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export function TurnOffPanel() {
  const [state, setState] = useState<TurnOffState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hoursInput, setHoursInput] = useState(DEFAULT_HOURS);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = (await invoke("turn_off_status")) as TurnOffState;
      setState(s);
      if (s.active && s.hours !== null) {
        setHoursInput(String(s.hours));
      }
    } catch (e) {
      setError(errMsg(e));
      setState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Cuenta atrás en cliente, recalculada cada segundo a partir del deadline
  // absoluto — nunca un contador local que se desincronice de Windows.
  useEffect(() => {
    if (!state?.active || state.deadline_epoch_secs === null) {
      setRemainingSeconds(0);
      return;
    }
    const deadline = state.deadline_epoch_secs;

    const tick = () => {
      const remaining = secondsUntil(deadline, nowEpochSecs());
      setRemainingSeconds(remaining);
      if (remaining <= 0) {
        // El plazo venció: pedir al backend el estado real en vez de
        // asumir en cliente que ya se limpió el registro.
        void load();
      }
    };

    tick();
    const intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [state?.active, state?.deadline_epoch_secs, load]);

  const handleSchedule = useCallback(async () => {
    const hours = Number(hoursInput);
    const validation = validateHours(hours);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const s = (await invoke("turn_off_schedule", { hours })) as TurnOffState;
      setState(s);
      setSuccessMsg(`Apagado programado dentro de ${hours} h.`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [hoursInput]);

  const handleCancel = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const s = (await invoke("turn_off_cancel")) as TurnOffState;
      setState(s);
      setSuccessMsg("Apagado cancelado.");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleToggle = useCallback(
    (next: boolean) => {
      if (next) {
        void handleSchedule();
      } else {
        void handleCancel();
      }
    },
    [handleSchedule, handleCancel],
  );

  const active = state?.active ?? false;

  return (
    <section className="mb-6 space-y-3">
      <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Programa el apagado de este PC con antelación. Lo ejecuta Windows
        (shutdown.exe): el plazo sigue en pie aunque cierres el Control
        Center.
      </p>

      {error && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded px-2.5 py-1 text-[11.5px] font-medium"
            style={{ border: "1px solid var(--color-danger)", color: "var(--color-danger)" }}
          >
            Reintentar
          </button>
        </div>
      )}

      {successMsg && !error && (
        <div
          className="rounded p-2 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {successMsg}
        </div>
      )}

      <div
        className="flex flex-wrap items-center gap-5 rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <label
          className="flex items-center gap-2 text-[13px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          <input
            type="checkbox"
            checked={active}
            disabled={busy || loading}
            onChange={(e) => handleToggle(e.target.checked)}
          />
          {loading ? "Comprobando…" : active ? "Apagado programado" : "Programar apagado"}
        </label>

        <label
          className="flex flex-col gap-1 text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Horas ({MIN_HOURS}–{MAX_HOURS})
          <input
            type="number"
            step="0.1"
            min={MIN_HOURS}
            max={MAX_HOURS}
            value={hoursInput}
            disabled={active || busy || loading}
            onChange={(e) => setHoursInput(e.target.value)}
            className="rounded px-2 py-1 text-[12px] disabled:opacity-50"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text)",
            }}
          />
        </label>

        {active && (
          <>
            <div
              className="flex flex-col gap-1 text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Apaga en
              <span
                className="rounded px-2 py-1 text-[16px] font-semibold tabular-nums"
                style={{
                  background: "var(--color-surface-1)",
                  border: "1px solid var(--color-border-strong)",
                  color: "var(--color-text)",
                }}
              >
                {formatCountdown(remainingSeconds)}
              </span>
            </div>

            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={busy}
              className="rounded px-3 py-2 text-[12.5px] font-medium disabled:opacity-50"
              style={{ background: "var(--color-danger)", color: "var(--color-accent-text)" }}
            >
              {busy ? "…" : "Cancelar"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

import { useState } from "react";
import {
  DEFAULT_GAMES,
  MAX_GAMES,
  OUTFITS,
  gameExeError,
  normalizeGames,
  type GameEntry,
  type GameOutfit,
  type MascotSettings,
} from "../mascot/settings";
import { SettingsSwitch } from "./SettingsSwitch";

// Settings > Pupus > Juegos — «no molestar» con un juego delante y la tabla
// de juegos conocidos con su disfraz (games.rs la vuelve a normalizar al
// guardar). Todo local: Pupus lo detecta por el ejecutable en primer plano.

const OUTFIT_LABEL: Record<GameOutfit, string> = {
  car: "Coche",
  pirate: "Pirata",
  tactical: "Táctico",
  none: "Sin disfraz",
};

const cell: React.CSSProperties = {
  background: "var(--color-surface-1)",
  border: "1px solid var(--color-border)",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 12,
  color: "var(--color-text)",
};

const card: React.CSSProperties = {
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "14px 16px",
};

const linkBtn: React.CSSProperties = {
  fontSize: 12,
  color: "var(--color-accent)",
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 0,
};

interface Props {
  s: MascotSettings;
  update: (patch: Partial<MascotSettings>, debounce?: boolean) => void;
}

function GameRow({
  g,
  error,
  onChange,
  onRemove,
}: {
  g: GameEntry;
  error: string | null;
  onChange: (g: GameEntry) => void;
  onRemove: () => void;
}) {
  return (
    <div className="grid grid-cols-[1fr_1fr_110px_auto] items-center gap-2 py-1">
      <input
        style={{ ...cell, borderColor: error ? "var(--color-danger, #E5484D)" : undefined }}
        value={g.exe}
        placeholder="juego.exe"
        title={error ?? "Nombre del ejecutable (sin carpeta)"}
        onChange={(e) => onChange({ ...g, exe: e.target.value })}
      />
      <input
        style={cell}
        value={g.name}
        placeholder="Nombre"
        onChange={(e) => onChange({ ...g, name: e.target.value })}
      />
      <select
        style={cell}
        value={g.outfit}
        onChange={(e) => onChange({ ...g, outfit: e.target.value as GameOutfit })}
      >
        {OUTFITS.map((o) => (
          <option key={o} value={o}>
            {OUTFIT_LABEL[o]}
          </option>
        ))}
      </select>
      <button type="button" style={linkBtn} title="Quitar de la tabla" onClick={onRemove}>
        quitar
      </button>
    </div>
  );
}

export function MascotGamesSection({ s, update }: Props) {
  // La tabla se edita en local: solo se guarda cuando todas las filas valen.
  const [rows, setRows] = useState<GameEntry[]>(() => s.games.map((g) => ({ ...g })));
  const errors = rows.map((g) => gameExeError(g.exe));
  const firstError = errors.find((e) => e !== null) ?? null;

  const commit = (next: GameEntry[]) => {
    setRows(next);
    if (next.every((g) => gameExeError(g.exe) === null)) update({ games: normalizeGames(next) }, true);
  };

  return (
    <section style={card}>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
        Escritorio y juegos
      </h3>
      <label className="flex cursor-pointer items-start gap-3 py-1.5">
        <SettingsSwitch
          className="mt-0.5"
          checked={s.game_mode}
          onChange={(v) => update({ game_mode: v })}
          label="Modo juego: no molestar"
        />
        <span>
          <span className="text-[12.5px]" style={{ color: "var(--color-text)" }}>
            Modo juego: no molestar
          </span>
          <span className="block text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            Con un juego de la tabla delante (o algo sin bordes a pantalla completa) no saca bocadillos, no pasea por
            su cuenta, no se sube al juego y los clics lo atraviesan. Si el juego le deja sin suelo en su monitor, se
            esconde. Los avisos se dan al salir.
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-3 py-1.5">
        <SettingsSwitch
          className="mt-0.5"
          checked={s.taskbar_hints}
          onChange={(v) => update({ taskbar_hints: v })}
          label="Señala la barra de tareas"
        />
        <span>
          <span className="text-[12.5px]" style={{ color: "var(--color-text)" }}>
            Señala la barra de tareas
          </span>
          <span className="block text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            Cuando una app hace parpadear su botón, o llega un aviso de Sessions con su ventana en segundo plano, va
            hasta el botón y lo señala con una flecha (solo con la barra abajo y visible).
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-3 py-1.5">
        <SettingsSwitch
          className="mt-0.5"
          checked={s.taskbar_islands}
          onChange={(v) => update({ taskbar_islands: v })}
          label="Barra transparente con islas"
        />
        <span>
          <span className="text-[12.5px]" style={{ color: "var(--color-text)" }}>
            Barra transparente con islas
          </span>
          <span className="block text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            Para una barra de tareas transparente: baja hasta el borde de la pantalla, se sube a las islas (los botones y
            la bandeja) y en los huecos se apoya abajo del todo. Con una barra opaca, déjalo apagado.
          </span>
        </span>
      </label>
      <div className="mt-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Juegos conocidos (el disfraz se ve si Pupus está visible y los gorros están activados):
      </div>
      {rows.map((g, i) => (
        <GameRow
          key={i}
          g={g}
          error={errors[i]}
          onChange={(ng) => commit(rows.map((r, j) => (j === i ? ng : r)))}
          onRemove={() => commit(rows.filter((_, j) => j !== i))}
        />
      ))}
      {firstError && (
        <div className="text-[11.5px]" style={{ color: "var(--color-danger, #E5484D)" }}>
          No se guarda hasta corregirlo: {firstError}
        </div>
      )}
      <div className="mt-1 flex gap-4">
        <button
          type="button"
          style={linkBtn}
          disabled={rows.length >= MAX_GAMES}
          onClick={() => setRows([...rows, { exe: "", name: "", outfit: "none" }])}
        >
          + añadir juego
        </button>
        <button type="button" style={linkBtn} onClick={() => commit(DEFAULT_GAMES.map((g) => ({ ...g })))}>
          Restaurar tabla por defecto
        </button>
      </div>
    </section>
  );
}

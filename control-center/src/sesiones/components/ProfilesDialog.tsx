// Gestión de los perfiles de lanzamiento de «+ Claude»: crear, editar, duplicar
// y borrar. Modelo, effort y permisos se eligen de listas; la carpeta se escribe
// o se elige con el diálogo del sistema. «Normal» solo se puede duplicar.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApi } from "../context";
import {
  deleteProfile,
  duplicateProfile,
  NAME_MAX,
  NORMAL_ID,
  saveProfile,
  useLaunchProfiles,
  type LaunchProfile,
  type ProfileDraft,
} from "../launch-profiles";
import { EFFORTS, NEW_SESSION_MODELS } from "../prefs";
import { shortPath } from "../project-groups";
import { Dropdown, type DropdownOption } from "./Dropdown";
import { PERMISSION_MODES, permissionLabel } from "./SettingsDialog";
import { prettyModel } from "./TopBar";
import { IconClose } from "./icons";
import "../styles/profiles.css";

const INHERIT = "__ajustes__";
const INHERIT_LABEL = "Como en Ajustes";

const modelLabel = (m: string) => (m.endsWith("[1m]") ? `${prettyModel(m)} · 1M` : prettyModel(m));

const MODEL_OPTIONS: DropdownOption[] = [{ value: INHERIT, label: INHERIT_LABEL }, ...NEW_SESSION_MODELS.map((m) => ({ value: m, label: modelLabel(m) }))];
const EFFORT_OPTIONS: DropdownOption[] = [{ value: INHERIT, label: INHERIT_LABEL }, ...EFFORTS.map((e) => ({ value: e, label: e }))];
const MODE_OPTIONS: DropdownOption[] = [
  { value: INHERIT, label: INHERIT_LABEL },
  ...PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, description: m.description, tone: m.value === "bypassPermissions" ? "warn" : undefined })),
];

/** Resumen de una línea de lo que fija el perfil. */
export function profileSummary(p: LaunchProfile): string {
  const parts = [
    ...(p.model ? [modelLabel(p.model)] : []),
    ...(p.effort ? [p.effort] : []),
    ...(p.permissionMode ? [permissionLabel(p.permissionMode)] : []),
    ...(p.cwd ? [shortPath(p.cwd)] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : "Todo como en Ajustes → Sesiones nuevas";
}

function Pick({ label, value, options, onChange }: { label: string; value: string | null | undefined; options: DropdownOption[]; onChange: (v: string | null) => void }) {
  const current = value || INHERIT;
  return (
    <div className="set-row">
      <span>{label}</span>
      <Dropdown label={label} triggerClass={`tbtn${current === "bypassPermissions" ? " warn" : ""}`} value={current} options={options} align="end" width={280}
        onSelect={(v) => onChange(v === INHERIT ? null : v)} trigger={<span>{options.find((o) => o.value === current)?.label ?? current}</span>} />
    </div>
  );
}

async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title: "Carpeta de trabajo del perfil" });
  return typeof r === "string" ? r : null;
}

function Editor({ draft, onCancel, onSaved }: { draft: ProfileDraft; onCancel: () => void; onSaved: (warning: string | null) => void }) {
  const api = useApi();
  const [d, setD] = useState<ProfileDraft>(draft);
  const [error, setError] = useState<string | null>(null);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => name.current?.focus(), []);
  const set = (patch: Partial<ProfileDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setError(null);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = saveProfile(d);
    if (!r.ok) return setError(r.error);
    onSaved(r.persisted ? null : "No se pudo escribir en el almacenamiento: el perfil dura lo que esta ventana.");
  };
  const browse = () => {
    pickFolder().then((p) => p && set({ cwd: p }), (e: unknown) => setError(`No se pudo abrir el selector de carpetas: ${String(e)}`));
  };
  return (
    <form className="prof-edit" onSubmit={submit} aria-label={d.id ? `Editar ${draft.name}` : "Perfil nuevo"}>
      <label className="set-row">
        <span>Nombre</span>
        <input ref={name} className="prof-input" value={d.name} maxLength={NAME_MAX} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <Pick label="Modelo" value={d.model} options={MODEL_OPTIONS} onChange={(v) => set({ model: v })} />
      <Pick label="Effort" value={d.effort} options={EFFORT_OPTIONS} onChange={(v) => set({ effort: v })} />
      <Pick label="Permisos" value={d.permissionMode} options={MODE_OPTIONS} onChange={(v) => set({ permissionMode: v })} />
      <div className="set-row prof-cwd">
        <label htmlFor="prof-cwd">Carpeta</label>
        <input id="prof-cwd" className="prof-input" value={d.cwd ?? ""} placeholder="La del proyecto elegido" spellCheck={false}
          onChange={(e) => set({ cwd: e.target.value })} />
        {!api.isMock && <button type="button" className="btn sm" onClick={browse}>Elegir…</button>}
      </div>
      <p className="dd-note">
        La carpeta sustituye a la del proyecto al lanzar; al retomar una conversación se usa la suya. Si no existe, la sesión no arranca y se avisa.
      </p>
      {error && <p className="warn-text" role="alert">{error}</p>}
      <div className="prof-acts">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="btn pri">Guardar</button>
      </div>
    </form>
  );
}

function Row({ p, onEdit, onResult }: { p: LaunchProfile; onEdit: () => void; onResult: (msg: string | null) => void }) {
  const [armed, setArmed] = useState(false);
  const isNormal = p.id === NORMAL_ID;
  const remove = () => {
    if (!armed) return setArmed(true);
    const r = deleteProfile(p.id);
    onResult(!r.ok ? r.error : r.persisted ? null : "No se pudo escribir en el almacenamiento: el borrado dura lo que esta ventana.");
  };
  const duplicate = () => {
    const r = duplicateProfile(p.id);
    onResult(!r.ok ? r.error : r.persisted ? null : "No se pudo escribir en el almacenamiento: la copia dura lo que esta ventana.");
  };
  return (
    <li className="prof-row">
      <div className="prof-txt">
        <b>{p.name}</b>
        <span className="faint">{profileSummary(p)}</span>
      </div>
      <button className="btn sm" disabled={isNormal} title={isNormal ? "«Normal» no fija nada: duplícalo para crear uno propio" : undefined}
        aria-label={`Editar ${p.name}`} onClick={onEdit}>Editar</button>
      <button className="btn sm" aria-label={`Duplicar ${p.name}`} onClick={duplicate}>Duplicar</button>
      <button className={`btn sm danger${armed ? " armed" : ""}`} disabled={isNormal} title={isNormal ? "«Normal» no se puede borrar" : undefined}
        aria-label={armed ? `Confirmar: borrar ${p.name}` : `Borrar ${p.name}`} onClick={remove} onBlur={() => setArmed(false)}>
        {armed ? "¿Borrar?" : "Borrar"}
      </button>
    </li>
  );
}

/** Selector compacto del desplegable «+ Claude»: perfil con el que se lanza y acceso a la gestión. */
export function LaunchProfileSelect({ value, onChange, onManage }: { value: LaunchProfile; onChange: (id: string) => void; onManage: () => void }) {
  const { profiles } = useLaunchProfiles();
  return (
    <div className="dd-note new-profile">
      <div className="prof-top">
        <span>Perfil</span>
        <button type="button" className="btn sm ghost" onClick={onManage} data-testid="manage-launch-profiles">Gestionar perfiles…</button>
      </div>
      <div className="seg" role="radiogroup" aria-label="Perfil de lanzamiento" data-testid="launch-profile">
        {profiles.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={value.id === p.id} aria-pressed={value.id === p.id} title={profileSummary(p)}
            className={p.permissionMode === "bypassPermissions" ? "warn" : undefined} onClick={() => onChange(p.id)}>
            {p.name}
          </button>
        ))}
      </div>
      <span className="faint prof-sum" title={profileSummary(value)}>{profileSummary(value)}</span>
    </div>
  );
}

export function ProfilesDialog({ onClose }: { onClose: () => void }) {
  const { profiles } = useLaunchProfiles();
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // El padre pasa un cierre nuevo en cada render; con él como dependencia el
  // efecto devolvía el foco a la caja a mitad de escribir.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const edit = (draft: ProfileDraft) => {
    setNotice(null);
    setEditing(draft);
  };
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal profiles" role="dialog" aria-modal="true" aria-label="Perfiles de lanzamiento" tabIndex={-1} ref={box}>
        <header>
          <h2>Perfiles de lanzamiento</h2>
          <button className="icon-btn" aria-label="Cerrar perfiles" onClick={onClose}><IconClose /></button>
        </header>
        <section>
          <ul className="prof-list">
            {profiles.map((p) => (
              <Row key={p.id} p={p} onResult={setNotice} onEdit={() => edit({ ...p })} />
            ))}
          </ul>
          {notice && <p className="warn-text" role="alert">{notice}</p>}
          {!editing && (
            <div className="prof-acts">
              <button className="btn" onClick={() => edit({ name: "" })}>+ Perfil nuevo</button>
            </div>
          )}
        </section>
        {editing && (
          <section>
            <h3>{editing.id ? `Editar «${editing.name}»` : "Perfil nuevo"}</h3>
            <Editor key={editing.id ?? "nuevo"} draft={editing} onCancel={() => setEditing(null)}
              onSaved={(warning) => {
                setEditing(null);
                setNotice(warning);
              }} />
          </section>
        )}
      </div>
    </div>,
    document.body,
  );
}

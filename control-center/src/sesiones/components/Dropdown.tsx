// Desplegable propio (E4): sustituye a los <select> nativos y a los menús
// sueltos. Botón disparador + popover en un portal con posición fija, lista
// accesible (listbox con aria-activedescendant) y panel de detalle opcional.
// Teclado: ↑↓ Inicio Fin mueven, Enter o Espacio eligen, Esc cierra y
// devuelve el foco, Tab cierra, una letra salta a la opción que empieza por ella.
// Con `searchable`, un campo arriba filtra por etiqueta, descripción y grupo
// (sin distinguir mayúsculas ni tildes) y ↑↓ Enter siguen funcionando desde él.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { nextEnabled, typeahead } from "./dropdown-keys";

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  /** Texto corto a la derecha (versión, atajo, cifra). */
  hint?: string;
  disabled?: boolean;
  /** Motivo visible cuando está deshabilitada (mandamiento 11: nunca un no-op mudo). */
  disabledReason?: string;
  group?: string;
  /** Clase de color del punto (p. ej. `codex`, `gemini`, `claude`). */
  tone?: string;
  /** Color literal del punto (muestras de tema); se aplica por CSSOM. */
  swatch?: string;
}

export interface DropdownProps<T extends string> {
  /** Nombre accesible del popover y de la lista. */
  label: string;
  trigger: ReactNode;
  value?: T | null;
  options?: readonly DropdownOption<T>[];
  onSelect?: (value: T) => void;
  onOpen?: () => void;
  header?: ReactNode;
  footer?: ReactNode;
  placement?: "up" | "down";
  align?: "start" | "end";
  width?: number;
  disabled?: boolean;
  triggerClass?: string;
  triggerTitle?: string;
  testId?: string;
  /** Texto de ayuda del campo de filtro; sin él no hay filtro. */
  searchable?: string;
}

/** Minúsculas y sin tildes, para comparar al filtrar. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** Opciones que contienen todas las palabras de `query` en etiqueta, descripción o grupo. */
export function filterOptions<T extends string>(options: readonly DropdownOption<T>[], query: string): readonly DropdownOption<T>[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return options;
  return options.filter((o) => {
    const hay = fold(`${o.label} ${o.description ?? ""} ${o.group ?? ""}`);
    return terms.every((t) => hay.includes(t));
  });
}

const GAP = 6;
/** Alto mínimo útil del popover; con menos hueco en su lado se abre hacia el otro. */
const MIN_HEIGHT = 160;

/** Lado en el que cabe el popover: el pedido si hay hueco; si no, el que tenga más. */
export function fitSide(placement: "up" | "down", above: number, below: number): "up" | "down" {
  const room = placement === "up" ? above : below;
  const other = placement === "up" ? below : above;
  return room < MIN_HEIGHT && other > room ? (placement === "up" ? "down" : "up") : placement;
}

function usePopoverPosition(open: boolean, anchor: React.RefObject<HTMLElement | null>, placement: "up" | "down", align: "start" | "end", width: number) {
  const [style, setStyle] = useState<CSSProperties>({});
  const [side, setSide] = useState(placement);
  const place = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    const left = align === "start" ? Math.min(Math.max(8, r.left), vw - w - 8) : Math.max(8, r.right - w);
    const next: CSSProperties = { left, width: w };
    const above = r.top - GAP - 8;
    const below = vh - r.bottom - GAP - 8;
    // Sin hueco en el lado pedido (disparador al borde de la ventana), el popover
    // se salía de la pantalla con un alto mínimo fijo: se abre hacia el otro lado.
    const fit = fitSide(placement, above, below);
    if (fit === "up") {
      next.bottom = vh - r.top + GAP;
      next.maxHeight = Math.max(Math.min(MIN_HEIGHT, vh - 16), above);
    } else {
      next.top = r.bottom + GAP;
      next.maxHeight = Math.max(Math.min(MIN_HEIGHT, vh - 16), below);
    }
    setSide(fit);
    setStyle(next);
  }, [anchor, placement, align, width]);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);
  return { style, side };
}

function useOutsideClose(open: boolean, refs: React.RefObject<HTMLElement | null>[], close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, refs, close]);
}

function OptionDot({ o }: { o: DropdownOption<string> }) {
  if (o.swatch) return <i className="dd-dot" style={{ background: o.swatch }} />;
  return o.tone ? <i className={`dd-dot ${o.tone}`} /> : null;
}

interface ListProps<T extends string> {
  id: string;
  label: string;
  options: readonly DropdownOption<T>[];
  value: T | null | undefined;
  active: number;
  setActive: (i: number) => void;
  choose: (i: number) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
}

function OptionList<T extends string>({ id, label, options, value, active, setActive, choose, onKeyDown, listRef }: ListProps<T>) {
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listRef]);
  return (
    <div className="dd-list" role="listbox" id={`${id}-list`} aria-label={label} tabIndex={0} ref={listRef}
      aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const showGroup = o.group && o.group !== options[i - 1]?.group;
        return (
          <div key={o.value} role="presentation">
            {showGroup && <div className="dd-group" role="presentation">{o.group}</div>}
            <div id={`${id}-opt-${i}`} data-index={i} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
              className={`dd-opt${i === active ? " active" : ""}`} onMouseMove={() => i !== active && setActive(i)}
              onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)}>
              <span className="dd-check" aria-hidden="true">{o.value === value ? "✓" : <OptionDot o={o} />}</span>
              <span className="dd-label">{o.label}</span>
              {o.hint && <span className="dd-hint">{o.hint}</span>}
              {(o.description || (o.disabled && o.disabledReason)) && (
                <span className={`dd-desc${o.disabled ? " why" : ""}`}>{o.disabled && o.disabledReason ? o.disabledReason : o.description}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Dropdown<T extends string>(props: DropdownProps<T>) {
  const { label, trigger, value, options: all = [], onSelect, onOpen, header, footer, placement = "down", align = "start", width = 300, searchable } = props;
  const id = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState("");
  const options = searchable ? filterOptions(all, query) : all;
  const search = useRef<HTMLInputElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const { style, side } = usePopoverPosition(open, btn, placement, align, width);
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, []);
  const refs = useRef([btn, pop]).current;
  useOutsideClose(open, refs, useCallback(() => close(false), [close]));

  function show() {
    setQuery("");
    const sel = all.findIndex((o) => o.value === value && !o.disabled);
    setActive(sel >= 0 ? sel : nextEnabled(all, -1, 1));
    setOpen(true);
    onOpen?.();
    window.requestAnimationFrame(() => (search.current ?? list.current ?? pop.current?.querySelector<HTMLElement>("button, [tabindex]"))?.focus());
  }

  function onQuery(q: string) {
    setQuery(q);
    setActive(nextEnabled(searchable ? filterOptions(all, q) : all, -1, 1));
  }

  /** Desde el filtro solo navegan ↑↓ Inicio Fin y Enter; el resto de teclas escribe. */
  function onSearchKey(e: React.KeyboardEvent) {
    if (["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) onListKey(e);
  }

  function choose(i: number) {
    const o = options[i];
    if (!o || o.disabled) return;
    close();
    onSelect?.(o.value);
  }

  function onListKey(e: React.KeyboardEvent) {
    const k = e.key;
    if (k === "ArrowDown" || k === "ArrowUp") setActive(nextEnabled(options, active, k === "ArrowDown" ? 1 : -1));
    else if (k === "Home") setActive(nextEnabled(options, -1, 1));
    else if (k === "End") setActive(nextEnabled(options, options.length, -1));
    else if (k === "Enter" || k === " ") choose(active);
    else if (k.length === 1 && /\S/.test(k)) {
      const hit = typeahead(options, active, k);
      if (hit >= 0) setActive(hit);
    } else return;
    e.preventDefault();
  }

  function onPopKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab" && !header && !footer && !searchable) {
      close(false);
    }
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
      e.preventDefault();
      show();
    }
  }

  const hasPanel = Boolean(header || footer || searchable);
  return (
    <>
      <button ref={btn} type="button" className={props.triggerClass ?? "dd-trigger"} title={props.triggerTitle} disabled={props.disabled}
        aria-haspopup={options.length > 0 ? "listbox" : "dialog"} aria-expanded={open} aria-controls={open ? `${id}-pop` : undefined}
        data-testid={props.testId} onKeyDown={onTriggerKey} onClick={() => (open ? close(false) : show())}>
        {trigger}
      </button>
      {open && createPortal(
        <div ref={pop} id={`${id}-pop`} className={`dd-pop ${side}`} style={style} role={hasPanel ? "dialog" : undefined}
          aria-label={hasPanel ? label : undefined} onKeyDown={onPopKey}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && !pop.current?.contains(to) && to !== btn.current) close(false);
          }}>
          {header && <div className="dd-head">{header}</div>}
          {searchable && (
            <div className="dd-search">
              <input ref={search} type="search" value={query} placeholder={searchable} aria-label={searchable}
                aria-controls={`${id}-list`} onChange={(e) => onQuery(e.target.value)} onKeyDown={onSearchKey} />
            </div>
          )}
          {searchable && query && options.length === 0 && <p className="dd-note" role="status">Sin coincidencias con «{query}».</p>}
          {options.length > 0 && (
            <OptionList id={id} label={label} options={options} value={value} active={active} setActive={setActive} choose={choose} onKeyDown={onListKey} listRef={list} />
          )}
          {footer && <div className="dd-foot">{footer}</div>}
        </div>,
        document.body,
      )}
    </>
  );
}

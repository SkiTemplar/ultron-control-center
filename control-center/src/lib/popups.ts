/**
 * popups.ts — in-app popup queue (bottom-left, non-invasive).
 *
 * Replaces the central-modal `plugin:dialog|confirm` and the Windows-native
 * notification path. Two surfaces:
 *   - showToast(): fire-and-forget status pill (auto-dismiss).
 *   - showConfirm(): inline confirm with [Cancel] [OK] — returns Promise<boolean>.
 *
 * Subscribers (`PopupHost`) receive the live queue and render. Multiple
 * popups stack vertically, newest at the bottom.
 */

export type PopupKind = "toast" | "confirm";
export type Severity = "info" | "warn" | "critical" | "blocking";

export interface Popup {
    id: number;
    kind: PopupKind;
    source?: string;
    message: string;
    severity?: Severity;
    okLabel?: string;
    cancelLabel?: string;
    resolve?: (ok: boolean) => void;
}

let _nextId = 1;
let _queue: Popup[] = [];
const _subs = new Set<(items: Popup[]) => void>();

function _notify() {
    const snapshot = [..._queue];
    for (const sub of _subs) sub(snapshot);
}

function _remove(id: number) {
    const timer = _timers.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    _timers.delete(id);
    _queue = _queue.filter((p) => p.id !== id);
    _notify();
}

// Auto-dismiss timers, pausable while the pointer is over a toast.
type ToastTimer = { handle: ReturnType<typeof setTimeout> | null; remaining: number; startedAt: number };
const _timers = new Map<number, ToastTimer>();

function _arm(id: number, ms: number) {
    _timers.set(id, { handle: setTimeout(() => _remove(id), ms), remaining: ms, startedAt: Date.now() });
}

/** Default lifetime: warnings and errors stay long enough to be read; blocking is sticky. */
function _defaultTtl(severity: Severity): number {
    switch (severity) {
        case "blocking": return 0;
        case "critical":
        case "warn":     return 12_000;
        default:         return 6_000;
    }
}

/** Close a toast now (the × button). Confirms resolve through their buttons. */
export function dismissToast(id: number): void {
    _remove(id);
}

/** Freeze a toast's countdown (pointer enter). */
export function pauseToast(id: number): void {
    const timer = _timers.get(id);
    if (!timer?.handle) return;
    clearTimeout(timer.handle);
    _timers.set(id, { handle: null, remaining: Math.max(0, timer.remaining - (Date.now() - timer.startedAt)), startedAt: 0 });
}

/** Resume a paused countdown with whatever time it had left (pointer leave). */
export function resumeToast(id: number): void {
    const timer = _timers.get(id);
    if (!timer || timer.handle) return;
    _arm(id, Math.max(timer.remaining, 1_500));
}

export function subscribeQueue(fn: (items: Popup[]) => void): () => void {
    _subs.add(fn);
    fn([..._queue]);
    return () => { _subs.delete(fn); };
}

export interface ShowToastInput {
    message: string;
    source?: string;
    severity?: Severity;
    /** Auto-dismiss after N ms (default 6000; 12000 for warn/critical; blocking is sticky). Pass 0 for sticky. */
    ttlMs?: number;
}

export function showToast(input: ShowToastInput): number {
    const id = _nextId++;
    const popup: Popup = {
        id,
        kind: "toast",
        message: input.message,
        source: input.source,
        severity: input.severity ?? "info",
    };
    _queue.push(popup);
    _notify();
    const ttl = input.ttlMs ?? _defaultTtl(popup.severity ?? "info");
    if (ttl > 0) _arm(id, ttl);
    return id;
}

export interface ShowConfirmInput {
    message: string;
    source?: string;
    severity?: Severity;
    okLabel?: string;
    cancelLabel?: string;
}

export function showConfirm(input: ShowConfirmInput): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const id = _nextId++;
        const popup: Popup = {
            id,
            kind: "confirm",
            message: input.message,
            source: input.source,
            severity: input.severity ?? "warn",
            okLabel: input.okLabel,
            cancelLabel: input.cancelLabel,
            resolve: (ok: boolean) => {
                _remove(id);
                resolve(ok);
            },
        };
        _queue.push(popup);
        _notify();
    });
}

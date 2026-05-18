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
    _queue = _queue.filter((p) => p.id !== id);
    _notify();
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
    /** Auto-dismiss after N ms (default 6000). Pass 0 for sticky. */
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
    const ttl = input.ttlMs ?? 6000;
    if (ttl > 0) {
        setTimeout(() => _remove(id), ttl);
    }
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

export function dismissToast(id: number) {
    _remove(id);
}

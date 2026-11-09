import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesionesApi } from "../api";
import { createTauriApi } from "../api-tauri";
import { createMockApi } from "../mock/api-mock";
import type { KeyName } from "../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

type Call = [keyof SesionesApi, (api: SesionesApi) => Promise<unknown>, string, Record<string, unknown> | undefined];

// Nombres de comando del contrato de estabilidad §7.1: otro paquete los registra en Rust.
const CALLS: Call[] = [
  ["send", (a) => a.send({ id: "s", text: "t", attachments: [], clientId: "c", mode: "auto" }), "sesiones_send", { id: "s", text: "t", attachments: [], clientId: "c", mode: "auto" }],
  ["runCommand", (a) => a.runCommand({ id: "s", command: "cost", args: "", clientId: "c" }), "sesiones_run_command", { id: "s", command: "cost", args: "", clientId: "c" }],
  ["recover", (a) => a.recover({ id: "s", action: "restart", opts: { permissionMode: "default" } }), "sesiones_recover", { id: "s", action: "restart", opts: { permissionMode: "default" } }],
  ["trustAnswer", (a) => a.trustAnswer({ id: "s", accept: true }), "sesiones_trust_answer", { id: "s", accept: true }],
  ["dialogAnswer", (a) => a.dialogAnswer({ id: "s", index: 2 }), "sesiones_dialog_answer", { id: "s", index: 2 }],
  ["terminalInput", (a) => a.terminalInput({ id: "s", data: "x" }), "sesiones_terminal_input", { id: "s", data: "x" }],
  ["setPermissionMode", (a) => a.setPermissionMode({ id: "s", mode: "plan" }), "sesiones_set_permission_mode", { id: "s", mode: "plan" }],
  ["logDir", (a) => a.logDir(), "sesiones_log_dir", undefined],
  ["pendingAsks", (a) => a.pendingAsks("s"), "sesiones_pending_asks", { id: "s" }],
  ["queueList", (a) => a.queueList("s"), "sesiones_queue_list", { id: "s" }],
  ["queueEnqueue", (a) => a.queueEnqueue({ id: "s", item: { clientId: "c", text: "t", attachments: [], delegate: false, kind: "prompt" } }), "sesiones_queue_enqueue", { id: "s", item: { clientId: "c", text: "t", attachments: [], delegate: false, kind: "prompt" } }],
  ["queueUpdate", (a) => a.queueUpdate({ id: "s", clientId: "c", patch: { text: "u" } }), "sesiones_queue_update", { id: "s", clientId: "c", patch: { text: "u" } }],
  ["queueRemove", (a) => a.queueRemove({ id: "s", clientId: "c" }), "sesiones_queue_remove", { id: "s", clientId: "c" }],
  ["queueMove", (a) => a.queueMove({ id: "s", clientId: "c", toIndex: 0 }), "sesiones_queue_move", { id: "s", clientId: "c", toIndex: 0 }],
  ["queueSendNow", (a) => a.queueSendNow({ id: "s" }), "sesiones_queue_send_now", { id: "s" }],
  ["queueRetry", (a) => a.queueRetry({ id: "s", clientId: "c" }), "sesiones_queue_retry", { id: "s", clientId: "c" }],
  ["commands", (a) => a.commands("C:/p", "s"), "sesiones_commands", { cwd: "C:/p", id: "s" }],
  ["prefsGet", (a) => a.prefsGet(), "sesiones_prefs_get", undefined],
  ["prefsSet", (a) => a.prefsSet({ launchPermissionMode: "default", stallSeconds: 120 }), "sesiones_prefs_set", { prefs: { launchPermissionMode: "default", stallSeconds: 120 } }],
  ["listFiles", (a) => a.listFiles("C:/p"), "sesiones_files", { cwd: "C:/p" }],
  ["previewPut", (a) => a.previewPut("<p>x</p>"), "sesiones_preview_put", { html: "<p>x</p>" }],
  // Actualizar de la pestaña Uso: `force` llega al backend (sin él, la espera tras un fallo lo anulaba).
  ["usage", (a) => a.usage({ force: true }), "sesiones_usage", { force: true }],
  ["usagePace", (a) => a.usagePace({ force: true }), "sesiones_usage_pace", { force: true }],
  ["usagePace", (a) => a.usagePace(), "sesiones_usage_pace", { force: false }],
  // La respuesta vacía del mock no pasa `normalizeEngines`: aquí solo cuenta el comando.
  ["enginesUsage", (a) => a.enginesUsage({ force: true }).catch(() => undefined), "sesiones_engines_usage", { force: true }],
  ["enginesUsage", (a) => a.enginesUsage().catch(() => undefined), "sesiones_engines_usage", { force: false }],
];

describe("adaptador Tauri: comandos v3 con los nombres del contrato §7.1", () => {
  beforeEach(() => invoke.mockClear());

  it.each(CALLS)("%s invoca su comando con sus argumentos", async (_name, call, command, args) => {
    await call(createTauriApi());
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(args === undefined ? [command] : [command, args]);
  });

  it("KeyName ya no admite escape, ctrlC ni raw (Esc y Ctrl+C solo por recover)", () => {
    // @ts-expect-error escape salió de KeyName en el contrato v3
    const escape: KeyName = "escape";
    // @ts-expect-error raw salió de KeyName: la terminal escribe con terminalInput
    const raw: KeyName = "raw";
    const ok: KeyName = "shiftTab";
    expect([escape, raw, ok]).toHaveLength(3);
  });
});

describe("mock: los stubs v3 nunca son un no-op silencioso", () => {
  let api: SesionesApi;
  beforeEach(() => {
    vi.useFakeTimers();
    api = createMockApi();
  });
  afterEach(() => vi.useRealTimers());

  it("los comandos de WP-MOTORES aún sin implementar rechazan con «pendiente»", async () => {
    await expect(api.previewPut("<p>x</p>")).rejects.toThrow(/pendiente/);
  });

  it("un comando con la sesión ocupada se encola; libre, se escribe", async () => {
    expect(await api.runCommand({ id: "s-mods", command: "cost", args: "", clientId: "c" })).toEqual({ disposition: "queued" });
    expect(await api.runCommand({ id: "s-practica", command: "cost", args: "", clientId: "d" })).toEqual({ disposition: "written" });
  });

  it("encolar es idempotente por clientId", async () => {
    const item = { clientId: "c", text: "t", attachments: [], delegate: false, kind: "prompt" as const };
    await api.queueEnqueue({ id: "s-mods", item });
    expect(await api.queueEnqueue({ id: "s-mods", item })).toHaveLength(1);
  });

  it("interrumpir sin turno no pone idle (caso negativo de SC-18)", async () => {
    expect(await api.recover({ id: "s-practica", action: "interrupt" })).toMatchObject({ ok: false, status: "idle" });
  });

  it("un modo fuera del ciclo devuelve el error que ofrece reiniciar", async () => {
    const out = await api.setPermissionMode({ id: "s-practica", mode: "auto" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/fuera del ciclo/);
  });

  it("send devuelve el clientId del envío", async () => {
    const out = await api.send({ id: "s-practica", text: "hola", attachments: [], clientId: "c-1", mode: "auto" });
    expect(out).toEqual({ clientId: "c-1", disposition: "written" });
  });

  it("pendingAsks lista la pregunta pendiente y filtra por sesión", async () => {
    expect((await api.pendingAsks("s-review")).map((a) => a.askId)).toEqual(["ask-review-1"]);
    expect(await api.pendingAsks("s-practica")).toEqual([]);
  });

  it("responder una pregunta ya resuelta rechaza con ask_gone", async () => {
    await api.answer({ askId: "ask-review-1", answer: { kind: "permission", decision: "deny" } });
    await expect(api.answer({ askId: "ask-review-1", answer: { kind: "permission", decision: "deny" } })).rejects.toThrow("ask_gone");
  });

  it("prefsSet guarda y prefsGet devuelve lo guardado", async () => {
    await api.prefsSet({ launchPermissionMode: "acceptEdits", stallSeconds: 300 });
    expect(await api.prefsGet()).toEqual({ launchPermissionMode: "acceptEdits", stallSeconds: 300 });
  });
});

describe("mock: autoplay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sin autoplay no deja temporizadores vivos tras el test", () => {
    createMockApi({ autoplay: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("con autoplay (la demo) arranca el streaming y el latido", () => {
    createMockApi();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});

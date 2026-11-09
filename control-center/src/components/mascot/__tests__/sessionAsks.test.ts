import { describe, expect, it } from "vitest";
import type { Approval } from "../bubble";
import { answerCommand, mergeSessionAsks, toApproval } from "../sessionAsks";

const sessions = [{ id: "s1", title: "Bocadillo", projectName: "ultron" }];

const freno: Approval = { id: "f1", tool: "Bash", reason: "borrar", summary: "rm -rf x", source: "pupus" };

describe("toApproval", () => {
  it("convierte un permiso de Sessions con origen y «siempre»", () => {
    const a = toApproval(
      { askId: "a1", id: "s1", kind: "permission", tool: "Bash", summary: "git push", always: { rules: ["Bash(git push:*)"] } },
      sessions,
    );
    expect(a).toEqual({
      id: "ses:a1",
      tool: "Bash",
      reason: "permiso para Bash",
      summary: "git push",
      origin: "Sessions · Bocadillo",
      source: "sessions",
      sessionId: "s1",
      canAlways: true,
    });
  });

  it("sin summary usa el comando de la entrada", () => {
    const a = toApproval({ askId: "a2", id: "zz", kind: "permission", tool: "Bash", input: { command: "ls" } }, sessions);
    expect(a?.summary).toBe("ls");
    expect(a?.origin).toBe("Sessions");
    expect(a?.canAlways).toBe(false);
  });

  it("ignora preguntas y planes, y los asks sin id", () => {
    expect(toApproval({ askId: "q", id: "s1", kind: "question" }, sessions)).toBeNull();
    expect(toApproval({ askId: "p", id: "s1", kind: "plan" }, sessions)).toBeNull();
    expect(toApproval({ id: "s1", kind: "permission" }, sessions)).toBeNull();
  });
});

describe("mergeSessionAsks", () => {
  const ses = (id: string): Approval => ({ id, tool: "Bash", reason: "r", summary: "s", source: "sessions" });

  it("conserva el freno y sustituye las de Sessions por las pendientes", () => {
    const out = mergeSessionAsks([freno, ses("ses:viejo")], [ses("ses:nuevo")], new Set());
    expect(out.map((a) => a.id)).toEqual(["f1", "ses:nuevo"]);
  });

  it("no vuelve a enseñar lo contestado desde Pupus", () => {
    const out = mergeSessionAsks([freno], [ses("ses:a"), ses("ses:b")], new Set(["ses:a"]));
    expect(out.map((a) => a.id)).toEqual(["f1", "ses:b"]);
  });

  it("devuelve el mismo array si nada cambia (sin repintar)", () => {
    const current = [freno, ses("ses:a")];
    expect(mergeSessionAsks(current, [ses("ses:a")], new Set())).toBe(current);
  });
});

describe("answerCommand", () => {
  it("Sessions contesta por sesiones_answer con la decisión tal cual", () => {
    const a = toApproval({ askId: "a1", id: "s1", kind: "permission", tool: "Bash" }, sessions)!;
    expect(answerCommand(a, "allowAlways")).toEqual({
      cmd: "sesiones_answer",
      args: { askId: "a1", answer: { kind: "permission", decision: "allowAlways" } },
    });
  });

  it("el freno y la terminal contestan por mascot_approve_answer", () => {
    expect(answerCommand(freno, "deny")).toEqual({ cmd: "mascot_approve_answer", args: { id: "f1", allow: false } });
    expect(answerCommand({ ...freno, source: "terminal" }, "allow")).toEqual({
      cmd: "mascot_approve_answer",
      args: { id: "f1", allow: true },
    });
  });
});

// Mascota — capa de entrada del motor: lo que haces tú con ella.
//
// Elegir agente en la conversación, arrastrarla, lanzarla, pincharla,
// acariciarla, hacerle cosquillas, el modo ratón (drive), la mirada que sigue
// al cursor y las travesuras con el cursor quieto.

import { clamp } from "./activities/util";
import { AGENT_COLORS, nudge, type AgentId, type RGB } from "./mood";
import { EngineClimb } from "./engineClimb";
import { MAX_SPEED, PRANK_COOLDOWN, type FrameInput, type Point } from "./engineTypes";

export class EngineInput extends EngineClimb {
  protected lookX = 0;
  protected lookY = 0;
  /** Color del agente rival que se pondrá al acabar la reacción de celos. */
  protected pendingColor: RGB | null = null;
  protected driveAct: { kind: string; t: number } | null = null;
  private pokes: number[] = [];
  private shakes: number[] = [];
  private lastShakeDir = 0;
  private shaken = false;
  /** Travesura pedida: tirar del cursor hacia este punto (px CSS). */
  private prank: Point | null = null;
  private lastPrankAt = 0;
  private lastPrankCursor: Point | null = null;
  private cursorStillSince = 0;
  private tickle = 0;
  private lastTickleAt = -99;
  private rub = 0;
  private lastLoveAt = -99;
  private lastCursorTickle: Point | null = null;
  private lastCursor: Point | null = null;
  private lastPetHover = false;

  // -------------------------------------------------------------------------
  // Conversación: ¿a quién has elegido?
  // -------------------------------------------------------------------------

  /** Has pulsado el botón de `agent`. A Claude le alegra; a los otros, celos. */
  chooseAgent(agent: AgentId) {
    if (this.chatAgent === agent) return;
    this.chatAgent = agent;
    this.idleFor = 0;
    if (agent === "claude") {
      this.mood = nudge(this.mood, { happy: 0.25, jealousy: -0.35, boredom: -1 });
      this.pendingColor = null;
      this.setColorTarget(AGENT_COLORS.claude, true);
      this.showIcon("heart");
      this.play("joy");
      return;
    }
    this.mood = nudge(this.mood, { jealousy: 0.5, happy: -0.12, boredom: -1 });
    if (this.isGrounded() && this.mode !== "sleep") {
      // La reacción entera (sorpresa → pena → «hmph» → disfraz) en el suelo.
      this.pendingColor = [...AGENT_COLORS[agent]];
      this.play("jealous");
    } else {
      this.setColorTarget(AGENT_COLORS[agent], true);
      this.showIcon("puff");
    }
  }

  /** Se cerró la conversación: vuelve a su color con un «poof» de alivio. */
  chatEnded() {
    const was = this.chatAgent;
    this.chatAgent = null;
    this.pendingColor = null;
    if (!was || was === "claude") return;
    this.mood = nudge(this.mood, { jealousy: -0.25, happy: 0.05 });
    this.setColorTarget(AGENT_COLORS.claude, true);
    if (this.isGrounded() && this.mode !== "sleep") this.play("poof");
  }

  /** Llegó la respuesta. Si la dio «el otro», un resoplido. */
  replyArrived(agent: AgentId) {
    if (agent === "claude") {
      this.mood = nudge(this.mood, { happy: 0.06 });
      this.showIcon("heart", 1.2);
    } else {
      this.mood = nudge(this.mood, { jealousy: 0.05 });
      this.showIcon("puff", 1.2);
    }
  }

  // -------------------------------------------------------------------------
  // Interacción con el ratón
  // -------------------------------------------------------------------------

  startDrag(px: number, py: number, now: number) {
    this.cancelTravel();
    this.drag = { offX: this.x - px, offY: this.y - py, samples: [{ x: px, y: py, t: now }] };
    this.ground = null;
    this.hangAnchor = null;
    this.idleFor = 0;
    this.setMode("drag");
    this.kick(-3, 4);
    this.showIcon("exclaim", 0.8);
  }

  dragTo(px: number, py: number, now: number) {
    if (!this.drag) return;
    const s = this.drag.samples;
    s.push({ x: px, y: py, t: now });
    while (s.length > 2 && now - s[0].t > 0.1) s.shift();
    this.x = px + this.drag.offX;
    this.y = py + this.drag.offY;
    this.clampToScreen();
    this.noteShake(now);
  }

  /** Zarandearlo: cambios de sentido rápidos seguidos lo marean. */
  private noteShake(now: number) {
    const vx = this.dragVelocity().vx;
    const dir = Math.abs(vx) > 900 ? Math.sign(vx) : 0;
    if (dir && dir !== this.lastShakeDir) {
      if (this.lastShakeDir) this.shakes.push(now);
      this.lastShakeDir = dir;
    }
    this.shakes = this.shakes.filter((s) => now - s < 1.2);
    if (this.shakes.length >= 4 && !this.shaken) {
      this.shaken = true;
      this.life.note("zarandeado");
      this.showIcon("sweat", 1.2);
    }
  }

  /** Soltar. Con Ctrl, se queda colgada de una chincheta donde la soltaste. */
  endDrag(ctrl: boolean) {
    if (!this.drag) return;
    const v = this.dragVelocity();
    if (this.shaken) this.dizzyAfterLand = true;
    this.shaken = false;
    this.shakes = [];
    this.lastShakeDir = 0;
    const anchor = { x: this.x - this.drag.offX, y: this.y - this.drag.offY };
    this.drag = null;
    if (ctrl) {
      this.hangAnchor = anchor;
      this.swingV = Math.max(-6, Math.min(6, v.vx / 300));
      this.setMode("hang");
      return;
    }
    this.vx = clamp(v.vx, -MAX_SPEED, MAX_SPEED);
    this.vy = clamp(v.vy, -MAX_SPEED, MAX_SPEED);
    if (Math.hypot(this.vx, this.vy) > 1200) this.showIcon("exclaim", 0.9);
    if (Math.hypot(this.vx, this.vy) > 600) this.life.note("lanzado");
    this.fall();
  }

  /** Clic sin arrastrar: saltito contento (o enfado si son muchos seguidos). */
  poke() {
    this.idleFor = 0;
    if (this.mode === "act" && this.acts.poke(this)) return;
    this.pokes = this.pokes.filter((p) => this.t - p < 3);
    this.pokes.push(this.t);
    if (this.mode === "hang") {
      // Clic estando colgada: se suelta de la chincheta.
      this.hangAnchor = null;
      this.vx = 0;
      this.vy = 0;
      this.fall();
      return;
    }
    if (this.pokes.length >= 4) {
      this.pokes = [];
      this.mood = nudge(this.mood, { anger: 0.55, happy: -0.1 });
      this.showIcon("anger");
      if (this.isGrounded()) this.play("angry");
      return;
    }
    this.mood = nudge(this.mood, { happy: 0.08, boredom: -0.3 });
    this.happyUntil = this.t + 0.9;
    this.life.note(this.mode === "sleep" ? "despertado" : "pinchado");
    if (this.isGrounded()) this.hopOnPoke();
  }

  /** Saltito al pincharla en el suelo (o despertarse si dormía). */
  private hopOnPoke() {
    if (this.mode === "sleep") {
      this.wake();
      return;
    }
    this.vy = -Math.sqrt(2 * this.g * 10 * this.S);
    this.vx = 0;
    this.ground = null;
    this.kick(-4, 5);
    this.setMode("air");
  }

  /** «Llamar»: cae desde arriba en `x` (la del cursor) o en el centro. */
  summon(x?: number) {
    this.cancelTravel();
    const margin = this.halfW + 4;
    this.x = x !== undefined && Number.isFinite(x) ? Math.min(Math.max(x, margin), this.W - margin) : this.W / 2;
    this.y = this.height + 8;
    this.vx = 0;
    this.vy = 0;
    this.hangAnchor = null;
    this.drag = null;
    this.dizzyAfterLand = false;
    this.waveAfterLand = true;
    this.fall();
  }

  /** Coge un fichero (soltado encima o recogido con Ctrl+Alt+clic). */
  grab(name: string) {
    this.carrying = name;
    this.idleFor = 0;
    this.life.note("ficheroCogido");
    this.showIcon("exclaim", 0.9);
    this.kick(5, -5);
    if (this.isGrounded()) this.play("joy");
  }

  // -------------------------------------------------------------------------
  // Modo ratón (drive)
  // -------------------------------------------------------------------------

  driveStart() {
    this.cancelTravel();
    this.drag = null;
    this.hangAnchor = null;
    this.ground = null;
    this.driveAct = null;
    this.setMode("drive");
  }

  driveAction(kind: string, at: Point | null) {
    if (this.mode !== "drive") this.driveStart();
    this.driveAct = { kind, t: this.t };
    if (at && kind === "click") {
      this.effects.push({ kind: "ring", x: at.x, y: at.y, vx: 0, vy: 0, age: 0, life: 0.4 });
      this.kick(3, -3);
    }
  }

  driveEnd() {
    if (this.mode !== "drive") return;
    this.vx = 0;
    this.vy = 0;
    this.fall();
  }

  // -------------------------------------------------------------------------
  // Cursor: mirada, caricias y travesuras
  // -------------------------------------------------------------------------

  protected updateEyes(input: FrameInput) {
    let tx = 0;
    let ty = 0;
    if (input.chat !== "none") {
      ty = -1;
    } else if (this.settings.eyes_follow_cursor && input.cursor) {
      const dx = input.cursor.x - this.x;
      const dy = input.cursor.y - (this.y - this.height * 0.7);
      const d = Math.hypot(dx, dy);
      if (d > 4 * this.S) {
        // La mirada se dibuja en el espacio del sprite (reflejado si mira a
        // la izquierda), así que la x se expresa respecto a `facing`.
        tx = (dx / d) * 1.4 * this.facing;
        ty = (dy / d) * 1.4;
      }
    } else if (this.mode === "walk") {
      tx = 1;
    }
    const k = 1 - Math.exp(-10 * input.dt);
    this.lookX += (tx - this.lookX) * k;
    this.lookY += (ty - this.lookY) * k;
  }

  /** Frotar el cursor por encima de la mascota = caricias. */
  protected updatePetting(input: FrameInput, dt: number) {
    const cur = input.cursor;
    this.rub *= Math.exp(-0.8 * dt);
    // Solo cuenta el movimiento que empieza Y acaba encima: entrar desde
    // lejos no es una caricia.
    if (input.petHover && this.lastPetHover && cur && this.lastCursor && this.mode !== "drag") {
      this.rub += Math.min(60, Math.hypot(cur.x - this.lastCursor.x, cur.y - this.lastCursor.y));
    }
    this.lastCursor = cur ? { ...cur } : null;
    this.lastPetHover = !!input.petHover;
    // Cosquillas: frotar MUY rápido (se apaga enseguida) le da la risa.
    this.tickle *= Math.exp(-3 * dt);
    if (input.petHover && this.lastPetHover && cur && this.mode !== "drag") {
      this.tickle += Math.min(60, Math.abs(cur.x - (this.lastCursorTickle?.x ?? cur.x)));
    }
    this.lastCursorTickle = cur ? { ...cur } : null;
    if (this.tickle > 420 && this.t - this.lastTickleAt > 3) return this.laugh();
    if (this.rub > 300 && this.tickle < 200 && this.t - this.lastLoveAt > 4) this.enjoyPetting();
  }

  private laugh() {
    this.tickle = 0;
    this.rub = 0;
    this.lastTickleAt = this.t;
    this.life.note("cosquillas");
    this.mood = nudge(this.mood, { happy: 0.2, boredom: -1 });
    this.happyUntil = this.t + 1.4;
    this.floatUp("note", 3);
    this.kick(6, -6);
    if (this.isGrounded() && this.mode !== "emote") this.play("wiggle");
  }

  private enjoyPetting() {
    this.rub = 0;
    this.lastLoveAt = this.t;
    this.life.note("caricia");
    this.mood = nudge(this.mood, { happy: 0.25, anger: -0.3, boredom: -1 });
    if (this.isGrounded() && this.mode !== "emote") this.play("love");
    else this.floatUp("heart", 2);
  }

  /** ¿Toca travesura con el cursor? (la app la consume y tira de él). */
  takePrank(): Point | null {
    const p = this.prank;
    this.prank = null;
    return p;
  }

  /**
   * Travesura: si dejas el cursor quieto un rato cerca de él, de vez en
   * cuando se agarra a él y tira un poquito. Cada PRANK_COOLDOWN como mucho.
   */
  protected updatePrank(input: FrameInput, dt: number) {
    const cur = input.cursor;
    const last = this.lastPrankCursor;
    if (!cur || !last || Math.hypot(cur.x - last.x, cur.y - last.y) > 3) this.cursorStillSince = this.t;
    this.lastPrankCursor = cur ? { ...cur } : null;
    if (!cur || !this.settings.cursor_pranks || input.hovered || input.chat !== "none" || !this.life.allows("pranks")) return;
    if (!["idle", "sit", "walk"].includes(this.mode) || this.goal) return;
    if (this.t - this.lastPrankAt < PRANK_COOLDOWN || this.t - this.cursorStillSince < 4) return;
    const d = Math.hypot(cur.x - this.x, cur.y - (this.y - this.height / 2));
    if (d > 180 || d < 40 || this.rand() > 0.4 * dt) return;
    this.lastPrankAt = this.t;
    this.prank = { x: this.x, y: this.y - this.height / 2 };
    this.facing = cur.x < this.x ? -1 : 1;
    this.showIcon("exclaim", 0.8);
    this.play("joy");
  }
}

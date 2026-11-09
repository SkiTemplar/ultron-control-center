// Mascota — motor: física + comportamiento + ánimo + pose a pintar.
//
// Sin DOM ni Tauri: recibe el mundo (tamaño del área de trabajo, ventanas)
// y la entrada de cada fotograma, y decide dónde está la mascota, qué
// siente y qué pose tiene. Así se puede probar entero en vitest.
//
// Unidades: px CSS dentro de la ventana de la mascota; (x, y) = centro de
// los pies. El suelo (y = H) es el borde superior de la barra de tareas.
//
// Fluidez: el aplastamiento/estiramiento es un MUELLE (rebota y se asienta
// en vez de saltar de pose a pose), los botes y la respiración se pintan en
// píxeles de dispositivo, el color cambia con un fundido y casi todo
// (paseo, mirada, balanceo) es continuo.
//
// El motor se reparte en capas (engineCore → enginePhysics → engineTravel →
// engineClimb → engineInput → MascotEngine); aquí quedan el paso de cada fotograma, el
// comportamiento en el suelo y la pose. Este fichero es la entrada pública:
// reexporta los tipos de engineTypes.ts.

import { BASE_POSE, type Eyes, type Pose } from "./sprite";
import type { Hat } from "./outfits";
import { hatPolicy } from "./headAnchor";
import type { EpisodeKind } from "./episodes";
import { choicesFor, pickWeighted, type Choice } from "./moodTable";
import { EMOTE_DURATION } from "./emotes";
import type { ActivityId } from "./activities/runner";
import { clamp } from "./activities/util";
import { sleepAfterS } from "./nightRest";
import { nudge, rgbToCss, tickMood } from "./mood";
import { Blinker, catchPose, chatPose, modePose, type BlinkPhase, type ModeLook, type PoseCtx } from "./framePose";
import { runEmoteCues, type CueFx } from "./emoteCues";
import { EngineInput } from "./engineInput";
import { WALK_SPEED, type ChatState, type Frame, type FrameInput } from "./engineTypes";

export type { AgentId } from "./mood";
export { DEFAULT_SETTINGS, type MascotSettings } from "./settings";
export { type Emote, EMOTE_DURATION, JEALOUS_COLOR_AT } from "./emotes";
export type { ChatState, Effect, EffectKind, Exits, Frame, FrameInput, Mode, Side, Surface } from "./engineTypes";

/** Sin eventos de arrastre en este tiempo (s), deja de esperar el fichero. */
const DROP_HOVER_TTL = 10;

export class MascotEngine extends EngineInput {
  private lastChat: ChatState = "none";
  /** Fichero arrastrado encima (OLE), en px CSS, y cuándo se vio por última vez. */
  private dropAt: { x: number; y: number; seen: number } | null = null;
  private wasHovered = false;
  private lastHoverReact = -99;
  private sleptTired = false;
  private readonly blinker = new Blinker();
  /** Efectos que disparan las marcas de los emotes (emoteCues.ts). */
  private readonly cueFx: CueFx = {
    flip: () => {
      this.facing = this.facing === 1 ? -1 : 1;
    },
    kick: (dx, dy) => this.kick(dx, dy),
    floatUp: (kind, n) => this.floatUp(kind, n),
    burst: (kind, n, color, spread) => this.burst(kind, n, color, spread),
    showIcon: (glyph, life) => this.showIcon(glyph, life),
    tear: () => this.tear(),
    settleColor: () => {
      if (this.pendingColor) this.setColorTarget(this.pendingColor, true);
      this.pendingColor = null;
    },
    recoil: () => {
      this.x = clamp(this.x - this.facing * 2 * this.S, this.halfW, this.W - this.halfW);
    },
  };

  /** Cambia de gorro con un «poof» de chispas. */
  setHat(h: Hat | null) {
    if (h === this.hat) return;
    this.hat = h;
    if (this.settings.hats) this.burst("spark", 10, "#FFFFFF", 0.8);
  }

  /** Suceso de fuera (Sessions, builds, lo que haces). `react`: con gesto, si lo tiene. */
  feel(k: EpisodeKind, react = true) {
    const r = this.life.note(k);
    this.mood = nudge(this.mood, r.mood ?? {});
    if (!react || !r.react || !this.isGrounded() || this.mode === "emote") return;
    if (k === "vuelves" && this.doActivity("bienvenida")) return;
    if (this.mode === "sleep") this.setMode("idle");
    this.play(r.react);
  }

  /** Un arrastre de ficheros entra o se mueve sobre Pupus (`at`) o se va (null). */
  dropHover(at: { x: number; y: number } | null) {
    if (!at) {
      this.dropAt = null;
      return;
    }
    if (!this.dropAt) {
      // Recién llegado: se despierta, se para y avisa de que lo va a coger.
      if (this.mode === "sleep") this.wake();
      if (this.mode === "walk") this.setMode("idle");
      this.idleFor = 0;
      this.showIcon("exclaim", 0.7);
      this.kick(-3, 4);
    }
    this.dropAt = { x: at.x, y: at.y, seen: this.t };
  }

  /** Esperando a que le suelten un fichero (en el suelo y sin arrastre propio). */
  get awaitingDrop(): boolean {
    const d = this.dropAt;
    return !!d && this.t - d.seen < DROP_HOVER_TTL && this.isGrounded() && this.mode !== "drag";
  }

  // -------------------------------------------------------------------------
  // Paso
  // -------------------------------------------------------------------------

  update(input: FrameInput) {
    const dt = Math.min(Math.max(input.dt, 0), 1 / 20);
    this.t += dt;
    this.modeT += dt;
    this.tickLife(input, dt);
    this.updateEffects(dt);
    this.updateEyes(input);
    this.updatePetting(input, dt);
    this.updatePrank(input, dt);
    this.stepMode(dt, input);
    this.acts.tick(dt, input, this);
    const req = this.acts.takeRequest(dt, this);
    if (req) this.doActivity(req);
    if (this.queued && this.isGrounded() && this.mode !== "land" && this.mode !== "crouch") {
      const e = this.queued;
      this.queued = null;
      this.play(e);
    }
  }

  /** Atención, ánimo, vitalidad, gorro caído y fundido de color de este paso. */
  private tickLife(input: FrameInput, dt: number) {
    const engaged = input.hovered || input.chat !== "none" || this.mode === "drag";
    this.idleFor = engaged ? 0 : this.idleFor + dt;
    if (input.chat !== "none" && this.lastChat === "none") this.idleFor = 0;
    this.lastChat = input.chat;

    this.mood = tickMood(this.mood, dt, {
      sleeping: this.mode === "sleep",
      engaged,
      chattingOther: !!this.chatAgent && this.chatAgent !== "claude",
    });
    const pet = { x: this.x, y: this.y - this.height / 2 };
    const cue = this.life.tick(dt, { mood: this.mood, mode: this.mode, chat: input.chat, engaged, cursor: input.cursor, pet });
    if (cue && (this.mode === "idle" || this.mode === "sit")) this.play(cue);
    if (this.hatDrop.step(dt, this.H, this.mode === "idle" || this.mode === "walk")) this.burst("spark", 8, "#FFFFFF", 0.6);
    const k = 1 - Math.exp(-4 * dt);
    this.color = [
      this.color[0] + (this.colorTarget[0] - this.color[0]) * k,
      this.color[1] + (this.colorTarget[1] - this.color[1]) * k,
      this.color[2] + (this.colorTarget[2] - this.color[2]) * k,
    ];
  }

  private stepMode(dt: number, input: FrameInput) {
    switch (this.mode) {
      case "drag":
        return this.swingFromDrag(dt);
      case "hang":
        return this.stepHang(dt);
      case "drive":
        return this.stepDrive(dt, input.cursor);
      case "fly":
        return this.stepFly(dt);
      case "climb":
        return this.stepClimb(dt);
      case "air":
        return this.stepAirFor(dt);
      case "splat":
        return this.stepSplat(dt);
      case "crouch":
        return this.stepCrouch();
      case "land":
        return this.stepLand(dt);
      case "dizzy":
        return this.stepDizzy();
      case "wave":
        if (this.followGround() && this.modeT > 1.3) this.setMode("idle");
        return;
      case "emote":
        if (this.followGround()) this.stepEmote();
        return;
      case "act":
        if (this.followGround()) this.stepActivity({ ...input, dt });
        return;
      default:
        this.stepGround(dt, input);
    }
  }

  // -------------------------------------------------------------------------
  // En el suelo: atención, siesta, paseo y decisiones
  // -------------------------------------------------------------------------

  /** Reacción al pasar el cursor según el estado (moodTable.ts). */
  private reactToHover(input: FrameInput) {
    if (this.t - this.lastHoverReact < 5) return;
    this.lastHoverReact = this.t;
    const { hover, hoverIcon } = this.life.traits;
    const calm = this.mode === "idle" || this.mode === "sit";
    if (hoverIcon) this.showIcon(hoverIcon, 1.2);
    if (hover === "turnAway" && input.cursor) this.facing = input.cursor.x < this.x ? 1 : -1;
    else if (hover === "flinch") this.kick(-4, 6);
    else if (calm && hover === "wave") this.setMode("wave");
    else if (calm && (hover === "wiggle" || hover === "peek")) this.play(hover);
  }

  private stepGround(dt: number, input: FrameInput) {
    if (!this.followGround()) return;
    this.slide(dt);
    if (this.mode === "air") return;
    // Un viaje (Ctrl+Alt+clic) manda sobre paseos, hover y siestas.
    if (this.stepTravel(dt)) return;

    const hoverNow = input.hovered && input.chat === "none";
    if (hoverNow && !this.wasHovered && this.mode !== "sleep") this.reactToHover(input);
    this.wasHovered = hoverNow;
    if (input.hovered || input.chat !== "none") return this.attend(input);

    // Receloso y el cursor se le echa encima deprisa: se aparta.
    const away = this.mode === "sleep" || this.mode === "walk" ? 0 : this.life.flee(this.x);
    if (away) {
      this.walkTarget = this.x + away * 40 * this.S;
      this.setMode("walk");
    }
    if (this.stepRest()) return;
    if (this.stepClimbApproach(dt)) return;
    if (this.mode === "walk" && this.walkTarget !== null) return this.stepWalk(dt, this.walkTarget);
    if (this.settings.wander && this.t >= this.nextThink) this.decide();
  }

  /** Le estás haciendo caso (cursor encima o conversación): despierta, se para y te mira. */
  private attend(input: FrameInput) {
    if (this.mode === "sleep") {
      this.wake();
      this.mood = nudge(this.mood, { energy: 0.1 });
      this.life.note("despertado");
    } else if (this.mode === "walk") this.setMode("idle");
    const grumpy = this.life.traits.hover === "turnAway";
    if (input.cursor && input.hovered && !grumpy) {
      const dx = input.cursor.x - this.x;
      if (Math.abs(dx) > 2 * this.S) this.facing = dx < 0 ? -1 : 1;
    }
    this.nextThink = this.t + 1.5;
  }

  /** Siesta por aburrimiento o cansancio, y despertar descansado. true = el paso acaba aquí. */
  private stepRest(): boolean {
    const sleepAfter = sleepAfterS(this.settings.sleep_after_min, this.now());
    if (this.mode !== "sleep") {
      const bored = sleepAfter > 0 && this.idleFor > sleepAfter;
      const tired = this.mood.energy < 0.12 && this.idleFor > 5;
      if (!bored && !tired) return false;
      this.walkTarget = null;
      this.sleptTired = tired && !bored;
      this.setMode("sleep");
      return true;
    }
    if (this.sleptTired && this.mood.energy > 0.95) {
      this.sleptTired = false;
      this.idleFor = 0;
      this.setMode("idle");
      this.play("stretch");
    }
    return true;
  }

  /** Andar hacia walkTarget; una isla de la barra en medio se salta (islandHop). */
  private stepWalk(dt: number, walkTarget: number) {
    const hop = this.islandHop(walkTarget < this.x ? -1 : 1, walkTarget);
    const [lo, hi] = this.surfaceBounds();
    const target = hop ? hop.takeoffX : clamp(walkTarget, lo, hi);
    const step = WALK_SPEED * this.S * this.life.traits.speed * dt;
    const d = target - this.x;
    this.facing = d < 0 ? -1 : 1;
    if (Math.abs(d) <= step) {
      this.x = target;
      this.walkTarget = null;
      if (hop && this.crouchFor(hop.landX, hop.top)) return;
      this.setMode("idle");
    } else {
      this.x += Math.sign(d) * step;
    }
  }

  private decide() {
    this.nextThink = this.t + 2 + this.rand() * 4;
    const onWindow = this.ground?.kind === "win";
    const w = choicesFor(this.life.state, this.settings.jump, onWindow, this.life.allows("wander"));
    const pick = pickWeighted<Choice | "activity">([...w, ["activity", this.acts.offerWeight(this)]], this.rand());
    switch (pick) {
      case "activity":
        return this.setMode(this.acts.pick(this) ? "act" : "idle");
      case "jumpUp":
        if (!this.tryClimbOrJumpUp()) this.startWalk();
        return;
      case "hopDown":
        if (!this.tryClimbOrHopDown()) this.startWalk();
        return;
      case "walk":
        return this.startWalk();
      case "sit":
        return this.setMode("sit");
      case "idle":
        return this.setMode("idle");
      default:
        this.play(pick);
    }
  }

  private startWalk() {
    const [lo, hi] = this.surfaceBounds();
    const span = Math.min(hi - lo, this.life.allows("wander") ? 420 : 90);
    const target = clamp(this.x + (this.rand() * 2 - 1) * span, lo, hi);
    if (Math.abs(target - this.x) > 4 * this.S) {
      this.walkTarget = target;
      this.setMode("walk");
    } else {
      this.setMode("idle");
    }
  }

  // -------------------------------------------------------------------------
  // Emotes y actividades
  // -------------------------------------------------------------------------

  /** Efectos con tiempo dentro de cada animación (una vez por marca). */
  private stepEmote() {
    const e = this.emote;
    if (!e) {
      this.setMode("idle");
      return;
    }
    const tt = this.modeT;
    const once = (key: string, at: number, fn: () => void) => {
      if (tt >= at && !this.emoteMarks.has(key)) {
        this.emoteMarks.add(key);
        fn();
      }
    };
    runEmoteCues(e, once, this.cueFx);
    if (tt >= EMOTE_DURATION[e]) {
      if (e === "jealous" && this.pendingColor) {
        this.setColorTarget(this.pendingColor, true);
        this.pendingColor = null;
      }
      this.setMode("idle");
    }
  }

  /**
   * Empieza la actividad `id` si está tranquilo (o dormido, si la actividad
   * lo admite). `limit`: tramo del suelo del que no puede salir.
   */
  doActivity(id: ActivityId, limit: [number, number] | null = null): boolean {
    if (!["idle", "sit", "walk", "sleep", "act"].includes(this.mode) || this.goal) return false;
    const woke = this.mode === "sleep";
    if (!this.acts.start(id, this, { woke, limit })) return false;
    if (woke) this.idleFor = 0;
    this.walkTarget = null;
    this.setMode("act");
    return true;
  }

  private stepActivity(input: FrameInput) {
    const r = this.acts.step(this, input);
    if (r === "go") return;
    this.setMode(r === "sleep" ? "sleep" : "idle");
    if (r !== "sleep" && r !== "idle") this.play(r);
  }

  // -------------------------------------------------------------------------
  // Pose
  // -------------------------------------------------------------------------

  frame(chat: ChatState): Frame {
    const t = this.t;
    const p: Pose = { ...BASE_POSE, lookX: this.lookX, lookY: this.lookY };
    const blink = this.blinker.phase(t, this.rand, () => this.life.blinkGap());
    let eyes: Eyes = blink ?? "open";
    // Cara, postura de fondo y respiración del estado (expression.ts).
    const lf = this.life.face(p, t);
    Object.assign(p, lf.pose);
    if (lf.eyes && !blink) eyes = lf.eyes;
    if (t < this.happyUntil) eyes = "happy";
    const look = modePose(p, eyes, this.poseCtx(blink));
    eyes = look.eyes;

    // Microgestos en reposo (idleLife.ts): mirar a un lado, rascarse…
    const mo = this.life.micro(p, this.mode);
    if (mo) Object.assign(p, mo.pose);
    if (mo?.eyes && !blink) eyes = mo.eyes;

    // Conversación (en el suelo, salvo gestos con guion que ya mandan).
    const groundedChat = this.isGrounded() && !["dizzy", "wave", "emote", "sleep"].includes(this.mode);
    if (groundedChat && chat !== "none") chatPose(p, chat, !!this.chatAgent && this.chatAgent !== "claude", t);

    // Le arrastran un fichero encima: se prepara para cogerlo.
    const d = this.dropAt;
    if (d && this.awaitingDrop) {
      const wide = catchPose(p, d.x - this.x, d.y - (this.y - this.height), this.facing, t);
      if (!blink) eyes = wide;
    }

    if (this.mode === "sleep") eyes = "closed";
    p.eyes = eyes;
    this.squash.settle(p, t, look.snap);
    return this.assembleFrame(p, look);
  }

  /** Lo que la pose del modo actual necesita del motor (framePose.ts). */
  private poseCtx(blink: BlinkPhase): PoseCtx {
    const v = this.dragVelocity();
    return {
      t: this.t,
      mode: this.mode,
      modeT: this.modeT,
      vy: this.vy,
      swing: this.swing,
      facing: this.facing,
      splatSide: this.splatSide,
      hangAnchor: this.hangAnchor,
      hangStruggle: this.settings.hang_struggle,
      dragSpeed: Math.hypot(v.vx, v.vy),
      happyUntil: this.happyUntil,
      state: this.life.state,
      walkPace: this.life.traits.speed,
      emote: this.emote,
      driveAct: this.driveAct,
      blink,
      actPose: (q) => this.acts.pose(q, this),
    };
  }

  private assembleFrame(p: Pose, look: ModeLook): Frame {
    const drop = this.hatDrop.at();
    let icon: Frame["icon"] = null;
    if (this.icon) {
      const age = this.t - this.icon.t0;
      if (age < this.icon.life) icon = { glyph: this.icon.glyph, age, life: this.icon.life };
      else this.icon = null;
    }
    return {
      pose: p,
      facing: this.facing,
      x: this.x,
      y: this.y,
      color: rgbToCss(this.color),
      pin: look.pin,
      zzz: look.zzz,
      stars: look.stars,
      icon,
      heli: look.heli,
      carry: this.carrying,
      hat: this.settings.hats && !drop && hatPolicy(this.mode, this.splatSide) === "on" && !p.rot ? this.hat : null,
      hatDrop: drop,
    };
  }
}

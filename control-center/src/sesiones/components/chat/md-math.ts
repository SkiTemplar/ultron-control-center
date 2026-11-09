// Fórmulas en línea con `$…$` sin comerse el texto normal. `remark-math` abre y cierra
// con dos `$` cualesquiera del párrafo, y en español el `$` va detrás del importe
// («3,42 $ frente a 5,10 $») y en Windows delante de la variable («$env:HOME y $env:PATH»):
// el texto perdía signos y espacios. `singleDollarTextMath: false` lo evita a costa de
// `$a^2$`, que la skill `rico` y la guía de formato prometen. Se aplica la regla de Pandoc
// a la marca de un solo `$`; `$$…$$` no cambia:
//
// - abre si lo que sigue no es espacio y lo que precede no es letra ni cifra («US$5»);
// - cierra si lo que precede no es espacio y lo que sigue no es letra ni cifra («$HOME/$PATH»).
//
// Si el cierre no vale, el `$` de apertura queda como texto y micromark prueba con el
// siguiente, así que un importe suelto no se lleva por delante la fórmula de detrás.

const DOLLAR = 36;
const SPACE = 32;
/** micromark: por debajo de este valor, saltos de línea (CR, LF, CRLF). */
const LINE_ENDING_BELOW = -2;

/** Carácter de micromark: `null` al final y negativos para saltos de línea y tabuladores. */
type Code = number | null;
type State = (code: Code) => State | undefined;

interface Token {
  type: string;
}

interface Effects {
  enter(type: string): Token;
  exit(type: string): Token;
  consume(code: Code): void;
}

interface TokenizeContext {
  previous: Code;
}

interface MathTextConstruct {
  name: string;
  tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State;
}

interface MicromarkExtension {
  text?: Record<number, unknown>;
}

/** Estado de una fórmula candidata mientras se recorre. */
interface Run {
  effects: Effects;
  ok: State;
  nok: State;
  /** Carácter anterior a la marca de apertura. */
  before: Code;
  sizeOpen: number;
  size: number;
  /** Último carácter de la fórmula: el anterior a la marca de cierre. */
  last: Code;
  closing: Token | null;
}

function isSpaceCode(code: Code): boolean {
  return code === null || code < 0 || /\s/.test(String.fromCharCode(code));
}

function isWordCode(code: Code): boolean {
  return code !== null && code >= 0 && /[\p{L}\p{N}]/u.test(String.fromCharCode(code));
}

function isLineEnding(code: Code): boolean {
  return code !== null && code < LINE_ENDING_BELOW;
}

function sequenceOpen(r: Run, code: Code): State | undefined {
  if (code === DOLLAR) {
    r.effects.consume(code);
    r.sizeOpen++;
    return (next) => sequenceOpen(r, next);
  }
  if (r.sizeOpen === 1 && (isSpaceCode(code) || isWordCode(r.before))) return r.nok(code);
  r.effects.exit("mathTextSequence");
  return between(r, code);
}

function between(r: Run, code: Code): State | undefined {
  if (code === null) return r.nok(code);
  if (code === DOLLAR) {
    r.closing = r.effects.enter("mathTextSequence");
    r.size = 0;
    return sequenceClose(r, code);
  }
  if (code === SPACE || isLineEnding(code)) {
    const type = code === SPACE ? "space" : "lineEnding";
    r.effects.enter(type);
    r.effects.consume(code);
    r.last = code;
    r.effects.exit(type);
    return (next) => between(r, next);
  }
  r.effects.enter("mathTextData");
  return data(r, code);
}

function data(r: Run, code: Code): State | undefined {
  if (code === null || code === SPACE || code === DOLLAR || isLineEnding(code)) {
    r.effects.exit("mathTextData");
    return between(r, code);
  }
  r.effects.consume(code);
  r.last = code;
  return (next) => data(r, next);
}

function sequenceClose(r: Run, code: Code): State | undefined {
  if (code === DOLLAR) {
    r.effects.consume(code);
    r.size++;
    return (next) => sequenceClose(r, next);
  }
  if (r.size !== r.sizeOpen) {
    // Otro tamaño de marca: es parte de la fórmula.
    if (r.closing) r.closing.type = "mathTextData";
    r.last = DOLLAR;
    return data(r, code);
  }
  if (r.sizeOpen === 1 && (isSpaceCode(r.last) || isWordCode(code))) return r.nok(code);
  r.effects.exit("mathTextSequence");
  r.effects.exit("mathText");
  return r.ok(code);
}

/**
 * Misma máquina de estados y mismos tokens que `mathText` de `micromark-extension-math`
 * (los lee `mdast-util-math`), con las comprobaciones de la regla en la apertura y el cierre.
 */
function tokenizeStrict(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const r: Run = { effects, ok, nok, before: this.previous, sizeOpen: 0, size: 0, last: null, closing: null };
  return (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    return sequenceOpen(r, code);
  };
}

function isMathText(value: unknown): value is MathTextConstruct {
  return typeof value === "object" && value !== null && (value as { name?: unknown }).name === "mathText";
}

/** remark: va justo detrás de `remarkMath` y sustituye el tokenizador de `$` que acaba de registrar. */
export function remarkStrictInlineMath(this: { data(): unknown }): void {
  const data = this.data() as { micromarkExtensions?: MicromarkExtension[] };
  data.micromarkExtensions = (data.micromarkExtensions ?? []).map((ext) => {
    const base = ext.text?.[DOLLAR];
    return isMathText(base) ? { ...ext, text: { ...ext.text, [DOLLAR]: { ...base, tokenize: tokenizeStrict } } } : ext;
  });
}

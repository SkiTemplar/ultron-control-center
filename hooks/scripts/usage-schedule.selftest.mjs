/**
 * usage-schedule.selftest.mjs — selftest del calendario de uso (lib/usage-schedule.js)
 * y de su efecto en el ritmo semanal (lib/usage-pace.js).
 * Uso: node hooks/scripts/usage-schedule.selftest.mjs   (exit 0 = verde)
 * Las fechas se construyen en hora local: el resultado no depende de la zona.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sched = require('./lib/usage-schedule.js');
const pace = require('./lib/usage-pace.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-schedule-selftest-'));
const FILE = path.join(TMP, 'schedule.json');
process.env.ULTRON_USAGE_SCHEDULE_FILE = FILE;
delete process.env.ULTRON_USAGE_SCHEDULE;

let fail = 0;
const A = (cond, name, detail = '') => {
  console.log(cond ? `  ok    ${name}` : `  FALLO ${name}${detail ? ` -> ${detail}` : ''}`);
  if (!cond) fail++;
};
const write = (obj) => fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj));
const sec = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Semana de prueba: viernes 2026-09-25 03:00 -> viernes 2026-10-02 03:00.
const START = sec(2026, 9, 25, 3);
const RESET = sec(2026, 10, 2, 3);
const WEEK = 7 * 86400;

// 1. Sin fichero -> sin calendario y ritmo lineal.
fs.rmSync(FILE, { force: true });
A(sched.loadSchedule() === null, 'sin fichero: loadSchedule devuelve null');
const noFile = pace.windowPace('seven_day', 30, RESET, sec(2026, 9, 28, 22));
A(noFile.scheduled === false && near(noFile.elapsedPct, noFile.linearElapsedPct), 'sin fichero: ritmo lineal');

// 2. Ficheros invalidos: null, sin lanzar y con motivo legible.
const bad = [
  ['JSON roto', '{ no es json'],
  ['lowWeight 0', { lowWeight: 0, low: {} }],
  ['lowWeight > 1', { lowWeight: 2, low: {} }],
  ['dia desconocido', { lowWeight: 0.2, low: { lunes: [['01:00', '02:00']] } }],
  ['franja invertida', { lowWeight: 0.2, low: { mon: [['10:00', '03:00']] } }],
  ['hora mal escrita', { lowWeight: 0.2, low: { mon: [['3', '10:00']] } }],
  ['baseWeight fuera de rango', { lowWeight: 0.2, baseWeight: { sat: 5 }, low: {} }],
];
for (const [name, content] of bad) {
  write(content);
  let threw = false;
  let result;
  try {
    result = sched.loadSchedule();
  } catch {
    threw = true;
  }
  A(!threw && result === null, `invalido (${name}): null y sin excepcion`);
}
A(typeof sched.normalize({ lowWeight: 0.2, low: { mon: [['10:00', '03:00']] } }).error === 'string', 'invalido: normalize da el motivo');

// 3. lowWeight = 1 y sin pesos base equivale al lineal.
write({ lowWeight: 1, low: { mon: [['01:00', '07:00']], thu: [['01:00', '17:00']] } });
const flat = sched.loadSchedule();
const mid = sec(2026, 9, 28, 22, 47);
A(near(sched.weightedElapsedPct(START, mid, RESET, flat), ((mid - START) / WEEK) * 100, 1e-6), 'peso 1: coincide con el lineal');

// 4. Extremos y monotonia.
write({ lowWeight: 0.15, baseWeight: { sat: 0.8, sun: 0.8 }, low: { tue: [['01:00', '13:00']], thu: [['01:00', '17:00']] } });
const real = sched.loadSchedule();
A(near(sched.weightedElapsedPct(START, START, RESET, real), 0) && near(sched.weightedElapsedPct(START, RESET, RESET, real), 100), 'extremos: 0 % al inicio y 100 % al reset');
let last = -1;
let mono = true;
for (let i = 0; i <= 50; i++) {
  const v = sched.weightedElapsedPct(START, START + (WEEK * i) / 50, RESET, real);
  if (v < last) mono = false;
  last = v;
}
A(mono, 'monotonia: el esperado nunca baja');

// 5. Una franja baja avanza menos que el reloj.
write({ lowWeight: 0.1, low: { tue: [['01:00', '13:00']] } });
const tue = sched.loadSchedule();
const dayStart = sec(2026, 9, 29, 0);
const dayEnd = sec(2026, 9, 30, 0);
const at13 = sec(2026, 9, 29, 13);
const w13 = sched.weightedElapsedPct(dayStart, at13, dayEnd, tue);
A(w13 < 54.2 - 30, 'franja baja: a las 13:00 el esperado va muy por debajo del 54,2 % lineal', `${w13.toFixed(1)} %`);
A(near(w13, ((1 + 12 * 0.1) / (24 - 12 + 1.2)) * 100, 1e-6), 'franja baja: coincide con el calculo a mano (16,7 %)', `${w13.toFixed(3)} %`);

// 6. Efecto en el aviso: tres dias de poco uso al final de la semana.
write({ lowWeight: 0.1, low: { tue: [['00:00', '24:00']], wed: [['00:00', '24:00']], thu: [['00:00', '24:00']] } });
const now6 = sec(2026, 9, 28, 22);
const withSched = pace.windowPace('seven_day', 60, RESET, now6);
process.env.ULTRON_USAGE_SCHEDULE = '0';
const linear = pace.windowPace('seven_day', 60, RESET, now6);
delete process.env.ULTRON_USAGE_SCHEDULE;
A(linear.alert === true && linear.scheduled === false, 'lineal: 60 % usado el lunes por la noche avisa');
A(withSched.scheduled === true && withSched.alert === false && withSched.elapsedPct > 80, 'con horario: los tres dias siguientes casi sin uso no avisan', `esperado ${withSched.elapsedPct.toFixed(1)} %`);
A(withSched.linearElapsedPct < withSched.elapsedPct && withSched.projectedPct < linear.projectedPct, 'con horario: la proyeccion baja frente a la lineal');

// 7. La ventana de 5 h nunca se pondera y ULTRON_USAGE_SCHEDULE=0 apaga el calendario.
const five = pace.windowPace('five_hour', 30, now6 + 2.5 * 3600, now6);
A(five.scheduled === false && near(five.elapsedPct, five.linearElapsedPct), '5 h: siempre lineal');
process.env.ULTRON_USAGE_SCHEDULE = '0';
A(sched.loadSchedule() === null, 'ULTRON_USAGE_SCHEDULE=0: calendario apagado');
delete process.env.ULTRON_USAGE_SCHEDULE;

// 8. El fichero personal real, si existe, tiene que ser valido (no se falla en silencio).
const personal = path.join(os.homedir(), '.ultron', 'cockpit', 'usage-schedule.json');
if (fs.existsSync(personal)) {
  let parsed = null;
  try {
    parsed = sched.normalize(JSON.parse(fs.readFileSync(personal, 'utf8')));
  } catch {
    /* parsed null */
  }
  A(parsed && parsed.schedule !== null, 'cockpit/usage-schedule.json es valido', parsed ? parsed.error : 'JSON ilegible');
}

// 9. Valores de referencia compartidos con el port de TypeScript (control-center).
const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'control-center', 'src', 'components', 'usage', 'usage-schedule-parity.json'), 'utf8'),
);
write(fixture.schedule);
const parSchedule = sched.loadSchedule();
const local = (a) => sec(a[0], a[1], a[2], a[3], a[4]);
const mismatches = fixture.cases.filter(
  (c) => !near(sched.weightedElapsedPct(local(fixture.start), local(c.now), local(fixture.reset), parSchedule), c.pct, 1e-9),
);
A(parSchedule !== null && fixture.cases.length >= 10 && mismatches.length === 0, 'valores de referencia compartidos con el port de TypeScript', JSON.stringify(mismatches));

// 10. Horario invalido: loadScheduleResult da el motivo y usage-pace-guard lo
//     anota en su log (hook-errors.jsonl) una vez por motivo (auditoria 2026-10-26, L6).
const LOGS = path.join(TMP, 'logs');
process.env.ULTRON_HOOK_LOGS_DIR = LOGS;
process.env.ULTRON_USAGE_PACE_STATE_DIR = path.join(TMP, 'pace-state');
process.env.ULTRON_USAGE_PACE_PAYLOAD = path.join(TMP, 'sin-payload.json');
delete process.env.ULTRON_USAGE_PACE;
delete process.env.CLAUDE_NO_HOOKS;
const guard = require('./usage-pace-guard.js');
const errorLines = () => {
  try {
    return fs.readFileSync(path.join(LOGS, 'hook-errors.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

fs.rmSync(FILE, { force: true });
A(sched.loadScheduleResult().error === null, 'sin fichero: loadScheduleResult sin error (lineal esperado)');
guard.decide({ session_id: 's10' });
A(errorLines().length === 0, 'caso negativo: sin fichero el hook no anota nada');

write({ lowWeight: 0.2, low: { mon: [['00:00', '08:00']] } });
guard.decide({ session_id: 's10' });
A(errorLines().length === 0, 'caso negativo: con horario valido el hook no anota nada');

write({ lowWeight: 0, low: {} });
A(/lowWeight/.test(sched.loadScheduleResult().error || ''), 'reglas incumplidas: loadScheduleResult da el motivo');
guard.decide({ session_id: 's10' });
const afterInvalid = errorLines();
A(
  afterInvalid.length === 1 && afterInvalid[0].hook === 'usage-pace-guard' && /horario de uso inválido.*lowWeight/.test(afterInvalid[0].error),
  'reglas incumplidas: el hook lo anota en hook-errors.jsonl',
  JSON.stringify(afterInvalid),
);
guard.decide({ session_id: 's10' });
A(errorLines().length === 1, 'mismo motivo y mismo fichero: no se repite en cada prompt');

write('{ no es json');
A(/no es JSON/.test(sched.loadScheduleResult().error || ''), 'JSON roto: loadScheduleResult da el motivo');
guard.decide({ session_id: 's10' });
const afterBroken = errorLines();
A(afterBroken.length === 2 && /no es JSON/.test(afterBroken[1].error), 'JSON roto: el hook lo anota', JSON.stringify(afterBroken));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'VERDE' : 'ROJO'}: ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);

// fixture-personality.js — HOME temporal con un personality.json minimo para los
// tests que dependen del tono por defecto.
//
// ~/.ultron/personality.json no se versiona (config personal; lo siembra la app
// desde orchestrator/personality.rs al primer arranque), asi que en un checkout
// limpio o en el runner del CI no existe. Sin este fixture esos tests pasaban
// solo en la maquina del usuario y fallaban en CI desde el 2026-10-03.
//
// No es un test: run-selftests.mjs solo descubre hooks/scripts/tests/test-*.js.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_VARS = ['HOME', 'USERPROFILE'];

/** Catalogo minimo: el tono por defecto `ultron`, como el seed de Rust. */
const FIXTURE = Object.freeze({
  version: 1,
  default_tone: 'ultron',
  tones: [
    {
      id: 'ultron',
      name: 'Ultron',
      lang: 'es',
      description: 'Default del sistema (fixture de test).',
      style_guide: 'Maquina: resultado + cifra.',
      signals: [],
      strong_signals: [],
      explicit_triggers: ['modo ultron'],
      lexicon: [],
      profanity: 'none',
    },
  ],
});

/** Crea un HOME temporal con `.ultron/personality.json` y devuelve su ruta. */
function makeFixtureHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-tone-home-'));
  fs.mkdirSync(path.join(home, '.ultron'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ultron', 'personality.json'), JSON.stringify(FIXTURE, null, 2));
  return home;
}

/** Variables de entorno para un proceso hijo que debe ver el HOME del fixture. */
function fixtureHomeEnv(home) {
  return Object.fromEntries(HOME_VARS.map((k) => [k, home]));
}

/**
 * Apunta HOME/USERPROFILE del proceso actual al fixture (os.homedir() los lee
 * en cada llamada). Devuelve lo necesario para restaurarlos.
 */
function withFixturePersonality() {
  const home = makeFixtureHome();
  const previous = Object.fromEntries(HOME_VARS.map((k) => [k, process.env[k]]));
  for (const k of HOME_VARS) process.env[k] = home;
  return { home, previous };
}

/** Restaura HOME/USERPROFILE y borra el HOME temporal. */
function restoreHome({ home, previous }) {
  for (const k of HOME_VARS) {
    if (previous[k] === undefined) delete process.env[k];
    else process.env[k] = previous[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
}

module.exports = { FIXTURE, makeFixtureHome, fixtureHomeEnv, withFixturePersonality, restoreHome };

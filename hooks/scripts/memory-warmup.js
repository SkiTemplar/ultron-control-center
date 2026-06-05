#!/usr/bin/env node
// hooks/scripts/memory-warmup.js — SessionStart hook (mitigacion cold-start E5).
//
// PROBLEMA: el modelo FastEmbed multilingual-e5-large (1024d, ~1.3GB ONNX en
// ~/.ultron/.fastembed_cache/) se carga LAZY en el PRIMER embed de la sesion,
// dentro de memory-orchestrate.js o memory-session-resume.js. En frio tarda
// 1-2s (verificado: recall en frio = ~2987ms) y puede reventar el timeout del
// hook -> inyecta contexto VACIO (degradacion silenciosa).
//
// MITIGACION (barata, sin rebuild): en SessionStart, spawn DETACHED del binario
// para forzar que el SO cachee el .onnx en page-cache (~80% del coste en frio).
// El hook retorna en <50ms porque NO espera al hijo. Cuando el usuario escribe
// su primer prompt (segundos despues), el page-cache esta caliente y el embed
// en frio baja de 1-2s a ~300-500ms (bajo el timeout).
//
// LIMITACION HONESTA: cada invocacion del .exe es un PROCESO NUEVO, asi que esto
// NO deja E5 residente en RAM — solo calienta el page-cache del SO. La cura en
// memoria es el daemon `serve` opcional (ver notas REQUIRES-REBUILD). Hasta
// entonces, page-cache warmup + timeouts subidos son el fix fiable.
//
// Prueba `warmup` (subcomando futuro que llama embed_query("warmup") una vez) y
// como fallback `recall warmup --project __warmup__`, que fuerza un embed por el
// path nativo exacto. Ambos detached, salida ignorada; un subcomando desconocido
// sale con error de inmediato y se ignora. FAIL-SAFE: emite vacio y exit 0.

const fs = require('fs');
const { spawnDetached } = require('./lib/ultron-memory-cli');

function emit(additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: additionalContext || '',
      },
    })
  );
}

function main() {
  try { fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  spawnDetached(['warmup']);
  spawnDetached(['recall', 'warmup', '--project', '__warmup__']);
  emit(''); // este hook solo pre-calienta; nunca inyecta nada
}

try {
  main();
} catch {
  try { emit(''); } catch { /* ignore */ }
}
process.exitCode = 0;


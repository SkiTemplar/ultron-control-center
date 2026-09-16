/**
 * Prueba de humo real contra un Ollama local: construye una peticion FIM con
 * un prefijo C++ y muestra la linea sugerida y la latencia. No usa la API de
 * `vscode`, solo la logica pura de `src/logic.ts`.
 *
 * Uso: npx tsx scripts/smoke.ts [endpoint] [modelo]
 */
import { buildGenerateRequest, fetchCompletion, sanitizeCompletion } from "../src/logic";

async function main(): Promise<void> {
  const endpoint = process.argv[2] ?? "http://127.0.0.1:11434";
  const model = process.argv[3] ?? "qwen2.5-coder:1.5b-base";

  const prefix = "#include <vector>\n\nint sum(const std::vector<int>& xs) {\n  int total = 0;\n  for (int x : xs) {\n    total += ";
  const suffix = ";\n  }\n  return total;\n}\n";

  const request = buildGenerateRequest({
    model,
    prefix,
    suffix,
    maxPrefixChars: 3000,
    maxSuffixChars: 1000,
  });

  console.log(`[smoke] endpoint=${endpoint} model=${model}`);
  const start = performance.now();
  try {
    const raw = await fetchCompletion({
      endpoint,
      request,
      timeoutMs: 60_000,
      fetchImpl: fetch,
    });
    const elapsedMs = performance.now() - start;
    const suggestion = sanitizeCompletion(raw, suffix);
    console.log(`[smoke] respuesta cruda: ${JSON.stringify(raw)}`);
    console.log(`[smoke] linea sugerida: ${JSON.stringify(suggestion)}`);
    console.log(`[smoke] latencia: ${elapsedMs.toFixed(1)} ms`);
  } catch (err) {
    const elapsedMs = performance.now() - start;
    console.error(`[smoke] fallo tras ${elapsedMs.toFixed(1)} ms:`, err);
    process.exitCode = 1;
  }
}

main();

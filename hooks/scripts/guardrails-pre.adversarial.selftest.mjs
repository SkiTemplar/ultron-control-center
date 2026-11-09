/**
 * Arnes adversarial de guardrails-pre (auditoria 2026-11-01). Mide falsos
 * negativos (FN: un comando que debia dispararse y pasa) y falsos positivos
 * (FP: un comando legitimo que se bloquea) sobre una tabla de payloads.
 *
 * Solo llama a classify() con cadenas: no se ejecuta ningun comando.
 *
 *   node guardrails-pre.adversarial.selftest.mjs           exit 1 si hay un FP, un
 *                                                          FN sin declarar o un
 *                                                          limite declarado obsoleto
 *   node guardrails-pre.adversarial.selftest.mjs --medir   solo el recuento (exit 0)
 *
 * Un payload con cuarta columna es un limite declarado: FN conocido que no se
 * arregla y que el codigo documenta. Si la regla empieza a dispararse, el test
 * falla para que la tabla no quede obsoleta.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const g = require('./guardrails-pre.js');

const B = 'Bash';
const P = 'PowerShell';
const M = 'Monitor';
const CF = 'deny/commit-format';
const UV = 'deny/uv';
const SK = 'deny/skip-permissions';
const FP = 'ask/force-push';
const OK = 'pasa';
const FLAG = '--dangerously-skip-permissions';
const b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');

const LIM_EVAL = 'no evalua la shell: comando construido en una variable o sustitucion';
const LIM_CODIGO = 'codigo arbitrario dentro de otro interprete o script';
const LIM_ENVOLTORIO = 'envoltorio no listado en PREFIJOS';
const LIM_ESCAPE = 'escape dentro del nombre del binario';

const COMMIT = [
  [B, 'git commit -m "x"', CF],
  [B, 'git commit -am "x"', CF],
  [B, 'git commit --message="x"', CF],
  [B, 'git commit --message "x"', CF],
  [B, 'git commit --message=x', CF],
  [B, 'git commit -m"x"', CF],
  [B, 'git commit -qm "x"', CF],
  [B, 'git commit -a -m "x"', CF],
  [B, 'git commit --no-verify -m "x"', CF],
  [B, 'git add . && git commit -m "x"', CF],
  [B, 'git commit -m "feat: ok" && git commit -m "x"', CF],
  [B, "git commit -m 'x'", CF],
  [B, 'git -C . commit -m "x"', CF],
  [B, '"git" commit -m "x"', CF],
  [B, '/usr/bin/git commit -m "x"', CF],
  [B, 'git.exe commit -m "x"', CF],
  [B, 'sudo git commit -m "x"', CF],
  [B, 'timeout 5 git commit -m "x"', CF],
  [B, 'HOME=/tmp git commit -m "x"', CF],
  [B, '(git commit -m "x")', CF],
  [B, 'if git commit -m "x"; then echo y; fi', CF],
  [B, 'bash -c \'git commit -m "x"\'', CF],
  [B, 'echo "$(git commit -m x)"', CF],
  [P, 'git commit -m "x"', CF],
  [P, '& git commit -m "x"', CF],
  [B, 'git commit -m x', CF],
  [B, 'git commit --amend -m "x"', CF],
  [B, 'git --no-pager commit -m "x"', CF],
  [B, "git commit -m @'\nx\n'@", CF],
  [B, 'xargs git commit -m "x"', CF],
  [B, `git commit -m "$(cat <<'EOF'\nfeat: a\nEOF\n)" && git commit -m "$(cat <<'EOF'\nx\nEOF\n)"`, CF],
  [M, 'git commit -m "x"', CF],
  [B, 'git commit -m "feat: a"', OK],
  [B, 'git commit -am "fix: x"', OK],
  [B, 'git commit --message="docs: x"', OK],
  [B, 'git commit --message "docs: x"', OK],
  [B, 'git commit -m"chore: x"', OK],
  [B, 'git commit -qm "test: x"', OK],
  [B, 'git commit --amend --no-edit', OK],
  [B, 'git commit -F msg.txt', OK],
  [B, 'git commit --file=msg.txt', OK],
  [B, 'git commit', OK],
  [B, 'git commit -m "$msg"', OK],
  [B, 'git commit -m "$(cat m.txt)"', OK],
  [B, 'echo "git commit -m nope"', OK],
  [B, 'grep "git commit -m nope" a.md', OK],
  [B, "rg 'git commit -m nope' docs", OK],
  [B, `cat > t.sh <<'EOF'\ngit commit -m "wip"\nEOF`, OK],
  [B, 'git log --grep="git commit -m x"', OK],
  [B, 'echo git commit -m nope', OK],
  [B, 'git commit -m "feat: a" -m "cuerpo"', OK],
  [B, 'git commit -a && uv run python -m pytest', OK],
  [B, 'git commit -m "feat(x)!: y"', OK],
  [P, 'Write-Host "git commit -m nope"', OK],
  [B, 'git commit -C HEAD', OK],
  [B, 'git commit -c HEAD', OK],
  [B, 'git ci -m "x"', CF, 'alias de git: requiere leer la configuracion'],
];

const UV_TABLA = [
  [B, 'python x.py', UV],
  [B, 'python3 x.py', UV],
  [B, 'python3.12 x.py', UV],
  [B, 'py x.py', UV],
  [B, 'pythonw x.py', UV],
  [B, 'python.exe x.py', UV],
  [B, '.venv/Scripts/python.exe x.py', UV],
  [B, '.venv/bin/python x.py', UV],
  [B, '/usr/bin/python x.py', UV],
  [P, 'C:\\Python312\\python.exe x.py', UV],
  [P, '& "C:\\Program Files\\Python\\python.exe" x.py', UV],
  [P, '& python x.py', UV],
  [B, 'timeout 10 python x.py', UV],
  [B, 'timeout -k 2 10 python x.py', UV],
  [B, 'exec python x.py', UV],
  [B, 'command python x.py', UV],
  [B, 'nohup python x.py', UV],
  [B, 'sudo python x.py', UV],
  [B, 'sudo -u root python x.py', UV],
  [B, 'env python x.py', UV],
  [B, 'env -i FOO=1 python x.py', UV],
  [B, '/usr/bin/env python3 x.py', UV],
  [B, 'FOO=1 python x.py', UV],
  [B, 'nice -n 5 python x.py', UV],
  [B, 'ls | xargs python', UV],
  [B, 'ls | xargs -n1 python x.py', UV],
  [B, "find . -name '*.py' -exec python {} \\;", UV],
  [B, 'find . -execdir python3 {} +', UV],
  [B, 'if python x.py; then echo y; fi', UV],
  [B, 'while python x.py; do echo y; done', UV],
  [B, 'for f in a b; do python $f; done', UV],
  [B, 'if true; then python x.py; fi', UV],
  [B, 'if false; then a; else python x.py; fi', UV],
  [B, 'cd x && python y', UV],
  [B, 'a | python', UV],
  [B, 'a || python y', UV],
  [B, '(python x.py)', UV],
  [B, '{ python x.py; }', UV],
  [B, '! python x.py', UV],
  [B, 'case a in a) python x.py;; esac', UV],
  [B, 'f() { python x.py; }', UV],
  [B, 'p"ytho"n x.py', UV],
  [B, '"python" x.py', UV],
  [B, 'pip install x', UV],
  [B, 'pip3 install x', UV],
  [B, 'pip3.12 install x', UV],
  [B, 'pip.exe install x', UV],
  [B, '/usr/bin/pip install x', UV],
  [B, '.venv/Scripts/pip.exe install x', UV],
  [B, 'sudo pip install x', UV],
  [B, 'python -m pip install x', UV],
  [B, 'timeout 5 pip install x', UV],
  [P, 'Start-Process python -ArgumentList x.py', UV],
  [P, 'Start-Process -FilePath python', UV],
  [P, 'Start-Process -Wait -NoNewWindow python x.py', UV],
  [P, 'saps python', UV],
  [P, 'start python x.py', UV],
  [B, 'start /b python x.py', UV],
  [B, 'start "" python x.py', UV],
  [B, 'bash -c "python x.py"', UV],
  [B, "sh -c 'pip install x'", UV],
  [P, 'cmd /c python x.py', UV],
  [P, 'cmd.exe /C python x.py', UV],
  [P, 'powershell -Command "python x.py"', UV],
  [P, 'powershell -Com "python x.py"', UV],
  [P, 'powershell -c "python x.py"', UV],
  [P, 'powershell "python x.py"', UV],
  [P, "pwsh 'python x.py'", UV],
  [P, 'pwsh -NoProfile "python x.py"', UV],
  [P, 'powershell -ExecutionPolicy Bypass -Command "python x.py"', UV],
  [P, `powershell -en ${b64('python x.py')}`, UV],
  [P, `powershell -encodedc ${b64('python x.py')}`, UV],
  [P, `powershell /enc ${b64('python x.py')}`, UV],
  [P, `powershell -ec ${b64('python x.py')}`, UV],
  [B, 'echo "python x.py" | bash', UV],
  [B, "echo 'python x.py' | sh", UV],
  [B, 'printf "python x.py" | bash', UV],
  [B, 'bash <<EOF\npython x.py\nEOF', UV],
  [B, "cat <<'EOF' | bash\npython x.py\nEOF", UV],
  [B, 'bash <<< "python x.py"', UV],
  [B, 'eval "python x.py"', UV],
  [P, 'iex "python x.py"', UV],
  [P, 'Invoke-Expression "python x.py"', UV],
  [P, 'foreach ($f in $a) { python $f }', UV],
  [P, '1..3 | % { python x.py }', UV],
  [P, 'echo (python x.py)', UV],
  [P, '$x = (python x.py)', UV],
  [P, 'if ($true) { python x.py }', UV],
  [M, 'python x.py', UV],
  [M, '& python x.py', UV],
  [B, 'eval "$x"', UV, LIM_EVAL],
  [B, '$cmd x.py', UV, LIM_EVAL],
  [B, '$(echo python) x.py', UV, LIM_EVAL],
  [P, 'iex $x', UV, LIM_EVAL],
  [B, 'pyt\\hon x.py', UV, LIM_ESCAPE],
  [B, 'node -e "require(\'child_process\').execSync(\'python x\')"', UV, LIM_CODIGO],
  [B, 'echo cHl0aG9u | base64 -d | bash', UV, LIM_CODIGO],
  [B, 'parallel python ::: a b', UV, LIM_ENVOLTORIO],
  [B, 'fd -e py -x python', UV, LIM_ENVOLTORIO],
  [B, 'poetry run python x.py', UV, LIM_ENVOLTORIO],
  [B, 'uv run python x.py', OK],
  [B, 'uv pip install x', OK],
  [B, 'uv run --with y python x.py', OK],
  [B, 'grep -rn python src/', OK],
  [B, 'cat docs/python.md', OK],
  [B, 'echo python x.py', OK],
  [B, 'echo "pip install x"', OK],
  [B, 'git commit -m "feat: usa pip install z"', OK],
  [B, 'git commit -m "docs: python x.py"', OK],
  [B, 'git commit -m "docs: usa bash -c python"', OK],
  [B, 'grep "pip install" README.md', OK],
  [B, "rg \"sh -c 'pip install x'\" docs", OK],
  [B, 'grep "bash -c python" a.md', OK],
  [B, 'echo "cmd /c python x"', OK],
  [B, 'which python', OK],
  [B, 'where python', OK],
  [B, 'command -v python', OK],
  [B, 'type python', OK],
  [B, 'ls python', OK],
  [P, 'Get-Command python', OK],
  [B, "uv run python - <<'PY'\nprint(1)\nPY", OK],
  [B, "cat <<'EOF' > a.md\npython x.py\nEOF", OK],
  [B, `cat > t.sh <<'EOF'\nbash -c "python x"\nEOF`, OK],
  [P, "$x = @'\npython y\n'@; Write-Host $x", OK],
  [P, 'Write-Host "python x"', OK],
  [B, 'grep -E "(py|js)" f', OK],
  [B, 'npx pyright', OK],
  [B, 'pipx list', OK],
  [B, 'python-config --libs', OK],
  [B, './python-helpers.sh', OK],
  [B, 'pyenv versions', OK],
  [B, 'cat python3.12', OK],
  [B, 'mkdir python', OK],
  [B, 'cd python', OK],
  [B, 'ls .venv/Scripts/python.exe', OK],
  [B, "echo 'a; python x.py'", OK],
  [B, 'echo "a#b; python x.py"', OK],
  [B, 'timeout 5 echo python', OK],
  [B, 'xargs echo python', OK],
  [B, 'find . -name python', OK],
  [B, 'find . -exec echo python {} \\;', OK],
  [B, 'git log --grep=pip', OK],
  [B, 'bash script.sh', OK],
  [P, 'powershell -File script.ps1', OK],
  [P, 'Start-Process notepad', OK],
  [B, 'start index.html', OK],
  [P, 'Get-Process | Where-Object { $_.Name -eq "python" }', OK],
];

const SKIP = [
  [B, `claude ${FLAG}`, SK],
  [B, `claude "${FLAG}"`, SK],
  [B, `claude '${FLAG}'`, SK],
  [B, `claude --dangerously-skip-"permissions"`, SK],
  [B, `claude ${FLAG}=true`, SK],
  [B, `timeout 5 claude ${FLAG}`, SK],
  [B, `nohup claude ${FLAG}`, SK],
  [B, `sudo claude ${FLAG}`, SK],
  [B, `env X=1 claude ${FLAG}`, SK],
  [B, `exec claude ${FLAG}`, SK],
  [B, `if claude ${FLAG}; then echo y; fi`, SK],
  [B, `node /x/cli.js ${FLAG}`, SK],
  [P, `node "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" ${FLAG}`, SK],
  [B, `bun /x/node_modules/@anthropic-ai/claude-code/cli.js "${FLAG}"`, SK],
  [P, `start claude ${FLAG}`, SK],
  [P, `Start-Process claude -ArgumentList '${FLAG}'`, SK],
  [P, `Start-Process claude -ArgumentList "${FLAG} -p x"`, SK],
  [P, `Start-Process -FilePath claude -ArgumentList "${FLAG}"`, SK],
  [B, `npx claude ${FLAG}`, SK],
  [B, `npx -y @anthropic-ai/claude-code ${FLAG}`, SK],
  [B, `bunx claude ${FLAG}`, SK],
  [B, `pnpm dlx claude ${FLAG}`, SK],
  [B, `claude.exe ${FLAG}`, SK],
  [P, `claude.cmd ${FLAG}`, SK],
  [P, `& claude ${FLAG}`, SK],
  [B, 'claude --permission-mode bypassPermissions', SK],
  [B, 'claude --permission-mode=bypassPermissions', SK],
  [B, 'claude --permission-mode "bypassPermissions"', SK],
  [B, 'claude --allow-dangerously-skip-permissions', SK],
  [B, `bash -c "claude ${FLAG}"`, SK],
  [P, `cmd /c claude ${FLAG}`, SK],
  [P, `powershell -enc ${b64(`claude ${FLAG}`)}`, SK],
  [B, `echo "claude ${FLAG}" | bash`, SK],
  [B, `claude -p "x" ${FLAG}`, SK],
  [M, `claude ${FLAG}`, SK],
  [B, 'claude --version', OK],
  [B, `claude -p "hola ${FLAG} adios"`, OK],
  [B, `echo claude ${FLAG}`, OK],
  [B, `grep -rn -- ${FLAG} docs/`, OK],
  [B, `rg "claude ${FLAG}" docs`, OK],
  [B, `node -e "console.log(1)" # ${FLAG}`, OK],
  [B, `node x.js ${FLAG}`, OK],
  [B, 'claude --permission-mode plan', OK],
  [B, `git commit -m "docs: prohibe claude ${FLAG}"`, OK],
];

const PUSH = [
  [B, 'git push --force', FP],
  [B, 'git push -f', FP],
  [B, 'git push "--force"', FP],
  [B, "git push '-f'", FP],
  [B, 'git push --forc', FP],
  [B, 'git push --force-with-lease', FP],
  [B, 'git push --force-if-includes', FP],
  [B, 'git push --mirror', FP],
  [B, 'git push -uf origin main', FP],
  [B, 'git push origin +main', FP],
  [B, 'git push origin "+main"', FP],
  [B, 'git -C x push -f', FP],
  [B, "bash -c 'git push -f'", FP],
  [B, 'timeout 9 git push -f', FP],
  [B, 'cd x && git push --force', FP],
  [M, 'git push -f', FP],
  [B, 'git push', OK],
  [B, 'git push -u origin main', OK],
  [B, 'git push --follow-tags origin main', OK],
  [B, 'git push -o ci.skip origin main', OK],
  [B, 'echo git push --force', OK],
  [B, 'echo "git push --force"', OK],
  [B, 'grep "git push -f" a.md', OK],
  [B, 'git log +main..x', OK],
  [P, '"{0}" -f 1; git push', OK],
  [B, 'git commit -m "docs: git push --force"', OK],
  [B, 'git push origin main:main', OK],
  [B, 'git push origin feature+x', OK],
];

const TABLA = [...COMMIT, ...UV_TABLA, ...SKIP, ...PUSH];

const veredicto = (tool, command) => {
  const v = g.classify(tool, { command });
  return v ? `${v.decision}/${v.regla}` : OK;
};

const cuenta = { total: TABLA.length, fn: 0, fnDeclarados: 0, fnSinDeclarar: 0, fp: 0, otros: 0, obsoletos: 0 };
const errores = [];
for (const [tool, command, esperado, limite] of TABLA) {
  const real = veredicto(tool, command);
  const etiqueta = `[${tool}] ${JSON.stringify(command).slice(0, 110)}: esperado=${esperado} real=${real}`;
  if (real === esperado) {
    if (limite) {
      cuenta.obsoletos++;
      errores.push(`LIMITE OBSOLETO ${etiqueta}`);
    }
  } else if (esperado === OK) {
    cuenta.fp++;
    errores.push(`FP ${etiqueta}`);
  } else if (real === OK) {
    cuenta.fn++;
    if (limite) cuenta.fnDeclarados++;
    else {
      cuenta.fnSinDeclarar++;
      errores.push(`FN ${etiqueta}`);
    }
  } else {
    cuenta.otros++;
    errores.push(`REGLA DISTINTA ${etiqueta}`);
  }
}

// Rendimiento: el hook es sincrono en cada llamada a la shell. `echo ` repetido
// hacia cuadratico el escaneo de `echo … | bash` (7,9 s con 100 KB).
{
  const patologicas = [
    'sh -c '.repeat(5000),
    '$('.repeat(5000),
    'echo '.repeat(20000),
    `${'echo '.repeat(20000)}| bash`,
    `echo "${'palabra '.repeat(12000)}`,
    "cat <<EOF\nx\nEOF\n".repeat(2000),
    `powershell -enc ${'A'.repeat(100000)}`,
  ];
  const t0 = Date.now();
  for (const command of patologicas) g.classify(B, { command });
  const ms = Date.now() - t0;
  if (ms >= 2500) errores.push(`LENTO ${patologicas.length} lineas patologicas en ${ms} ms (tope 2500)`);
}

for (const linea of errores) console.error(linea);
console.log(
  `payloads=${cuenta.total} FN=${cuenta.fn} (declarados=${cuenta.fnDeclarados}, sin declarar=${cuenta.fnSinDeclarar}) ` +
    `FP=${cuenta.fp} regla-distinta=${cuenta.otros} limites-obsoletos=${cuenta.obsoletos}`,
);
const medir = process.argv.includes('--medir');
process.exit(!medir && errores.length ? 1 : 0);

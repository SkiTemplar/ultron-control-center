// Pantalla de terminal simulada para la vista xterm del modo demo.

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const copper = (s: string) => `${ESC}38;5;173m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;

export function terminalScreen(title: string): string {
  const lines = [
    copper("╭───────────────────────────────────────────────────────────╮"),
    copper("│") + ` ✻ Claude Code · ${title.padEnd(40).slice(0, 40)}` + copper("│"),
    copper("╰───────────────────────────────────────────────────────────╯"),
    "",
    `${dim(">")} ¿Y en 80 columnas cómo queda? Enséñamelo.`,
    "",
    `${green("●")} Bash(npx tsx scripts/render-uso.ts --cols 80)`,
    `  ${dim("⎿")}  5 h  ████████░░░░░░░░░░░░  12 %   reset 03:40`,
    `     sem  ██████████░░░░░░░░░░  51 %   reset lun`,
    "",
    `${copper("●")} Con 80 columnas el panel queda así: el ritmo baja a la segunda línea…`,
    "",
    dim("  ⏵⏵ auto · opus 5.5 · 168k/1M · Esc para interrumpir"),
    "",
    "> ",
  ];
  return lines.join("\r\n");
}

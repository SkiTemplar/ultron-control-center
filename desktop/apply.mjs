#!/usr/bin/env node
// Aplica theme.json al escritorio: Windows Terminal y color de acento.
// El dock (Windhawk) se aplica aparte con windhawk/dock-noche.ps1 (requiere admin).
// Uso: node apply.mjs [preset] [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTheme, toAbgrDword } from './lib/palette.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const presetArg = args.find((a) => !a.startsWith('--'));

const themeJson = JSON.parse(readFileSync(join(ROOT, 'theme.json'), 'utf8'));
const theme = resolveTheme(themeJson, presetArg);

function write(path, content) {
  if (isDryRun) {
    console.log(`[dry-run] ${path} (${content.length} bytes)`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(`${path}.pre-lienzo`)) copyFileSync(path, `${path}.pre-lienzo`);
  writeFileSync(path, content);
  console.log(`escrito ${path}`);
}

function applyTerminal() {
  const path = join(process.env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json');
  if (!existsSync(path)) {
    console.warn(`Windows Terminal no encontrado en ${path}: se omite`);
    return;
  }
  const settings = JSON.parse(readFileSync(path, 'utf8'));
  const c = theme.colors;
  const a = theme.ansi;
  const scheme = {
    name: 'Lienzo',
    background: c.background, foreground: c.onSurface, cursorColor: c.primary,
    selectionBackground: c.selection,
    black: c.surface, brightBlack: c.muted, white: c.onSurface, brightWhite: '#FFFFFF',
    red: a.red, green: a.green, yellow: a.yellow, blue: a.blue, purple: a.purple, cyan: a.cyan,
    brightRed: a.brightRed, brightGreen: a.brightGreen, brightYellow: a.brightYellow,
    brightBlue: a.brightBlue, brightPurple: a.brightPurple, brightCyan: a.brightCyan,
  };
  const schemes = (settings.schemes ?? []).filter((s) => s.name !== 'Lienzo');
  const gitBash = {
    guid: '{2ece5bfe-50ed-5f3a-ab87-5cd4baafed2b}',
    name: 'Git Bash',
    commandline: 'C:\\Program Files\\Git\\bin\\bash.exe -i -l',
    icon: 'C:\\Program Files\\Git\\mingw64\\share\\git\\git-for-windows.ico',
    startingDirectory: '%USERPROFILE%',
    hidden: false,
  };
  const list = settings.profiles.list.filter((p) => p.guid !== gitBash.guid);
  const next = {
    ...settings,
    schemes: [...schemes, scheme],
    theme: theme.isDark ? 'dark' : 'light',
    profiles: {
      ...settings.profiles,
      defaults: {
        ...settings.profiles.defaults,
        colorScheme: 'Lienzo',
        font: { face: theme.font.mono, size: theme.font.terminalSize },
        opacity: 92,
        useAcrylic: true,
        padding: '10',
        cursorShape: 'bar',
      },
      list: existsSync(gitBash.commandline.split(' -')[0]) ? [gitBash, ...list] : list,
    },
  };
  write(path, `${JSON.stringify(next, null, 4)}\n`);
}

function applyAccent() {
  const dword = toAbgrDword(theme.colors.primary);
  const cmds = [
    ['HKCU\\Software\\Microsoft\\Windows\\DWM', 'AccentColor', dword],
    ['HKCU\\Software\\Microsoft\\Windows\\DWM', 'ColorizationColor', toAbgrDword(theme.colors.primary, 0xc4)],
    ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent', 'AccentColorMenu', dword],
  ];
  const light = theme.isDark ? 0 : 1;
  cmds.push(['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'AppsUseLightTheme', light]);
  cmds.push(['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'SystemUsesLightTheme', light]);
  // Inicio, barra y buscador en negro neutro: el acento solo en bordes y controles.
  cmds.push(['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'ColorPrevalence', 0]);
  cmds.push(['HKCU\\Software\\Microsoft\\Windows\\DWM', 'ColorPrevalence', 0]);
  for (const [key, name, value] of cmds) {
    if (isDryRun) {
      console.log(`[dry-run] reg ${key} ${name}=0x${value.toString(16)}`);
      continue;
    }
    execFileSync('reg', ['add', key, '/v', name, '/t', 'REG_DWORD', '/d', String(value), '/f'], { stdio: 'ignore' });
  }
  if (!isDryRun) console.log(`acento ${theme.colors.primary} aplicado`);
}

console.log(`Preset: ${theme.label} (${theme.name})`);
applyTerminal();
applyAccent();

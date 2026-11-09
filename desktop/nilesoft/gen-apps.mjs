#!/usr/bin/env node
// Genera apps.local.nss (ignorado por git) con los submenús del clic derecho «Desarrollo», «Apps»,
// «Juegos», «Utilidades» y «Carpetas», a partir de los accesos directos del escritorio (también los que
// están dentro de sus carpetas), Blender y las apps de la Store indicadas.
//
// Uso: node gen-apps.mjs [--organizar]
//   --organizar  agrupa los accesos sueltos del escritorio en carpetas por categoría (estilo Android).
// Después: "C:\Program Files\Nilesoft Shell\shell.exe" -restart
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'apps.local.nss');
const DEV_EXES = /\\(Code|rider64|clion64|pycharm64|webstorm64|idea64|UnrealEditor|Unity Hub|blender)\.exe$/i;
const UTIL_EXES = /\\(HWMonitor|WinDirStat|windhawk|DS4Windows|SmowlCM|launch\.bat)(\.exe)?$/i;
const GAME_PATHS = /\\(GOG Games|steamapps)\\/i;
const NON_GAME_URLS = /^Wallpaper Engine$/i;
// Nada se queda suelto en el escritorio: también ULTRON va a su tarjeta (Apps).
const KEEP_ON_DESKTOP = /^$/;
// Carpetas estilo Android (escritorio/carpetas-android.ps1): sus accesos abren el panel de LienzoFolders.
const FOLDER_STORE = join(process.env.LOCALAPPDATA ?? '', 'Lienzo', 'Carpetas');
const isFolderLauncher = (sc) => /LienzoFolders.exe$/i.test(sc.target);
const SKIP_MENU = /^(Google Drive|SmowlCM|ULTRON Sessions)/i;
// Accesos con un GUID por nombre (p. ej. una captura añadida a una carpeta Lienzo): no son apps.
const GUID_NAME = /^\{?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?(\.\w+)?$/i;
const STORE_APPS = ['Spotify'];
const CATEGORIES = {
  dev: { folder: 'Desarrollo', glyph: '\\uE26E' },
  apps: { folder: 'Apps', glyph: '\\uE254' },
  juegos: { folder: 'Juegos', glyph: '\\uE1C9' },
  util: { folder: 'Utilidades', glyph: '\\uE15E' },
};
// Un menú demasiado grande hace que Nilesoft no llegue a abrirlo en el escritorio.
const MAX_FOLDER_ITEMS = 20;
const MAX_NESTED_ITEMS = 12;

function powershell(script) {
  // PowerShell 5.1 escribe en la página OEM: sin esto, «Enlace Móvil» llega como «Enlace M�vil».
  const utf8 = '[Console]::OutputEncoding = [Text.Encoding]::UTF8;';
  return execFileSync('powershell', ['-NoProfile', '-Command', utf8 + script], { encoding: 'utf8' });
}

function desktops() {
  const json = powershell(
    "[Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory') | ConvertTo-Json -Compress",
  );
  const [user, common] = JSON.parse(json);
  return { user, common };
}

function readShortcuts(dirs) {
  const list = dirs.map((d) => `'${d.replace(/'/g, "''")}'`).join(',');
  const script = `
    $sh = New-Object -Com WScript.Shell
    $out = foreach ($d in @(${list})) {
      Get-ChildItem $d -Include *.lnk, *.url -Recurse -Depth 1 -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Extension -eq '.lnk') {
          $s = $sh.CreateShortcut($_.FullName)
          [pscustomobject]@{ name = $_.BaseName; path = $_.FullName; target = $s.TargetPath; icon = '' }
        } else {
          $c = Get-Content $_.FullName
          [pscustomobject]@{ name = $_.BaseName; path = $_.FullName;
            target = (($c | Where-Object { $_ -like 'URL=*' }) -replace '^URL=', '');
            icon = (($c | Where-Object { $_ -like 'IconFile=*' }) -replace '^IconFile=', '') }
        }
      }
    }
    $out | ConvertTo-Json -Compress`;
  const raw = powershell(script).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function storeApps() {
  const list = STORE_APPS.map((n) => `'${n}'`).join(',');
  const json = powershell(`Get-StartApps | Where-Object { @(${list}) -contains $_.Name } | ConvertTo-Json -Compress`);
  if (!json.trim()) return [];
  const parsed = JSON.parse(json);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((a) => ({
    name: a.Name, target: `shell:AppsFolder\\${a.AppID}`, icon: '', isStore: true,
  }));
}

function blender() {
  const base = 'C:\\Program Files\\Blender Foundation';
  if (!existsSync(base)) return [];
  const versions = readdirSync(base).filter((d) => existsSync(join(base, d, 'blender.exe'))).sort();
  const last = versions.at(-1);
  return last ? [{ name: 'Blender', target: join(base, last, 'blender.exe'), icon: '' }] : [];
}

function classify(app) {
  if (app.target.startsWith('steam://')) return NON_GAME_URLS.test(app.name) ? 'apps' : 'juegos';
  if (GAME_PATHS.test(app.target)) return 'juegos';
  if (DEV_EXES.test(app.target)) return 'dev';
  if (UTIL_EXES.test(app.target)) return 'util';
  return 'apps';
}

const cleanName = (n) => n
  .replace(/\s+-\s+Acceso directo$/i, '')
  .replace(/\s+\d{4}(\.\d+)*$/, '')
  .replace(/^JetBrains\s+/, '');

/**
 * Mueve los accesos sueltos del escritorio del usuario a carpetas por categoría y copia los del escritorio
 * público (borrarlos de ahí requiere admin: se devuelven para que lo haga el lote elevado). Un acceso con
 * el mismo destino que otro ya colocado se elimina.
 */
function organize(shortcuts, desk) {
  const placedTargets = new Set();
  const publicToDelete = [];
  for (const sc of shortcuts) {
    const parent = dirname(sc.path);
    const isRoot = parent === desk.user || parent === desk.common;
    if (!isRoot || KEEP_ON_DESKTOP.test(sc.name) || isFolderLauncher(sc)) continue;
    const folder = join(FOLDER_STORE, CATEGORIES[classify(sc)].folder);
    mkdirSync(folder, { recursive: true });
    const dest = join(folder, basename(sc.path));
    const isDuplicate = placedTargets.has(sc.target) || existsSync(dest);
    placedTargets.add(sc.target);
    if (parent === desk.common) {
      if (!isDuplicate) copyFileSync(sc.path, dest);
      publicToDelete.push(sc.path);
    } else if (isDuplicate) {
      unlinkSync(sc.path);
    } else {
      renameSync(sc.path, dest);
    }
  }
  return publicToDelete;
}

// Nilesoft no admite escapar comillas: un texto con comilla simple va entre comillas dobles.
// Entre comillas dobles Nilesoft interpreta escapes, así que ahí se duplican las barras invertidas.
const lit = (s) => (s.includes("'") ? `"${s.replace(/"/g, '').replace(/\\/g, '\\\\')}"` : `'${s}'`);

function item(app) {
  if (app.isStore) {
    return `\titem(title=${lit(app.name)} image=[\\uE290, #1DB954] cmd='explorer.exe' args=${lit(app.target)})`;
  }
  if (app.target.startsWith('steam://')) {
    const image = app.icon ? `image=${lit(app.icon)}` : 'image=[\\uE1C9, #8AB4FF]';
    return `\titem(title=${lit(app.name)} ${image} cmd=${lit(app.target)})`;
  }
  return `\titem(title=${lit(app.name)} image cmd=${lit(app.target)})`;
}

function menu(title, glyph, apps) {
  if (apps.length === 0) return '';
  const body = apps.sort((a, b) => a.name.localeCompare(b.name, 'es')).map(item).join('\n');
  return `menu(type='desktop|back|taskbar' title='${title}' image=[${glyph}, #8AB4FF])\n{\n${body}\n}\n`;
}

function subdirs(dir, max = MAX_FOLDER_ITEMS) {
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.') && !n.startsWith('$'))
      .filter((n) => { try { return statSync(join(dir, n)).isDirectory(); } catch { return false; } })
      .sort((a, b) => a.localeCompare(b, 'es'))
      .slice(0, max);
  } catch {
    return [];
  }
}

/** Raíces del submenú «Carpetas»: Descargas, Documentos y las carpetas de primer nivel en MAYÚSCULAS. */
function folderRoots() {
  const home = homedir();
  const named = ['Downloads', 'Documents'].map((n) => join(home, n)).filter(existsSync);
  const upper = subdirs(home, Infinity).filter((n) => n === n.toUpperCase() && /[A-Z]/.test(n)).map((n) => join(home, n));
  return [...upper, ...named];
}

function folderMenu() {
  const open = (p) => `item(title='Abrir' image=icon.open_folder cmd=${lit(p)})`;
  const roots = folderRoots().map((root) => {
    const children = subdirs(root).map((child) => {
      const childPath = join(root, child);
      const isMain = basename(root) === basename(root).toUpperCase();
      const grand = (isMain ? subdirs(childPath, MAX_NESTED_ITEMS) : [])
        .map((g) => `\t\t\titem(title=${lit(g)} image=icon.folder cmd=${lit(join(childPath, g))})`);
      if (grand.length === 0) return `\t\titem(title=${lit(child)} image=icon.folder cmd=${lit(childPath)})`;
      return `\t\tmenu(title=${lit(child)} image=icon.folder)\n\t\t{\n\t\t\t${open(childPath)}\n\t\t\tsep\n${grand.join('\n')}\n\t\t}`;
    });
    return `\tmenu(title=${lit(basename(root))} image=icon.folder)\n\t{\n\t\t${open(root)}\n\t\tsep\n${children.join('\n')}\n\t}`;
  });
  return `menu(type='desktop|back' title='Carpetas' image=[\\uE1F6, #8AB4FF])\n{\n${roots.join('\n')}\n}\n`;
}

/** Entradas de las carpetas de LienzoDesk: añadir lo seleccionado a una carpeta o crear una nueva. */
function lienzoMenu() {
  const exe = join(process.env.LOCALAPPDATA ?? '', 'Lienzo', 'bin', 'LienzoDesk.exe');
  if (!existsSync(exe)) return '';
  return [
    `item(title='Añadir a carpeta…' type='file|dir|drive' mode='multiple' image=icon.new_folder cmd=${lit(exe)} args='--add @sel(true)')`,
    `item(title='Nueva carpeta Lienzo…' type='desktop|back' image=icon.new_folder cmd=${lit(exe)} args='--new-folder')`,
    '',
  ].join('\n');
}

const desk = desktops();
let shortcuts = readShortcuts([desk.user, desk.common, FOLDER_STORE]);
if (process.argv.includes('--organizar')) {
  const publicToDelete = organize(shortcuts, desk);
  writeFileSync(join(ROOT, 'public-desktop-to-delete.local.txt'), publicToDelete.join('\n'), 'utf8');
  console.log(`escritorio organizado; ${publicToDelete.length} accesos del escritorio público pendientes de borrar (admin)`);
  shortcuts = readShortcuts([desk.user, FOLDER_STORE]);
}

const seen = new Set();
const apps = [...shortcuts, ...blender(), ...storeApps()]
  .map((a) => ({ ...a, name: cleanName(a.name) }))
  .filter((a) => a.target && !SKIP_MENU.test(a.name) && !GUID_NAME.test(a.name) && !isFolderLauncher(a))
  .filter((a) => (seen.has(a.target) ? false : seen.add(a.target)));

const groups = { dev: [], apps: [], juegos: [], util: [] };
for (const app of apps) groups[classify(app)].push(app);

const content = [
  '// Generado por gen-apps.mjs desde los accesos directos del escritorio. No editar a mano.',
  ...Object.entries(CATEGORIES).map(([key, c]) => menu(c.folder, c.glyph, groups[key])),
  folderMenu(),
  lienzoMenu(),
].join('\n');
writeFileSync(OUT, content, 'utf8');
const counts = Object.entries(groups).map(([k, v]) => `${v.length} ${k}`).join(', ');
console.log(`apps.local.nss: ${counts}, ${folderRoots().length} raíces en Carpetas`);

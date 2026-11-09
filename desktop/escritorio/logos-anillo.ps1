# Logos ULTRON "Disco" (2026-10-28): disco negro a sangre con el aro en el borde, como el de Spotify,
# en vez del cuadrado redondeado con un aro pequeno dentro. Control Center con aro blanco cerrado y
# Sessions con aro naranja Claude abierto; U con serifa en el centro.
# Cada tamano del ICO se dibuja a su resolucion (16..256 px) con grosor minimo de aro: un ICO con una
# sola imagen de 256 px que Windows reduce a 30 px dejaba el aro en 1 px y roto.
# Genera en %LOCALAPPDATA%\Lienzo\icons los ICO y PNG de 1024 px y los asigna a los accesos del
# escritorio, del menu Inicio y al anclado de la barra. Con -Tauri escribe tambien los iconos de la app
# (src-tauri/icons) y el atlas de iniciales de las ventanas de Sessions. Sin admin.
param([switch]$Tauri)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $env:LOCALAPPDATA 'Lienzo\icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$ICO_SIZES = @(16, 20, 24, 30, 32, 36, 40, 48, 64, 96, 128, 256)
$WHITE = [System.Drawing.Color]::FromArgb(255, 0xF2, 0xF3, 0xF5)
$ORANGE = [System.Drawing.Color]::FromArgb(255, 0xD9, 0x77, 0x57)
$DISC = [System.Drawing.Color]::FromArgb(255, 0x05, 0x05, 0x07)

# Aro: 8 % del lado, nunca por debajo de 2 px (a 16 px sigue leyendose); pegado al borde del disco.
function Get-RingWidth([int]$size) { return [Math]::Max(2.0, $size * 0.08) }

function New-Logo([int]$size, [System.Drawing.Color]$ring, [bool]$open, [string]$text = 'U') {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush($DISC)), 0, 0, $size, $size)
  $w = Get-RingWidth $size
  $pen = New-Object System.Drawing.Pen($ring, $w)
  if ($open) { $pen.StartCap = 'Round'; $pen.EndCap = 'Round' }
  $box = New-Object System.Drawing.RectangleF(($w / 2), ($w / 2), ($size - $w), ($size - $w))
  if ($open) { $g.DrawArc($pen, $box, -60, 270) } else { $g.DrawEllipse($pen, $box) }
  # U: Georgia Bold al 62 % del lado (antes 47 %); trazada como ruta para que no la recorte el hinting.
  $glyph = New-Object System.Drawing.Drawing2D.GraphicsPath
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $family = New-Object System.Drawing.FontFamily('Georgia')
  $glyph.AddString($text, $family, [int][System.Drawing.FontStyle]::Bold, ($size * 0.62), (New-Object System.Drawing.RectangleF(0, ($size * 0.035), $size, $size)), $fmt)
  $g.FillPath((New-Object System.Drawing.SolidBrush($WHITE)), $glyph)
  # Por debajo de 32 px los trazos finos de Georgia se pierden: contorno de medio pixel.
  if ($size -le 32) { $g.DrawPath((New-Object System.Drawing.Pen($WHITE, 0.6)), $glyph) }
  $g.Dispose()
  return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  return , $ms.ToArray()
}

# ICO con una imagen PNG por tamano (ICONDIR + una ICONDIRENTRY por imagen).
function Save-Ico([System.Drawing.Color]$ring, [bool]$open, [string]$dest) {
  $images = @()
  foreach ($s in $ICO_SIZES) { $images += , (Get-PngBytes (New-Logo $s $ring $open)) }
  $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($dest))
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$ICO_SIZES.Count)
  $offset = 6 + 16 * $ICO_SIZES.Count
  for ($i = 0; $i -lt $ICO_SIZES.Count; $i++) {
    $s = $ICO_SIZES[$i]; $b = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$b); $bw.Write([byte]$b); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$images[$i].Length); $bw.Write([uint32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($img in $images) { $bw.Write($img) }
  $bw.Close()
}

function Set-LinkIcon($shell, [string]$path, [string]$ico) {
  if (-not (Test-Path $path)) { return }
  $l = $shell.CreateShortcut($path); $l.IconLocation = "$ico,0"; $l.Save()
  "  icono -> $path"
}

# El nombre del .ico lleva el diseno: Windows cachea los iconos por ruta.
$specs = @(
  @{ name = 'control-center-disco'; ring = $WHITE; open = $false; lnk = 'ULTRON Control Center.lnk' },
  @{ name = 'sessions-disco'; ring = $ORANGE; open = $true; lnk = 'ULTRON Sessions.lnk' }
)
$shell = New-Object -ComObject WScript.Shell
$places = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('Programs'),
  (Join-Path $env:LOCALAPPDATA 'Lienzo'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)
# Carpetas del escritorio de LienzoDesk (FolderStore): los accesos pueden estar en cualquiera.
$carpetas = Join-Path $env:LOCALAPPDATA 'Lienzo\Carpetas'
if (Test-Path $carpetas) { $places += @(Get-ChildItem $carpetas -Directory | ForEach-Object { $_.FullName }) }
foreach ($s in $specs) {
  (New-Logo 1024 $s.ring $s.open).Save((Join-Path $dir "$($s.name).png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $ico = Join-Path $dir "$($s.name).ico"
  Save-Ico $s.ring $s.open $ico
  "logo: $ico"
  foreach ($p in $places) { Set-LinkIcon $shell (Join-Path $p $s.lnk) $ico }
}

if ($Tauri) {
  $icons = Join-Path $PSScriptRoot '..\..\control-center\src-tauri\icons' | Resolve-Path
  Save-Ico $WHITE $false (Join-Path $icons 'icon.ico')
  foreach ($p in @(@{ f = '32x32.png'; s = 32 }, @{ f = '64x64.png'; s = 64 }, @{ f = '128x128.png'; s = 128 },
      @{ f = '128x128@2x.png'; s = 256 }, @{ f = 'icon.png'; s = 512 })) {
    (New-Logo $p.s $WHITE $false).Save((Join-Path $icons $p.f), [System.Drawing.Imaging.ImageFormat]::Png)
  }
  "tauri: $icons (icon.icns se regenera con: npx tauri icon $dir\control-center-disco.png)"

  # Atlas de iniciales (A-Z y 0-9) para las ventanas de Sessions (sesiones/ventana_icono.rs): una fila de
  # celdas de 64 px, blanco sobre transparente; el Rust lo usa como mascara alfa.
  $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  $cell = 64
  $atlas = New-Object System.Drawing.Bitmap(($cell * $chars.Length), $cell, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($atlas)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $family = New-Object System.Drawing.FontFamily('Georgia')
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  for ($i = 0; $i -lt $chars.Length; $i++) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddString([string]$chars[$i], $family, [int][System.Drawing.FontStyle]::Bold, ($cell * 0.62), (New-Object System.Drawing.RectangleF(($i * $cell), ($cell * 0.035), $cell, $cell)), $fmt)
    $g.FillPath((New-Object System.Drawing.SolidBrush($WHITE)), $path)
  }
  $g.Dispose()
  $dest = Join-Path $PSScriptRoot '..\..\control-center\src-tauri\src\sesiones\iniciales.png'
  $atlas.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  "atlas: $dest"
}

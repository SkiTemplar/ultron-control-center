# Iconos de carpeta estilo Android: cuadricula 2x2 con los iconos de las primeras apps de cada carpeta,
# sobre un cuadrado redondeado con la paleta Noche. Escribe folder.ico + desktop.ini en cada carpeta.
# Uso: folder-icons.ps1 -Folders <ruta1>,<ruta2>...   (sin admin)
param([Parameter(Mandatory = $true)][string[]]$Folders)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Lienzo -Name Native -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern uint PrivateExtractIcons(string file, int index, int cx, int cy, IntPtr[] icons, uint[] ids, uint count, uint flags);
[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
'@

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class FolderIcon {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct SHFOLDERCUSTOMSETTINGS {
    public uint dwSize; public uint dwMask; public IntPtr pvid; public string pszWebViewTemplate; public uint cchWebViewTemplate;
    public string pszWebViewTemplateVersion; public string pszInfoTip; public uint cchInfoTip; public IntPtr pclsid; public uint dwFlags;
    public string pszIconFile; public uint cchIconFile; public int iIconIndex; public string pszLogo; public uint cchLogo; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetSetFolderCustomSettings(ref SHFOLDERCUSTOMSETTINGS pfcs, string pszPath, uint dwReadWrite);
  // FCSM_ICONFILE = 0x10, FCS_FORCEWRITE = 2
  public static int Set(string folder, string ico) {
    var s = new SHFOLDERCUSTOMSETTINGS(); s.dwSize = (uint)Marshal.SizeOf(s); s.dwMask = 0x10; s.pszIconFile = ico;
    return SHGetSetFolderCustomSettings(ref s, folder, 2); } }
'@

$SIZE = 256
$shell = New-Object -ComObject WScript.Shell

function Get-IconSource([string]$path) {
  if ($path -like '*.url') {
    $line = Get-Content $path | Where-Object { $_ -like 'IconFile=*' } | Select-Object -First 1
    if ($line) { return @(($line -replace '^IconFile=', ''), 0) }
    return $null
  }
  $lnk = $shell.CreateShortcut($path)
  $loc = $lnk.IconLocation
  if ($loc -and -not $loc.StartsWith(',')) {
    $parts = $loc -split ','
    $file = [Environment]::ExpandEnvironmentVariables($parts[0])
    if (Test-Path $file) { return @($file, [int]$parts[-1]) }
  }
  return @($lnk.TargetPath, 0)
}

function Get-IconBitmap([string]$file, [int]$index, [int]$px) {
  $handles = New-Object IntPtr[] 1
  $ids = New-Object uint32[] 1
  $n = [Lienzo.Native]::PrivateExtractIcons($file, $index, $px, $px, $handles, $ids, 1, 0)
  if ($n -lt 1 -or $handles[0] -eq [IntPtr]::Zero) { return $null }
  $bmp = [System.Drawing.Icon]::FromHandle($handles[0]).ToBitmap()
  [void][Lienzo.Native]::DestroyIcon($handles[0])
  return $bmp
}

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90)
  $p.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
  $p.AddArc($x + $w - 2 * $r, $y + $h - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $p.AddArc($x, $y + $h - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $p.CloseFigure()
  return $p
}

function Save-PngAsIco([System.Drawing.Bitmap]$bmp, [string]$dest) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $fs = [System.IO.File]::Create($dest)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]1)
  $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$png.Length); $bw.Write([uint32]22)
  $bw.Write($png)
  $bw.Close()
}

foreach ($folder in $Folders) {
  $items = Get-ChildItem $folder -Include *.lnk, *.url -Recurse -Depth 0 | Sort-Object Name | Select-Object -First 4
  $canvas = New-Object System.Drawing.Bitmap($SIZE, $SIZE)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $bg = New-RoundedPath 8 8 ($SIZE - 16) ($SIZE - 16) 56
  $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(240, 0x1B, 0x1D, 0x24))), $bg)
  $g.DrawPath((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(170, 0x8A, 0xB4, 0xFF), 6)), $bg)
  $cell = 84; $gap = 20; $start = ($SIZE - (2 * $cell + $gap)) / 2
  $i = 0
  foreach ($it in $items) {
    $src = Get-IconSource $it.FullName
    if (-not $src) { continue }
    $icon = Get-IconBitmap $src[0] $src[1] 256
    if (-not $icon) { continue }
    $x = $start + ($i % 2) * ($cell + $gap)
    $y = $start + [math]::Floor($i / 2) * ($cell + $gap)
    $g.DrawImage($icon, [float]$x, [float]$y, [float]$cell, [float]$cell)
    $icon.Dispose()
    $i++
  }
  $g.Dispose()
  $ico = Join-Path $folder 'folder.ico'
  if (Test-Path $ico) { attrib -h -s $ico | Out-Null }
  Save-PngAsIco $canvas $ico
  $canvas.Dispose()
  $ini = Join-Path $folder 'desktop.ini'
  if (Test-Path $ini) { attrib -h -s $ini | Out-Null }
  Set-Content $ini "[.ShellClassInfo]`r`nIconResource=$ico,0`r`n[ViewState]`r`nMode=`r`nVid=`r`nFolderType=Generic" -Encoding Unicode
  attrib +h +s $ini | Out-Null
  attrib +h $ico | Out-Null
  attrib +r $folder | Out-Null
  # Escribir desktop.ini no basta: el Explorador solo refresca el icono si se aplica con la API del shell.
  [void][FolderIcon]::Set($folder, $ico)
  "icono: $folder ($i apps)"
}

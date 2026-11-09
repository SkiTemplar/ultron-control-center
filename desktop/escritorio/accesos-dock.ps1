# Accesos propios del dock para que "Apagado" vaya el primero (Windows no deja anclar nada antes de la lupa
# ni de Vista de tareas nativas): "Buscar" (LienzoDesk.exe --search = Win+S) y "Vistas" (--taskview =
# Win+Tab). Cada uno pulsa la tecla y sale, sin cargar WPF ni quedarse en memoria. Crea los iconos y los
# accesos en %LOCALAPPDATA%\Lienzo con AppUserModelID propio (si no, se agruparian con "Apagado", mismo .exe),
# los copia al escritorio para anclarlos (clic derecho > Mostrar mas opciones > Anclar a la barra de tareas;
# luego arrastrarlos tras Apagado), actualiza el icono de las copias ya ancladas y oculta los botones nativos.
# Sin admin.
$ErrorActionPreference = 'Stop'
$lienzo = Join-Path $env:LOCALAPPDATA 'Lienzo'
$exe = Join-Path $lienzo 'bin\LienzoDesk.exe'
if (-not (Test-Path $exe)) { throw "falta $exe (dotnet publish de desktop\lienzo-desk)" }
$icons = Join-Path $lienzo 'icons'
New-Item -ItemType Directory -Force -Path $icons | Out-Null

# Icono: cuadrado redondeado casi negro con un glifo de Segoe Fluent Icons en blanco, como el de Apagado.
# Glifo de 190 px con trazo engrosado (7 px), del tamano y grosor del de Apagado; a 112 px se veia pequeno.
Add-Type -AssemblyName System.Drawing
function New-GlyphIcon([int]$glyph, [string]$ico) {
  $size = 256
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 56
  $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($size - $r, 0, $r, $r, 270, 90)
  $path.AddArc($size - $r, $size - $r, $r, $r, 0, 90); $path.AddArc(0, $size - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 11, 12, 15))), $path)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = 'Center'; $format.LineAlignment = 'Center'
  $glyphPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $family = New-Object System.Drawing.FontFamily 'Segoe Fluent Icons'
  $glyphPath.AddString([string][char]$glyph, $family, 0, 190, (New-Object System.Drawing.RectangleF 0, 10, $size, $size), $format)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 242, 243, 245)), 7
  $pen.LineJoin = 'Round'
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 242, 243, 245))), $glyphPath)
  $g.DrawPath($pen, $glyphPath)
  $png = New-Object System.IO.MemoryStream
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $png.ToArray()
  # ICO con una sola imagen PNG de 256 px (cabecera ICONDIR + ICONDIRENTRY).
  $w = New-Object System.IO.BinaryWriter ([System.IO.File]::Create($ico))
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$bytes.Length); $w.Write([uint32]22)
  $w.Write($bytes); $w.Close()
}

# Acceso directo con AppUserModelID propio (IPropertyStore, PKEY_AppUserModel_ID).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LinkAumid {
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out uint c); int GetAt(uint i, out PropKey k); int GetValue(ref PropKey k, out PropVariant v);
    int SetValue(ref PropKey k, ref PropVariant v); int Commit();
  }
  [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPersistFile {
    int GetClassID(out Guid g); [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m); void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool r);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f); void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
  }
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropKey { public Guid Fmtid; public uint Pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PropVariant { [FieldOffset(0)] public ushort Vt; [FieldOffset(8)] public IntPtr Ptr; }
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLink { }
  public static void Set(string lnk, string aumid) {
    var link = new ShellLink();
    ((IPersistFile)link).Load(lnk, 2);
    var key = new PropKey { Fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Pid = 5 };
    var value = new PropVariant { Vt = 31, Ptr = Marshal.StringToCoTaskMemUni(aumid) };
    var store = (IPropertyStore)link;
    Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
    Marshal.ThrowExceptionForHR(store.Commit());
    ((IPersistFile)link).Save(lnk, true);
    Marshal.FreeCoTaskMem(value.Ptr);
  }
}
'@
# El nombre del .ico cambia con el diseno: Windows cachea los iconos por ruta.
$accesos = @(
  @{ Name = 'Buscar'; Glyph = 0xE721; Args = '--search'; Aumid = 'Lienzo.Buscar'; Ico = 'buscar-3.ico'; Desc = 'Buscar en Windows' },
  @{ Name = 'Vistas'; Glyph = 0xE7C4; Args = '--taskview'; Aumid = 'Lienzo.Vistas'; Ico = 'vistas-2.ico'; Desc = 'Vista de tareas' }
)
$shell = New-Object -ComObject WScript.Shell
$pinned = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
foreach ($a in $accesos) {
  $ico = Join-Path $icons $a.Ico
  New-GlyphIcon $a.Glyph $ico
  $lnk = Join-Path $lienzo "$($a.Name).lnk"
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.Arguments = $a.Args
  $s.IconLocation = "$ico,0"
  $s.Description = $a.Desc
  $s.Save()
  [LinkAumid]::Set($lnk, $a.Aumid)
  # Ya anclado: se actualiza el icono de la copia anclada (la barra lee el .lnk de User Pinned, no el original).
  # Sin anclar: copia en el escritorio para anclarlo a mano.
  $pin = Join-Path $pinned "$($a.Name).lnk"
  if (Test-Path $pin) { $p = $shell.CreateShortcut($pin); $p.IconLocation = "$ico,0"; $p.Save() }
  else { Copy-Item $lnk ([Environment]::GetFolderPath('Desktop')) -Force }
  "OK $lnk (AUMID $($a.Aumid))"
}

# Lupa y Vista de tareas nativas fuera (ajustes de Windows; el Explorador los aplica al momento o al reiniciarse).
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Search' -Name SearchboxTaskbarMode -Value 0 -Type DWord
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name ShowTaskViewButton -Value 0 -Type DWord

# ULTRON Sessions anclado: mismo AppUserModelID que su ventana (ULTRON.Sessions) para que el acceso anclado y la
# ventana abierta sean un unico boton. control-center.exe --sesiones abre solo Sessions (o lo enfoca).
$cc = Join-Path $env:USERPROFILE '.ultron\control-center\src-tauri\target\release\control-center.exe'
$sessionsIco = Join-Path $icons 'sessions-disco.ico'
if ((Test-Path $cc) -and (Test-Path $sessionsIco)) {
  $lnk = Join-Path $lienzo 'ULTRON Sessions.lnk'
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $cc
  $s.Arguments = '--sesiones'
  $s.IconLocation = "$sessionsIco,0"
  $s.Description = 'ULTRON Sessions'
  $s.Save()
  [LinkAumid]::Set($lnk, 'ULTRON.Sessions')
  Copy-Item $lnk ([Environment]::GetFolderPath('Desktop')) -Force
  # Al anclar la ventana abierta, Windows busca en el menu Inicio un acceso con su AppUserModelID; sin el,
  # ancla el .exe a secas (que abre el Control Center, no Sessions).
  Copy-Item $lnk ([Environment]::GetFolderPath('Programs')) -Force
  "OK $lnk (AUMID ULTRON.Sessions)"
} else { "AVISO: falta $cc o $sessionsIco; sin acceso de Sessions" }

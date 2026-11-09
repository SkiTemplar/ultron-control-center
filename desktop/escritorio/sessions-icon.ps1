# Icono de ULTRON Sessions con la paleta Noche: bocadillo de chat azul con una U, sobre un cuadrado
# redondeado oscuro con borde azul. Lo asigna al acceso directo indicado. Sin admin.
# Uso: sessions-icon.ps1 -Shortcut <ruta .lnk>
param([Parameter(Mandatory = $true)][string]$Shortcut)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$SIZE = 256
$out = Join-Path $env:LOCALAPPDATA 'Lienzo\icons\sessions.ico'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90)
  $p.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
  $p.AddArc($x + $w - 2 * $r, $y + $h - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $p.AddArc($x, $y + $h - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $p.CloseFigure()
  return $p
}

$bmp = New-Object System.Drawing.Bitmap($SIZE, $SIZE)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$blue = [System.Drawing.Color]::FromArgb(255, 0x8A, 0xB4, 0xFF)
$dark = [System.Drawing.Color]::FromArgb(255, 0x0E, 0x0F, 0x13)

$bg = New-RoundedPath 8 8 ($SIZE - 16) ($SIZE - 16) 56
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point(0, 0)), (New-Object System.Drawing.Point(0, $SIZE)),
  [System.Drawing.Color]::FromArgb(255, 0x23, 0x27, 0x33), $dark)
$g.FillPath($grad, $bg)
$g.DrawPath((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(190, 0x8A, 0xB4, 0xFF), 6)), $bg)

# Bocadillo: rectangulo redondeado con cola abajo a la izquierda.
$bubble = New-RoundedPath 52 58 152 112 34
$tail = New-Object System.Drawing.Drawing2D.GraphicsPath
$tail.AddPolygon([System.Drawing.PointF[]]@((New-Object System.Drawing.PointF(76, 160)), (New-Object System.Drawing.PointF(66, 202)), (New-Object System.Drawing.PointF(114, 166))))
$g.FillPath((New-Object System.Drawing.SolidBrush($blue)), $bubble)
$g.FillPath((New-Object System.Drawing.SolidBrush($blue)), $tail)

$font = New-Object System.Drawing.Font('JetBrainsMono NF', 70, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
$g.DrawString('U', $font, (New-Object System.Drawing.SolidBrush($dark)), (New-Object System.Drawing.RectangleF(52, 54, 152, 116)), $fmt)
$g.Dispose()

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]1)
$bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)
$bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$png.Length); $bw.Write([uint32]22)
$bw.Write($png)
$bw.Close()
$bmp.Save(($out -replace '\.ico$', '.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($Shortcut)
$lnk.IconLocation = "$out,0"
$lnk.Save()
"icono: $out -> $Shortcut"

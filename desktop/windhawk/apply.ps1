# Instala y configura los mods de Windhawk con la paleta Noche de theme.json (requiere admin).
# Uso: apply.ps1 [-Only dock|dockanim|start|clock|explorer]
# -SettingsOnly: solo reescribe los ajustes (sin recompilar ni reiniciar Windhawk); despues hay que
# reiniciar el Explorador. Recargar mods en caliente tumba explorer.exe (0xc0000005) en la build 26300.
param([string]$Only = '', [switch]$SettingsOnly)

$bg = '#0E0F13'
# "Halo glass" del dock, la bandeja y su desplegable: desenfoque fuerte (WindhawkBlur) tintado de negro y un
# filo de luz blanco que se apaga hacia abajo, igual que las tarjetas de LienzoDesk.
$glass = "<WindhawkBlur BlurAmount=`"40`" TintColor=`"#05060A`" TintOpacity=`"0.62`" FallbackColor=`"$bg`" />"
$halo = '<LinearGradientBrush StartPoint="0,0" EndPoint="0,1"><GradientStop Offset="0" Color="#5CFFFFFF" /><GradientStop Offset="0.4" Color="#1AFFFFFF" /><GradientStop Offset="1" Color="#0FFFFFFF" /></LinearGradientBrush>'
$indicatorIdle = '#8E939E'
$explorerBg = '<SolidColorBrush Color="#0A0B0E" />'
# Ancho del reloj sin segundos (HH:mm) y con ellos (HH:mm:ss).
$clockShort = 55
$clockLong = 90

$mods = [ordered]@{
  dock = @{
    source = 'windows-11-taskbar-styler.wh.cpp'
    settings = @{
      'theme' = 'DockLike'
      'clickThroughTaskbar' = 0
      # TranslucentTB y otros consumidores de XAML Diagnostics se bloquean sin preguntar: con el aviso
      # pendiente el mod no aplica los estilos y el dock sale sin transparencia en ese monitor.
      'xamlDiagnosticsHandling' = 'block'
      # "Halo glass": desenfoque fuerte tintado de negro y filo de luz blanco arriba (como las tarjetas).
      'controlStyles[0].target' = 'Taskbar.TaskbarFrame > Grid#RootGrid'
      'controlStyles[0].styles[0]' = "Background:=$glass"
      'controlStyles[0].styles[1]' = "BorderBrush:=$halo"
      'controlStyles[0].styles[2]' = 'BorderThickness=1'
      'controlStyles[0].styles[3]' = 'CornerRadius=14'
      # Margen inferior 0: la pildora llega abajo y deja sitio al indicador entre el icono y el borde.
      'controlStyles[0].styles[4]' = 'Margin=0,3,0,0'
      # Hueco vacio al final de la pildora: zona para el clic derecho de la barra.
      'controlStyles[0].styles[5]' = 'Padding=6,0,56,0'
      'controlStyles[1].target' = 'StackPanel#SystemTrayFrameGrid, Grid#SystemTrayFrameGrid'
      'controlStyles[1].styles[0]' = "Background:=$glass"
      'controlStyles[1].styles[1]' = "BorderBrush:=$halo"
      'controlStyles[1].styles[2]' = 'BorderThickness=1'
      'controlStyles[1].styles[3]' = 'CornerRadius=14'
      'controlStyles[1].styles[4]' = 'Margin=0,3,4,0'
      'controlStyles[1].styles[5]' = 'Padding=8,0,8,0'
      'controlStyles[1].styles[6]' = 'BackgroundSizing=InnerBorderEdge'
      # Indicador de app abierta: gris si esta abierta sin foco, blanco y largo si es la activa.
      'controlStyles[2].target' = 'Grid#IconPanel@RunningIndicatorStates > Rectangle#RunningIndicator, Taskbar.TaskListLabeledButtonPanel@RunningIndicatorStates > Rectangle#RunningIndicator'
      'controlStyles[2].styles[0]' = "Fill=$indicatorIdle"
      'controlStyles[2].styles[1]' = 'Height=4'
      'controlStyles[2].styles[2]' = 'RadiusX=2'
      'controlStyles[2].styles[3]' = 'RadiusY=2'
      'controlStyles[2].styles[4]' = 'Width@InactiveRunningIndicator=12'
      'controlStyles[2].styles[5]' = 'Width@InactiveRunningIndicatorPointerOver=16'
      'controlStyles[2].styles[6]' = 'Width@ActiveRunningIndicator=22'
      'controlStyles[2].styles[7]' = 'Fill@ActiveRunningIndicator=#FFFFFF'
      'controlStyles[2].styles[8]' = 'Opacity=1'
      # Windows pisa Fill y Opacity en el estado "abierta"; se fuerzan ahi tambien.
      'controlStyles[2].styles[9]' = "Fill@InactiveRunningIndicator=$indicatorIdle"
      'controlStyles[2].styles[10]' = 'Opacity@InactiveRunningIndicator=1'
      'controlStyles[2].styles[11]' = 'Fill@InactiveRunningIndicatorPointerOver=#B9BDC7'
      # Indicador 2 px por debajo del icono y con aire hasta el borde: la pildora llega hasta abajo (margen 0).
      'controlStyles[2].styles[12]' = 'VerticalAlignment=Bottom'
      'controlStyles[2].styles[13]' = 'Margin=0,0,0,-2'
      # Reloj en una sola fila: hora y fecha una al lado de la otra.
      'controlStyles[3].target' = 'SystemTray.DateTimeIconContent > Grid > StackPanel'
      'controlStyles[3].styles[0]' = 'Orientation=Horizontal'
      'controlStyles[3].styles[1]' = 'Spacing=10'
      'controlStyles[3].styles[2]' = 'VerticalAlignment=Center'
      # La hora en JetBrainsMono queda alta respecto a la fecha: se baja un poco.
      'controlStyles[4].target' = 'TextBlock#TimeInnerTextBlock'
      'controlStyles[4].styles[0]' = 'Margin=0,3,0,0'
      'controlStyles[4].styles[1]' = 'VerticalAlignment=Center'
      # Desplegable de iconos ocultos (flechita junto al wifi) con el mismo cristal que el dock.
      'controlStyles[5].target' = 'Border#OverflowFlyoutBackgroundBorder'
      'controlStyles[5].styles[0]' = "Background:=$glass"
      'controlStyles[5].styles[1]' = "BorderBrush:=$halo"
      'controlStyles[5].styles[2]' = 'BorderThickness=1'
      'controlStyles[5].styles[3]' = 'CornerRadius=14'
      # Sin boton de Inicio (solo se usaba para apagar): lo sustituye el acceso "Apagado" de LienzoDesk.
      # La tecla Windows sigue abriendo el menu Inicio.
      'controlStyles[6].target' = 'Taskbar.ExperienceToggleButton#LaunchListButton[AutomationProperties.AutomationId=StartButton]'
      'controlStyles[6].styles[0]' = 'Visibility=Collapsed'
      # Segundos al pasar el raton por el reloj: la hora lleva segundos (TimeFormat del mod del reloj) pero
      # se recorta a HH:mm; con el raton encima se ve entera y los iconos de la bandeja se desplazan con
      # una transicion (RepositionThemeTransition) en vez de saltar. Ancho de JetBrainsMono 18 px: 10,8 por caracter.
      'controlStyles[7].target' = 'SystemTray.OmniButton#NotificationCenterButton > Grid@CommonStates > * > TextBlock#TimeInnerTextBlock'
      'controlStyles[7].styles[0]' = 'TextTrimming=Clip'
      'controlStyles[7].styles[1]' = "MaxWidth=$clockShort"
      'controlStyles[7].styles[2]' = "MaxWidth@PointerOver=$clockLong"
      'controlStyles[7].styles[3]' = "MaxWidth@Pressed=$clockLong"
      'controlStyles[8].target' = 'SystemTray.OmniButton#ControlCenterButton, SystemTray.NotificationAreaIcons, SystemTray.DateTimeIconContent > Grid > StackPanel > TextBlock#DateInnerTextBlock'
      'controlStyles[8].styles[0]' = 'Transitions:=<TransitionCollection><RepositionThemeTransition/></TransitionCollection>'
      # Apagado va a la izquierda de una lupa propia (escritorio/buscar.ps1): la nativa y Vista de tareas
      # se ocultan con los ajustes de Windows. Fondo de los botones oculto: sin gris al pasar el raton ni en la app activa
      # (el indicador blanco ya marca la activa). En unas builds el Border cuelga del panel y en otras de un Grid.
      'controlStyles[9].target' = 'Taskbar.TaskListButtonPanel > Border#BackgroundElement, Taskbar.TaskListButtonPanel > Grid > Border#BackgroundElement'
      'controlStyles[9].styles[0]' = 'Visibility=Collapsed'
      # Bandeja (wifi, volumen, reloj, campana, flecha de ocultos): sus botones tienen su propio fondo gris de hover.
      'controlStyles[10].target' = 'SystemTray.OmniButton > Grid > Border#BackgroundBorder, SystemTray.NotifyIconView > * > Border#BackgroundBorder'
      'controlStyles[10].styles[0]' = 'Visibility=Collapsed'
      # Desplegable de iconos ocultos (otra ventana): el gris puede venir del propio contenedor del icono.
      'controlStyles[11].target' = 'SystemTray.NotifyIconView@CommonStates > Grid#ContainerGrid'
      'controlStyles[11].styles[0]' = 'Background=Transparent'
      'controlStyles[11].styles[1]' = 'Background@PointerOver=Transparent'
      'controlStyles[11].styles[2]' = 'Background@Pressed=Transparent'
    }
  }
  # Animacion ligera al pasar el raton: los iconos crecen como en el dock de macOS.
  dockanim = @{
    source = 'taskbar-dock-animation.wh.cpp'
    settings = @{
      'AnimationType' = 0
      'MaxScale' = 112
      'EffectRadius' = 90
      # Sin rebote al dejar el raton quieto ni empuje de los iconos vecinos: solo crece, fluido.
      'DisableBounce' = 1
      'DisableVerticalBounce' = 1
      'SpacingFactor' = 0
      'LerpSpeed' = 25
    }
  }
  start = @{
    source = 'windows-11-start-menu-styler.wh.cpp'
    settings = @{
      'theme' = 'WindowGlass'
      # Tinte en #RRGGBB con opacidad aparte: con #AARRGGBB el blur de Windhawk lo leia mal y salia marron.
      'styleConstants[0]' = 'Glass=<WindhawkBlur BlurAmount="18" TintColor="#0E0F13" TintOpacity="0.9" />'
      'styleConstants[1]' = 'BorderBrush=<SolidColorBrush Color="#8AB4FF" Opacity="0.45" />'
      'styleConstants[2]' = 'BorderThickness=1'
      'styleConstants[3]' = 'CornerRadius=14'
      'styleConstants[4]' = 'SearchBoxRadius=12'
      'styleConstants[5]' = 'ElementCornerRadius=10'
      'styleConstants[6]' = 'HoverCornerRadius=8'
      # Fondo solido oscuro: el acrilico del sistema cogia el color del fondo de pantalla (salia marron).
      'styleConstants[7]' = 'Background=<SolidColorBrush Color="#16181E" Opacity="0.97" />'
      # Interior de la busqueda (pagina web de SearchHost): filas redondeadas, seleccion azul, titulos grises.
      'webContentStyles[0].target' = '.suggestion:not(.groupHeader)'
      'webContentStyles[0].styles[0]' = 'border-radius: 10px !important'
      'webContentStyles[1].target' = '.suggestion[aria-selected="true"], .suggestion:hover'
      'webContentStyles[1].styles[0]' = 'background: rgba(138,180,255,.16) !important'
      'webContentStyles[1].styles[1]' = 'box-shadow: inset 0 0 0 1px rgba(138,180,255,.45) !important'
      'webContentStyles[2].target' = '.groupTitle'
      'webContentStyles[2].styles[0]' = 'color: #9AA0AE !important'
      'webContentStyles[2].styles[1]' = 'font-weight: 600 !important'
      'webContentStyles[2].styles[2]' = 'letter-spacing: .02em !important'
      'webContentStyles[3].target' = '.cortanaFontIcon, .iconContent'
      'webContentStyles[3].styles[0]' = 'border-radius: 8px !important'
      'webContentStyles[4].target' = 'body, #root, #qfContainer, .rootContainer'
      'webContentStyles[4].styles[0]' = 'background: transparent !important'
    }
  }
  # 2026-10-27: con DateLocale, TimeFormat y un tooltip con %cpu%/%ram% hizo caer el Explorador
  # (0xc0000005) en la build 26300. Mas tarde se vio que el fallo lo causa recargar mods en caliente.
  # Diseno elegido: "Mono" (n.4 de previews/relojes.html): hora en JetBrainsMono bold blanca y, a su
  # derecha, el dia arriba y la fecha 27/10 debajo, en gris.
  # El mod no pasa el mes a mayusculas, por eso la fecha es numerica.
  clock = @{
    source = 'taskbar-clock-customization.wh.cpp'
    settings = @{
      'TopLine' = '%time%'
      # Con segundos: el taskbar-styler recorta la hora a HH:mm y la muestra entera al pasar el raton.
      'ShowSeconds' = 1
      'TimeFormat' = "HH':'mm':'ss"
      'BottomLine' = '%weekday%%newline%%date%'
      'WeekdayFormat' = 'custom'
      'WeekdayFormatCustom' = "DOM, LUN, MAR, MI$([char]0x00C9), JUE, VIE, S$([char]0x00C1)B"
      'DateFormat' = "dd'/'MM"
      'TimeStyle.FontFamily' = 'JetBrainsMono NF'
      'TimeStyle.FontWeight' = 'Bold'
      'TimeStyle.FontSize' = 18
      'TimeStyle.TextColor' = '#F2F3F5'
      'DateStyle.FontFamily' = 'JetBrainsMono NF'
      'DateStyle.FontWeight' = 'Medium'
      'DateStyle.FontSize' = 10
      'DateStyle.TextColor' = '#9AA0AE'
      'DateStyle.CharacterSpacing' = 0
      'TextSpacing' = 10
      'TimeStyle.TextAlignment' = 'Center'
      'DateStyle.TextAlignment' = 'Center'
    }
  }
  explorer = @{
    source = 'windows-11-file-explorer-styler.wh.cpp'
    # Muy oscuro y sin tema (2026-10-28: TintedGlass descartado): los mismos elementos que pintaba TintedGlass
    # (barra de comandos, navegacion, pestana activa, Inicio, Galeria, detalles) en negro casi puro y opaco.
    # La lista de archivos y el panel lateral no son XAML: siguen con el gris oscuro del modo oscuro de Windows.
    settings = @{
      'theme' = ''
      'xamlDiagnosticsHandling' = 'block'
      'controlStyles[0].target' = 'FileExplorerExtensions.CommandBarControl_Wave1 > Grid, Grid#CommandBarControlRootGrid'
      'controlStyles[0].styles[0]' = "Background:=$explorerBg"
      'controlStyles[0].styles[1]' = 'BorderThickness=0'
      'controlStyles[1].target' = 'CommandBar#FileExplorerCommandBar'
      'controlStyles[1].styles[0]' = 'Background=Transparent'
      'controlStyles[2].target' = 'Grid#NavigationBarControlGrid, Grid#HomeViewRootGrid, Grid#DetailsViewControlRootGrid, FileExplorerExtensions.GalleryViewControl#GalleryViewControl > Grid, Microsoft.UI.Xaml.Controls.Grid#GalleryRootGrid'
      'controlStyles[2].styles[0]' = "Background:=$explorerBg"
      'controlStyles[3].target' = 'TabViewItem > Grid#LayoutRoot > Canvas > Microsoft.UI.Xaml.Shapes.Path#SelectedBackgroundPath'
      'controlStyles[3].styles[0]' = "Fill:=$explorerBg"
    }
  }
}

$results = @()
foreach ($name in $mods.Keys) {
  if ($Only -and $Only -ne $name) { continue }
  if (-not $Only -and $mods[$name].optIn) { continue }
  $mod = $mods[$name]
  $log = Join-Path $PSScriptRoot "install-$name.log"
  & (Join-Path $PSScriptRoot 'install-mod.ps1') -Source (Join-Path $PSScriptRoot $mod.source) -Settings $mod.settings -Log $log -SettingsOnly:$SettingsOnly
  $results += "[$name] " + (Get-Content $log -Raw).Trim()
}
$results | Out-File (Join-Path $PSScriptRoot 'apply.log') -Encoding utf8
if (-not $SettingsOnly) {
  Start-Process 'C:\Program Files\Windhawk\windhawk.exe' -ArgumentList '-restart', '-tray-only' -Wait
}

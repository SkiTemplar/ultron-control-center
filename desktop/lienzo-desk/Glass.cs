using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace LienzoDesk;

/// <summary>
/// Estilo «halo glass» de Lienzo: cristal tintado de negro con un filo de luz arriba, a juego con el dock.
/// Todas las ventanas son transparentes y dibujan su propio cristal con degradados: el acrílico de DWM se
/// probó (2026-10-28) y en el proceso residente dejaba la ventana más grande que su contenido, una «×»
/// fantasma y un tinte marrón cogido del fondo; en la build 26300 además se aplana sin foco.
/// </summary>
public static class Glass
{
    public static readonly Brush Text = Freeze(new SolidColorBrush(Color.FromRgb(0xF4, 0xF5, 0xF7)));
    public static readonly Brush Muted = Freeze(new SolidColorBrush(Color.FromArgb(0x99, 0xF4, 0xF5, 0xF7)));
    public static readonly Brush Hover = Freeze(new SolidColorBrush(Color.FromArgb(0x1A, 0xFF, 0xFF, 0xFF)));
    public static readonly Brush DangerHover = Freeze(new SolidColorBrush(Color.FromArgb(0x55, 0xE5, 0x5B, 0x4F)));
    public static readonly Brush Divider = Freeze(new SolidColorBrush(Color.FromArgb(0x1F, 0xFF, 0xFF, 0xFF)));

    /// <summary>Fondo de las ventanas emergentes: negro casi opaco y uniforme (sin desenfoque real, ver UsePopup).</summary>
    public static readonly Brush PopupTint = Freeze(new SolidColorBrush(Color.FromArgb(0xF0, 0x0E, 0x0F, 0x12)));

    /// <summary>Sombra suave de las ventanas emergentes (el panel lleva margen para que quepa).</summary>
    public static readonly System.Windows.Media.Effects.Effect PopupShadow = Freeze(new System.Windows.Media.Effects.DropShadowEffect
    {
        BlurRadius = 28, ShadowDepth = 6, Opacity = 0.55, Color = Colors.Black,
    });

    /// <summary>
    /// Relleno de las tarjetas plegadas: negro translúcido uniforme. Sin brillo lechoso arriba ni filo (a
    /// al usuario le parecían desenfoque y borde de app antigua): el fondo de pantalla se ve a través, limpio.
    /// </summary>
    public static readonly Brush CardFill = Freeze(new SolidColorBrush(Color.FromArgb(0x59, 0x0E, 0x0F, 0x12)));

    /// <summary>Panel de carpeta abierta: negro translúcido uniforme, sin degradado (se pidió muy transparente).</summary>
    public static readonly Brush PanelFill = Freeze(new SolidColorBrush(Color.FromArgb(0xA6, 0x0E, 0x0F, 0x12)));

    /// <summary>Filo de luz: más claro arriba y casi invisible abajo, como un cristal iluminado desde arriba.</summary>
    public static readonly Brush Halo = Freeze(new LinearGradientBrush(
        [new GradientStop(Color.FromArgb(0x5C, 0xFF, 0xFF, 0xFF), 0), new GradientStop(Color.FromArgb(0x1A, 0xFF, 0xFF, 0xFF), 0.35),
         new GradientStop(Color.FromArgb(0x0F, 0xFF, 0xFF, 0xFF), 1)], 90));

    /// <summary>Texto pequeño (≤ 14 px): la variante Text de Segoe UI Variable está dibujada para esos tamaños.</summary>
    public static readonly FontFamily UiFont = new("Segoe UI Variable Text");
    public static readonly FontFamily TitleFont = new("Segoe UI Variable Display");
    public static readonly FontFamily IconFont = new("Segoe Fluent Icons");

    private static readonly IEasingFunction EaseOut = Freeze(new CubicEase { EasingMode = EasingMode.EaseOut });

    private const uint MonitorDefaultToNearest = 2;
    private const uint SwpNoSize = 0x0001, SwpNoZOrder = 0x0004, SwpNoActivate = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Native.NativeRect Monitor;
        public Native.NativeRect Work;
        public uint Flags;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Native.NativePoint point, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    /// <summary>Ventana emergente sin marco y transparente: el panel de dentro dibuja el cristal y la sombra.</summary>
    public static void UsePopup(Window window)
    {
        window.WindowStyle = WindowStyle.None;
        window.AllowsTransparency = true;
        window.ResizeMode = ResizeMode.NoResize;
        window.Background = Brushes.Transparent;
        TextOptions.SetTextFormattingMode(window, TextFormattingMode.Display);
    }

    /// <summary>
    /// Coloca la ventana en el monitor donde está el cursor (no siempre en el principal): centrada en él o,
    /// con <paramref name="isAboveTaskbar"/>, encima de la barra y alineada con el cursor.
    /// Trabaja en píxeles físicos para no depender del DPI de cada monitor.
    /// </summary>
    public static void PlaceOnCursorMonitor(Window window, bool isAboveTaskbar)
    {
        Native.GetCursorPos(out var cursor);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(MonitorFromPoint(cursor, MonitorDefaultToNearest), ref info)) return;
        var hwnd = new WindowInteropHelper(window).Handle;
        // Primero se lleva al monitor: si su DPI es otro, WPF reescala la ventana y cambia su tamaño físico.
        SetWindowPos(hwnd, IntPtr.Zero, info.Work.Left, info.Work.Top, 0, 0, SwpNoSize | SwpNoZOrder | SwpNoActivate);
        if (!Native.GetWindowRect(hwnd, out var rect)) return;
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        var gap = (int)Math.Round(12 * VisualTreeHelper.GetDpi(window).DpiScaleY);
        var x = isAboveTaskbar ? cursor.X - width / 2 : (info.Work.Left + info.Work.Right - width) / 2;
        var y = isAboveTaskbar ? info.Work.Bottom - height - gap : (info.Work.Top + info.Work.Bottom - height) / 2;
        x = Math.Clamp(x, info.Work.Left + gap, Math.Max(info.Work.Left + gap, info.Work.Right - width - gap));
        SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, SwpNoSize | SwpNoZOrder | SwpNoActivate);
    }

    /// <summary>Zona de trabajo (sin barra de tareas) del monitor donde está la ventana, en píxeles lógicos.</summary>
    public static Rect WorkAreaOf(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(MonitorFromWindow(hwnd, MonitorDefaultToNearest), ref info)) return SystemParameters.WorkArea;
        var dpi = VisualTreeHelper.GetDpi(window);
        return new Rect(info.Work.Left / dpi.DpiScaleX, info.Work.Top / dpi.DpiScaleY,
            (info.Work.Right - info.Work.Left) / dpi.DpiScaleX, (info.Work.Bottom - info.Work.Top) / dpi.DpiScaleY);
    }

    /// <summary>Entrada suave: aparece desde transparente, un poco desplazada y algo más pequeña.</summary>
    public static void Enter(FrameworkElement element, double fromScale = 0.96, double fromY = 8, int delayMs = 0, int durationMs = 200)
    {
        var scale = new ScaleTransform(fromScale, fromScale);
        var shift = new TranslateTransform(0, fromY);
        element.RenderTransform = new TransformGroup { Children = { scale, shift } };
        element.Opacity = 0;
        var begin = TimeSpan.FromMilliseconds(delayMs);
        var duration = new Duration(TimeSpan.FromMilliseconds(durationMs));
        element.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(0, 1, duration) { BeginTime = begin, EasingFunction = EaseOut });
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(fromScale, 1, duration) { BeginTime = begin, EasingFunction = EaseOut });
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(fromScale, 1, duration) { BeginTime = begin, EasingFunction = EaseOut });
        shift.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(fromY, 0, duration) { BeginTime = begin, EasingFunction = EaseOut });
    }

    /// <summary>Salida rápida (desvanecer y encoger un poco); <paramref name="done"/> se llama al terminar.</summary>
    public static void Exit(FrameworkElement element, Action done, int durationMs = 80)
    {
        var scale = new ScaleTransform(1, 1);
        element.RenderTransform = scale;
        var duration = new Duration(TimeSpan.FromMilliseconds(durationMs));
        var fade = new DoubleAnimation(element.Opacity, 0, duration) { EasingFunction = EaseOut };
        fade.Completed += (_, _) => done();
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, new DoubleAnimation(1, 0.97, duration));
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, new DoubleAnimation(1, 0.97, duration));
        element.BeginAnimation(UIElement.OpacityProperty, fade);
    }

    /// <summary>Fila de menú: glifo + texto, resalte suave al pasar el ratón (rojizo si es destructiva).</summary>
    public static Border MenuRow(string glyph, string text, bool isDanger, Action onClick)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(new TextBlock { Text = glyph, FontFamily = IconFont, FontSize = 15, Foreground = Text, Opacity = 0.85, Width = 30, VerticalAlignment = VerticalAlignment.Center });
        row.Children.Add(new TextBlock { Text = text, FontFamily = UiFont, FontSize = 14, Foreground = Text, VerticalAlignment = VerticalAlignment.Center });
        var item = new Border { Child = row, Padding = new Thickness(12, 9, 18, 9), CornerRadius = new CornerRadius(8), Background = Brushes.Transparent, Cursor = System.Windows.Input.Cursors.Hand };
        item.MouseEnter += (_, _) => item.Background = isDanger ? DangerHover : Hover;
        item.MouseLeave += (_, _) => item.Background = Brushes.Transparent;
        item.MouseLeftButtonUp += (_, _) => onClick();
        return item;
    }

    public static T Freeze<T>(T freezable) where T : Freezable
    {
        freezable.Freeze();
        return freezable;
    }
}

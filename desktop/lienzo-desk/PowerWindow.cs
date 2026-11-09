using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace LienzoDesk;

/// <summary>
/// Menú de apagado con el estilo de Lienzo (sustituye al botón de Inicio), diseño «píldora de iconos»
/// (previews/apagado.html, n.º 2): una fila de botones redondos sobre la barra con bloquear, suspender, cerrar
/// sesión y, tras un separador, reiniciar y apagar. El nombre de cada acción sale encima al pasar el ratón.
/// Aparece sobre la barra del monitor donde se ha hecho clic, junto al cursor, y se cierra al pulsar fuera o con Esc.
/// </summary>
public sealed class PowerWindow : Window
{
    private const double ButtonSize = 40;
    private static readonly Brush ButtonHover = Glass.Freeze(new SolidColorBrush(Color.FromArgb(0x1F, 0xFF, 0xFF, 0xFF)));
    private static readonly Brush DangerHover = Glass.Freeze(new SolidColorBrush(Color.FromArgb(0x73, 0xE5, 0x5B, 0x4F)));
    private static readonly Brush LabelFill = Glass.Freeze(new SolidColorBrush(Color.FromArgb(0xF2, 0x0E, 0x0F, 0x12)));

    private readonly Grid _root = new();
    private readonly Canvas _labelLayer = new() { Height = 30, IsHitTestVisible = false };
    private readonly TextBlock _labelText = new() { FontFamily = Glass.UiFont, FontSize = 12, Foreground = Glass.Text };
    private readonly Border _label;
    private bool _wasActive;
    // Al cerrarse, la ventana pierde el foco y Deactivated volvía a llamar a Close(): la excepción tiraba el
    // proceso antes de ejecutar la acción (Apagar «no hacía nada»).
    private bool _isClosing;

    public PowerWindow()
    {
        Glass.UsePopup(this);
        SizeToContent = SizeToContent.WidthAndHeight;
        ShowInTaskbar = false;
        Topmost = true;
        Title = "Apagado";

        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(Action("\uE72E", "Bloquear", false, "rundll32.exe", "user32.dll,LockWorkStation"));
        row.Children.Add(Action("\uE708", "Suspender", false, "rundll32.exe", "powrprof.dll,SetSuspendState 0,1,0"));
        row.Children.Add(Action("\uF3B1", "Cerrar sesión", false, "shutdown.exe", "/l"));
        row.Children.Add(new Border { Width = 1, Margin = new Thickness(4, 9, 4, 9), Background = Glass.Divider });
        row.Children.Add(Action("\uE777", "Reiniciar", true, "shutdown.exe", "/r /t 0"));
        row.Children.Add(Action("\uE7E8", "Apagar", true, "shutdown.exe", "/s /t 0"));

        var pill = new Border
        {
            Background = Glass.PopupTint,
            BorderBrush = Glass.Halo,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(ButtonSize / 2 + 5),
            Effect = Glass.PopupShadow,
            Padding = new Thickness(5),
            Child = row,
        };
        _label = new Border
        {
            Background = LabelFill,
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(8, 3, 8, 4),
            Child = _labelText,
            Opacity = 0,
        };
        _labelLayer.Children.Add(_label);

        // Margen alrededor para la sombra y para que el nombre de los botones de los extremos quepa sin recortarse.
        _root.Margin = new Thickness(20, 0, 20, 14);
        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(pill, 1);
        _root.Children.Add(_labelLayer);
        _root.Children.Add(pill);
        Content = _root;

        KeyDown += (_, e) => { if (e.Key == Key.Escape) Close(); };
        Activated += (_, _) => _wasActive = true;
        Deactivated += (_, _) => { if (_wasActive && !_isClosing) Close(); };
        Closing += (_, _) => _isClosing = true;
        Loaded += (_, _) =>
        {
            Glass.PlaceOnCursorMonitor(this, isAboveTaskbar: true);
            Glass.Enter(pill, fromScale: 0.98, fromY: 6, durationMs: 100);
            Activate();
        };
    }

    private Border Action(string glyph, string text, bool isDanger, string exe, string args)
    {
        var button = new Border
        {
            Width = ButtonSize,
            Height = ButtonSize,
            Margin = new Thickness(2, 0, 2, 0),
            CornerRadius = new CornerRadius(ButtonSize / 2),
            Background = Brushes.Transparent,
            Cursor = Cursors.Hand,
            Child = new TextBlock
            {
                Text = glyph,
                FontFamily = Glass.IconFont,
                FontSize = 15,
                Foreground = Glass.Text,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
        button.MouseEnter += (_, _) =>
        {
            button.Background = isDanger ? DangerHover : ButtonHover;
            ShowLabel(button, text);
        };
        button.MouseLeave += (_, _) =>
        {
            button.Background = Brushes.Transparent;
            FadeLabel(0);
        };
        button.MouseLeftButtonUp += (_, _) => Run(text, exe, args);
        return button;
    }

    /// <summary>Coloca el nombre de la acción centrado encima de su botón y lo hace aparecer.</summary>
    private void ShowLabel(FrameworkElement button, string text)
    {
        _labelText.Text = text;
        _label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        var center = button.TranslatePoint(new Point(button.ActualWidth / 2, 0), _root).X;
        Canvas.SetLeft(_label, center - _label.DesiredSize.Width / 2);
        Canvas.SetTop(_label, 2);
        FadeLabel(1);
    }

    private void FadeLabel(double to) =>
        _label.BeginAnimation(OpacityProperty, new DoubleAnimation(to, TimeSpan.FromMilliseconds(120)));

    /// <summary>Lanza la acción y después cierra; si Windows la rechaza, lo dice en vez de cerrarse sin más.</summary>
    private void Run(string text, string exe, string args)
    {
        _isClosing = true;
        try
        {
            Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Hide();
            ConfirmWindow.Notify($"No se pudo {text.ToLowerInvariant()}", Launcher.Describe(ex));
        }
        Close();
    }
}

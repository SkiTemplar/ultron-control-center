using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace LienzoDesk;

/// <summary>
/// Diálogo de confirmación o aviso con el estilo de Lienzo (acrílico tintado de negro, filo de luz, botones
/// sobrios) en lugar del MessageBox de Windows. Aparece en el monitor del cursor. Enter confirma y Esc cancela.
/// </summary>
public sealed class ConfirmWindow : Window
{
    private static readonly Color Danger = Color.FromRgb(0xE5, 0x5B, 0x4F);
    private static readonly Color Warning = Color.FromRgb(0xF2, 0xB8, 0x4B);
    private static readonly Color Primary = Color.FromRgb(0x8A, 0xB4, 0xFF);

    private bool _result;

    private ConfirmWindow(string glyph, Color accent, string title, string message, string confirmText, string? cancelText, bool isDanger)
    {
        Glass.UsePopup(this);
        SizeToContent = SizeToContent.WidthAndHeight;
        ShowInTaskbar = false;
        Topmost = true;
        Title = title;

        var icon = new TextBlock
        {
            Text = glyph,
            FontFamily = Glass.IconFont,
            FontSize = 16,
            Foreground = Glass.Freeze(new SolidColorBrush(accent)),
            Margin = new Thickness(0, 3, 12, 0),
            VerticalAlignment = VerticalAlignment.Top,
        };
        var heading = new TextBlock
        {
            Text = title,
            Foreground = Glass.Text,
            FontFamily = Glass.TitleFont,
            FontSize = 16,
            FontWeight = FontWeights.SemiBold,
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 320,
        };
        var titleRow = new StackPanel { Orientation = Orientation.Horizontal };
        titleRow.Children.Add(icon);
        titleRow.Children.Add(heading);
        var body = new TextBlock
        {
            Text = message,
            Foreground = Glass.Muted,
            FontFamily = Glass.UiFont,
            FontSize = 13,
            LineHeight = 19,
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 348,
            Margin = new Thickness(28, 6, 0, 20),
        };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        if (cancelText is not null) buttons.Children.Add(Button(cancelText, null, () => Close()));
        buttons.Children.Add(Button(confirmText, cancelText is null ? null : isDanger ? Danger : Primary, () => { _result = true; Close(); }));

        var stack = new StackPanel();
        stack.Children.Add(titleRow);
        stack.Children.Add(body);
        stack.Children.Add(buttons);
        Content = new Border
        {
            Background = Glass.PopupTint,
            BorderBrush = Glass.Halo,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(14),
            Margin = new Thickness(18),
            Effect = Glass.PopupShadow,
            Padding = new Thickness(20, 18, 16, 16),
            MinWidth = 360,
            Child = stack,
        };
        KeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) Close();
            if (e.Key == Key.Enter) { _result = true; Close(); }
        };
        Loaded += (_, _) =>
        {
            Glass.PlaceOnCursorMonitor(this, isAboveTaskbar: false);
            Glass.Enter(stack, fromScale: 0.98, fromY: 4, durationMs: 100);
            Activate();
        };
    }

    /// <summary>Pide confirmación; true si se acepta.</summary>
    public static bool Ask(string title, string message, string confirmText, bool isDanger = false)
    {
        var window = new ConfirmWindow(isDanger ? "\uE74D" : "\uE897", isDanger ? Danger : Primary, title, message, confirmText, "Cancelar", isDanger);
        window.ShowDialog();
        return window._result;
    }

    /// <summary>Aviso con un solo botón, neutro: informa de un fallo sin alarmar.</summary>
    public static void Notify(string title, string message) =>
        new ConfirmWindow("\uE7BA", Warning, title, message, "Entendido", null, isDanger: false).ShowDialog();

    /// <summary>Botón rectangular redondeado: con color de acento si es la acción principal, translúcido si no.</summary>
    private static Border Button(string text, Color? fill, Action onClick)
    {
        var normal = Glass.Freeze(fill is { } f ? new SolidColorBrush(f) : new SolidColorBrush(Color.FromArgb(0x1F, 0xFF, 0xFF, 0xFF)));
        var hover = Glass.Freeze(fill is { } h ? new SolidColorBrush(Color.FromArgb(0xD9, h.R, h.G, h.B)) : new SolidColorBrush(Color.FromArgb(0x33, 0xFF, 0xFF, 0xFF)));
        var button = new Border
        {
            Background = normal,
            BorderBrush = fill is null ? Glass.Halo : Brushes.Transparent,
            BorderThickness = new Thickness(fill is null ? 1 : 0),
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(18, 7, 18, 8),
            Margin = new Thickness(8, 0, 0, 0),
            MinWidth = 96,
            Cursor = Cursors.Hand,
            Child = new TextBlock
            {
                Text = text,
                FontFamily = Glass.UiFont,
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                HorizontalAlignment = HorizontalAlignment.Center,
                Foreground = fill is null ? Glass.Text : Glass.Freeze(new SolidColorBrush(Color.FromRgb(0x0C, 0x0D, 0x10))),
            },
        };
        button.MouseEnter += (_, _) => button.Background = hover;
        button.MouseLeave += (_, _) => button.Background = normal;
        button.MouseLeftButtonUp += (_, _) => onClick();
        return button;
    }
}

using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace LienzoDesk;

/// <summary>
/// Selector "Añadir a carpeta" y diálogo "Nueva carpeta" con el estilo de las tarjetas. Aparece junto al cursor y
/// se cierra al elegir, con Esc o al pulsar fuera.
/// </summary>
public sealed class PickerWindow : Window
{
    private static readonly Brush TextBrush = Glass.Text;
    private static readonly Brush MutedBrush = Glass.Muted;
    private static readonly FontFamily UiFont = Glass.UiFont;

    private readonly IReadOnlyList<string> _items;
    private readonly StackPanel _list = new();
    private bool _isDone;
    private bool _isClosing;
    private readonly Func<string, string> _onName;
    private readonly string _initial;
    private bool _wasActive;

    /// <summary>Con <paramref name="newOnly"/> solo pide el nombre de una carpeta nueva.</summary>
    /// <summary>Pide un nombre con <paramref name="title"/> y llama a <paramref name="onName"/> al pulsar Enter.</summary>
    public PickerWindow(string title, Func<string, string> onName, string initial = "")
        : this([], newOnly: true, title, onName, initial)
    {
    }

    public PickerWindow(IReadOnlyList<string> items, bool newOnly, string? heading = null,
        Func<string, string>? onName = null, string initial = "")
    {
        _onName = onName ?? FolderStore.Create;
        _initial = initial;
        _items = items;
        Glass.UsePopup(this);
        SizeToContent = SizeToContent.WidthAndHeight;
        ShowInTaskbar = false;
        Topmost = true;
        WindowStartupLocation = WindowStartupLocation.Manual;

        var title = new TextBlock
        {
            Text = heading ?? (newOnly ? "Nueva carpeta" : items.Count == 1 ? $"Añadir «{Path.GetFileNameWithoutExtension(items[0])}» a…" : $"Añadir {items.Count} elementos a…"),
            Foreground = TextBrush,
            FontFamily = Glass.TitleFont,
            FontSize = 15,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(6, 0, 6, 10),
            MaxWidth = 300,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        _list.Children.Add(title);
        if (newOnly) ShowNameInput();
        else
        {
            foreach (var folder in FolderStore.Folders()) _list.Children.Add(Row("\uE8B7", Path.GetFileName(folder), () => Finish(folder)));
            _list.Children.Add(Row("\uE710", "Nueva carpeta…", ShowNameInput));
        }

        Content = new Border
        {
            Background = Glass.PopupTint,
            BorderBrush = Glass.Halo,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(14),
            Margin = new Thickness(18),
            Effect = Glass.PopupShadow,
            Padding = new Thickness(10, 12, 10, 10),
            MinWidth = 240,
            Child = _list,
        };
        KeyDown += (_, e) => { if (e.Key == Key.Escape) Close(); };
        // Solo se cierra al perder el foco si llegó a tenerlo (Windows puede negárselo al abrirse).
        Activated += (_, _) => _wasActive = true;
        // Al cerrarse pierde el foco: sin _isClosing, Deactivated llamaba otra vez a Close() y lanzaba una excepción.
        Deactivated += (_, _) => { if (_wasActive && !_isDone && !_isClosing) Close(); };
        Closing += (_, _) => _isClosing = true;
        Loaded += (_, _) =>
        {
            Glass.PlaceOnCursorMonitor(this, isAboveTaskbar: false);
            Glass.Enter(_list, fromScale: 0.98, fromY: 4, durationMs: 100);
            Activate();
        };
    }

    private static Border Row(string glyph, string text, Action onClick) => Glass.MenuRow(glyph, text, false, onClick);

    private void ShowNameInput()
    {
        while (_list.Children.Count > 1) _list.Children.RemoveAt(1);
        // Campo sencillo: caja redondeada gris muy oscura sin borde ni el azul de foco de WPF.
        var box = new TextBox
        {
            FontFamily = UiFont,
            FontSize = 14,
            Padding = new Thickness(0),
            Background = Brushes.Transparent,
            Foreground = TextBrush,
            CaretBrush = TextBrush,
            BorderThickness = new Thickness(0),
            FocusVisualStyle = null,
            MinWidth = 240,
            Text = _initial,
        };
        var field = new Border
        {
            Background = Frozen(new SolidColorBrush(Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF))),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12, 9, 12, 9),
            Child = box,
        };
        var hint = new TextBlock { Text = "Escribe el nombre y pulsa Enter", Foreground = MutedBrush, FontFamily = UiFont, FontSize = 11.5, Margin = new Thickness(4, 6, 0, 0) };
        box.KeyDown += (_, e) =>
        {
            if (e.Key != Key.Enter) return;
            try
            {
                Finish(_onName(box.Text));
            }
            catch (ArgumentException ex)
            {
                hint.Text = ex.Message;
            }
        };
        _list.Children.Add(field);
        _list.Children.Add(hint);
        Dispatcher.BeginInvoke(() => { Activate(); box.Focus(); Keyboard.Focus(box); });
    }

    private void Finish(string folder)
    {
        _isDone = true;
        FolderStore.AddItems(folder, _items);
        Close();
    }


    private static T Frozen<T>(T freezable) where T : Freezable
    {
        freezable.Freeze();
        return freezable;
    }
}

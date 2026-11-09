using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace LienzoDesk;

/// <summary>
/// Catálogo «Añadir apps» de una carpeta: se escribe parte del nombre, las flechas eligen y Enter (o un clic) añade
/// la app. Se queda abierto para añadir varias; se cierra con Esc o al pulsar fuera. Los iconos se cargan solo para
/// los resultados visibles.
/// </summary>
public sealed class CatalogWindow : Window
{
    private const int MaxResults = 8;
    private const double RowHeight = 40;
    private static CatalogWindow? _current;

    private readonly string _folder;
    private readonly IReadOnlyList<InstalledApp> _apps;
    private readonly HashSet<string> _present;
    private readonly Dictionary<string, BitmapSource?> _icons = new(StringComparer.OrdinalIgnoreCase);
    private readonly StackPanel _results = new();
    private readonly TextBox _box;
    private readonly TextBlock _hint;
    private IReadOnlyList<InstalledApp> _shown = [];
    private int _selected;
    private bool _isClosing;
    private bool _wasActive;

    /// <summary>Hay un catálogo abierto: el clic fuera de las tarjetas no debe plegar la carpeta que lo abrió.</summary>
    public static bool IsOpen => _current is not null;

    /// <summary>Abre el catálogo de la carpeta o, si ya hay uno abierto, lo trae al frente.</summary>
    public static void Open(string folder)
    {
        if (_current is not null)
        {
            _current.Activate();
            return;
        }
        _current = new CatalogWindow(folder);
        _current.Closed += (_, _) =>
        {
            _current = null;
            Native.TrimMemory();
            AppCatalog.RefreshInBackground();
        };
        _current.Show();
    }

    private CatalogWindow(string folder)
    {
        _folder = folder;
        _apps = AppCatalog.Cached;
        _present = Directory.EnumerateFiles(folder).Select(Path.GetFileNameWithoutExtension).OfType<string>()
            .ToHashSet(StringComparer.CurrentCultureIgnoreCase);
        Glass.UsePopup(this);
        SizeToContent = SizeToContent.WidthAndHeight;
        ShowInTaskbar = false;
        Topmost = true;
        WindowStartupLocation = WindowStartupLocation.Manual;

        var title = new TextBlock
        {
            Text = $"Añadir apps a «{Path.GetFileName(folder)}»",
            Foreground = Glass.Text,
            FontFamily = Glass.TitleFont,
            FontSize = 15,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(6, 0, 6, 10),
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        _box = new TextBox
        {
            FontFamily = Glass.UiFont,
            FontSize = 14,
            Padding = new Thickness(0),
            Background = Brushes.Transparent,
            Foreground = Glass.Text,
            CaretBrush = Glass.Text,
            BorderThickness = new Thickness(0),
            FocusVisualStyle = null,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var searchGlyph = new TextBlock
        {
            Text = "\uE721",
            FontFamily = Glass.IconFont,
            FontSize = 13,
            Foreground = Glass.Muted,
            Margin = new Thickness(0, 0, 10, 0),
            VerticalAlignment = VerticalAlignment.Center,
        };
        var fieldContent = new DockPanel();
        DockPanel.SetDock(searchGlyph, Dock.Left);
        fieldContent.Children.Add(searchGlyph);
        fieldContent.Children.Add(_box);
        var field = new Border
        {
            Background = Glass.Freeze(new SolidColorBrush(Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF))),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12, 9, 12, 9),
            Margin = new Thickness(0, 0, 0, 8),
            Child = fieldContent,
        };
        _hint = new TextBlock { Foreground = Glass.Muted, FontFamily = Glass.UiFont, FontSize = 11.5, Margin = new Thickness(4, 8, 0, 0) };

        var stack = new StackPanel { Width = 340 };
        stack.Children.Add(title);
        stack.Children.Add(field);
        stack.Children.Add(_results);
        stack.Children.Add(_hint);
        Content = new Border
        {
            Background = Glass.PopupTint,
            BorderBrush = Glass.Halo,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(14),
            Margin = new Thickness(18),
            Effect = Glass.PopupShadow,
            Padding = new Thickness(10, 12, 10, 10),
            Child = stack,
        };

        _box.TextChanged += (_, _) =>
        {
            _selected = 0;
            Refresh();
        };
        PreviewKeyDown += OnKey;
        Activated += (_, _) => _wasActive = true;
        Deactivated += (_, _) => { if (_wasActive && !_isClosing) Close(); };
        Closing += (_, _) => _isClosing = true;
        Loaded += (_, _) =>
        {
            Glass.PlaceOnCursorMonitor(this, isAboveTaskbar: false);
            Glass.Enter(stack, fromScale: 0.98, fromY: 4, durationMs: 100);
            Native.ForceForeground(this);
            Activate();
            _box.Focus();
            Keyboard.Focus(_box);
        };
        Refresh();
    }

    private void OnKey(object sender, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.Escape:
                Close();
                break;
            case Key.Down when _shown.Count > 0:
                _selected = (_selected + 1) % _shown.Count;
                Refresh();
                break;
            case Key.Up when _shown.Count > 0:
                _selected = (_selected - 1 + _shown.Count) % _shown.Count;
                Refresh();
                break;
            case Key.Enter when _shown.Count > 0:
                Add(_shown[_selected]);
                break;
            default:
                return;
        }
        e.Handled = true;
    }

    private void Refresh()
    {
        _shown = AppCatalog.Search(_apps, _box.Text, MaxResults);
        _selected = Math.Clamp(_selected, 0, Math.Max(0, _shown.Count - 1));
        _results.Children.Clear();
        for (var i = 0; i < _shown.Count; i++) _results.Children.Add(Row(_shown[i], i == _selected));
        _hint.Text = _box.Text.Trim().Length == 0
            ? $"Escribe para buscar entre {_apps.Count} apps instaladas"
            : _shown.Count == 0 ? "Ninguna app coincide" : "Enter o clic para añadir · Esc para cerrar";
    }

    private Border Row(InstalledApp app, bool isSelected)
    {
        var isPresent = _present.Contains(AppCatalog.LinkName(app));
        var icon = new Image { Source = IconOf(app), Width = 24, Height = 24, Margin = new Thickness(0, 0, 12, 0) };
        RenderOptions.SetBitmapScalingMode(icon, BitmapScalingMode.HighQuality);
        var name = new TextBlock
        {
            Text = app.Name,
            Foreground = isPresent ? Glass.Muted : Glass.Text,
            FontFamily = Glass.UiFont,
            FontSize = 13.5,
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };
        var state = new TextBlock
        {
            Text = isPresent ? "\uE73E" : "\uE710",
            FontFamily = Glass.IconFont,
            FontSize = 12,
            Foreground = Glass.Muted,
            VerticalAlignment = VerticalAlignment.Center,
            Opacity = isPresent || isSelected ? 1 : 0,
        };
        var content = new DockPanel { LastChildFill = true };
        DockPanel.SetDock(icon, Dock.Left);
        DockPanel.SetDock(state, Dock.Right);
        content.Children.Add(icon);
        content.Children.Add(state);
        content.Children.Add(name);
        var row = new Border
        {
            Height = RowHeight,
            Padding = new Thickness(8, 0, 10, 0),
            CornerRadius = new CornerRadius(8),
            Background = isSelected ? Glass.Hover : Brushes.Transparent,
            Cursor = Cursors.Hand,
            Child = content,
        };
        row.MouseEnter += (_, _) => { row.Background = Glass.Hover; state.Opacity = 1; };
        row.MouseLeave += (_, _) =>
        {
            row.Background = isSelected ? Glass.Hover : Brushes.Transparent;
            state.Opacity = isPresent || isSelected ? 1 : 0;
        };
        row.MouseLeftButtonUp += (_, _) => Add(app);
        return row;
    }

    private BitmapSource? IconOf(InstalledApp app)
    {
        if (!_icons.TryGetValue(app.Id, out var icon)) _icons[app.Id] = icon = AppCatalog.Icon(app, 32);
        return icon;
    }

    private void Add(InstalledApp app)
    {
        if (_present.Contains(AppCatalog.LinkName(app))) return;
        try
        {
            AppCatalog.AddTo(_folder, app);
            _present.Add(AppCatalog.LinkName(app));
            Refresh();
        }
        catch (Exception ex) when (ex is COMException or IOException or UnauthorizedAccessException)
        {
            _hint.Text = $"No se pudo añadir «{app.Name}»: {ex.Message}";
        }
    }
}

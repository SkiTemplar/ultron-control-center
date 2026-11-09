using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;

namespace LienzoDesk;

/// <summary>
/// Tarjeta fija en el escritorio con las apps de una carpeta: cristal negro translúcido, plano y sin borde.
/// Plegada: cuadrado con la cuadrícula de mini iconos y el nombre debajo. Abierta: panel por encima de las demás tarjetas con la rejilla de apps de un clic, que entra con una
/// animación corta. Clic pliega o despliega; arrastrar la mueve y la encaja en una rejilla de 16 px; soltar
/// archivos encima los añade; el lápiz abre la carpeta real.
/// </summary>
public sealed class FolderCard : Window
{
    /// <summary>Paso de la rejilla de colocación, en píxeles lógicos.</summary>
    public const double GridStep = 16;

    private static readonly Effect TextShadow = FreezeEffect(new DropShadowEffect
    {
        BlurRadius = 8, ShadowDepth = 1, Opacity = 0.85, Color = Colors.Black,
    });
    private static readonly IEasingFunction EaseOut = Glass.Freeze(new CubicEase { EasingMode = EasingMode.EaseOut });
    private const int Columns = 4;
    // Medidas en múltiplos de la rejilla (16 px) para que abiertas y plegadas encajen entre sí.
    private const double TileWidth = 96;
    private const double TileHeight = 112;
    private const double HeaderHeight = 40;
    private const double LabelLineHeight = 15;

    private readonly string _folder;
    private readonly DeskConfig _config;
    private readonly FileSystemWatcher _watcher;
    private readonly ContentControl _host = new();
    private bool _isCollapsed;
    // Posición de la carpeta plegada; abierta puede desplazarse para no salirse de la pantalla.
    private Point _home;

    public FolderCard(string folder, DeskConfig config, Point fallback)
    {
        _folder = folder;
        _config = config;
        _isCollapsed = config.Collapsed.Contains(FolderName);
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        ResizeMode = ResizeMode.NoResize;
        Background = Brushes.Transparent;
        ShowInTaskbar = false;
        ShowActivated = false;
        SizeToContent = SizeToContent.WidthAndHeight;
        AllowDrop = true;
        // Texto nítido a tamaños pequeños (las ventanas con transparencia no admiten ClearType).
        TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
        TextOptions.SetTextRenderingMode(this, TextRenderingMode.Grayscale);
        // A 125-150 % una posición en píxeles lógicos cae entre píxeles físicos: se redondea el diseño.
        UseLayoutRounding = true;
        var pos = config.Positions.TryGetValue(FolderName, out var p) && p.Length == 2 ? new Point(p[0], p[1]) : fallback;
        Left = Snap(pos.X);
        Top = Snap(pos.Y);
        _home = new Point(Left, Top);
        SizeChanged += (_, _) => { if (!_isCollapsed) FitOnScreen(); };
        Content = _host;
        Rebuild();

        _watcher = new FileSystemWatcher(folder) { NotifyFilter = NotifyFilters.FileName, EnableRaisingEvents = true };
        _watcher.Created += (_, _) => Dispatcher.BeginInvoke(Rebuild);
        _watcher.Deleted += (_, _) => Dispatcher.BeginInvoke(Rebuild);
        _watcher.Renamed += (_, _) => Dispatcher.BeginInvoke(Rebuild);
        SourceInitialized += (_, _) =>
        {
            Native.PinToDesktop(this);
            if (!_isCollapsed) Native.BringToTop(this);
            PlaceAtHome();
        };
        // El primer diseño (SizeToContent) y el anclaje al escritorio pueden dejar la ventana en el centro: se recoloca tras pintar.
        ContentRendered += (_, _) => PlaceAtHome();
        Activated += (_, _) => { if (_isCollapsed) Native.SendToBottom(this); };
        Drop += OnDrop;
        Closed += (_, _) => _watcher.Dispose();
    }

    /// <summary>Se dispara al plegar o desplegar (Program activa el cierre por clic fuera).</summary>
    public event Action? ExpandedChanged;

    public bool IsExpanded => !_isCollapsed;

    /// <summary>Pliega la carpeta si está abierta (clic fuera o tras abrir una app).</summary>
    public void Collapse()
    {
        if (!_isCollapsed) ToggleCollapsed();
    }

    /// <summary>Abre o pliega la carpeta (clic en el título o menú contextual).</summary>
    public void Toggle() => ToggleCollapsed();

    /// <summary>Sitúa la ventana en su posición guardada (plegada) o ya ajustada a la pantalla (abierta), también en el HWND.</summary>
    private void PlaceAtHome()
    {
        if (_isCollapsed) Place(_home.X, _home.Y);
        else FitOnScreen();
    }

    private void Place(double x, double y)
    {
        Left = x;
        Top = y;
        Native.MoveTo(this, x, y);
    }

    private string FolderName => Path.GetFileName(_folder);

    public static double Snap(double value) => Math.Round(value / GridStep) * GridStep;

    private void Rebuild()
    {
        var apps = Shortcuts.Load(_folder);
        _host.Content = _isCollapsed ? BuildFolded(apps) : BuildOpen(apps);
    }

    private void ToggleCollapsed()
    {
        _isCollapsed = !_isCollapsed;
        if (_isCollapsed) _config.Collapsed.Add(FolderName);
        else _config.Collapsed.Remove(FolderName);
        _config.Save();
        ExpandedChanged?.Invoke();

        if (_isCollapsed && _host.Content is FrameworkElement open)
        {
            // Sale el panel y, al terminar, vuelve la carpeta plegada al fondo.
            open.RenderTransformOrigin = new Point(0, 0);
            Glass.Exit(open, () =>
            {
                if (!_isCollapsed) return;
                Rebuild();
                Left = _home.X;
                Top = _home.Y;
                Native.SendToBottom(this);
                if (_host.Content is FrameworkElement folded) Glass.Enter(folded, fromScale: 0.9, fromY: 0, durationMs: 90);
            });
            return;
        }
        Rebuild();
        Native.BringToTop(this);
    }

    private Border BuildOpen(IReadOnlyList<Shortcut> apps)
    {
        var header = DragArea();
        header.Height = HeaderHeight;
        header.Margin = new Thickness(8, 0, 4, 4);
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.ColumnDefinitions.Add(new ColumnDefinition());
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var title = Label(FolderName, 16, Glass.Text, Glass.TitleFont);
        title.FontWeight = FontWeights.SemiBold;
        var count = Label(apps.Count == 1 ? "1 app" : $"{apps.Count} apps", 12, Glass.Muted, Glass.UiFont);
        count.Margin = new Thickness(10, 2, 0, 0);
        Grid.SetColumn(count, 1);
        var edit = Glyph("\uE70F", 13);
        edit.Opacity = 0;
        edit.Padding = new Thickness(8);
        edit.MouseLeftButtonUp += (_, e) => { e.Handled = true; Launcher.Open(_folder); };
        Grid.SetColumn(edit, 2);
        header.MouseEnter += (_, _) => Fade(edit, 0.75);
        header.MouseLeave += (_, _) => Fade(edit, 0);
        header.Children.Add(title);
        header.Children.Add(count);
        header.Children.Add(edit);

        var grid = new UniformGrid { Columns = Math.Clamp(apps.Count + 1, 1, Columns) };
        for (var i = 0; i < apps.Count; i++)
        {
            var tile = BuildTile(apps[i]);
            tile.RenderTransformOrigin = new Point(0.5, 0.5);
            grid.Children.Add(tile);
            Glass.Enter(tile, fromScale: 0.94, fromY: 4, delayMs: Math.Min(i * 6, 60), durationMs: 120);
        }
        grid.Children.Add(BuildAddTile());

        var stack = new StackPanel();
        stack.Children.Add(header);
        stack.Children.Add(grid);
        var panel = new Border
        {
            Background = Glass.PanelFill,
            CornerRadius = new CornerRadius(24),
            Padding = new Thickness(8, 8, 8, 12),
            Child = stack,
            RenderTransformOrigin = new Point(0, 0),
        };
        Glass.Enter(panel, fromScale: 0.96, fromY: 0, durationMs: 110);
        return panel;
    }

    /// <summary>Plegada: cuadrado de cristal con hasta 9 mini iconos en 3×3 y el nombre debajo.</summary>
    private Grid BuildFolded(IReadOnlyList<Shortcut> apps)
    {
        var area = DragArea();
        var minis = new UniformGrid { Columns = 3, Rows = 3, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        foreach (var app in apps.Take(9))
        {
            var icon = AppIcon(app, 21);
            icon.Margin = new Thickness(2.5);
            minis.Children.Add(icon);
        }
        var square = new Border
        {
            Width = 96,
            Height = 96,
            Background = Glass.CardFill,
            CornerRadius = new CornerRadius(24),
            Padding = new Thickness(10),
            Child = minis,
            // Crece desde el borde superior: la ventana se ajusta al contenido y por arriba no hay margen
            // (desde el centro se recortaba); a los lados y hacia el nombre sí sobra sitio.
            RenderTransformOrigin = new Point(0.5, 0),
            RenderTransform = new ScaleTransform(1, 1),
        };
        // Al pasar el ratón la carpeta crece un poco, como los iconos del dock.
        area.MouseEnter += (_, _) => Grow(square, 1.05);
        area.MouseLeave += (_, _) => Grow(square, 1);
        var stack = new StackPanel { Width = 112, Height = 128 };
        stack.Children.Add(square);
        stack.Children.Add(ShadowedName());
        area.Children.Add(stack);
        return area;
    }

    /// <summary>Zona que pliega o despliega con un clic y, si se arrastra, mueve la tarjeta y la encaja en la rejilla.</summary>
    private Grid DragArea()
    {
        var area = new Grid { Background = Brushes.Transparent, Cursor = Cursors.Hand };
        area.ContextMenuOpening += (_, _) => area.ContextMenu = AppMenu.BuildFolder(this, _folder, _config);
        area.ContextMenu = AppMenu.BuildFolder(this, _folder, _config);
        area.MouseLeftButtonDown += (_, e) =>
        {
            if (e.OriginalSource is TextBlock { Tag: "edit" }) return;
            var before = new Point(Left, Top);
            DragMove();
            if (Math.Abs(Left - before.X) + Math.Abs(Top - before.Y) < 3)
            {
                ToggleCollapsed();
                return;
            }
            Left = Snap(Left);
            Top = Snap(Top);
            _home = new Point(Left, Top);
            _config.Positions[FolderName] = [Left, Top];
            _config.Save();
        };
        return area;
    }

    /// <summary>
    /// Abierta cerca de un borde, la carpeta se abre hacia el lado que se ve: si el panel se saldría por la
    /// derecha o por abajo, se desplaza hacia la izquierda o hacia arriba (y la animación sale de esa esquina).
    /// </summary>
    private void FitOnScreen()
    {
        var area = Glass.WorkAreaOf(this);
        var x = _home.X;
        var y = _home.Y;
        var isShiftedX = x + ActualWidth > area.Right - GridStep;
        var isShiftedY = y + ActualHeight > area.Bottom - GridStep;
        if (isShiftedX) x = Math.Max(area.Left + GridStep, area.Right - GridStep - ActualWidth);
        if (isShiftedY) y = Math.Max(area.Top + GridStep, area.Bottom - GridStep - ActualHeight);
        Place(x, y);
        if (_host.Content is FrameworkElement panel) panel.RenderTransformOrigin = new Point(isShiftedX ? 1 : 0, isShiftedY ? 1 : 0);
    }

    /// <summary>
    /// Nombre de la carpeta con sombra. Un Effect convierte su elemento en un mapa de bits y el texto pierde el
    /// ajuste a píxel (se ve borroso): la sombra va en una copia detrás y el texto de delante queda sin efecto.
    /// </summary>
    private UIElement ShadowedName()
    {
        TextBlock Make()
        {
            var t = Label(FolderName, 13, Glass.Text, Glass.UiFont);
            t.FontWeight = FontWeights.SemiBold;
            t.HorizontalAlignment = HorizontalAlignment.Center;
            return t;
        }
        var shadow = Make();
        shadow.Effect = TextShadow;
        var grid = new Grid { Margin = new Thickness(0, 8, 0, 0), HorizontalAlignment = HorizontalAlignment.Center };
        grid.Children.Add(shadow);
        grid.Children.Add(Make());
        return grid;
    }

    private static TextBlock Label(string text, double size, Brush brush, FontFamily font) => new()
    {
        Text = text,
        Foreground = brush,
        FontFamily = font,
        FontSize = size,
        VerticalAlignment = VerticalAlignment.Center,
    };

    private static TextBlock Glyph(string glyph, double size) => new()
    {
        Text = glyph,
        Tag = "edit",
        FontFamily = Glass.IconFont,
        FontSize = size,
        Foreground = Glass.Text,
        Background = Brushes.Transparent,
        VerticalAlignment = VerticalAlignment.Center,
        Cursor = Cursors.Hand,
    };

    private static Image AppIcon(Shortcut app, double size)
    {
        var image = new Image { Source = app.Icon, Width = size, Height = size, Stretch = Stretch.Uniform };
        RenderOptions.SetBitmapScalingMode(image, BitmapScalingMode.HighQuality);
        return image;
    }

    private Border BuildTile(Shortcut app)
    {
        var icon = AppIcon(app, 44);
        var lift = new TranslateTransform();
        icon.RenderTransform = lift;
        var content = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
        content.Children.Add(icon);
        // Al pasar el ratón solo sube el icono, sin fondo gris.
        // Nombre en dos líneas como mucho: «Wallpaper Engine» o «ULTRON Sessions» caben enteros.
        var name = new TextBlock
        {
            Text = app.Name,
            Foreground = Glass.Text,
            FontFamily = Glass.UiFont,
            FontSize = 12,
            TextAlignment = TextAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
            TextTrimming = TextTrimming.CharacterEllipsis,
            LineHeight = LabelLineHeight,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            MaxHeight = LabelLineHeight * 2,
            Width = TileWidth - 12,
            Margin = new Thickness(0, 8, 0, 0),
        };
        content.Children.Add(name);
        var tile = new Border
        {
            Width = TileWidth,
            Height = TileHeight,
            Padding = new Thickness(0, 14, 0, 0),
            CornerRadius = new CornerRadius(14),
            Background = Brushes.Transparent,
            Cursor = Cursors.Hand,
            Child = content,
        };
        tile.MouseEnter += (_, _) =>
        {
            lift.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(-3, TimeSpan.FromMilliseconds(140)) { EasingFunction = EaseOut });
        };
        tile.MouseLeave += (_, _) =>
        {
            lift.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(0, TimeSpan.FromMilliseconds(180)) { EasingFunction = EaseOut });
        };
        tile.MouseLeftButtonUp += (_, _) => { Launcher.Open(app.Path); Collapse(); };
        tile.ContextMenu = AppMenu.Build(app, _folder);
        return tile;
    }

    /// <summary>Ficha «Añadir»: abre el catálogo de apps instaladas para esta carpeta.</summary>
    private Border BuildAddTile()
    {
        var circle = new Border
        {
            Width = 44,
            Height = 44,
            CornerRadius = new CornerRadius(22),
            Background = Glass.Hover,
            HorizontalAlignment = HorizontalAlignment.Center,
            Child = new TextBlock
            {
                Text = "\uE710",
                FontFamily = Glass.IconFont,
                FontSize = 18,
                Foreground = Glass.Muted,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };
        var content = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
        content.Children.Add(circle);
        var label = Label("Añadir", 12, Glass.Muted, Glass.UiFont);
        label.HorizontalAlignment = HorizontalAlignment.Center;
        label.Margin = new Thickness(0, 8, 0, 0);
        content.Children.Add(label);
        var tile = new Border
        {
            Width = TileWidth,
            Height = TileHeight,
            Padding = new Thickness(0, 14, 0, 0),
            Background = Brushes.Transparent,
            Cursor = Cursors.Hand,
            Child = content,
        };
        tile.MouseLeftButtonUp += (_, e) =>
        {
            e.Handled = true;
            CatalogWindow.Open(_folder);
        };
        return tile;
    }

    private static void Fade(UIElement element, double to) =>
        element.BeginAnimation(OpacityProperty, new DoubleAnimation(to, TimeSpan.FromMilliseconds(150)));

    private static void Grow(FrameworkElement element, double to)
    {
        var scale = (ScaleTransform)element.RenderTransform;
        var animation = new DoubleAnimation(to, TimeSpan.FromMilliseconds(160)) { EasingFunction = EaseOut };
        scale.BeginAnimation(ScaleTransform.ScaleXProperty, animation);
        scale.BeginAnimation(ScaleTransform.ScaleYProperty, animation);
    }

    /// <summary>Añade a la carpeta lo que se suelte encima (ver <see cref="FolderStore.AddItems"/>).</summary>
    private void OnDrop(object sender, DragEventArgs e)
    {
        if (e.Data.GetData(DataFormats.FileDrop) is string[] paths) FolderStore.AddItems(_folder, paths);
    }

    private static Effect FreezeEffect(Effect effect)
    {
        effect.Freeze();
        return effect;
    }
}

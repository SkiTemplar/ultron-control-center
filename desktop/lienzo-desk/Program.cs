using System.IO;
using System.Windows;
using System.Windows.Threading;

namespace LienzoDesk;

/// <summary>
/// Un solo proceso residente con una tarjeta por carpeta de %LOCALAPPDATA%\Lienzo\Carpetas. Instancia única.
/// Crear o borrar una carpeta ahí añade o quita su tarjeta en caliente. Si Windows mueve las tarjetas (monitor que
/// se apaga o reconecta, suspensión), las devuelve a su sitio y lo anota en desk-moves.log. Tras dibujar y cada pocos minutos
/// recorta su memoria para quedarse en lo mínimo. La del Explorador no se toca: recortarla no libera RAM (las
/// páginas pasan a la lista en espera) y cada clic derecho tardaba ~15 ms más en volver a cargarlas (medido el
/// 2026-10-28: 62 frente a 77 ms).
/// </summary>
public static class Program
{
    private const double Margin = 16;
    private const int WmDisplayChange = 0x007E, WmSettingChange = 0x001A, WmPowerBroadcast = 0x0218;
    private const int SpiSetWorkArea = 0x002F, PbtResumeAutomatic = 0x0012;
    // Tras un cambio de pantallas Windows recoloca las ventanas en ráfagas y a veces con segundos de retraso:
    // primera pasada al calmarse los avisos y una segunda por si el sistema las vuelve a mover.
    private static readonly TimeSpan[] RealignDelays = [TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(6)];
    private static readonly Dictionary<string, FolderCard> Cards = new(StringComparer.OrdinalIgnoreCase);
    private static readonly string MovesLog = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lienzo", "desk-moves.log");
    private static readonly DispatcherTimer Realign = new();
    private static string _realignReason = "";
    private static int _realignPass;
    private static DeskConfig _config = new();
    private static double _nextY;
    private static PowerWindow? _power;
    private static DateTime _powerClosedAt;

    [STAThread]
    public static int Main(string[] args)
    {
        // Acceso "Buscar" del dock: pulsa Win+S y sale, sin cargar WPF ni quedarse en memoria.
        if (args.Length > 0 && args[0] == "--search") return Native.PressWinKey(Native.VkS);
        // Acceso "Vistas": Win+Tab (Vista de tareas), igual de ligero.
        if (args.Length > 0 && args[0] == "--taskview") return Native.PressWinKey(Native.VkTab);
        // Acceso "Apagado": el menú lo abre el proceso residente, ya cargado, así que sale al instante (un proceso
        // WPF nuevo tardaba ~0,3 s más el primer pintado). Sin residente, se abre aquí como antes.
        if (args.Length > 0 && args[0] == "--power" && Native.PostToResident(Native.PowerMessage)) return 0;
        // "Añadir a carpeta…" y "Nueva carpeta Lienzo…" también los abre el residente: sin arrancar WPF aquí.
        if (args.Length > 0 && args[0] is "--add" or "--new-folder" && Native.SendToResident(string.Join('\n', args))) return 0;
        // Las ventanas emergentes van con DPI por monitor (nítidas y bien colocadas en cada pantalla). Las tarjetas
        // no: con PerMonitorV2, WPF dibuja las ventanas transparentes desplazadas respecto a su zona de clic.
        if (args.Length > 0 && args[0] is "--add" or "--new-folder" or "--power") Native.UsePerMonitorDpi();
        // Modo menú contextual: "--add <rutas>" abre el selector de carpeta; "--new-folder" pide el nombre.
        if (args.Length > 0 && args[0] is "--add" or "--new-folder") return RunPicker(args);
        if (args.Length > 0 && args[0] == "--power")
            return new Application { ShutdownMode = ShutdownMode.OnMainWindowClose }.Run(new PowerWindow());

        using var mutex = new Mutex(true, "Lienzo.Desk.SingleInstance", out var isFirst);
        if (!isFirst) return 0;

        var store = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lienzo", "Carpetas");
        Directory.CreateDirectory(store);

        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        // Un fallo inesperado se registra y no cierra el proceso: las tarjetas no deben desaparecer.
        var log = Path.Combine(Path.GetDirectoryName(store)!, "desk-errors.log");
        app.DispatcherUnhandledException += (_, e) =>
        {
            File.AppendAllText(log, $"{DateTime.Now:s} {e.Exception}{Environment.NewLine}");
            e.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            File.AppendAllText(log, $"{DateTime.Now:s} FATAL {e.ExceptionObject}{Environment.NewLine}");
        _config = DeskConfig.Load();
        _nextY = SystemParameters.WorkArea.Top + Margin;
        foreach (var folder in Directory.GetDirectories(store).Order(StringComparer.CurrentCultureIgnoreCase)) AddCard(folder);
        UpdateOutsideClick();

        using var watcher = new FileSystemWatcher(store) { NotifyFilter = NotifyFilters.DirectoryName, EnableRaisingEvents = true };
        watcher.Created += (_, e) => app.Dispatcher.BeginInvoke(() => AddCard(e.FullPath));
        watcher.Deleted += (_, e) => app.Dispatcher.BeginInvoke(() => RemoveCard(e.FullPath));
        watcher.Renamed += (_, e) => app.Dispatcher.BeginInvoke(() => { RemoveCard(e.OldFullPath); AddCard(e.FullPath); });

        // Si el Explorador se reinicia, el escritorio (Progman) se destruye y con él las tarjetas que posee.
        // Windows avisa a las ventanas de nivel superior con "TaskbarCreated": se vuelven a crear todas.
        var taskbarCreated = Native.RegisterWindowMessage("TaskbarCreated");
        var powerMessage = Native.RegisterWindowMessage(Native.PowerMessage);
        var listener = new System.Windows.Interop.HwndSource(new System.Windows.Interop.HwndSourceParameters(Native.ListenerTitle)
        {
            Width = 0, Height = 0, WindowStyle = 0, ExtendedWindowStyle = 0x80,
        });
        listener.AddHook((IntPtr hwnd, int msg, IntPtr w, IntPtr l, ref bool handled) =>
        {
            if (msg == taskbarCreated) app.Dispatcher.BeginInvoke(DispatcherPriority.Background, () => RecreateAll(store));
            if (msg == powerMessage) app.Dispatcher.BeginInvoke(TogglePower);
            if (RealignReason(msg, w) is { } reason) ScheduleRealign(reason);
            if (Native.ReadResidentText(msg, l) is { } text)
            {
                handled = true;
                app.Dispatcher.BeginInvoke(() => OpenPicker(text.Split('\n')));
                return new IntPtr(1);
            }
            return IntPtr.Zero;
        });

        Realign.Tick += (_, _) => RealignTick();

        var trim = new DispatcherTimer { Interval = TimeSpan.FromMinutes(3) };
        trim.Tick += (_, _) => Native.TrimMemory();

        trim.Start();
        app.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, Native.TrimMemory);
        app.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, AppCatalog.RefreshInBackground);
        return app.Run();
    }

    /// <summary>Avisos del sistema tras los que Windows puede haber movido las tarjetas; null si el mensaje no lo es.</summary>
    private static string? RealignReason(int msg, IntPtr w) => msg switch
    {
        WmDisplayChange => "cambio de pantallas",
        WmSettingChange when w.ToInt64() == SpiSetWorkArea => "cambio del área de trabajo",
        WmPowerBroadcast when w.ToInt64() == PbtResumeAutomatic => "vuelta de suspensión",
        _ => null,
    };

    /// <summary>Cada aviso nuevo reinicia la cuenta: se recoloca cuando el sistema deja de mover ventanas.</summary>
    private static void ScheduleRealign(string reason)
    {
        _realignReason = reason;
        _realignPass = 0;
        Realign.Stop();
        Realign.Interval = RealignDelays[0];
        Realign.Start();
    }

    private static void RealignTick()
    {
        foreach (var card in Cards.Values)
        {
            if (card.ReturnHome() is not { } from) continue;
            var line = $"{DateTime.Now:s} {_realignReason}: {card.FolderName} estaba en {from.X:0},{from.Y:0}; vuelve a {card.Left:0},{card.Top:0}";
            try
            {
                File.AppendAllText(MovesLog, line + Environment.NewLine);
            }
            catch (IOException)
            {
                // El registro es diagnóstico: si el fichero está bloqueado, la tarjeta ya ha vuelto igualmente.
            }
        }
        _realignPass++;
        Realign.Stop();
        if (_realignPass >= RealignDelays.Length) return;
        Realign.Interval = RealignDelays[_realignPass];
        Realign.Start();
    }

    /// <summary>
    /// Abre el menú de Apagado o, si ya está abierto, lo cierra. Al pulsar otra vez el botón del dock, el clic
    /// en la barra le quita el foco y lo cierra justo antes de que llegue el aviso: ese aviso no lo reabre.
    /// </summary>
    private static void TogglePower()
    {
        if (_power is not null)
        {
            _power.Close();
            return;
        }
        if (DateTime.UtcNow - _powerClosedAt < TimeSpan.FromMilliseconds(400)) return;
        _power = new PowerWindow();
        _power.Closed += (_, _) =>
        {
            _power = null;
            _powerClosedAt = DateTime.UtcNow;
        };
        _power.Show();
    }

    private static void AddCard(string folder)
    {
        if (Cards.ContainsKey(folder) || !Directory.Exists(folder)) return;
        var area = SystemParameters.WorkArea;
        var card = new FolderCard(folder, _config, new Point(area.Right - 480, _nextY));
        card.ExpandedChanged += UpdateOutsideClick;
        card.Show();
        // Plegada, al fondo; abierta, por encima de las demás tarjetas (que se crean después y quedarían encima).
        Native.SendToBottom(card);
        foreach (var open in Cards.Values.Append(card).Where(c => c.IsExpanded)) Native.BringToTop(open);
        // Sin posición guardada: alineada al borde derecho según su ancho real.
        if (!_config.Positions.ContainsKey(Path.GetFileName(folder)))
            card.Left = FolderCard.Snap(area.Right - card.ActualWidth - Margin);
        _nextY += card.ActualHeight + Margin;
        Cards[folder] = card;
    }

    /// <summary>Con alguna carpeta abierta, un clic fuera de ella la pliega; sin ninguna, no hay gancho.</summary>
    private static void UpdateOutsideClick()
    {
        if (!Cards.Values.Any(c => c.IsExpanded))
        {
            OutsideClick.Disable();
            return;
        }
        OutsideClick.Enable(point =>
        {
            if (AppMenu.IsOpen || CatalogWindow.IsOpen) return;
            // IsMouseOver de respaldo: si el ratón está sobre la tarjeta para WPF, el clic es suyo (lo atiende DragArea).
            foreach (var card in Cards.Values.Where(c => c.IsExpanded && !c.IsMouseOver && !Native.Contains(c, point)).ToList()) card.Collapse();
        });
    }

    /// <summary>Selector del menú contextual abierto por el residente (orden de <see cref="Native.SendToResident"/>).</summary>
    private static void OpenPicker(string[] args)
    {
        if (args.Length == 0 || args[0] is not ("--add" or "--new-folder")) return;
        Directory.CreateDirectory(FolderStore.Root);
        new PickerWindow(args.Skip(1).ToList(), args[0] == "--new-folder").Show();
    }

    private static int RunPicker(string[] args)
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        Directory.CreateDirectory(FolderStore.Root);
        var isNew = args[0] == "--new-folder";
        return app.Run(new PickerWindow(args.Skip(1).ToList(), isNew));
    }

    private static void RecreateAll(string store)
    {
        OutsideClick.Disable();
        foreach (var card in Cards.Values.ToList()) card.Close();
        Cards.Clear();
        _nextY = SystemParameters.WorkArea.Top + Margin;
        foreach (var folder in Directory.GetDirectories(store).Order(StringComparer.CurrentCultureIgnoreCase)) AddCard(folder);
    }

    private static void RemoveCard(string folder)
    {
        if (!Cards.Remove(folder, out var card)) return;
        card.Close();
    }
}

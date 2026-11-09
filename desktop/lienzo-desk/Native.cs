using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace LienzoDesk;

/// <summary>Llamadas Win32 para anclar las tarjetas al escritorio y recortar la RAM del proceso.</summary>
internal static class Native
{
    private const int GwlExStyle = -20;
    private const int GwlpHwndParent = -8;
    private const long WsExToolWindow = 0x00000080;
    private const long WsExNoActivate = 0x08000000;
    private static readonly IntPtr HwndBottom = new(1);
    private const uint SwpNoSize = 0x0001, SwpNoMove = 0x0002, SwpNoZOrder = 0x0004, SwpNoActivate = 0x0010;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string? className, string? windowName);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern long GetWindowLongPtr(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern long SetWindowLongPtr(IntPtr hwnd, int index, long value);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int RegisterWindowMessage(string message);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    private const byte VkLeftWin = 0x5B;
    public const byte VkS = 0x53, VkTab = 0x09;
    private const uint KeyUp = 0x0002;

    /// <summary>Pulsa Win + <paramref name="key"/> (Win+S búsqueda, Win+Tab Vista de tareas). Devuelve el código de salida.</summary>
    public static int PressWinKey(byte key)
    {
        keybd_event(VkLeftWin, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, KeyUp, UIntPtr.Zero);
        keybd_event(VkLeftWin, 0, KeyUp, UIntPtr.Zero);
        return 0;
    }

    /// <summary>DPI por monitor (PerMonitorV2) para todo el proceso; llamar antes de crear ninguna ventana.</summary>
    public static void UsePerMonitorDpi() => SetProcessDpiAwarenessContext(new IntPtr(-4));

    /// <summary>Título de la ventana oculta del proceso residente que recibe los avisos de los accesos del dock.</summary>
    public const string ListenerTitle = "LienzoDeskListener";

    /// <summary>Aviso «abre el menú de Apagado» para el proceso residente.</summary>
    public const string PowerMessage = "Lienzo.Desk.Power";

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(uint processId);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    /// <summary>
    /// Pasa un aviso al proceso residente y le cede el permiso de primer plano que Windows da a quien se lanza
    /// desde la barra (sin él, su ventana no podría coger el foco). Falso si el residente no está abierto.
    /// </summary>
    public static bool PostToResident(string message)
    {
        var hwnd = FindWindow(null, ListenerTitle);
        if (hwnd == IntPtr.Zero || GetWindowThreadProcessId(hwnd, out var pid) == 0) return false;
        AllowSetForegroundWindow(pid);
        return PostMessage(hwnd, RegisterWindowMessage(message), IntPtr.Zero, IntPtr.Zero);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool isAttached);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    /// <summary>
    /// Pone la ventana en primer plano aunque el clic que la abrió fuera en una tarjeta que no se activa (Windows le
    /// negaría el foco): enlaza un momento la entrada con el hilo de la ventana activa.
    /// </summary>
    public static void ForceForeground(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        var foreground = GetForegroundWindow();
        if (hwnd == IntPtr.Zero || foreground == hwnd) return;
        var foregroundThread = GetWindowThreadProcessId(foreground, out _);
        var thread = GetCurrentThreadId();
        var isAttached = foregroundThread != 0 && foregroundThread != thread && AttachThreadInput(thread, foregroundThread, true);
        SetForegroundWindow(hwnd);
        if (isAttached) AttachThreadInput(thread, foregroundThread, false);
    }

    private const int WmCopyData = 0x004A;
    private static readonly IntPtr CopyDataTag = new(0x4C5A);

    [StructLayout(LayoutKind.Sequential)]
    private struct CopyDataStruct { public IntPtr Tag; public int Size; public IntPtr Data; }

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, ref CopyDataStruct data);

    /// <summary>
    /// Pasa al proceso residente una orden con texto (WM_COPYDATA, síncrono) y le cede el primer plano. Falso si el
    /// residente no está abierto o no la acepta.
    /// </summary>
    public static bool SendToResident(string text)
    {
        var hwnd = FindWindow(null, ListenerTitle);
        if (hwnd == IntPtr.Zero || GetWindowThreadProcessId(hwnd, out var pid) == 0) return false;
        AllowSetForegroundWindow(pid);
        var buffer = Marshal.StringToHGlobalUni(text);
        try
        {
            var data = new CopyDataStruct { Tag = CopyDataTag, Size = (text.Length + 1) * 2, Data = buffer };
            return SendMessage(hwnd, WmCopyData, IntPtr.Zero, ref data) != IntPtr.Zero;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>Texto de una orden de <see cref="SendToResident"/>; nulo si el mensaje no es WM_COPYDATA de Lienzo.</summary>
    public static string? ReadResidentText(int msg, IntPtr lParam)
    {
        if (msg != WmCopyData || lParam == IntPtr.Zero) return null;
        var data = Marshal.PtrToStructure<CopyDataStruct>(lParam);
        if (data.Tag != CopyDataTag || data.Data == IntPtr.Zero || data.Size < 2) return null;
        return Marshal.PtrToStringUni(data.Data, data.Size / 2 - 1);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NativePoint { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct NativeRect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out NativePoint point);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out NativeRect rect);

    public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetWindowsHookEx(int idHook, HookProc proc, IntPtr module, uint threadId);

    [DllImport("user32.dll")]
    public static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

    /// <summary>¿Está el punto (píxeles de pantalla) dentro de la ventana?</summary>
    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    /// <summary>
    /// ¿Cae el punto del gancho de ratón dentro de la ventana? El gancho da píxeles físicos y este proceso es
    /// «system aware»: si el DPI del sistema no es el del monitor, GetWindowRect devuelve coordenadas
    /// escaladas y un clic en el título contaba como «fuera» (la carpeta se plegaba y el mismo clic la
    /// reabría). El rectángulo se pide en físicos, con el hilo en PerMonitorV2 solo durante la llamada.
    /// </summary>
    public static bool Contains(Window window, NativePoint point)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try
        {
            return GetWindowRect(hwnd, out var r) && point.X >= r.Left && point.X < r.Right && point.Y >= r.Top && point.Y < r.Bottom;
        }
        finally
        {
            if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
        }
    }

    [DllImport("psapi.dll")]
    private static extern bool EmptyWorkingSet(IntPtr process);

    /// <summary>
    /// Sin botón en la barra ni en Alt+Tab, sin robar el foco, al fondo y con el escritorio (Progman) como
    /// propietario: así «Mostrar escritorio» (Win+D) no la oculta.
    /// </summary>
    public static void PinToDesktop(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        var ex = GetWindowLongPtr(hwnd, GwlExStyle);
        SetWindowLongPtr(hwnd, GwlExStyle, ex | WsExToolWindow | WsExNoActivate);
        var progman = FindWindow("Progman", null);
        if (progman != IntPtr.Zero) SetWindowLongPtr(hwnd, GwlpHwndParent, progman.ToInt64());
        SendToBottom(window);
    }

    /// <summary>
    /// Mueve la ventana a una posición en píxeles lógicos directamente con Win32. Asignar Left/Top no basta al
    /// arrancar: WPF ya los ha sincronizado con el HWND y, si el anclaje o el primer diseño lo dejaron en otro
    /// sitio (centro de pantalla), repetir el mismo valor no lo mueve.
    /// </summary>
    public static void MoveTo(Window window, double x, double y)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero) return;
        var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(window);
        SetWindowPos(hwnd, IntPtr.Zero, (int)Math.Round(x * dpi.DpiScaleX), (int)Math.Round(y * dpi.DpiScaleY), 0, 0,
            SwpNoSize | SwpNoZOrder | SwpNoActivate);
    }

    /// <summary>Por encima del resto de ventanas sin quitar el foco (carpeta abierta sobre las demás tarjetas).</summary>
    public static void BringToTop(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SwpNoSize | SwpNoMove | SwpNoActivate);
    }

    public static void SendToBottom(Window window)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        SetWindowPos(hwnd, HwndBottom, 0, 0, 0, 0, SwpNoSize | SwpNoMove | SwpNoActivate);
    }

    /// <summary>Libera la memoria gestionada sobrante y devuelve al sistema las páginas no usadas.</summary>
    public static void TrimMemory()
    {
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        EmptyWorkingSet(Process.GetCurrentProcess().Handle);
    }
}

using System.Diagnostics;
using System.Runtime.InteropServices;

namespace LienzoLaunch;

/// <summary>
/// Lanzador nativo de LienzoDesk (NativeAOT, sin WPF). Los accesos del dock y del menú contextual lo llaman
/// en cada clic: pulsa la tecla o pasa la orden al proceso residente (LienzoDesk.App.exe), ya cargado, y sale.
/// Sin residente, o sin argumentos (arranque de sesión), abre LienzoDesk.App.exe con los mismos argumentos.
/// El protocolo con el residente es el de <c>lienzo-desk/Native.cs</c>: aviso registrado "Lienzo.Desk.Power"
/// y WM_COPYDATA con la etiqueta 0x4C5A a la ventana "LienzoDeskListener".
/// </summary>
internal static partial class Program
{
    private const string AppExe = "LienzoDesk.App.exe";
    private const string ListenerTitle = "LienzoDeskListener";
    private const string PowerMessage = "Lienzo.Desk.Power";
    private const int WmCopyData = 0x004A;
    private const nint CopyDataTag = 0x4C5A;
    private const byte VkLeftWin = 0x5B, VkS = 0x53, VkTab = 0x09;
    private const uint KeyUp = 0x0002;

    [STAThread]
    private static int Main(string[] args)
    {
        var verb = args.Length > 0 ? args[0] : "";
        switch (verb)
        {
            case "--search":
                return PressWinKey(VkS);
            case "--taskview":
                return PressWinKey(VkTab);
            case "--power" when PostToResident(PowerMessage):
                return 0;
            case "--add" or "--new-folder" when SendToResident(string.Join('\n', args)):
                return 0;
            default:
                return StartApp(args);
        }
    }

    /// <summary>Pulsa Win + <paramref name="key"/> (Win+S búsqueda, Win+Tab Vista de tareas).</summary>
    private static int PressWinKey(byte key)
    {
        keybd_event(VkLeftWin, 0, 0, 0);
        keybd_event(key, 0, 0, 0);
        keybd_event(key, 0, KeyUp, 0);
        keybd_event(VkLeftWin, 0, KeyUp, 0);
        return 0;
    }

    /// <summary>
    /// Ventana del residente; le cede el permiso de primer plano que Windows da a quien se lanza desde la barra
    /// (sin él, su menú no podría coger el foco). Cero si el residente no está abierto.
    /// </summary>
    private static nint FindResident()
    {
        var hwnd = FindWindowW(null, ListenerTitle);
        if (hwnd == 0 || GetWindowThreadProcessId(hwnd, out var pid) == 0) return 0;
        AllowSetForegroundWindow(pid);
        return hwnd;
    }

    private static bool PostToResident(string message)
    {
        var hwnd = FindResident();
        return hwnd != 0 && PostMessageW(hwnd, RegisterWindowMessageW(message), 0, 0);
    }

    private static unsafe bool SendToResident(string text)
    {
        var hwnd = FindResident();
        if (hwnd == 0) return false;
        fixed (char* chars = text)
        {
            var data = new CopyDataStruct { Tag = CopyDataTag, Size = (text.Length + 1) * 2, Data = (nint)chars };
            return SendMessageW(hwnd, WmCopyData, 0, ref data) != 0;
        }
    }

    /// <summary>Abre la app WPF con los mismos argumentos; error legible en el código de salida si falta.</summary>
    private static int StartApp(string[] args)
    {
        var exe = Path.Combine(AppContext.BaseDirectory, AppExe);
        var info = new ProcessStartInfo(exe) { UseShellExecute = false };
        foreach (var a in args) info.ArgumentList.Add(a);
        try
        {
            using var child = Process.Start(info);
            if (child is null) return 1;
            AllowSetForegroundWindow((uint)child.Id);
            return 0;
        }
        catch (System.ComponentModel.Win32Exception ex)
        {
            MessageBoxW(0, $"No se pudo abrir {exe}: {ex.Message}", "Lienzo", 0x10);
            return 2;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CopyDataStruct
    {
        public nint Tag;
        public int Size;
        public nint Data;
    }

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint FindWindowW(string? className, string title);

    [LibraryImport("user32.dll")]
    private static partial uint GetWindowThreadProcessId(nint hwnd, out uint processId);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool AllowSetForegroundWindow(uint processId);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int RegisterWindowMessageW(string name);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool PostMessageW(nint hwnd, int msg, nint wParam, nint lParam);

    [LibraryImport("user32.dll")]
    private static partial nint SendMessageW(nint hwnd, int msg, nint wParam, ref CopyDataStruct lParam);

    [LibraryImport("user32.dll")]
    private static partial void keybd_event(byte vk, byte scan, uint flags, nuint extraInfo);

    [LibraryImport("user32.dll", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int MessageBoxW(nint hwnd, string text, string caption, uint type);
}

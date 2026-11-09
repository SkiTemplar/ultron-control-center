using System.Runtime.InteropServices;

namespace LienzoDesk;

/// <summary>
/// Gancho de ratón de bajo nivel que solo existe mientras hay alguna carpeta abierta: un clic fuera de ella la
/// pliega. El callback no hace trabajo pesado (solo encola), para no añadir retardo al ratón del sistema.
/// </summary>
internal static class OutsideClick
{
    private const int WhMouseLl = 14;
    private const int WmLButtonDown = 0x0201, WmRButtonDown = 0x0204, WmMButtonDown = 0x0207;
    private static readonly Native.HookProc Callback = OnMouse;
    private static IntPtr _hook;
    private static Action<Native.NativePoint>? _onClick;

    public static void Enable(Action<Native.NativePoint> onClick)
    {
        _onClick = onClick;
        if (_hook == IntPtr.Zero) _hook = Native.SetWindowsHookEx(WhMouseLl, Callback, IntPtr.Zero, 0);
    }

    public static void Disable()
    {
        if (_hook == IntPtr.Zero) return;
        Native.UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
    }

    private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        var msg = wParam.ToInt32();
        if (code >= 0 && (msg == WmLButtonDown || msg == WmRButtonDown || msg == WmMButtonDown))
        {
            var point = Marshal.PtrToStructure<Native.NativePoint>(lParam);
            var handler = _onClick;
            if (handler is not null) System.Windows.Application.Current?.Dispatcher.BeginInvoke(() => handler(point));
        }
        return Native.CallNextHookEx(_hook, code, wParam, lParam);
    }
}

using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;

namespace LienzoDesk;

/// <summary>Acceso directo (.lnk o .url) de una carpeta Lienzo, con su icono en alta resolución.</summary>
public sealed record Shortcut(string Name, string Path, BitmapSource? Icon);

public static class Shortcuts
{
    private const int IconPx = 64;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint PrivateExtractIcons(string file, int index, int cx, int cy,
        IntPtr[] icons, uint[] ids, uint count, uint flags);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);

    public static IReadOnlyList<Shortcut> Load(string folder)
    {
        if (!Directory.Exists(folder)) return [];
        return Directory.EnumerateFiles(folder)
            .Where(f => f.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase)
                     || f.EndsWith(".url", StringComparison.OrdinalIgnoreCase))
            .Select(f => new Shortcut(CleanName(System.IO.Path.GetFileNameWithoutExtension(f)), f, LoadIcon(f)))
            .OrderBy(s => s.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    private static string CleanName(string name) =>
        System.Text.RegularExpressions.Regex.Replace(name, @"(\s+-\s+Acceso directo|\s+\d{4}(\.\d+)*)$", "")
            .Replace("JetBrains ", "");

    private static BitmapSource? LoadIcon(string shortcutPath)
    {
        var (file, index) = IconSource(shortcutPath);
        // Accesos sin ruta de destino (apps de la Store añadidas desde el catálogo): icono a través del shell.
        if (string.IsNullOrEmpty(file) || !File.Exists(file)) return AppCatalog.ShellIcon(shortcutPath, IconPx);
        var handles = new IntPtr[1];
        var ids = new uint[1];
        if (PrivateExtractIcons(file, index, IconPx, IconPx, handles, ids, 1, 0) < 1 || handles[0] == IntPtr.Zero)
            return null;
        try
        {
            var source = Imaging.CreateBitmapSourceFromHIcon(handles[0], Int32Rect.Empty,
                BitmapSizeOptions.FromEmptyOptions());
            source.Freeze();
            return source;
        }
        finally
        {
            DestroyIcon(handles[0]);
        }
    }

    private static (string File, int Index) IconSource(string shortcutPath)
    {
        if (shortcutPath.EndsWith(".url", StringComparison.OrdinalIgnoreCase))
        {
            var line = File.ReadLines(shortcutPath).FirstOrDefault(l => l.StartsWith("IconFile=", StringComparison.OrdinalIgnoreCase));
            return (line?["IconFile=".Length..] ?? "", 0);
        }
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType is null) return ("", 0);
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic link = shell.CreateShortcut(shortcutPath);
        string location = link.IconLocation ?? "";
        if (!string.IsNullOrEmpty(location) && !location.StartsWith(','))
        {
            var comma = location.LastIndexOf(',');
            var file = Environment.ExpandEnvironmentVariables(comma > 0 ? location[..comma] : location);
            var index = comma > 0 && int.TryParse(location[(comma + 1)..], out var i) ? i : 0;
            if (File.Exists(file)) return (file, index);
        }
        return ((string)link.TargetPath, 0);
    }
}

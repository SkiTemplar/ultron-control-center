using System.IO;

namespace LienzoDesk;

/// <summary>Carpetas de Lienzo en %LOCALAPPDATA%\Lienzo\Carpetas: listar, crear y añadir elementos.</summary>
public static class FolderStore
{
    public static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lienzo", "Carpetas");

    public static IReadOnlyList<string> Folders() =>
        Directory.Exists(Root)
            ? Directory.GetDirectories(Root).Order(StringComparer.CurrentCultureIgnoreCase).ToList()
            : [];

    /// <summary>Crea la carpeta con un nombre saneado; si ya existe, devuelve la existente.</summary>
    public static string Create(string name)
    {
        var clean = string.Concat(name.Trim().Where(c => !Path.GetInvalidFileNameChars().Contains(c)));
        if (clean.Length == 0) throw new ArgumentException("El nombre de la carpeta está vacío.");
        var path = Path.Combine(Root, clean);
        Directory.CreateDirectory(path);
        return path;
    }

    /// <summary>
    /// Copia los accesos (.lnk/.url) tal cual y crea un acceso directo para cualquier otro archivo o carpeta.
    /// Devuelve cuántos elementos se añadieron (los que ya estaban se omiten).
    /// </summary>
    public static int AddItems(string folder, IEnumerable<string> paths)
    {
        var added = 0;
        foreach (var raw in paths)
        {
            var path = raw.Trim().Trim('"');
            if (path.Length == 0 || !(File.Exists(path) || Directory.Exists(path))) continue;
            var ext = Path.GetExtension(path);
            if (ext.Equals(".lnk", StringComparison.OrdinalIgnoreCase) || ext.Equals(".url", StringComparison.OrdinalIgnoreCase))
            {
                var dest = Path.Combine(folder, Path.GetFileName(path));
                if (File.Exists(dest)) continue;
                File.Copy(path, dest);
                added++;
                continue;
            }
            var link = Path.Combine(folder, Path.GetFileNameWithoutExtension(path.TrimEnd('\\')) + ".lnk");
            if (File.Exists(link)) continue;
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType is null) continue;
            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic shortcut = shell.CreateShortcut(link);
            shortcut.TargetPath = path;
            shortcut.WorkingDirectory = Directory.Exists(path) ? path : Path.GetDirectoryName(path);
            shortcut.Save();
            added++;
        }
        return added;
    }
}

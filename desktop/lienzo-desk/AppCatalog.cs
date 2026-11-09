using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace LienzoDesk;

/// <summary>App instalada según shell:AppsFolder (escritorio y Store). <see cref="Id"/> es su ruta dentro de esa carpeta.</summary>
public sealed record InstalledApp(string Name, string Id);

/// <summary>Catálogo de apps instaladas: listar, buscar, sacar su icono y crear su acceso en una carpeta Lienzo.</summary>
public static class AppCatalog
{
    private const string AppsFolder = "shell:AppsFolder";
    private static readonly string[] NoiseWords = ["uninstall", "desinstalar", "readme", "léame", "release notes", "help", "ayuda"];

    private static IReadOnlyList<InstalledApp>? _cache;

    /// <summary>Catálogo ya leído (si aún no lo está, se lee ahora). Lo renueva <see cref="RefreshInBackground"/>.</summary>
    public static IReadOnlyList<InstalledApp> Cached => _cache ??= Load();

    /// <summary>
    /// Vuelve a leer el catálogo en un hilo STA aparte (el shell tarda ~1 s con 200 apps): al abrir el catálogo la
    /// lista ya está y recoge las apps instaladas desde la última vez.
    /// </summary>
    public static void RefreshInBackground()
    {
        var thread = new Thread(() =>
        {
            try
            {
                _cache = Load();
                // La lectura carga media shell en el proceso: se suelta en cuanto termina.
                Native.TrimMemory();
            }
            catch (COMException)
            {
                // Sin catálogo nuevo se sigue usando el anterior; Cached lo leerá al abrir si no hay ninguno.
            }
        }) { IsBackground = true, Priority = ThreadPriority.BelowNormal };
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    /// <summary>Lee la carpeta de aplicaciones del shell; sin desinstaladores, documentación ni enlaces web.</summary>
    public static IReadOnlyList<InstalledApp> Load()
    {
        var shellType = Type.GetTypeFromProgID("Shell.Application");
        if (shellType is null) return [];
        dynamic shell = Activator.CreateInstance(shellType)!;
        dynamic? folder = shell.NameSpace(AppsFolder);
        if (folder is null) return [];
        var apps = new List<InstalledApp>();
        foreach (dynamic item in folder.Items())
        {
            string name = item.Name ?? "";
            string id = item.Path ?? "";
            if (name.Length == 0 || id.Length == 0 || IsNoise(name, id)) continue;
            apps.Add(new InstalledApp(name, id));
        }
        return apps
            .DistinctBy(a => a.Name, StringComparer.CurrentCultureIgnoreCase)
            .OrderBy(a => a.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    private static bool IsNoise(string name, string id) =>
        id.StartsWith("http", StringComparison.OrdinalIgnoreCase)
        || NoiseWords.Any(w => name.Contains(w, StringComparison.CurrentCultureIgnoreCase));

    /// <summary>
    /// Coincidencias sin distinguir mayúsculas ni tildes: primero las que empiezan por la consulta, luego las que la
    /// tienen al principio de una palabra y después el resto.
    /// </summary>
    public static IReadOnlyList<InstalledApp> Search(IReadOnlyList<InstalledApp> apps, string query, int max)
    {
        var text = query.Trim();
        if (text.Length == 0) return [];
        var compare = CultureInfo.CurrentCulture.CompareInfo;
        const CompareOptions options = CompareOptions.IgnoreCase | CompareOptions.IgnoreNonSpace;
        return apps
            .Select(a => (App: a, Index: compare.IndexOf(a.Name, text, options)))
            .Where(m => m.Index >= 0)
            .OrderBy(m => m.Index == 0 ? 0 : char.IsLetterOrDigit(m.App.Name[m.Index - 1]) ? 2 : 1)
            .ThenBy(m => m.App.Name, StringComparer.CurrentCultureIgnoreCase)
            .Take(max)
            .Select(m => m.App)
            .ToList();
    }

    /// <summary>Nombre del acceso que <see cref="AddTo"/> crearía para la app (sin extensión).</summary>
    public static string LinkName(InstalledApp app) =>
        string.Concat(app.Name.Where(c => !Path.GetInvalidFileNameChars().Contains(c))).Trim();

    /// <summary>
    /// Crea en la carpeta un acceso a la app apuntando a su elemento de shell:AppsFolder, así que sirve también para
    /// las apps de la Store. Devuelve la ruta del acceso; si ya existía, no lo toca.
    /// </summary>
    public static string AddTo(string folder, InstalledApp app)
    {
        var path = Path.Combine(folder, LinkName(app) + ".lnk");
        if (File.Exists(path)) return path;
        var hr = SHParseDisplayName($@"{AppsFolder}\{app.Id}", IntPtr.Zero, out var pidl, 0, out _);
        if (hr < 0 || pidl == IntPtr.Zero) throw new COMException($"La app «{app.Name}» ya no está disponible.", hr);
        try
        {
            var link = (IShellLinkW)new ShellLinkCoClass();
            link.SetIDList(pidl);
            ((IPersistFile)link).Save(path, true);
        }
        finally
        {
            ILFree(pidl);
        }
        return path;
    }

    /// <summary>Icono de una app del catálogo.</summary>
    public static BitmapSource? Icon(InstalledApp app, int px) => ShellIcon($@"{AppsFolder}\{app.Id}", px);

    /// <summary>
    /// Icono de cualquier elemento del shell (archivo, acceso o app de la Store) a través de IShellItemImageFactory.
    /// Nulo si el shell no lo resuelve.
    /// </summary>
    public static BitmapSource? ShellIcon(string parsingName, int px)
    {
        if (SHCreateItemFromParsingName(parsingName, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out var factory) < 0) return null;
        try
        {
            const int iconOnly = 0x4;
            if (factory.GetImage(new NativeSize { Width = px, Height = px }, iconOnly, out var bitmap) < 0 || bitmap == IntPtr.Zero) return null;
            try
            {
                return ToBitmapSource(bitmap);
            }
            finally
            {
                DeleteObject(bitmap);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(factory);
        }
    }

    /// <summary>
    /// Copia los píxeles de la sección DIB conservando el alfa (CreateBitmapSourceFromHBitmap lo pierde y deja el
    /// fondo negro). El shell entrega el alfa premultiplicado; si la DIB va de abajo arriba, se voltea.
    /// </summary>
    private static BitmapSource? ToBitmapSource(IntPtr bitmap)
    {
        var dib = new DibSection();
        if (GetObject(bitmap, Marshal.SizeOf<DibSection>(), ref dib) == 0 || dib.Bits == IntPtr.Zero || dib.BitsPixel != 32)
        {
            var fallback = Imaging.CreateBitmapSourceFromHBitmap(bitmap, IntPtr.Zero, Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
            fallback.Freeze();
            return fallback;
        }
        var stride = dib.WidthBytes;
        BitmapSource source = BitmapSource.Create(dib.Width, dib.Height, 96, 96, PixelFormats.Pbgra32, null, dib.Bits, stride * dib.Height, stride);
        if (dib.HeaderHeight > 0) source = new TransformedBitmap(source, new ScaleTransform(1, -1));
        source.Freeze();
        return source;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(string name, IntPtr bindContext, out IntPtr pidl, uint attributesIn, out uint attributesOut);

    [DllImport("shell32.dll")]
    private static extern void ILFree(IntPtr pidl);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr bindContext, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItemImageFactory factory);

    [DllImport("gdi32.dll")]
    private static extern int GetObject(IntPtr handle, int size, ref DibSection section);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeSize { public int Width; public int Height; }

    [StructLayout(LayoutKind.Sequential)]
    private struct DibSection
    {
        public int Type, Width, Height, WidthBytes;
        public ushort Planes, BitsPixel;
        public IntPtr Bits;
        public int HeaderSize, HeaderWidth, HeaderHeight;
        public ushort HeaderPlanes, HeaderBitCount;
        public int Compression, SizeImage, XPelsPerMeter, YPelsPerMeter, ColorsUsed, ColorsImportant;
        public uint MaskRed, MaskGreen, MaskBlue;
        public IntPtr Section;
        public uint Offset;
    }

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory
    {
        [PreserveSig]
        int GetImage(NativeSize size, int flags, out IntPtr bitmap);
    }

    // Solo se declaran los métodos hasta SetIDList: el orden de la vtable es lo que cuenta y no se llama a los demás.
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath(IntPtr file, int maxPath, IntPtr findData, uint flags);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
    }

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLinkCoClass;
}

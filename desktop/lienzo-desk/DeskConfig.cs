using System.IO;
using System.Text.Json;

namespace LienzoDesk;

/// <summary>Posición de cada tarjeta, guardada en %LOCALAPPDATA%\Lienzo\desk.json.</summary>
public sealed class DeskConfig
{
    public Dictionary<string, double[]> Positions { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public HashSet<string> Collapsed { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    private static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lienzo", "desk.json");

    public static DeskConfig Load()
    {
        try
        {
            return File.Exists(FilePath)
                ? JsonSerializer.Deserialize<DeskConfig>(File.ReadAllText(FilePath)) ?? new DeskConfig()
                : new DeskConfig();
        }
        catch (JsonException)
        {
            return new DeskConfig();
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}

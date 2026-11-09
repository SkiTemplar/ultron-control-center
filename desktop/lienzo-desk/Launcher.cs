using System.ComponentModel;
using System.Diagnostics;
using System.IO;

namespace LienzoDesk;

/// <summary>
/// Abre apps y accesos directos de las tarjetas. Cancelar el UAC de una app que pide administrador
/// (HWMonitor, por ejemplo) no es un error y no muestra nada; el resto de fallos sale en un aviso legible.
/// </summary>
public static class Launcher
{
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const int ErrorAccessDenied = 5;
    private const int ErrorCancelled = 1223;

    public static void Open(string path, string? verb = null)
    {
        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true, Verb = verb ?? "" });
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == ErrorCancelled)
        {
            // El usuario dijo «No» en el UAC: no hay nada que avisar.
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException)
        {
            ConfirmWindow.Notify($"No se pudo abrir {Path.GetFileNameWithoutExtension(path)}", Describe(ex));
        }
    }

    /// <summary>Texto para el aviso: causa en lenguaje llano para los códigos habituales.</summary>
    public static string Describe(Exception ex) => ex is Win32Exception w ? w.NativeErrorCode switch
    {
        ErrorFileNotFound or ErrorPathNotFound =>
            "El acceso directo apunta a un programa que ya no existe. Puede que se haya desinstalado o movido.",
        ErrorAccessDenied => "Windows ha denegado el acceso. Prueba con «Ejecutar como administrador».",
        _ => w.Message,
    } : ex.Message;
}

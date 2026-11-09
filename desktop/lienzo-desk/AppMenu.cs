using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;

namespace LienzoDesk;

/// <summary>Menú del clic derecho de una app dentro de una tarjeta, con el estilo oscuro de Lienzo.</summary>
public static class AppMenu
{
    /// <summary>Mientras hay un menú abierto, el clic fuera no pliega la carpeta (el menú es otra ventana).</summary>
    public static bool IsOpen { get; private set; }

    private static readonly ResourceDictionary Styles = (ResourceDictionary)XamlReader.Parse("""
        <ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                            xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
          <Style TargetType="ContextMenu">
            <Setter Property="Template">
              <Setter.Value>
                <ControlTemplate TargetType="ContextMenu">
                  <Border Background="#F2121318" BorderBrush="#2EFFFFFF" BorderThickness="1" CornerRadius="12" Padding="6">
                    <StackPanel IsItemsHost="True" MinWidth="220"/>
                  </Border>
                </ControlTemplate>
              </Setter.Value>
            </Setter>
          </Style>
          <Style TargetType="MenuItem">
            <Setter Property="Foreground" Value="#F7F8FA"/>
            <Setter Property="FontFamily" Value="Segoe UI Variable Text"/>
            <Setter Property="FontSize" Value="13"/>
            <Setter Property="Template">
              <Setter.Value>
                <ControlTemplate TargetType="MenuItem">
                  <Border x:Name="Bg" CornerRadius="8" Padding="10,7" Background="Transparent">
                    <StackPanel Orientation="Horizontal">
                      <TextBlock Text="{TemplateBinding Tag}" FontFamily="Segoe Fluent Icons" FontSize="13"
                                 Width="24" VerticalAlignment="Center" Opacity="0.8"/>
                      <ContentPresenter ContentSource="Header" VerticalAlignment="Center"/>
                    </StackPanel>
                  </Border>
                  <ControlTemplate.Triggers>
                    <Trigger Property="IsHighlighted" Value="True">
                      <Setter TargetName="Bg" Property="Background" Value="#1FFFFFFF"/>
                    </Trigger>
                    <Trigger Property="IsEnabled" Value="False">
                      <Setter Property="Opacity" Value="0.45"/>
                    </Trigger>
                  </ControlTemplate.Triggers>
                </ControlTemplate>
              </Setter.Value>
            </Setter>
          </Style>
          <Style TargetType="Separator">
            <Setter Property="Template">
              <Setter.Value>
                <ControlTemplate TargetType="Separator">
                  <Border Height="1" Margin="8,5" Background="#26FFFFFF"/>
                </ControlTemplate>
              </Setter.Value>
            </Setter>
          </Style>
        </ResourceDictionary>
        """);

    public static ContextMenu Build(Shortcut app, string folder)
    {
        var menu = new ContextMenu { Resources = Styles, Placement = System.Windows.Controls.Primitives.PlacementMode.MousePoint };
        menu.Opened += (_, _) => IsOpen = true;
        menu.Closed += (_, _) => IsOpen = false;
        var target = ResolveTarget(app.Path);

        menu.Items.Add(Item("\uE8A7", "Abrir", () => Launcher.Open(app.Path)));
        menu.Items.Add(Item("\uE7EF", "Ejecutar como administrador", () => Launcher.Open(app.Path, "runas"), target is not null));
        menu.Items.Add(Item("\uE838", "Abrir ubicación del archivo", () => Process.Start("explorer.exe", $"/select,\"{target}\""), target is not null));
        menu.Items.Add(Divider());
        foreach (var other in FolderStore.Folders().Where(f => !string.Equals(f, folder, StringComparison.OrdinalIgnoreCase)))
            menu.Items.Add(Item("\uE8DE", $"Mover a {Path.GetFileName(other)}", () => Move(app.Path, other)));
        menu.Items.Add(Item("\uE74D", "Quitar de la carpeta", () => File.Delete(app.Path)));
        menu.Items.Add(Divider());
        menu.Items.Add(Item("\uE946", "Propiedades", () => ShowProperties(target ?? app.Path)));
        return menu;
    }

    /// <summary>Menú del clic derecho de la propia carpeta (tarjeta abierta o plegada).</summary>
    public static ContextMenu BuildFolder(FolderCard card, string folder, DeskConfig config)
    {
        var menu = new ContextMenu { Resources = Styles, Placement = System.Windows.Controls.Primitives.PlacementMode.MousePoint };
        menu.Opened += (_, _) => IsOpen = true;
        menu.Closed += (_, _) => IsOpen = false;
        var name = Path.GetFileName(folder);
        menu.Items.Add(Item(card.IsExpanded ? "\uE70E" : "\uE70D", card.IsExpanded ? "Plegar" : "Abrir", card.Toggle));
        menu.Items.Add(Item("\uEC50", "Abrir en el Explorador", () => Process.Start("explorer.exe", $"\"{folder}\"")));
        menu.Items.Add(Item("\uE710", "Añadir apps…", () => CatalogWindow.Open(folder)));
        menu.Items.Add(Divider());
        menu.Items.Add(Item("\uE8AC", "Cambiar nombre…", () => new PickerWindow("Cambiar nombre", newName => Rename(folder, newName, config), name).Show()));
        menu.Items.Add(Item("\uE8F4", "Nueva carpeta…", () => new PickerWindow("Nueva carpeta", FolderStore.Create).Show()));
        menu.Items.Add(Divider());
        menu.Items.Add(Item("\uE74D", "Eliminar carpeta", () => Delete(folder, config)));
        return menu;
    }

    /// <summary>Renombra la carpeta conservando su posición y estado plegado.</summary>
    private static string Rename(string folder, string newName, DeskConfig config)
    {
        var oldName = Path.GetFileName(folder);
        var dest = Path.Combine(Path.GetDirectoryName(folder)!, newName.Trim());
        if (string.Equals(dest, folder, StringComparison.OrdinalIgnoreCase)) return folder;
        if (Directory.Exists(dest)) throw new ArgumentException("Ya existe una carpeta con ese nombre.");
        if (config.Positions.Remove(oldName, out var pos)) config.Positions[newName.Trim()] = pos;
        if (config.Collapsed.Remove(oldName)) config.Collapsed.Add(newName.Trim());
        config.Save();
        Directory.Move(folder, dest);
        return dest;
    }

    /// <summary>Manda la carpeta a la papelera (recuperable), tras confirmar.</summary>
    private static void Delete(string folder, DeskConfig config)
    {
        var name = Path.GetFileName(folder);
        var isConfirmed = ConfirmWindow.Ask($"Eliminar «{name}»",
            "La carpeta y sus accesos directos irán a la papelera; las apps no se desinstalan y puedes recuperarla.",
            "Mover a la papelera", isDanger: true);
        if (!isConfirmed) return;
        config.Positions.Remove(name);
        config.Collapsed.Remove(name);
        config.Save();
        Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(folder,
            Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs, Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin);
    }

    /// <summary>
    /// Separador con el estilo del menú. En un ContextMenu WPF busca MenuItem.SeparatorStyleKey, no el estilo
    /// implícito de Separator, y sin esto salía la línea clara por defecto.
    /// </summary>
    private static Separator Divider() => new() { Style = (Style)Styles[typeof(Separator)] };

    private static MenuItem Item(string glyph, string text, Action action, bool isEnabled = true)
    {
        var item = new MenuItem { Header = text, Tag = glyph, IsEnabled = isEnabled };
        item.Click += (_, _) =>
        {
            try
            {
                action();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
            {
                ConfirmWindow.Notify("No se pudo completar", Launcher.Describe(ex));
            }
        };
        return item;
    }

    /// <summary>Ruta real a la que apunta un .lnk; null para .url (Steam, web) o si no existe.</summary>
    private static string? ResolveTarget(string shortcutPath)
    {
        if (!shortcutPath.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase)) return null;
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType is null) return null;
        dynamic shell = Activator.CreateInstance(shellType)!;
        string target = shell.CreateShortcut(shortcutPath).TargetPath;
        return File.Exists(target) || Directory.Exists(target) ? target : null;
    }

    private static void Move(string shortcutPath, string folder)
    {
        var dest = Path.Combine(folder, Path.GetFileName(shortcutPath));
        if (File.Exists(dest)) File.Delete(shortcutPath);
        else File.Move(shortcutPath, dest);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ShellExecuteInfo
    {
        public int Size; public uint Mask; public IntPtr Hwnd;
        public string? Verb; public string? File; public string? Parameters; public string? Directory;
        public int Show; public IntPtr InstApp; public IntPtr IdList; public string? Class;
        public IntPtr KeyClass; public uint HotKey; public IntPtr Icon; public IntPtr Process;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ShellExecuteEx(ref ShellExecuteInfo info);

    /// <summary>Ventana de propiedades de Windows (necesita SEE_MASK_INVOKEIDLIST, que Process.Start no pone).</summary>
    private static void ShowProperties(string path)
    {
        var info = new ShellExecuteInfo { Verb = "properties", File = path, Show = 5, Mask = 0x0000000C };
        info.Size = Marshal.SizeOf(info);
        if (!ShellExecuteEx(ref info)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
}

// ==WindhawkMod==
// @id              lienzo-nilesoft-preload
// @name            Lienzo: Nilesoft preload
// @description     Carga y fija shell.dll de Nilesoft en el Explorador al arrancar
// @version         1.1
// @author          ULTRON
// @include         explorer.exe
// @architecture    x86-64
// @compilerOptions -lole32 -lshell32 -luser32
// ==/WindhawkMod==

// Nilesoft Shell solo esta registrado como ContextMenuHandler: el Explorador carga shell.dll con el
// primer clic derecho sobre un archivo o el escritorio y puede descargarlo (CoFreeUnusedLibraries).
// Mientras no esta cargado, el clic derecho en la barra de tareas muestra el menu nativo. Este mod lo
// carga al iniciar el Explorador, crea una instancia de su objeto COM y conserva ambas referencias.
//
// 1.1: con la DLL cargada y la instancia creada, la barra seguia saliendo nativa hasta el primer clic
// derecho real sobre un archivo o el escritorio. Ahora se imita ese primer uso: IShellExtInit::Initialize
// con el fondo del escritorio y IContextMenu::QueryContextMenu sobre un menu temporal. El hilo se queda
// atendiendo mensajes para que lo que Nilesoft asocie a el (ventanas, ganchos) no muera al salir.

#include <objbase.h>
#include <shlobj.h>

namespace {

constexpr CLSID kNilesoftClsid = {0xBAE3934B, 0x8A6A, 0x4BFB, {0x81, 0xBD, 0x3F, 0xC5, 0x99, 0xA1, 0xBA, 0xF1}};
// IID definidos aqui: el enlazado de Windhawk no trae libuuid.
constexpr IID kIidUnknown = {0x00000000, 0x0000, 0x0000, {0xC0, 0, 0, 0, 0, 0, 0, 0x46}};
constexpr IID kIidClassFactory = {0x00000001, 0x0000, 0x0000, {0xC0, 0, 0, 0, 0, 0, 0, 0x46}};
constexpr IID kIidShellExtInit = {0x000214E8, 0x0000, 0x0000, {0xC0, 0, 0, 0, 0, 0, 0, 0x46}};
constexpr IID kIidContextMenu = {0x000214E4, 0x0000, 0x0000, {0xC0, 0, 0, 0, 0, 0, 0, 0x46}};
constexpr wchar_t kDllPath[] = L"C:\\Program Files\\Nilesoft Shell\\shell.dll";

using DllGetClassObjectFn = HRESULT(STDAPICALLTYPE*)(REFCLSID, REFIID, LPVOID*);

// Primer uso simulado: el menu del fondo del escritorio, como un clic derecho en el vacio.
void WarmUp(IUnknown* instance) {
    PIDLIST_ABSOLUTE desktop = nullptr;
    if (FAILED(SHGetSpecialFolderLocation(nullptr, CSIDL_DESKTOP, &desktop))) {
        Wh_Log(L"sin PIDL del escritorio; queda solo la instancia");
        return;
    }
    IShellExtInit* init = nullptr;
    if (SUCCEEDED(instance->QueryInterface(kIidShellExtInit, reinterpret_cast<void**>(&init))) && init) {
        HRESULT hr = init->Initialize(desktop, nullptr, nullptr);
        Wh_Log(L"Initialize 0x%08X", static_cast<unsigned>(hr));
        init->Release();
    }
    IContextMenu* menu = nullptr;
    if (SUCCEEDED(instance->QueryInterface(kIidContextMenu, reinterpret_cast<void**>(&menu))) && menu) {
        HMENU popup = CreatePopupMenu();
        if (popup) {
            HRESULT hr = menu->QueryContextMenu(popup, 0, 1, 0x7FFF, CMF_NORMAL);
            Wh_Log(L"QueryContextMenu 0x%08X", static_cast<unsigned>(hr));
            DestroyMenu(popup);
        }
        menu->Release();
    }
    CoTaskMemFree(desktop);
}

DWORD WINAPI PreloadThread(LPVOID) {
    HMODULE module = LoadLibraryW(kDllPath);
    if (!module) {
        Wh_Log(L"LoadLibrary fallo: %u", GetLastError());
        return 1;
    }
    auto getClassObject = reinterpret_cast<DllGetClassObjectFn>(GetProcAddress(module, "DllGetClassObject"));
    if (!getClassObject) {
        Wh_Log(L"shell.dll sin DllGetClassObject; queda solo fijada");
        return 0;
    }
    HRESULT init = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    IClassFactory* factory = nullptr;
    HRESULT hr = getClassObject(kNilesoftClsid, kIidClassFactory, reinterpret_cast<void**>(&factory));
    if (SUCCEEDED(hr) && factory) {
        IUnknown* instance = nullptr;
        hr = factory->CreateInstance(nullptr, kIidUnknown, reinterpret_cast<void**>(&instance));
        // La instancia y la fabrica no se liberan a proposito: mantienen DllCanUnloadNow en S_FALSE.
        Wh_Log(L"Nilesoft precargado (CreateInstance 0x%08X)", static_cast<unsigned>(hr));
        if (SUCCEEDED(hr) && instance) WarmUp(instance);
    } else {
        Wh_Log(L"DllGetClassObject fallo: 0x%08X", static_cast<unsigned>(hr));
    }
    // Bucle de mensajes mientras viva el Explorador (el apartamento COM sigue abierto a proposito).
    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    if (SUCCEEDED(init)) CoUninitialize();
    return 0;
}

}  // namespace

BOOL Wh_ModInit() {
    HANDLE thread = CreateThread(nullptr, 0, PreloadThread, nullptr, 0, nullptr);
    if (thread) CloseHandle(thread);
    return TRUE;
}

// Sin Wh_ModUninit: descargar Nilesoft con menus abiertos podria tumbar el Explorador.

"""Registra sensores de HWiNFO (memoria compartida SM2) en CSV mientras corre un benchmark.

Uso: uv run python hwinfo_log.py <salida.csv> <segundos> [--list]
"""
import csv
import ctypes
import struct
import sys
import time
from ctypes import wintypes

FILE_MAP_READ = 0x0004
SM_NAME = "Global\\HWiNFO_SENS_SM2"
HEADER_FMT = "<IIIqIIIIII"
READING_FMT = "<III128s128s16sdddd"

# Etiquetas originales (inglés) que interesan; se comparan por prefijo.
WANTED = (
    "CPU Package",
    "CPU Package Power",
    "P-core 0 Clock",
    "E-core 8 Clock",
    "Core Thermal Throttling",
    "Package/Ring Thermal Throttling",
    "IA: Package-Level RAPL/PBM PL1",
    "IA: Package-Level RAPL/PBM PL2",
    "Core Effective Clocks",
    "Average Effective Clock",
    "Total CPU Usage",
    "GPU Temperature",
    "GPU Power",
    "CPU",
    "Fan",
)

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenFileMappingW.restype = wintypes.HANDLE
kernel32.OpenFileMappingW.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
kernel32.MapViewOfFile.restype = ctypes.c_void_p
kernel32.MapViewOfFile.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t)


def open_view():
    handle = kernel32.OpenFileMappingW(FILE_MAP_READ, False, SM_NAME)
    if not handle:
        raise OSError(f"No se puede abrir {SM_NAME} (error {ctypes.get_last_error()}); "
                      "HWiNFO no está abierto o falta 'Shared Memory Support'")
    view = kernel32.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0)
    if not view:
        raise OSError(f"MapViewOfFile falló (error {ctypes.get_last_error()})")
    return view


def read_all(view):
    header = ctypes.string_at(view, struct.calcsize(HEADER_FMT))
    (_sig, _ver, _rev, _poll, _off_s, _size_s, _num_s,
     off_r, size_r, num_r) = struct.unpack(HEADER_FMT, header)
    base = ctypes.string_at(view, off_r + size_r * num_r)
    readings = []
    for i in range(num_r):
        chunk = base[off_r + i * size_r: off_r + i * size_r + struct.calcsize(READING_FMT)]
        _t, sensor_idx, _rid, label, _user, unit, value, _mn, _mx, _avg = struct.unpack(READING_FMT, chunk)
        readings.append((sensor_idx, label.split(b"\0")[0].decode("latin-1"),
                         unit.split(b"\0")[0].decode("latin-1"), value))
    return readings


def is_wanted(label):
    return any(label.startswith(w) for w in WANTED)


def main():
    if len(sys.argv) < 3:
        sys.exit("Uso: hwinfo_log.py <salida.csv> <segundos> [--list]")
    out_path, duration = sys.argv[1], float(sys.argv[2])
    view = open_view()
    if "--list" in sys.argv:
        for idx, label, unit, value in read_all(view):
            print(f"{idx}\t{label}\t{value:.1f} {unit}")
        return
    first = [r for r in read_all(view) if is_wanted(r[1])]
    columns = [f"{idx}:{label} [{unit}]" for idx, label, unit, _ in first]
    deadline = time.time() + duration
    with open(out_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["t"] + columns)
        while time.time() < deadline:
            values = {f"{i}:{l} [{u}]": v for i, l, u, v in read_all(view) if is_wanted(l)}
            writer.writerow([f"{time.time():.1f}"] + [f"{values.get(c, float('nan')):.2f}" for c in columns])
            fh.flush()
            time.sleep(1.0)


if __name__ == "__main__":
    main()

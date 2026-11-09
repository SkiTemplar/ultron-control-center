"""Resume un CSV de HWiNFO en una ventana de tiempo.

Uso: uv run python analyze.py <hwinfo.csv> <HH:MM:SS inicio> <HH:MM:SS fin>
"""
import csv
import statistics
import sys

NUMERIC = (
    "CPU Entera [°C]",
    "Potencia total de CPU [W]",
    "Reloj efectivo promedio [MHz]",
    "P-core 0 T0 Reloj efectivo [MHz]",
    "E-core 8 T0 Reloj efectivo [MHz]",
    "Uso total de CPU [%]",
    "PCH Temperatura [°C]",
    "Ventilador 1 (CPU) [RPM]",
    "Ventilador 2 (GPU) [RPM]",
    "Temperatura de la GPU [°C]",
    "Límite de potencia PL1 (Dynamic) [W]",
    "Límite de potencia PL2 (Dynamic) [W]",
)
FLAGS = (
    "Desaceleración térmica del núcleo (avg) [Yes/No]",
    "Desaceleración térmica del paquete/anillo [Yes/No]",
    "Límite de potencia del núcleo excedido (avg) [Yes/No]",
    "Límite de potencia del paquete / anillo excedido [Yes/No]",
)


def to_seconds(clock):
    hours, minutes, seconds = clock.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def in_window(clock, start, end):
    return to_seconds(start) <= to_seconds(clock) <= to_seconds(end)


def main():
    path, start, end = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(path, encoding="utf-8-sig", errors="replace") as fh:
        rows = list(csv.reader(fh))
    header, data = rows[0], [r for r in rows[1:] if len(r) > 2 and in_window(r[1], start, end)]
    if not data:
        sys.exit("Sin filas en la ventana indicada")
    index = {name: i for i, name in enumerate(header)}
    print(f"filas={len(data)}  {data[0][1]} -> {data[-1][1]}")
    for name in NUMERIC:
        if name not in index:
            continue
        values = [float(r[index[name]]) for r in data if r[index[name]].replace(".", "", 1).isdigit()]
        if values:
            print(f"{name:55s} media={statistics.mean(values):8.1f}  max={max(values):8.1f}  min={min(values):8.1f}")
    for name in FLAGS:
        if name not in index:
            continue
        yes = sum(1 for r in data if r[index[name]].strip() == "Yes")
        print(f"{name:55s} Yes={100 * yes / len(data):5.1f} %")


if __name__ == "__main__":
    main()

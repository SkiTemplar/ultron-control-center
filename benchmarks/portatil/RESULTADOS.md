# Benchmarks del portátil (MSI Raider GE68HX 13VF, i9-13950HX, RTX 4060 Laptop)

Solo se añaden entradas; no se reescriben las anteriores.

## 2026-10-13: antes de cambiar la pasta (referencia)

- Cinebench R23 Multi, 10 min: media de 13.003 y mediana de 12.635. Pasadas de 17.965 a 8.974.
  Las condiciones cambiaron durante la prueba: empezó con el plan Alto rendimiento, a los ~1,5 min
  se activó el tope de 4 GHz y a los ~3 min MSI Center pasó a Balanced.
- Reposo (HWiNFO): CPU a 94 °C de media y 99-100 °C de pico, desaceleración térmica el 100 %
  del tiempo, 42 W, ventilador de CPU a 7.353 RPM fijo y PCH a 89-94 °C.
- GPU (2026-10-25, LiminalPortals en UE): 87-88 °C y 2.295 MHz con SW thermal slowdown tras ~10 min.
- RDR2 (2026-04-25): 73,4 FPS de media, 46,4 de mínimo y 99,2 % de frames por debajo de 16 ms.

## 2026-10-26: después de cambiar la pasta y limpiar

Condiciones: con cargador, MSI Center en Extreme Performance (PL1 de 150 W y PL2 de 220 W), BIOS 112
y registro CSV de HWiNFO cada 2 s.

| Prueba | CB R23 Multi (media) | Mediana | Pasadas | CPU media / máx. | W medios | Desaceleración térmica |
|---|---|---|---|---|---|---|
| Plan "ULTRON Unreal (tope 4 GHz)" | 19.216 | 20.076 | 11.023-23.172 | 88 / 93 °C | 103 | 0 % |
| Plan Equilibrado, sin tope | 24.283 | 23.651 | 29.310 → 21.335 (última, 18.037) | 93 / 96 °C | 120 (112 al final) | 0 % |

- Reposo: CPU a 60 °C, 23 W, ventilador de CPU a 5.500 RPM, PCH a 82 °C y 0 % de desaceleración.
- Sin tope, el PL1 dinámico baja hasta 55 W en momentos puntuales: MSI/DTT recorta potencia por
  temperatura en lugar de activar PROCHOT. La puntuación cae un ~25 % entre la primera y la última pasada.
- En las dos pruebas el ventilador de CPU va al máximo (~7.400 RPM).
- La GPU no se ha medido en esta sesión.

Los ficheros `2026-10-26_cb23_*.txt` contienen la salida de Cinebench. `analyze.py` resume un CSV de HWiNFO.

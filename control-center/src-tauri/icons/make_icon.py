"""Genera el icono de mar.ia: el reactor sobre fondo oscuro.

Se dibuja a 1024 px y se reduce con LANCZOS — dibujar directamente a 32 px
deja los anillos aliasados y el resultado parece un borron azul en la barra de
tareas.

Uso:  python make_icon.py
Salida: 32x32.png, 64x64.png, 128x128.png, 128x128@2x.png, icon.ico, y los
        Square*Logo.png que pide el bundler de Windows.
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

AQUI = pathlib.Path(__file__).parent

# Paleta del HUD (styles.css): fondo azul marino, cian electrico, nucleo claro.
FONDO = (3, 7, 15, 255)
CIAN = (53, 214, 255, 255)
CIAN_TENUE = (53, 214, 255, 90)
NUCLEO = (220, 245, 255, 255)

S = 1024  # lienzo de trabajo


def dibuja() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = S / 2

    # Fondo redondo: en Windows el icono se ve sobre barras claras y oscuras.
    d.ellipse([0, 0, S, S], fill=FONDO)

    # Anillo exterior discontinuo (24 segmentos).
    r_ext = S * 0.42
    for i in range(24):
        a0 = i * 15
        if i % 2:
            continue
        d.arc(
            [c - r_ext, c - r_ext, c + r_ext, c + r_ext],
            start=a0,
            end=a0 + 9,
            fill=CIAN,
            width=int(S * 0.022),
        )

    # Anillo intermedio continuo, mas tenue.
    r_med = S * 0.33
    d.ellipse(
        [c - r_med, c - r_med, c + r_med, c + r_med],
        outline=CIAN_TENUE,
        width=int(S * 0.012),
    )

    # Anillo interior con hueco: la parte que "procesa".
    r_int = S * 0.24
    d.arc(
        [c - r_int, c - r_int, c + r_int, c + r_int],
        start=210,
        end=110,
        fill=CIAN,
        width=int(S * 0.035),
    )

    # Nucleo con halo.
    r_halo = S * 0.15
    d.ellipse([c - r_halo, c - r_halo, c + r_halo, c + r_halo], fill=(53, 214, 255, 70))
    r_nuc = S * 0.085
    d.ellipse([c - r_nuc, c - r_nuc, c + r_nuc, c + r_nuc], fill=NUCLEO)
    return img


def main() -> None:
    base = dibuja()
    tamanos = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }
    for nombre, px in tamanos.items():
        base.resize((px, px), Image.LANCZOS).save(AQUI / nombre)
    # El .ico lleva varias resoluciones dentro: Windows elige segun el sitio.
    base.resize((256, 256), Image.LANCZOS).save(
        AQUI / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    base.resize((512, 512), Image.LANCZOS).save(AQUI / "icon.png")
    print(f"iconos generados en {AQUI}")


if __name__ == "__main__":
    main()

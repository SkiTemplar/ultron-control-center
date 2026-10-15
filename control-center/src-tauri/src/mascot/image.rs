// Mascota — reducción y codificación PNG de capturas para el MCP de
// escritorio. Independiente de la plataforma (se prueba en cualquier SO).

/// Ancho máximo de la imagen que se entrega al modelo. Una captura 4K a
/// tamaño real son miles de tokens de imagen y el modelo la reescala igual;
/// 1280 px mantiene legibles los textos de interfaz normales.
pub const MAX_SHOT_WIDTH: u32 = 1280;

/// Factor físico/imagen para una pantalla de `width` píxeles: las
/// coordenadas que da el modelo (sobre la imagen) se multiplican por él.
/// Determinista: no hace falta recordar la última captura para convertir.
pub fn shot_scale(width: u32) -> f64 {
    if width <= MAX_SHOT_WIDTH || width == 0 {
        1.0
    } else {
        width as f64 / MAX_SHOT_WIDTH as f64
    }
}

/// Reduce una imagen BGRA (arriba abajo) promediando por áreas y la
/// devuelve en RGB. Con `tw == w` solo reordena canales.
pub fn downscale_bgra_to_rgb(src: &[u8], w: u32, h: u32, tw: u32, th: u32) -> Vec<u8> {
    let (w, h, tw, th) = (w as usize, h as usize, tw.max(1) as usize, th.max(1) as usize);
    let mut out = vec![0u8; tw * th * 3];
    for ty in 0..th {
        let y0 = ty * h / th;
        let y1 = (((ty + 1) * h) / th).max(y0 + 1).min(h);
        for tx in 0..tw {
            let x0 = tx * w / tw;
            let x1 = (((tx + 1) * w) / tw).max(x0 + 1).min(w);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row = y * w * 4;
                for x in x0..x1 {
                    let i = row + x * 4;
                    b += src[i] as u32;
                    g += src[i + 1] as u32;
                    r += src[i + 2] as u32;
                    n += 1;
                }
            }
            let o = (ty * tw + tx) * 3;
            let n = n.max(1);
            out[o] = (r / n) as u8;
            out[o + 1] = (g / n) as u8;
            out[o + 2] = (b / n) as u8;
        }
    }
    out
}

pub fn encode_png_rgb(rgb: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut buf, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().map_err(|e| format!("png: {e}"))?;
        writer
            .write_image_data(rgb)
            .map_err(|e| format!("png: {e}"))?;
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_escala_solo_reduce_pantallas_anchas() {
        assert_eq!(shot_scale(1280), 1.0);
        assert_eq!(shot_scale(800), 1.0);
        assert!((shot_scale(2560) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn promedia_bloques_y_pasa_bgra_a_rgb() {
        // 2x2 BGRA: rojo, rojo, azul, azul -> 1x1 = mezcla.
        let src = [
            0, 0, 255, 255, 0, 0, 255, 255, //
            255, 0, 0, 255, 255, 0, 0, 255,
        ];
        let out = downscale_bgra_to_rgb(&src, 2, 2, 1, 1);
        assert_eq!(out, vec![127, 0, 127]);
        let same = downscale_bgra_to_rgb(&src, 2, 2, 2, 2);
        assert_eq!(&same[0..3], &[255, 0, 0]);
        assert_eq!(&same[9..12], &[0, 0, 255]);
    }

    #[test]
    fn el_png_empieza_por_la_firma() {
        let png = encode_png_rgb(&[1, 2, 3, 4, 5, 6], 2, 1).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}

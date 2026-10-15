// Mascota — traducción de combinaciones de teclas («ctrl+shift+t», «enter»,
// «win+r») a códigos de tecla virtual de Windows. Sin dependencias de
// plataforma para poder probarla en cualquier SO.

/// Códigos VK de Windows (winuser.h). Se escriben a mano para que este
/// módulo compile y se pruebe también fuera de Windows.
fn named_vk(name: &str) -> Option<u16> {
    let vk = match name {
        "ctrl" | "control" | "ctl" => 0x11,
        "shift" => 0x10,
        "alt" | "menu" => 0x12,
        "win" | "super" | "meta" | "cmd" | "windows" => 0x5B,
        "enter" | "return" => 0x0D,
        "tab" => 0x09,
        "esc" | "escape" => 0x1B,
        "space" | "espacio" => 0x20,
        "backspace" | "back" => 0x08,
        "delete" | "del" | "supr" => 0x2E,
        "insert" | "ins" => 0x2D,
        "home" | "inicio" => 0x24,
        "end" | "fin" => 0x23,
        "pageup" | "pgup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        "left" | "izquierda" => 0x25,
        "up" | "arriba" => 0x26,
        "right" | "derecha" => 0x27,
        "down" | "abajo" => 0x28,
        "capslock" => 0x14,
        "printscreen" | "prtsc" => 0x2C,
        "apps" | "contextmenu" => 0x5D,
        "volumeup" => 0xAF,
        "volumedown" => 0xAE,
        "volumemute" | "mute" => 0xAD,
        "medianext" => 0xB0,
        "mediaprev" => 0xB1,
        "mediaplaypause" | "playpause" => 0xB3,
        "minus" | "-" => 0xBD,
        "plus" | "=" => 0xBB,
        "comma" | "," => 0xBC,
        "period" | "." => 0xBE,
        _ => return None,
    };
    Some(vk)
}

/// Teclas que Windows envía con el prefijo E0 (flechas, bloque de edición,
/// Win derecha…). Sin KEYEVENTF_EXTENDEDKEY, por ejemplo, la flecha arriba
/// llega como el 8 del teclado numérico.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn is_extended(vk: u16) -> bool {
    matches!(
        vk,
        0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x2C | 0xAD..=0xB3
    )
}

/// «ctrl+shift+t» → [VK_CONTROL, VK_SHIFT, 'T']. Las teclas se pulsan en
/// ese orden y se sueltan al revés.
pub fn parse_combo(spec: &str) -> Result<Vec<u16>, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("combinación vacía".into());
    }
    let mut out = Vec::new();
    for raw in spec.split('+') {
        let part = raw.trim().to_lowercase();
        if part.is_empty() {
            return Err(format!("combinación mal formada: «{spec}»"));
        }
        let vk = if let Some(vk) = named_vk(&part) {
            vk
        } else if part.len() == 1 {
            let c = part.chars().next().unwrap_or(' ');
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase() as u16
            } else {
                return Err(format!("tecla desconocida: «{part}»"));
            }
        } else if let Some(n) = part.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
            if (1..=24).contains(&n) {
                0x70 + n - 1
            } else {
                return Err(format!("tecla de función fuera de rango: «{part}»"));
            }
        } else {
            return Err(format!("tecla desconocida: «{part}»"));
        };
        out.push(vk);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combina_modificadores_y_letra() {
        assert_eq!(parse_combo("Ctrl+Shift+t").unwrap(), vec![0x11, 0x10, 0x54]);
        assert_eq!(parse_combo("win+r").unwrap(), vec![0x5B, 0x52]);
        assert_eq!(parse_combo("enter").unwrap(), vec![0x0D]);
        assert_eq!(parse_combo("alt+F4").unwrap(), vec![0x12, 0x73]);
    }

    #[test]
    fn rechaza_lo_que_no_entiende() {
        assert!(parse_combo("").is_err());
        assert!(parse_combo("ctrl+").is_err());
        assert!(parse_combo("hyper+x").is_err());
        assert!(parse_combo("f99").is_err());
    }

    #[test]
    fn flechas_son_extendidas_y_letras_no() {
        assert!(is_extended(0x26));
        assert!(!is_extended(0x41));
    }
}

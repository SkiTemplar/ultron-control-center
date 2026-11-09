// sesiones/voz.rs — Dictado del composer: un trozo de audio (webm/opus que
// graba el WebView entre pausas del habla) a texto con Whisper de Groq.
//
// La key sale de `GROQ_API_KEY` (la misma del AI Router, cargada con dotenvy
// en `run()`). El audio sale de la máquina hacia Groq: es la contrapartida de
// la latencia baja (~0,5 s por trozo) frente a un Whisper local.

use base64::Engine as _;
use serde_json::Value;

const ENDPOINT: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL: &str = "whisper-large-v3-turbo";
/// Tope por trozo: el composer corta a los 12 s; 4 MB deja margen de sobra.
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// Frases que Whisper inventa sobre silencio o ruido de fondo.
const HALLUCINATIONS: &[&str] = &[
    "subtítulos realizados por la comunidad de amara.org",
    "gracias por ver el vídeo",
    "gracias por ver",
    "suscríbete",
];

pub fn transcribe(audio_b64: &str, mime: &str, language: Option<&str>) -> Result<String, String> {
    let audio = base64::engine::general_purpose::STANDARD
        .decode(audio_b64)
        .map_err(|e| format!("audio no válido: {e}"))?;
    if audio.is_empty() {
        return Ok(String::new());
    }
    if audio.len() > MAX_BYTES {
        return Err(format!(
            "trozo de audio demasiado grande ({} KB)",
            audio.len() / 1024
        ));
    }
    let key = std::env::var("GROQ_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .ok_or("falta GROQ_API_KEY: añádela en Control Center → Ajustes → API Keys o en ~/.ultron/.env")?;
    let (content_type, body) = multipart(&audio, mime, language.unwrap_or("es"));
    let resp = reqwest::blocking::Client::new()
        .post(ENDPOINT)
        .bearer_auth(key.trim())
        .header("Content-Type", content_type)
        .body(body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .map_err(|e| format!("Groq no responde: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .map_err(|e| format!("respuesta ilegible de Groq: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Groq {status}: {}",
            text.chars().take(300).collect::<String>()
        ));
    }
    let v: Value =
        serde_json::from_str(&text).map_err(|e| format!("JSON de Groq no válido: {e}"))?;
    Ok(clean(v["text"].as_str().unwrap_or_default()))
}

/// Recorta y descarta las alucinaciones típicas de Whisper sobre silencio.
pub fn clean(text: &str) -> String {
    let t = text.trim();
    let bare = normalize(t);
    if HALLUCINATIONS.iter().any(|h| bare == normalize(h)) {
        return String::new();
    }
    t.to_string()
}

fn normalize(s: &str) -> String {
    s.to_lowercase()
        .trim_matches(|c: char| {
            c.is_ascii_punctuation() || c.is_whitespace() || c == '¡' || c == '¿'
        })
        .to_string()
}

fn extension(mime: &str) -> &'static str {
    let base = mime.split(';').next().unwrap_or_default().trim();
    match base {
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/wav" | "audio/x-wav" => "wav",
        _ => "webm",
    }
}

/// Cuerpo multipart/form-data a mano (reqwest va sin la feature `multipart`).
fn multipart(audio: &[u8], mime: &str, language: &str) -> (String, Vec<u8>) {
    let boundary = format!(
        "ultron-voz-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let mut body = Vec::with_capacity(audio.len() + 512);
    let field = |body: &mut Vec<u8>, name: &str, value: &str| {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    };
    field(&mut body, "model", MODEL);
    field(&mut body, "language", language);
    field(&mut body, "response_format", "json");
    field(&mut body, "temperature", "0");
    let ext = extension(mime);
    let base_mime = mime.split(';').next().unwrap_or("audio/webm").trim();
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dictado.{ext}\"\r\nContent-Type: {base_mime}\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descarta_alucinaciones_de_silencio() {
        assert_eq!(clean("  Gracias por ver el vídeo. "), "");
        assert_eq!(clean("¡Gracias por ver!"), "");
        assert_eq!(
            clean("Subtítulos realizados por la comunidad de Amara.org"),
            ""
        );
    }

    #[test]
    fn conserva_el_texto_real() {
        assert_eq!(
            clean(" Quita el botón de historial. "),
            "Quita el botón de historial."
        );
        assert_eq!(
            clean("gracias por ver el vídeo que te pasé ayer"),
            "gracias por ver el vídeo que te pasé ayer"
        );
    }

    #[test]
    fn multipart_lleva_modelo_idioma_y_fichero() {
        let (ct, body) = multipart(b"OPUS", "audio/webm;codecs=opus", "es");
        let s = String::from_utf8_lossy(&body);
        assert!(ct.starts_with("multipart/form-data; boundary=ultron-voz-"));
        assert!(s.contains("name=\"model\"\r\n\r\nwhisper-large-v3-turbo"));
        assert!(s.contains("name=\"language\"\r\n\r\nes"));
        assert!(s.contains("filename=\"dictado.webm\"\r\nContent-Type: audio/webm\r\n\r\nOPUS"));
        assert!(s.trim_end().ends_with("--"));
    }

    #[test]
    fn audio_vacio_no_llama_a_groq() {
        assert_eq!(transcribe("", "audio/webm", None), Ok(String::new()));
        assert!(transcribe("no-es-base64!!", "audio/webm", None).is_err());
    }
}

/// Prueba real contra Groq (red y key): `VOZ_WAV=<fichero.wav> cargo test --lib voz_real -- --ignored`.
#[cfg(test)]
mod tests_real {
    #[test]
    #[ignore]
    fn voz_real_transcribe_un_wav() {
        let _ = dotenvy::from_path(dirs::home_dir().unwrap().join(".ultron/.env"));
        crate::mascot::calendar_fetch::scrub_process_env();
        let path = std::env::var("VOZ_WAV").expect("VOZ_WAV");
        let b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            std::fs::read(path).unwrap(),
        );
        let text = super::transcribe(&b64, "audio/wav", Some("es")).unwrap();
        println!("TRANSCRITO: {text}");
        assert!(text.to_lowercase().contains("historial"), "{text}");
    }
}

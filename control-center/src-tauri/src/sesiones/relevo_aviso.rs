// sesiones/relevo_aviso.rs — Aviso de cuota de Claude Code (submódulo de
// `relevo`): detección, tipo de límite y hora de vuelta.
//
// La señal principal es un mensaje `assistant` con `model == "<synthetic>"`.
// Se aceptan las redacciones conocidas («You've hit your session limit ·
// resets 1:20am», «5-hour limit reached ∙ resets 3pm», «Claude AI usage limit
// reached|<epoch>») con el apóstrofo tipográfico o el ASCII. Un aviso sin hora
// también dispara el relevo, con la vuelta desconocida (manual). La segunda
// señal es la muestra local de uso al 100 % junto a un mensaje sintético que
// hable de un límite que no case con ninguna redacción conocida.

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeZone};
use serde::Serialize;
use serde_json::Value;

use crate::sesiones::types::{PlanUsage, UsageWindow};

/// Ventana del plan que se agotó.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LimitKind {
    /// Ventana de 5 h.
    Session,
    /// Ventana semanal (incluido el límite semanal de Opus).
    Weekly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageLimit {
    pub kind: LimitKind,
    /// Texto de la hora del aviso (`1:20am`, `oct 30, 9am`); vacío si no trae.
    pub reset_time: String,
    /// Instante de la vuelta según el aviso (RFC 3339), si se pudo calcular.
    pub return_at: Option<String>,
}

fn synthetic_text(v: &Value) -> Option<&str> {
    if v.pointer("/message/model").and_then(Value::as_str) != Some("<synthetic>") {
        return None;
    }
    v.pointer("/message/content/0/text")
        .and_then(Value::as_str)
        .or_else(|| v.pointer("/message/content").and_then(Value::as_str))
}

/// Minúsculas y apóstrofos tipográficos cambiados por el ASCII.
fn normalize(text: &str) -> String {
    text.to_lowercase()
        .replace(['\u{2019}', '\u{2018}', '`'], "'")
}

/// Redacciones conocidas del aviso de cuota (texto ya normalizado). Un
/// «rate limit» (429 de la API) es transitorio y no es una cuota del plan.
fn is_quota_notice(lower: &str) -> bool {
    if lower.contains("rate limit") {
        return false;
    }
    let hit = lower
        .find("hit your")
        .is_some_and(|i| lower[i..].contains("limit"));
    hit || lower.contains("limit reached")
}

fn kind_of(lower: &str) -> LimitKind {
    if lower.contains("weekly") {
        LimitKind::Weekly
    } else {
        LimitKind::Session
    }
}

/// Texto tras `resets ` hasta la zona (`(`), un separador o el final.
fn reset_text(lower: &str) -> String {
    let Some((_, tail)) = lower.split_once("resets ") else {
        return String::new();
    };
    tail.split(['(', '\n', '·', '∙', '|'])
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('.')
        .trim()
        .to_string()
}

/// Formato antiguo `Claude AI usage limit reached|<segundos Unix>`.
fn epoch_return(text: &str) -> Option<DateTime<Local>> {
    let (_, tail) = text.rsplit_once('|')?;
    let secs: i64 = tail.trim().parse().ok()?;
    Local.timestamp_opt(secs, 0).single()
}

fn build_limit(text: &str, now: DateTime<Local>) -> UsageLimit {
    let lower = normalize(text);
    let reset_time = reset_text(&lower);
    let at = estimate_return(&reset_time, now).or_else(|| epoch_return(text));
    UsageLimit {
        kind: kind_of(&lower),
        reset_time,
        return_at: at.map(|a| a.to_rfc3339()),
    }
}

/// Detecta exclusivamente los avisos sintéticos de cuota de Claude Code.
pub fn detect_usage_limit(v: &Value) -> Option<UsageLimit> {
    detect_usage_limit_at(v, Local::now())
}

pub fn detect_usage_limit_at(v: &Value, now: DateTime<Local>) -> Option<UsageLimit> {
    let text = synthetic_text(v)?;
    is_quota_notice(&normalize(text)).then(|| build_limit(text, now))
}

/// Segunda señal: un mensaje sintético que menciona un límite, sin casar con
/// ninguna redacción conocida, mientras la muestra local de uso está al 100 %.
pub fn detect_by_usage(v: &Value, usage: Option<&PlanUsage>) -> Option<UsageLimit> {
    let lower = normalize(synthetic_text(v)?);
    if !lower.contains("limit") {
        return None;
    }
    let (kind, window) = exhausted_window(usage)?;
    Some(UsageLimit {
        kind,
        reset_time: String::new(),
        return_at: window.resets_at.clone(),
    })
}

/// Ventana agotada (100 % o más) de la muestra de uso; la semanal manda
/// porque su reinicio es el más tardío.
pub fn exhausted_window<'a>(usage: Option<&'a PlanUsage>) -> Option<(LimitKind, &'a UsageWindow)> {
    let u = usage?;
    let full = |w: Option<&'a UsageWindow>| w.filter(|w| w.percent >= 100.0);
    full(u.seven_day.as_ref())
        .map(|w| (LimitKind::Weekly, w))
        .or_else(|| full(u.five_hour.as_ref()).map(|w| (LimitKind::Session, w)))
}

/// Hora de vuelta: la de la ventana del tipo de límite en la muestra local
/// (instante exacto) y, si no la hay, la del aviso.
pub fn pick_return(limit: &UsageLimit, usage: Option<&PlanUsage>) -> Option<String> {
    let window = usage.and_then(|u| match limit.kind {
        LimitKind::Session => u.five_hour.as_ref(),
        LimitKind::Weekly => u.seven_day.as_ref(),
    });
    window
        .and_then(|w| w.resets_at.clone())
        .or_else(|| limit.return_at.clone())
}

/// `1:20am`, `3pm`, `9 am` o `15:00`.
fn parse_clock(raw: &str) -> Option<NaiveTime> {
    let t = raw.trim().replace(' ', "");
    let (body, offset) = if let Some(b) = t.strip_suffix("pm") {
        (b, Some(12))
    } else if let Some(b) = t.strip_suffix("am") {
        (b, Some(0))
    } else {
        (t.as_str(), None)
    };
    let (h, m) = body.split_once(':').unwrap_or((body, "0"));
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    let hour = match offset {
        Some(off) if (1..=12).contains(&h) => h % 12 + off,
        Some(_) => return None,
        None => h,
    };
    NaiveTime::from_hms_opt(hour, m, 0)
}

/// `oct 30` del año en curso o, si ya pasó, del siguiente.
fn parse_day(raw: &str, now: DateTime<Local>) -> Option<NaiveDate> {
    let mut parts = raw.split_whitespace();
    let (month, day) = (parts.next()?, parts.next()?);
    let try_year = |y: i32| NaiveDate::parse_from_str(&format!("{day} {month} {y}"), "%d %b %Y");
    let this = try_year(now.year()).ok()?;
    if this < now.date_naive() - chrono::Duration::days(1) {
        return try_year(now.year() + 1).ok();
    }
    Some(this)
}

/// Instante de la vuelta a partir del texto del aviso: hora sola (hoy o, si ya
/// pasó, mañana) o fecha y hora (`oct 30, 9am`, `oct 30 at 9am`).
pub fn estimate_return(raw: &str, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let clean = format!(" {} ", raw.replace(',', " ")).replace(" at ", " ");
    let words: Vec<&str> = clean.split_whitespace().collect();
    let split = words.len().checked_sub(match words.last()? {
        w if *w == "am" || *w == "pm" => 2,
        _ => 1,
    })?;
    let time = parse_clock(&words[split..].join(""))?;
    if split == 0 {
        let mut at = Local
            .from_local_datetime(&now.date_naive().and_time(time))
            .single()?;
        if at <= now {
            at += chrono::Duration::days(1);
        }
        return Some(at);
    }
    let day = parse_day(&words[..split].join(" "), now)?;
    Local.from_local_datetime(&day.and_time(time)).single()
}

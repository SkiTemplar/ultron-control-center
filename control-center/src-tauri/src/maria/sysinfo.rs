// mar.ia — telemetria nativa para el HUD.
//
// Sustituye a `rich_system_info` en la pantalla principal. Aquel lanza
// `system_tasks.ps1` a traves del plugin shell de Tauri, que NO oculta la
// consola: con el HUD pidiendo datos cada pocos segundos, el escritorio se
// llenaba de ventanas de PowerShell abriendose y cerrandose solas (reportado
// por el usuario el 2026-09-18). Aqui no se lanza ningun proceso para CPU,
// RAM ni disco — se lee con `sysinfo`, que ya era dependencia — y el unico
// proceso que queda (nvidia-smi, para la GPU) va con CREATE_NO_WINDOW.
//
// El System tab clasico sigue usando su camino de PowerShell: no se toca lo
// que ya funcionaba, solo se deja de llamar cada 10 segundos.

use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;
use sysinfo::{Disks, System};

/// Instancia reutilizada: `System::new_all()` en cada llamada escanea procesos
/// enteros y cuesta cientos de ms. Guardarla ademas es lo que permite calcular
/// el uso de CPU (necesita dos muestras).
static SYS: Lazy<Mutex<System>> = Lazy::new(|| Mutex::new(System::new()));

#[derive(Debug, Clone, Serialize, Default)]
pub struct Gpu {
    pub name: String,
    pub util_pct: Option<i32>,
    pub mem_used_mb: Option<i64>,
    pub mem_total_mb: Option<i64>,
    pub temp_c: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct HudTelemetry {
    /// Uso de CPU 0..100. `None` en la primerisima llamada (hace falta una
    /// segunda muestra para que el dato signifique algo).
    pub cpu_pct: Option<f32>,
    pub ram_used_gb: f64,
    pub ram_total_gb: f64,
    pub ram_pct: f64,
    pub disk_free_gb: f64,
    pub disk_total_gb: f64,
    pub disk_pct: f64,
    pub gpus: Vec<Gpu>,
}

/// Lee la GPU con nvidia-smi. Sin tarjeta NVIDIA devuelve vacio y el panel
/// pinta "sin datos de gpu" en vez de inventarse una.
fn read_gpus() -> Vec<Gpu> {
    let mut cmd = crate::proc::oculto("nvidia-smi");
    cmd.args([
        "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: sin esto parpadea
    }
    let Ok(out) = cmd.output() else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|linea| {
            let campos: Vec<&str> = linea.split(',').map(str::trim).collect();
            if campos.len() < 5 {
                return None;
            }
            Some(Gpu {
                name: campos[0].to_string(),
                util_pct: campos[1].parse().ok(),
                mem_used_mb: campos[2].parse().ok(),
                mem_total_mb: campos[3].parse().ok(),
                temp_c: campos[4].parse().ok(),
            })
        })
        .collect()
}

/// Disco del sistema. Se busca por punto de montaje para no depender del orden.
fn read_disk() -> (f64, f64) {
    let disks = Disks::new_with_refreshed_list();
    let objetivo = if cfg!(windows) { "C:" } else { "/" };
    for d in disks.list() {
        let punto = d.mount_point().to_string_lossy();
        if punto.starts_with(objetivo) {
            let gb = |b: u64| b as f64 / 1_073_741_824.0;
            return (gb(d.available_space()), gb(d.total_space()));
        }
    }
    (0.0, 0.0)
}

pub fn telemetry() -> HudTelemetry {
    let mut sys = SYS.lock().unwrap_or_else(|e| e.into_inner());
    sys.refresh_memory();
    sys.refresh_cpu_usage();

    let gb = |b: u64| b as f64 / 1_073_741_824.0;
    let total = gb(sys.total_memory());
    let usada = gb(sys.used_memory());
    let cpu = sys.global_cpu_usage();
    // sysinfo devuelve 0.0 hasta que hay dos muestras: se distingue del "0%"
    // real devolviendo None y pintando un guion.
    let cpu_pct = (cpu > 0.0).then_some(cpu);

    let (libre, disco_total) = read_disk();
    HudTelemetry {
        cpu_pct,
        ram_used_gb: usada,
        ram_total_gb: total,
        ram_pct: if total > 0.0 {
            usada / total * 100.0
        } else {
            0.0
        },
        disk_free_gb: libre,
        disk_total_gb: disco_total,
        disk_pct: if disco_total > 0.0 {
            (disco_total - libre) / disco_total * 100.0
        } else {
            0.0
        },
        gpus: read_gpus(),
    }
}

/// Telemetria para el HUD. Sin lanzar consolas.
#[tauri::command]
pub async fn maria_telemetry() -> Result<HudTelemetry, String> {
    tauri::async_runtime::spawn_blocking(telemetry)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_telemetria_devuelve_memoria_real() {
        let t = telemetry();
        assert!(
            t.ram_total_gb > 0.5,
            "RAM total sospechosa: {}",
            t.ram_total_gb
        );
        assert!(t.ram_used_gb > 0.0 && t.ram_used_gb <= t.ram_total_gb);
        assert!((0.0..=100.0).contains(&t.ram_pct));
    }

    #[test]
    fn el_disco_del_sistema_tiene_tamano() {
        let t = telemetry();
        assert!(
            t.disk_total_gb > 1.0,
            "disco sin tamano: {}",
            t.disk_total_gb
        );
        assert!(t.disk_free_gb <= t.disk_total_gb);
    }

    #[test]
    fn la_cpu_no_miente_en_la_primera_muestra() {
        // Caso negativo: sysinfo devuelve 0.0 hasta tener dos muestras. Un 0%
        // pintado como dato real seria mentira, asi que la primera vez debe
        // venir None (o un valor ya valido si otra prueba calento la instancia).
        let t = telemetry();
        if let Some(cpu) = t.cpu_pct {
            assert!(cpu > 0.0 && cpu <= 100.0, "cpu fuera de rango: {cpu}");
        }
    }

    #[test]
    fn la_gpu_es_opcional_y_coherente() {
        // Sin NVIDIA la lista viene vacia; con ella, los campos tienen que
        // cuadrar entre si.
        for g in telemetry().gpus {
            assert!(!g.name.is_empty());
            if let (Some(u), Some(t)) = (g.mem_used_mb, g.mem_total_mb) {
                assert!(u <= t, "VRAM usada mayor que la total");
            }
        }
    }
}

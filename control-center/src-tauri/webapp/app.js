// mar.ia en el movil — logica de la webapp.
//
// Tres cosas y ninguna mas: hablar con mar.ia (el mismo relevo de proveedores
// que en el escritorio), ver el estado del PC y leer los avisos.
//
// El token llega la primera vez en la URL (?t=…) y se guarda en el navegador,
// para no tener que pegarlo cada vez. Si el navegador no puede guardar (modo
// privado), se sigue usando el de la URL: la app no se queda inservible.
//
// La voz usa lo que YA trae el telefono: SpeechRecognition para dictar y
// speechSynthesis para leer. Asi no hay que subir audio ni cargar un modelo:
// en el movil eso significaria segundos de espera y megas de datos.

const $ = (sel) => document.querySelector(sel);

// --- token -----------------------------------------------------------------

const CLAVE_TOKEN = "maria.token";

function leerToken() {
  const url = new URL(location.href);
  const deUrl = url.searchParams.get("t");
  if (deUrl) {
    try {
      localStorage.setItem(CLAVE_TOKEN, deUrl);
    } catch {
      // Modo privado: seguimos con el de la URL.
    }
    // Se limpia de la barra para que no acabe en el historial compartido.
    url.searchParams.delete("t");
    history.replaceState(null, "", url.pathname + url.search);
    return deUrl;
  }
  try {
    return localStorage.getItem(CLAVE_TOKEN) || "";
  } catch {
    return "";
  }
}

const TOKEN = leerToken();

async function api(ruta, opciones = {}) {
  const resp = await fetch(ruta, {
    ...opciones,
    headers: {
      "content-type": "application/json",
      "x-maria-token": TOKEN,
      ...(opciones.headers || {}),
    },
  });
  const datos = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(datos.error || `error ${resp.status}`);
  return datos;
}

function mostrarError(msg) {
  const caja = $("#error");
  caja.textContent = msg;
  caja.classList.remove("oculta");
  setTimeout(() => caja.classList.add("oculta"), 6000);
}

// --- pestanas --------------------------------------------------------------

const VISTAS = ["chat", "estado", "avisos"];
document.querySelectorAll(".pestana").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".pestana").forEach((x) => x.classList.remove("activa"));
    b.classList.add("activa");
    const cual = b.dataset.vista;
    for (const v of VISTAS) {
      $(`#vista-${v}`).classList.toggle("oculta", v !== cual);
    }
    if (cual === "estado") void cargarEstado();
    if (cual === "avisos") void cargarAvisos();
  });
});

// --- hablar ----------------------------------------------------------------

let hiloActual = "";

function pintarTurno(quien, texto, clase) {
  const art = document.createElement("article");
  art.className = `turno ${clase}`;
  const q = document.createElement("span");
  q.className = "quien";
  q.textContent = quien;
  art.appendChild(q);
  art.appendChild(document.createTextNode(texto));
  const caja = $("#turnos");
  caja.appendChild(art);
  caja.scrollTop = caja.scrollHeight;
  return art;
}

async function preguntar(texto) {
  pintarTurno("tú", texto, "yo");
  const esperando = document.createElement("p");
  esperando.className = "pensando";
  esperando.textContent = "mar.ia está pensando…";
  $("#turnos").appendChild(esperando);
  try {
    const r = await api("/api/preguntar", {
      method: "POST",
      body: JSON.stringify({ prompt: texto, thread_id: hiloActual || null }),
    });
    hiloActual = r.thread_id || hiloActual;
    esperando.remove();
    pintarTurno(r.provider || "mar.ia", r.text || "(sin respuesta)", "asistente");
    // Lo que hay que contar aunque la respuesta haya salido bien (2026-09-22):
    // hoy, que el turno se ha contestado SIN punto de control. Si no se pinta,
    // el movil deja trabajando a un agente sin red y sin decirlo.
    if (r.aviso) mostrarError(r.aviso);
    if ($("#leer-en-voz").checked) leerEnVoz(r.text || "");
  } catch (e) {
    esperando.remove();
    mostrarError(String(e.message || e));
  }
}

$("#formulario").addEventListener("submit", (e) => {
  e.preventDefault();
  const campo = $("#mensaje");
  const texto = campo.value.trim();
  if (!texto) return;
  campo.value = "";
  void preguntar(texto);
});

// --- voz del telefono ------------------------------------------------------

function leerEnVoz(texto) {
  if (!("speechSynthesis" in window) || !texto) return;
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = "es-ES";
  u.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

const Reconocedor = window.SpeechRecognition || window.webkitSpeechRecognition;
let dictado = null;

$("#microfono").addEventListener("click", () => {
  if (!Reconocedor) {
    mostrarError("este navegador no sabe dictar; escribe el mensaje");
    return;
  }
  const boton = $("#microfono");
  if (dictado) {
    dictado.stop();
    return;
  }
  dictado = new Reconocedor();
  dictado.lang = "es-ES";
  dictado.interimResults = true;
  dictado.continuous = false;
  boton.classList.add("grabando");

  dictado.onresult = (ev) => {
    let texto = "";
    for (const res of ev.results) texto += res[0].transcript;
    $("#mensaje").value = texto;
    // Cuando el reconocedor da el resultado por definitivo, se envia solo:
    // en el movil pulsar "enviar" despues de hablar sobra.
    if (ev.results[ev.results.length - 1].isFinal) {
      const limpio = texto.trim();
      $("#mensaje").value = "";
      if (limpio) void preguntar(limpio);
    }
  };
  dictado.onerror = (ev) => mostrarError(`dictado: ${ev.error}`);
  dictado.onend = () => {
    boton.classList.remove("grabando");
    dictado = null;
  };
  dictado.start();
});

// --- estado ----------------------------------------------------------------

function fila(k, v) {
  return `<div class="fila"><span>${k}</span><span class="v">${v}</span></div>`;
}

function gb(n) {
  return typeof n === "number" ? `${n.toFixed(1)} GB` : "—";
}

async function cargarEstado() {
  try {
    const d = await api("/api/estado");
    const t = d.telemetria || {};
    const gpu = (t.gpus || [])[0];
    const prov = d.proveedores || {};
    const cuota = d.cuota_claude || {};
    const orden = (d.relevo && d.relevo.order) || [];

    const paneles = [
      `<div class="panel"><h2>sistema</h2>
        ${fila("cpu", typeof t.cpu_pct === "number" ? `${Math.round(t.cpu_pct)}%` : "—")}
        ${fila("ram", `${gb(t.ram_used_gb)} / ${gb(t.ram_total_gb)}`)}
        ${fila("disco", `${gb(t.disk_free_gb)} libres`)}
      </div>`,
      gpu
        ? `<div class="panel"><h2>gpu</h2>
            ${fila("modelo", gpu.name || "—")}
            ${fila("uso", gpu.util_pct != null ? `${gpu.util_pct}%` : "—")}
            ${fila("vram", gpu.mem_used_mb != null ? `${gpu.mem_used_mb} / ${gpu.mem_total_mb} MB` : "—")}
            ${fila("temp", gpu.temp_c != null ? `${gpu.temp_c} °C` : "—")}
          </div>`
        : "",
      `<div class="panel"><h2>proveedores</h2>
        ${orden
          .map((p) => {
            const e = prov[p];
            return fila(p, e ? `${e.status} · ${e.answered} resp.` : "sin usar");
          })
          .join("")}
        ${cuota.tokens != null ? fila("claude 5h", `${Math.round(cuota.tokens / 1000)}k tokens`) : ""}
      </div>`,
    ];
    $("#paneles").innerHTML = paneles.join("");
    $("#estado-corto").textContent = "en línea";
  } catch (e) {
    $("#estado-corto").textContent = "sin conexión";
    mostrarError(String(e.message || e));
  }
}

$("#formulario-decir").addEventListener("submit", async (e) => {
  e.preventDefault();
  const campo = $("#texto-decir");
  const texto = campo.value.trim();
  if (!texto) return;
  campo.value = "";
  try {
    await api("/api/decir", { method: "POST", body: JSON.stringify({ text: texto }) });
  } catch (err) {
    mostrarError(String(err.message || err));
  }
});

// --- avisos ----------------------------------------------------------------

async function cargarAvisos() {
  try {
    const d = await api("/api/avisos");
    const lista = d.avisos || [];
    if (lista.length === 0) {
      $("#lista-avisos").innerHTML = '<p class="pie">sin avisos.</p>';
      return;
    }
    $("#lista-avisos").innerHTML = lista
      .map((a) => {
        const sev = (a.severity || "info").replace(/[^a-z]/g, "");
        const cuando = a.timestamp ? new Date(a.timestamp).toLocaleString("es-ES") : "";
        return `<div class="aviso ${sev}"><span class="cuando">${cuando} · ${escapar(
          a.source || "",
        )}</span>${escapar(a.message || "")}</div>`;
      })
      .join("");
  } catch (e) {
    mostrarError(String(e.message || e));
  }
}

/** Escapa para meter texto ajeno en innerHTML sin abrir un agujero. */
function escapar(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

// --- arranque --------------------------------------------------------------

if (!TOKEN) {
  mostrarError("falta el token: abre el enlace que muestra mar.ia en Ajustes");
}
void cargarEstado();
// El estado se refresca solo mientras la pestana esta a la vista: en el movil,
// seguir pidiendo datos con la pantalla apagada solo gasta bateria.
setInterval(() => {
  if (!document.hidden && !$("#vista-estado").classList.contains("oculta")) {
    void cargarEstado();
  }
}, 15000);

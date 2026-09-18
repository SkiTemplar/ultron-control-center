// mar.ia móvil — lógica de la app instalable.
//
// LO QUE ESTA APP NO HACE, a propósito: no piensa. No hay modelo, ni memoria,
// ni claves de nadie aquí dentro. Todo se manda al PC (`maria_web`) y el PC
// decide, ejecuta y contesta. El teléfono pone micrófono, altavoz y pantalla.
//
// Por qué así: el usuario quiere "que todo se redirija y se piense desde el
// PC". Además, es lo único honesto: las suscripciones de Claude/Codex viven en
// las CLIs del ordenador y no se pueden usar desde un navegador.
//
// LÍMITE DECLARADO: esta página se sirve por https, así que el navegador solo
// la deja hablar con direcciones https. Un `http://192.168.x.x` lo bloquea el
// propio teléfono (contenido mixto), no mar.ia. La vía que funciona es
// `tailscale serve`, que da un https real; en la misma red, la alternativa es
// abrir la webapp que sirve el propio PC. La pestaña "conexión" lo explica.

const $ = (s) => document.querySelector(s);

// --- conexión guardada -----------------------------------------------------

const CLAVE = "maria.movil.conexion.v1";

function leerConexion() {
  // Un enlace con ?pc= y ?t= configura la app de una vez (p. ej. desde un QR).
  const url = new URL(location.href);
  const pc = url.searchParams.get("pc");
  const t = url.searchParams.get("t");
  if (pc && t) {
    const conn = { base: pc.replace(/\/+$/, ""), token: t };
    guardarConexion(conn);
    // Se limpia la barra para que el token no quede en el historial.
    history.replaceState(null, "", url.pathname);
    return conn;
  }
  try {
    return JSON.parse(localStorage.getItem(CLAVE) || "null") || { base: "", token: "" };
  } catch {
    return { base: "", token: "" };
  }
}

function guardarConexion(c) {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(c));
  } catch {
    // Modo privado: la app funciona igual, solo que no lo recuerda.
  }
}

let conexion = leerConexion();

async function api(ruta, opciones = {}) {
  if (!conexion.base || !conexion.token) {
    throw new Error("falta configurar la conexión con el PC (pestaña «conexión»)");
  }
  const resp = await fetch(conexion.base + ruta, {
    ...opciones,
    headers: {
      "content-type": "application/json",
      "x-maria-token": conexion.token,
      ...(opciones.headers || {}),
    },
  });
  const datos = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(datos.error || `error ${resp.status}`);
  return datos;
}

function marcarEstado(ok, texto) {
  const e = $("#estado-corto");
  e.textContent = texto;
  e.className = `etiqueta ${ok ? "ok" : "mal"}`;
}

function mostrarError(msg) {
  const caja = $("#error");
  caja.textContent = msg;
  caja.classList.remove("oculta");
  setTimeout(() => caja.classList.add("oculta"), 7000);
}

// --- pestañas --------------------------------------------------------------

const VISTAS = ["chat", "llamada", "estado", "conexion"];
function irA(cual) {
  document.querySelectorAll(".pestana").forEach((b) => {
    b.classList.toggle("activa", b.dataset.vista === cual);
  });
  for (const v of VISTAS) $(`#vista-${v}`).classList.toggle("oculta", v !== cual);
  if (cual === "estado") void cargarEstado();
}
document.querySelectorAll(".pestana").forEach((b) => {
  b.addEventListener("click", () => irA(b.dataset.vista));
});
$("#ajustes-btn").addEventListener("click", () => irA("conexion"));

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

/** Manda al PC y devuelve la respuesta. Lo comparten el chat y la llamada. */
async function preguntarAlPc(texto) {
  const r = await api("/api/preguntar", {
    method: "POST",
    body: JSON.stringify({ prompt: texto, thread_id: hiloActual || null }),
  });
  hiloActual = r.thread_id || hiloActual;
  return r;
}

async function preguntar(texto) {
  pintarTurno("tú", texto, "yo");
  const esperando = document.createElement("p");
  esperando.className = "pensando";
  esperando.textContent = "el PC está pensando…";
  $("#turnos").appendChild(esperando);
  try {
    const r = await preguntarAlPc(texto);
    esperando.remove();
    const quien = [r.provider, r.model].filter(Boolean).join(" · ") || "mar.ia";
    pintarTurno(quien, r.text || "(sin respuesta)", "asistente");
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

// --- voz del teléfono ------------------------------------------------------

function leerEnVoz(texto, alTerminar) {
  if (!("speechSynthesis" in window) || !texto) {
    alTerminar?.();
    return;
  }
  const u = new SpeechSynthesisUtterance(texto);
  u.lang = "es-ES";
  u.rate = 1.05;
  u.onend = () => alTerminar?.();
  u.onerror = () => alTerminar?.();
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

const Reconocedor = window.SpeechRecognition || window.webkitSpeechRecognition;

$("#microfono").addEventListener("click", () => {
  if (!Reconocedor) {
    mostrarError("este navegador no sabe dictar; escribe el mensaje");
    return;
  }
  const boton = $("#microfono");
  if (boton.classList.contains("grabando")) return;
  const rec = new Reconocedor();
  rec.lang = "es-ES";
  rec.interimResults = true;
  rec.continuous = false;
  boton.classList.add("grabando");
  rec.onresult = (ev) => {
    let texto = "";
    for (const res of ev.results) texto += res[0].transcript;
    $("#mensaje").value = texto;
    if (ev.results[ev.results.length - 1].isFinal) {
      const limpio = texto.trim();
      $("#mensaje").value = "";
      if (limpio) void preguntar(limpio);
    }
  };
  rec.onerror = (ev) => mostrarError(`dictado: ${ev.error}`);
  rec.onend = () => boton.classList.remove("grabando");
  rec.start();
});

// --- llamada (manos libres) -------------------------------------------------
//
// El bucle es: escuchar -> mandar al PC -> hablar -> volver a escuchar. Se
// para solo cuando se cuelga. No es VoIP: no hay audio en tiempo real de ida y
// vuelta, y decirlo importa. Lo que hay es una conversación hablada sin tocar
// la pantalla, que es lo que se pide al pedir "llamar".

let enLlamada = false;
let recLlamada = null;

function estadoLlamada(estado, texto) {
  $("#orbe").dataset.estado = estado;
  const etiquetas = {
    parada: "llamada colgada",
    escuchando: "te escucho",
    pensando: "pensando en el PC",
    hablando: "hablando",
  };
  $("#llamada-estado").textContent = etiquetas[estado] ?? estado;
  if (texto !== undefined) $("#llamada-texto").textContent = texto;
}

function escucharTurno() {
  if (!enLlamada) return;
  const rec = new Reconocedor();
  recLlamada = rec;
  rec.lang = "es-ES";
  rec.interimResults = true;
  rec.continuous = false;
  let dicho = "";
  estadoLlamada("escuchando", "");

  rec.onresult = (ev) => {
    let t = "";
    for (const res of ev.results) t += res[0].transcript;
    dicho = t;
    $("#llamada-texto").textContent = t;
  };
  rec.onerror = (ev) => {
    // "no-speech" y "aborted" son normales en un bucle: se reintenta en
    // silencio. Lo demás sí se dice, porque si no la llamada muere sin
    // explicación.
    if (!["no-speech", "aborted"].includes(ev.error)) {
      mostrarError(`llamada: ${ev.error}`);
    }
  };
  rec.onend = () => {
    recLlamada = null;
    if (!enLlamada) return estadoLlamada("parada");
    const texto = dicho.trim();
    if (!texto) return escucharTurno(); // no dijo nada: se vuelve a escuchar
    estadoLlamada("pensando", texto);
    preguntarAlPc(texto)
      .then((r) => {
        if (!enLlamada) return;
        estadoLlamada("hablando", r.text || "(sin respuesta)");
        pintarTurno("tú", texto, "yo");
        pintarTurno([r.provider, r.model].filter(Boolean).join(" · ") || "mar.ia", r.text, "asistente");
        leerEnVoz(r.text || "", () => enLlamada && escucharTurno());
      })
      .catch((e) => {
        mostrarError(String(e.message || e));
        colgar();
      });
  };
  rec.start();
}

function colgar() {
  enLlamada = false;
  try {
    recLlamada?.abort();
  } catch {
    // Ya estaba parado.
  }
  recLlamada = null;
  speechSynthesis.cancel();
  estadoLlamada("parada", "");
  $("#llamada-btn").textContent = "llamar a mar.ia";
  $("#llamada-btn").classList.remove("colgar");
}

$("#llamada-btn").addEventListener("click", () => {
  if (enLlamada) return colgar();
  if (!Reconocedor) {
    mostrarError("este navegador no sabe escuchar: usa la pestaña «hablar»");
    return;
  }
  if (!conexion.base || !conexion.token) {
    mostrarError("configura antes la conexión con el PC");
    irA("conexion");
    return;
  }
  enLlamada = true;
  $("#llamada-btn").textContent = "colgar";
  $("#llamada-btn").classList.add("colgar");
  escucharTurno();
});

// Si la app pasa a segundo plano, se cuelga: seguir con el micrófono abierto
// sin que se vea la pantalla no es algo que deba pasar sin pedirlo.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && enLlamada) colgar();
});

// --- estado ----------------------------------------------------------------

function fila(k, v) {
  return `<div class="fila"><span>${escapar(k)}</span><span class="v">${escapar(v)}</span></div>`;
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
    const orden = (d.relevo && d.relevo.order) || [];
    const partes = [
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
          </div>`
        : "",
      `<div class="panel"><h2>proveedores</h2>${orden
        .map((p) => {
          const e = prov[p];
          return fila(p, e ? `${e.status} · ${e.answered} resp.` : "sin usar");
        })
        .join("")}</div>`,
    ];
    $("#paneles").innerHTML = partes.join("");
    marcarEstado(true, "conectado");
  } catch (e) {
    marcarEstado(false, "sin conexión");
    $("#paneles").innerHTML = `<div class="panel"><p class="ayuda">${escapar(
      String(e.message || e),
    )}</p></div>`;
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

// --- conexión --------------------------------------------------------------

$("#base-url").value = conexion.base || "";
$("#token").value = conexion.token || "";

$("#probar").addEventListener("click", async () => {
  const base = $("#base-url").value.trim().replace(/\/+$/, "");
  const token = $("#token").value.trim();
  const salida = $("#conexion-resultado");
  if (!base || !token) {
    salida.textContent = "faltan la dirección o el token.";
    return;
  }
  if (location.protocol === "https:" && base.startsWith("http://")) {
    salida.textContent =
      "esa dirección es http y esta página es https: el navegador lo bloqueará. " +
      "Usa tailscale serve para tener un https, o abre la webapp que sirve el propio PC.";
    return;
  }
  salida.textContent = "probando…";
  const antes = conexion;
  conexion = { base, token };
  try {
    await api("/api/estado");
    guardarConexion(conexion);
    salida.textContent = "conectado y guardado.";
    marcarEstado(true, "conectado");
  } catch (e) {
    conexion = antes;
    salida.textContent = `no conecta: ${e.message || e}`;
    marcarEstado(false, "sin conexión");
  }
});

$("#olvidar").addEventListener("click", () => {
  conexion = { base: "", token: "" };
  try {
    localStorage.removeItem(CLAVE);
  } catch {
    // nada que olvidar
  }
  $("#base-url").value = "";
  $("#token").value = "";
  $("#conexion-resultado").textContent = "olvidado.";
  marcarEstado(false, "sin conectar");
});

/** Escapa para meter texto ajeno en innerHTML sin abrir un agujero. */
function escapar(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

// --- instalación -----------------------------------------------------------

let pedirInstalacion = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  pedirInstalacion = e;
  $("#instalar").classList.remove("oculta");
});
$("#instalar").addEventListener("click", async () => {
  if (!pedirInstalacion) return;
  pedirInstalacion.prompt();
  pedirInstalacion = null;
  $("#instalar").classList.add("oculta");
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Sin service worker la app funciona igual; solo no se instala ni
      // arranca sin red.
    });
  });
}

// --- arranque --------------------------------------------------------------

if (!conexion.base || !conexion.token) {
  irA("conexion");
  marcarEstado(false, "sin conectar");
} else {
  void cargarEstado();
}

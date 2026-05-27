/* =============================================================
   INSOBC Quiz — lógica del cuestionario
   - Carga preguntas desde data/questions.json
   - 20 preguntas por examen (por tema o mixto)
   - +1 acierto · -0.25 fallo · 0 sin responder
   - Modos: examen (corrección al final) y estudio (feedback inmediato)
   - Banco "Preguntas Falladas": las preguntas que fallas se guardan;
     al acertarlas en un examen posterior, se eliminan del banco.
   ============================================================= */

(function () {
  "use strict";

  // ----- Configuración -----
  const PENALTY_PER_WRONG = 0.25;        // se RESTA por fallar (un cuarto del valor de un acierto)

  // Lee el nº de preguntas seleccionado en los radios. "all" → todas las del pool.
  function questionsPerExam(poolSize) {
    const raw = document.querySelector('input[name="nq"]:checked')?.value || "20";
    if (raw === "all") return poolSize;
    return parseInt(raw, 10);
  }

  // ----- Estado -----
  const state = {
    bank: null,            // { topics: { Tx: { name, questions: [...] } } }
    topicId: null,         // "T1".."T7" o "MIX"
    mode: "exam",          // "exam" | "study"
    questions: [],         // 20 preguntas seleccionadas
    answers: [],           // index seleccionado o null
    locked: [],            // si la pregunta está bloqueada (study mode)
    current: 0,            // índice de pregunta actual
    finished: false,
  };

  // ----- Constantes -----
  const HISTORY_KEY = "insobcquiz.history.v1";
  const HISTORY_MAX = 100;
  const FAILED_KEY = "insobcquiz.failed.v1";

  // ----- DOM refs -----
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $("screenHome"),
    exam: $("screenExam"),
    results: $("screenResults"),
    history: $("screenHistory"),
    detail: $("screenHistoryDetail"),
  };

  // ============================================================
  //   CARGA DEL BANCO DE PREGUNTAS
  // ============================================================
  async function loadBank() {
    try {
      const res = await fetch("data/questions.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      state.bank = data;
      renderHome();
    } catch (err) {
      $("bankInfo").textContent = "❌ Error cargando preguntas: " + err.message +
        ". Sirve la web con un servidor local (no abrir el .html con doble click).";
      $("bankInfo").style.color = "var(--danger)";
    }
  }

  // ============================================================
  //   BANCO DE PREGUNTAS FALLADAS (localStorage)
  // ============================================================
  // Identificador estable de una pregunta — el texto del enunciado
  function questionKey(q) {
    return q.question;
  }

  function loadFailed() {
    try {
      const raw = localStorage.getItem(FAILED_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  function saveFailed(map) {
    try {
      localStorage.setItem(FAILED_KEY, JSON.stringify(map));
    } catch (e) {
      console.warn("No se pudo guardar el banco de falladas:", e);
    }
  }

  function failedCount() {
    return Object.keys(loadFailed()).length;
  }

  // Tras corregir un examen: añade las falladas al banco, elimina las acertadas.
  // Las en blanco no tocan el banco.
  function updateFailedBank() {
    const failed = loadFailed();
    state.questions.forEach((q, i) => {
      const a = state.answers[i];
      const key = questionKey(q);
      if (a === null) return;
      if (a === q.correct) {
        if (failed[key]) delete failed[key];
      } else {
        const opts = q.options.slice();
        const correctOption = opts[q.correct];
        const reordered = [correctOption, ...opts.filter((_, idx) => idx !== q.correct)];
        failed[key] = {
          question: q.question,
          options: reordered,
          correct: 0,
          explanation: q.explanation || null,
          code: q.code || null,
          _topic: q._topic || null,
          _origin: q._origin || q._topic || null,
          lastFailed: Date.now(),
          fails: (failed[key]?.fails || 0) + 1,
        };
      }
    });
    saveFailed(failed);
  }

  // ============================================================
  //   PANTALLA INICIO
  // ============================================================
  function renderHome() {
    const grid = $("topicGrid");
    grid.innerHTML = "";

    const topics = state.bank.topics;
    let total = 0;

    // Card mixto
    const mixCount = Object.values(topics).reduce((acc, t) => acc + t.questions.length, 0);
    total = mixCount;
    grid.appendChild(buildTopicCard("MIX", "🎲 Examen mixto", "Aleatorio de todos los temas", mixCount, "mix"));

    // Card de FALLADAS si hay alguna
    const fc = failedCount();
    if (fc > 0) {
      grid.appendChild(buildTopicCard(
        "FAILED",
        "❌ Preguntas falladas",
        "Solo las que has fallado · acertarlas las elimina del banco",
        fc,
        "failed"
      ));
    }

    // Por tema
    Object.entries(topics).forEach(([id, t]) => {
      grid.appendChild(buildTopicCard(id, t.name, id, t.questions.length, ""));
    });

    const fcText = fc > 0 ? ` · ❌ <b>${fc}</b> falladas pendientes` : "";
    $("bankInfo").innerHTML = `📚 Banco: <b>${total}</b> preguntas · ${Object.keys(topics).length} temas${fcText}`;
  }

  function buildTopicCard(id, title, label, count, kind) {
    const btn = document.createElement("button");
    let cls = "topicCard";
    if (kind === "mix") cls += " mixed";
    if (kind === "failed") cls += " failed";
    btn.className = cls;
    const plural = count === 1 ? "" : "s";
    btn.innerHTML = `
      <div class="topicLabel">${escapeHtml(label)}</div>
      <p class="topicTitle">${escapeHtml(title)}</p>
      <div class="topicCount">${count} pregunta${plural} disponible${plural}</div>
    `;
    btn.addEventListener("click", () => startExam(id));
    return btn;
  }

  // ============================================================
  //   ARRANCAR EXAMEN
  // ============================================================
  function startExam(topicId) {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    state.mode = mode;
    state.topicId = topicId;

    // Selección de preguntas
    let pool = [];
    if (topicId === "MIX") {
      pool = Object.values(state.bank.topics).flatMap((t) =>
        t.questions.map((q) => ({ ...q, _topic: t.name, _origin: t.name }))
      );
    } else if (topicId === "FAILED") {
      const failed = loadFailed();
      pool = Object.values(failed).map((q) => ({
        ...q,
        _topic: q._topic || "Falladas",
        _origin: q._origin || q._topic || "Falladas",
      }));
      if (pool.length === 0) {
        alert("No tienes preguntas falladas pendientes. Acierta todas y este banco se vacía 🎉");
        return;
      }
    } else {
      const t = state.bank.topics[topicId];
      pool = t.questions.map((q) => ({ ...q, _topic: t.name, _origin: t.name }));
    }

    const target = questionsPerExam(pool.length);
    if (pool.length < target && topicId !== "FAILED") {
      alert(`Solo hay ${pool.length} preguntas en este tema. Se mostrarán todas.`);
    }

    state.questions = shuffle(pool).slice(0, Math.min(target, pool.length)).map(shuffleOptions);
    state.answers = new Array(state.questions.length).fill(null);
    state.locked = new Array(state.questions.length).fill(false);
    state.current = 0;
    state.finished = false;

    showScreen("exam");
    let title;
    if (topicId === "MIX") title = "Examen mixto";
    else if (topicId === "FAILED") title = "❌ Preguntas falladas";
    else title = `${topicId} · ${state.bank.topics[topicId].name}`;
    $("examTitle").textContent = title;
    $("examModeTag").textContent = mode === "exam" ? "Modo examen" : "Modo estudio";
    $("stats").classList.remove("hidden");

    renderDots();
    renderQuestion();
    updateStats();
  }

  // ============================================================
  //   RENDER DE PREGUNTA
  // ============================================================
  function renderQuestion() {
    const q = state.questions[state.current];
    const card = $("questionCard");
    const total = state.questions.length;
    const idx = state.current;

    const codeBlock = q.code
      ? `<pre class="codeBlock">${escapeHtml(q.code)}</pre>`
      : "";

    card.innerHTML = `
      <div class="questionMeta">
        Pregunta ${idx + 1} de ${total}${q._topic ? " · " + escapeHtml(q._topic) : ""}
      </div>
      <p class="questionText">${escapeHtml(q.question)}</p>
      ${codeBlock}
      <div class="options" id="options"></div>
      <div id="feedback"></div>
    `;

    const opts = $("options");
    q.options.forEach((opt, i) => {
      const btn = document.createElement("button");
      btn.className = "option";
      btn.innerHTML = `
        <span class="letter">${"ABCD"[i]}</span>
        <span>${escapeHtml(opt)}</span>
      `;
      btn.addEventListener("click", () => selectOption(i));
      opts.appendChild(btn);
    });

    applySelectionUI();
    updateProgress();
    updateNavButtons();
  }

  function selectOption(i) {
    const idx = state.current;
    if (state.locked[idx]) return;

    // Permitir deseleccionar (toggle) — útil para "no responder"
    if (state.answers[idx] === i) {
      state.answers[idx] = null;
    } else {
      state.answers[idx] = i;
    }

    if (state.mode === "study" && state.answers[idx] !== null) {
      state.locked[idx] = true;
    }

    applySelectionUI();
    renderDots();
    updateStats();
    updateNavButtons();
  }

  function applySelectionUI() {
    const idx = state.current;
    const q = state.questions[idx];
    const sel = state.answers[idx];
    const locked = state.locked[idx];
    const optionsEl = document.querySelectorAll("#options .option");

    optionsEl.forEach((el, i) => {
      el.classList.remove("selected", "correct", "wrong", "locked");
      if (locked) el.classList.add("locked");

      if (locked) {
        if (i === q.correct) el.classList.add("correct");
        if (i === sel && sel !== q.correct) el.classList.add("wrong");
      } else if (sel === i) {
        el.classList.add("selected");
      }
    });

    const fb = $("feedback");
    if (locked && state.mode === "study") {
      const ok = sel === q.correct;
      fb.innerHTML = `
        <div class="feedback ${ok ? "ok" : "bad"}">
          <strong>${ok ? "✓ Correcto" : "✗ Incorrecto"}</strong>
          ${q.explanation ? escapeHtml(q.explanation) : (ok ? "Bien hecho." : `La respuesta correcta era <b>${"ABCD"[q.correct]}</b>: ${escapeHtml(q.options[q.correct])}.`)}
        </div>
      `;
    } else {
      fb.innerHTML = "";
    }
  }

  // ============================================================
  //   NAVEGACIÓN
  // ============================================================
  function nextQuestion() {
    if (state.current < state.questions.length - 1) {
      state.current++;
      renderQuestion();
      renderDots();
    }
  }
  function prevQuestion() {
    if (state.current > 0) {
      state.current--;
      renderQuestion();
      renderDots();
    }
  }
  function goTo(i) {
    state.current = i;
    renderQuestion();
    renderDots();
  }

  function updateNavButtons() {
    const last = state.current === state.questions.length - 1;
    $("btnPrev").disabled = state.current === 0;
    $("btnNext").classList.toggle("hidden", last);
    $("btnFinish").classList.toggle("hidden", !last);
  }

  function renderDots() {
    const wrap = $("dotIndex");
    wrap.innerHTML = "";
    state.questions.forEach((q, i) => {
      const d = document.createElement("button");
      d.className = "dot";
      if (state.answers[i] !== null) d.classList.add("answered");
      if (state.mode === "study" && state.locked[i]) {
        d.classList.remove("answered");
        d.classList.add(state.answers[i] === q.correct ? "correct" : "wrong");
      }
      if (i === state.current) d.classList.add("current");
      d.addEventListener("click", () => goTo(i));
      wrap.appendChild(d);
    });
  }

  function updateProgress() {
    const pct = ((state.current + 1) / state.questions.length) * 100;
    $("progressBar").style.width = pct + "%";
  }

  // Calcula la puntuación bruta: aciertos - 0.25 * fallos
  function computeScore(answers, questions) {
    let correct = 0, wrong = 0, blank = 0;
    answers.forEach((a, i) => {
      if (a === null) blank++;
      else if (a === questions[i].correct) correct++;
      else wrong++;
    });
    const score = correct - PENALTY_PER_WRONG * wrong;
    return { correct, wrong, blank, score };
  }

  // Formatea un número con decimales solo si los necesita (para mostrar -0.25 o +1)
  function fmtScore(n) {
    const sign = n >= 0 ? "+" : "";
    // mostramos hasta 2 decimales pero quitamos ceros sobrantes
    const fixed = Number(n.toFixed(2));
    return sign + fixed;
  }

  function updateStats() {
    const answered = state.answers.filter((a) => a !== null).length;
    $("statQuestion").textContent = `Pregunta ${state.current + 1}/${state.questions.length}`;

    if (state.mode === "study") {
      const { score } = computeScore(state.answers, state.questions);
      $("statScore").textContent = `Puntos: ${fmtScore(score)}`;
    } else {
      $("statScore").textContent = `Respondidas: ${answered}/${state.questions.length}`;
    }
  }

  // ============================================================
  //   FINALIZAR
  // ============================================================
  function finishExam() {
    state.finished = true;
    showScreen("results");
    $("stats").classList.add("hidden");
    saveCurrentExamToHistory();
    updateFailedBank();              // ← actualiza banco de falladas
    renderResults();
  }

  // ============================================================
  //   HISTORIAL (localStorage)
  // ============================================================
  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch (e) {
      console.warn("No se pudo guardar el historial:", e);
    }
  }

  function saveCurrentExamToHistory() {
    const total = state.questions.length;
    const { correct, wrong, blank, score } = computeScore(state.answers, state.questions);
    const grade = Math.max(0, (score / total) * 10);

    let topicName;
    if (state.topicId === "MIX") topicName = "Examen mixto";
    else if (state.topicId === "FAILED") topicName = "❌ Preguntas falladas";
    else topicName = state.bank.topics[state.topicId]?.name || state.topicId;

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
      topicId: state.topicId,
      topicName,
      mode: state.mode,
      total,
      correct,
      wrong,
      blank,
      score,
      grade,
      questions: state.questions.map((q, i) => ({
        question: q.question,
        code: q.code || null,
        options: q.options,
        correct: q.correct,
        explanation: q.explanation || null,
        userAnswer: state.answers[i],
        topic: q._topic || null,
      })),
    };

    const history = loadHistory();
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    saveHistory(history);
  }

  function renderHistory() {
    const history = loadHistory();
    const stats = $("historyStats");
    const list = $("historyList");

    if (history.length === 0) {
      stats.innerHTML = "";
      list.innerHTML = `
        <div class="historyEmpty">
          <div class="icon">📋</div>
          <p>Aún no has hecho ningún examen.<br>Vuelve al inicio y elige uno.</p>
        </div>
      `;
      return;
    }

    // Estadísticas globales
    const totalExams = history.length;
    const avgGrade = history.reduce((s, e) => s + e.grade, 0) / totalExams;
    const bestGrade = Math.max(...history.map(e => e.grade));
    const totalCorrect = history.reduce((s, e) => s + e.correct, 0);
    const totalQuestions = history.reduce((s, e) => s + e.total, 0);
    const accuracy = totalQuestions ? (totalCorrect / totalQuestions) * 100 : 0;

    stats.innerHTML = `
      <div class="historyStat"><div class="num">${totalExams}</div><div class="label">Exámenes</div></div>
      <div class="historyStat"><div class="num">${avgGrade.toFixed(1)}</div><div class="label">Nota media</div></div>
      <div class="historyStat"><div class="num">${bestGrade.toFixed(1)}</div><div class="label">Mejor nota</div></div>
      <div class="historyStat"><div class="num">${accuracy.toFixed(0)}%</div><div class="label">Aciertos</div></div>
      <div class="historyStat"><div class="num">${failedCount()}</div><div class="label">Falladas pendientes</div></div>
    `;

    list.innerHTML = "";
    history.forEach((e) => {
      const item = document.createElement("button");
      item.className = "historyItem";
      const date = new Date(e.timestamp);
      const dateStr = date.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
      const timeStr = date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
      const isMix = e.topicId === "MIX";
      const isFailed = e.topicId === "FAILED";
      const scoreClass = e.score < 0 ? "bad" : (e.score >= e.total * 0.6 ? "ok" : "mid");
      const badgeText = isMix ? "🎲 MIX" : (isFailed ? "❌ FAIL" : escapeHtml(e.topicId));
      item.innerHTML = `
        <span class="badge ${isMix ? "mix" : ""}">${badgeText}</span>
        <div>
          <div class="topicName">${escapeHtml(e.topicName)}</div>
          <div class="meta">${dateStr} · ${timeStr} · ${e.mode === "study" ? "Modo estudio" : "Modo examen"} · ✓${e.correct} ✗${e.wrong} ○${e.blank}</div>
        </div>
        <div class="score ${scoreClass}">${fmtScore(e.score)}</div>
        <div class="grade">${e.grade.toFixed(2)}<br>/10</div>
      `;
      item.addEventListener("click", () => openHistoryDetail(e.id));
      list.appendChild(item);
    });
  }

  function openHistoryDetail(id) {
    const history = loadHistory();
    const entry = history.find((e) => e.id === id);
    if (!entry) return;

    showScreen("detail");

    const date = new Date(entry.timestamp);
    const dateStr = date.toLocaleString("es-ES", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
    $("detailTitle").textContent = entry.topicName;

    const scoreClass = entry.score < 0 ? "bad" : (entry.score >= entry.total * 0.6 ? "ok" : "");
    $("detailHero").innerHTML = `
      <h2>Resultado guardado</h2>
      <div class="bigScore ${scoreClass}">${fmtScore(entry.score)} / ${entry.total}</div>
      <p class="breakdown">
        ✓ <b>${entry.correct}</b> aciertos · ✗ <b>${entry.wrong}</b> fallos · ○ <b>${entry.blank}</b> sin responder
      </p>
      <p class="grade">Nota: <b>${entry.grade.toFixed(2)}/10</b> · ${dateStr}</p>
    `;

    const review = $("detailReview");
    review.innerHTML = "";
    entry.questions.forEach((q, i) => {
      const a = q.userAnswer;
      const status = a === null ? "skip" : a === q.correct ? "ok" : "bad";
      const item = document.createElement("div");
      item.className = "reviewItem " + status;
      const correctTxt = `<b>${"ABCD"[q.correct]}</b>: ${escapeHtml(q.options[q.correct])}`;
      const userTxt = a === null
        ? "<span style='color:var(--warn)'>(sin responder)</span>"
        : `<b>${"ABCD"[a]}</b>: ${escapeHtml(q.options[a])}`;
      item.innerHTML = `
        <div class="qnum">Pregunta ${i + 1}${q.topic ? " · " + escapeHtml(q.topic) : ""}</div>
        <p class="qtxt">${escapeHtml(q.question)}</p>
        ${q.code ? `<code>${escapeHtml(q.code)}</code>` : ""}
        <div class="ans">Tu respuesta: ${userTxt}</div>
        <div class="ans">Correcta: ${correctTxt}</div>
        ${q.explanation ? `<div class="ans" style="margin-top:8px">💡 ${escapeHtml(q.explanation)}</div>` : ""}
      `;
      review.appendChild(item);
    });
  }

  function renderResults() {
    const total = state.questions.length;
    const { correct, wrong, blank, score } = computeScore(state.answers, state.questions);
    const grade = Math.max(0, (score / total) * 10);

    const big = $("resultBigScore");
    big.textContent = `${fmtScore(score)} / ${total}`;
    big.classList.remove("ok", "bad");
    if (score >= total * 0.6) big.classList.add("ok");
    else if (score < 0) big.classList.add("bad");

    const fc = failedCount();
    const failedNote = state.topicId === "FAILED"
      ? `<br><small style="opacity:.85">📥 Falladas pendientes en banco: <b>${fc}</b></small>`
      : (fc > 0 ? `<br><small style="opacity:.7">📥 Falladas pendientes en banco: <b>${fc}</b></small>` : "");
    $("resultBreakdown").innerHTML = `
      ✓ <b>${correct}</b> aciertos &nbsp;·&nbsp;
      ✗ <b>${wrong}</b> fallos &nbsp;·&nbsp;
      ○ <b>${blank}</b> sin responder
      <br><small style="opacity:.7">Cada fallo resta ${PENALTY_PER_WRONG} (un cuarto). Sin responder no resta.</small>
      ${failedNote}
    `;
    $("resultGrade").innerHTML = `Nota equivalente: <b>${grade.toFixed(2)}/10</b>`;

    // Construir review
    const review = $("reviewList");
    review.innerHTML = "";
    state.questions.forEach((q, i) => {
      const a = state.answers[i];
      const status = a === null ? "skip" : a === q.correct ? "ok" : "bad";
      const item = document.createElement("div");
      item.className = "reviewItem " + status;
      const correctTxt = `<b>${"ABCD"[q.correct]}</b>: ${escapeHtml(q.options[q.correct])}`;
      const userTxt = a === null
        ? "<span style='color:var(--warn)'>(sin responder)</span>"
        : `<b>${"ABCD"[a]}</b>: ${escapeHtml(q.options[a])}`;
      item.innerHTML = `
        <div class="qnum">Pregunta ${i + 1}${q._topic ? " · " + escapeHtml(q._topic) : ""}</div>
        <p class="qtxt">${escapeHtml(q.question)}</p>
        ${q.code ? `<code>${escapeHtml(q.code)}</code>` : ""}
        <div class="ans">Tu respuesta: ${userTxt}</div>
        <div class="ans">Correcta: ${correctTxt}</div>
        ${q.explanation ? `<div class="ans" style="margin-top:8px">💡 ${escapeHtml(q.explanation)}</div>` : ""}
      `;
      review.appendChild(item);
    });
  }

  // ============================================================
  //   UTILIDADES
  // ============================================================
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function shuffleOptions(q) {
    // Mezcla las opciones manteniendo el índice "correct" actualizado
    const indices = q.options.map((_, i) => i);
    const shuffled = shuffle(indices);
    return {
      ...q,
      options: shuffled.map((i) => q.options[i]),
      correct: shuffled.indexOf(q.correct),
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => {
      el.classList.toggle("hidden", k !== name);
    });
    // Botón historial visible solo en home
    const homeOnly = $("btnHistory");
    if (homeOnly) homeOnly.classList.toggle("hidden", name !== "home");
    if (name === "home" && state.bank) renderHome();   // refresca tarjeta FAILED tras un examen
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ============================================================
  //   EVENTOS GLOBALES
  // ============================================================
  $("btnNext").addEventListener("click", nextQuestion);
  $("btnPrev").addEventListener("click", prevQuestion);
  $("btnFinish").addEventListener("click", () => {
    const unanswered = state.answers.filter((a) => a === null).length;
    if (unanswered > 0) {
      if (!confirm(`Tienes ${unanswered} pregunta(s) sin responder (no restan). ¿Corregir igualmente?`)) return;
    }
    finishExam();
  });
  $("btnExit").addEventListener("click", () => {
    if (!confirm("¿Salir del examen? Perderás el progreso.")) return;
    showScreen("home");
    $("stats").classList.add("hidden");
  });
  $("btnHome").addEventListener("click", () => showScreen("home"));
  $("btnRetry").addEventListener("click", () => startExam(state.topicId));
  $("btnHistory").addEventListener("click", () => {
    renderHistory();
    showScreen("history");
  });
  $("btnHistoryBack").addEventListener("click", () => showScreen("home"));
  $("btnDetailBack").addEventListener("click", () => {
    renderHistory();
    showScreen("history");
  });
  $("btnClearHistory").addEventListener("click", () => {
    if (!confirm("¿Borrar TODO el historial de exámenes? Esta acción no se puede deshacer.")) return;
    saveHistory([]);
    renderHistory();
  });
  $("btnReview").addEventListener("click", () => {
    const list = $("reviewList");
    list.classList.toggle("hidden");
    $("btnReview").textContent = list.classList.contains("hidden") ? "Ver corrección" : "Ocultar corrección";
  });

  // Atajos teclado
  document.addEventListener("keydown", (e) => {
    if (screens.exam.classList.contains("hidden")) return;
    if (["1", "2", "3", "4"].includes(e.key)) {
      const i = parseInt(e.key, 10) - 1;
      if (i < (state.questions[state.current]?.options.length || 0)) selectOption(i);
    } else if (e.key === "ArrowRight") nextQuestion();
    else if (e.key === "ArrowLeft") prevQuestion();
  });

  // ----- Init -----
  loadBank();
})();

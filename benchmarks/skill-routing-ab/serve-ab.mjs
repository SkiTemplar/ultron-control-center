/**
 * serve-ab.mjs — jurado ciego local para la evaluacion de skill routing.
 *
 * Sirve en 127.0.0.1 los casos de arms.json: prompt real arriba, propuestas
 * barajadas debajo SIN decir de que brazo sale cada una. El voto se guarda en
 * votes.json y solo despues, al agregar, se cruza con la identidad del brazo.
 *
 * POR QUE CIEGO: el golden etiquetado a mano de julio premiaba lo que el
 * propio sistema producia (46% agent_note) y salio 0.479 de recall util. Aqui
 * el juicio no puede contaminarse porque el jurado no sabe quien propone.
 *
 * Teclas: 1..n eligen propuesta, 0 = ninguna sirve, s = saltar, ← retrocede.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const DIR = import.meta.dirname;
const PUERTO = Number(process.env.AB_PORT || 7788);
const VOTOS = path.join(DIR, 'votes.json');

const { filas } = JSON.parse(fs.readFileSync(path.join(DIR, 'arms.json'), 'utf8'));
// Solo se vota lo que tiene algo que votar: un caso donde ningun brazo propone
// nada no distingue brazos, y hacerlo pasar por el jurado solo gasta su tiempo.
const casos = filas.filter((f) => f.opciones.length > 0).map((f) => ({
  id: f.id, prompt: f.prompt, proyecto: f.proyecto,
  opciones: f.opciones.map((o) => ({ key: o.key, skills: o.skills, desc: o.desc })),
}));

function leerVotos() {
  try { return JSON.parse(fs.readFileSync(VOTOS, 'utf8')); } catch { return {}; }
}

const HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Jurado ciego — skill routing</title><style>
:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--card:#161b22;--bd:#30363d;--ac:#58a6ff;--ok:#3fb950}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,Segoe UI,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:24px}
.top{display:flex;justify-content:space-between;align-items:center;color:var(--mut);font-size:13px;margin-bottom:14px}
.bar{height:4px;background:var(--bd);border-radius:2px;overflow:hidden;margin-bottom:20px}.bar i{display:block;height:100%;background:var(--ac)}
.prompt{background:var(--card);border:1px solid var(--bd);border-left:3px solid var(--ac);border-radius:8px;padding:16px;white-space:pre-wrap;max-height:340px;overflow:auto}
.meta{color:var(--mut);font-size:12px;margin:8px 2px 18px}
.op{display:flex;gap:12px;width:100%;text-align:left;background:var(--card);border:1px solid var(--bd);color:var(--fg);border-radius:8px;padding:14px;margin-bottom:10px;cursor:pointer;font:inherit}
.op:hover{border-color:var(--ac)}.num{flex:0 0 26px;height:26px;border-radius:6px;background:var(--bd);display:grid;place-items:center;font-size:13px;color:var(--mut)}
.sk{font-weight:600}.dsc{color:var(--mut);font-size:12.5px;margin-top:3px}
.none{border-style:dashed}.done{text-align:center;padding:60px 0}
kbd{background:var(--bd);border-radius:4px;padding:1px 6px;font-size:12px}
</style></head><body><div class="wrap">
<div class="top"><span id="cnt"></span><span><kbd>1..n</kbd> elegir · <kbd>0</kbd> ninguna · <kbd>s</kbd> saltar</span></div>
<div class="bar"><i id="pb" style="width:0"></i></div>
<div id="app"></div></div>
<script>
let casos=[],votos={},i=0;
const $=(s)=>document.querySelector(s);
async function cargar(){const r=await fetch('/data');const d=await r.json();casos=d.casos;votos=d.votos;i=casos.findIndex(c=>!votos[c.id]);if(i<0)i=casos.length;pintar();}
function pintar(){
 const n=Object.keys(votos).length;$('#cnt').textContent=n+' / '+casos.length+' votados';
 $('#pb').style.width=(100*n/casos.length)+'%';
 if(i>=casos.length){$('#app').innerHTML='<div class="done"><h2>Listo.</h2><p style="color:var(--mut)">Cierra y ejecuta <code>node score.mjs</code></p></div>';return;}
 const c=casos[i];
 $('#app').innerHTML='<div class="prompt">'+esc(c.prompt)+'</div><div class="meta">'+esc(c.proyecto)+' · '+esc(c.id)+'</div>'+
  c.opciones.map((o,k)=>'<button class="op" data-k="'+o.key+'"><span class="num">'+(k+1)+'</span><span><span class="sk">'+o.skills.map(esc).join(' + ')+'</span><span class="dsc">'+o.desc.map(esc).join(' — ').slice(0,220)+'</span></span></button>').join('')+
  '<button class="op none" data-k="ninguna"><span class="num">0</span><span><span class="sk">Ninguna sirve</span><span class="dsc">Para este prompt no hay skill que aporte; mejor no sugerir nada.</span></span></button>';
 document.querySelectorAll('.op').forEach(b=>b.onclick=()=>votar(b.dataset.k));
}
function esc(s){return (s||'').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}
async function votar(k){const c=casos[i];votos[c.id]=k;await fetch('/vote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:c.id,eleccion:k})});i++;pintar();}
document.addEventListener('keydown',e=>{
 if(i>=casos.length)return;const c=casos[i];
 if(e.key==='s'){i++;pintar();return;}
 if(e.key==='0'){votar('ninguna');return;}
 const n=parseInt(e.key,10);if(n>=1&&n<=c.opciones.length)votar(c.opciones[n-1].key);
});
cargar();
</script></body></html>`;

http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HTML); }
  if (req.url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ casos, votos: leerVotos() }));
  }
  if (req.url === '/vote' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const { id, eleccion } = JSON.parse(body);
        const v = leerVotos();
        v[id] = eleccion;
        fs.writeFileSync(VOTOS, JSON.stringify(v, null, 2));
      } catch { /* un voto perdido no tumba la sesion de votacion */ }
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PUERTO, '127.0.0.1', () => {
  console.log(`Jurado ciego: http://127.0.0.1:${PUERTO}   (${casos.length} casos con propuesta)`);
});

// Shader del blob de mar.ia.
//
// WebGL crudo a proposito: un unico quad a pantalla completa con un fragment
// shader. Meter three.js + React Three Fiber para dibujar UNA esfera anadiria
// ~1 MB al bundle y un arbol de dependencias entero para algo que cabe en 80
// lineas de GLSL.
//
// El blob es un campo de distancia radial deformado por ruido fbm y coloreado
// con una paleta azul. Todo el movimiento sale de tres uniformes:
//   uTime   — reloj continuo (respiracion)
//   uAmp    — nivel del microfono 0..1 (late con tu voz)
//   uState  — 0 dormido · 1 escuchando · 2 pensando · 3 hablando

export const VERT_SRC = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const FRAG_SRC = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uAmp;
uniform float uState;

// Ruido de valor + fbm. Barato y suficiente: el blob se ve pequeno.
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / min(uRes.x, uRes.y);
  float r = length(uv);
  float ang = atan(uv.y, uv.x);

  // Velocidad y turbulencia por estado: dormido respira, pensando hierve,
  // hablando ondula (el nivel viene en uAmp desde el sidecar).
  float speed = uState < 0.5 ? 0.22 : (uState < 1.5 ? 0.6 : (uState < 2.5 ? 1.5 : 1.15));
  float churn = uState < 0.5 ? 0.35 : (uState < 1.5 ? 0.7 : (uState < 2.5 ? 1.25 : 1.05));
  float hablando = step(2.5, uState);

  float t = uTime * speed;
  // Deformacion del borde: ruido en coordenadas polares -> nada de "pelota".
  float wob = fbm(vec2(cos(ang), sin(ang)) * 2.1 + t) - 0.5;
  float breathe = 0.035 * sin(uTime * 1.1);
  float radius = 0.52 + breathe + wob * 0.16 * churn + uAmp * 0.20;

  // Al hablar, ondas concentricas que salen del nucleo: es lo que hace que se
  // LEA como una voz y no como un blob mas rapido. Sin esto, hablar y
  // escuchar se veian casi igual.
  float ondas = 0.0;
  if (hablando > 0.5) {
    float fase = r * 16.0 - uTime * 5.0;
    ondas = sin(fase) * 0.5 + 0.5;
    ondas *= exp(-2.2 * r) * (0.25 + uAmp * 0.9);
  }

  // Cuerpo con borde suave + halo exterior.
  float body = smoothstep(radius, radius - 0.20, r);
  float rim  = smoothstep(radius + 0.02, radius - 0.06, r) - smoothstep(radius - 0.06, radius - 0.24, r);
  float halo = exp(-2.6 * max(r - radius, 0.0) * 6.0) * 0.55;

  // Paleta: azul profundo -> cian. El estado sube el brillo interior.
  vec3 deep = vec3(0.04, 0.16, 0.45);
  vec3 mid  = vec3(0.10, 0.45, 0.92);
  vec3 hot  = vec3(0.55, 0.92, 1.00);
  float inner = fbm(uv * 2.6 + vec2(t * 0.6, -t * 0.4));
  vec3 col = mix(deep, mid, smoothstep(0.15, 0.85, inner));
  col = mix(col, hot, rim * (0.55 + uAmp * 0.8));
  col += hot * halo * (0.35 + uAmp * 0.5);
  col += hot * ondas * body;

  float alpha = clamp(body + halo * 0.9, 0.0, 1.0);
  // Sin premultiplicar: el canvas se compone sobre una ventana transparente.
  fragColor = vec4(col * alpha, alpha);
}
`;

/** Estados visuales del orbe. El numero es el que viaja al shader. */
export const ORB_STATE = {
  idle: 0,
  listening: 1,
  thinking: 2,
  speaking: 3,
} as const;

export type OrbState = keyof typeof ORB_STATE;

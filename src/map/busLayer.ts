import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import { Fleet, ORIGIN } from '../live/fleet';

/**
 * Buses en una capa WebGL propia (decisiones/005): un quad instanciado por bus, forma y estado en el
 * shader con campos de distancia. Tamaño en píxeles con un mínimo legible y, al acercarse, a escala
 * real (18 m un articulado). Coordenadas relativas a un origen en Bogotá para no perder precisión.
 */

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_pos;
layout(location=2) in vec2 a_dir;
layout(location=3) in vec4 a_color;
layout(location=4) in float a_size;
layout(location=5) in float a_flags;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_ppm;
uniform float u_dpr;
uniform float u_zf;
out vec2 v_local;
out vec2 v_half;
out vec4 v_color;
out float v_flags;
out float v_pad;
out float v_tail;

void main() {
  float flags = a_flags;
  bool dim = mod(flags, 2.0) >= 1.0;
  bool selected = mod(floor(flags / 4.0), 2.0) >= 1.0;
  vec4 c0 = u_matrix * vec4(a_pos, 0.0, 1.0);
  vec4 c1 = u_matrix * vec4(a_pos + a_dir * 2e-6, 0.0, 1.0);
  vec2 s0 = c0.xy / c0.w * u_viewport * 0.5;
  vec2 s1 = c1.xy / c1.w * u_viewport * 0.5;
  vec2 d = s1 - s0;
  vec2 fwd = length(d) > 1e-6 ? normalize(d) : vec2(1.0, 0.0);
  vec2 side = vec2(-fwd.y, fwd.x);
  float k = dim ? 0.78 : 1.0;
  // Mínimos legibles que crecen con el zoom (u_zf: 0 en z10, 1 en z15); más cerca, escala real.
  float minLen = mix(7.0, 18.0, u_zf) * mix(0.72, 1.0, a_size);
  float minWid = mix(4.5, 10.0, u_zf) * mix(0.86, 1.0, a_size);
  float len = max(minLen * u_dpr, 18.0 * a_size * u_ppm) * k;
  float wid = max(minWid * u_dpr, 2.55 * u_ppm) * k;
  float pad = (selected ? 9.0 : 2.0) * u_dpr;
  bool trail = mod(floor(flags / 16.0), 2.0) >= 1.0;
  // Con estela, el quad se alarga hacia atrás: la cola ocupa ~3 largos de bus, mínimo 36 px.
  float tail = trail ? max(36.0 * u_dpr, len * 3.0) : 0.0;
  vec2 h = vec2(len * 0.5 + pad, wid * 0.5 + pad);
  float x0 = -h.x - tail, x1 = h.x;
  float lx = a_corner.x < 0.0 ? x0 : x1;
  vec2 off = fwd * lx + side * a_corner.y * h.y;
  gl_Position = vec4((s0 + off) / (u_viewport * 0.5) * c0.w, c0.z, c0.w);
  v_local = vec2(lx, a_corner.y * h.y);
  v_tail = tail;
  v_half = vec2(len, wid) * 0.5;
  v_color = a_color;
  v_flags = flags;
  v_pad = pad;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_half;
in vec4 v_color;
in float v_flags;
in float v_pad;
in float v_tail;
uniform float u_dpr;
out vec4 frag;

// Distancia con signo (px) a la silueta: cuerpo recto y trompa que se angosta en el 30 % delantero.
float body(vec2 p, vec2 h) {
  float nose = h.x * 0.4;
  float x0 = h.x - nose;
  float w = h.y * (p.x > x0 ? mix(1.0, 0.38, (p.x - x0) / nose) : 1.0);
  return max(abs(p.x) - h.x, abs(p.y) - w);
}

void main() {
  float flags = v_flags;
  bool dim = mod(flags, 2.0) >= 1.0;
  bool stale = mod(floor(flags / 2.0), 2.0) >= 1.0;
  bool selected = mod(floor(flags / 4.0), 2.0) >= 1.0;
  bool hover = mod(floor(flags / 8.0), 2.0) >= 1.0;
  bool focused = mod(floor(flags / 32.0), 2.0) >= 1.0;
  vec3 base = v_color.rgb;
  vec3 streak = base;
  // Bus de la ruta en foco: cuerpo claro, para leerse sobre su propio trazo resaltado.
  if (focused || selected) base = mix(base, vec3(0.96), 0.62);
  if (dim) base = mix(vec3(0.16, 0.18, 0.21), base, 0.28);
  if (hover) base = mix(base, vec3(1.0), 0.28);
  float d = body(v_local, v_half);
  float aa = 0.75 * u_dpr;
  float edge = 1.5 * u_dpr;
  // Relleno con borde oscuro de 1 px que separa el bus de su propia línea.
  float inside = clamp(0.5 - d / aa, 0.0, 1.0);
  float fill = clamp(0.5 - (d + edge) / aa, 0.0, 1.0);
  // Borde oscuro: separa el bus de su propia línea (que a escala de ciudad va a media intensidad).
  vec3 col = mix(vec3(0.027, 0.035, 0.043), base, fill);
  float alpha = inside;
  if (selected) {
    // Escuadras en las cuatro esquinas, a 5 px del cuerpo.
    vec2 q = abs(v_local);
    vec2 r = v_half + 5.0 * u_dpr;
    float t = 1.4 * u_dpr, arm = 5.0 * u_dpr;
    bool hBar = abs(q.y - r.y) < t && q.x > r.x - arm && q.x < r.x + t;
    bool vBar = abs(q.x - r.x) < t && q.y > r.y - arm && q.y < r.y + t;
    if ((hBar || vBar) && inside < 0.5) { col = vec3(0.93); alpha = 1.0; }
  }
  if (v_tail > 0.0 && inside < 0.01) {
    // Estela: franja angosta del color de la ruta que se desvanece hacia atrás.
    float back = -v_local.x - v_half.x;
    if (back > 0.0 && back < v_tail && abs(v_local.y) < v_half.y * 0.45) {
      col = streak;
      alpha = 0.6 * pow(1.0 - back / v_tail, 1.6);
    }
  }
  alpha *= v_color.a * (stale ? 0.45 : 1.0) * (dim ? 0.85 : 1.0);
  if (alpha < 0.01) discard;
  frag = vec4(col * alpha, alpha);
}`;

export class BusLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  // '3d': comparte el búfer de profundidad con edificios y viaducto, que tapan a los buses que pasan
  // detrás o debajo. En 2D (sin inclinación) no hay nada con altura y el resultado es el mismo.
  readonly renderingMode = '3d' as const;
  private gl!: WebGL2RenderingContext;
  private prog!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private inst!: WebGLBuffer;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private map!: MLMap;
  private frames: number[] = [];
  onFrame?: () => void;

  /** `main`: todos salvo los atenuados; `dim`: solo los atenuados (van debajo de la ruta en foco). */
  constructor(private fleet: Fleet, private only: 'all' | 'dim' | 'main' = 'all') {
    this.id = only === 'dim' ? 'buses-dim' : 'buses';
  }

  onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl as WebGL2RenderingContext;
    const g = this.gl;
    const sh = (type: number, src: string) => {
      const s = g.createShader(type)!;
      g.shaderSource(s, src);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = g.createProgram()!;
    g.attachShader(p, sh(g.VERTEX_SHADER, VS));
    g.attachShader(p, sh(g.FRAGMENT_SHADER, FS));
    g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? 'link');
    this.prog = p;
    for (const n of ['u_matrix', 'u_viewport', 'u_ppm', 'u_dpr', 'u_zf']) this.u[n] = g.getUniformLocation(p, n);

    this.vao = g.createVertexArray()!;
    g.bindVertexArray(this.vao);
    const quad = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, quad);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    this.inst = g.createBuffer()!;
    g.bindBuffer(g.ARRAY_BUFFER, this.inst);
    const S = Fleet.STRIDE * 4;
    const attr = (loc: number, size: number, offset: number) => {
      g.enableVertexAttribArray(loc);
      g.vertexAttribPointer(loc, size, g.FLOAT, false, S, offset * 4);
      g.vertexAttribDivisor(loc, 1);
    };
    attr(1, 2, 0); // posición
    attr(2, 2, 2); // rumbo
    attr(3, 4, 4); // color + alfa
    attr(4, 1, 8); // tamaño
    attr(5, 1, 9); // banderas
    g.bindVertexArray(null);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    const g = gl as WebGL2RenderingContext;
    const now = Date.now();
    const moving = this.fleet.update(now);
    const { data, count } = this.fleet.fill(now, this.only);
    if (count) {
      g.useProgram(this.prog);
      // Matriz × traslación al origen, en float64 antes de pasar a float32.
      // `mainMatrix` proyecta mercator 0–1 a recorte (proyección mercator; ver tipos de MapLibre 6).
      const m = opts.defaultProjectionData.mainMatrix as unknown as ArrayLike<number>;
      const [ox, oy] = ORIGIN;
      const mm = new Float32Array(16);
      for (let i = 0; i < 16; i++) mm[i] = m[i];
      for (let r = 0; r < 4; r++) mm[12 + r] = m[r] * ox + m[4 + r] * oy + m[12 + r];
      g.uniformMatrix4fv(this.u.u_matrix, false, mm);
      g.uniform2f(this.u.u_viewport, g.drawingBufferWidth, g.drawingBufferHeight);
      const dpr = window.devicePixelRatio || 1;
      const lat = (this.map.getCenter().lat * Math.PI) / 180;
      const ppm = (dpr * 512 * Math.pow(2, this.map.getZoom())) / (40_075_016.686 * Math.cos(lat));
      g.uniform1f(this.u.u_ppm, ppm);
      g.uniform1f(this.u.u_dpr, dpr);
      g.uniform1f(this.u.u_zf, Math.min(1, Math.max(0, (this.map.getZoom() - 10) / 5)));
      g.bindBuffer(g.ARRAY_BUFFER, this.inst);
      g.bufferData(g.ARRAY_BUFFER, data.subarray(0, count * Fleet.STRIDE), g.DYNAMIC_DRAW);
      g.bindVertexArray(this.vao);
      g.enable(g.BLEND);
      g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
      // Prueba de profundidad sin escribir: los buses no se tapan entre sí por profundidad (el orden del
      // buffer ya pone al seleccionado encima), pero sí los tapa lo que tiene altura.
      g.enable(g.DEPTH_TEST);
      g.depthFunc(g.LEQUAL);
      g.depthMask(false);
      g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, count);
      g.bindVertexArray(null);
    }
    this.frames.push(performance.now());
    if (this.frames.length > 120) this.frames.shift();
    this.onFrame?.();
    // Mientras algo se mueva (o se esté desvaneciendo), se piden más cuadros; quieto, no se gasta GPU.
    if (moving || this.fleet.animating(now)) this.map.triggerRepaint();
  }

  /** Cuadros por segundo de los últimos dos segundos (para pruebas). */
  fps(): number {
    const f = this.frames;
    if (f.length < 2) return 0;
    return Math.round(((f.length - 1) * 1000) / (f[f.length - 1] - f[0]));
  }

  onRemove() {
    this.gl.deleteProgram(this.prog);
    this.gl.deleteBuffer(this.inst);
    this.gl.deleteVertexArray(this.vao);
  }
}

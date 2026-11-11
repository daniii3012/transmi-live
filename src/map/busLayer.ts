import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import { Fleet, ORIGIN } from '../live/fleet';
import { KX, KY } from '../domain/geo';
import { BusBodies } from './busBodies';

/**
 * Buses en una capa WebGL propia (decisiones/005), revisión R2:
 *
 *  - Apoyados en el suelo: las esquinas se calculan en coordenadas mercator, así que en 3D el bus se
 *    inclina con la calle en vez de quedar plano frente a la cámara.
 *  - Dos escalas, sin píldoras: lejos, un punto; de cerca, la huella del bus vista desde arriba
 *    (rectángulo de esquinas cortas, parabrisas al frente y las articulaciones del articulado y del
 *    biarticulado). Sin flecha de rumbo (con el anillo de foco parecía un pin de lugar).
 *    El paso entre punto y huella es un morfismo de distancias con signo, no un fundido.
 *  - Separación del trazado: halo del color del fondo y una sombra corta; la línea de la ruta no
 *    tapa al bus aunque sea del mismo color.
 *  - Ondas breves, lentas y redondas (HIG: «movimiento breve y preciso», nada en lo que pasa cada
 *    rato): solo el bus seguido, los próximos en llegar a la estación abierta y, al llegar una lectura,
 *    los de la ruta en foco. Nada con `prefers-reduced-motion`.
 *  - Prueba de profundidad compartida: edificios y viaducto los tapan.
 *
 * Rendimiento: cuadros según el zoom (a escala de ciudad un bus avanza menos de un píxel por cuadro) y
 * solo los buses a la vista.
 */

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_pos;
layout(location=2) in vec2 a_dir;
layout(location=3) in vec4 a_color;
layout(location=4) in float a_size;
layout(location=5) in float a_flags;
layout(location=6) in float a_ping;
layout(location=7) in float a_elev;   // altura sobre un puente (m)
uniform mat4 u_matrix;
uniform float u_mpp;
uniform float u_ppm;
uniform float u_zf;
out vec2 v_local;
out vec2 v_foot;
out float v_r;
out vec4 v_color;
out float v_flags;
out float v_tail;
out float v_size;
out float v_ping;

bool bit(float f, float b) { return mod(floor(f / b), 2.0) >= 1.0; }

void main() {
  float flags = a_flags;
  bool dim = bit(flags, 1.0);
  bool selected = bit(flags, 4.0);
  float tailK = floor(flags / 256.0) / 15.0; // largo de la estela (0–1; 0: sin estela)
  bool focused = bit(flags, 32.0);
  bool arriving = bit(flags, 64.0);
  float k = dim ? 0.85 : (focused || selected ? 1.2 : 1.0);
  float sz = min(a_size, 1.0);
  // Punto: radio en px según el zoom. Zonal y alimentador (≈ 5.000 a la vez) a escala de ciudad
  // más pequeños: la troncal se lee encima; recuperan su tamaño hacia z14,5.
  float minor = (a_size < 0.8 && !focused && !selected) ? 1.0 : 0.0;
  float near_ = smoothstep(0.35, 0.9, u_zf);
  float r = 0.5 * mix(4.4, 9.0, u_zf) * mix(0.8, 1.0, sz) * k * mix(1.0, mix(0.62, 1.0, near_), minor);
  // Huella: tamaño real (18 m un articulado, 27 m un biarticulado, 2,55 m de ancho) con un mínimo
  // legible y proporción de bus, no de píldora.
  float wid = max(2.55 * u_ppm, 6.5 * mix(0.85, 1.0, sz) * k);
  float len = max(18.0 * a_size * u_ppm, wid * (1.5 + 1.1 * a_size));
  vec2 foot = vec2(len, wid) * 0.5;
  float pad = selected ? 24.0 : (arriving || a_ping >= 0.0) ? 17.0 : 6.0;
  float tail = max(30.0, len * 3.0) * tailK;
  float front = max(r, foot.x) + pad;
  float back = max(r, foot.x) + max(pad, tail);
  float side = max(r, foot.y) + pad;
  // Las ondas son redondas (R10.1): el cuadro también las cubre a los lados del bus.
  if (pad > 6.0) side = max(side, max(r, foot.x) + pad);
  float lx = a_corner.x < 0.0 ? -back : front;
  float ly = a_corner.y * side;
  vec2 fwd = normalize(a_dir);
  vec2 sd = vec2(-fwd.y, fwd.x);
  vec2 world = a_pos + (fwd * lx + sd * ly) * u_mpp;
  gl_Position = u_matrix * vec4(world, a_elev * u_mpp * u_ppm, 1.0);
  v_local = vec2(lx, ly);
  v_foot = foot;
  v_r = r;
  v_color = a_color;
  v_flags = flags;
  v_tail = tail;
  v_size = a_size;
  v_ping = a_ping;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_foot;
in float v_r;
in vec4 v_color;
in float v_flags;
in float v_tail;
in float v_size;
in float v_ping;
uniform float u_zf;
uniform float u_el;      // 0 punto … 1 huella
uniform float u_time;
uniform float u_motion;  // 0 con prefers-reduced-motion
uniform float u_shadow;  // intensidad de la sombra según el tema
uniform float u_bodies;  // 1: los cuerpos 3D van encima; aquí solo sombra, anillo y ondas
uniform vec3 u_rim;      // halo: color del fondo del mapa
uniform vec3 u_light;    // anillo de selección
uniform vec3 u_mute;     // hacia dónde se apagan atenuados y zonal lejano
out vec4 frag;

bool bit(float f, float b) { return mod(floor(f / b), 2.0) >= 1.0; }

float rbox(vec2 p, vec2 h, float rc) {
  vec2 q = abs(p) - h + rc;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rc;
}
// Triángulo que apunta hacia +x: base en x0 (media anchura hw), punta en x1.
float tri(vec2 p, float x0, float x1, float hw) {
  vec2 n = normalize(vec2(x1 - x0, hw).yx);
  return max(x0 - p.x, dot(vec2(p.x - x1, abs(p.y)), n));
}
float ring(float d, float r, float th, float aa) {
  return 1.0 - smoothstep(0.0, aa * 1.5, abs(d - r) - th * 0.5);
}

void main() {
  float flags = v_flags;
  bool dim = bit(flags, 1.0);
  bool stale = bit(flags, 2.0);
  bool selected = bit(flags, 4.0);
  bool hover = bit(flags, 8.0);
  bool focused = bit(flags, 32.0);
  bool arriving = bit(flags, 64.0);
  vec3 base = v_color.rgb;
  // Atenuado, no borrado: con una ruta o un bus en foco, el resto de la flota se sigue viendo (al 30 %
  // del color, en el tema oscuro los buses parecían desaparecer al seleccionar otro).
  // Zonal y alimentador (≈ 5.000 a la vez) van más apagados a escala de ciudad, también atenuados.
  bool minor = v_size < 0.8 && !focused && !selected;
  float far_ = mix(0.5, 1.0, smoothstep(0.35, 0.9, u_zf));
  if (dim) base = mix(u_mute, base, minor ? 0.52 * mix(0.6, 1.0, smoothstep(0.35, 0.9, u_zf)) : 0.52);
  else if (minor) base = mix(u_mute, base, far_);
  if (hover) base = mix(base, vec3(1.0), 0.22);

  // Forma: punto (+ flecha) que se transforma en huella.
  // Sin flecha de rumbo: con el anillo parecía un pin de lugar. El rumbo lo dan el tramo de la ruta
  // en foco y, de cerca, el parabrisas de la huella.
  float dDot = length(v_local) - v_r;
  float dA = dDot;
  float dB = rbox(v_local, v_foot, min(v_foot.y * 0.4, 1.6));
  float d = mix(dA, dB, u_el);
  float aa = max(fwidth(d), 0.35);
  float halo = mix(0.9, 1.5, u_zf);
  float fill = 1.0 - smoothstep(-aa, aa, d);
  float body = 1.0 - smoothstep(-aa, aa, d - halo);
  vec3 col = mix(u_rim, base, fill);

  // Detalles de la huella: parabrisas oscuro al frente y articulaciones.
  float det = u_el * fill * (dim ? 0.3 : 1.0);
  if (det > 0.0) {
    float ws = max(1.4, v_foot.x * 0.13);
    float fr = smoothstep(v_foot.x - ws - aa, v_foot.x - ws + aa, v_local.x);
    col = mix(col, mix(base, vec3(0.06, 0.07, 0.08), 0.5), fr * det);
    float L = 2.0 * v_foot.x, xr = v_local.x + v_foot.x, jw = 0.5;
    float j = 0.0;
    if (v_size > 1.3) {
      j = max(1.0 - smoothstep(jw - aa, jw + aa, abs(xr - 0.27 * L)), 1.0 - smoothstep(jw - aa, jw + aa, abs(xr - 0.56 * L)));
    } else if (v_size > 0.9) {
      j = 1.0 - smoothstep(jw - aa, jw + aa, abs(xr - 0.39 * L));
    }
    col = mix(col, u_rim, j * det * 0.9);
  }

  // Con cuerpos 3D, la huella es su sombra en el suelo.
  if (u_bodies > 0.5) {
    float s = (1.0 - smoothstep(-1.5, 2.0, d)) * 0.34 * (dim ? 0.5 : 1.0);
    col = vec3(0.0);
    body = s;
  }
  // Premultiplicado: cuerpo y halo; debajo, anillo, ondas, sombra y estela.
  vec4 acc = vec4(col * body, body);
  // Anillo solo para el seleccionado: si los demás buses de su ruta (en foco) también lo llevaban,
  // no se sabía cuál era el elegido.
  if (selected) {
    float rg = ring(d, halo + 1.9, 1.3, aa);
    acc += vec4(u_light * rg, rg) * (1.0 - acc.a);
  }
  float w = 0.0;
  if (u_motion > 0.5 && !dim) {
    // Ondas redondas (R10.1, variante elegida por Daniel): círculos centrados en el bus que nacen a la
    // altura de su cuerpo y crecen hasta pasar sus extremos. De lejos (punto) es el mismo círculo de
    // antes; de cerca ya no toman la forma del bus.
    float rin = mix(v_r, v_foot.y, u_el), span = mix(v_r, v_foot.x, u_el) - rin;
    float wd = length(v_local) - rin;
    float wa = max(fwidth(wd), 0.35);
    if (selected) {
      float k = fract(u_time / 3.2);
      w = ring(wd, halo + 3.0 + (15.0 + span) * (1.0 - pow(1.0 - k, 3.0)), 1.1, wa) * 0.34 * pow(1.0 - k, 2.0);
    } else if (arriving) {
      float k = fract(u_time / 3.6 + fract(v_color.r * 7.0) * 0.5);
      w = ring(wd, halo + 2.0 + (10.0 + span) * (1.0 - pow(1.0 - k, 3.0)), 1.0, wa) * 0.28 * pow(1.0 - k, 2.0);
    }
    if (v_ping >= 0.0 && v_ping < 1.0) {
      float k = v_ping;
      w = max(w, ring(wd, halo + 2.0 + (12.0 + span) * (1.0 - pow(1.0 - k, 3.0)), 1.0, wa) * 0.3 * pow(1.0 - k, 2.0));
    }
  }
  if (w > 0.0) {
    vec3 wc = selected ? mix(u_light, base, 0.35) : base;
    acc += vec4(wc * w, w) * (1.0 - acc.a);
  }
  // Sombra corta solo con la huella (de cerca, sobre la línea de su ruta); como punto basta el halo.
  float sh = (1.0 - smoothstep(halo, halo + 3.0, d)) * u_shadow * (dim ? 0.35 : 1.0) * u_el * (1.0 - u_bodies);
  acc += vec4(0.0, 0.0, 0.0, sh) * (1.0 - acc.a);
  if (v_tail > 0.0 && acc.a < 0.5) {
    float back = -v_local.x - max(v_foot.x * u_el + v_r * (1.0 - u_el), 0.0);
    float half_ = mix(v_r, v_foot.y, u_el) * 0.5;
    if (back > 0.0 && back < v_tail && abs(v_local.y) < half_) {
      float a = 0.5 * pow(1.0 - back / v_tail, 1.6);
      acc += vec4(v_color.rgb * a, a) * (1.0 - acc.a);
    }
  }
  float k = v_color.a * (stale ? 0.45 : 1.0) * (dim ? 0.9 : 1.0);
  acc *= k;
  if (acc.a < 0.01) discard;
  frag = acc;
}`;

export class BusLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;
  private gl!: WebGL2RenderingContext;
  private prog!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private inst!: WebGLBuffer;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private map!: MLMap;
  private frames: number[] = [];
  private timer = 0;
  private t0 = performance.now();
  /** Colores del tema: borde del bus (fondo del mapa) y anillo de foco. */
  rim: [number, number, number] = [0.043, 0.051, 0.062];
  light: [number, number, number] = [0.94, 0.95, 0.96];
  mute: [number, number, number] = [0.16, 0.18, 0.21];
  shadow = 0.5;
  /** Sin ondas si la persona pidió menos movimiento. */
  motion = typeof matchMedia === 'undefined' || !matchMedia('(prefers-reduced-motion: reduce)').matches;
  onFrame?: () => void;
  setColors(rim: [number, number, number], light: [number, number, number], mute: [number, number, number], shadow: number) {
    this.rim = rim; this.light = light; this.mute = mute; this.shadow = shadow;
  }
  private fleet: Fleet;
  private only: 'all' | 'dim' | 'main';
  private bodies = new BusBodies();

  /** `main`: todos salvo los atenuados; `dim`: solo los atenuados (van debajo de la ruta en foco). */
  constructor(fleet: Fleet, only: 'all' | 'dim' | 'main' = 'all') {
    this.fleet = fleet;
    this.only = only;
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
    for (const n of ['u_matrix', 'u_mpp', 'u_ppm', 'u_zf', 'u_el', 'u_time', 'u_motion', 'u_shadow', 'u_bodies', 'u_rim', 'u_light', 'u_mute']) this.u[n] = g.getUniformLocation(p, n);
    this.bodies.init(g);

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
    attr(1, 2, 0);
    attr(2, 2, 2);
    attr(3, 4, 4);
    attr(4, 1, 8);
    attr(5, 1, 9);
    attr(6, 1, 10);
    attr(7, 1, 13);
    g.bindVertexArray(null);
  }

  /** Rectángulo visible (metros locales), con margen, para no calcular lo que no se ve. */
  private view(): [number, number, number, number] {
    const b = this.map.getBounds();
    const mx = (b.getEast() - b.getWest()) * 0.15, my = (b.getNorth() - b.getSouth()) * 0.15;
    return [(b.getWest() - mx) * KX, (b.getSouth() - my) * KY, (b.getEast() + mx) * KX, (b.getNorth() + my) * KY];
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, opts: CustomRenderMethodInput) {
    const g = gl as WebGL2RenderingContext;
    const now = Date.now();
    const box = this.view();
    const moving = this.fleet.update(now, box);
    const zoom = this.map.getZoom();
    // Cuerpos 3D con la vista inclinada y de cerca; crecen desde el suelo entre z16,3–16,8 y entre
    // 10°–25° de inclinación.
    const pitch = this.map.getPitch();
    const bodies = pitch > 10 && zoom >= 16.3;
    const rise = Math.min(1, (zoom - 16.3) / 0.5) * Math.min(1, (pitch - 10) / 15);
    this.fleet.rearDirs = bodies;
    // 30 px de estela en metros, a este zoom (para acortarla en las curvas).
    this.fleet.tailMin = (30 * 40_075_016.686 * Math.cos((this.map.getCenter().lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
    const { data, count } = this.fleet.fill(now, this.only, box);
    if (count) {
      g.useProgram(this.prog);
      const m = opts.defaultProjectionData.mainMatrix as unknown as ArrayLike<number>;
      const [ox, oy] = ORIGIN;
      const mm = new Float32Array(16);
      for (let i = 0; i < 16; i++) mm[i] = m[i];
      for (let r = 0; r < 4; r++) mm[12 + r] = m[r] * ox + m[4 + r] * oy + m[12 + r];
      g.uniformMatrix4fv(this.u.u_matrix, false, mm);
      const worldPx = 512 * Math.pow(2, zoom);
      const lat = (this.map.getCenter().lat * Math.PI) / 180;
      g.uniform1f(this.u.u_mpp, 1 / worldPx);
      g.uniform1f(this.u.u_ppm, worldPx / (40_075_016.686 * Math.cos(lat)));
      g.uniform1f(this.u.u_zf, Math.min(1, Math.max(0, (zoom - 10) / 5)));
      // Punto → huella entre los zooms 15,2 y 16; flecha de rumbo desde el 13.
      const el = Math.min(1, Math.max(0, (zoom - 15.2) / 0.8));
      g.uniform1f(this.u.u_el, el * el * (3 - 2 * el));
      g.uniform1f(this.u.u_time, (performance.now() - this.t0) / 1000);
      g.uniform1f(this.u.u_motion, this.motion ? 1 : 0);
      g.uniform1f(this.u.u_shadow, this.shadow);
      // Cuerpos 3D: con la vista inclinada y de cerca (desde z16,3 el ancho real ya pasa de 2 px).
      g.uniform1f(this.u.u_bodies, bodies ? 1 : 0);
      g.uniform3fv(this.u.u_rim, this.rim);
      g.uniform3fv(this.u.u_light, this.light);
      g.uniform3fv(this.u.u_mute, this.mute);
      g.bindBuffer(g.ARRAY_BUFFER, this.inst);
      g.bufferData(g.ARRAY_BUFFER, data.subarray(0, count * Fleet.STRIDE), g.DYNAMIC_DRAW);
      g.bindVertexArray(this.vao);
      g.enable(g.BLEND);
      g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
      g.enable(g.DEPTH_TEST);
      g.depthFunc(g.LEQUAL);
      g.depthMask(false);
      g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, count);
      g.bindVertexArray(null);
      if (bodies) {
        const ppm = worldPx / (40_075_016.686 * Math.cos(lat));
        this.bodies.draw(g, mm, data, count, ppm, ppm / worldPx, this.mute, Math.max(0.02, rise));
      }
    }
    this.frames.push(performance.now());
    if (this.frames.length > 120) this.frames.shift();
    this.onFrame?.();
    if (this.only === 'dim') return; // la capa principal agenda el siguiente cuadro por las dos
    const waves = this.motion && (this.fleet.selectedId !== null || this.fleet.arriving.size > 0 || this.fleet.pinging(now));
    if (!moving && !waves && !this.fleet.animating(now)) return;
    // Al ritmo que hace falta: las ondas son lentas (30 cuadros bastan); si solo avanzan buses, según
    // cuánto se mueven en pantalla a este zoom (a escala de ciudad, menos de un píxel por cuadro).
    // A z16 un bus a 10 m/s avanza ~0,3 px por cuadro a 30 cuadros: 60 solo desde z17,5 (R1.17, calor).
    const fps = zoom >= 17.5 ? 60 : zoom >= 14 || waves ? 30 : zoom < 12 ? 10 : 20;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.map.triggerRepaint(), Math.max(0, 1000 / fps - 4));
  }

  fps(): number {
    const f = this.frames;
    if (f.length < 2) return 0;
    return Math.round(((f.length - 1) * 1000) / (f[f.length - 1] - f[0]));
  }

  onRemove() {
    clearTimeout(this.timer);
    this.gl.deleteProgram(this.prog);
    this.gl.deleteBuffer(this.inst);
    this.gl.deleteVertexArray(this.vao);
  }
}

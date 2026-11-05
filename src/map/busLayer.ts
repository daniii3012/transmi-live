import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import { Fleet, ORIGIN } from '../live/fleet';
import { KX, KY } from '../domain/geo';

/**
 * Buses en una capa WebGL propia (decisiones/005), revisión R1:
 *
 *  - Silueta apoyada en el suelo: las esquinas se calculan en coordenadas mercator, así que en 3D el
 *    bus se inclina con la calle en vez de quedar plano frente a la cámara.
 *  - Forma: a escala de ciudad un punto con un «ojo» hacia donde avanza; al acercarse se alarga en
 *    cápsula hasta su tamaño real (18 m un articulado, 27 m un biarticulado).
 *  - Ondas: continuas para el seguido, una sutil al llegar cada lectura, suaves para los próximos en
 *    llegar a la estación abierta.
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
uniform mat4 u_matrix;
uniform float u_mpp;
uniform float u_ppm;
uniform float u_zf;
uniform float u_el;
out vec2 v_local;
out vec2 v_half;
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
  bool trail = bit(flags, 16.0);
  bool focused = bit(flags, 32.0);
  bool arriving = bit(flags, 64.0);
  float k = dim ? 0.8 : (focused || selected ? 1.25 : 1.0);
  float d = mix(4.6, 8.0, u_zf) * mix(0.82, 1.0, min(a_size, 1.0)) * k;
  float realL = 18.0 * a_size * u_ppm, realW = 2.55 * u_ppm;
  float len = mix(d, max(d * 1.9, realL), u_el);
  float wid = mix(d, max(d * 0.92, realW), u_el);
  float halfL = len * 0.5, halfW = wid * 0.5;
  float pad = selected ? 44.0 : arriving ? 26.0 : a_ping >= 0.0 ? 22.0 : 3.0;
  float tail = trail ? max(30.0, len * 3.0) : 0.0;
  float lx = a_corner.x < 0.0 ? -(halfL + max(pad, tail)) : halfL + pad;
  float ly = a_corner.y * (halfW + pad);
  vec2 fwd = normalize(a_dir);
  vec2 side = vec2(-fwd.y, fwd.x);
  vec2 world = a_pos + (fwd * lx + side * ly) * u_mpp;
  gl_Position = u_matrix * vec4(world, 0.0, 1.0);
  v_local = vec2(lx, ly);
  v_half = vec2(halfL, halfW);
  v_color = a_color;
  v_flags = flags;
  v_tail = tail;
  v_size = a_size;
  v_ping = a_ping;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_half;
in vec4 v_color;
in float v_flags;
in float v_tail;
in float v_size;
in float v_ping;
uniform float u_zf;
uniform float u_time;
uniform vec3 u_rim;
uniform vec3 u_light;
uniform vec3 u_mute;   // hacia dónde se apagan atenuados y zonal lejano (según el tema)
out vec4 frag;

bool bit(float f, float b) { return mod(floor(f / b), 2.0) >= 1.0; }

float capsule(vec2 p, vec2 h) {
  float hx = max(h.x - h.y, 0.0);
  vec2 q = vec2(max(abs(p.x) - hx, 0.0), p.y);
  return length(q) - h.y;
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
  if (dim) base = mix(u_mute, base, 0.3);
  else if (v_size < 0.8 && !focused && !selected) base = mix(u_mute, base, mix(0.62, 1.0, u_zf));
  if (hover) base = mix(base, vec3(1.0), 0.25);

  float d = capsule(v_local, v_half);
  float aa = max(fwidth(d), 0.35);
  float body = 1.0 - smoothstep(-aa, aa, d);
  float fill = 1.0 - smoothstep(-aa, aa, d + 1.2);
  vec3 col = mix(u_rim, base, fill);
  float alpha = body;

  // «Ojo» hacia donde avanza.
  float hx = max(v_half.x - v_half.y, 0.0);
  vec2 eye = vec2(hx + v_half.y * 0.38, 0.0);
  float de = length(v_local - eye) - v_half.y * 0.34;
  float eyeA = (1.0 - smoothstep(-aa, aa, de)) * fill;
  col = mix(col, mix(base, vec3(1.0), 0.65), eyeA * (dim ? 0.3 : 0.85));

  // Foco y selección: anillo claro por fuera del cuerpo.
  if ((focused || selected) && body < 0.99) {
    float ring = 1.0 - smoothstep(0.0, aa * 1.5, abs(d - 1.5) - 0.75);
    col = mix(col, u_light, ring);
    alpha = max(alpha, ring);
  }

  float wave = 0.0;
  vec3 waveCol = mix(v_color.rgb, vec3(1.0), 0.35);
  if (selected) {
    for (int i = 0; i < 2; i++) {
      float k = fract(u_time / 1.9 + float(i) * 0.5);
      float r = 4.0 + 38.0 * k;
      wave = max(wave, (1.0 - smoothstep(0.0, aa * 2.0, abs(d - r) - 1.0)) * 0.6 * pow(1.0 - k, 1.4));
    }
    waveCol = mix(u_light, v_color.rgb, 0.25);
  } else if (arriving) {
    float k = fract(u_time / 2.4);
    float r = 3.0 + 22.0 * k;
    wave = (1.0 - smoothstep(0.0, aa * 2.0, abs(d - r) - 0.8)) * 0.42 * pow(1.0 - k, 1.5);
  } else if (v_ping >= 0.0 && v_ping < 1.0 && !dim) {
    float r = 2.0 + 17.0 * v_ping;
    wave = (1.0 - smoothstep(0.0, aa * 2.0, abs(d - r) - 0.7)) * 0.3 * pow(1.0 - v_ping, 2.0) * smoothstep(0.25, 0.5, u_zf);
  }
  if (wave > 0.0 && body < 0.5) {
    col = mix(col, waveCol, wave / max(alpha + wave, 1e-3));
    alpha = max(alpha, wave);
  }

  if (v_tail > 0.0 && body < 0.01) {
    float back = -v_local.x - v_half.x;
    if (back > 0.0 && back < v_tail && abs(v_local.y) < v_half.y * 0.5) {
      float a = 0.55 * pow(1.0 - back / v_tail, 1.6);
      if (a > alpha) { col = v_color.rgb; alpha = a; }
    }
  }
  alpha *= v_color.a * (stale ? 0.45 : 1.0) * (dim ? 0.8 : 1.0);
  if (alpha < 0.01) discard;
  frag = vec4(col * alpha, alpha);
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
  onFrame?: () => void;
  setColors(rim: [number, number, number], light: [number, number, number], mute: [number, number, number]) { this.rim = rim; this.light = light; this.mute = mute; }
  private fleet: Fleet;
  private only: 'all' | 'dim' | 'main';

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
    for (const n of ['u_matrix', 'u_mpp', 'u_ppm', 'u_zf', 'u_el', 'u_time', 'u_rim', 'u_light', 'u_mute']) this.u[n] = g.getUniformLocation(p, n);

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
    const { data, count } = this.fleet.fill(now, this.only, box);
    const zoom = this.map.getZoom();
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
      g.uniform1f(this.u.u_el, Math.min(1, Math.max(0, (zoom - 13.5) / 2.5)));
      g.uniform1f(this.u.u_time, (performance.now() - this.t0) / 1000);
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
    }
    this.frames.push(performance.now());
    if (this.frames.length > 120) this.frames.shift();
    this.onFrame?.();
    if (this.only === 'dim') return; // la capa principal agenda el siguiente cuadro por las dos
    const waves = this.fleet.selectedId !== null || this.fleet.arriving.size > 0 || this.fleet.pinging(now);
    if (!moving && !waves && !this.fleet.animating(now)) return;
    // Al ritmo que hace falta: fluido con ondas; si solo avanzan buses, según cuánto se mueven en
    // pantalla a este zoom (a escala de ciudad, menos de un píxel por cuadro).
    const fps = waves ? 45 : zoom < 12 ? 10 : zoom < 14 ? 20 : zoom < 16 ? 30 : 60;
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

import { Fleet } from '../live/fleet';

/**
 * Buses con volumen para la vista inclinada de cerca (hito 7, F7.3).
 *
 * Modelos de baja poligonización, en metros, a partir de las carrocerías de la troncal: articulado de
 * 18 m (chasis Volvo B340M / Scania / Mercedes-Benz O500 con carrocería Marcopolo Gran Viale o Busscar)
 * y biarticulado de 27 m (Volvo Gran Artic 300). Proporciones tomadas de sus fichas: ancho 2,55 m,
 * alto 3,2 m con el aire acondicionado, cuerpo delantero de unos 11 m y tramos traseros de 6–7 m unidos
 * por fuelles. Los zonales (padrón de 12 m) usan un cuerpo rígido; sus variantes (busetón, buseta) y
 * los BYD eléctricos quedan para después.
 *
 * Partes: faldón y techo del color de la ruta, franja de ventanas oscura, parabrisas, letrero de ruta
 * ámbar al frente, fuelles grafito y la cápsula del aire acondicionado. Luz direccional fija desde el
 * noroeste y un poco de luz ambiente: se lee el volumen sin efectos.
 */

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_vpos;
layout(location=1) in vec3 a_vnorm;
layout(location=2) in float a_mat;
layout(location=3) in vec2 a_pos;
layout(location=4) in vec2 a_dir;
layout(location=5) in vec4 a_color;
layout(location=6) in float a_size;
layout(location=7) in float a_flags;
layout(location=8) in vec2 a_dir2;   // rumbo del tramo trasero
uniform mat4 u_matrix;
uniform float u_j1;    // centro del primer fuelle (x del modelo, m); −1000 si es rígido
uniform float u_j2;    // centro del segundo fuelle (biarticulado); −1000 si no hay
uniform float u_ppm;   // píxeles por metro
uniform float u_mpm;   // unidades mercator por metro
uniform vec3 u_mute;   // atenuados: hacia el tono del tema
out vec3 v_color;
out float v_shade;
out float v_alpha;

bool bit(float f, float b) { return mod(floor(f / b), 2.0) >= 1.0; }

vec3 material(float m, vec3 c) {
  if (m < 0.5) return c * 0.82;                                   // faldón
  if (m < 1.5) return mix(c, vec3(0.06, 0.08, 0.10), 0.86);       // ventanas
  if (m < 2.5) return mix(c, vec3(1.0), 0.12);                    // techo y franja alta
  if (m < 3.5) return mix(vec3(0.80, 0.83, 0.86), c, 0.12);       // aire acondicionado
  if (m < 4.5) return vec3(0.16, 0.18, 0.20);                     // fuelle
  if (m < 5.5) return vec3(0.05, 0.07, 0.09);                     // parabrisas
  return vec3(1.0, 0.68, 0.12);                                   // letrero
}

void main() {
  bool dim = bit(a_flags, 1.0);
  bool stale = bit(a_flags, 2.0);
  // Mismo tamaño que la huella plana en la transición: ancho mínimo de 6,5 px, largo real.
  float realW = 2.55 * u_ppm;
  float sw = max(1.0, 6.5 / realW);
  vec3 p = vec3(a_vpos.x, a_vpos.y * sw, a_vpos.z * sqrt(sw));
  // Cada tramo sigue su propio rumbo y gira en su fuelle: el delantero con el del bus, el trasero con
  // el del recorrido detrás; el del medio (biarticulado), con el promedio.
  vec2 f = normalize(a_dir);
  vec2 r = normalize(a_dir2);
  vec2 m = normalize(f + r);
  vec2 d = f;
  vec2 base = vec2(0.0);
  float x = p.x;
  if (x < u_j1) {
    if (u_j2 < -100.0 || x >= u_j2) {
      d = u_j2 < -100.0 ? r : m;
      base = f * u_j1 - d * u_j1;
    } else {
      d = r;
      base = f * u_j1 + m * (u_j2 - u_j1) - r * u_j2;
    }
  }
  vec2 side = vec2(-d.y, d.x);
  vec2 w = a_pos + (base + d * x + side * p.y) * u_mpm;
  gl_Position = u_matrix * vec4(w, p.z * u_mpm, 1.0);
  vec3 n = normalize(vec3(d * a_vnorm.x + side * a_vnorm.y, a_vnorm.z));
  vec3 L = normalize(vec3(-0.35, -0.45, 0.82));
  v_shade = 0.6 + 0.4 * max(dot(n, L), 0.0);
  vec3 c = a_color.rgb;
  v_color = material(a_mat, c);
  if (dim) v_color = mix(u_mute, v_color, 0.3);
  v_alpha = a_color.a * (stale ? 0.55 : 1.0) * (dim ? 0.9 : 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 v_color;
in float v_shade;
in float v_alpha;
out vec4 frag;
void main() {
  vec3 c = v_color * v_shade;
  frag = vec4(c * v_alpha, v_alpha);
}`;

type Mat = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Caja con normales (sin la cara de abajo): 30 vértices de [x, y, z, nx, ny, nz, material]. */
function box(out: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: Mat) {
  const q = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    for (const v of [a, b, c, a, c, d]) out.push(v[0], v[1], v[2], n[0], n[1], n[2], m);
  };
  q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);     // techo
  q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);     // frente
  q([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]);    // atrás
  q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);    // costado
  q([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]);     // costado
}

const HW = 1.275; // medio ancho, m

/** Un tramo de carrocería entre x0 y x1 (x hacia el frente); `front` agrega parabrisas y letrero. */
function segment(out: number[], x0: number, x1: number, front: boolean, ac: boolean) {
  box(out, x0, x1, -HW, HW, 0.35, 1.1, 0);
  box(out, x0 + 0.02, x1 - (front ? 0.2 : 0.02), -HW + 0.03, HW - 0.03, 1.1, 2.5, 1);
  box(out, x0, x1, -HW, HW, 2.5, 3.0, 2);
  if (front) {
    box(out, x1 - 0.2, x1, -HW + 0.1, HW - 0.1, 0.8, 2.55, 5);
    box(out, x1 - 0.12, x1 + 0.01, -0.9, 0.9, 2.6, 2.88, 6);
  }
  if (ac) {
    const a = front ? x1 - 5.2 : (x0 + x1) / 2 + 1.6, b = front ? x1 - 1.4 : (x0 + x1) / 2 - 1.6;
    box(out, Math.min(a, b), Math.max(a, b), -0.95, 0.95, 3.0, 3.25, 3);
  }
}
function joint(out: number[], x0: number, x1: number) {
  box(out, x0, x1, -HW + 0.12, HW - 0.12, 0.45, 2.9, 4);
}

export type BodyKind = 'rigid' | 'articulated' | 'biarticulated';

/** Modelos centrados en el bus (x de −L/2 a L/2). */
function model(kind: BodyKind): { data: Float32Array; len: number } {
  const v: number[] = [];
  if (kind === 'rigid') {
    segment(v, -6, 6, true, true);
    return { data: new Float32Array(v), len: 12 };
  }
  if (kind === 'articulated') {
    segment(v, -2.0, 9, true, true);
    joint(v, -2.8, -2.0);
    segment(v, -9, -2.8, false, false);
    return { data: new Float32Array(v), len: 18 };
  }
  segment(v, 2.5, 13.5, true, true);
  joint(v, 1.7, 2.5);
  segment(v, -5.5, 1.7, false, true);
  joint(v, -6.3, -5.5);
  segment(v, -13.5, -6.3, false, false);
  return { data: new Float32Array(v), len: 27 };
}

const KINDS: BodyKind[] = ['rigid', 'articulated', 'biarticulated'];

/** Tipo de cuerpo según el tamaño de la capa (1 articulado, 1,5 biarticulado, ~0,67 padrón). */
export function bodyOf(size: number): BodyKind | null {
  return size >= 1.3 ? 'biarticulated' : size >= 0.9 ? 'articulated' : size > 0.5 ? 'rigid' : null;
}

export class BusBodies {
  private prog!: WebGLProgram;
  private vaos: Record<BodyKind, WebGLVertexArrayObject> = {} as never;
  private counts: Record<BodyKind, number> = {} as never;
  private inst!: WebGLBuffer;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private split: Record<BodyKind, Float32Array> = { rigid: new Float32Array(0), articulated: new Float32Array(0), biarticulated: new Float32Array(0) };

  init(g: WebGL2RenderingContext) {
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
    for (const n of ['u_matrix', 'u_ppm', 'u_mpm', 'u_mute', 'u_j1', 'u_j2']) this.u[n] = g.getUniformLocation(p, n);
    this.inst = g.createBuffer()!;
    const S = Fleet.STRIDE * 4;
    for (const k of KINDS) {
      const { data } = model(k);
      const vao = g.createVertexArray()!;
      g.bindVertexArray(vao);
      const vb = g.createBuffer()!;
      g.bindBuffer(g.ARRAY_BUFFER, vb);
      g.bufferData(g.ARRAY_BUFFER, data, g.STATIC_DRAW);
      g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 3, g.FLOAT, false, 28, 0);
      g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 3, g.FLOAT, false, 28, 12);
      g.enableVertexAttribArray(2); g.vertexAttribPointer(2, 1, g.FLOAT, false, 28, 24);
      g.bindBuffer(g.ARRAY_BUFFER, this.inst);
      const attr = (loc: number, size: number, offset: number) => {
        g.enableVertexAttribArray(loc);
        g.vertexAttribPointer(loc, size, g.FLOAT, false, S, offset * 4);
        g.vertexAttribDivisor(loc, 1);
      };
      attr(3, 2, 0); attr(4, 2, 2); attr(5, 4, 4); attr(6, 1, 8); attr(7, 1, 9); attr(8, 2, 11);
      g.bindVertexArray(null);
      this.vaos[k] = vao;
      this.counts[k] = data.length / 7;
    }
  }

  /** Dibuja los cuerpos de los buses del búfer de la capa (ya recortado a la vista). */
  draw(g: WebGL2RenderingContext, matrix: Float32Array, data: Float32Array, count: number, ppm: number, mpm: number, mute: [number, number, number]) {
    const S = Fleet.STRIDE;
    // Reparto por tipo de cuerpo.
    const n: Record<BodyKind, number> = { rigid: 0, articulated: 0, biarticulated: 0 };
    for (const k of KINDS) if (this.split[k].length < count * S) this.split[k] = new Float32Array(Math.ceil(count * 1.5) * S);
    for (let i = 0; i < count; i++) {
      const k = bodyOf(data[i * S + 8]);
      if (!k) continue;
      this.split[k].set(data.subarray(i * S, i * S + S), n[k] * S);
      n[k]++;
    }
    g.useProgram(this.prog);
    g.uniformMatrix4fv(this.u.u_matrix, false, matrix);
    g.uniform1f(this.u.u_ppm, ppm);
    g.uniform1f(this.u.u_mpm, mpm);
    g.uniform3fv(this.u.u_mute, mute);
    g.enable(g.DEPTH_TEST);
    g.depthFunc(g.LEQUAL);
    g.depthMask(true);
    g.enable(g.BLEND);
    g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    const J: Record<BodyKind, [number, number]> = { rigid: [-1000, -1000], articulated: [-2.4, -1000], biarticulated: [2.1, -5.9] };
    for (const k of KINDS) {
      if (!n[k]) continue;
      g.uniform1f(this.u.u_j1, J[k][0]);
      g.uniform1f(this.u.u_j2, J[k][1]);
      g.bindBuffer(g.ARRAY_BUFFER, this.inst);
      g.bufferData(g.ARRAY_BUFFER, this.split[k].subarray(0, n[k] * S), g.DYNAMIC_DRAW);
      g.bindVertexArray(this.vaos[k]);
      g.drawArraysInstanced(g.TRIANGLES, 0, this.counts[k], n[k]);
    }
    g.bindVertexArray(null);
    g.depthMask(false);
  }
}

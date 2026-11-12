import{i as e,n as t,r as n}from"./audio-Ds-N7sX7.js";import{a as r,i,n as a,r as o,t as s}from"./webgpu-C8PYNhZC.js";var c=`
struct U {
  res: vec4f,   // render w, h, aspect, world units per render px
  fres: vec4f,  // scene w, h, world units per scene px, -
  a: vec4f,     // time, shot time, kick, snare
  b: vec4f,     // hat, bass, mid, treble
  cam: vec4f,   // world point at the frame centre (x, y), zoom, roll
  sc: vec4f,    // shot id, seed, energy, pulse
  fx: vec4f,    // exposure, bloom gain, streak gain, grain
  fx2: vec4f,   // -, white flash, vignette, mirror (-1/1)
  ramp: array<vec4f, 6>, // gradient map stops: rgb, position
  sp: array<vec4f, 8>,   // shot parameters
  spec: array<vec4f, 8>, // 32 spectrum bars 0..1
};
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

const PI = 3.14159265;

fn rot2(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn h11(x: f32) -> f32 { return fract(sin(x * 91.3458) * 47453.5453); }
fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
`,l=c+`
@group(0) @binding(0) var<uniform> u: U;

// World coordinates: y up, the frame is 2 units high; the camera pushes in, drifts and rolls.
fn world(uv: vec2f) -> vec2f {
  let s = vec2f((uv.x - 0.5) * 2.0 * u.res.z * u.fx2.w, (0.5 - uv.y) * 2.0);
  return rot2(u.cam.w) * s / u.cam.z + u.cam.xy;
}
fn fpx() -> f32 { return u.fres.z / u.cam.z; }

fn h22(p: vec2f) -> vec2f { return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), w.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), w.x), w.y);
}
fn fbm(p: vec2f) -> f32 {
  var v = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 5; i++) { v += a * vnoise(q); q = rot2(0.6) * q * 2.03 + vec2f(1.7, 9.2); a *= 0.5; }
  return v;
}
// sharp creases: filaments of gas
fn ridged(p: vec2f) -> f32 {
  var v = 0.0; var a = 0.55; var q = p;
  for (var i = 0; i < 5; i++) { let n = 1.0 - abs(2.0 * vnoise(q) - 1.0); v += a * n * n; q = rot2(0.7) * q * 2.1 + vec2f(3.1, 1.7); a *= 0.5; }
  return v;
}
fn voronoi(p: vec2f) -> vec2f {
  let i = floor(p); let f = fract(p);
  var d1 = 8.0; var d2 = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let g = vec2f(f32(x), f32(y));
      let d = length(g + h22(i + g) - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return vec2f(d1, d2);
}
fn specBar(i: i32) -> f32 { let k = clamp(i, 0, 31); return u.spec[k / 4][k % 4]; }
fn disc(r: f32, R: f32, px: f32) -> f32 { return smoothstep(R + px, R - px, r); }

// Point stars: soft dots (they are photographed, not drawn), twinkling faster on hi-hats.
fn starLayer(p: vec2f, cell: f32, dens: f32, seed: f32) -> f32 {
  let g = p / cell;
  let id = floor(g) + seed;
  let h = hash21(id);
  let pos = h22(id + 3.1) * 0.8 + 0.1;
  let d = length(fract(g) - pos) * cell / fpx();
  let tw = 0.75 + 0.25 * sin(u.a.x * (0.8 + 3.0 * h) * (1.0 + 1.5 * u.b.x) + h * 50.0);
  let b = pow(hash21(id + 1.3), 2.5);
  return step(1.0 - dens, h) * b * tw * (exp(-d * d / 0.9) + 0.15 * exp(-d / 2.5) * b);
}
fn starfield(p: vec2f, dens: f32) -> f32 {
  return 1.6 * starLayer(p, 0.11, min(0.9, dens * 0.18), 0.0)
       + 0.8 * starLayer(p, 0.05, min(0.9, dens * 0.22), 7.0)
       + 0.45 * starLayer(p, 0.024, min(0.9, dens * 0.26), 13.0);
}

// A beam of light from c along d: (thin core, soft sheath, distance along); it widens with the distance.
fn beam(p: vec2f, c: vec2f, d: vec2f, w0: f32, grow: f32) -> vec3f {
  let q = p - c;
  let along = dot(q, d);
  let perp = abs(q.x * d.y - q.y * d.x);
  let w = w0 + grow * abs(along) + fpx() * 0.6;
  return vec3f(exp(-perp * perp / (w * w)), exp(-perp / (w * 6.0 + 0.01)), along);
}

// 0 pulsar: the white star, two thin beams through it, a soft halo, faint stars.
fn shotPulsar(p: vec2f) -> f32 {
  let P = u.sp[0]; // beam angle, star radius, beam intensity, glow
  let R = P.y;
  let r = length(p);
  let px = fpx();
  var L = 0.05 + 0.07 * fbm(p * 1.1 + vec2f(u.a.x * 0.01, 4.0)) + starfield(p, 0.7);
  let x = max(r - R, 0.0);
  L += P.w * (1.1 * exp(-x / (R * 0.16)) + 0.3 * exp(-x / (R * 0.9)) + 0.13 * exp(-r / (R * 5.0)));
  let b = beam(p, vec2f(0.0), vec2f(cos(P.x), sin(P.x)), 0.0022, 0.0028);
  let s = abs(b.z);
  let shimmer = 0.85 + 0.3 * vnoise(vec2f(b.z * 9.0 - u.a.y * 6.0, 3.0));
  L += P.z * (2.2 * b.x + 0.16 * b.y) * shimmer / (1.0 + 0.2 * s) * smoothstep(R * 0.5, R * 1.2, s);
  return mix(L, 3.2 + 0.6 * (1.0 - r / R), disc(r, R, px * 1.3));
}

// 1 magnetosphere: dipole loops in planes through the magnetic axis (beaded, like the field
// lines of a simulation), cones of light streaming out along the axis, the star in the middle.
fn shotMagneto(p: vec2f) -> f32 {
  let M = u.sp[0].xyz;
  let R = u.sp[0].w;
  let E1 = u.sp[1].xyz;
  let E2 = u.sp[2].xyz;
  let r = length(p);
  let px = fpx();
  var L = 0.02 + 0.04 * fbm(p * 1.4 + 2.0) + 0.8 * starfield(p, 0.4);
  let A = M.xy;
  let al = max(length(A), 1e-3);
  let d = A / al;
  let along = dot(p, d);
  let perp = abs(p.x * d.y - p.y * d.x);
  let s = abs(along);
  let streaks = 0.68 + 0.32 * vnoise(vec2f(atan2(perp, s) * 70.0, sign(along) * 9.0 + u.a.x * 0.15));
  L += u.sp[2].w * exp(-pow(perp / max(s * 0.42, 1e-3), 2.0)) * smoothstep(R, R * 4.0, s) * 0.9 / (1.0 + 0.5 * s) * streaks * (0.3 + 0.7 * al);
  for (var i = 0; i < 6; i++) {
    let phi = f32(i) * PI / 6.0 + u.sp[3].x;
    let e = cos(phi) * E1 + sin(phi) * E2;
    let E = e.xy;
    let det0 = A.x * E.y - A.y * E.x;
    let det = select(det0, 1e-3, abs(det0) < 1e-3);
    let x = (p.x * E.y - p.y * E.x) / det;
    let y = (A.x * p.y - A.y * p.x) / det;
    let rr = max(length(vec2f(x, y)), 1e-4);
    let s2 = y * y / (rr * rr);
    let th = atan2(y, x);
    let behind = select(1.0, 1.0 - disc(r, R, px), x * M.z + y * e.z < 0.0);
    let edgeOn = smoothstep(0.04, 0.16, abs(det0));
    for (var j = 0; j < 2; j++) {
      let k = i * 2 + j;
      let Lj = R * (3.2 + 4.2 * f32(j) + 2.6 * h11(f32(k) * 3.7 + u.sc.y * 11.0));
      let f = rr - Lj * s2;
      let dd = abs(f) / max(fwidth(f), 1e-6);
      let bead = 0.35 + 0.9 * smoothstep(0.3, 0.9, vnoise(vec2f(th * 30.0 + u.a.y * 2.5 * select(-1.0, 1.0, j == 0), f32(k) * 5.0)));
      let line = exp(-dd * dd / 1.6) + 0.22 * exp(-dd / 5.0);
      L += u.sp[1].w * line * bead * behind * edgeOn * (0.45 + 0.9 * specBar(k * 2 + 2));
    }
  }
  return mix(L, 2.2 + 0.4 * (1.0 - r / R), disc(r, R, px * 1.3));
}

// 2 limb: a sunrise over a dark planet: the star just behind the limb with rays and a plume,
// the thin bright atmosphere, a faintly lit surface.
fn shotLimb(p: vec2f) -> f32 {
  let C = u.sp[0].xy; let Rp = u.sp[0].z; let sa = u.sp[0].w;
  let flare = u.sp[1].x; let rays = u.sp[1].y;
  let px = fpx();
  let q = p - C;
  let r = length(q);
  let n = vec2f(cos(sa), sin(sa));
  let S = C + n * (Rp + 0.015);
  let bg = 0.04 + 0.14 * fbm(p * 0.8 + 3.0) * smoothstep(-1.2, 1.0, p.y) + 0.6 * starfield(p, 0.3);
  let ds = p - S;
  let rs = length(ds);
  var sun = flare * (3.5 * exp(-rs / 0.05) + 0.9 * exp(-rs / 0.22) + 0.3 * exp(-rs / 0.8));
  let ra = atan2(ds.y, ds.x);
  var spikes = 0.0;
  for (var k = 0; k < 3; k++) {
    spikes += pow(abs(cos(ra * f32(3 + k * 2) + f32(k) * 1.3 + u.sp[1].z)), 50.0 + 40.0 * f32(k));
  }
  sun += rays * spikes * 0.4 / (1.0 + rs * 9.0);
  let pa = dot(ds, n);
  let pt = dot(ds, vec2f(-n.y, n.x));
  let plume = exp(-pow(pt / (0.05 + 0.3 * max(pa, 0.0)), 2.0)) * exp(-max(pa, 0.0) / 0.8) * smoothstep(-0.05, 0.05, pa)
            * (0.7 + 0.6 * fbm(vec2f(pt * 5.0, pa * 2.5 - u.a.x * 0.25)));
  let near = exp(-pow(acos(clamp(dot(q / max(r, 1e-4), n), -1.0, 1.0)), 2.0) / 0.3);
  let rimW = 0.005 + 0.012 * near;
  let rim = exp(-pow((r - Rp) / rimW, 2.0)) * (1.0 + 3.0 * near)
          + exp(-max(r - Rp, 0.0) / 0.05) * step(Rp, r) * (0.2 + 0.9 * near);
  let surf = 0.03 + 0.2 * fbm(q * 2.6 + 7.0) * (0.3 + 0.7 * exp(-(Rp - r) / 0.5)) * (0.5 + near) + 0.6 * near * exp(-(Rp - r) / 0.05);
  return mix(bg + sun + flare * plume * 1.4, surf, disc(r, Rp, px)) + rim;
}

// 3 ring: a dark hazy disc with a bright rim, a flare inside its lower edge and a jet leaving it,
// horizontal streaks of light behind.
fn shotRing(p: vec2f) -> f32 {
  let C = u.sp[0].xy; let R = u.sp[0].z; let ja = u.sp[0].w;
  let fl = u.sp[1].x;
  let px = fpx();
  let q = p - C;
  let r = length(q);
  var L = 0.1 + 0.2 * fbm(p * 1.1 + vec2f(u.a.x * 0.02, 5.0));
  for (var k = 0; k < 5; k++) {
    let hk = h11(f32(k) * 7.3 + u.sc.y * 3.0);
    let yk = C.y - R * 0.35 + (hk - 0.5) * 1.1;
    L += 0.3 * exp(-pow((p.y - yk) / (0.012 + 0.04 * hk), 2.0)) * (0.3 + fbm(vec2f(p.x * 1.4, f32(k) * 4.0))) * exp(-abs(p.x - C.x) / 1.6);
  }
  let F = C + vec2f(0.15 * R, -0.45 * R);
  let df = p - F;
  let inner = 0.08 + 0.35 * exp(-length(df) / (0.5 * R)) + 0.12 * fbm(q * 3.0);
  L = mix(L, inner, disc(r, R, px) * 0.85);
  let bottom = smoothstep(0.3, -0.9, q.y / max(r, 1e-4));
  L += exp(-pow((r - R) / 0.009, 2.0)) * (1.6 + 1.6 * bottom) + exp(-abs(r - R) / 0.06) * 0.35;
  L += fl * (4.0 * exp(-length(df) / 0.035) + 1.6 * exp(-pow(df.x / 0.5, 2.0) - pow(df.y / 0.022, 2.0)) + 0.6 * exp(-length(df) / 0.25));
  let b = beam(p, F, vec2f(cos(ja), sin(ja)), 0.02, 0.07);
  L += fl * (1.5 * b.x + 0.2 * b.y) * smoothstep(0.0, 0.08, b.z) / (1.0 + 0.4 * max(b.z, 0.0));
  return L;
}

// 4 eclipse: a black disc against a flare on its limb, plasma filaments swept around it.
fn shotEclipse(p: vec2f) -> f32 {
  let C = u.sp[0].xy; let R = u.sp[0].z; let fa = u.sp[0].w;
  let fl = u.sp[1].x; let fil = u.sp[1].y;
  let px = fpx();
  let q = p - C;
  let r = length(q);
  let F = C + vec2f(cos(fa), sin(fa)) * R * 0.97;
  let df = p - F;
  let dfl = length(df);
  let t = u.a.x;
  let w = p + 0.3 * vec2f(fbm(p * 1.2 + vec2f(t * 0.04, 0.0)), fbm(p * 1.2 + vec2f(4.0, -t * 0.03)));
  let filaments = pow(ridged(w * vec2f(1.4, 2.2) + vec2f(t * 0.05, 0.0)), 3.0) * 1.6;
  var L = 0.04 + 0.1 * fbm(p * 0.7) + filaments * fil * (0.07 + 1.5 * exp(-dfl / 0.7));
  let x = max(r - R, 0.0);
  L += step(R, r) * (0.9 * exp(-x / 0.05) + 0.3 * exp(-x / 0.35)) * (0.7 + 0.6 * fbm(vec2f(atan2(q.y, q.x) * 4.0, x * 3.0 - t * 0.1)));
  let inside = 0.025 + 0.06 * fbm(q * 4.0) * smoothstep(R, R * 0.4, r);
  L = mix(L, inside, disc(r, R, px));
  L += exp(-pow((r - R) / 0.007, 2.0)) * 1.2;
  // a prominence: a bright thread from the flare across the disc
  let pd = vec2f(-cos(fa + 0.12), -sin(fa + 0.12));
  let b = beam(p, F, pd, 0.004, 0.006);
  L += fl * 1.4 * b.x * step(0.0, b.z) * exp(-max(b.z, 0.0) / (R * 0.9)) * (0.6 + 0.6 * vnoise(vec2f(b.z * 18.0, t)));
  L += fl * (6.0 * exp(-dfl / 0.045) + 1.2 * exp(-dfl / 0.22) + 1.3 * exp(-pow(df.x / 0.9, 2.0) - pow(df.y / 0.02, 2.0)));
  return L;
}

// 5 wide: a distant pulsar, a broad mottled beam sweeping a dense field of stars.
fn shotWide(p: vec2f) -> f32 {
  let C = u.sp[0].xy; let ang = u.sp[0].z; let R = u.sp[0].w;
  let bi = u.sp[1].x;
  let px = fpx();
  let clusters = smoothstep(0.45, 0.75, fbm(p * 1.3 + 9.0));
  var L = 0.025 + 0.08 * fbm(p * 0.9 + 1.0) + 1.1 * starfield(p, 0.8 + 2.5 * clusters);
  let d = vec2f(cos(ang), sin(ang));
  let b = beam(p, C, d, 0.05, 0.09);
  let mott = 0.6 + 0.6 * fbm(vec2f(b.z * 2.5 - u.a.x * 0.4, dot(p - C, vec2f(-d.y, d.x)) * 9.0));
  let end = 1.0 + 3.0 * smoothstep(0.4, 2.2, -b.z);
  L += bi * (0.42 * b.x * mott * end + 0.12 * b.y);
  let core = beam(p, C, d, 0.004, 0.006);
  L += bi * 0.5 * core.x / (1.0 + abs(core.z));
  let r = length(p - C);
  L += 0.6 * exp(-max(r - R, 0.0) / 0.015) + 0.2 * exp(-r / 0.15);
  return mix(L, 2.6, disc(r, R, px));
}

// 6 wings: a beam and its star crossing curtains of gas that rise in a V.
fn shotWings(p: vec2f) -> f32 {
  let C = u.sp[0].xy; let ang = u.sp[0].z; let bi = u.sp[0].w;
  let W = u.sp[1].xy; let gas = u.sp[1].z;
  let t = u.a.x;
  var L = 0.025 + 0.06 * fbm(p * 1.2) + 0.5 * starfield(p, 0.3);
  let h = p.y - W.y;
  var m = 0.0;
  for (var k = 0; k < 2; k++) {
    let sg = f32(k) * 2.0 - 1.0;
    let cx = W.x + sg * (0.12 + 0.55 * max(h, 0.0)) + 0.08 * sin(h * 3.0 + f32(k) * 2.0);
    m += exp(-pow((p.x - cx) / (0.1 + 0.22 * max(h, 0.0)), 2.0)) * smoothstep(-0.35, 0.05, h);
  }
  let w = p + 0.2 * vec2f(fbm(p * 1.5 + vec2f(0.0, t * 0.05)), fbm(p * 1.5 + 6.0));
  let fils = pow(ridged(w * vec2f(4.0, 1.3) + vec2f(0.0, -t * 0.06)), 3.0);
  L += gas * m * (0.1 + 1.6 * fils);
  let d = vec2f(cos(ang), sin(ang));
  let b = beam(p, C, d, 0.003, 0.004);
  L += bi * (1.8 * b.x + 0.25 * b.y) * (1.0 + 0.8 * smoothstep(0.0, 1.5, b.z));
  let r = length(p - C);
  return L + bi * (3.0 * exp(-r / 0.012) + 0.6 * exp(-r / 0.08));
}

// 7 cell star: an overexposed star with a cellular surface, the Milky Way behind it.
fn shotCell(p: vec2f) -> f32 {
  let S = u.sp[0].xy; let R = u.sp[0].z; let ba = u.sp[0].w;
  let O = u.sp[1].xy; let glow = u.sp[1].z;
  let px = fpx();
  let bd = vec2f(cos(ba), sin(ba));
  let dist = abs((p.x - O.x) * bd.y - (p.y - O.y) * bd.x);
  let band = exp(-pow(dist / 0.42, 2.0));
  let clouds = fbm(p * 2.2 + 11.0);
  let dust = fbm(p * 4.5 + vec2f(3.0, 1.0));
  var L = 0.02 + band * (0.06 + 0.75 * clouds * clouds) * (1.0 - 0.85 * smoothstep(0.48, 0.7, dust));
  L += 1.1 * starfield(p, 0.5 + 3.5 * band);
  let q = (p - S) / R;
  let r = length(q);
  let x = max(r - 1.0, 0.0) * R;
  L += glow * (0.9 * exp(-x / 0.03) + 0.25 * exp(-x / 0.25) + 0.08 * exp(-x / 1.0));
  let z = sqrt(max(1.0 - r * r, 0.0));
  let sc0 = q / (0.35 + z) * 3.2 + vec2f(u.a.x * 0.03, 0.0);
  let sc = sc0 + 0.18 * vec2f(vnoise(sc0 * 2.5), vnoise(sc0 * 2.5 + 5.0));
  let v = voronoi(sc);
  let edge = smoothstep(0.01, 0.2, v.y - v.x);
  let surf = glow * mix(0.3, 1.7, edge) * (0.8 + 0.35 * vnoise(sc * 3.0 + u.a.x * 0.2)) * (0.8 + 0.4 * (1.0 - z));
  return mix(L, surf, disc(r * R, R, px));
}

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let p = world(i.uv);
  var L = 0.0;
  switch (i32(u.sc.x)) {
    case 1: { L = shotMagneto(p); }
    case 2: { L = shotLimb(p); }
    case 3: { L = shotRing(p); }
    case 4: { L = shotEclipse(p); }
    case 5: { L = shotWide(p); }
    case 6: { L = shotWings(p); }
    case 7: { L = shotCell(p); }
    default: { L = shotPulsar(p); }
  }
  return vec4f(max(L, 0.0), 0.0, 0.0, 1.0);
}
`,u=c+`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

fn tap(uv: vec2f) -> f32 { return textureSampleLevel(src, samp, uv, 0.0).r; }
fn box4(uv: vec2f) -> f32 {
  let px = 1.0 / vec2f(textureDimensions(src, 0));
  return (tap(uv + px * vec2f(-1.0, -1.0)) + tap(uv + px * vec2f(1.0, -1.0))
        + tap(uv + px * vec2f(-1.0, 1.0)) + tap(uv + px * vec2f(1.0, 1.0))) * 0.25;
}
// soft knee: only the bright light blooms
@fragment fn fsDown1(i: VSOut) -> @location(0) vec4f { let c = box4(i.uv); return vec4f(c * smoothstep(0.8, 2.6, c), 0.0, 0.0, 1.0); }
@fragment fn fsDown(i: VSOut) -> @location(0) vec4f { return vec4f(box4(i.uv), 0.0, 0.0, 1.0); }
fn blur(uv: vec2f, dir: vec2f) -> vec4f {
  let px = dir / vec2f(textureDimensions(src, 0)) * 1.3;
  var c = tap(uv) * 0.2270;
  c += (tap(uv + px * 1.3846) + tap(uv - px * 1.3846)) * 0.3162;
  c += (tap(uv + px * 3.2308) + tap(uv - px * 3.2308)) * 0.0703;
  return vec4f(c, 0.0, 0.0, 1.0);
}
@fragment fn fsBlurH(i: VSOut) -> @location(0) vec4f { return blur(i.uv, vec2f(1.0, 0.0)); }
@fragment fn fsBlurV(i: VSOut) -> @location(0) vec4f { return blur(i.uv, vec2f(0.0, 1.0)); }
// anamorphic lens streaks: very wide horizontal blurs of the brightest light
fn streak(uv: vec2f, spread: f32) -> vec4f {
  let px = vec2f(spread / f32(textureDimensions(src, 0).x), 0.0);
  var c = tap(uv);
  var ws = 1.0;
  for (var k = 1; k <= 7; k++) {
    let w = exp(-f32(k * k) / 16.0);
    c += (tap(uv + px * f32(k)) + tap(uv - px * f32(k))) * w;
    ws += 2.0 * w;
  }
  return vec4f(c / ws, 0.0, 0.0, 1.0);
}
@fragment fn fsStreak1(i: VSOut) -> @location(0) vec4f { return streak(i.uv, 3.0); }
@fragment fn fsStreak2(i: VSOut) -> @location(0) vec4f { return streak(i.uv, 11.0); }
`,d=c+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneT: texture_2d<f32>;
@group(0) @binding(3) var bloom1: texture_2d<f32>;
@group(0) @binding(4) var bloom2: texture_2d<f32>;
@group(0) @binding(5) var streakT: texture_2d<f32>;

fn ramp(v: f32) -> vec3f {
  var c = u.ramp[0].rgb;
  for (var k = 1; k < 6; k++) { c = mix(c, u.ramp[k].rgb, smoothstep(u.ramp[k - 1].w, u.ramp[k].w, v)); }
  return c;
}

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let sp = vec2f((i.uv.x - 0.5) * 2.0 * u.res.z, (0.5 - i.uv.y) * 2.0);
  let L = textureSampleLevel(sceneT, samp, i.uv, 0.0).r
        + u.fx.y * (textureSampleLevel(bloom1, samp, i.uv, 0.0).r * 0.55 + textureSampleLevel(bloom2, samp, i.uv, 0.0).r * 0.9)
        + u.fx.z * textureSampleLevel(streakT, samp, i.uv, 0.0).r;
  var v = 1.0 - exp(-max(L, 0.0) * u.fx.x);
  v = mix(v, v * v * (3.0 - 2.0 * v), 0.4);
  v *= 1.0 - u.fx2.z * smoothstep(0.5, 1.9, length(sp * vec2f(0.72, 1.0)));
  // film grain, a little coarser than a pixel, strongest in the mid tones
  let g = hash21(floor(i.uv * u.res.xy * 0.7) + fract(u.a.x * 7.13) * 917.0) - 0.5;
  v += g * u.fx.w * (0.4 + 1.8 * v * (1.0 - v));
  v += u.fx2.y;
  return vec4f(ramp(clamp(v, 0.0, 1.0)), 1.0);
}
`,ee=[0,.15,.35,.55,.78,1],f=[{name:`mono`,weight:4,stops:[[0,0,0],[.13,.13,.135],[.34,.34,.35],[.56,.56,.57],[.8,.8,.81],[1,1,1]]},{name:`xray`,weight:1,stops:[[0,.005,.015],[.04,.09,.2],[.12,.3,.5],[.36,.64,.86],[.76,.91,1],[1,1,1]]},{name:`magnetar`,weight:1,stops:[[.01,0,.02],[.15,.04,.24],[.45,.13,.5],[.86,.38,.6],[1,.78,.8],[1,1,1]]},{name:`crab`,weight:1,stops:[[.01,.005,0],[.17,.07,.03],[.5,.2,.08],[.9,.52,.2],[1,.86,.62],[1,1,1]]}];function te(e){let t=f.filter(t=>t.name!==e),n=Math.random()*t.reduce((e,t)=>e+t.weight,0);for(let e of t)if((n-=e.weight)<=0)return e;return t[0]}function ne(e,t,n){let r=n*n*(3-2*n);return{name:t.name,weight:t.weight,stops:e.stops.map((e,n)=>e.map((e,i)=>e+(t.stops[n][i]-e)*r))}}function re(e,t){if(!t)return e;let n=t*Math.PI/180,r=Math.cos(n),i=Math.sin(n),a=1/3,o=Math.sqrt(1/3),s=r+(1-r)*a,c=a*(1-r)-o*i,l=a*(1-r)+o*i,u=e=>Math.min(1,Math.max(0,e));return[u(e[0]*s+e[1]*c+e[2]*l),u(e[0]*l+e[1]*s+e[2]*c),u(e[0]*c+e[1]*l+e[2]*s)]}function ie(e){let t=e>>>0;return()=>{t=t+1831565813>>>0;let e=t;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}}var p=(e,t,n)=>t+(n-t)*e(),ae=e=>e()<.5?-1:1;function m(){let e=0,t=NaN;return{name:`pulsar`,calm:!0,exposure:1.25,enter(n){e=Math.PI/2+p(n,.25,.5)*ae(n),t=NaN},frame(n,r){return Number.isNaN(t)&&(t=n.spin),r.set([e+.35*(n.spin-t),.1*(1+.06*n.kick),1+.6*n.pulse+.4*n.treble,1+.7*n.pulse+.3*n.bass],0),[0,0]}}}function oe(){let e=1,t=2;return{name:`magneto`,calm:!0,exposure:1.2,enter(n){e=p(n,1.05,1.35),t=Math.PI/2+p(n,.3,.6)*ae(n)},frame(n,r){let i=t+.04*Math.sin(n.t*.4),a=[Math.sin(e)*Math.cos(i),Math.sin(e)*Math.sin(i),Math.cos(e)],o=Math.hypot(a[0],a[1])||1,s=[a[1]/o,-a[0]/o,0],c=[a[1]*s[2]-a[2]*s[1],a[2]*s[0]-a[0]*s[2],a[0]*s[1]-a[1]*s[0]];return r.set([...a,.095*(1+.05*n.kick)],0),r.set([...s,.75+.5*n.pulse+.3*n.mid],4),r.set([...c,.6+.5*n.bass+.4*n.pulse],8),r.set([.12*n.spin],12),[0,0]}}}function h(){let e=0,t=0;return{name:`limb`,calm:!0,exposure:1.15,enter(n){e=p(n,.15,.4),t=Math.PI/2+p(n,.2,.32)},frame(n,r){return r.set([e,-.88,1.55,t],0),r.set([1+.8*n.pulse+.3*n.bass,.5+1.3*n.treble+.6*n.hat,.05*n.t],4),[e+1.55*Math.cos(t),-.88+1.55*Math.sin(t)]}}}function g(){let e=0,t=0;return{name:`ring`,calm:!1,exposure:1.05,enter(n){e=-p(n,.15,.35),t=-Math.PI/2+p(n,.25,.45)},frame(n,r){return r.set([e,.22,.62,t],0),r.set([1+.9*n.pulse+.3*n.bass],4),[e+.09,.22-.28]}}}function _(){let e=0,t=0;return{name:`eclipse`,calm:!1,exposure:1.1,enter(n){e=p(n,.25,.45),t=Math.PI+p(n,-.15,.15)},frame(n,r){return r.set([e,0,.55,t],0),r.set([1+.9*n.pulse+.3*n.bass,.7+.8*n.mid+.3*n.snare],4),[e+.53*Math.cos(t),.53*Math.sin(t)]}}}function se(){let e=0,t=NaN;return{name:`wide`,calm:!0,exposure:1.3,enter(n){e=p(n,-.5,-.2),t=NaN},frame(n,r){return Number.isNaN(t)&&(t=n.spin),r.set([0,0,e+.08*(n.spin-t),.018],0),r.set([.8+.7*n.pulse+.3*n.bass],4),[0,0]}}}function v(){let e=0,t=0;return{name:`wings`,calm:!1,exposure:1.2,enter(n){e=p(n,.2,.45),t=p(n,.3,.55)},frame(n,r){return r.set([-.45,-.12,e,1+.8*n.pulse+.3*n.treble],0),r.set([t,-.45,.8+.6*n.mid+.3*n.pulse],4),[-.45,-.12]}}}function y(){let e=0;return{name:`cellstar`,calm:!1,exposure:1.15,enter(t){e=p(t,.2,.45)},frame(t,n){return n.set([.55*t.ax-.15,-.55,.62*(1+.03*t.kick),e],0),n.set([-.3,.55,1+.6*t.pulse+.3*t.bass],4),[.55*t.ax-.15,-.55]}}}var b=[m(),oe(),h(),g(),_(),se(),v(),y()],ce=120,le=3686400,ue=.8,de=2073600,fe=async({container:c})=>{let m=navigator.gpu;if(!m)return r(c,i());let oe=await m.requestAdapter().catch(()=>null);if(!oe)return r(c,`No WebGPU adapter: enable hardware acceleration.`);let h=await oe.requestDevice(),g=document.createElement(`canvas`);g.className=`w-full h-full block`,c.appendChild(g);let _=g.getContext(`webgpu`),se=m.getPreferredCanvasFormat();_.configure({device:h,format:se,alphaMode:`opaque`});let v=!1,y=null;h.lost.then(e=>{v||(g.remove(),y=r(c,`WebGPU device lost (${e.reason||`unknown`}).`),y.resize?.(c.clientWidth,c.clientHeight,Math.min(2,window.devicePixelRatio||1)))}),h.pushErrorScope(`validation`);let[fe,x,pe]=await Promise.all([o(h,l,`pulsar-scene`),o(h,u,`pulsar-bloom`),o(h,d,`pulsar-final`)]),S=`r16float`,C=(e,t,n)=>h.createRenderPipelineAsync({layout:`auto`,vertex:{module:e,entryPoint:`vs`},fragment:{module:e,entryPoint:t,targets:[{format:n}]},primitive:{topology:`triangle-list`}}),[me,he,ge,_e,ve,ye,be,xe]=await Promise.all([C(fe,`fs`,S),C(x,`fsDown1`,S),C(x,`fsDown`,S),C(x,`fsBlurH`,S),C(x,`fsBlurV`,S),C(x,`fsStreak1`,S),C(x,`fsStreak2`,S),C(pe,`fs`,se)]),Se=await h.popErrorScope();if(Se)throw Error(`Pulsar: ${Se.message}`);let w=h.createSampler({magFilter:`linear`,minFilter:`linear`,addressModeU:`clamp-to-edge`,addressModeV:`clamp-to-edge`}),Ce=new Float32Array(ce),we=h.createBuffer({size:480,usage:s.UNIFORM|s.COPY_DST}),T=2,E=2,D=2,O=2,k=1,A=[],j,M,Te,N,Ee,De,Oe,P;function ke(e,t,n){let r=Math.max(1,e),i=Math.max(1,t),o=n;r*i*o*o>le&&(o=Math.sqrt(le/(r*i))),T=Math.max(2,Math.round(r*o)),E=Math.max(2,Math.round(i*o)),k=T/E,g.width=T,g.height=E;let s=ue;T*E*s*s>de&&(s=Math.sqrt(de/(T*E))),D=Math.max(2,Math.round(T*s)),O=Math.max(2,Math.round(E*s));for(let e of A)e.destroy();A=[];let c=(e,t)=>{let n=h.createTexture({size:[Math.max(1,e),Math.max(1,t)],format:S,usage:a.RENDER_ATTACHMENT|a.TEXTURE_BINDING});return A.push(n),n};j=c(D,O),M=c(Math.ceil(D/4),Math.ceil(O/4)),Te=c(Math.ceil(D/4),Math.ceil(O/4)),N=c(Math.ceil(D/16),Math.ceil(O/16)),Ee=c(Math.ceil(D/16),Math.ceil(O/16)),De=c(Math.ceil(D/4),Math.ceil(O/4)),Oe=c(Math.ceil(D/4),Math.ceil(O/4));let l=(e,t)=>h.createBindGroup({layout:e.getBindGroupLayout(0),entries:t.map((e,t)=>({binding:t,resource:e}))}),u=e=>e.createView(),d={buffer:we};P={scene:l(me,[d]),down1:l(he,[w,u(j)]),blurH1:l(_e,[w,u(M)]),blurV1:l(ve,[w,u(Te)]),down2:l(ge,[w,u(M)]),blurH2:l(_e,[w,u(N)]),blurV2:l(ve,[w,u(Ee)]),streak1:l(ye,[w,u(M)]),streak2:l(be,[w,u(De)]),final:l(xe,[d,w,u(j),u(M),u(N),u(Oe)])}}let Ae=new URLSearchParams(window.location.search),je=f.find(e=>e.name===Ae.get(`palette`))??null,F=b.findIndex(e=>e.name===Ae.get(`shot`)),I=0,L=0,Me=Math.random(),Ne=1,R=0,Pe=1,Fe=.03,Ie=0,Le=0,Re=0,ze=0,Be=[0,0],Ve=0,z=0,He=0,Ue=0,We=0,B=0,Ge=0,Ke=0,V=0,qe=0,Je=0,H=0,U=0,W=-1,G=0,Ye=0,K=0,Xe=!0,q=je??f[0],J=q,Y=1,X=new Float32Array(32),Z=new Float32Array(32),Q=new Float32Array(32).fill(.3),Ze=()=>Y>=1?J:ne(q,J,Y);function Qe(e){I=e,L=0,R=0,Me=Math.random();let t=ie(Math.floor(Me*2**32));b[e].enter(t),Ne=F>=0?1:ae(t),Pe=p(t,.92,1.08),Fe=p(t,.02,.05),Ie=0,Le=p(t,-.012,.012),Re=p(t,-.008,.008),ze=p(t,-.05,.05)}function $e(e){if(I!==0&&Math.random()<.25)return 0;let t=b.map((e,t)=>t).filter(t=>t!==I&&(!e||b[t].calm));return t[Math.floor(Math.random()*t.length)]}function $(e){Qe($e(e))}function et(){Ve=1,je||(q=Ze(),J=Math.random()<.35?te(J.name):f[0],Y=+(J===q)),F<0&&(z=16,$(!1))}Qe(F>=0?F:0);function tt(t,r,i,a){let o=e=>Math.exp(-i/e),s=t.silent||t.beat.confidence<.3||U<.15;if(n(t)){let n=Math.min(1,e(t)*r);B=Math.max(B,n),Ue+=Math.PI/10*n*Math.min(2,a),e(t)>=.5&&F<0&&(R++,z>0?(z--,z%2==0&&$(!1)):!s&&R>=(U>.45?8:16)&&(t.beat.barBeat===0||R>=20)&&$(!1))}B*=o(.18),Ve*=o(.12);let c=(e,t,n)=>e+(Math.min(1.5,t*r)-e)*(1-o(n));Ge=c(Ge,t.onsets.kick.envelope,.05),Ke=c(Ke,t.onsets.snare.envelope,.05),V=c(V,t.onsets.hat.envelope,.04),qe=c(qe,t.bands.bass,.12),Je=c(Je,t.bands.mid,.15),H=c(H,t.bands.treble,.1),U+=((t.silent?0:Math.min(1,t.level.rms*r*2))-U)*(1-o(.4));let l=t.silent?0:t.level.rms;W<0?l>0&&(W=G=l):(W+=(l-W)*(1-o(.3)),G+=(l-G)*(1-o(6)),Ye+=i);let u=G>.01?Math.min(1,Math.max(0,(W/G-1.1)*3))*Math.min(1,Math.max(0,(Ye-3)/3)):0;K+=(u-K)*(1-o(u>K?.15:.8)),K>.6&&Xe&&!s&&(Xe=!1,et()),K<.25&&(Xe=!0),s&&(z=0),F<0&&z===0&&L>13/Math.max(.3,a)&&(s||L>30)&&$(s),We+=(Ue-We)*(1-o(.09)),He+=i*a*(.1+.15*U),Y=Math.min(1,Y+i/1.2)}function nt(e,n,r){let i=e.spectrum({fftSize:1024,smoothing:.75}),a=1-Math.exp(-r/.15),o=1-Math.exp(-r/1.5),s=1-Math.exp(-r/2.5);for(let e=0;e<32;e++){let r=Math.floor(2*200**(e/32)),c=Math.max(r+1,Math.floor(2*200**((e+1)/32))),l=t(i,r,c)/255*(.9+e/60);Z[e]=l<Z[e]?l:Z[e]+(l-Z[e])*o,Q[e]=l>Q[e]?l:Q[e]+(l-Q[e])*s;let u=Math.max(.12,Q[e]-Z[e]),d=Math.min(1,Math.max(0,.08+(l-Z[e])/u*.92)*Math.min(1,l*3)*n);X[e]=d>X[e]?d:X[e]+(d-X[e])*a}}function rt(e,t,n){let r=Ce,i=b[I];r.set([T,E,k,2/E],0),r.set([D,O,2/O,0],4),r.set([e,L,Ge,Ke],8),r.set([V,qe,Je,H],12);let a=Math.min(1,.4+.6*k/1.4),o=Math.exp(Math.min(Ie,.6))*(1+.03*B+.02*K),s=a*t*Pe*o,c=.006*K,l=Be[0]*(1-1/o)+Le*L+c*Math.sin(e*31),u=Be[1]*(1-1/o)+Re*L+c*Math.cos(e*27);r.set([l,u,s,ze+.006*Math.sin(e*.3)],16),r.set([I,Me,U,B],20),r.set([i.exposure*(1+.25*B)*(1+.15*K),.55+.25*K,.12+.2*K+.1*H,.045+.015*V],24),r.set([0,Math.min(1,Ve),.55,Ne],28),Ze().stops.forEach((e,t)=>r.set([...re(e,n),ee[t]],32+t*4)),r.set(X,88),h.queue.writeBuffer(we,0,r)}return{resize(e,t,n){y?y.resize?.(e,t,n):ke(e,t,n)},frame({audio:e,settings:t,dt:n,time:r}){if(v||y)return;tt(e,t.sensitivity,n,t.speed),nt(e,t.sensitivity,n),L+=n,Ie+=n*Fe*t.speed*(.6+1.2*U+(z>0?4:0));let i=Ce.subarray(56,88);i.fill(0),Be=b[I].frame({t:r,spin:He+We,pulse:B,kick:Ge,snare:Ke,hat:V,bass:qe,mid:Je,treble:H,ax:k},i),rt(r,t.scale,t.hueShift);let a=h.createCommandEncoder(),o=(e,t,n)=>{let r=a.beginRenderPass({colorAttachments:[{view:e,loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,1]}]});r.setPipeline(t),r.setBindGroup(0,n),r.draw(3),r.end()};o(j.createView(),me,P.scene),o(M.createView(),he,P.down1),o(Te.createView(),_e,P.blurH1),o(M.createView(),ve,P.blurV1),o(N.createView(),ge,P.down2),o(Ee.createView(),_e,P.blurH2),o(N.createView(),ve,P.blurV2),o(De.createView(),ye,P.streak1),o(Oe.createView(),be,P.streak2),o(_.getCurrentTexture().createView(),xe,P.final),h.queue.submit([a.finish()])},dispose(){v=!0,y?.dispose();for(let e of A)e.destroy();we.destroy(),_.unconfigure(),h.destroy(),g.remove()}}};export{fe as default};
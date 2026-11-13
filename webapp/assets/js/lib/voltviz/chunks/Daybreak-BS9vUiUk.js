import{i as e,n as t,r as n}from"./audio-Ds-N7sX7.js";import{a as r,i,n as a,r as o,t as s}from"./webgpu-C8PYNhZC.js";var c=`
struct U {
  res: vec4f,   // render w, h, aspect, world units per render px
  fres: vec4f,  // field w, h, world units per field px, -
  a: vec4f,     // time, phase, kick, snare
  b: vec4f,     // hat, bass, mid, treble
  cam: vec4f,   // world point at the frame centre (x, y), zoom, roll
  sc: vec4f,    // scene id, seed, defocus, flare
  fx: vec4f,    // exposure, chromatic aberration, feedback blend, light-trail ghost
  fx2: vec4f,   // feedback zoom, black (inserts), grain, gate weave
  fx3: vec4f,   // overlays in screen space (inserts), overlay glow (world), stars, twinkle
  fx4: vec4f,   // bloom gain, fog, energy, drop
  ramp: array<vec4f, 6>, // gradient map stops: rgb, position
  ovCol: vec4f, // overlay colour, primitive count
  sp: array<vec4f, 16>,  // scene parameters
  spec: array<vec4f, 8>, // 32 spectrum bars 0..1
  ov: array<vec4f, 24>,  // 12 overlay primitives: (type, x, y, size), (p1, p2, p3, alpha)
};
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

const TAU = 6.2831853;

fn rot2(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn h11(x: f32) -> f32 { return fract(sin(x * 91.3458) * 47453.5453); }
fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
// coverage of a shape with signed distance d and edge softness w (blur)
fn cover(d: f32, w: f32) -> f32 { return smoothstep(w, -w, d); }
fn sdSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a; let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
fn sdBox(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}
`,l=`
fn screenPos(uv: vec2f) -> vec2f { return vec2f((uv.x - 0.5) * 2.0 * u.res.z, (0.5 - uv.y) * 2.0); }
fn world(uv: vec2f) -> vec2f { return rot2(u.cam.w) * screenPos(uv) / u.cam.z + u.cam.xy; }
`,u=c+`
@group(0) @binding(0) var<uniform> u: U;
`+l+`
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), w.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), w.x), w.y);
}
fn fbm(p: vec2f) -> f32 {
  var v = 0.0; var a = 0.5; var q = p;
  for (var i = 0; i < 4; i++) { v += a * vnoise(q); q = rot2(0.6) * q * 2.03 + vec2f(1.7, 9.2); a *= 0.5; }
  return v;
}
fn spec(i: i32) -> f32 { let k = clamp(i, 0, 31); return u.spec[k / 4][k % 4]; }

// Haze behind everything: dark navy with lighter, slowly drifting patches.
fn fog(p: vec2f) -> f32 {
  let t = u.a.x * 0.025;
  let n = fbm(p * 0.85 + vec2f(t, -t * 0.7) + u.sc.y * 10.0);
  return u.fx4.y * (0.25 + 2.2 * n * n * n);
}

// soft glows (out-of-focus lights): sp[first..last) = (x, y, radius, intensity)
fn glows(p: vec2f, first: i32, last: i32) -> f32 {
  var L = 0.0;
  for (var k = first; k < last; k++) {
    let b = u.sp[k];
    if (b.w <= 0.0) { continue; }
    let d = length(p - b.xy) / b.z;
    L += b.w * exp(-d * d * 2.2);
  }
  return L;
}

// A wedge of light from the origin along angle ang (half-angle hw), fading out towards len.
fn wedge(q: vec2f, ang: f32, hw: f32, len: f32, w: f32) -> f32 {
  let r = length(q);
  var da = atan2(q.y, q.x) - ang;
  da -= TAU * round(da / TAU);
  if (abs(da) > 1.4) { return 0.0; }
  let d = r * sin(abs(da)) - sin(hw) * r;
  return cover(d, w + r * 0.015) * (1.0 - smoothstep(len * 0.4, len, r)) / (1.0 + r * 0.9);
}

// 0 burst: rays from a sun (lengths follow the spectrum), a folded ribbon, a moon.
fn hairpin(q: vec2f, R: f32, tail: f32) -> f32 {
  if (q.x > 0.0) { return max(abs(abs(q.y) - R), q.x - tail); }
  return abs(length(q) - R);
}
fn sceneBurst(p: vec2f, px: f32) -> f32 {
  let c = u.sp[0].xy;
  let q = p - c;
  let r = length(q);
  let a = atan2(q.y, q.x);
  let n = i32(u.sp[1].x);
  let blur = u.sc.z;
  var L = 0.0;
  for (var i = 0; i < n; i++) {
    let fi = f32(i) + u.sc.y * 31.0;
    let h1 = h11(fi * 1.37 + 0.1);
    let h2 = h11(fi * 2.71 + 0.3);
    let h3 = h11(fi * 3.93 + 0.7);
    let ang = u.sp[1].y + (f32(i) + (h1 - 0.5) * 0.7) * TAU / f32(n);
    var da = a - ang;
    da -= TAU * round(da / TAU);
    if (abs(da) > 1.0) { continue; }
    let thin = select(0.0, 1.0, h2 > 0.8); // a few hair-thin threads of light
    let hw = mix(u.sp[1].w * (0.45 + 0.9 * h3), 0.0035, thin);
    let len = u.sp[1].z * (0.5 + 0.8 * h1) * (0.55 + 0.8 * spec(i * 32 / n)) * (1.0 + 0.6 * thin);
    let d = r * sin(abs(da)) - hw * r - 0.003;
    let w = px + blur + r * 0.02;
    let along = 1.0 - smoothstep(len * 0.3, len, r);
    let fib = 0.7 + 0.3 * vnoise(vec2f(da * 70.0 + fi * 5.0, r * 5.0 - u.a.y * 2.0));
    L += cover(d, w) * along * fib * mix(0.8 + 0.6 * h3, 2.0, thin) * 1.5 / (1.0 + r * 1.3);
  }
  let core = u.sp[0].z;
  L += u.sc.w * (6.0 * exp(-r * r / (core * core)) + 0.5 / (1.0 + r * r * 40.0));
  let hp = u.sp[2];
  let hq = u.sp[3];
  if (hq.x > 0.0) {
    let qh = rot2(-hq.z) * (p - hp.xy);
    let d = hairpin(qh, hp.z, hq.y) - hp.w;
    L += hq.x * cover(d, px + blur + hq.w) * (0.75 + 0.45 * vnoise(qh * 7.0));
  }
  let m = u.sp[4];
  if (m.w > 0.0) {
    let qm = p - m.xy;
    let dm = length(qm) - m.z;
    let lit = smoothstep(-m.z, m.z * 0.6, dot(qm, normalize(c - m.xy)));
    L += m.w * (cover(dm, px * 1.5 + blur * 0.3) * (0.2 + 1.3 * lit) + 0.12 * exp(-max(dm, 0.0) * 30.0));
  }
  return L;
}

// 1 stars: concave stars with uneven spikes at different depths, glows, out-of-focus slabs.
fn starSd(q: vec2f, size: f32, ra: f32, n: i32, seed: f32) -> f32 {
  var d = length(q) - size * 0.27;
  for (var j = 0; j < n; j++) {
    let h = h11(seed * 17.0 + f32(j) * 3.1);
    let ang = ra + (f32(j) + (h - 0.5) * 0.4) * TAU / f32(n);
    let dir = vec2f(cos(ang), sin(ang));
    let len = size * (0.75 + 0.9 * h) * select(1.0, 1.8, j == 0);
    let t = dot(q, dir);
    if (t > 0.0) {
      // beyond the tip: the distance to the tip, so blurred spikes fade out instead of ending flat
      let perp = abs(q.x * dir.y - q.y * dir.x);
      d = min(d, select(perp - size * 0.28 * pow(1.0 - t / len, 2.0), length(q - dir * len), t >= len));
    }
  }
  return d;
}
fn sceneStars(p: vec2f, px: f32) -> f32 {
  var L = glows(p, 10, 14);
  for (var k = 14; k < 16; k++) {
    let s = u.sp[k];
    if (s.w <= 0.0) { continue; }
    let qq = rot2(-s.z) * (p - s.xy);
    L += s.w * cover(sdBox(qq, vec2f(1.6, 0.13)), 0.09 + u.sc.z);
  }
  for (var k = 0; k < 5; k++) {
    let A = u.sp[k * 2];
    let B = u.sp[k * 2 + 1];
    if (B.w <= 0.0) { continue; }
    let q = p - A.xy;
    let d = starSd(q, A.z, A.w, i32(B.x), B.y);
    L += B.w * cover(d, px + B.z + u.sc.z) * (0.8 + 0.8 * exp(-length(q) / (A.z * 0.35)));
  }
  return L;
}

// 2 ribbons: twisting bands (thin where they turn edge-on) sweeping through the frame.
fn sceneRibbons(p: vec2f, px: f32) -> f32 {
  var L = glows(p, 12, 16);
  for (var i = 0; i < 4; i++) {
    let A = u.sp[i * 3];
    let B = u.sp[i * 3 + 1];
    let C = u.sp[i * 3 + 2];
    if (C.z <= 0.0) { continue; }
    let q = rot2(-C.w) * p;
    let arg = A.z * q.x + A.w;
    let yc = A.x + A.y * sin(arg);
    let slope = A.y * A.z * cos(arg);
    let dy = (q.y - yc) / sqrt(1.0 + slope * slope);
    let tw = cos(B.y * q.x + B.z);
    let th = B.x * (0.1 + 0.9 * abs(tw));
    let d = max(abs(dy) - th, max(C.x - q.x, q.x - C.y));
    let shade = 0.5 + 0.5 * abs(tw) + 0.3 * smoothstep(-th, th, dy * sign(tw));
    L += C.z * cover(d, px + B.w + u.sc.z) * shade;
  }
  return L;
}

// 3 beacon: cones of light from one bright point, a broad beam from off-frame, lens ghosts.
fn sceneBeacon(p: vec2f, px: f32) -> f32 {
  let ap = u.sp[0];
  let q = p - ap.xy;
  let r = length(q);
  var L = 0.0;
  for (var k = 1; k < 5; k++) {
    let c = u.sp[k];
    if (c.w > 0.0) { L += c.w * wedge(q, c.x, c.y, c.z, px + u.sc.z); }
  }
  let bm = u.sp[5];
  let bm2 = u.sp[6];
  if (bm2.y > 0.0) { L += bm2.y * wedge(p - bm.xy, bm.z, bm.w, bm2.x, px + bm2.z + u.sc.z); }
  let toC = u.cam.xy - ap.xy;
  for (var g = 0; g < 4; g++) {
    let hg = h11(f32(g) + u.sc.y * 3.0);
    let tg = 1.3 + f32(g) * 0.45 + hg * 0.3;
    let gr = 0.03 + 0.12 * hg;
    let d = length(p - (ap.xy + toC * tg)) - gr;
    L += 0.07 * ap.z * cover(d, 0.01 + 0.25 * gr);
  }
  L += ap.z * (5.0 * exp(-r * r / (ap.w * ap.w)) + 0.4 / (1.0 + r * r * 50.0));
  return L;
}

// 4 fan: blades turning around a hub (twisted with the radius), floating discs.
fn sceneFan(p: vec2f, px: f32) -> f32 {
  let c = u.sp[0];
  let q = p - c.xy;
  let r = length(q);
  let n = i32(u.sp[1].x);
  var L = 0.0;
  let a = atan2(q.y, q.x) - c.w * r;
  for (var i = 0; i < n; i++) {
    let h = h11(f32(i) * 5.3 + u.sc.y * 17.0);
    var da = a - (c.z + f32(i) * TAU / f32(n));
    da -= TAU * round(da / TAU);
    if (abs(da) > 1.4) { continue; }
    let l = u.sp[1].z * (0.6 + 0.6 * h);
    let d = r * sin(abs(da)) - sin(u.sp[1].y * (0.6 + 0.6 * h)) * r * (1.0 - 0.35 * r / l);
    L += u.sp[1].w * cover(max(d, max(r - l, 0.035 - r)), px + u.sc.z + 0.004 + r * 0.012) * (1.35 - 0.7 * r / l);
  }
  for (var k = 2; k < 6; k += 2) {
    let E = u.sp[k];
    let F = u.sp[k + 1];
    if (F.y <= 0.0) { continue; }
    let qe = rot2(-F.x) * (p - E.xy);
    let d = (length(qe / E.zw) - 1.0) * min(E.z, E.w);
    L += F.y * cover(d, px + F.z + u.sc.z) * (0.65 + 0.5 * qe.y / E.w);
  }
  L += u.sc.w * (4.0 * exp(-r * r / 0.0016) + 0.3 / (1.0 + r * r * 60.0));
  return L;
}

// 5 nebula: slow clouds (calm passages), glows that bloom on soft kicks.
fn sceneNebula(p: vec2f, px: f32) -> f32 {
  let t = u.a.y * 0.12 + u.a.x * 0.015;
  let w = vec2f(fbm(p * 0.8 + vec2f(t, 1.3)), fbm(p * 0.8 + vec2f(4.1, -t)));
  let n = fbm(p * 1.3 + w * 1.7 + u.sc.y * 7.0);
  var L = 0.08 + u.sp[1].x * pow(n, 2.6);
  for (var k = 2; k < 5; k++) {
    let g = u.sp[k];
    let d = length(p - g.xy) / g.z;
    L += g.w * exp(-d * d * 2.0) * (0.4 + n);
  }
  return L;
}

// 6 horizon: a white plain under a low sun with a cross-shaped flare, a house on the horizon.
fn sceneHorizon(p: vec2f, px: f32) -> f32 {
  let H = u.sp[0];
  let S = u.sp[1];
  let hy = H.x;
  let sun = H.yz;
  let dy = p.y - hy;
  let sky = 0.1 + 0.9 * exp(-max(dy, 0.0) * 3.0) * (0.6 + 0.4 * exp(-abs(p.x - sun.x) * 1.5));
  let z = 0.35 / max(-dy, 0.004);
  let stripe = 0.5 + 0.5 * sin(z * 2.2 - S.y);
  let track = abs(abs((p.x - sun.x * 0.6) * z) - 0.9);
  var ground = (0.55 + 0.9 * exp(dy * 2.5)) * (0.75 + 0.25 * stripe * smoothstep(40.0, 4.0, z));
  ground *= 1.0 - 0.4 * cover(track - 0.05, 0.03 + px * z) * smoothstep(60.0, 8.0, z);
  var L = mix(sky, ground, cover(dy, px + u.sc.z * 0.5));
  let ds = length(p - sun);
  L += S.x * (5.0 * exp(-ds * ds / (H.w * H.w)) + 0.6 / (1.0 + ds * ds * 25.0));
  L += S.x * (0.9 * exp(-abs(p.y - sun.y) * 90.0) * exp(-abs(p.x - sun.x) * 1.0)
            + 0.7 * exp(-abs(p.x - sun.x) * 110.0) * exp(-abs(p.y - sun.y) * 2.2));
  // the house: a dark silhouette with one lit window
  let hq = (p - vec2f(S.z, hy)) / S.w;
  let body = sdBox(hq - vec2f(0.0, 0.5), vec2f(0.6, 0.5));
  let roof = max((hq.y - 1.6 + 0.8 * abs(hq.x)) * 0.78, 1.0 - hq.y);
  L = mix(L, 0.04, 0.95 * cover(min(body, roof) * S.w, px));
  L += 2.5 * cover(sdBox(hq - vec2f(0.18, 0.45), vec2f(0.13, 0.13)) * S.w, px);
  return L;
}

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let p = world(i.uv);
  let px = u.fres.z / u.cam.z;
  var L = fog(p);
  switch i32(u.sc.x) {
    case 0: { L += sceneBurst(p, px); }
    case 1: { L += sceneStars(p, px); }
    case 2: { L += sceneRibbons(p, px); }
    case 3: { L += sceneBeacon(p, px); }
    case 4: { L += sceneFan(p, px); }
    case 5: { L += sceneNebula(p, px); }
    case 6: { L = sceneHorizon(p, px) + L * 0.3; }
    default: {}
  }
  return vec4f(L, 0.0, 0.0, 1.0);
}
`,d=c+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var cur: texture_2d<f32>;
@group(0) @binding(3) var prev: texture_2d<f32>;

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let s = textureSampleLevel(cur, samp, i.uv, 0.0).r;
  let pr = textureSampleLevel(prev, samp, (i.uv - 0.5) * u.fx2.x + 0.5, 0.0).r;
  return vec4f(max(mix(s, pr, u.fx.z), min(pr, 3.0) * u.fx.w), 0.0, 0.0, 1.0);
}
`,f=c+`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

fn tap(uv: vec2f) -> f32 { return textureSampleLevel(src, samp, uv, 0.0).r; }
fn box4(uv: vec2f) -> f32 {
  let px = 1.0 / vec2f(textureDimensions(src, 0));
  return (tap(uv + px * vec2f(-1.0, -1.0)) + tap(uv + px * vec2f(1.0, -1.0))
        + tap(uv + px * vec2f(-1.0, 1.0)) + tap(uv + px * vec2f(1.0, 1.0))) * 0.25;
}
// soft knee: only the bright light blooms
@fragment fn fsDown1(i: VSOut) -> @location(0) vec4f { let c = box4(i.uv); return vec4f(c * smoothstep(0.45, 2.0, c), 0.0, 0.0, 1.0); }
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
`,p=c+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var fieldT: texture_2d<f32>;
@group(0) @binding(3) var bloom1: texture_2d<f32>;
@group(0) @binding(4) var bloom2: texture_2d<f32>;
`+l+`
fn light(uv: vec2f) -> f32 {
  return textureSampleLevel(fieldT, samp, uv, 0.0).r
       + (textureSampleLevel(bloom1, samp, uv, 0.0).r * 0.5
       + textureSampleLevel(bloom2, samp, uv, 0.0).r * 0.85) * u.fx4.x;
}
fn tone(L: f32) -> f32 { return 1.0 - exp(-max(L, 0.0) * u.fx.x); }
// the gradient map: light 0..1 through the palette stops
fn ramp(v: f32) -> vec3f {
  var c = u.ramp[0].rgb;
  for (var k = 1; k < 6; k++) { c = mix(c, u.ramp[k].rgb, smoothstep(u.ramp[k - 1].w, u.ramp[k].w, v)); }
  return c;
}

// Thin line work. Returns (core coverage, glow).
fn overlays(p: vec2f, px: f32) -> vec2f {
  var core = 0.0;
  var glow = 0.0;
  let n = i32(u.ovCol.w);
  for (var k = 0; k < n; k++) {
    let A = u.ov[k * 2];
    let B = u.ov[k * 2 + 1];
    let q = p - A.yz;
    let s = A.w;
    var d = 1e3;
    var wmul = 1.0;
    var lit = 1.0;
    switch i32(A.x) {
      case 1: { // arc: radius s, start angle p1, length p2, width p3
        var t = atan2(q.y, q.x) - B.x;
        t -= TAU * floor(t / TAU);
        if (B.y >= TAU || t <= B.y) { d = abs(length(q) - s); }
        else {
          let e0 = s * vec2f(cos(B.x), sin(B.x));
          let e1 = s * vec2f(cos(B.x + B.y), sin(B.x + B.y));
          d = min(length(q - e0), length(q - e1));
        }
        wmul = B.z;
      }
      case 2: { // plus: size s, rotation p1
        let a = abs(rot2(-B.x) * q);
        d = min(max(a.x - s, a.y), max(a.y - s, a.x));
      }
      case 3: { // arrow pointing along p1
        let a = rot2(-B.x) * q;
        d = min(sdSeg(a, vec2f(-s, 0.0), vec2f(s, 0.0)),
            min(sdSeg(a, vec2f(s, 0.0), vec2f(s * 0.4, s * 0.45)), sdSeg(a, vec2f(s, 0.0), vec2f(s * 0.4, -s * 0.45))));
      }
      case 4: { // row of p1 squares, square p2 filled
        let spc = s * 1.75;
        let kk = clamp(round(q.x / spc), 0.0, B.x - 1.0);
        let bx = sdBox(q - vec2f(kk * spc, 0.0), vec2f(s * 0.5));
        d = select(abs(bx), bx, kk == B.y);
      }
      case 5: { // four-point sparkle
        let a = abs(rot2(-B.x) * q) / s;
        d = (pow(a.x, 0.6667) + pow(a.y, 0.6667) - 1.0) * s * 0.45;
      }
      case 6: { // segment to (p1, p2), width p3
        d = sdSeg(p, A.yz, B.xy);
        wmul = B.z;
      }
      case 7: { // row of p1 rings, the first p2 lit
        let spc = s * 3.4;
        let kk = clamp(round(q.x / spc), 0.0, B.x - 1.0);
        d = abs(length(q - vec2f(kk * spc, 0.0)) - s);
        lit = select(0.1, 1.0, kk < B.y);
        wmul = B.z;
      }
      default: {}
    }
    let a = B.w * lit;
    let hw = px * 0.7 * wmul;
    core += a * clamp((hw - d) / px + 0.5, 0.0, 1.0);
    glow += a * exp(-max(d - hw, 0.0) / u.fx3.y) * 0.55;
  }
  return vec2f(min(core, 1.0), glow);
}

// A sparse starfield (crisp, at full resolution), twinkling, faster on hi-hats.
fn stars(p: vec2f, px: f32) -> f32 {
  let g = 0.05;
  let cell = floor(p / g);
  let h = hash21(cell + 3.1);
  if (h < 0.84) { return 0.0; }
  let o = (vec2f(hash21(cell + 7.7), hash21(cell + 1.9)) * 0.7 + 0.15) * g;
  let d = length(p - cell * g - o);
  let tw = 0.6 + 0.4 * sin(u.a.x * (1.3 + 4.0 * h) + h * 50.0) + u.fx3.w * (hash21(cell + floor(u.a.x * 20.0)) - 0.3);
  return smoothstep(px * 1.6, 0.0, d) * max(tw, 0.0) * (0.35 + 3.5 * (h - 0.84));
}

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let t = u.a.x;
  let uv = i.uv + vec2f(0.0, u.fx2.w);
  let dir = uv - 0.5;
  let ca = u.fx.y * (0.25 + dot(dir, dir) * 2.0);
  let lr = tone(light(uv + dir * ca));
  let lg = tone(light(uv));
  let lb = tone(light(uv - dir * ca));
  var col = vec3f(ramp(lr).r, ramp(lg).g, ramp(lb).b);

  let p = world(uv);
  let px = u.res.w / u.cam.z;
  col += u.ovCol.rgb * stars(p, px) * u.fx3.z * (1.0 - smoothstep(0.2, 0.5, lg));
  col *= 1.0 - u.fx2.y; // inserts: a black frame
  var ov: vec2f;
  if (u.fx3.x > 0.5) { ov = overlays(screenPos(uv), u.res.w); } else { ov = overlays(p, px); }
  col += u.ovCol.rgb * (ov.x + ov.y);

  // The film gate: rounded corners, a soft dark edge, vignette.
  let asp = u.res.z;
  let fq = abs(dir) * 2.0 * vec2f(asp, 1.0);
  let rr = 0.12;
  let fd = length(max(fq - vec2f(asp, 1.0) + rr + 0.012, vec2f(0.0))) - rr;
  col *= smoothstep(0.0, -0.035, fd);
  col *= mix(0.4, 1.0, smoothstep(1.75, 0.35, length(dir * vec2f(1.45, 1.85))));

  // grain (24 fps, strongest in the mid-tones) and a little dither against banding
  let gs = i.pos.xy + vec2f(floor(t * 24.0) * 37.0, 0.0);
  let l = dot(col, vec3f(0.3, 0.55, 0.15));
  col += (hash21(gs) - 0.5) * u.fx2.z * (0.35 + 0.65 * (1.0 - abs(l * 2.0 - 1.0)));
  col += (hash21(gs + 17.0) - 0.5) / 255.0;
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`,ee=[0,.16,.34,.52,.72,1],m=[{name:`dawn`,weight:3,stops:[[.004,.006,.03],[.05,.075,.25],[.2,.26,.58],[.58,.52,.64],[.95,.72,.47],[1,.97,.9]]},{name:`ultramarine`,weight:2,stops:[[.002,.004,.03],[.01,.04,.3],[.06,.2,.85],[.35,.55,1],[.76,.88,1],[.97,.99,1]]},{name:`glacier`,weight:1.5,stops:[[0,.008,.018],[0,.07,.15],[.04,.32,.48],[.28,.72,.82],[.74,.96,1],[.97,1,1]]},{name:`rose`,weight:1,stops:[[.018,.002,.03],[.12,.03,.2],[.42,.15,.45],[.86,.45,.6],[1,.78,.72],[1,.97,.93]]},{name:`ember`,weight:1,stops:[[.01,.002,.002],[.13,.015,.02],[.46,.06,.04],[.9,.33,.08],[1,.73,.32],[1,.97,.86]]},{name:`verdigris`,weight:1,stops:[[0,.014,.014],[.02,.1,.1],[.08,.32,.3],[.45,.6,.42],[.95,.85,.55],[1,.98,.9]]},{name:`silver`,weight:.6,stops:[[.008,.008,.01],[.07,.075,.09],[.25,.26,.3],[.55,.56,.6],[.86,.86,.88],[1,1,1]]}];function h(e){let t=m.filter(t=>t.name!==e),n=Math.random()*t.reduce((e,t)=>e+t.weight,0);for(let e of t)if((n-=e.weight)<=0)return e;return t[0]}function te(e,t,n){let r=n*n*(3-2*n);return{name:t.name,weight:t.weight,stops:e.stops.map((e,n)=>e.map((e,i)=>e+(t.stops[n][i]-e)*r))}}function ne(e,t){if(!t)return e;let n=t*Math.PI/180,r=Math.cos(n),i=Math.sin(n),a=.299*e[0]+.587*e[1]+.114*e[2],o=.596*e[0]-.274*e[1]-.322*e[2],s=.211*e[0]-.523*e[1]+.312*e[2],c=o*r-s*i,l=o*i+s*r;return[Math.max(0,a+.956*c+.621*l),Math.max(0,a-.272*c-.647*l),Math.max(0,a-1.106*c+1.703*l)]}var g=Math.PI*2,_={ARC:1,PLUS:2,ARROW:3,SQUARES:4,SPARKLE:5,SEGMENT:6,RINGS:7},re=12;function ie(e){let t=e>>>0;return()=>{t=t+1831565813>>>0;let e=t;return e=Math.imul(e^e>>>15,e|1),e^=e+Math.imul(e^e>>>7,e|61),((e^e>>>14)>>>0)/4294967296}}var v=(e,t,n)=>t+(n-t)*e(),y=e=>e()<.5?-1:1;function ae(){let e=0,t=0,n=22,r=.04,i=0,a=1,o=0,s=1,c=0,l=0,u=0,d=[];return{name:`burst`,beats:16,calm:!1,enter(f){e=v(f,-.35,.15),t=v(f,-.12,.15),n=16+Math.floor(f()*11),r=v(f,.035,.065),i=f()*g,a=y(f),o=+(f()<.65),s=y(f),c=+(f()<.6),l=v(f,.3,.75),u=v(f,.5,.75),d=[0,1,2].map(()=>[v(f,-1,1),v(f,-.8,.8),f()*10])},frame(f,p,ee){let m=e+.04*Math.sin(f.local*.37),h=t+.03*Math.cos(f.local*.29),te=i+a*(f.local*.06+f.spin*.35);p.set([m,h,(.035+.02*f.bass)*f.scale,0],0),p.set([n,te,(1.3+.45*f.kick+.3*f.pulse)*f.scale,r],4),o&&(p.set([s*f.ax*.72+.1*Math.sin(f.local*.4),h-.05,.22*f.scale,(.045+.012*f.mid)*f.scale],8),p.set([.9+.4*f.mid,1.4,(s<0?Math.PI:0)+.15*Math.sin(f.local*.3),.004],12)),c&&p.set([l*f.ax,u,.035*f.scale,1.1],16),ee(_.ARC,m,h,(.3+.06*f.kick)*f.scale,-f.spin*.2+.6,g*.78,1,.45),ee(_.PLUS,m+.44*f.scale,h-.2*f.scale,.018,0,0,1,.75);for(let[e,t,n]of d)ee(_.SPARKLE,e*f.ax,t,.022,.2,0,1,Math.max(0,.25+.6*Math.sin(f.t*1.7+n)+.8*f.hat));return{flare:1+1.6*f.kick+.8*f.pulse,fog:.16,defocus:.004,stars:.7,spectrum:!0}}}}function oe(){let e=[],t=[],n=[],r=[];return{name:`stars`,beats:16,calm:!0,enter(i){let a=3+Math.floor(i()*3);e=Array.from({length:a},(e,t)=>({x:v(i,-1.1,1.1),y:v(i,-.7,.7),size:t===0?v(i,.3,.45):v(i,.1,.3),rot:i()*g,rs:v(i,.05,.2)*y(i),n:4+Math.floor(i()*3),seed:i()*100,blur:t===0?.002:v(i,.01,.07),i:v(i,.9,1.4),vx:v(i,-.06,.06),vy:v(i,-.04,.04)})),t=[0,1,2,3].map(()=>[v(i,-1.3,1.3),v(i,-.8,.8),v(i,.25,.55),v(i,.2,.55)]),n=i()<.6?[v(i,-.6,.6),v(i,-.7,.7),v(i,-.9,.9),v(i,.5,.9)]:[0,0,0,0],r=[0,1,2,3].map(()=>[v(i,-1,1),v(i,-.85,.85),i()*10])},frame(i,a,o){let s=i.ax+.5,c=(e,t)=>((e+t)%(2*t)+2*t)%(2*t)-t;e.forEach((e,t)=>{let n=c(e.x*i.ax+e.vx*i.local,s),r=c(e.y+e.vy*i.local,1.4);a.set([n,r,e.size*i.scale*(1+.14*i.kick+.06*i.pulse),e.rot+e.rs*i.local+i.spin*.5*(t%2?1:-1)],t*8),a.set([e.n,e.seed,e.blur,e.i*(.85+.3*i.snare)],t*8+4)}),t.forEach((e,t)=>a.set([e[0]*i.ax+.05*Math.sin(i.local*.3+t),e[1],e[2]*(1+.25*i.bass),e[3]*(.8+.6*i.mid)],(10+t)*4)),a.set([n[0]+.3*Math.sin(i.local*.1),n[1],n[2],n[3]],56);for(let[e,t,n]of r)o(_.SPARKLE,e*i.ax,t,.02,0,0,1,Math.max(0,.2+.6*Math.sin(i.t*2.1+n)+.9*i.hat));o(_.PLUS,r[0][0]*i.ax*.6,r[1][1]*.6,.016,0,0,1,.7);let l=i.sceneTime%5/5;if(l<.25){let e=l/.25,t=-i.ax*.9+e*i.ax*1.4,n=.6-e*.5;o(_.SEGMENT,t,n,0,t+.3,n-.1,.8,Math.sin(e*Math.PI)*.8)}return{flare:1,fog:.17,defocus:0,stars:1}}}}function b(){let e=[],t=[],n=-2.4;return{name:`ribbons`,beats:16,calm:!0,enter(r){let i=v(r,-.4,.4),a=3+Math.floor(r()*2);e=Array.from({length:a},(e,t)=>({y:-.55+1.1*(t+v(r,.2,.8))/a,amp:v(r,.04,.16),f:v(r,1.4,3),ph:r()*g,th:v(r,.05,.11),tf:v(r,1.2,3.5),tp:r()*g,blur:t===1?.002:v(r,.01,.06),x0:v(r,-2.5,-.5),len:v(r,1.2,2.6),i:v(r,.9,1.4),slant:i+v(r,-.08,.08),v:v(r,.25,.5)})),t=[0,1,2,3].map(()=>[v(r,-1.3,1.3),v(r,-.8,.8),v(r,.3,.6),v(r,.2,.5)]),n=v(r,-2.6,-2)},frame(r,i,a){let o=2*r.ax+3;return e.forEach((e,t)=>{let n=((e.x0+e.v*r.local+o/2)%o+o)%o-o/2-.5;i.set([e.y,e.amp*(1+.5*r.bass),e.f,e.ph+r.local*.9],t*12),i.set([e.th*r.scale*(1+.25*r.kick),e.tf,e.tp+r.local*(.5+.6*r.mid)+r.spin*.3,e.blur],t*12+4),i.set([n,n+e.len*r.scale,e.i,e.slant],t*12+8)}),t.forEach((e,t)=>i.set([e[0]*r.ax,e[1]+.05*Math.sin(r.local*.4+t),e[2],e[3]*(.8+.6*r.mid)],(12+t)*4)),a(_.ARC,0,n,2.75,1+r.local*.02,1.1,1,.35),a(_.ARC,.4,n-.2,2.9,1.2+r.local*.015,.9,1,.2),a(_.PLUS,-.55*r.ax,.55,.016,0,0,1,.6),{flare:1,fog:.17,defocus:0,stars:.6}}}}function se(){let e=0,t=0,n=[],r=[],i=0;return{name:`beacon`,beats:8,calm:!1,enter(a){e=v(a,-.2,.2),t=v(a,-.15,.15);let o=a()<.5?Math.PI/2:-Math.PI/2;n=[[o-v(a,.25,.5),v(a,.06,.14),v(a,1.8,2.6),v(a,1,1.35)],[o+v(a,.25,.5),v(a,.06,.14),v(a,1.8,2.6),v(a,1,1.35)],[o+Math.PI+v(a,-.5,.5),v(a,.08,.18),v(a,1.2,2),v(a,.8,1.1)],a()<.5?[o+Math.PI+v(a,.6,1.1)*y(a),v(a,.03,.07),v(a,1.5,2.4),1]:[0,0,0,0]],r=[y(a)*1.6,v(a,.6,1.1),0,v(a,.12,.2)],r[2]=Math.atan2(t-r[1],e-r[0])+v(a,-.3,.3),i=a()*g},frame(a,o,s){let c=e+.05*Math.sin(a.local*.3),l=t+.03*Math.cos(a.local*.4);return o.set([c,l,1+1.5*a.kick+.6*a.pulse,.03*a.scale],0),n.forEach((e,t)=>{o.set([e[0]+.25*Math.sin(a.local*.5+i+t*1.7)*.6+a.spin*.12,e[1],e[2]*a.scale*(1+.3*a.kick),e[3]],4+t*4)}),o.set([r[0]*a.ax,r[1],r[2]+.1*Math.sin(a.local*.2),r[3]],20),o.set([3.2,.55+.3*a.bass,.05,0],24),s(_.SQUARES,c+.07,l+.05,.02,4,a.barBeat,1,.85),s(_.ARC,c+.6,l-.42,.73,1.9+a.local*.05,1.3,1,.4),s(_.ARROW,c-.32,l+.04,.03,Math.PI,0,1,.65),{flare:1,fog:.15,defocus:.002,stars:.6}}}}function ce(){let e=0,t=0,n=6,r=.16,i=1.9,a=1,o=0,s=1,c=[];return{name:`fan`,beats:16,calm:!1,enter(l){e=v(l,-.25,.25),t=v(l,-.15,.15),n=4+Math.floor(l()*4),r=v(l,.13,.24),i=v(l,1.6,2.3),a=v(l,.15,.55)*y(l),o=l()*g,s=y(l),c=[0,1].map(()=>[v(l,.45,.9),l()*g,v(l,.18,.32),v(l,.06,.11),v(l,.01,.06)])},frame(l,u,d){let f=o+s*(l.local*.35+l.spin*.8);u.set([e,t,f,a],0),u.set([n,r,i*l.scale*(1+.15*l.bass),.7+.3*l.kick],4),c.forEach((n,r)=>{let i=n[1]+s*l.local*.25;u.set([e+Math.cos(i)*n[0]*l.ax*.8,t+Math.sin(i)*n[0]*.55,n[2]*l.scale,n[3]*l.scale],8+r*8),u.set([i*.5,.95,n[4],0],12+r*8)});let p=(.42+.05*l.kick)*l.scale;d(_.ARC,e,t,p,0,g,1,.38),d(_.ARC,e,t,p*1.12,f*.5,.5,1,.5);for(let n=0;n<2;n++){let r=f*.5+n*Math.PI+.9;d(_.ARROW,e+Math.cos(r)*p*1.3,t+Math.sin(r)*p*1.3,.03,r+(s>0?Math.PI/2:-Math.PI/2),0,1,.6)}return d(_.PLUS,e,t,.022,f*.25,0,1,.5),{flare:1+1.2*l.kick+.5*l.pulse,fog:.15,defocus:.003,stars:.4}}}}function x(){let e=0,t=[[0,0,.3,0],[0,0,.3,0],[0,0,.3,0]],n=Math.random;return{name:`nebula`,beats:16,calm:!0,enter(e){n=e;for(let e of t)e[3]=0},frame(r,i,a){if(i.set([0,0,0,0,.75+.45*r.mid+.3*r.bass,0,0,0],0),r.kickHit){let i=t[e++%t.length];i[0]=v(n,-r.ax*.8,r.ax*.8),i[1]=v(n,-.6,.6),i[2]=v(n,.2,.45),i[3]=.9}return t.forEach((e,t)=>{e[3]*=Math.exp(-r.dt/.5),i.set(e,8+t*4)}),a(_.PLUS,-.6*r.ax,.35,.016,0,0,1,.5),a(_.ARC,.5*r.ax,-.3,.12,r.local*.3,4.5,1,.3),{flare:1,fog:.12,defocus:0,stars:1.3}}}}function le(){let e=0,t=0;return{name:`horizon`,beats:16,calm:!0,enter(n){e=v(n,-.6,.6),t=v(n,-.35,.35)},frame(n,r,i){let a=-.18+.03*Math.sin(n.local*.2);return r.set([a,e*n.ax,a+.3,(.05+.02*n.bass)*n.scale],0),r.set([1+1.2*n.kick+.5*n.pulse,n.local*3,t*n.ax,.055*n.scale],4),i(_.PLUS,e*n.ax,a+.3,.05+.02*n.kick,0,0,.8,.35),{flare:1,fog:.12,defocus:0,stars:.9}}}}var S=[ae(),oe(),b(),se(),ce(),x(),le()],ue=[(e,t,n)=>{n(_.ARC,-.25,-.05,.6,2.2,.15+3.6*e,2.4,1),n(_.ARC,.25,.2,.32,-.6,.1+1.8*e,1.6,.8)},(e,t,n)=>{let r=Math.min(.035,t/22);n(_.RINGS,-12*r*1.7,0,r,13,Math.ceil(e*13),2.2,1)},(e,t,n)=>{for(let r=0;r<3;r++){let i=e*2.6-1.3+r*.2,a=i*t*.6,o=-i*.9+(r-1)*.12;n(_.SEGMENT,a-.35,o-.5,0,a+.35,o+.5,2.2,r===1?1:.6)}},(e,t,n)=>{n(_.ARC,0,0,.1,Math.PI/2,.3+5.2*e,2,1),n(_.ARROW,0,0,.05,Math.PI/4+e*Math.PI*.5,0,2,1)}],de=260,fe=3686400,pe=.7,me=144e4,C=async({container:c})=>{let l=navigator.gpu;if(!l)return r(c,i());let g=await l.requestAdapter().catch(()=>null);if(!g)return r(c,`No WebGPU adapter: enable hardware acceleration.`);let _=await g.requestDevice(),v=document.createElement(`canvas`);v.className=`w-full h-full block`,c.appendChild(v);let y=v.getContext(`webgpu`),ae=l.getPreferredCanvasFormat();y.configure({device:_,format:ae,alphaMode:`opaque`});let oe=!1,b=null;_.lost.then(e=>{oe||(v.remove(),b=r(c,`WebGPU device lost (${e.reason||`unknown`}).`),b.resize?.(c.clientWidth,c.clientHeight,Math.min(2,window.devicePixelRatio||1)))}),_.pushErrorScope(`validation`);let[se,ce,x,le]=await Promise.all([o(_,u,`daybreak-field`),o(_,d,`daybreak-feedback`),o(_,f,`daybreak-bloom`),o(_,p,`daybreak-final`)]),C=`r16float`,w=(e,t,n)=>_.createRenderPipelineAsync({layout:`auto`,vertex:{module:e,entryPoint:`vs`},fragment:{module:e,entryPoint:t,targets:[{format:n}]},primitive:{topology:`triangle-list`}}),[he,ge,_e,ve,ye,be,xe]=await Promise.all([w(se,`fs`,C),w(ce,`fs`,C),w(x,`fsDown1`,C),w(x,`fsDown`,C),w(x,`fsBlurH`,C),w(x,`fsBlurV`,C),w(le,`fs`,ae)]),Se=await _.popErrorScope();if(Se)throw Error(`Daybreak: ${Se.message}`);let T=_.createSampler({magFilter:`linear`,minFilter:`linear`,addressModeU:`clamp-to-edge`,addressModeV:`clamp-to-edge`}),E=new Float32Array(de),Ce=_.createBuffer({size:de*4,usage:s.UNIFORM|s.COPY_DST}),D=2,O=2,k=2,A=2,we=1,Te=[],Ee,j,M,De,N,Oe,P;function ke(e,t,n){let r=Math.max(1,e),i=Math.max(1,t),o=n;r*i*o*o>fe&&(o=Math.sqrt(fe/(r*i))),D=Math.max(2,Math.round(r*o)),O=Math.max(2,Math.round(i*o)),we=D/O,v.width=D,v.height=O;let s=pe;D*O*s*s>me&&(s=Math.sqrt(me/(D*O))),k=Math.max(2,Math.round(D*s)),A=Math.max(2,Math.round(O*s));for(let e of Te)e.destroy();Te=[];let c=(e,t)=>{let n=_.createTexture({size:[Math.max(1,e),Math.max(1,t)],format:C,usage:a.RENDER_ATTACHMENT|a.TEXTURE_BINDING});return Te.push(n),n};Ee=c(k,A),j=[c(k,A),c(k,A)],M=c(Math.ceil(k/4),Math.ceil(A/4)),De=c(Math.ceil(k/4),Math.ceil(A/4)),N=c(Math.ceil(k/16),Math.ceil(A/16)),Oe=c(Math.ceil(k/16),Math.ceil(A/16));let l=(e,t)=>_.createBindGroup({layout:e.getBindGroupLayout(0),entries:t.map((e,t)=>({binding:t,resource:e}))}),u=e=>e.createView(),d={buffer:Ce};P={field:l(he,[d]),feedback:[0,1].map(e=>l(ge,[d,T,u(Ee),u(j[1-e])])),down1:[0,1].map(e=>l(_e,[T,u(j[e])])),blurH1:l(ye,[T,u(M)]),blurV1:l(be,[T,u(De)]),down2:l(ve,[T,u(M)]),blurH2:l(ye,[T,u(N)]),blurV2:l(be,[T,u(Oe)]),final:[0,1].map(e=>l(xe,[d,T,u(j[e]),u(M),u(N)]))}}let Ae=0,F=0,je=0,Me=0,I=0,Ne=0,Pe=0,Fe=0,L=0,R=0,z=0,Ie=0,B=0,V=0,Le=1,Re=0,ze=0,H=-1,U=0,Be=0,W=0,Ve=0,He=!0,Ue=0,We=0,G=0,Ge=Math.random(),Ke=0,K=null,qe=-1,Je=-1e9,Ye=0,q=new Float32Array(32),J=new Float32Array(32),Y=new Float32Array(32).fill(.3),Xe=new URLSearchParams(window.location.search),Ze=m.find(e=>e.name===Xe.get(`palette`))??null,X=S.findIndex(e=>e.name===Xe.get(`scene`)),Qe=Ze??m[0],Z=Qe,Q=1,$e=!0,et=()=>Q>=1?Z:te(Qe,Z,Q);function tt(e,t){Qe=t?et():e,Z=e,Q=+!t}function nt(e){G=e,We=0,Ue=0,F=0,Ge=Math.random(),S[e].enter(ie(Math.floor(Ge*2**32))),!Ze&&!$e&&tt(h(Z.name),!0),$e=!1}function rt(e,t=!1){let n=S.map((e,t)=>t).filter(n=>n!==G&&(t?!S[n].calm||S[n].name===`stars`:!e||S[n].calm));return n[Math.floor(Math.random()*n.length)]}function it(e,t){let n=Math.floor(Math.random()*ue.length);n===qe&&(n=(n+1)%ue.length),qe=n,Je=e,K={type:n,t:0,dur:Math.min(.75,Math.max(.3,t||.5))}}function at(e,t,n=!1){let r=e.silent||e.beat.confidence<.3||V<.18;(n||!r&&t-Je>8&&Math.random()<.45)&&it(t,e.beat.period),nt(rt(r,n))}nt(X>=0?X:0);function ot(t,r,i,a,o){let s=e=>Math.exp(-i/e),c=n(t);if(c){let n=e(t);I=Math.max(I,Math.min(1,n*r)),Ne=Math.max(Ne,Math.min(1,n*r)),n>=.5&&(We++,t.beat.isBeat&&t.beat.barBeat===0&&(Ue++,Pe=Math.max(Pe,.55*n),Ue%4==0&&!Ze&&tt(h(Z.name),!0)),X<0&&!K&&We>=S[G].beats&&at(t,a))}I*=s(.17),Ne*=s(.12),Pe*=s(.16);let l=(e,t,n)=>e+(Math.min(1.5,t*r)-e)*(1-s(n));if(Fe=l(Fe,t.onsets.kick.envelope,.05),L=l(L,t.onsets.snare.envelope,.05),R=l(R,t.onsets.hat.envelope,.04),z=l(z,t.bands.bass,.12),Ie=l(Ie,t.bands.mid,.15),B=l(B,t.bands.treble,.1),V+=((t.silent?0:Math.min(1,t.level.rms*r*2))-V)*(1-s(.4)),t.onsets.snare.hit){let e=Math.min(1,t.onsets.snare.strength*r);Me+=.9*e*o,Le=-Le,Re=Le*.04*e}Me*=s(.3),je+=i*Me,Re*=s(.35),ze+=(Re-ze)*(1-s(.06));let u=t.silent?0:t.level.rms;H<0?u>0&&(H=U=u):(H+=(u-H)*(1-s(.3)),U+=(u-U)*(1-s(6)),Be+=i);let d=U>.01?Math.min(1,Math.max(0,(H/U-1.1)*3))*Math.min(1,Math.max(0,(Be-3)/3)):0;W+=(d-W)*(1-s(d>W?.15:.8));let f=+(!t.silent&&t.beat.confidence>=.3&&t.beat.strength<.35&&H>U*1.05);return Ve+=(f-Ve)*(1-s(1)),W>.6&&He&&X<0&&!K&&a-Je>6&&(He=!1,at(t,a,!0)),W<.25&&(He=!0),Q=Math.min(1,Q+i/.8),c}function st(e,n,r){let i=e.spectrum({fftSize:1024,smoothing:.75}),a=1-Math.exp(-r/.12),o=1-Math.exp(-r/1.5),s=1-Math.exp(-r/2.5);for(let e=0;e<32;e++){let r=Math.floor(2*200**(e/32)),c=Math.max(r+1,Math.floor(2*200**((e+1)/32))),l=t(i,r,c)/255*(.9+e/60);J[e]=l<J[e]?l:J[e]+(l-J[e])*o,Y[e]=l>Y[e]?l:Y[e]+(l-Y[e])*s;let u=Math.max(.12,Y[e]-J[e]),d=Math.min(1,Math.max(0,.08+(l-J[e])/u*.92)*Math.min(1,l*3)*n);q[e]=d>q[e]?d:q[e]+(d-q[e])*a}}let $=0,ct=(e,t,n,r,i=0,a=0,o=1,s=1)=>{$>=re||s<=.002||(E.set([e,t,n,r,i,a,o,s],164+$*8),$++)};function lt(e,t,n,r,i){let a=E;a.set([D,O,we,2/O],0),a.set([k,A,2/A,0],4),a.set([n,Ae,Fe,L],8),a.set([R,z,Ie,B],12);let o=(e.zoom??1)*(1+.06*Ne+.04*W),s=.03*Math.sin(n*.31)+.012*W*Math.sin(n*31),c=.02*Math.sin(n*.27+1)+.012*W*Math.cos(n*27);a.set([s,c,o,ze+.015*Math.sin(n*.21)],16);let l=e.defocus+.07*Math.exp(-F/.22)+.035*Ve;a.set([G,Ge,l,e.flare*(1+.6*Pe)],20);let u=1.1*(1+.26*I)*(1+1.3*Pe)*(1-.18*Ve)*(1+.15*W),d=.0012+.004*L+.002*I+.004*W+.003*B,f=(.32+.25*W)**(i*60),p=(.82*W)**(i*60);a.set([u,d,f,p],24),a.set([1-.012*W,Ye,.075+.03*W,7e-4*Math.sin(n*23)*(1+2*W)],28),a.set([+!!K,K?.03:.004,e.stars,Math.min(1,R)],32),a.set([.9+.4*Math.min(1,z),e.fog,V,W],36),t.stops.forEach((e,t)=>a.set([...ne(e,r),ee[t]],40+t*4)),a.set([...ne(t.stops[5],r),$],64),a.set(q,132),_.queue.writeBuffer(Ce,0,a)}return{resize(e,t,n){b?b.resize?.(e,t,n):ke(e,t,n)},frame({audio:e,settings:t,dt:n,time:r}){if(oe||b)return;let i=t.sensitivity,a=ot(e,i,n,r,t.speed);Ae+=n*t.speed*(.45+.9*V),F+=n,X<0&&!K&&F>24/Math.max(.3,t.speed)&&at(e,r),K&&(K.t+=n,(a&&K.t>.22||K.t>K.dur)&&(K=null)),Ye+=(+!!K-Ye)*(1-Math.exp(-n/(K?.015:.04)));let o=E.subarray(68,132);o.fill(0),E.fill(0,164),$=0;let s=S[G].frame({t:r,dt:n,local:Ae,sceneTime:F,spin:je,pulse:I,kick:Fe,snare:L,hat:R,bass:z,mid:Ie,treble:B,energy:V,drop:W,barBeat:e.beat.barBeat,kickHit:e.onsets.kick.hit,ax:we,scale:t.scale},o,ct);K&&($=0,E.fill(0,164),ue[K.type](Math.min(1,K.t/K.dur),we,ct)),s.spectrum&&st(e,i,n),lt(s,et(),r,t.hueShift,n);let c=_.createCommandEncoder(),l=(e,t,n)=>{let r=c.beginRenderPass({colorAttachments:[{view:e,loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,1]}]});r.setPipeline(t),r.setBindGroup(0,n),r.draw(3),r.end()},u=1-Ke;l(Ee.createView(),he,P.field),l(j[u].createView(),ge,P.feedback[u]),l(M.createView(),_e,P.down1[u]),l(De.createView(),ye,P.blurH1),l(M.createView(),be,P.blurV1),l(N.createView(),ve,P.down2),l(Oe.createView(),ye,P.blurH2),l(N.createView(),be,P.blurV2),l(y.getCurrentTexture().createView(),xe,P.final[u]),_.queue.submit([c.finish()]),Ke=u},dispose(){oe=!0,b?.dispose();for(let e of Te)e.destroy();Ce.destroy(),y.unconfigure(),_.destroy(),v.remove()}}};export{C as default};
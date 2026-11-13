import{i as e,n as t,r as n}from"./audio-Ds-N7sX7.js";import{a as r,i,n as a,r as o,t as s}from"./webgpu-C8PYNhZC.js";var c=`
struct Plane { c: vec4f, u: vec4f, v: vec4f, rect: vec4f };
struct Blob { p: vec4f, c: vec4f, s: vec4f };
struct Ring { p: vec4f, c: vec4f, s: vec4f };
struct U {
  res: vec4f,   // w, h, 1/w, 1/h (render px)
  time: vec4f,  // time, pulse, kick, snare
  cam: vec4f,   // focal, focus distance, dof, exposure
  bg: vec4f,    // rgb, -
  tint: vec4f,  // rgb, led mask amount
  fx: vec4f,    // trail decay, warp zoom, chromatic aberration, glitch
  fx2: vec4f,   // warp x, warp y, led cell (px), flash
  planes: array<Plane, 2>,
  blobs: array<Blob, 8>,
  ring: Ring,
  duoLo: vec4f, // palette grade: shadow rgb, grade amount
  duoHi: vec4f, // palette grade: highlight rgb, desaturation (build-ups)
  fx3: vec4f,   // drop, mirror fold, invert flash, hat shimmer
  fx4: vec4f,   // colour wash rgb (premultiplied), tracking tear
  fx5: vec4f,   // bloom gain, halo scale, -, -
  eq: vec4f,    // equalizer: amount, baseline y, max height, half width
  eqCol: vec4f, // equalizer colour, peak-cap brightness
  spec: array<vec4f, 8>,  // 32 bar heights 0..1
  peaks: array<vec4f, 8>, // 32 peak caps 0..1
};
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
`,l=c+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var atlas: texture_2d<f32>;

struct Hit { uv: vec2f, t: f32 };

fn hitPlane(pl: Plane, d: vec3f) -> Hit {
  let n = cross(pl.u.xyz, pl.v.xyz);
  let dn = dot(d, n);
  let t = dot(pl.c.xyz, n) / select(dn, 1e-4, abs(dn) < 1e-4);
  let p = d * t - pl.c.xyz;
  let l = vec2f(dot(p, pl.u.xyz) / pl.u.w, dot(p, pl.v.xyz) / pl.v.w);
  var h: Hit;
  h.t = t;
  h.uv = pl.rect.xy + (vec2f(l.x, -l.y) * 0.5 + 0.5) * pl.rect.zw;
  return h;
}

// Text on a plane with depth of field: a mip level for the blur size plus a small disc of taps.
fn shadePlane(pl: Plane, h: Hit, footprint: f32) -> f32 {
  if (pl.c.w <= 0.0 || h.t < 0.05) { return 0.0; }
  let ts = vec2f(textureDimensions(atlas, 0));
  let coc = u.cam.z * abs(h.t - u.cam.y) / max(h.t, 0.1);
  let blurUv = coc * (h.t / u.cam.x) / pl.u.w * 0.5 * pl.rect.z;
  let lod = clamp(log2(max(footprint * ts.x, blurUv * ts.x * 0.35) + 1e-4) - 0.5, 0.0, 6.5);
  let lo = pl.rect.xy + 0.5 / ts;
  let hi = pl.rect.xy + pl.rect.zw - 0.5 / ts;
  var a = 0.0;
  for (var k = 0; k < 8; k++) {
    let ang = f32(k) * 2.39996;
    let r = sqrt((f32(k) + 0.5) / 8.0);
    let o = vec2f(cos(ang), sin(ang) * ts.x / ts.y) * r * blurUv;
    a += textureSampleLevel(atlas, samp, clamp(h.uv + o, lo, hi), lod).r;
  }
  return a / 8.0 * pl.c.w;
}

fn sdRoundBox(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Blobs (rounded squares / circles with a hot core and a halo) and the outline shape.
fn shapes(sp: vec2f) -> vec3f {
  var col = vec3f(0.0);
  for (var k = 0; k < 8; k++) {
    let b = u.blobs[k];
    if (b.c.w <= 0.0) { continue; }
    let cs = cos(b.s.z);
    let sn = sin(b.s.z);
    var q = sp - b.p.xy;
    q = vec2f(cs * q.x + sn * q.y, -sn * q.x + cs * q.y) / b.p.zw;
    let rr = b.s.x;
    let dd = length(max(abs(q) - vec2f(1.0 - rr), vec2f(0.0))) - rr;
    let hard = b.s.y;
    let core = 1.0 - smoothstep(-mix(0.9, 0.04, hard), 0.03, dd);
    let halo = exp(-max(dd, 0.0) * mix(3.0, 8.0, hard) / u.fx5.y);
    let c = mix(b.c.rgb, vec3f(1.0), core * 0.65);
    col += c * (core * 2.4 + halo * 0.32) * b.c.w;
  }
  let rg = u.ring;
  if (rg.c.w > 0.0) {
    let rd = sdRoundBox(sp - rg.p.xy, rg.p.zw, rg.s.x);
    let line = exp(-pow(abs(rd) / rg.s.y, 2.0));
    let glow = exp(-abs(rd) / (rg.s.y * 9.0));
    col += rg.c.rgb * (line * 1.6 + glow * 0.22) * rg.c.w;
  }
  return col;
}

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let res = u.res.xy;
  let sp = (i.pos.xy - 0.5 * res) / res.y * vec2f(2.0, -2.0);
  let d = normalize(vec3f(sp, -u.cam.x));

  let h0 = hitPlane(u.planes[0], d);
  let h1 = hitPlane(u.planes[1], d);
  let f0 = length(fwidth(h0.uv));
  let f1 = length(fwidth(h1.uv));

  // Background: the scene colour, a soft falloff to the corners.
  var col = u.bg.rgb * (1.15 - 0.45 * length(sp * vec2f(0.6, 0.9)));

  // Far plane first (dimmer, usually out of focus), then the main one.
  col += vec3f(1.0) * shadePlane(u.planes[1], h1, f1) * 1.6;
  col += vec3f(1.0) * shadePlane(u.planes[0], h0, f0) * 1.7;

  // Shapes; in drops they fold onto their mirror image (the type is left alone, so it reads).
  var sh = shapes(sp);
  if (u.fx3.y > 0.0) { sh = max(sh, shapes(vec2f(-sp.x, sp.y)) * u.fx3.y); }
  col += sh;

  // LED equalizer: 32 segmented bars with a dim reflection and slowly falling peak caps.
  if (u.eq.x > 0.0) {
    let hw = u.eq.w;
    let fx = (sp.x + hw) / (2.0 * hw) * 32.0;
    if (fx >= 0.0 && fx < 32.0) {
      let bi = u32(fx);
      let fr = fract(fx);
      let hgt = u.spec[bi / 4u][bi % 4u] * u.eq.z;
      let pk = u.peaks[bi / 4u][bi % 4u] * u.eq.z;
      let y = sp.y - u.eq.y;
      let segH = u.eq.z / 24.0;
      let seg = fract(y / segH);
      let colMask = smoothstep(0.08, 0.16, fr) * (1.0 - smoothstep(0.84, 0.92, fr));
      let segMask = smoothstep(0.1, 0.22, seg) * (1.0 - smoothstep(0.78, 0.9, seg));
      let lit = select(0.0, 1.0, y >= 0.0 && y <= hgt);
      let refl = select(0.0, 0.2 * exp(y / (segH * 3.0)), y < 0.0 && -y <= hgt * 0.5);
      let cap = select(0.0, 1.0, pk > segH && abs(y - pk - segH * 0.5) < segH * 0.35);
      let top = clamp(y / max(u.eq.z, 1e-3), 0.0, 1.0);
      let c = mix(u.eqCol.rgb, vec3f(1.0), top * 0.7);
      col += c * colMask * (segMask * (lit + refl) * 1.6 + cap * u.eqCol.w) * u.eq.x;
    }
  }

  return vec4f(col, 1.0);
}
`,u=c+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var cur: texture_2d<f32>;
@group(0) @binding(3) var prev: texture_2d<f32>;

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let s = textureSampleLevel(cur, samp, i.uv, 0.0).rgb;
  let w = (i.uv - 0.5) * u.fx.y + 0.5 + u.fx2.xy;
  let p = min(textureSampleLevel(prev, samp, w, 0.0).rgb, vec3f(0.9)) * u.fx.x;
  return vec4f(max(s, p), 1.0);
}
`,d=c+`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var hud: texture_2d<f32>;

fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }

fn box4(uv: vec2f) -> vec3f {
  let px = 1.0 / vec2f(textureDimensions(src, 0));
  return (tap(uv + px * vec2f(-1.0, -1.0)) + tap(uv + px * vec2f(1.0, -1.0))
        + tap(uv + px * vec2f(-1.0, 1.0)) + tap(uv + px * vec2f(1.0, 1.0))) * 0.25;
}

// First level: frame + HUD lines, with a soft knee so only the bright parts bloom.
@fragment fn fsDown1(i: VSOut) -> @location(0) vec4f {
  let c = box4(i.uv) + vec3f(textureSampleLevel(hud, samp, i.uv, 0.0).r * 0.45);
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(c * smoothstep(0.25, 1.6, l), 1.0);
}

@fragment fn fsDown(i: VSOut) -> @location(0) vec4f { return vec4f(box4(i.uv), 1.0); }

fn blur(uv: vec2f, dir: vec2f) -> vec4f {
  let px = dir / vec2f(textureDimensions(src, 0)) * 1.25;
  var c = tap(uv) * 0.2270;
  c += (tap(uv + px * 1.3846) + tap(uv - px * 1.3846)) * 0.3162;
  c += (tap(uv + px * 3.2308) + tap(uv - px * 3.2308)) * 0.0703;
  return vec4f(c, 1.0);
}
@fragment fn fsBlurH(i: VSOut) -> @location(0) vec4f { return blur(i.uv, vec2f(1.0, 0.0)); }
@fragment fn fsBlurV(i: VSOut) -> @location(0) vec4f { return blur(i.uv, vec2f(0.0, 1.0)); }
`,f=c+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var frameT: texture_2d<f32>;
@group(0) @binding(3) var hudT: texture_2d<f32>;
@group(0) @binding(4) var bloom1: texture_2d<f32>;
@group(0) @binding(5) var bloom2: texture_2d<f32>;

fn hdr(uv: vec2f) -> vec3f {
  return textureSampleLevel(frameT, samp, uv, 0.0).rgb
       + (textureSampleLevel(bloom1, samp, uv, 0.0).rgb * 0.4
       + textureSampleLevel(bloom2, samp, uv, 0.0).rgb * 0.75) * u.fx5.x;
}

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let t = u.time.x;
  var uv = i.uv;

  // Glitch: on a hard snare, slices jump sideways and smear into blocks for a few frames.
  let g = u.fx.w;
  let r = hash21(vec2f(floor(uv.y * 30.0), floor(t * 24.0)));
  if (r > 1.0 - 0.4 * g) {
    uv.x += (r - 0.5) * 0.1 * g;
    uv.y = mix(uv.y, (floor(uv.y * 18.0) + 0.5) / 18.0, g * 0.8);
  }

  // Tracking tear: a band rolling up the screen during build-ups.
  let band = fract(uv.y + t * 0.23);
  let inBand = smoothstep(0.0, 0.015, band) * (1.0 - smoothstep(0.04, 0.07, band)) * u.fx4.w;
  uv.x += inBand * (hash21(vec2f(floor(uv.y * 240.0), floor(t * 30.0))) - 0.5) * 0.05;

  let dir = uv - 0.5;
  let ca = u.fx.z * (0.35 + dot(dir, dir) * 3.0);
  var col = vec3f(hdr(uv + dir * ca).r, hdr(uv).g, hdr(uv - dir * ca).b);

  // Grade before the tone curve so highlights still burn out to white.
  col = 1.0 - exp(-col * u.tint.rgb * u.cam.w);

  // Palette grade (a duotone cast, like a filmed LED wall) and desaturation in build-ups.
  let luma = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  col = mix(col, mix(u.duoLo.rgb, u.duoHi.rgb, smoothstep(0.0, 1.0, luma)), u.duoLo.w);
  col = mix(col, vec3f(luma), u.duoHi.w);
  col += vec3f(inBand * 0.12);

  // Downbeats: a short inverted frame or a wash of the palette colour.
  col = mix(col, vec3f(1.0) - col, u.fx3.z);
  col += u.fx4.rgb;

  // HUD: green = hatch that inverts what is under it, red = lines and labels (palette-tinted white).
  let hud = textureSampleLevel(hudT, samp, uv, 0.0);
  col = mix(col, vec3f(1.0) - col, clamp(hud.g, 0.0, 1.0) * 0.8);
  col += hud.r * 0.95 * mix(vec3f(1.0), u.duoHi.rgb, 0.3);
  col += vec3f(u.fx2.w * 0.3);

  // LED wall: RGB sub-pixel columns and dark gaps between cells.
  let cell = u.fx2.z;
  let local = i.pos.xy - floor(i.pos.xy / cell) * cell;
  let ph = local.x / cell;
  let sub = vec3f(
    0.5 + 0.5 * cos(6.2831853 * (ph - 0.1667)),
    0.5 + 0.5 * cos(6.2831853 * (ph - 0.5)),
    0.5 + 0.5 * cos(6.2831853 * (ph - 0.8333)));
  let e = min(local, vec2f(cell) - local) / cell;
  let gap = smoothstep(0.0, 0.2, min(e.x, e.y));
  let mask = mix(vec3f(0.42), vec3f(1.0), sub) * mix(0.3, 1.0, gap) * 1.55;
  // hi-hats make single LED cells flicker
  let shimmer = 1.0 + u.fx3.w * (hash21(floor(i.pos.xy / cell) + vec2f(floor(t * 30.0) * 13.0, 0.0)) - 0.5);
  col = mix(col, col * mask * shimmer, u.tint.w);

  // Camera: vignette, a slow rolling refresh band, grain.
  let vig = smoothstep(1.25, 0.25, length(dir * vec2f(1.6, 1.9)));
  col *= mix(0.45, 1.0, vig);
  col *= 1.0 - 0.06 * (0.5 + 0.5 * sin(uv.y * 5.0 - t * 1.3));
  col += vec3f((hash21(i.pos.xy + vec2f(fract(t * 7.13) * 911.0, 0.0)) - 0.5) * 0.04);
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`,p=c+`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@fragment fn fs(i: VSOut) -> @location(0) vec4f { return textureSampleLevel(src, samp, i.uv, 0.0); }
`,m=`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outBuf: array<u32>;
@group(0) @binding(2) var<uniform> grid: vec4u; // cols, rows, cell px, -

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= grid.x || id.y >= grid.y) { return; }
  let dims = textureDimensions(src, 0);
  let c = grid.z;
  var s = 0.0;
  for (var j = 0u; j < 4u; j++) {
    for (var i = 0u; i < 4u; i++) {
      let p = vec2u(id.x * c + (i * c) / 4u + c / 8u, id.y * c + (j * c) / 4u + c / 8u);
      s += dot(textureLoad(src, min(p, dims - 1u), 0).rgb, vec3f(0.2126, 0.7152, 0.0722));
    }
  }
  outBuf[id.y * grid.x + id.x] = u32(clamp(s / 16.0, 0.0, 60.0) * 1000.0);
}
`,h=[{name:`ultramarine`,bg:[.02,.08,.6],tint:[.95,.97,1.05],accent:[.7,.85,1],alt:[.45,.62,1],hot:[.92,.96,1],lo:[0,.03,.28],hi:[.92,.96,1],grade:.3},{name:`cobalt`,bg:[.004,.016,.07],tint:[.75,.95,1.1],accent:[.2,.85,1],alt:[.35,.5,1],hot:[.85,1,1],lo:[0,.02,.09],hi:[.78,1,1],grade:.45},{name:`violet`,bg:[.03,.008,.1],tint:[.95,.82,1.1],accent:[.72,.45,1],alt:[1,.35,.78],hot:[1,.9,1],lo:[.05,0,.13],hi:[1,.88,1],grade:.4},{name:`acid`,bg:[.006,.012,.004],tint:[.85,1.05,.7],accent:[.75,1,.2],alt:[.3,1,.6],hot:[.95,1,.85],lo:[0,.02,0],hi:[.92,1,.7],grade:.4},{name:`infrared`,bg:[.022,.006,.004],tint:[1.1,.8,.66],accent:[1,.42,.1],alt:[1,.16,.22],hot:[1,.95,.82],lo:[.07,0,0],hi:[1,.9,.76],grade:.4},{name:`mint`,bg:[.008,.022,.018],tint:[.72,1,.85],accent:[.45,1,.65],alt:[1,.55,.2],hot:[.9,1,.92],lo:[0,.03,.02],hi:[.85,1,.9],grade:.3},{name:`mono`,bg:[.02,.02,.024],tint:[1,1,1],accent:[.9,.92,1],alt:[1,.96,.82],hot:[1,1,1],lo:[0,0,0],hi:[1,1,1],grade:0}],g=[2,2,1.5,1,1,1,.75];function _(e,t=!1){let n=t?2:h.length,r=0;for(let t=0;t<n;t++)h[t].name!==e&&(r+=g[t]);let i=Math.random()*r;for(let t=0;t<n;t++)if(h[t].name!==e&&(i-=g[t],i<=0))return h[t];return h[0]}function v(e,t,n){let r=(e,t)=>[e[0]+(t[0]-e[0])*n,e[1]+(t[1]-e[1])*n,e[2]+(t[2]-e[2])*n];return{name:t.name,bg:r(e.bg,t.bg),tint:r(e.tint,t.tint),accent:r(e.accent,t.accent),alt:r(e.alt,t.alt),hot:r(e.hot,t.hot),lo:r(e.lo,t.lo),hi:r(e.hi,t.hi),grade:e.grade+(t.grade-e.grade)*n}}var y=0,b=1,x=2;function S(e,t,n){let r=(r,i,a)=>{let o=Math.cos(n),s=Math.sin(n),c=r*o-i*s,l=r*s+i*o,u=a,d=Math.cos(t),f=Math.sin(t),p=l*d-u*f,m=l*f+u*d;l=p,u=m;let h=Math.cos(e),g=Math.sin(e),_=c*h+u*g,v=-c*g+u*h;return c=_,u=v,[c,l,u]};return{u:r(1,0,0),v:r(0,1,0)}}var C=[{name:`drift`,beats:16,build:e=>{let t=Math.sin(e.phase*.21+e.seed*6),n=.5-e.local*.16,r=S(.5+.07*t,-.1,.34),i=e.pulse*.1,a=t=>.035*Math.sin(e.phase*.6+t*2.1);return{planes:[{row:y,pos:[.3*e.ax+r.u[0]*n,.02+r.u[1]*n,-3.4+r.u[2]*n+i],yaw:.5+.07*t,pitch:-.1,roll:.34,h:.5*e.scale,intensity:1.15+.4*e.mid},{row:b,pos:[2.3*e.ax,1.35,-8.5],yaw:.55,pitch:0,roll:.35,h:.8*e.scale,intensity:.35}],blobs:[{x:-.4*e.ax+a(0),y:-.42+a(1),sx:.17*e.scale*(1+.3*e.kick),sy:.15*e.scale*(1+.3*e.kick),color:e.pal.accent,intensity:.8+.9*e.kick,round:.45,hard:.25},{x:-1.28*e.ax+a(2),y:.74+a(3),sx:.13*e.scale,sy:.12*e.scale,color:e.pal.hot,intensity:.8+.6*e.bass,round:.4,hard:.35},{x:-1.02*e.ax+a(4),y:.62+a(5),sx:.09*e.scale,sy:.085*e.scale,color:e.pal.alt,intensity:.7+.8*e.hat,round:.35,hard:.4}],ring:null,focus:3,dof:.16,trail:.72,drift:[3e-4,-2e-4],zoom:.999}}},{name:`count`,beats:8,build:e=>({planes:[{row:x,pos:[.05*Math.sin(e.phase*.17),-.05,-2.45+e.pulse*.12],yaw:.2*Math.sin(e.local*.31+e.seed*4),pitch:.06,roll:-.03,h:.95*e.scale,intensity:1.1+.3*e.mid},null],blobs:[{x:0,y:0,sx:1.1,sy:.65,color:e.pal.accent,intensity:.1+.15*e.bass,round:1,hard:0}],ring:null,focus:3,dof:.2,trail:.7,drift:[0,0],zoom:.998})},{name:`ritual`,beats:16,build:e=>{let t=-.62*e.ax,n=.04,r=[[-.14,.11],[-.03,.15],[-.15,-.04],[-.04,0],[.1,.1],[.03,-.14]],i=[e.bass,e.kick,e.mid,e.snare,e.hat,e.treble],a=e.scale*(1+.25*e.pulse);return{planes:[{row:y,pos:[.72*e.ax,-.05,-3.1+e.pulse*.1],yaw:.42+.05*Math.sin(e.phase*.2),pitch:-.06,roll:.22,h:.5*e.scale,intensity:1.1+.3*e.mid},null],blobs:[{x:t,y:n,sx:.32*e.scale,sy:.3*e.scale,color:e.pal.alt,intensity:.12+.2*e.bass,round:1,hard:0},...r.map(([r,o],s)=>({x:t+r*a+.008*Math.sin(e.phase*1.3+s),y:n+o*a,sx:.048*a,sy:.048*a,color:e.pal.hot,intensity:.55+.9*i[s],round:1,hard:.8}))],ring:null,focus:3,dof:.4,trail:.74,drift:[2e-4,0],zoom:.999}}},{name:`ticker`,beats:8,build:e=>{let t=.3*e.scale*e.aspect(y),n=2*t+3.2*e.ax;return{planes:[{row:y,pos:[t+1.6*e.ax-e.local*.55%n,.02,-2.4+e.pulse*.08],yaw:0,pitch:0,roll:0,h:.3*e.scale,intensity:1.3+.3*e.mid},null],blobs:[],ring:null,focus:3,dof:.05,trail:.8,drift:[0,0],zoom:1}}},{name:`blue`,beats:8,build:e=>{let t=1+.35*e.kick;return{planes:[{row:b,pos:[.85*e.ax,-.08,-3+e.pulse*.1],yaw:-.38,pitch:.05,roll:.06,h:.32*e.scale,intensity:1.15},null],blobs:[{x:-.2*e.ax,y:.05,sx:.2*e.scale*t,sy:.11*e.scale*t,color:e.pal.hot,intensity:.9+.5*e.bass,round:.95,hard:.6,rot:-.12}],ring:{x:-.2*e.ax,y:.05,hx:.36*e.scale*t,hy:.21*e.scale*t,radius:.21*e.scale*t,thickness:.005,color:e.pal.accent,intensity:.7},focus:3,dof:.2,trail:.7,drift:[0,0],zoom:.999}}},{name:`capsule`,beats:16,build:e=>({planes:[{row:y,pos:[.4*e.ax,-.06,-2.8+e.pulse*.1],yaw:.38+.06*Math.sin(e.phase*.25),pitch:.04,roll:-.08,h:.4*e.scale,intensity:1.2+.3*e.mid},null],blobs:[{x:-.72*e.ax,y:0,sx:.15*e.scale*(1+.3*e.kick),sy:.11*e.scale*(1+.3*e.kick),color:e.pal.hot,intensity:.8+.8*e.kick,round:.5,hard:.5}],ring:{x:-.18*e.ax,y:0,hx:.85*e.ax*e.scale,hy:.25*e.scale,radius:.25*e.scale,thickness:.007,color:e.pal.accent,intensity:1.1+.6*e.pulse},focus:3,dof:.3,trail:.72,drift:[2e-4,0],zoom:.999})},{name:`equalizer`,beats:16,build:e=>({planes:[{row:y,pos:[0,.66,-3.3+e.pulse*.1],yaw:.14*Math.sin(e.phase*.2),pitch:-.05,roll:0,h:.24*e.scale,intensity:1.1+.3*e.mid},null],blobs:[{x:0,y:-.25,sx:1.5*e.ax,sy:.45,color:e.pal.accent,intensity:.05+.12*e.bass,round:1,hard:0}],ring:null,focus:3,dof:.1,trail:.7,drift:[0,2e-4],zoom:1,eq:{amount:1,y:-.66,h:.95*e.scale,hw:1.5*e.ax}})},{name:`orbit`,beats:16,build:e=>{let t=.95*e.ax*e.scale,n=.42*e.scale,r=[];for(let i=0;i<8;i++){let a=e.phase*.5+i/8*Math.PI*2,o=Math.min(1.2,e.bands[i]),s=.75+.25*Math.sin(a),c=(.035+.08*o)*e.scale*s;r.push({x:Math.cos(a)*t,y:Math.sin(a)*n+.02,sx:c,sy:c,color:i%2?e.pal.alt:e.pal.accent,intensity:(.45+1.1*o)*s,round:i%3==0?.35:1,hard:.55})}let i=1+.12*e.kick;return{planes:[{row:y,pos:[0,0,-3+e.pulse*.12],yaw:.35*Math.sin(e.phase*.33),pitch:.08*Math.sin(e.phase*.21),roll:0,h:.36*e.scale,intensity:1.15+.3*e.mid},null],blobs:r,ring:{x:0,y:.02,hx:t*1.1*i,hy:n*i,radius:n*i,thickness:.004,color:e.pal.accent,intensity:.5+.9*e.kick},focus:3,dof:.12,trail:.78,drift:[0,0],zoom:.998}}}],ee=[`elements`,`signal`,`my ritual`,`transmit`,`resonance`,`frequency`,`voltage`,`pulse`,`inner space`,`sequence`],te=[`communication`,`transmission`,`synchronize`,`interference`];function ne(e){let t=[e?.title,e?.artist].filter(Boolean).join(` `).split(/[\s\-–—_/|,.:;()[\]]+/).map(e=>e.replace(/[^\p{L}\p{N}'&]/gu,``)).filter(e=>e.length>=2&&e.length<=14);return t.length?t.map(e=>e.toLowerCase()):ee}function re(e,t){if(!t)return e;let n=t*Math.PI/180,r=Math.cos(n),i=Math.sin(n),a=.299*e[0]+.587*e[1]+.114*e[2],o=.596*e[0]-.274*e[1]-.322*e[2],s=.211*e[0]-.523*e[1]+.312*e[2],c=o*r-s*i,l=o*i+s*r;return[Math.max(0,a+.956*c+.621*l),Math.max(0,a-.272*c-.647*l),Math.max(0,a-1.106*c+1.703*l)]}var ie=200,ae=120,oe=1300;function se(e,t,n,r,i,a,o,s){let c=t*n,l=i;for(let t=0;t<4;t++){let t=0;for(let n=0;n<c;n++)e[n]>l&&t++;if(t<c*.22)break;l*=1.6}o.fill(0,0,c);let u=[],d=0;for(let i=0;i<c;i++){if(o[i]||e[i]<=l)continue;d++;let a=0,f=0;s[f++]=i,o[i]=d;let p=t,m=n,h=0,g=0;for(;a<f;){let r=s[a++],i=r%t,c=(r-i)/t;i<p&&(p=i),i>h&&(h=i),c<m&&(m=c),c>g&&(g=c),i>0&&!o[r-1]&&e[r-1]>l&&(o[r-1]=d,s[f++]=r-1),i<t-1&&!o[r+1]&&e[r+1]>l&&(o[r+1]=d,s[f++]=r+1),c>0&&!o[r-t]&&e[r-t]>l&&(o[r-t]=d,s[f++]=r-t),c<n-1&&!o[r+t]&&e[r+t]>l&&(o[r+t]=d,s[f++]=r+t)}let _=f;if(_<2||_>c*.35)continue;let v=h-p+1,y=g-m+1,b=Math.min(8,Math.max(v>2.2*y&&v>=6?Math.round(v/(y*1.15)):1,Math.ceil(v/r))),x=Math.min(4,Math.ceil(y/r));for(let r=0;r<b*x;r++){let i=r%b,a=(r-i)/b;if(b*x>2&&(i+2*a)%3!=0)continue;let o=p+i*v/b,c=p+(i+1)*v/b,l=m+a*y/x,d=m+(a+1)*y/x,f=t,h=n,g=-1,S=-1,C=0,ee=0,te=0,ne=0;for(let n=0;n<_;n++){let r=s[n],i=r%t;if(i<o||i>=c)continue;let a=(r-i)/t;if(a<l||a>=d)continue;let u=e[r];C+=u,ee+=i*u,te+=a*u,ne++,i<f&&(f=i),i>g&&(g=i),a<h&&(h=a),a>S&&(S=a)}ne<2||u.push({x0:f,y0:h,x1:g+1,y1:S+1,cx:ee/C+.5,cy:te/C+.5,score:C})}}u.sort((e,t)=>t.score-e.score);let f=[];for(let e of u){let t=e.x1-e.x0,n=e.y1-e.y0;if(f.some(r=>Math.hypot(r.cx-e.cx,r.cy-e.cy)<1.1*Math.max(t,n,r.x1-r.x0,r.y1-r.y0))||f.push(e),f.length>=a)break}return f}var ce=260,le=3686400,w=2048,ue=1024,T=256,de=7,fe=async({container:c,metadata:g})=>{let fe=navigator.gpu;if(!fe)return r(c,i());let pe=await fe.requestAdapter().catch(()=>null);if(!pe)return r(c,`No WebGPU adapter: enable hardware acceleration.`);let E=await pe.requestDevice(),D=document.createElement(`canvas`);D.className=`w-full h-full block`,c.appendChild(D);let me=D.getContext(`webgpu`),he=fe.getPreferredCanvasFormat();me.configure({device:E,format:he,alphaMode:`opaque`});let ge=!1,O=null;E.lost.then(e=>{ge||(D.remove(),O=r(c,`WebGPU device lost (${e.reason||`unknown`}).`),O.resize?.(c.clientWidth,c.clientHeight,Math.min(2,window.devicePixelRatio||1)))}),E.pushErrorScope(`validation`);let k=(e,t)=>o(E,e,t),[_e,ve,ye,be,xe,Se]=await Promise.all([k(l,`blobtracker-scene`),k(u,`blobtracker-feedback`),k(d,`blobtracker-bloom`),k(f,`blobtracker-final`),k(m,`blobtracker-detect`),k(p,`blobtracker-mip`)]),A=`rgba16float`,j=(e,t,n)=>E.createRenderPipelineAsync({layout:`auto`,vertex:{module:e,entryPoint:`vs`},fragment:{module:e,entryPoint:t,targets:[{format:n}]},primitive:{topology:`triangle-list`}}),[Ce,we,Te,Ee,De,Oe,ke,Ae,je]=await Promise.all([j(_e,`fs`,A),j(ve,`fs`,A),j(ye,`fsDown1`,A),j(ye,`fsDown`,A),j(ye,`fsBlurH`,A),j(ye,`fsBlurV`,A),j(be,`fs`,he),j(Se,`fs`,`rgba8unorm`),E.createComputePipelineAsync({layout:`auto`,compute:{module:xe,entryPoint:`main`}})]),Me=await E.popErrorScope();if(Me)throw Error(`Blob Tracker: ${Me.message}`);let M=E.createSampler({magFilter:`linear`,minFilter:`linear`,mipmapFilter:`linear`,addressModeU:`clamp-to-edge`,addressModeV:`clamp-to-edge`}),Ne=new Float32Array(ce),Pe=E.createBuffer({size:ce*4,usage:s.UNIFORM|s.COPY_DST}),Fe=E.createBuffer({size:16,usage:s.UNIFORM|s.COPY_DST}),Ie=96e3,Le=E.createBuffer({size:Ie,usage:s.STORAGE|s.COPY_SRC}),Re=[0,1].map(()=>({buf:E.createBuffer({size:Ie,usage:s.MAP_READ|s.COPY_DST}),busy:!1})),ze=E.createTexture({size:[w,ue],format:`rgba8unorm`,mipLevelCount:de,usage:a.TEXTURE_BINDING|a.COPY_DST|a.RENDER_ATTACHMENT}),Be=Array.from({length:6},(e,t)=>({target:ze.createView({baseMipLevel:t+1,mipLevelCount:1}),group:E.createBindGroup({layout:Ae.getBindGroupLayout(0),entries:[{binding:0,resource:M},{binding:1,resource:ze.createView({baseMipLevel:t,mipLevelCount:1})}]})})),Ve=document.createElement(`canvas`);Ve.width=w,Ve.height=T;let He=Ve.getContext(`2d`,{willReadFrequently:!0}),Ue=[w/4,w/4,w/4,w/4],We=[``,``,``,``],Ge=!1,Ke=`"Segoe UI", "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;function N(e,t,n=!1){if(We[e]===t)return;We[e]=t;let r=He;r.fillStyle=`#000`,r.fillRect(0,0,w,T);let i=n?214:164;r.font=`${n?700:800} ${i}px ${Ke}`;let a=r.measureText(t).width;a>1960&&(i*=1960/a,r.font=`${n?700:800} ${i}px ${Ke}`,a=r.measureText(t).width),r.fillStyle=`#fff`,r.textBaseline=`alphabetic`,r.fillText(t,44,T/2+i*(n?.36:.3)),Ue[e]=Math.min(w,Math.ceil(a+88));let o=r.getImageData(0,0,w,T);E.queue.writeTexture({texture:ze,origin:{x:0,y:e*T}},o.data,{bytesPerRow:w*4},[w,T]),Ge=!0}function qe(e){for(let t of Be){let n=e.beginRenderPass({colorAttachments:[{view:t.target,loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,1]}]});n.setPipeline(Ae),n.setBindGroup(0,t.group),n.draw(3),n.end()}}let Je=e=>Ue[e]/T,P=document.createElement(`canvas`),Ye=P.getContext(`2d`),Xe=document.createElement(`canvas`);Xe.width=Xe.height=11;{let e=Xe.getContext(`2d`);e.strokeStyle=`#0f0`,e.lineWidth=2,e.beginPath(),e.moveTo(-1,12),e.lineTo(12,-1),e.moveTo(-1,1),e.lineTo(1,-1),e.moveTo(10,12),e.lineTo(12,10),e.stroke()}let Ze=Ye.createPattern(Xe,`repeat`),F=1,I=1,L=1,R=1,Qe=1,z=1,$e=1,et=1,tt=8,nt=[],rt,B,it,V,at,ot,st,H,ct=E.createBindGroup({layout:Ce.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:Pe}},{binding:1,resource:M},{binding:2,resource:ze.createView()}]});function lt(e,t,n){L=Math.max(1,e),R=Math.max(1,t);let r=n;L*R*r*r>le&&(r=Math.sqrt(le/(L*R))),Qe=r,F=Math.max(2,Math.round(L*r)),I=Math.max(2,Math.round(R*r)),D.width=F,D.height=I,z=Math.min(r,1.5),P.width=Math.max(1,Math.round(L*z)),P.height=Math.max(1,Math.round(R*z)),tt=Math.max(Math.round(10*r),Math.ceil(F/ie),Math.ceil(I/ae)),$e=Math.ceil(F/tt),et=Math.ceil(I/tt),E.queue.writeBuffer(Fe,0,new Uint32Array([$e,et,tt,0]));for(let e of nt)e.destroy();let i=(e,t,n=A,r=0)=>{let i=E.createTexture({size:[Math.max(1,e),Math.max(1,t)],format:n,usage:a.RENDER_ATTACHMENT|a.TEXTURE_BINDING|r});return nt.push(i),i};nt=[],rt=i(F,I),B=[i(F,I),i(F,I)],it=i(P.width,P.height,`rgba8unorm`,a.COPY_DST),V=i(Math.ceil(F/4),Math.ceil(I/4)),at=i(Math.ceil(F/4),Math.ceil(I/4)),ot=i(Math.ceil(F/16),Math.ceil(I/16)),st=i(Math.ceil(F/16),Math.ceil(I/16));let o=(e,t)=>E.createBindGroup({layout:e.getBindGroupLayout(0),entries:t.map((e,t)=>({binding:t,resource:e}))}),s=e=>e.createView(),c={buffer:Pe};H={scene:ct,feedback:[0,1].map(e=>o(we,[c,M,s(rt),s(B[1-e])])),down1:[0,1].map(e=>o(Te,[M,s(B[e]),s(it)])),blurH1:o(De,[M,s(V)]),blurV1:o(Oe,[M,s(at)]),down2:o(Ee,[M,s(V)]),blurH2:o(De,[M,s(ot)]),blurV2:o(Oe,[M,s(st)]),final:[0,1].map(e=>o(ke,[c,M,s(B[e]),s(it),s(V),s(ot)])),detect:[0,1].map(e=>o(je,[s(B[e]),{buffer:Le},{buffer:Fe}]))},U.length=0,pt++}let ut=new Int32Array(24e3),dt=new Int32Array(24e3),U=[],ft=1,pt=0;function mt(e,t,n,r){let i=r/Qe,a=oe*(1.15-.35*Math.min(1,Math.max(0,K)*3)),o=se(e,t,n,Math.max(3,Math.round(R*.24/i)),a,7+Math.round(3*J),ut,dt).map(e=>({x0:e.x0*i,y0:e.y0*i,x1:e.x1*i,y1:e.y1*i,cx:e.cx*i,cy:e.cy*i,score:e.score})),s=new Set,c=Math.min(L,R)*.12;for(let e of o){let t=null,n=1/0;for(let r of U){if(s.has(r))continue;let i=Math.hypot(r.t.cx-e.cx,r.t.cy-e.cy);i<n&&i<c+(e.x1-e.x0)*.5&&(t=r,n=i)}if(t)t.t=e,t.age++,t.miss=0,s.add(t);else if(U.length<22){let t={id:ft++,x0:e.x0,y0:e.y0,x1:e.x1,y1:e.y1,t:e,age:1,miss:0,scramble:0};U.push(t),s.add(t)}}for(let e=U.length-1;e>=0;e--){let t=U[e];s.has(t)||++t.miss>4&&U.splice(e,1)}}function ht(e,t){let n=Re.find(e=>!e.busy);if(!n)return null;let r=e.beginComputePass();r.setPipeline(je),r.setBindGroup(0,H.detect[t]),r.dispatchWorkgroups(Math.ceil($e/8),Math.ceil(et/8)),r.end();let i=$e*et*4;e.copyBufferToBuffer(Le,0,n.buf,0,i),n.busy=!0;let a=$e,o=et,s=tt,c=pt;return()=>{n.buf.mapAsync(1,0,i).then(()=>{ge||(c===pt&&mt(new Uint32Array(n.buf.getMappedRange(0,i)),a,o,s),n.buf.unmap(),n.busy=!1)},()=>{n.busy=!1})}}let gt=ne(g),_t=0,vt=0,yt=0,bt=0,W=0,xt=0,St=0,G=0,Ct=0,wt=0,Tt=0,Et=0,Dt=0,Ot=Array(8).fill(0),kt=0,At=1,jt=0,Mt=0,K=-1,q=0,Nt=0,J=0,Pt=0,Ft=0,Y=0,It=0,Lt=0,Rt=1.8,X=new Float32Array(32),zt=new Float32Array(32),Z=new Float32Array(32),Bt=new Float32Array(32).fill(.3),Vt=h[0],Ht=h[0],Ut=1,Wt=h.find(e=>e.name===new URLSearchParams(window.location.search).get(`palette`))??null,Q=0,Gt=0,Kt=Math.random(),qt=6141,Jt=0,$=Xt([...C.keys()]),Yt=0;function Xt(e){for(let t=e.length-1;t>0;t--){let n=Math.floor(Math.random()*(t+1));[e[t],e[n]]=[e[n],e[t]]}return e}let Zt=()=>String(qt%1e4).padStart(4,`0`),Qt=()=>Ut>=1?Ht:v(Vt,Ht,Ut);function $t(e,t){Vt=t?Qt():e,Ht=e,Ut=+!t}function en(){let e=gt[_t%gt.length];return _t++,e}function tn(e){Q=e,Gt=0,yt=0,bt=0,It=0,Kt=Math.random();let t=C[e].name;$t(Wt??(t===`blue`?h[0]:_(Ht.name,t===`equalizer`)),!1),t===`count`&&N(x,Zt(),!0),t===`ticker`?N(y,gt===ee?te[Math.floor(Math.random()*te.length)]:gt.slice(0,4).join(` `)):N(y,en());let n=en();N(b,t===`blue`?n.charAt(0).toUpperCase():n)}function nn(){if(Yt++,Yt>=$.length){let e=$[$.length-1];$=Xt([...C.keys()]),$[0]===e&&$.push($.shift()),Yt=0}tn($[Yt]),St=.6}let rn=new URLSearchParams(window.location.search),an=C.findIndex(e=>e.name===rn.get(`scene`));tn(an>=0?an:$[0]);function on(e,t,n,r,i){let a=Ne,o=e=>re(e,r);a.fill(0),a.set([F,I,1/F,1/I],0),a.set([n,W,G,Ct],4);let s=e.focus,c=e.planes[0];if(c){let e=S(c.yaw,c.pitch,c.roll),t=.35*c.h*Je(c.row),n=n=>Math.hypot(c.pos[0]+n*e.u[0]*t,c.pos[1]+n*e.u[1]*t,c.pos[2]+n*e.u[2]*t);s=Math.min(n(-1),n(1))}let l=Math.min(1,Math.max(W,G*.6));Rt=1.8*(1+.12*kt),a.set([Rt,s,e.dof+.12*Pt,1.05*(.85+.55*l)],8),a.set([...o(t.bg),0],12),a.set([...o(t.tint),1],16);let u=(e.trail+(.8-e.trail)*J*.6)**(i*60);a.set([u,e.zoom-W*.004-.005*J,.0016+.006*Ct+.003*W+.004*Dt+.004*J,xt],20);let d=Math.max(3,Math.min(10,Math.round(I/220)));a.set([e.drift[0],e.drift[1],d,St],24);let f=.012*Math.sin(n*.9)+.006*Math.sin(n*2.3)+.0025*W*Math.sin(n*37)+.008*J*Math.sin(n*29),p=.01*Math.sin(n*.7+1)+.006*Math.cos(n*1.9)+.008*J*Math.cos(n*23);for(let t=0;t<2;t++){let n=e.planes[t],r=28+t*16;if(!n)continue;let i=S(n.yaw,n.pitch,n.roll+Mt),o=n.pos[2];a.set([n.pos[0]+f*-o,n.pos[1]+p*-o,o,n.intensity],r),a.set([...i.u,n.h*Je(n.row)],r+4),a.set([...i.v,n.h],r+8),a.set([0,n.row*T/ue,Ue[n.row]/w,T/ue],r+12)}if(e.blobs.slice(0,8).forEach((e,t)=>{let n=60+t*12;a.set([e.x+f*1.8,e.y+p*1.8,e.sx,e.sy],n),a.set([...o(e.color),e.intensity],n+4),a.set([e.round,e.hard,e.rot??0,0],n+8)}),e.ring){let t=e.ring;a.set([t.x+f*1.8,t.y+p*1.8,t.hx,t.hy],156),a.set([...o(t.color),t.intensity],160),a.set([t.radius,t.thickness,0,0],164)}let m=Math.min(1,Math.max(0,(J-.5)*2.5));a.set([...o(t.lo),t.grade],168),a.set([...o(t.hi),.55*Pt],172),a.set([J,m,Ft,.4*Math.min(1,wt)],176);let h=o(t.accent);a.set([h[0]*Y,h[1]*Y,h[2]*Y,Pt],180),a.set([.75+.35*Math.min(1,Tt),1+.3*Math.min(1,Tt),0,0],184),e.eq&&(a.set([e.eq.amount,e.eq.y+p*1.8,e.eq.h,e.eq.hw],188),a.set([...o(t.accent),1.4],192),a.set(X,196),a.set(zt,228)),E.queue.writeBuffer(Pe,0,a)}function sn(e){if(e[2]>-.05)return null;let t=e[0]/-e[2]*Rt,n=e[1]/-e[2]*Rt;return[L/2+t*R/2,R/2-n*R/2]}function cn(e,t,n){let r=Ye;r.setTransform(1,0,0,1,0,0),r.globalCompositeOperation=`source-over`,r.globalAlpha=1,r.clearRect(0,0,P.width,P.height),r.setTransform(z,0,0,z,0,0),r.globalCompositeOperation=`lighter`,r.lineCap=`butt`;let i=e.planes[0];if(i&&(i.yaw!==0||i.roll!==0)){let e=S(i.yaw,i.pitch,i.roll+Mt),t=i.h*Je(i.row)*.5;for(let[n,a]of[[-1.7,.2],[2.1,.13],[-4.2,.08]]){let o=t=>[i.pos[0]+e.u[0]*t+e.v[0]*n*i.h,i.pos[1]+e.u[1]*t+e.v[1]*n*i.h,i.pos[2]+e.u[2]*t+e.v[2]*n*i.h],s=sn(o(-t)),c=sn(o(t));if(!s||!c)continue;let l=c[0]-s[0],u=c[1]-s[1],d=Math.hypot(l,u)||1,f=(L+R)*2;r.strokeStyle=`rgba(255,0,0,${a})`,r.lineWidth=1.2,r.beginPath(),r.moveTo(s[0]-l/d*f,s[1]-u/d*f),r.lineTo(c[0]+l/d*f,c[1]+u/d*f),r.stroke()}}let a=1-Math.exp(-t*16);for(let e of U)e.x0+=(e.t.x0-e.x0)*a,e.y0+=(e.t.y0-e.y0)*a,e.x1+=(e.t.x1-e.x1)*a,e.y1+=(e.t.y1-e.y1)*a,e.scramble=Math.max(0,e.scramble-t);let o=U.filter(e=>e.age>=3);for(n&&o.length&&(o[Math.floor(Math.random()*o.length)].scramble=.09);Lt>0&&o.length;Lt--)o[Math.floor(Math.random()*o.length)].scramble=.14;if(o.length>1){let e=[...o];e.sort((e,t)=>e.x0+e.x1-(t.x0+t.x1));let t=[e.shift()];for(;e.length;){let n=t[t.length-1],r=(n.x0+n.x1)/2,i=(n.y0+n.y1)/2,a=0,o=1/0;e.forEach((e,t)=>{let n=Math.hypot((e.x0+e.x1)/2-r,(e.y0+e.y1)/2-i);n<o&&(o=n,a=t)}),t.push(e.splice(a,1)[0])}let n=t.map(e=>[(e.x0+e.x1)/2,(e.y0+e.y1)/2]),i=(e,t)=>{let n=e[0]-t[0],r=e[1]-t[1],i=Math.hypot(n,r)||1,a=L+R;return[e[0]+n/i*a,e[1]+r/i*a]};r.strokeStyle=`rgba(255,0,0,${.7+.3*W})`,r.lineWidth=1.3,r.beginPath();let a=i(n[0],n[1]);r.moveTo(a[0],a[1]);for(let e of n)r.lineTo(e[0],e[1]);let s=i(n[n.length-1],n[n.length-2]);r.lineTo(s[0],s[1]),r.stroke()}let s=Math.round(Math.max(11,Math.min(20,R/44)));r.font=`500 ${s}px ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace`,r.textBaseline=`bottom`;let c=3+Math.max(W,G*.6)*7+kt*6,l=[];for(let e of o){let t=Math.min(1,e.age/4)*(1-e.miss/5),n=Math.round(e.x0-c),i=Math.round(e.y0-c),a=Math.round(e.x1-e.x0+c*2),o=Math.round(e.y1-e.y0+c*2);r.globalAlpha=t,e.id%3!=0&&(Ze.setTransform(new DOMMatrix().translateSelf(n,i)),r.fillStyle=Ze,r.fillRect(n,i,a,o)),r.strokeStyle=`#f00`,r.lineWidth=1.3,r.strokeRect(n+.5,i+.5,a,o);let u=(e.x0+e.x1)/2,d=(e.y0+e.y1)/2,f=e.scramble>0?`x: ${Math.floor(Math.random()*1900)} y: ${Math.floor(Math.random()*1e3)}`:`x: ${Math.round(u)} y: ${Math.round(d)}`,p=n-s*.4,m=i-3,h=r.measureText(f).width;l.some(([e,t,n])=>p<e+n&&e<p+h&&Math.abs(t-m)<s)||(l.push([p,m,h,s]),r.fillStyle=`#f00`,r.fillText(f,p,m))}r.globalAlpha=1,E.queue.copyExternalImageToTexture({source:P},{texture:it,premultipliedAlpha:!0},[P.width,P.height])}function ln(e){It++,It%2?Ft=Math.max(Ft,.75*e):Y=Math.max(Y,.3*e),It%2==0&&!Wt&&C[Q].name!==`blue`&&$t(_(Ht.name,C[Q].name===`equalizer`),!0)}function un(t,r,i){let a=e=>Math.exp(-i/e),o=n(t);if(o){let n=e(t);W=Math.max(W,Math.min(1,n*r)),kt=Math.max(kt,Math.min(1,n*r)),qt++,C[Q].name===`count`&&N(x,Zt(),!0),n>=.5&&(Gt++,Lt=2,t.beat.isBeat&&t.beat.barBeat===0&&ln(n),Gt===8&&C[Q].beats>=16&&N(y,en()))}W*=a(.17),kt*=a(.12);let s=(e,t,n)=>e+(Math.min(1.5,t*r)-e)*(1-a(n));G=s(G,t.onsets.kick.envelope,.05),Ct=s(Ct,t.onsets.snare.envelope,.05),wt=s(wt,t.onsets.hat.envelope,.04),Tt=s(Tt,t.bands.bass,.12),Et=s(Et,t.bands.mid,.15),Dt=s(Dt,t.bands.treble,.1);let c=t.bands;[c.sub,c.bass,c.lowMid,c.mid,c.highMid,c.treble,t.onsets.kick.envelope,t.onsets.snare.envelope].forEach((e,t)=>{Ot[t]=s(Ot[t],e,.08)}),t.onsets.snare.hit&&(At=-At,jt=At*.06*Math.min(1,t.onsets.snare.strength*r)),jt*=a(.35),Mt+=(jt-Mt)*(1-a(.06));let l=t.silent?0:t.level.rms;K<0?l>0&&(K=q=l):(K+=(l-K)*(1-a(.3)),q+=(l-q)*(1-a(6)),Nt+=i);let u=q>.01?Math.min(1,Math.max(0,(K/q-1.1)*3))*Math.min(1,Math.max(0,(Nt-3)/3)):0;J+=(u-J)*(1-a(u>J?.15:.8));let d=+(!t.silent&&t.beat.confidence>=.3&&t.beat.strength<.35&&K>q*1.05);return Pt+=(d-Pt)*(1-a(1)),t.onsets.snare.hit&&t.beat.confidence>=.3&&t.onsets.snare.strength*r>.65-.25*J&&(xt=1),xt*=a(.07),St*=a(.1),Ft*=a(.08),Y*=a(.12),Ut=Math.min(1,Ut+i/.6),o}function dn(e,n,r){let i=e.spectrum({fftSize:1024,smoothing:.75}),a=1-Math.exp(-r/.12),o=1-Math.exp(-r/1.5),s=1-Math.exp(-r/2.5);for(let e=0;e<32;e++){let c=Math.floor(2*200**(e/32)),l=Math.max(c+1,Math.floor(2*200**((e+1)/32))),u=t(i,c,l)/255*(.9+e/60);Z[e]=u<Z[e]?u:Z[e]+(u-Z[e])*o,Bt[e]=u>Bt[e]?u:Bt[e]+(u-Bt[e])*s;let d=Math.max(.12,Bt[e]-Z[e]),f=Math.min(1,Math.max(0,.08+(u-Z[e])/d*.92)*Math.min(1,u*3)*n);X[e]=f>X[e]?f:X[e]+(f-X[e])*a,zt[e]=Math.max(X[e],zt[e]-r*.45)}}return{resize(e,t,n){O?O.resize?.(e,t,n):lt(e,t,n)},metadata(e){gt=ne(e),_t=0},frame({audio:e,settings:t,dt:n,time:r}){if(ge||O)return;let i=t.sensitivity;un(e,i,n);let a=e.onsets.hat.hit,o=e.silent?0:Math.min(1,e.level.rms*i*2),s=t.speed*(.35+o);vt+=n*s,yt+=n*s,bt+=n;let c=C[Q];an<0&&(Gt>=c.beats||bt>16/Math.max(.3,t.speed))&&nn();let l=Qt(),u=C[Q].build({phase:vt,local:yt,pulse:W,kick:G,snare:Ct,hat:wt,bass:Tt,mid:Et,treble:Dt,seed:Kt,ax:Math.min(1,L/R/1.78),scale:t.scale,bands:Ot,pal:l,aspect:Je});u.eq&&dn(e,i,n),on(u,l,r,t.hueShift,n),cn(u,n,a);let d=E.createCommandEncoder(),f=(e,t,n)=>{let r=d.beginRenderPass({colorAttachments:[{view:`createView`in e?e.createView():e,loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,1]}]});r.setPipeline(t),r.setBindGroup(0,n),r.draw(3),r.end()},p=1-Jt;Ge&&=(qe(d),!1),f(rt,Ce,H.scene),f(B[p],we,H.feedback[p]);let m=ht(d,p);f(V,Te,H.down1[p]),f(at,De,H.blurH1),f(V,Oe,H.blurV1),f(ot,Ee,H.down2),f(st,De,H.blurH2),f(ot,Oe,H.blurV2),f(me.getCurrentTexture().createView(),ke,H.final[p]),E.queue.submit([d.finish()]),m?.(),Jt=p},dispose(){ge=!0,O?.dispose();for(let e of nt)e.destroy();ze.destroy(),Pe.destroy(),Fe.destroy(),Le.destroy();for(let e of Re)e.buf.destroy();me.unconfigure(),E.destroy(),D.remove()}}};export{fe as default};
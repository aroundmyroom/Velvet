import{i as e,r as t}from"./audio-Ds-N7sX7.js";import{a as n,i as r,n as i,r as a,t as o}from"./webgpu-C8PYNhZC.js";var s=`
struct U {
  res: vec4f,  // render w, h, aspect, px per scope unit
  scr: vec4f,  // screen half width, half height (clip units, x times aspect), corner radius, curvature
  gr: vec4f,   // scope unit in clip units, graticule half width, half height (units), time
  ph: vec4f,   // fluorescence decay, afterglow decay, afterglow weight, glass scatter
  colF: vec4f, // fluorescence rgb, exposure
  colS: vec4f, // afterglow rgb, bloom gain
  colG: vec4f, // graticule rgb, graticule level
  fx: vec4f,   // bezel reflection, readout level, grain, -
};
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

fn hash21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
`,c=s+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> segs: array<vec4f>;

struct BOut { @builtin(position) pos: vec4f, @location(0) lc: vec2f, @location(1) k: vec2f };

@vertex fn vsBeam(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  let s0 = segs[ii * 2u];
  let s1 = segs[ii * 2u + 1u];
  let a = s0.xy;
  let d = s0.zw - a;
  let sig = max(s1.y, 0.7 / u.res.w); // at least 0.7 px, so thin traces stay antialiased
  let L = length(d);
  var dir = vec2f(1.0, 0.0);
  if (L > 1e-6) { dir = d / L; }
  let nrm = vec2f(-dir.y, dir.x);
  let r = sig * 3.6;
  var cs = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = cs[vi];
  let along = mix(-r, L + r, c.x);
  let across = c.y * r;
  let p = (a + dir * along + nrm * across) * u.gr.x;
  var o: BOut;
  o.pos = vec4f(p.x / u.res.z, p.y, 0.0, 1.0);
  o.lc = vec2f(along, across) / sig;
  o.k = vec2f(L / sig, s1.x / sig);
  return o;
}

fn erf(x: f32) -> f32 { // Abramowitz-Stegun 7.1.26
  let t = 1.0 / (1.0 + 0.3275911 * abs(x));
  let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return sign(x) * y;
}

// The spot integrated along the segment: a line's core is energy / length, a dot's peak
// energy / (sqrt(2 pi) sigma).
@fragment fn fsBeam(v: BOut) -> @location(0) vec4f {
  let x = v.lc.x;
  let y = v.lc.y;
  let len = v.k.x;
  var I: f32;
  if (len < 0.02) { I = 0.39894 * exp(-0.5 * (x * x + y * y)); }
  else { I = exp(-0.5 * y * y) * 0.5 * (erf(x * 0.70711) - erf((x - len) * 0.70711)) / len; }
  return vec4f(I * v.k.y, 0.0, 0.0, 1.0);
}
`,l=s+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var beam: texture_2d<f32>;
@group(0) @binding(2) var prev: texture_2d<f32>;

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let ip = vec2i(i.pos.xy);
  let b = textureLoad(beam, ip, 0).r;
  let p = textureLoad(prev, ip, 0).rg;
  let f = p.x * u.ph.x + b * (1.0 - u.ph.x);
  let s = min(p.y * u.ph.y + b * (1.0 - u.ph.y), 60.0);
  return vec4f(f, s, 0.0, 1.0);
}
`,u=s+`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

fn tap(uv: vec2f) -> vec2f { return textureSampleLevel(src, samp, uv, 0.0).rg; }
fn box4(uv: vec2f) -> vec2f {
  let px = 1.0 / vec2f(textureDimensions(src, 0));
  return (tap(uv + px * vec2f(-1.0, -1.0)) + tap(uv + px * vec2f(1.0, -1.0))
        + tap(uv + px * vec2f(-1.0, 1.0)) + tap(uv + px * vec2f(1.0, 1.0))) * 0.25;
}
@fragment fn fsDown(i: VSOut) -> @location(0) vec4f { return vec4f(box4(i.uv), 0.0, 1.0); }
fn blur(uv: vec2f, dir: vec2f) -> vec4f {
  let px = dir / vec2f(textureDimensions(src, 0)) * 1.4;
  var c = tap(uv) * 0.2270;
  c += (tap(uv + px * 1.3846) + tap(uv - px * 1.3846)) * 0.3162;
  c += (tap(uv + px * 3.2308) + tap(uv - px * 3.2308)) * 0.0703;
  return vec4f(c, 0.0, 1.0);
}
@fragment fn fsBlurH(i: VSOut) -> @location(0) vec4f { return blur(i.uv, vec2f(1.0, 0.0)); }
@fragment fn fsBlurV(i: VSOut) -> @location(0) vec4f { return blur(i.uv, vec2f(0.0, 1.0)); }
`,d=s+`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var acc: texture_2d<f32>;
@group(0) @binding(3) var bloom1: texture_2d<f32>;
@group(0) @binding(4) var bloom2: texture_2d<f32>;
@group(0) @binding(5) var hud: texture_2d<f32>;

// clip position (x times aspect) -> texture uv
fn toUv(c: vec2f) -> vec2f { return vec2f(c.x / u.res.z * 0.5 + 0.5, 0.5 - c.y * 0.5); }
fn glow(uv: vec2f) -> vec2f {
  return textureSampleLevel(bloom1, samp, uv, 0.0).rg * 0.55 + textureSampleLevel(bloom2, samp, uv, 0.0).rg * 0.9;
}
fn rrect(p: vec2f, h: vec2f, r: f32) -> f32 {
  let q = abs(p) - h + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn lineCov(d: f32, hw: f32, px: f32) -> f32 { return 1.0 - smoothstep(hw - px * 0.5, hw + px * 0.5, d); }

// The graticule in scope units (one division = 0.25): a frame, division lines, and the centre
// axes with minor ticks. px = one pixel in units.
fn graticule(g: vec2f, px: f32) -> f32 {
  let ext = u.gr.yz;
  let e = abs(g) - ext;
  if (e.x > px * 2.0 || e.y > px * 2.0) { return 0.0; }
  let hw = px * 0.55;
  let m = abs(fract(g / 0.25 + 0.5) - 0.5) * 0.25;
  // division lines are dotted, like an etched Tek graticule
  let dots = abs(fract(g / 0.05 + 0.5) - 0.5) * 0.05;
  var L = max(lineCov(m.x, hw, px) * lineCov(dots.y, px * 1.1, px), lineCov(m.y, hw, px) * lineCov(dots.x, px * 1.1, px)) * 0.7;
  L = max(L, max(lineCov(abs(g.x), hw, px), lineCov(abs(g.y), hw, px)) * 0.75);
  let tick = 0.022;
  let t = abs(fract(g / 0.05 + 0.5) - 0.5) * 0.05;
  if (abs(g.y) < tick) { L = max(L, lineCov(t.x, hw, px)); }
  if (abs(g.x) < tick) { L = max(L, lineCov(t.y, hw, px)); }
  L = max(L, max(lineCov(abs(e.x), hw * 1.4, px) * step(e.y, 0.0), lineCov(abs(e.y), hw * 1.4, px) * step(e.x, 0.0)));
  return L;
}

@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let asp = u.res.z;
  let p = vec2f((i.uv.x - 0.5) * 2.0 * asp, (0.5 - i.uv.y) * 2.0);
  let hs = u.scr.xy;
  let pxc = 2.0 / u.res.y;
  let sd = rrect(p, hs, u.scr.z);
  let n = p / hs;
  let r2 = dot(n, n) * 0.5;
  // the faceplate bulges a little: the middle of the picture is magnified
  let c = p * (1.0 - u.scr.w * (1.0 - r2));
  let uv = toUv(c);

  // phosphor light: the coating is grainy, which shows in the bright parts
  let grain = 0.88 + 0.24 * hash21(floor(i.pos.xy / 1.5) + 0.37);
  let L = textureSampleLevel(acc, samp, uv, 0.0).rg;
  let G = glow(uv) * u.colS.w;
  let txt = textureSampleLevel(hud, samp, uv, 0.0).r * u.fx.y;
  let fast = (L.x + G.x * 0.45) * grain + txt;
  let slow = (L.y * grain + G.y) * u.ph.z;
  var col = u.colF.rgb * fast + u.colS.rgb * slow;
  // the graticule, edge-lit and lit by the glow of the trace
  let gl = graticule(c / u.gr.x, pxc / u.gr.x);
  col += u.colG.rgb * gl * (u.colG.w + 0.9 * (G.x + G.y));
  // light scattered in the glass: the whole screen glows faintly with what is on it
  col += u.colS.rgb * u.ph.w * (1.0 - 0.55 * r2);
  // the unlit faceplate
  col += vec3f(0.006, 0.009, 0.008) * (1.0 - 0.5 * r2);
  col = vec3f(1.0) - exp(-col * u.colF.w);
  // a soft sheen of the room on the glass
  let sh = n - vec2f(-0.5, 0.62);
  col += vec3f(0.018, 0.02, 0.022) * exp(-dot(sh, sh) * 2.2);
  col *= mix(0.72, 1.0, smoothstep(1.15, 0.25, r2));

  // the bezel: dark plastic, lit a little from above, with the screen reflected in its lip
  let q = abs(p) - hs;
  var m = p;
  if (q.y > q.x) { m.y = sign(p.y) * (hs.y - (abs(p.y) - hs.y) * 2.6); }
  else { m.x = sign(p.x) * (hs.x - (abs(p.x) - hs.x) * 2.6); }
  let dist = max(sd, 0.0);
  let R = glow(toUv(m)) * u.colS.w;
  var bez = vec3f(0.018, 0.019, 0.021) * (0.75 + 0.5 * (1.0 - i.uv.y));
  bez += (u.colF.rgb * R.x + u.colS.rgb * R.y * u.ph.z) * u.fx.x * exp(-dist / 0.022);
  bez += vec3f(0.06) * exp(-abs(sd - pxc * 2.0) / (pxc * 1.2)) * (0.35 + 0.65 * (1.0 - i.uv.y));
  bez = vec3f(1.0) - exp(-bez * 1.3);
  let inside = smoothstep(pxc, -pxc, sd);
  col = mix(bez, col, inside);

  // grain (camera noise) and a little dither against banding
  let gs = i.pos.xy + vec2f(floor(u.gr.w * 30.0) * 37.0, 0.0);
  col += (hash21(gs) - 0.5) * u.fx.z;
  col += (hash21(gs + 17.0) - 0.5) / 255.0;
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`,f=[{name:`p31`,fast:[.3,1,.42],slow:[.1,.78,.2],grat:[.5,.66,.56],weight:6},{name:`p7`,fast:[.55,.76,1],slow:[.68,.92,.16],grat:[.5,.58,.68],weight:1.5},{name:`p11`,fast:[.22,.95,.88],slow:[.06,.55,.66],grat:[.46,.64,.66],weight:1.5},{name:`p3`,fast:[1,.64,.16],slow:[.92,.36,.04],grat:[.68,.56,.42],weight:1}];function p(e,t){if(!t)return e;let n=t*Math.PI/180,r=Math.cos(n),i=Math.sin(n),a=.299*e[0]+.587*e[1]+.114*e[2],o=.596*e[0]-.274*e[1]-.322*e[2],s=.211*e[0]-.523*e[1]+.312*e[2],c=o*r-s*i,l=o*i+s*r;return[Math.max(0,a+.956*c+.621*l),Math.max(0,a-.272*c-.647*l),Math.max(0,a-1.106*c+1.703*l)]}var m=(e,t,n)=>[e[0]+(t[0]-e[0])*n,e[1]+(t[1]-e[1])*n,e[2]+(t[2]-e[2])*n],h=1400,g=Math.PI*2;function _(e){let t=e.length,n=new Float64Array(t);for(let r=1;r<t;r++){let t=e[r-1],i=e[r];n[r]=n[r-1]+Math.hypot(i[0]-t[0],i[1]-t[1],i[2]-t[2],i[3]-t[3])}let r=n[t-1],i=new Float32Array(h*4),a=1;for(let o=0;o<h;o++){let s=o/h*r;for(;a<t-1&&n[a]<s;)a++;let c=n[a]-n[a-1],l=c>0?(s-n[a-1])/c:0;for(let t=0;t<4;t++)i[o*4+t]=e[a-1][t]+(e[a][t]-e[a-1][t])*l}return i}function v(e,t){let n=[];for(let r=0;r<e.length;r++)for(let i=r+1;i<e.length;i++){let a=Math.hypot(...e[r].map((t,n)=>t-e[i][n]));Math.abs(a-t)<.001&&n.push([r,i])}let r=e.map(()=>[]);n.forEach(([e,t],n)=>{r[e].push(n),r[t].push(n)});let i=new Uint8Array(n.length),a=[],o=t=>{a.push(e[t]);for(let s of r[t])i[s]||(i[s]=1,o(n[s][0]===t?n[s][1]:n[s][0]),a.push(e[t]))};return o(0),a}function y(e,t=2400){let n=[];for(let r=0;r<=t;r++)n.push(e(r/t*g));return n}var b=null;function x(){if(b)return b;let e=[];for(let t=0;t<8;t++)e.push([t&1?1:-1,t&2?1:-1,t&4?1:-1,0]);let t=[];for(let e=0;e<16;e++)t.push([e&1?1:-1,e&2?1:-1,e&4?1:-1,e&8?1:-1]);let n=(1+Math.sqrt(5))/2,r=[];for(let e of[-1,1])for(let t of[-1,1])r.push([0,e,t*n,0],[e,t*n,0,0],[t*n,0,e,0]);let i=(e,t)=>e.map(e=>e.map(e=>e*t)),a=.72/Math.hypot(1,n);return b=[{name:`cube`,label:`CUBE`,pts:_(i(v(e,2),.5)),four:0},{name:`tesseract`,label:`TESSERACT`,pts:_(i(v(t,2),.4)),four:1},{name:`icosa`,label:`ICOSAHEDRON`,pts:_(i(v(r,2),a)),four:0},{name:`coil`,label:`TOROID`,pts:_(y(e=>{let t=.56+.19*Math.cos(22*e);return[t*Math.cos(e),t*Math.sin(e),.19*Math.sin(22*e),0]},4e3)),four:0},{name:`knot`,label:`TORUS KNOT 2,5`,pts:_(y(e=>{let t=.5+.2*Math.cos(5*e);return[t*Math.cos(2*e),t*Math.sin(2*e),.2*Math.sin(5*e),0]})),four:0},{name:`spring`,label:`HELIX`,pts:_([...y(e=>{let t=e/g;return[-.8+1.6*t,.28*Math.cos(g*11*t),.28*Math.sin(g*11*t),0]},3e3),[.8,0,0,0],[-.8,0,0,0],[-.8,.28,0,0]]),four:0},{name:`yarn`,label:`LOXODROME`,pts:_(y(e=>{let t=e<Math.PI,n=t?e:g-e,r=t?0:Math.PI/14,i=14*n+r;return[.62*Math.sin(n)*Math.cos(i),.62*Math.cos(n),.62*Math.sin(n)*Math.sin(i),0]},4e3)),four:0},{name:`lissajous`,label:`LISSAJOUS 3:4:5`,pts:_(y(e=>[.6*Math.sin(3*e+Math.PI/2),.6*Math.sin(4*e),.6*Math.sin(5*e),0])),four:0}],b}var S=[{name:`yt`,calm:!0,loud:!0,beats:32,persist:.2},{name:`xy`,calm:!0,loud:!1,beats:32,persist:.45},{name:`vector`,calm:!0,loud:!0,beats:48,persist:.14},{name:`dots`,calm:!1,loud:!0,beats:32,persist:.1},{name:`sparks`,calm:!1,loud:!0,beats:32,persist:.3},{name:`polar`,calm:!0,loud:!0,beats:32,persist:.26}],C=0,w=1,ee=2,te=3,ne=4,re=5,ie=[`bass`,`full`,`dual`,`stereo`],T=[.1,.2,.5,1,2,5],ae=32,oe=3686400,se=12e3,ce=560,le=150,E=1800,ue=2.5066283,de=2.6;function fe(e){let t=new Float32Array(e*3),n=Math.PI*(3-Math.sqrt(5));for(let r=0;r<e;r++){let i=1-2*(r+.5)/e,a=Math.sqrt(1-i*i),o=r*n;t.set([a*Math.cos(o),i,a*Math.sin(o)],r*3)}return t}var pe=async({container:s})=>{let _=navigator.gpu;if(!_)return n(s,r());let v=await _.requestAdapter().catch(()=>null);if(!v)return n(s,`No WebGPU adapter: enable hardware acceleration.`);let y=await v.requestDevice(),b=document.createElement(`canvas`);b.className=`w-full h-full block`,s.appendChild(b);let pe=b.getContext(`webgpu`),me=_.getPreferredCanvasFormat();pe.configure({device:y,format:me,alphaMode:`opaque`});let he=!1,ge=null;y.lost.then(e=>{he||(b.remove(),ge=n(s,`WebGPU device lost (${e.reason||`unknown`}).`),ge.resize?.(s.clientWidth,s.clientHeight,Math.min(2,window.devicePixelRatio||1)))}),y.pushErrorScope(`validation`);let[_e,ve,ye,be]=await Promise.all([a(y,c,`oscilloscope-beam`),a(y,l,`oscilloscope-phosphor`),a(y,u,`oscilloscope-bloom`),a(y,d,`oscilloscope-final`)]),xe=`r16float`,Se=`rg16float`,Ce=(e,t,n)=>y.createRenderPipelineAsync({layout:`auto`,vertex:{module:e,entryPoint:`vs`},fragment:{module:e,entryPoint:t,targets:[{format:n}]},primitive:{topology:`triangle-list`}}),we={srcFactor:`one`,dstFactor:`one`,operation:`add`},[Te,Ee,De,Oe,ke,Ae]=await Promise.all([y.createRenderPipelineAsync({layout:`auto`,vertex:{module:_e,entryPoint:`vsBeam`},fragment:{module:_e,entryPoint:`fsBeam`,targets:[{format:xe,blend:{color:we,alpha:we}}]},primitive:{topology:`triangle-list`}}),Ce(ve,`fs`,Se),Ce(ye,`fsDown`,Se),Ce(ye,`fsBlurH`,Se),Ce(ye,`fsBlurV`,Se),Ce(be,`fs`,me)]),je=await y.popErrorScope();if(je)throw Error(`Oscilloscope: ${je.message}`);let D=y.createSampler({magFilter:`linear`,minFilter:`linear`,addressModeU:`clamp-to-edge`,addressModeV:`clamp-to-edge`}),Me=new Float32Array(ae),Ne=y.createBuffer({size:128,usage:o.UNIFORM|o.COPY_DST}),O=new Float32Array(se*8),Pe=y.createBuffer({size:O.byteLength,usage:o.STORAGE|o.COPY_DST}),Fe=y.createBindGroup({layout:Te.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:Ne}},{binding:1,resource:{buffer:Pe}}]}),k=document.createElement(`canvas`),Ie=k.getContext(`2d`),A=2,j=2,Le=1,Re=1,ze=1,Be=1,M=1,Ve=1,N=1,He=[],Ue,We,Ge,Ke,qe,Je,Ye,P,Xe=``,Ze=0;function Qe(e,t,n){let r=Math.max(1,e),a=Math.max(1,t),o=n;r*a*o*o>oe&&(o=Math.sqrt(oe/(r*a))),A=Math.max(2,Math.round(r*o)),j=Math.max(2,Math.round(a*o)),Le=A/j,b.width=A,b.height=j,Re=Math.min(o,1.5),k.width=Math.max(1,Math.round(r*Re)),k.height=Math.max(1,Math.round(a*Re)),ze=Math.max(.2,Le-.075*Math.min(1,Le)),Be=.925,M=.9*Math.min(Be,ze),Ve=Math.max(1,Math.floor(ze/M*.97*4))/4,N=Math.max(1,Math.floor(Be/M*.97*4))/4;for(let e of He)e.destroy();He=[];let s=(e,t,n=Se,r=0)=>{let a=y.createTexture({size:[Math.max(1,e),Math.max(1,t)],format:n,usage:i.RENDER_ATTACHMENT|i.TEXTURE_BINDING|r});return He.push(a),a};Ue=s(A,j,xe),We=[s(A,j),s(A,j)],Ge=s(k.width,k.height,`rgba8unorm`,i.COPY_DST),Ke=s(Math.ceil(A/4),Math.ceil(j/4)),qe=s(Math.ceil(A/4),Math.ceil(j/4)),Je=s(Math.ceil(A/16),Math.ceil(j/16)),Ye=s(Math.ceil(A/16),Math.ceil(j/16));let c=(e,t)=>y.createBindGroup({layout:e.getBindGroupLayout(0),entries:t.map((e,t)=>({binding:t,resource:e}))}),l=e=>e.createView(),u={buffer:Ne};P={phos:[0,1].map(e=>c(Ee,[u,l(Ue),l(We[1-e])])),down1:[0,1].map(e=>c(De,[D,l(We[e])])),blurH1:c(Oe,[D,l(Ke)]),blurV1:c(ke,[D,l(qe)]),down2:c(De,[D,l(Ke)]),blurH2:c(Oe,[D,l(Je)]),blurV2:c(ke,[D,l(Ye)]),final:[0,1].map(e=>c(Ae,[u,D,l(We[e]),l(Ke),l(Je),l(Ge)]))},Xe=``}let $e=0,et=0,tt=.004,nt=1,rt=0,it=0;function F(e,t,n,r,i,a=tt){if($e>=se||i<=0)return;let o=$e++*8;O[o]=e+rt,O[o+1]=t+it,O[o+2]=n+rt,O[o+3]=r+it,O[o+4]=i*nt*de,O[o+5]=a,et+=i*nt}let at=(e,t,n,r=tt)=>F(e,t,e,t,n*r*ue,r),I=2048,ot=new Float32Array(I),L=new Float32Array(I),st=new Float32Array(I),ct=new Float32Array(I),lt=new Float32Array(I),ut=new Float32Array(I),dt=ot,ft=ot,pt=!1,R=400,mt=0,ht=48e3,z=[],gt=new Float32Array(48),_t=!1,vt=!1,yt=3,bt=3,xt=0;function St(e,t){let n=e.stereo();dt=n.left,ft=n.right;let r=ht=e.sampleRate||48e3,i=1-Math.exp(-g*170/r),a=1-Math.exp(-g*5e3/r),o=1-Math.exp(-g*1100/r),s=0,c=0,l=0,u=0,d=0,f=0,p=0;for(let e=0;e<48;e++)s+=(dt[e]+ft[e])*.5;s/=48,c=s,l=s,u=s;for(let e=0;e<I;e++){let t=(dt[e]+ft[e])*.5,n=(dt[e]-ft[e])*.5;ot[e]=t,ct[e]=n,s+=i*(t-s),c+=i*(s-c),L[e]=c,l+=a*(t-l),st[e]=l,u+=o*(t-u),d+=o*(n-d),lt[e]=u,ut[e]=d,f+=n*n,p+=t*t}pt=dt!==ft&&f>p*.004;let m=0;for(let e=0;e<I;e++)m+=L[e]*L[e];mt=Math.sqrt(m/I);let h=.25*mt+.0015;z.length=0;let _=!1;for(let e=64;e<I;e++){let t=L[e];t<-h?_=!0:_&&t>=0&&L[e-1]<0&&(z.push(e-1+-L[e-1]/(t-L[e-1])),_=!1)}if(z.length>=3){let e=[];for(let t=1;t<z.length;t++)e.push(z[t]-z[t-1]);e.sort((e,t)=>e-t);let n=Math.min(r/30,Math.max(r/600,e[e.length>>1]));R=Math.exp(Math.log(R)+(Math.log(n)-Math.log(R))*(1-Math.exp(-t/.35)))}}function Ct(e){let t=-1,n=1/0,r=I-e-2;for(let i=z.length-1;i>=0;i--){let a=z[i];if(a>r)continue;if(!_t){t=a;break}let o=0;for(let t=0;t<48;t++){let n=L[Math.min(2047,Math.floor(a+t/48*e))]-gt[t];o+=n*n}if(o<n&&(n=o,t=a),z.length-i>10)break}vt=t>=0,t<0&&(t=Math.max(0,r));for(let n=0;n<48;n++)gt[n]=L[Math.min(2047,Math.floor(t+n/48*e))];return _t=vt,t}function wt(e,t,n,r,i,a){let o=Math.ceil(t),s=o-t,c=2*Ve/n,l=Math.min(n,2047-o),u=-Ve+s*c,d=i+e[o]*r;for(let t=1;t<=l;t++){let n=-Ve+(t+s)*c,l=i+e[o+t]*r;F(u,d,n,l,a*c),u=n,d=l}}let Tt=new URLSearchParams(window.location.search),B=S.findIndex(e=>e.name===Tt.get(`mode`)),Et=f.find(e=>e.name===Tt.get(`phosphor`))??null,Dt=x().findIndex(e=>e.name===Tt.get(`shape`)),Ot=ie.find(e=>e===Tt.get(`variant`))??null,V=B>=0?B:C,kt=0,At=0,jt=0,Mt=0,H=`bass`,Nt=2,Pt=`phase`,Ft=Et??f[0],U=Ft,W=1,G=0,It=0,Lt=0,Rt=0,zt=0,Bt=0,Vt=0,K=0,Ht=-1,Ut=0,Wt=0,Gt=0,Kt=!0,qt=-1e9,q=0,Jt=0,Yt=0,Xt=0,Zt=0,Qt=0,$t=0,J=1,en=Dt>=0?Dt:0,tn=en,nn=0,rn=fe(ce),an=fe(le),on=new Float32Array(40),Y=new Float32Array(h*3),X={x:new Float32Array(E),y:new Float32Array(E),vx:new Float32Array(E),vy:new Float32Array(E),px:new Float32Array(E),py:new Float32Array(E),life:new Float32Array(E),max:new Float32Array(E),sig:new Float32Array(E),br:new Float32Array(E)},sn=0,cn=0;function ln(e){let t=f.filter(t=>t.name!==e),n=Math.random()*t.reduce((e,t)=>e+t.weight,0);for(let e of t)if(n-=e.weight,n<=0)return e;return t[0]}let un=()=>{if(W>=1)return U;let e=W*W*(3-2*W);return{name:U.name,fast:m(Ft.fast,U.fast,e),slow:m(Ft.slow,U.slow,e),grat:m(Ft.grat,U.grat,e),weight:1}};function dn(e,t){V=e,kt=0,At=0,jt=0,Mt=1,V===C&&(H=Ot??(t?[`dual`,`full`,`stereo`][Math.floor(Math.random()*3)]:ie[Math.floor(Math.random()*2)])),V===w&&(Pt=Tt.get(`variant`)===`ms`||Tt.get(`variant`)!==`phase`&&Math.random()<.5?`ms`:`phase`),V===re&&(Nt=[1,2,3,5][Math.floor(Math.random()*4)]),V===ee&&Dt<0&&fn(!0),V===ne&&(sn=0),!Et&&!mn&&Math.random()<.3&&(Ft=un(),U=Math.random()<.5?f[0]:ln(U.name),W=0)}function fn(e){let t=x(),n=Math.floor(Math.random()*t.length);n===tn&&(n=(n+1)%t.length),en=e?n:tn,tn=n,J=+!!e}function pn(e,t,n=!1){qt=t;let r=e.silent||e.beat.confidence<.3||K<.16,i=S.map((e,t)=>t).filter(e=>e!==V&&(n?S[e].loud&&e!==w:r?S[e].calm:S[e].loud));dn(i[Math.floor(Math.random()*i.length)],n||!r)}let mn=!0;B>=0&&dn(B,!1),mn=!1,Mt=0;function hn(n,r,i,a,o){let s=e=>Math.exp(-i/e);if(t(n)){let t=e(n);G=Math.max(G,Math.min(1,t*r)),t>=.5&&(At++,n.beat.isBeat&&n.beat.barBeat===0&&(jt++,It=Math.max(It,.6*t),V===ee&&Dt<0&&jt%4==0&&fn(!1)),B<0&&At>=S[V].beats&&pn(n,a))}G*=s(.15),It*=s(.2);let c=(e,t,n)=>e+(Math.min(1.5,t*r)-e)*(1-s(n));Lt=c(Lt,n.onsets.kick.envelope,.05),Rt=c(Rt,n.onsets.snare.envelope,.05),zt=c(zt,n.onsets.hat.envelope,.04),Bt=c(Bt,n.bands.bass,.12),Vt=c(Vt,n.bands.treble,.1),K+=((n.silent?0:Math.min(1,n.level.rms*r*2))-K)*(1-s(.4)),n.onsets.snare.hit&&($t+=1.2*Math.min(1,n.onsets.snare.strength*r)*o*(Math.random()<.5?-1:1)),$t*=s(.35),Qt+=i*$t;let l=n.silent?0:n.level.rms;Ht<0?l>0&&(Ht=Ut=l):(Ht+=(l-Ht)*(1-s(.3)),Ut+=(l-Ut)*(1-s(6)),Wt+=i);let u=Ut>.01?Math.min(1,Math.max(0,(Ht/Ut-1.1)*3))*Math.min(1,Math.max(0,(Wt-3)/3)):0;Gt+=(u-Gt)*(1-s(u>Gt?.15:.8)),Gt>.6&&Kt&&B<0&&a-qt>6&&(Kt=!1,pn(n,a,!0)),Gt<.25&&(Kt=!0)}let Z=``,Q=[],$=``;function gn(e,t,n,r){let i=Ve*8,a=4.2*R/r/i*1e3,o=0;for(;o<T.length-1&&T[o+1]<=a*1.2&&T[o+1]*i*r/1e3<I*.72;)o++;o!==bt&&(bt=o,xt=0),(xt>.6||!_t)&&(yt=bt);let s=Math.max(16,Math.round(T[yt]*i*r/1e3)),c=Ct(s),l=.95*e*t,u=H===`dual`||H===`stereo`?N*.5:0,d=l*1.15;H===`bass`?(wt(L,c,s,d,0,n),Q=[{name:`CH1`,y:0,vdiv:.25/d}]):H===`full`?(wt(st,c,s,l*.8,0,n),Q=[{name:`CH1`,y:0,vdiv:.25/l}]):H===`dual`?(wt(L,c,s,d*.8,u,n),wt(st,c,s,l*.7,-u,n*.8),Q=[{name:`CH1`,y:u,vdiv:.25/(d*.8)},{name:`CH2`,y:-u,vdiv:.25/(l*.7)}]):(wt(dt,c,s,l*.7,u,n),wt(ft,c,s,l*.7,-u,n),Q=[{name:`CH1`,y:u,vdiv:.25/(l*.7)},{name:`CH2`,y:-u,vdiv:.25/(l*.7)}]),$=`M ${T[yt]<1?`${T[yt]*1e3}µs`:`${T[yt].toFixed(2)}ms`}`,Z=H===`bass`?`Y-T  BW 170Hz`:H===`dual`?`Y-T  CH1 BW 170Hz`:H===`stereo`?`Y-T  L / R`:`Y-T`}function _n(e,t,n){let r=1248,i=.9*e*t*(1+.08*G),a=n*.006,o=0,s=0;if(pt&&Pt===`ms`){for(let e=0;e<800;e++){let t=r+e,n=ut[t]*i*2.2,c=lt[t]*i*.75;e&&F(o,s,n,c,a),o=n,s=c}Z=`X-Y  M/S`}else{let e=Math.max(3,Math.min(600,Math.round(R/4))),t=e=>L[e]*1.2+(lt[e]-L[e])*.55+(pt?ut[e]*.5:0);for(let n=0;n<800;n++){let c=r+n,l=t(c)*i,u=t(c-e)*i,d=(l-u)*Math.SQRT1_2*1.4,f=(l+u)*Math.SQRT1_2*.85;n&&F(o,s,d,f,a),o=d,s=f}Z=`X-Y  CH2 = CH1 −${(e/ht*1e3).toFixed(1)}ms`}Q=[{name:`CH1`,y:0,vdiv:.25/i},{name:`CH2`,y:0,vdiv:.25/i}],$=`X-Y`}function vn(e,t,n,r,i){let a=x(),o=a[en],s=a[tn];J=Math.min(1,J+e*r/1.1);let c=J*J*(3-2*J),l=o.four+(s.four-o.four)*c,u=e*r*(.25+.7*K);q+=u*.9,Jt=.42*Math.sin(q*.37)+.2,Yt=Qt*.6,Xt+=u*.8,Zt+=u*.45;let d=Math.cos(q),f=Math.sin(q),p=Math.cos(Jt),m=Math.sin(Jt),g=Math.cos(Yt),_=Math.sin(Yt),v=Math.cos(Xt),y=Math.sin(Xt),b=Math.cos(Zt),S=Math.sin(Zt),C=1.15*n*(1+.1*G+.04*Lt);for(let e=0;e<h;e++){let t=e*4,n=o.pts[t]+(s.pts[t]-o.pts[t])*c,r=o.pts[t+1]+(s.pts[t+1]-o.pts[t+1])*c,i=o.pts[t+2]+(s.pts[t+2]-o.pts[t+2])*c,a=o.pts[t+3]+(s.pts[t+3]-o.pts[t+3])*c;if(l>0){let e=n*v-a*y,t=n*y+a*v,o=i*b-t*S,s=i*S+t*b,c=1.5/(2.2-s);n+=(e*c-n)*l,i+=(o*c-i)*l,r+=(r*c-r)*l,a=s}let u=n*d+i*f,h=-n*f+i*d,x=r*p-h*m,w=r*m+h*p,ee=u*g-x*_,te=u*_+x*g,ne=2.6/(3-w);Y[e*3]=ee*ne*C,Y[e*3+1]=te*ne*C,Y[e*3+2]=w}let w=.032*t*(.3+.8*Math.min(1,K*2)),ee=0;for(let e=0;e<h;e++){let t=(e+1)%h;ee+=Math.hypot(Y[t*3]-Y[e*3],Y[t*3+1]-Y[e*3+1])}let te=i*.75*(ee/h),ne=0,re=0,ie=0,T=0,ae=0;for(let e=0;e<=h;e++){let t=e%h,n=(t+h-1)%h,r=(t+1)%h,i=Y[r*3]-Y[n*3],a=Y[r*3+1]-Y[n*3+1],o=Math.hypot(i,a),s=ot[648+t]*w,c=Y[t*3]+(o>1e-5?-a/o*s:0),l=Y[t*3+1]+(o>1e-5?i/o*s:0),u=Y[t*3+2];e===0?(ne=c,re=l):e===h?F(ie,T,ne,re,te*(.62+.3*(u+ae)*.5)):F(ie,T,c,l,te*(.62+.3*(u+ae)*.5)),ie=c,T=l,ae=u}Q=[{name:`CH1`,y:0,vdiv:.25/w/4},{name:`CH2`,y:0,vdiv:.25/w/4}],$=`X-Y`,Z=`VECTOR  ${c<.5?o.label:s.label}`}function yn(e,t,n,r,i,a){let o=e.spectrum({fftSize:1024,smoothing:.6}),s=1-Math.exp(-t/.1);for(let e=0;e<40;e++){let t=Math.floor(2*150**(e/40)),r=Math.max(t+1,Math.floor(2*150**((e+1)/40))),i=0;for(let e=t;e<r;e++)i+=o[e];let a=Math.min(1.4,i/(r-t)/255*(1+e/50)*n);on[e]=a>on[e]?a:on[e]+(a-on[e])*s}q+=t*i*(.3+.8*K);let c=.4+.15*Math.sin(q*.31),l=Math.cos(q),u=Math.sin(q),d=Math.cos(c),f=Math.sin(c),p=Math.cos(Qt*.5),m=Math.sin(Qt*.5),h=.62*r*(1+.08*G),g=(e,t,n,r,i)=>{let a=e[t*3]*n,o=e[t*3+1]*n,s=e[t*3+2]*n,c=a*l+s*u,h=-a*u+s*l,g=o*d-h*f,_=o*f+h*d,v=c*p-g*m,y=c*m+g*p,b=2.6/(3-_),x=1+1.3*Math.abs(_+.15)*i,S=.45+.55*Math.max(0,Math.min(1,(_/Math.max(n,.01)+1)*.5));at(v*b,y*b,r*S/x,tt*x*.8)};for(let e=0;e<ce;e++){let t=Math.abs(rn[e*3+1]),n=Math.min(39,Math.floor(t*39.99)),r=zt>.25&&(e*7919+Math.floor(kt*30))%13==0?1.8:1;g(rn,e,h*(1+.42*on[n]),a*.38*r,1)}let _=h*.3*(1+.3*Lt+.15*G);for(let e=0;e<le;e++)g(an,e,_,a*.42,.4);Q=[{name:`CH1`,y:0,vdiv:.1},{name:`CH2`,y:0,vdiv:.1}],$=`X-Y  Z-AXIS`,Z=`DOTS  SPECTRUM SPHERE`}function bn(n,r,i,a,o){let s=(e,t)=>{for(let n=0;n<e&&sn<E;n++){let e=sn++,n=.28+.4*Vt,r=Math.PI/2+(Math.random()-.5)*2*n*(Math.random()<.8?.5:1),i=(.7+1.5*Math.random()**.7)*(.75+.45*t)*Math.sqrt(a)*N;X.x[e]=X.px[e]=(Math.random()-.5)*.16,X.y[e]=X.py[e]=-N*1.02,X.vx[e]=Math.cos(r)*i,X.vy[e]=Math.sin(r)*i,X.max[e]=X.life[e]=1.2+1.6*Math.random(),X.sig[e]=.8+2.6*Math.random()**3,X.br[e]=.35+.55*Math.random()}};cn+=r*(12+150*K)*i;let c=Math.floor(cn);cn-=c,s(c,Bt),t(n)&&s(Math.round(90*e(n)*i),.6+Bt);let l=1.25*N,u=Math.exp(-r*.55);for(let e=0;e<sn;e++){if(X.life[e]-=r,X.life[e]<=0||X.y[e]<-N*1.3){let t=--sn;for(let n of Object.values(X))n[e]=n[t];e--;continue}X.px[e]=X.x[e],X.py[e]=X.y[e],X.vy[e]-=l*r,X.vx[e]*=u,X.vy[e]*=u,X.x[e]+=X.vx[e]*r,X.y[e]+=X.vy[e]*r;let t=X.life[e]/X.max[e],n=zt>.2?.55+.9*Math.random():1,i=tt*X.sig[e]*1.3,a=o*X.br[e]*Math.min(1,t*3)*n/X.sig[e];F(X.px[e],X.py[e],X.x[e],X.y[e],a*i*ue,i)}Q=[{name:`CH1`,y:0,vdiv:.2}],$=`X-Y  Z-AXIS`,Z=`DOTS  PHOSPHOR SPARKS`}function xn(e,t,n,r,i){let a=Nt;for(;a>1&&a*R>I*.45;)a--;let o=Math.max(64,Math.min(921,Math.round(a*R))),s=Ct(o);q+=e*r*(.15+.5*K);let c=.6*n*(1+.08*G),l=.3*t;for(let e=0;e<3;e++){let t=s-e*o;if(t<0)break;let n=c*(1-.24*e),r=i*.55**e,a=Math.ceil(t),u=0,d=0;for(let t=0;t<=o;t++){let i=Math.min(2047,a+t%o),s=L[i]*1.3+(lt[i]-L[i])*.5,c=q*(e%2?-1:1)+g*t/o,f=Math.max(0,n+s*l*(1-.2*e)),p=Math.cos(c)*f,m=Math.sin(c)*f;t&&F(u,d,p,m,r*(g*n/o)),u=p,d=m}}Q=[{name:`CH1`,y:0,vdiv:.25/l}],$=`POLAR  ${a}×T`,Z=`POLAR  Z-MOD`}let Sn=0;function Cn(e,t){if(e<Sn&&Xe)return;Sn=e+.25;let n=t.beat.confidence>=.3&&t.beat.bpm>0?`${t.beat.bpm.toFixed(1)} BPM`:`---.- BPM`,r=V===C||V===re?t.silent?`READY`:vt?`TRIG'D`:`AUTO`:`XY`,i=e=>e>=1?`${e.toFixed(2)}V`:`${Math.round(e*1e3)}mV`,a=[n,r,Z,$,A,j,...Q.map(e=>`${e.name}${i(e.vdiv)}${e.y.toFixed(2)}`)].join(`|`);if(a===Xe)return;Xe=a;let o=k.width,s=k.height,c=e=>(e/Le*.5+.5)*o,l=e=>(.5-e*.5)*s,u=Ie;u.setTransform(1,0,0,1,0,0),u.clearRect(0,0,o,s);let d=N*M,f=-Ve*M,p=(Be-d)*s*.5,m=Math.max(9,Math.min(p*.34,17*Re));u.font=`400 ${m}px ui-monospace, "Cascadia Mono", Consolas, monospace`,u.fillStyle=`#fff`,u.textBaseline=`middle`;let h=l((Be+d)*.5),g=l(-(Be+d)*.5),_=c(f),v=c(-f);u.textAlign=`left`,u.fillText(Q.map(e=>`${e.name} ${i(e.vdiv)}`).join(`   `),_,h),u.fillText(`${$}`,_,g),u.textAlign=`right`,u.fillText(r,v,h),u.fillText(n,v,g),u.textAlign=`center`,u.fillText(Z,(_+v)/2,g),V===C&&Q.forEach((e,t)=>{let n=l(e.y*M),r=_-m*.35;u.beginPath(),u.moveTo(r,n),u.lineTo(r-m*.55,n-m*.38),u.lineTo(r-m*.55,n+m*.38),u.closePath(),u.fill(),u.textAlign=`right`,u.fillText(String(t+1),r-m*.7,n)}),y.queue.copyExternalImageToTexture({source:k},{texture:Ge,premultipliedAlpha:!0},[o,s])}function wn(e,t,n,r){let i=Me,a=un(),o=S[V].persist*(r?1.5:1);i.set([A,j,Le,M*j*.5],0),i.set([ze,Be,.09,.045],4),i.set([M,Ve,N,e],8),i.set([Math.exp(-n/.03),Math.exp(-n/o),.85,nn],12),i.set([...p(a.fast,t),1.5*(1+.25*It)],16),i.set([...p(a.slow,t),1.3+.5*Math.min(1,Bt)+.5*It],20),i.set([...p(a.grat,t),.16],24),i.set([.6,.5,.012,0],28),y.queue.writeBuffer(Ne,0,i)}return{resize(e,t,n){ge?ge.resize?.(e,t,n):Qe(e,t,n)},frame({audio:e,settings:t,dt:n,time:r}){if(he||ge)return;let i=t.sensitivity,a=t.scale,o=t.speed;hn(e,i,n,r,o),St(e,n),kt+=n,xt+=n,J=Math.min(1,J),W=Math.min(1,W+n/.9),B<0&&kt>32/Math.max(.3,o)&&pn(e,r);let s=e.silent||e.beat.confidence<.3||K<.16;$e=0,et=0,Mt=Math.max(0,Mt-n/.08),nt=1-Mt,tt=(.0042+.0035*Rt)*Math.max(.8,Math.min(1.6,a));let c=.0035*Math.max(0,zt-.15);rt=(Math.random()-.5)*c,it=(Math.random()-.5)*c;let l=(.9+.85*G+.35*It)*(e.silent?.6:1);switch(V){case C:gn(i,a,l,ht);break;case w:_n(i,a,l);break;case ee:vn(n,i,a,o,l);break;case te:yn(e,n,i,a,o,l);break;case ne:bn(e,n,i,a,l);break;default:xn(n,i,a,o,l)}nn+=(Math.min(.06,et*.004)-nn)*(1-Math.exp(-n/.1)),Cn(r,e),wn(r,t.hueShift,n,s),$e&&y.queue.writeBuffer(Pe,0,O,0,$e*8);let u=y.createCommandEncoder(),d=u.beginRenderPass({colorAttachments:[{view:Ue.createView(),loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,0]}]});$e&&(d.setPipeline(Te),d.setBindGroup(0,Fe),d.draw(6,$e)),d.end();let f=(e,t,n)=>{let r=u.beginRenderPass({colorAttachments:[{view:e,loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,1]}]});r.setPipeline(t),r.setBindGroup(0,n),r.draw(3),r.end()},p=1-Ze;f(We[p].createView(),Ee,P.phos[p]),f(Ke.createView(),De,P.down1[p]),f(qe.createView(),Oe,P.blurH1),f(Ke.createView(),ke,P.blurV1),f(Je.createView(),De,P.down2),f(Ye.createView(),Oe,P.blurH2),f(Je.createView(),ke,P.blurV2),f(pe.getCurrentTexture().createView(),Ae,P.final[p]),y.queue.submit([u.finish()]),Ze=p},dispose(){he=!0,ge?.dispose();for(let e of He)e.destroy();Ne.destroy(),Pe.destroy(),pe.unconfigure(),y.destroy(),b.remove()}}};export{pe as default};
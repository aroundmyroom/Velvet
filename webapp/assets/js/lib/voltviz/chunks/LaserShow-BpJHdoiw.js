import{H as e,N as t,W as n,ct as r,d as i,et as a,n as o,r as s,t as c,tt as l,ut as u}from"./three-_gmPQh3Y.js";import{i as ee,r as te}from"./audio-Ds-N7sX7.js";var d=24,f=48,p=3,m=6,ne=4.5,h=0,g=1,_=2,v=[`#ff1f7a`,`#9160ff`,`#4775ff`],re=`#2b58ff`,y=`#110b22`,b=`#240d2a`,ie=[{a:106.9,c:_,i:.9},{a:96.5,c:h,i:.55},{a:127,c:h,i:.9},{a:130.5,c:h,i:.7},{a:12.5,c:g,i:.85},{a:6,c:h,i:.45},{a:2.8,c:g,i:.55},{a:172,c:g,i:.6},{a:181.5,c:h,i:1.25},{a:190.5,c:g,i:.75},{a:201,c:g,i:.7},{a:210,c:_,i:.8},{a:226,c:h,i:.65},{a:243.5,c:h,i:1},{a:252,c:_,i:.9},{a:263,c:g,i:.6},{a:282.7,c:_,i:.9},{a:291,c:g,i:.6},{a:304,c:h,i:.95},{a:318,c:h,i:.9},{a:331,c:h,i:.75},{a:344,c:h,i:.85},{a:351.5,c:g,i:.8},{a:355,c:h,i:.6}],x=[1,4],ae=`void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,S=`
  #define BEAMS ${f}
  #define FANS ${m}
  uniform vec2 uResolution;   // device pixels
  uniform vec4 uEmit;         // left xy, right xy (device pixels, y up)
  uniform vec4 uBeam[BEAMS];  // dir.xy, intensity, emitter (0 | 1)
  uniform vec3 uBeamCol[BEAMS];
  uniform vec4 uFan[FANS];    // dir.xy, half width (rad), intensity
  uniform vec3 uFanCol;
  uniform vec3 uBgTop;
  uniform vec3 uBgBottom;
  uniform float uUnit;        // device pixels per reference pixel (reference = 1250 px tall)
  uniform float uGlow;        // halo gain (bass, mids)
  uniform float uCore;        // white in the beam cores (highs)
  uniform float uFog;         // fog brightness (level)
  uniform float uFlare;       // emitter flare (beat)
  uniform float uDrift;       // fog drift phase
  uniform float uSeed;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  // lattice hash on small, wrapped coordinates: a hash of large values differs between the
  // neighbouring cells sharing a corner on some GPUs (FMA / rounding), which shows as seams
  float lattice(vec2 i) {
    vec3 p3 = fract(vec3(mod(i, 289.0).xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(lattice(i), lattice(i + vec2(1.0, 0.0)), u.x),
               mix(lattice(i + vec2(0.0, 1.0)), lattice(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.03 + 17.1; a *= 0.5; }
    return v;
  }
  // coarse fbm for the domain warp (the fine octaves would be smeared away anyway)
  float fbm3(vec2 p) {
    return 0.5 * noise(p) + 0.25 * noise(p * 2.03 + 17.1) + 0.125 * noise(p * 4.1 - 9.3) + 0.0625;
  }

  void main() {
    vec2 p = gl_FragCoord.xy;
    float u = uUnit;
    float lw = max(u, 0.75);  // never thinner than a device pixel can antialias

    // drifting smoke, domain-warped (shared by the fans, the beam haze and the room)
    vec2 q = p / (330.0 * u);
    vec2 w = vec2(fbm3(q + vec2(uDrift * 0.6, 3.1)), fbm3(q + vec2(5.2, -uDrift * 0.4)));
    float smoke = fbm(q * 1.3 + w * 1.6 + vec2(uDrift * 0.25, uDrift * 0.1));
    float fog = smoothstep(0.25, 0.85, smoke);

    vec3 col = vec3(0.0);
    vec3 room = vec3(0.0);

    // thin beams
    for (int i = 0; i < BEAMS; i++) {
      vec4 b = uBeam[i];
      if (b.z <= 0.001) continue;
      vec2 e = b.w < 0.5 ? uEmit.xy : uEmit.zw;
      vec2 v = p - e;
      float t = dot(v, b.xy);
      float d = abs(v.x * b.y - v.y * b.x);
      float front = smoothstep(-1.5 * lw, 3.0 * lw, t);
      float fade = 0.6 + 0.4 * exp(-t / (1400.0 * u));
      float k = b.z * front * fade;
      room += k * uBeamCol[i] * exp(-d / (260.0 * u));
      if (d > 110.0 * u || k <= 0.0) continue;  // far from this beam: nothing visible left to add
      // halos and haze open up over the first ~80 px, so the converging beams keep the emitter a point
      float open = 0.2 + 0.8 * smoothstep(0.0, 80.0 * u, t);
      float halo = (exp(-d / (3.5 * u)) * 0.9 + exp(-d / (12.0 * u)) * 0.35) * open;
      float core = exp(-(d * d) / (lw * lw * 2.2)) * (0.45 + 0.55 * open);
      float haze = exp(-d / (34.0 * u)) * (0.35 + 0.9 * fog) * open;
      col += k * (uBeamCol[i] * (core * 1.6 + halo * uGlow + haze * 0.07) + vec3(core * uCore));
    }

    // smoky sheet fans
    for (int i = 0; i < FANS; i++) {
      vec4 f = uFan[i];
      if (f.w <= 0.001) continue;
      vec2 e = i < FANS / 2 ? uEmit.xy : uEmit.zw;
      vec2 v = p - e;
      float t = dot(v, f.xy);
      float s = v.x * f.y - v.y * f.x;
      float r = length(v);
      float da = abs(atan(s, t));
      float hw = f.z;
      float inside = smoothstep(hw, hw * 0.82, da) * smoothstep(0.0, 6.0 * u, t);
      float edgeD = r * abs(da - hw);
      float edge = exp(-edgeD * edgeD / (lw * lw * 4.0)) * 1.0 + exp(-edgeD / (6.0 * u)) * 0.45;
      edge *= smoothstep(0.0, 6.0 * u, t) * step(da, hw * 1.6);
      float body = inside * (0.75 + 1.2 * fog) * (0.65 + 0.35 * smoothstep(0.0, hw, da));
      float near = 0.7 + 0.3 * exp(-r / (900.0 * u));
      col += f.w * near * (uFanCol * (body * 1.8 + edge * 1.5) + vec3(edge * 0.4));
      room += f.w * uFanCol * inside * 0.6;
    }

    // emitter flares
    for (int i = 0; i < 2; i++) {
      vec2 v = p - (i == 0 ? uEmit.xy : uEmit.zw);
      float r = length(v);
      float dot0 = exp(-r / (1.1 * u)) * 1.0 + exp(-r / (8.0 * u)) * 0.06;
      float star = exp(-abs(v.y) / (0.9 * lw)) * exp(-abs(v.x) / (26.0 * u))
                 + exp(-abs(v.x) / (0.9 * lw)) * exp(-abs(v.y) / (18.0 * u));
      col += uFlare * (vec3(1.0, 0.75, 0.95) * dot0 + vec3(0.9, 0.6, 1.0) * star * 0.12);
    }

    // the room: gradient, fog lit by the beams, vignette
    float y = gl_FragCoord.y / uResolution.y;
    vec3 bg = mix(uBgBottom, uBgTop, smoothstep(0.05, 0.95, y));
    bg *= 0.75 + 0.5 * fog;
    bg += room * (0.007 + 0.016 * fog) * uFog;
    vec2 c = gl_FragCoord.xy / uResolution - 0.5;
    float vig = 1.0 - 0.45 * dot(c, c);

    vec3 hdr = col;
    vec3 outc = bg * vig + (1.0 - exp(-hdr * 1.1));
    outc += (hash(gl_FragCoord.xy + uSeed) - 0.5) / 255.0;
    gl_FragColor = vec4(outc, 1.0);
  }
`,C=Math.PI/180,oe=e=>(e%360+540)%360-180,w=({container:h,width:g,height:_,dpr:w})=>{let T=c(h,g,_,w,{antialias:!1}),E=new a,se=new e(-1,1,1,-1,0,1),D={uResolution:{value:new r(g*w,_*w)},uEmit:{value:new u},uBeam:{value:Array.from({length:f},()=>new u)},uBeamCol:{value:Array.from({length:f},()=>new i)},uFan:{value:Array.from({length:m},()=>new u)},uFanCol:{value:new i},uBgTop:{value:new i},uBgBottom:{value:new i},uUnit:{value:1},uGlow:{value:1},uCore:{value:.18},uFog:{value:1},uFlare:{value:1},uDrift:{value:0},uSeed:{value:0}},O=new l({uniforms:D,vertexShader:ae,fragmentShader:S,depthTest:!1,depthWrite:!1}),k=new t(new n(2,2),O);k.frustumCulled=!1,E.add(k);let A=e=>new i().setStyle(e,``),ce=v.map(A),le=A(re),ue=A(y),de=A(b),j=v.map(()=>new i),fe=NaN,pe=e=>{if(e===fe)return;fe=e;let t=e/360;ce.forEach((e,n)=>j[n].copy(e).offsetHSL(t,0,0)),D.uFanCol.value.copy(le).offsetHSL(t,0,0),D.uBgTop.value.copy(ue).offsetHSL(t,0,0),D.uBgBottom.value.copy(de).offsetHSL(t,0,0)},M=ie.map(e=>e.a),me=new Float64Array(d),N=0,P=0,F=0,he=0,I=0,ge=0,_e=0,L=0,R=0,z=0,B=0,V=1,H=0,U=0,W=0,G=0,K=0,q=0,ve=0,J=0,Y=0,X=Array.from({length:p},(e,t)=>({k:x[t]??-1,w:+(t<x.length),on:t<x.length,since:t})),Z=null,ye=p,be=0,Q=0,xe=()=>{if(Z)return;let e=X.findIndex(e=>!e.on&&e.w===0),t=X.filter(e=>e.on);if(e<0||!t.length)return;let n=X.indexOf(t.reduce((e,t)=>t.since<e.since?t:e)),r=X.filter(e=>e.k>=0).map(e=>e.k),i=Array.from({length:d},(e,t)=>t).filter(e=>!r.includes(e)),a=i.filter(e=>r.every(t=>Math.abs(oe(M[e]-M[t]))>=25)),o=a.length?a:i;Object.assign(X[e],{k:o[Math.floor(Math.random()*o.length)],on:!0,since:ye++}),Z={from:n,to:e},Q=0},$=new Float64Array(d),Se=[0,1],Ce=[2,3],we=()=>q>.02?1:q<-.02?-1:0,Te=()=>{let e=we(),t=(e>0?Ce:e<0?Se:[0,1,2,3]).filter(e=>e!==N);return t[Math.floor(Math.random()*t.length)]},Ee=e=>{let t=we();return t===0||(t>0?Ce:Se).includes(e)},De=(e,t,n)=>{let r=.3*Math.min(1.25,.85+.15*n);return{lx:e*(.5-r),rx:e*(.5+r),y:t*.5}};return{resize(e,t,n){T.setPixelRatio(n),T.setSize(e,t),D.uResolution.value.set(e*n,t*n)},frame({audio:e,settings:t,dt:n,width:r,height:i,dpr:a}){let o=t.sensitivity,s=Math.min(1,e.bands.bass*o);L+=(s-L)*Math.min(1,n*8);let c=Math.min(1,e.level.rms*2.5*o),l=e.bands,u=(.4*l.lowMid+.6*l.mid)*o,f=(.6*l.highMid+.4*l.treble)*o,m=Math.min(1,n*6),h=Math.min(1,n/4);U+=(u-U)*m,W+=(f-W)*m,G+=(U-G)*h,K+=(W-K)*h,q+=(W-.7*U+.04-q)*h;let g=Math.max(0,Math.min(1,(U-.58)/.25+3*(U-G))),_=Math.max(0,Math.min(1,(W-.3)/.3+3*(W-K)));R+=(.85+.55*L+.35*g-R)*Math.min(1,n*10);let v=!e.silent&&e.beat.confidence>=.3;if(F=v?0:F+n,F>3&&N!==0&&(N=0,P=0),te(e)){let t=ee(e);z=Math.max(z,t),B=t,V=-V,Y+=.08+.1*_,t>=.5&&++be%4==0&&xe(),t>=.5&&++P%8==0&&(P%16==0||!Ee(N))&&(N=Te(),P=0)}if(e.onsets.hat.hit){let e=2+Math.round(4*_);for(let t=0;t<e;t++){let e=Math.floor(Math.random()*d);$[e]=Math.max($[e],.5+.5*_)}}let re=Math.exp(-n/.09);for(let e=0;e<d;e++)$[e]*=re;z*=Math.exp(-n/.15),B*=Math.exp(-n/.2),Q+=n,!e.silent&&Q>(v?8:4)&&xe();let y=n/.35;for(let e of X)e.w=e.on?Math.min(1,e.w+y):Math.max(0,e.w-y);if(Z){let e=X[Z.from];e.on&&X[Z.to].w>=1&&(e.on=!1),!e.on&&e.w===0&&(e.k=-1,Z=null)}H=Math.max(H*Math.exp(-n/.15),e.onsets.snare.envelope);let b=t.speed*(.3+L);he+=n*b*.9,I+=n*b*1.4,ge+=n*b*.7,_e+=n*t.speed*(.06+.1*c),ve+=n*t.speed*(1.2+2.5*g),Y+=n*t.speed*.05,J+=(Y-J)*Math.min(1,n/.06);let{lx:x,rx:ae,y:S}=De(r,i,t.scale);for(let e=0;e<d;e++){let t;if(N===1)t=e<16?20+55*Math.sin(I*.8)+(e/15-.5)*(60+40*L+50*g):180+((e-16)/7-.5)*50+18*Math.sin(I*1.1+1);else if(N===2){let n=Math.min(r,i)*(.28+.06*Math.sin(I*.5)),a=e/d*Math.PI*2+ge;t=Math.atan2(i*.5+n*Math.sin(a)-S,r*.5+n*Math.cos(a)-x)/C}else t=N===3?e<18?(e/17-.5)*(34+22*g)+24*Math.sin(I*.9):180+(e-20.5)*9-12*Math.sin(I*.9):ie[e].a+2.5*Math.sin(he+e*.9)*(e%2?1:-1);t+=g*3.5*Math.sin(ve-e*.55),me[e]=t+B*3.5*V*(e%2?1:-1)}let w=1-Math.exp(-n/.13);for(let e=0;e<d;e++)M[e]+=oe(me[e]-M[e])*w;pe(t.hueShift);let O=Math.min(1,e.onsets.kick.envelope*o),k=Math.min(1,Math.max(z*o,O*.7)),A=.6+1*k,ce=J%1;for(let e=0;e<d;e++){let t=ie[e],n=((M[e]/360-ce)%1+1.5)%1-.5,r=Math.exp(-(n*n)/.006),i=1-.45*_+1.3*_*r,a=t.i*A*i*(1+.5*$[e]),o=M[e]*C,s=Math.cos(o),c=Math.sin(o);D.uBeam.value[e].set(s,c,a,0),D.uBeam.value[e+d].set(-s,c,a,1),D.uBeamCol.value[e].copy(j[t.c]),D.uBeamCol.value[e+d].copy(j[t.c])}let le=.6+.1*c+.45*O+.3*k+.15*g,ue=ne*(.9+.2*g)+.5*Math.min(1,H*o);X.forEach((e,t)=>{let n=e.w*e.w*(3-2*e.w);if(e.k<0||n<=0){D.uFan.value[t].w=0,D.uFan.value[t+p].w=0;return}let r=(.4+(ue-.4)*n)*C,i=le*Math.sqrt(n),a=M[e.k]*C;D.uFan.value[t].set(Math.cos(a),Math.sin(a),r,i),D.uFan.value[t+p].set(-Math.cos(a),Math.sin(a),r,i)}),D.uResolution.value.set(r*a,i*a),D.uEmit.value.set(x*a,S*a,ae*a,S*a),D.uUnit.value=i*a/1250*(.75+.25*t.scale),D.uGlow.value=R*(1-.25*_),D.uCore.value=.18+.45*_,D.uFog.value=.7+.8*c,D.uFlare.value=.85+.6*k,D.uDrift.value=_e,D.uSeed.value=(D.uSeed.value+.618)%64,T.render(E,se)},dispose(){o(E),s(T)}}};export{w as default};
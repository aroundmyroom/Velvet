import{$ as e,C as t,D as n,H as r,M as i,N as a,S as ee,T as te,U as ne,V as re,_ as o,a as ie,ct as s,d as c,et as ae,lt as l,n as u,q as d,r as oe,st as se,t as ce,ut as le,v as ue}from"./three-DIyfzUHm.js";import{i as de,r as fe}from"./audio-Ds-N7sX7.js";var pe=[[{p:[0,0,0],s:[.5,2.6,.5]}],[{p:[0,0,0],s:[.42,2.2,.42]},{p:[0,1.2,0],s:[.8,.22,.6]},{p:[0,-1.2,0],s:[.8,.22,.6]}],[{p:[-.32,0,0],s:[.38,2.4,.5]},{p:[.32,.25,0],s:[.38,2,.5]}],[{p:[-.42,0,0],s:[.36,1.5,.55],rz:-32},{p:[.42,0,0],s:[.36,1.5,.55],rz:32}],[{p:[0,0,0],s:[.46,1.9,.5]},{p:[.5,.75,0],s:[1,.4,.5]}],[{p:[0,0,0],s:[1.1,.5,1]},{p:[0,.42,0],s:[.75,.38,.7]},{p:[0,.75,0],s:[.4,.3,.4]}],[{p:[0,-.2,0],s:[.32,1.8,.36]},{p:[-.28,.65,0],s:[.26,.9,.36],rz:-42},{p:[.28,.65,0],s:[.26,.9,.36],rz:42}],[{p:[0,-.62,0],s:[1.45,.3,.45]},{p:[-.58,.05,0],s:[.3,1.4,.45]},{p:[.58,.05,0],s:[.3,1.4,.45]}],[{p:[0,0,0],s:[1,1,1]},{p:[.52,.52,.25],s:[.4,.4,.4]}],[{p:[0,0,0],s:[.62,.62,1.7],rz:45}],[{p:[0,0,0],s:[1.6,.34,.8]},{p:[.3,.3,0],s:[.3,.5,.8],ry:0}]],me=20,he=60,ge=9,f=[.3,.5,1,1.6,1.6,.7,.2,.04,0],_e=[2,4,2,6,4],p=[{dark:`#001458`,main:`#0a62d0`,mid:`#868ee8`,lit:`#eeb6fb`,hot:`#fff0ff`,edge:`#fff0ff`,near:`#ffc4ff`,far:`#3a8cff`},{dark:`#2b0038`,main:`#c3168f`,mid:`#9a5cf0`,lit:`#5ff4ff`,hot:`#e6ffff`,edge:`#f0ffff`,near:`#9ef8ff`,far:`#ff3fae`},{dark:`#1c0045`,main:`#6a25ff`,mid:`#c040e8`,lit:`#ff5fb4`,hot:`#ffe2f2`,edge:`#ffeaf6`,near:`#ff8ccc`,far:`#8f4dff`},{dark:`#00241c`,main:`#00a884`,mid:`#7ee05a`,lit:`#e2ff3a`,hot:`#f4ffa0`,edge:`#f8ffd8`,near:`#f2ff8a`,far:`#10ffb0`},{dark:`#2e0c00`,main:`#e05000`,mid:`#ff8a30`,lit:`#ffc04a`,hot:`#ffe0a0`,edge:`#c8ffff`,near:`#6cf6ff`,far:`#ff5a10`},{dark:`#002033`,main:`#009fd6`,mid:`#b45adc`,lit:`#ff3d94`,hot:`#ffc0de`,edge:`#f0ffff`,near:`#ff86c4`,far:`#00c4ff`}],m=Object.keys(p[0]),ve=1.2,ye=`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,be=`
  attribute float aTone;
  varying vec3 vLocal;
  varying vec3 vSize;
  varying vec3 vNLocal;
  varying vec3 vNView;
  varying vec3 vView;
  varying float vTone;
  void main() {
    vLocal = position;
    vNLocal = normal;
    vTone = aTone;
    vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    mat4 mv = modelViewMatrix * instanceMatrix;
    // box normals lie along the scaled axes, so the plain matrix keeps their direction
    vNView = normalize(mat3(mv) * normal);
    vec4 vp = mv * vec4(position, 1.0);
    vView = vp.xyz;
    gl_Position = projectionMatrix * vp;
  }
`,xe=`
  uniform vec3 uDark;
  uniform vec3 uMain;
  uniform vec3 uMid;
  uniform vec3 uLit;
  uniform vec3 uHot;
  uniform vec3 uEdgeCol;
  uniform vec3 uKeyDir;
  uniform vec3 uFillDir;
  uniform float uKey;     // key light strength
  uniform float uEdge;    // edge line brightness
  uniform float uLine;    // edge line half width, device pixels
  uniform float uRim;     // inner rim glow width, device pixels
  uniform float uNear;    // camera distance of the cluster centre
  varying vec3 vLocal;
  varying vec3 vSize;
  varying vec3 vNLocal;
  varying vec3 vNView;
  varying vec3 vView;
  varying float vTone;

  void main() {
    vec3 n = normalize(vNView);
    if (!gl_FrontFacing) n = -n;

    // distance to the face's border, per tangent axis, in device pixels
    // (the pixel scale comes from the linear position: fwidth(abs(x)) collapses at a face's centre
    // line, which would dot it with pixels that lose the rim light)
    vec3 d = (0.5 - abs(vLocal)) * vSize + abs(vNLocal) * 1e4;
    vec3 px3 = d / max(fwidth(vLocal * vSize), vec3(1e-5));
    float px = min(px3.x, min(px3.y, px3.z));
    float line = 1.0 - smoothstep(uLine - 0.7, uLine + 0.7, px);
    float rim = exp(-px / uRim);

    // flat lighting: dark body, main-colour fill, a key light that whitens when hot
    float key = max(dot(n, uKeyDir), 0.0);
    float fill = max(dot(n, uFillDir), 0.0);
    float facing = max(n.z, 0.0);
    vec3 col = uDark * (0.3 + 0.9 * facing);
    col = mix(col, uMain, pow(fill, 1.5) * (0.35 + 0.6 * facing));
    // faces are either lit or main-coloured: a sharp ramp keeps the mix from turning muddy
    float pk = smoothstep(0.35, 0.85, key * uKey * (0.6 + 0.7 * vTone));
    // a gradient across every face (bounce light) so flat faces are not dead flat
    float g = clamp(0.5 + dot(vLocal, vec3(-0.7, 0.9, 0.5)), 0.0, 1.0);
    col *= 0.3 + 1.0 * g;
    // half-lit faces pass through the palette's bright mid colour instead of a dull mix
    col = mix(col, uMid * (0.8 + 0.3 * g), smoothstep(0.0, 0.5, pk));
    col = mix(col, uLit * (0.85 + 0.3 * g), smoothstep(0.5, 1.0, pk));
    col = mix(col, uHot, pk * smoothstep(0.55, 1.0, key * uKey) * 0.85);
    // neon: the edges bleed light into the faces
    col += (uLit * (0.35 + 0.6 * pk) + uMain * 0.2) * rim * 0.6;
    // far blocks sink into the dark
    float depth = clamp((-vView.z - uNear) / 6.0, -1.0, 1.0);
    col *= 1.0 - 0.35 * max(depth, 0.0);
    col = mix(col, uEdgeCol * uEdge, line);
    gl_FragColor = vec4(col, 1.0);
  }
`,Se=`
  uniform sampler2D tScene; // the upper right quadrant of the screen (plus a small margin)
  uniform vec2 uCenter;      // mirror centre, on a whole pixel so the mirrored copies stay pixel-exact
  uniform vec4 uQuad;        // quadrant target: xy = its origin relative to the centre, zw = its size
  uniform float uSeg;        // wedge angle (PI / symmetry)
  varying vec2 vUv;
  void main() {
    vec2 p = gl_FragCoord.xy - uCenter;
    float r = length(p);
    float a = mod(atan(p.y, p.x), 2.0 * uSeg);
    a = uSeg - abs(a - uSeg);
    vec2 uv = (r * vec2(cos(a), sin(a)) - uQuad.xy) / uQuad.zw;
    vec2 inside = step(uv, vec2(1.0));
    gl_FragColor = vec4(texture2D(tScene, uv).rgb * inside.x * inside.y, 1.0);
  }
`,Ce=`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;   // 1 / source size
  varying vec2 vUv;
  void main() {
    vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
    s += texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
    s += texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb;
    s += texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
    s += texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb;
    gl_FragColor = vec4(s / 8.0, 1.0);
  }
`,we=`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;   // 1 / source size
  uniform vec3 uTint;
  varying vec2 vUv;
  void main() {
    vec2 h = uTexel * 0.5;
    vec3 s = texture2D(tSrc, vUv + vec2(-2.0 * h.x, 0.0)).rgb;
    s += texture2D(tSrc, vUv + vec2(2.0 * h.x, 0.0)).rgb;
    s += texture2D(tSrc, vUv + vec2(0.0, -2.0 * h.y)).rgb;
    s += texture2D(tSrc, vUv + vec2(0.0, 2.0 * h.y)).rgb;
    s += texture2D(tSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
    s += texture2D(tSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
    s += texture2D(tSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
    s += texture2D(tSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
    gl_FragColor = vec4(s / 12.0 * uTint, 1.0);
  }
`,Te=`
  uniform sampler2D tImage;
  uniform sampler2D tGlow;
  uniform float uGlow;
  uniform vec3 uGlowTint;
  uniform float uFlash;
  uniform vec3 uFlashCol;
  uniform float uSeed;
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  // linear up to 0.75, then a soft shoulder to 1
  vec3 shoulder(vec3 c) {
    vec3 k = vec3(0.75);
    return mix(c, k + 0.25 * (1.0 - exp(-(c - k) / 0.25)), step(k, c));
  }
  void main() {
    vec3 img = texture2D(tImage, vUv).rgb;
    // the glow saturates softly (hue kept), so the gaps inside the snowflake fill with blue light
    // instead of burning out while the halo outside can still reach far
    vec3 glow = texture2D(tGlow, vUv).rgb * uGlowTint * uGlow;
    float gm = max(glow.r, max(glow.g, glow.b));
    glow *= gm > 1e-4 ? 0.8 * (1.0 - exp(-gm / 0.8)) / gm : 1.0;
    // an outer glow: it fills the dark around and between the blocks, lit faces keep their colour
    float lum = dot(img, vec3(0.3, 0.5, 0.2));
    vec3 c = img + glow * (1.0 - smoothstep(0.02, 0.3, lum));
    // a cut flashes the glow around the blocks, the dark stays dark
    c += uFlashCol * uFlash * 2.2 * dot(glow, vec3(0.33));
    // red / green that does not fit spills into the other channels (hot pink -> white); a hot blue
    // stays blue instead of turning cyan
    float over = max(max(c.r, c.g) - 1.0, 0.0);
    c = shoulder(c + over * 0.35);
    c += (hash(gl_FragCoord.xy + uSeed) - 0.5) / 255.0;
    gl_FragColor = vec4(c, 1.0);
  }
`,Ee=({container:Ee,width:De,height:h,dpr:Oe})=>{let g=ce(Ee,De,h,Oe,{antialias:!1});g.autoClear=!1;let _=Math.max(1,Math.round(De*Oe)),v=Math.max(1,Math.round(h*Oe)),y=new e,b=new r(32,De/h,2,30),x=new ee;y.add(x);let S={uDark:{value:new c},uMain:{value:new c},uMid:{value:new c},uLit:{value:new c},uHot:{value:new c},uEdgeCol:{value:new c},uKeyDir:{value:new s(-.55,.55,.62).normalize()},uFillDir:{value:new s(.45,-.3,.85).normalize()},uKey:{value:1},uEdge:{value:1},uLine:{value:1},uRim:{value:8},uNear:{value:14}},C=new ie(1,1,1),ke=new Float32Array(he);C.setAttribute(`aTone`,new te(ke,1));let Ae=new ae({uniforms:S,vertexShader:be,fragmentShader:xe,side:2}),w=new n(C,Ae,he);w.instanceMatrix.setUsage(o),w.frustumCulled=!1,x.add(w);let je={type:t,depthBuffer:!1},T=new le(1,1,{type:t,samples:4}),Me=new l,E=new se,Ne=()=>{E.set(Math.floor(_/2),Math.floor(v/2));let e=_-E.x+4,t=v-E.y+4;T.setSize(e,t),Me.set(-4,-4,e,t),b.setViewOffset(_,v,E.x-4,0,e,t)},D=new le(_,v,je),O=Array.from({length:ge},()=>new le(1,1,je)),Pe=()=>{let e=_,t=v;for(let n of O)e=Math.max(1,e>>1),t=Math.max(1,t>>1),n.setSize(e,t)};Pe(),Ne();let Fe=new e,Ie=new re(-1,1,1,-1,0,1),k=new a(new ne(2,2));k.frustumCulled=!1,Fe.add(k);let A=(e,t,n=!1)=>new ae({uniforms:t,vertexShader:ye,fragmentShader:e,depthTest:!1,depthWrite:!1,blending:n?2:0,transparent:n}),Le=A(Se,{tScene:{value:T.texture},uCenter:{value:E},uQuad:{value:Me},uSeg:{value:Math.PI/2}}),j=A(Ce,{tSrc:{value:null},uTexel:{value:new se}}),M=A(we,{tSrc:{value:null},uTexel:{value:new se},uTint:{value:new c}},!0),N=A(Te,{tImage:{value:D.texture},tGlow:{value:O[0].texture},uGlow:{value:1},uGlowTint:{value:new c},uFlash:{value:0},uFlashCol:{value:new c},uSeed:{value:0}}),P=(e,t)=>{k.material=e,g.setRenderTarget(t),g.render(Fe,Ie)},F=e=>Object.fromEntries(m.map(t=>[t,e(t)])),Re=p.map(e=>F(t=>new c().setStyle(e[t],``))),I=F(e=>Re[0][e].clone()),ze=F(()=>new c),L=F(()=>new c),Be=0,R=1,Ve=()=>{for(let e of m)ze[e].copy(I[e]);Be=(Be+1+Math.floor(Math.random()*(p.length-1)))%p.length,R=0},He=e=>{let t=Math.max(0,Math.log2(2**(e+1)*600/v)-1),n=Math.min(f.length-2,Math.floor(t)),r=Math.min(1,t-n);return f[n]+(f[n+1]-f[n])*r},z=Array.from({length:ge},()=>new c),Ue=Array.from({length:8},()=>new c),B=NaN,We=(e,t)=>{let n=R<1;if(!n&&e===B)return;if(B=e,n){R=Math.min(1,R+t/ve);let e=R*R*(3-2*R);for(let t of m)I[t].copy(ze[t]).lerp(Re[Be][t],e)}let r=e/360;for(let e of m)L[e].copy(I[e]).offsetHSL(r,0,0);S.uDark.value.copy(L.dark),S.uMain.value.copy(L.main),S.uMid.value.copy(L.mid),S.uLit.value.copy(L.lit),S.uHot.value.copy(L.hot),S.uEdgeCol.value.copy(L.edge),N.uniforms.uFlashCol.value.copy(L.near);let{near:i,far:a}=L;z.forEach((e,t)=>{let n=Math.log2(2**(t+1)*600/v);e.copy(i).lerp(a,Math.min(1,Math.max(0,(n-1)/3))),e.multiplyScalar(Math.max(.001,He(t))/Math.max(e.r,e.g,e.b))}),Ue.forEach((e,t)=>{let n=z[t],r=z[t+1];e.setRGB(r.r/Math.max(n.r,.001),r.g/Math.max(n.g,.001),r.b/Math.max(n.b,.001))}),N.uniforms.uGlowTint.value.copy(z[0])},V=[],H=2,U=14,Ge=1,W=3.5,G=0,Ke=new i,qe=new i,K=new d,Je=new d,Ye=new ue,q=new s,Xe=new s,J=(e,t)=>e+Math.random()*(t-e),Ze=[0,Math.PI/2,Math.PI,-Math.PI/2],Qe=()=>{H=G===0?2:_e[(G+Math.floor(Math.random()*3))%_e.length],G>0&&Ve(),G++,U=J(12.5,15.5),Ge=J(.75,1.3);let e=Math.min(me,12+H),t=H<=2?1:H>=6?.8:.9;V.length=0;for(let n=0;n<e;n++){let e=pe[Math.floor(Math.random()*pe.length)],r=()=>Ze[Math.floor(Math.random()*4)],a=new d().setFromEuler(Ye.set(r()+J(-.25,.25),r()+J(-.25,.25),r()+(Math.random()<.3?Math.PI/4:0)));V.push({boxes:e.map((e,t)=>new i().compose(q.set(...e.p),K.setFromEuler(Ye.set(0,(e.ry??0)*Math.PI/180,(e.rz??0)*Math.PI/180)),Xe.set(...e.s).multiplyScalar(1+.04*t))),r:n<3?J(.3,1.1):J(.9,2.7),theta:J(0,Math.PI*2),z:J(-1.6,1.6),size:J(.65,1.25)*t,base:a,axis:new s(J(-1,1),J(-1,1),J(-1,1)).normalize(),spin:J(.25,.7)*(Math.random()<.5?-1:1),wobble:J(0,Math.PI*2),tone:Math.random()})}let n=0;for(let e of V)for(let t=0;t<e.boxes.length;t++)ke[n++]=e.tone;w.count=n,W=0;for(let e of V){let t=Math.max(...e.boxes.map(e=>{let t=e.elements;return Math.hypot(t[12],t[13],t[14])+.5*Math.hypot(Math.hypot(t[0],t[1],t[2]),Math.hypot(t[4],t[5],t[6]),Math.hypot(t[8],t[9],t[10]))}));W=Math.max(W,e.r+t*e.size)}C.getAttribute(`aTone`).needsUpdate=!0};Qe();let Y=0,$e=0,et=0,tt=0,nt=1,X=0,rt=1,Z=0,Q=0,it=0,$=0;return{resize(e,t,n){g.setPixelRatio(n),g.setSize(e,t),_=Math.max(1,Math.round(e*n)),v=Math.max(1,Math.round(t*n)),D.setSize(_,v),Pe(),B=NaN,b.aspect=e/t,Ne()},frame({audio:e,settings:t,dt:n,width:r,height:i}){let a=t.sensitivity,ee=Math.min(1,e.bands.bass*a);X+=(ee-X)*Math.min(1,n*8);let te=Math.min(1,e.level.rms*2.5*a),ne=Math.min(1,e.onsets.kick.envelope*a),re=Math.min(1,e.onsets.hat.envelope*a);if($+=n,fe(e)){let t=de(e);Z=Math.max(Z,Math.min(1,t*a)),t>=.5&&++it%16==0&&(Qe(),Q=1,$=0)}$>20/Math.max(.3,t.speed)&&(Qe(),Q=.6,$=0,it=0),e.onsets.snare.hit&&(nt=-nt,tt+=(.12+.18*Math.min(1,e.onsets.snare.strength*.5))*nt),Z*=Math.exp(-n/.16),Q*=Math.exp(-n/.2),et+=(tt-et)*(1-Math.exp(-n/.12));let o=t.speed*(.35+.9*X);Y+=n*o,$e+=n*o*.12,rt+=(.9+.5*X+.35*te-rt)*Math.min(1,n*8);let ie=Math.tan(b.fov*Math.PI/360),s=Math.min(1,r/i)*U*ie*1.25/W;x.scale.setScalar(s*t.scale*(1+.09*Z)),x.rotation.set(.35*Math.sin(Y*.23),.45*Math.sin(Y*.17+1),$e+et),b.position.set(0,0,U),b.lookAt(0,0,0);let c=0,ae=1+.06*X+.05*Z;for(let e of V){let t=e.r*ae;q.set(t*Math.cos(e.theta),t*Math.sin(e.theta),e.z+.3*Math.sin(Y*.5+e.wobble)),Je.setFromAxisAngle(e.axis,Y*e.spin+.35*Math.sin(Y*.7+e.wobble)),K.copy(Je).multiply(e.base),Ke.compose(q,K,Xe.setScalar(e.size));for(let t of e.boxes)w.setMatrixAt(c++,qe.multiplyMatrices(Ke,t))}w.instanceMatrix.needsUpdate=!0,We(t.hueShift,n);let l=v/700,u=Math.min(1,Math.max(Z,ne*.6));S.uKey.value=Ge*(.85+.6*u+.8*Q),S.uEdge.value=1.4+.5*re+.4*u,S.uLine.value=Math.max(1,1.3*l),S.uRim.value=7*l,S.uNear.value=U,Le.uniforms.uSeg.value=Math.PI/H,N.uniforms.uGlow.value=.8*rt*(1+.5*u+1.5*Q),N.uniforms.uFlash.value=Q,N.uniforms.uSeed.value=(N.uniforms.uSeed.value+.618)%64,g.setRenderTarget(T),g.setClearColor(0,1),g.clear(),g.render(y,b),P(Le,D);let d=D;for(let e of O)j.uniforms.tSrc.value=d.texture,j.uniforms.uTexel.value.set(1/d.width,1/d.height),P(j,e),d=e;for(let e=7;e>=0;e--){let t=O[e+1];M.uniforms.tSrc.value=t.texture,M.uniforms.uTexel.value.set(1/t.width,1/t.height),M.uniforms.uTint.value.copy(Ue[e]),P(M,O[e])}P(N,null)},dispose(){u(y);for(let e of[Le,j,M,N])e.dispose();k.geometry.dispose(),T.dispose(),D.dispose();for(let e of O)e.dispose();oe(g)}}};export{Ee as default};
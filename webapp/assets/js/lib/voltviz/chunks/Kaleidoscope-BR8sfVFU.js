import{C as e,D as t,H as n,J as r,M as i,N as a,S as ee,T as te,U as ne,W as re,_ as ie,a as ae,ct as o,d as s,dt as c,et as l,lt as u,n as d,r as oe,t as se,tt as ce,ut as le,v as ue}from"./three-_gmPQh3Y.js";import{i as de,r as fe}from"./audio-Ds-N7sX7.js";var pe=[[{p:[0,0,0],s:[.5,2.6,.5]}],[{p:[0,0,0],s:[.42,2.2,.42]},{p:[0,1.2,0],s:[.8,.22,.6]},{p:[0,-1.2,0],s:[.8,.22,.6]}],[{p:[-.32,0,0],s:[.38,2.4,.5]},{p:[.32,.25,0],s:[.38,2,.5]}],[{p:[-.42,0,0],s:[.36,1.5,.55],rz:-32},{p:[.42,0,0],s:[.36,1.5,.55],rz:32}],[{p:[0,0,0],s:[.46,1.9,.5]},{p:[.5,.75,0],s:[1,.4,.5]}],[{p:[0,0,0],s:[1.1,.5,1]},{p:[0,.42,0],s:[.75,.38,.7]},{p:[0,.75,0],s:[.4,.3,.4]}],[{p:[0,-.2,0],s:[.32,1.8,.36]},{p:[-.28,.65,0],s:[.26,.9,.36],rz:-42},{p:[.28,.65,0],s:[.26,.9,.36],rz:42}],[{p:[0,-.62,0],s:[1.45,.3,.45]},{p:[-.58,.05,0],s:[.3,1.4,.45]},{p:[.58,.05,0],s:[.3,1.4,.45]}],[{p:[0,0,0],s:[1,1,1]},{p:[.52,.52,.25],s:[.4,.4,.4]}],[{p:[0,0,0],s:[.62,.62,1.7],rz:45}],[{p:[0,0,0],s:[1.6,.34,.8]},{p:[.3,.3,0],s:[.3,.5,.8],ry:0}]],me=20,he=60,ge=9,f=[.3,.5,1,1.6,1.6,.7,.2,.04,0],_e=[2,4,2,6,4],p=[{dark:`#001458`,main:`#0a62d0`,mid:`#868ee8`,lit:`#eeb6fb`,hot:`#fff0ff`,edge:`#fff0ff`,near:`#ffc4ff`,far:`#3a8cff`},{dark:`#2b0038`,main:`#c3168f`,mid:`#9a5cf0`,lit:`#5ff4ff`,hot:`#e6ffff`,edge:`#f0ffff`,near:`#9ef8ff`,far:`#ff3fae`},{dark:`#1c0045`,main:`#6a25ff`,mid:`#c040e8`,lit:`#ff5fb4`,hot:`#ffe2f2`,edge:`#ffeaf6`,near:`#ff8ccc`,far:`#8f4dff`},{dark:`#00241c`,main:`#00a884`,mid:`#7ee05a`,lit:`#e2ff3a`,hot:`#f4ffa0`,edge:`#f8ffd8`,near:`#f2ff8a`,far:`#10ffb0`},{dark:`#2e0c00`,main:`#e05000`,mid:`#ff8a30`,lit:`#ffc04a`,hot:`#ffe0a0`,edge:`#c8ffff`,near:`#6cf6ff`,far:`#ff5a10`},{dark:`#002033`,main:`#009fd6`,mid:`#b45adc`,lit:`#ff3d94`,hot:`#ffc0de`,edge:`#f0ffff`,near:`#ff86c4`,far:`#00c4ff`}],m=Object.keys(p[0]),ve=1.2,ye=`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,be=`
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
`,Ee=({container:Ee,width:h,height:g,dpr:De})=>{let _=se(Ee,h,g,De,{antialias:!1});_.autoClear=!1;let v=Math.max(1,Math.round(h*De)),y=Math.max(1,Math.round(g*De)),Oe=new l,b=new ne(32,h/g,2,30),x=new ee;Oe.add(x);let S={uDark:{value:new s},uMain:{value:new s},uMid:{value:new s},uLit:{value:new s},uHot:{value:new s},uEdgeCol:{value:new s},uKeyDir:{value:new u(-.55,.55,.62).normalize()},uFillDir:{value:new u(.45,-.3,.85).normalize()},uKey:{value:1},uEdge:{value:1},uLine:{value:1},uRim:{value:8},uNear:{value:14}},ke=new ae(1,1,1),Ae=new Float32Array(he);ke.setAttribute(`aTone`,new te(Ae,1));let je=new ce({uniforms:S,vertexShader:be,fragmentShader:xe,side:2}),C=new t(ke,je,he);C.instanceMatrix.setUsage(ie),C.frustumCulled=!1,x.add(C);let Me={type:e,depthBuffer:!1},w=new c(1,1,{type:e,samples:4}),Ne=new le,T=new o,Pe=()=>{T.set(Math.floor(v/2),Math.floor(y/2));let e=v-T.x+4,t=y-T.y+4;w.setSize(e,t),Ne.set(-4,-4,e,t),b.setViewOffset(v,y,T.x-4,0,e,t)},E=new c(v,y,Me),D=Array.from({length:ge},()=>new c(1,1,Me)),Fe=()=>{let e=v,t=y;for(let n of D)e=Math.max(1,e>>1),t=Math.max(1,t>>1),n.setSize(e,t)};Fe(),Pe();let Ie=new l,Le=new n(-1,1,1,-1,0,1),O=new a(new re(2,2));O.frustumCulled=!1,Ie.add(O);let k=(e,t,n=!1)=>new ce({uniforms:t,vertexShader:ye,fragmentShader:e,depthTest:!1,depthWrite:!1,blending:n?2:0,transparent:n}),Re=k(Se,{tScene:{value:w.texture},uCenter:{value:T},uQuad:{value:Ne},uSeg:{value:Math.PI/2}}),A=k(Ce,{tSrc:{value:null},uTexel:{value:new o}}),j=k(we,{tSrc:{value:null},uTexel:{value:new o},uTint:{value:new s}},!0),M=k(Te,{tImage:{value:E.texture},tGlow:{value:D[0].texture},uGlow:{value:1},uGlowTint:{value:new s},uFlash:{value:0},uFlashCol:{value:new s},uSeed:{value:0}}),N=(e,t)=>{O.material=e,_.setRenderTarget(t),_.render(Ie,Le)},P=e=>Object.fromEntries(m.map(t=>[t,e(t)])),ze=p.map(e=>P(t=>new s().setStyle(e[t],``))),F=P(e=>ze[0][e].clone()),Be=P(()=>new s),I=P(()=>new s),L=0,R=1,Ve=()=>{for(let e of m)Be[e].copy(F[e]);L=(L+1+Math.floor(Math.random()*(p.length-1)))%p.length,R=0},He=e=>{let t=Math.max(0,Math.log2(2**(e+1)*600/y)-1),n=Math.min(f.length-2,Math.floor(t)),r=Math.min(1,t-n);return f[n]+(f[n+1]-f[n])*r},z=Array.from({length:ge},()=>new s),Ue=Array.from({length:8},()=>new s),We=NaN,Ge=(e,t)=>{let n=R<1;if(!n&&e===We)return;if(We=e,n){R=Math.min(1,R+t/ve);let e=R*R*(3-2*R);for(let t of m)F[t].copy(Be[t]).lerp(ze[L][t],e)}let r=e/360;for(let e of m)I[e].copy(F[e]).offsetHSL(r,0,0);S.uDark.value.copy(I.dark),S.uMain.value.copy(I.main),S.uMid.value.copy(I.mid),S.uLit.value.copy(I.lit),S.uHot.value.copy(I.hot),S.uEdgeCol.value.copy(I.edge),M.uniforms.uFlashCol.value.copy(I.near);let{near:i,far:a}=I;z.forEach((e,t)=>{let n=Math.log2(2**(t+1)*600/y);e.copy(i).lerp(a,Math.min(1,Math.max(0,(n-1)/3))),e.multiplyScalar(Math.max(.001,He(t))/Math.max(e.r,e.g,e.b))}),Ue.forEach((e,t)=>{let n=z[t],r=z[t+1];e.setRGB(r.r/Math.max(n.r,.001),r.g/Math.max(n.g,.001),r.b/Math.max(n.b,.001))}),M.uniforms.uGlowTint.value.copy(z[0])},B=[],V=2,H=14,Ke=1,U=3.5,W=0,qe=new i,Je=new i,G=new r,Ye=new r,Xe=new ue,K=new u,Ze=new u,q=(e,t)=>e+Math.random()*(t-e),Qe=[0,Math.PI/2,Math.PI,-Math.PI/2],$e=()=>{V=W===0?2:_e[(W+Math.floor(Math.random()*3))%_e.length],W>0&&Ve(),W++,H=q(12.5,15.5),Ke=q(.75,1.3);let e=Math.min(me,12+V),t=V<=2?1:V>=6?.8:.9;B.length=0;for(let n=0;n<e;n++){let e=pe[Math.floor(Math.random()*pe.length)],a=()=>Qe[Math.floor(Math.random()*4)],ee=new r().setFromEuler(Xe.set(a()+q(-.25,.25),a()+q(-.25,.25),a()+(Math.random()<.3?Math.PI/4:0)));B.push({boxes:e.map((e,t)=>new i().compose(K.set(...e.p),G.setFromEuler(Xe.set(0,(e.ry??0)*Math.PI/180,(e.rz??0)*Math.PI/180)),Ze.set(...e.s).multiplyScalar(1+.04*t))),r:n<3?q(.3,1.1):q(.9,2.7),theta:q(0,Math.PI*2),z:q(-1.6,1.6),size:q(.65,1.25)*t,base:ee,axis:new u(q(-1,1),q(-1,1),q(-1,1)).normalize(),spin:q(.25,.7)*(Math.random()<.5?-1:1),wobble:q(0,Math.PI*2),tone:Math.random()})}let n=0;for(let e of B)for(let t=0;t<e.boxes.length;t++)Ae[n++]=e.tone;C.count=n,U=0;for(let e of B){let t=Math.max(...e.boxes.map(e=>{let t=e.elements;return Math.hypot(t[12],t[13],t[14])+.5*Math.hypot(Math.hypot(t[0],t[1],t[2]),Math.hypot(t[4],t[5],t[6]),Math.hypot(t[8],t[9],t[10]))}));U=Math.max(U,e.r+t*e.size)}ke.getAttribute(`aTone`).needsUpdate=!0};$e();let J=0,et=0,tt=0,nt=0,Y=1,X=0,rt=1,Z=0,Q=0,it=0,$=0;return{resize(e,t,n){_.setPixelRatio(n),_.setSize(e,t),v=Math.max(1,Math.round(e*n)),y=Math.max(1,Math.round(t*n)),E.setSize(v,y),Fe(),We=NaN,b.aspect=e/t,Pe()},frame({audio:e,settings:t,dt:n,width:r,height:i}){let a=t.sensitivity,ee=Math.min(1,e.bands.bass*a);X+=(ee-X)*Math.min(1,n*8);let te=Math.min(1,e.level.rms*2.5*a),ne=Math.min(1,e.onsets.kick.envelope*a),re=Math.min(1,e.onsets.hat.envelope*a);if($+=n,fe(e)){let t=de(e);Z=Math.max(Z,Math.min(1,t*a)),t>=.5&&++it%16==0&&($e(),Q=1,$=0)}$>20/Math.max(.3,t.speed)&&($e(),Q=.6,$=0,it=0),e.onsets.snare.hit&&(Y=-Y,nt+=(.12+.18*Math.min(1,e.onsets.snare.strength*.5))*Y),Z*=Math.exp(-n/.16),Q*=Math.exp(-n/.2),tt+=(nt-tt)*(1-Math.exp(-n/.12));let ie=t.speed*(.35+.9*X);J+=n*ie,et+=n*ie*.12,rt+=(.9+.5*X+.35*te-rt)*Math.min(1,n*8);let ae=Math.tan(b.fov*Math.PI/360),o=Math.min(1,r/i)*H*ae*1.25/U;x.scale.setScalar(o*t.scale*(1+.09*Z)),x.rotation.set(.35*Math.sin(J*.23),.45*Math.sin(J*.17+1),et+tt),b.position.set(0,0,H),b.lookAt(0,0,0);let s=0,c=1+.06*X+.05*Z;for(let e of B){let t=e.r*c;K.set(t*Math.cos(e.theta),t*Math.sin(e.theta),e.z+.3*Math.sin(J*.5+e.wobble)),Ye.setFromAxisAngle(e.axis,J*e.spin+.35*Math.sin(J*.7+e.wobble)),G.copy(Ye).multiply(e.base),qe.compose(K,G,Ze.setScalar(e.size));for(let t of e.boxes)C.setMatrixAt(s++,Je.multiplyMatrices(qe,t))}C.instanceMatrix.needsUpdate=!0,Ge(t.hueShift,n);let l=y/700,u=Math.min(1,Math.max(Z,ne*.6));S.uKey.value=Ke*(.85+.6*u+.8*Q),S.uEdge.value=1.4+.5*re+.4*u,S.uLine.value=Math.max(1,1.3*l),S.uRim.value=7*l,S.uNear.value=H,Re.uniforms.uSeg.value=Math.PI/V,M.uniforms.uGlow.value=.8*rt*(1+.5*u+1.5*Q),M.uniforms.uFlash.value=Q,M.uniforms.uSeed.value=(M.uniforms.uSeed.value+.618)%64,_.setRenderTarget(w),_.setClearColor(0,1),_.clear(),_.render(Oe,b),N(Re,E);let d=E;for(let e of D)A.uniforms.tSrc.value=d.texture,A.uniforms.uTexel.value.set(1/d.width,1/d.height),N(A,e),d=e;for(let e=7;e>=0;e--){let t=D[e+1];j.uniforms.tSrc.value=t.texture,j.uniforms.uTexel.value.set(1/t.width,1/t.height),j.uniforms.uTint.value.copy(Ue[e]),N(j,D[e])}N(M,null)},dispose(){d(Oe);for(let e of[Re,A,j,M])e.dispose();O.geometry.dispose(),w.dispose(),E.dispose();for(let e of D)e.dispose();oe(_)}}};export{Ee as default};
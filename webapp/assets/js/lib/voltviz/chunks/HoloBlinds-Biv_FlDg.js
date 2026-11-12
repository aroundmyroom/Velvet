import{H as e,N as t,W as n,ct as r,d as i,et as a,lt as o,r as s,t as c,tt as l}from"./three-_gmPQh3Y.js";var u=`
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`,d=`
  uniform float uPhase;
  uniform float uTwist1Phase;
  uniform float uTwist2Phase;
  uniform float uTwistReact;
  uniform vec2 uResolution;

  uniform vec3 uColor1;
  uniform vec3 uColor2;
  uniform vec3 uColor3;

  uniform float uGlobalRotX;
  uniform float uGlobalRotY;
  uniform float uCoreSquash;
  uniform float uCoreRadius;
  uniform float uRayCorrection;

  uniform float uL1Twist;
  uniform float uL1Scale;
  uniform float uL1ScaleY;
  uniform float uL1Thickness;

  uniform float uL2Twist;
  uniform float uL2Scale;
  uniform float uL2ScaleY;
  uniform float uL2Thickness;

  uniform float uStepMult;
  uniform float uStepMin;

  #define MAX_STEPS 42
  #define MAX_DIST 12.8

  mat2 rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c);
  }

  float map(vec3 p) {
    p.xz *= rot(uPhase * uGlobalRotX);
    p.yz *= rot(uPhase * uGlobalRotY);

    float core = length(vec3(p.x, p.y * uCoreSquash, p.z)) - uCoreRadius;

    vec3 q = p;
    q.xz *= rot(q.y * uL1Twist + uTwist1Phase + uTwistReact);
    q *= uL1Scale;
    q.y *= uL1ScaleY;

    float g1 = dot(sin(q), cos(q.yzx));
    float r1 = abs(g1) - uL1Thickness;

    vec3 q2 = p;
    q2.xz *= rot(q2.y * uL2Twist + uTwist2Phase + uTwistReact * 0.7);
    q2 *= uL2Scale;
    q2.y *= uL2ScaleY;

    float g2 = dot(sin(q2), cos(q2.yzx));
    float r2 = abs(g2) - uL2Thickness;

    float rays = max(r1, r2);
    rays *= uRayCorrection;

    return max(core, rays);
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

    vec3 ro = vec3(0.0, 0.0, -4.5);
    vec3 rd = normalize(vec3(uv, 1.0));

    float t = uPhase;
    float rayT = 0.0;
    vec3 glow = vec3(0.0);

    for (int i = 0; i < MAX_STEPS; i++) {
      vec3 p = ro + rd * rayT;
      float d = map(p);

      float mixFactor1 = sin(p.y * 2.0 + p.x * 1.5 - t) * 0.5 + 0.5;
      vec3 rayColor = mix(uColor1, uColor2, mixFactor1);

      float mixFactor2 = sin(p.z * 3.0 + t * 2.0) * 0.5 + 0.5;
      rayColor = mix(rayColor, uColor3, mixFactor2);

      float intensity = 0.0018 / (abs(d) + 0.005);
      glow += rayColor * intensity;

      rayT += max(abs(d) * uStepMult, uStepMin);

      if (rayT > MAX_DIST) break;
    }

    vec3 finalColor = glow * 0.7;
    finalColor = smoothstep(0.0, 1.1, finalColor);
    finalColor = pow(finalColor, vec3(1.05));
    finalColor *= 1.0 - length(uv) * 0.5;

    gl_FragColor = vec4(finalColor, 1.0);
  }
`,f=.7,p=2.8322,m=.2,h=-.4,g=.1,_=.06,v=({container:v,width:y,height:b,dpr:x})=>{let S=new Uint8Array,C=Math.min(x,1)*.8,w=c(v,y,b,C,{antialias:!1}),T=new a,E=new e(-1,1,1,-1,0,1),D=new i(.349,0,1),O=new i(1,.251,0),k=new i(0,.482,1),A={h:0,s:0,l:0},j={h:0,s:0,l:0},M={h:0,s:0,l:0};D.getHSL(A),O.getHSL(j),k.getHSL(M);let N={uPhase:{value:0},uTwist1Phase:{value:0},uTwist2Phase:{value:0},uTwistReact:{value:0},uResolution:{value:new r(y*C,b*C)},uColor1:{value:new o(.349,0,1)},uColor2:{value:new o(1,.251,0)},uColor3:{value:new o(0,.482,1)},uGlobalRotX:{value:.1},uGlobalRotY:{value:.03},uCoreSquash:{value:-.2},uCoreRadius:{value:p},uRayCorrection:{value:.35},uL1Twist:{value:43.1},uL1Scale:{value:-.2},uL1ScaleY:{value:-.21},uL1Thickness:{value:g},uL2Twist:{value:.3},uL2Scale:{value:1.5},uL2ScaleY:{value:0},uL2Thickness:{value:_},uStepMult:{value:.48},uStepMin:{value:.017}},P=new l({vertexShader:u,fragmentShader:d,uniforms:N,depthWrite:!1,depthTest:!1}),F=new t(new n(2,2),P);T.add(F);let I=0,L=0,R=0,z=0,B=0,V=0,H=new i,U=(e,t)=>{let n=0;for(let r=e;r<t;r++)n+=S[r];return t>e?n/((t-e)*255):0};return{resize(e,t,n){C=Math.min(n,1)*.8,w.setPixelRatio(C),w.setSize(e,t),N.uResolution.value.set(e*C,t*C)},frame({audio:e,settings:t,dt:n}){S=e.spectrum({fftSize:2048,smoothing:.8});let r=S.length,i=e.sampleRate/2048,a=Math.min(Math.floor(250/i),r),o=Math.min(Math.floor(2e3/i),r),s=U(0,a)*t.sensitivity,c=U(a,o)*t.sensitivity,l=U(o,r)*t.sensitivity;I+=(s-I)*.15,L+=(c-L)*.12,R+=(l-R)*.1;let u=n,d=f*t.speed*(1+I*.25),v=1+L*.6;z+=u*d,B+=u*d*m*v,V+=u*d*h*v,N.uPhase.value=z,N.uTwist1Phase.value=B,N.uTwist2Phase.value=V,N.uTwistReact.value=L*3+I*1.5;let y=Math.max(.5,Math.min(3,t.scale));N.uCoreRadius.value=p*y,N.uL1Thickness.value=g+I*.08,N.uL2Thickness.value=_+R*.06;let b=t.hueShift/360;H.setHSL((A.h+b+1)%1,A.s,A.l),N.uColor1.value.set(H.r,H.g,H.b),H.setHSL((j.h+b+1)%1,j.s,j.l),N.uColor2.value.set(H.r,H.g,H.b),H.setHSL((M.h+b+1)%1,M.s,M.l),N.uColor3.value.set(H.r,H.g,H.b),w.render(T,E)},dispose(){F.geometry.dispose(),P.dispose(),s(w)}}};export{v as default};
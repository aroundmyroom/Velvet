import{H as e,N as t,W as n,ct as r,et as i,lt as a,r as o,t as s,tt as c}from"./three-_gmPQh3Y.js";var l=`
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`,u=`
  uniform float u_time;
  uniform float u_rotPhaseX;
  uniform float u_rotPhaseY;
  uniform float u_warpReact;
  uniform vec2 u_resolution;

  uniform vec3 u_color1;
  uniform vec3 u_color2;
  uniform vec3 u_color3;

  uniform float u_warpFreq;
  uniform float u_warpAmp;
  uniform vec3 u_fold;
  uniform vec3 u_rot;
  uniform float u_scaleMult;
  uniform float u_scaleAccum;
  uniform vec3 u_rays;

  vec3 orbitTrap;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  mat2 rot(float a) {
    float s = sin(a), c = cos(a);
    return mat2(c, -s, s, c);
  }

  float map(vec3 p) {
    p.xz *= rot(u_rotPhaseX);
    p.xy *= rot(u_rotPhaseY);

    vec3 q = p;
    float scale = 0.26;
    orbitTrap = vec3(1000.0);

    for (int i = 1; i < 2; i++) {
      q += sin(q.zxy * u_warpFreq) * (u_warpAmp + u_warpReact);
      q = abs(q) - u_fold;
      q.xy *= rot(u_rot.x);
      q.xz *= rot(u_rot.y);
      q.yz *= rot(u_rot.z);
      q *= u_scaleMult;
      scale *= u_scaleAccum;
      orbitTrap = min(orbitTrap, abs(q));
    }

    float raysX = length(q.yz) - u_rays.x;
    float raysY = length(q.xz) - u_rays.y;
    float raysZ = length(q.xy) - u_rays.z;

    float k = 0.1;

    float h1 = clamp(6.7 + 0.1 * (raysX - raysY) / k, 0.1, 0.4);
    float mergedRays = mix(raysX, raysY, h1) - k * h1 * (1.0 - h1);

    float h2 = clamp(0.1 + 0.1 * (mergedRays - raysZ) / k, 0.0, 0.8);
    mergedRays = mix(mergedRays, raysZ, h2) - k * h2 * (-7.3 - h2);

    float core = length(p) - 0.44;

    mergedRays /= scale;

    float h3 = clamp(0.5 + 0.5 * (core - mergedRays) / 0.3, 0.0, 1.0);
    float d = mix(core, mergedRays, h3) - 0.3 * h3 * (1.0 - h3);

    return d * 0.3;
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    vec3 ro = vec3(0.0, 0.0, -4.5);
    vec3 rd = normalize(vec3(uv, 1.0));

    float t = hash(gl_FragCoord.xy + mod(u_time, 100.0) * 10.0) * 0.05;

    vec3 finalGlow = vec3(0.0);

    for (int i = 0; i < 90; i++) {
      vec3 p = ro + rd * t;
      float d = map(p);

      vec3 stepColor = mix(u_color1, u_color2, smoothstep(0.0, 1.0, orbitTrap.x));
      stepColor = mix(stepColor, u_color3, smoothstep(0.0, 1.0, orbitTrap.y));

      float glowIntensity = 0.0035 / (abs(d) + 0.005);
      finalGlow += stepColor * glowIntensity;

      t += abs(d) * 0.45 + 0.015;
      if (t > 10.0) break;
    }

    float vignette = 1.0 - dot(uv, uv) * 0.4;
    finalGlow *= vignette;

    finalGlow = (finalGlow * (2.38 * finalGlow + -0.04)) / (finalGlow * (2.35 * finalGlow + 1.52) + 0.14);

    float grain = hash(gl_FragCoord.xy + mod(u_time, 1000.0) * 15.0);
    finalGlow += (grain - 0.5) * 0.10;

    float colorDither = (hash(gl_FragCoord.xy + 123.456) * 2.0 - 1.0) / 255.0;
    finalGlow += colorDither;

    gl_FragColor = vec4(finalGlow, 1.0);
  }
`;function d(e,t,n){let r=Math.max(e,t,n),i=Math.min(e,t,n),a=(r+i)/2;if(r===i)return{h:0,s:0,l:a};let o=r-i,s=a>.5?o/(2-r-i):o/(r+i),c=0;return c=r===e?((t-n)/o+(t<n?6:0))/6:r===t?((n-e)/o+2)/6:((e-t)/o+4)/6,{h:c,s,l:a}}function f(e,t,n){if(t===0)return[n,n,n];let r=(e,t,n)=>(n<0&&(n+=1),n>1&&--n,n<1/6?e+(t-e)*6*n:n<1/2?t:n<2/3?e+(t-e)*(2/3-n)*6:e),i=n<.5?n*(1+t):n+t-n*t,a=2*n-i;return[r(a,i,e+1/3),r(a,i,e),r(a,i,e-1/3)]}var p=({container:p,width:m,height:h,dpr:g})=>{let _=s(p,m,h,Math.min(g,1),{antialias:!1,powerPreference:`high-performance`}),v=new i,y=new e(-1,1,1,-1,.1,10);y.position.z=1;let b=[.016,1,0],x=[.784,1,0],S=[0,.62,.239],C=.29,w=.3,T=.25,E=.55,D=2.65,O={u_time:{value:0},u_rotPhaseX:{value:0},u_rotPhaseY:{value:0},u_warpReact:{value:0},u_resolution:{value:new r(m,h)},u_color1:{value:new a(...b)},u_color2:{value:new a(...x)},u_color3:{value:new a(...S)},u_warpFreq:{value:56.3},u_warpAmp:{value:C},u_fold:{value:new a(.5,.4,.4)},u_rot:{value:new a(.2,1.6,-2.9)},u_scaleMult:{value:D},u_scaleAccum:{value:7.48},u_rays:{value:new a(w,T,E)}},k=new c({vertexShader:l,fragmentShader:u,uniforms:O,depthWrite:!1,depthTest:!1}),A=new n(2,2),j=new t(A,k);v.add(j);let M=0,N=0,P=0,F=0,I=0;return{resize(e,t,n){_.setPixelRatio(Math.min(n,1)),_.setSize(e,t),O.u_resolution.value.set(e,t)},frame({audio:e,settings:t,dt:n}){let r=e.spectrum({fftSize:2048,smoothing:.7}),i=r.length,a=e.sampleRate/2048,o=Math.min(Math.floor(250/a),i),s=Math.min(Math.floor(2e3/a),i),c=(e,t)=>{let n=0;for(let i=e;i<t;i++)n+=r[i];return t>e?n/((t-e)*255):0},l=c(0,o)*t.sensitivity,u=c(o,s)*t.sensitivity,p=c(s,i)*t.sensitivity;M+=(l-M)*.2,N+=(u-N)*.15,P+=(p-P)*.15;let m=n;O.u_time.value+=m*t.speed;let h=1+N*2;F+=m*t.speed*.15*h,I+=m*t.speed*.1*h,O.u_rotPhaseX.value=F,O.u_rotPhaseY.value=I,O.u_warpAmp.value=C*(1+M*1.5),O.u_warpReact.value=N*.15+M*.1,O.u_rays.value.set(w*(1+P*1),T*(1+P*1),E*(1+P*.8)),O.u_scaleMult.value=D*t.scale;let g=t.hueShift/360,k=e=>{let t=d(e[0],e[1],e[2]);return f((t.h+g)%1,t.s,t.l)},A=k(b),j=k(x),L=k(S);O.u_color1.value.set(A[0],A[1],A[2]),O.u_color2.value.set(j[0],j[1],j[2]),O.u_color3.value.set(L[0],L[1],L[2]),_.render(v,y)},dispose(){A.dispose(),k.dispose(),o(_)}}};export{p as default};
import{$ as e,H as t,N as n,Z as r,ct as i,d as a,et as o,nt as s,r as c,t as l}from"./three-DIyfzUHm.js";import{i as u}from"./audio-Ds-N7sX7.js";import{n as d,r as f,t as p}from"./RenderPass-dJHevfz0.js";var m=`
  varying vec3 vLocalPosition;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  void main() {
    vLocalPosition = position;
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`,h=`
  uniform float uTime;
  uniform vec3 uLocalCamPos;
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform float uDensity;
  uniform float uFractalIters;
  uniform float uFractalScale;
  uniform float uFractalDecay;
  uniform float uInternalAnim;
  uniform float uSmoothness;
  uniform float uAsymmetry;

  varying vec3 vLocalPosition;
  varying vec3 vNormal;
  varying vec3 vViewPosition;

  float evaluateStructure(vec3 pos) {
    float densityAcc = 0.0;
    vec3 anchor = pos;

    float animTime = uTime * uInternalAnim;
    float s = sin(animTime);
    float c = cos(animTime);
    mat2 rotAnim = mat2(c, s, -s, c);

    float a = 0.5 * uAsymmetry;
    mat2 rotAsym1 = mat2(cos(a), sin(a), -sin(a), cos(a));
    float b = 0.3 * uAsymmetry;
    mat2 rotAsym2 = mat2(cos(b), sin(b), -sin(b), cos(b));

    for (int step = 0; step < 8; ++step) {
      if (float(step) >= uFractalIters) break;

      pos.xy *= rotAnim;
      pos.yz *= rotAnim;
      pos.xz *= rotAsym1;
      pos.yz *= rotAsym2;
      pos += vec3(0.05, -0.02, 0.03) * uAsymmetry;

      vec3 foldedPos = sqrt(pos * pos + uSmoothness);
      float magnitudeSq = dot(foldedPos, foldedPos);
      magnitudeSq = max(magnitudeSq, 0.00001);

      pos = (uFractalScale * foldedPos / magnitudeSq) - uFractalScale;

      float ySq = pos.y * pos.y;
      float zSq = pos.z * pos.z;
      float yz2 = 2.0 * pos.y * pos.z;
      pos.yz = vec2(ySq - zSq, yz2);

      pos = vec3(pos.z, pos.x, pos.y);

      densityAcc += exp(uFractalDecay * abs(dot(pos, anchor)));
    }

    return densityAcc * 0.5;
  }

  vec2 getVolumeBounds(vec3 origin, vec3 dir, float radius) {
    float b = dot(origin, dir);
    float c = dot(origin, origin) - radius * radius;
    float discriminant = b * b - c;
    if (discriminant < 0.0) return vec2(-1.0);
    float root = sqrt(discriminant);
    return vec2(-b - root, -b + root);
  }

  vec3 traceEnergy(vec3 origin, vec3 dir, vec2 limits) {
    float currentDepth = limits.x;
    float marchStep = 0.02;
    vec3 finalEnergy = vec3(0.0);
    float fieldVal = 0.0;

    for (int i = 0; i < 48; i++) {
      currentDepth += marchStep * exp(-2.0 * fieldVal);
      if (currentDepth > limits.y) break;

      vec3 samplePoint = origin + currentDepth * dir;
      fieldVal = evaluateStructure(samplePoint);

      float vSq = fieldVal * fieldVal;
      float gradientBlend = smoothstep(0.0, 0.4, fieldVal);
      vec3 currentGradient = mix(uSecondaryColor, uPrimaryColor, gradientBlend);
      vec3 emission = currentGradient * (fieldVal * 1.8 + vSq * 1.0);
      finalEnergy = 0.99 * finalEnergy + (0.08 * uDensity) * emission;
    }

    return finalEnergy;
  }

  void main() {
    vec3 rayOrig = uLocalCamPos;
    vec3 rayDir = normalize(vLocalPosition - uLocalCamPos);

    float t = uTime * 0.1;
    float s = sin(t);
    float c = cos(t);
    mat2 rotXZ = mat2(c, s, -s, c);
    rayOrig.xz *= rotXZ;
    rayDir.xz *= rotXZ;

    vec2 limits = getVolumeBounds(rayOrig, rayDir, 2.0);
    if (limits.x < 0.0) discard;

    vec3 volumeColor = traceEnergy(rayOrig, rayDir, limits);

    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);
    float facingRatio = max(dot(normal, viewDir), 0.0);
    float edgeAA = smoothstep(0.0, 0.05, facingRatio);

    vec3 finalColor = 0.5 * log(1.0 + volumeColor);
    finalColor = clamp(finalColor, 0.0, 1.0);
    finalColor *= edgeAA;

    float maxLuma = max(finalColor.r, max(finalColor.g, finalColor.b));
    float alpha = clamp(maxLuma * 1.5, 0.0, 1.0) * edgeAA;

    gl_FragColor = vec4(finalColor, alpha);
  }
`,g=`
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`,_=`
  uniform vec3 uColor;
  uniform float uGlow;
  uniform float uLevel;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);
    float vdn = max(dot(normal, viewDir), 0.0);
    float edgeFade = smoothstep(0.0, 0.15, vdn);
    float innerFadePoint = clamp(1.0 - uLevel, 0.0, 0.99);
    float centerFade = smoothstep(1.0, innerFadePoint, vdn);
    float alpha = edgeFade * centerFade * uGlow;
    gl_FragColor = vec4(uColor, alpha);
  }
`,v={uniforms:{tDiffuse:{value:null},uAmount:{value:.025}},vertexShader:`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,fragmentShader:`
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec4 baseColor = texture2D(tDiffuse, vUv);
      float luma = max(baseColor.r, max(baseColor.g, baseColor.b));
      float mask = smoothstep(0.01, 0.1, luma);
      vec2 offset = (vUv - 0.5) * uAmount;
      float r = texture2D(tDiffuse, vUv + offset).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - offset).b;
      vec3 aberratedColor = vec3(r, g, b);
      gl_FragColor = vec4(mix(baseColor.rgb, aberratedColor, mask), 1.0);
    }
  `},y=({container:y,width:b,height:x,dpr:S})=>{let C=0,w=l(y,b,x,Math.min(S,1),{antialias:!1});w.outputColorSpace=r;let T=new e;T.background=new a(0);let E=new t(45,b/x,.1,100);E.position.set(0,0,6);let D=new a(`#00b3ff`),O=new a(`#2e9aff`),k={h:0,s:0,l:0},A={h:0,s:0,l:0};D.getHSL(k),O.getHSL(A);let j=.15,M=.43,N=.025,P={uTime:{value:0},uLocalCamPos:{value:new i},uPrimaryColor:{value:D.clone()},uSecondaryColor:{value:O.clone()},uDensity:{value:3},uFractalIters:{value:4},uFractalScale:{value:.97},uFractalDecay:{value:-16.7},uInternalAnim:{value:M},uSmoothness:{value:.031},uAsymmetry:{value:.55}},F=new o({vertexShader:m,fragmentShader:h,uniforms:P,transparent:!0,side:2,depthWrite:!1,blending:2}),I={uColor:{value:D.clone()},uGlow:{value:j},uLevel:{value:1}},L=new o({vertexShader:g,fragmentShader:_,uniforms:I,transparent:!0,side:0,depthWrite:!1,blending:2}),R=new s(2,64,64),z=new n(R,F);T.add(z);let B=new n(R,L);B.scale.set(1.03,1.03,1.03),z.add(B);let V=new d(w);V.setPixelRatio(Math.min(S,1)),V.setSize(b,x),V.addPass(new p(T,E));let H=new f(v);H.uniforms.uAmount.value=N,V.addPass(H);let U=new i,W=new a,G=new a,K=0,q=0,J=0;return{resize(e,t,n){w.setPixelRatio(Math.min(n,1)),V.setPixelRatio(Math.min(n,1)),w.setSize(e,t),V.setSize(e,t),E.aspect=e/t,E.updateProjectionMatrix()},frame({audio:e,settings:t,dt:n}){let r=e.spectrum({fftSize:2048,smoothing:.7}),i=r.length,a=e.sampleRate/2048,o=Math.min(Math.floor(60/a),i),s=Math.min(Math.floor(250/a),i),c=Math.min(Math.floor(2e3/a),i),l=Math.min(Math.floor(6e3/a),i),d=(e,t)=>{let n=0;for(let i=e;i<t;i++)n+=r[i];return t>e?n/((t-e)*255):0},f=d(0,o)*t.sensitivity,p=d(o,s)*t.sensitivity,m=d(s,c)*t.sensitivity,h=d(c,l)*t.sensitivity,g=d(l,i)*t.sensitivity;K+=((f+p)*.5-K)*.2,q+=(m-q)*.15,J+=((h+g)*.5-J)*.15,C=Math.max(C,u(e)),C*=.88;let _=n;P.uTime.value+=_*(.5+q*.6)*t.speed,P.uDensity.value=3*(1+K*.8+C*1.5),P.uInternalAnim.value=M*(1+q*1.2),I.uGlow.value=j+K*.6+C*.8,H.uniforms.uAmount.value=N+J*.04+C*.06;let v=t.hueShift/360;W.setHSL((k.h+v)%1,k.s,k.l),G.setHSL((A.h+v)%1,A.s,A.l),P.uPrimaryColor.value.copy(W),P.uSecondaryColor.value.copy(G),I.uColor.value.copy(W);let y=t.scale*(1+K*.08+C*.15);z.scale.setScalar(y);let b=.89*t.speed;z.rotation.y+=_*b,z.rotation.x+=_*b*.5,z.updateMatrixWorld(),U.copy(E.position),z.worldToLocal(U),P.uLocalCamPos.value.copy(U),V.render()},dispose(){R.dispose(),F.dispose(),L.dispose();for(let e of V.passes)e.dispose();V.dispose(),c(w)}}};export{y as default};
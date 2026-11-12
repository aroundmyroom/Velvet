import{C as e,N as t,P as n,S as r,U as i,W as a,Y as o,at as s,ct as c,d as l,dt as u,et as d,lt as f,p,r as m,t as h,tt as g}from"./three-_gmPQh3Y.js";import{n as _,r as v,t as y}from"./RenderPass-BLFX_71l.js";import{n as b,t as x}from"./OutputPass-VyDuAH0f.js";var S=100,C=200,w=8,ee=3.6505,T=4.0131,E=.2,te=.4,ne=.294,re=0,D=3.5,ie=.1,ae=70,O=.25,k=1.5,A=10,j=-150,oe=132.75,se=200,M=140,N=20,P=[`#004c94`,`#2e89ff`,`#003994`,`#004bad`,`#ff5900`],ce=class extends p{constructor(e,t,n,r,i){super(),this.x=e,this.zStart=t,this.zBend=n,this.radius=r,this.yEnd=i,this.L_flat=Math.abs(t-(n+r)),this.L_arc=Math.PI*r*.5,this.L_up=Math.max(.1,i-r),this.totalLength=this.L_flat+this.L_arc+this.L_up}getPoint(e,t=new f){let n=e*this.totalLength,r=0,i=0;if(n<=this.L_flat)i=this.zStart-n;else if(n<=this.L_flat+this.L_arc){let e=(n-this.L_flat)/this.L_arc,t=e*e*(3-2*e),a=(e*.4+t*.6)*(Math.PI*.5);r=this.radius*(1-Math.cos(a)),i=this.zBend+this.radius-Math.sin(a)*this.radius}else r=this.radius+(n-(this.L_flat+this.L_arc)),i=this.zBend;return t.set(this.x,r,i)}},le=`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vUv = uv;
    vNormal = normalMatrix * normal;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`,ue=`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uSpeed;
  uniform float uOffset;
  uniform float uTailLength;
  uniform float uIntensityMultiplier;
  uniform float uBendUv;
  uniform float uIsReflection;
  uniform float uDotDensity;
  uniform float uDotSize;
  uniform float uDotSpeed;
  uniform float uBrightness;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    float t = fract(uTime * uSpeed + uOffset);
    float dist = fract(t - vUv.x + 1.0);

    float baseAlpha = smoothstep(uTailLength, 0.0, dist);
    baseAlpha = pow(max(0.0, baseAlpha), 1.2);

    vec3 viewDir = normalize(vViewPosition);
    float fresnel = abs(dot(normalize(vNormal), viewDir));
    float edgeSoftness = smoothstep(0.0, 0.02, fresnel);
    baseAlpha *= edgeSoftness;

    float core = pow(max(0.0, baseAlpha), 3.0) * 1.5;

    float movingUV = vUv.x - (uTime * uSpeed * uDotSpeed) - uOffset;
    float signalPos = movingUV * uDotDensity;
    float dotId = floor(signalPos);
    float dotLocal = fract(signalPos);

    float distToCenter = length(vec2((dotLocal - 0.5) * 2.0, (fract(vUv.y + 0.5) - 0.5) * 6.0));
    float dotShape = 1.0 - smoothstep(0.0, max(0.001, uDotSize), distToCenter);
    float dotFinal = dotShape * step(0.6, hash(vec2(dotId, uOffset))) * (sin(uTime * 4.0 + hash(vec2(dotId)) * 6.28) * 0.3 + 0.7) * baseAlpha;

    if (uIsReflection > 0.5) {
      float refFade = 1.0 - smoothstep(uBendUv - 0.015, uBendUv, vUv.x);
      baseAlpha *= refFade;
      core *= refFade;
      dotFinal *= refFade * 0.1;
      baseAlpha = pow(max(0.0, baseAlpha), 0.5) * (0.7 + hash(vUv * 300.0 + uTime * 0.05) * 0.3);
      core *= 0.3;
    }

    vec3 trailColor = uColor * (baseAlpha + core * 1.5) * uIntensityMultiplier * uBrightness;
    vec3 rgb = trailColor / max(1.0 - clamp(dotFinal * 1.8, 0.0, 0.95), 0.001) + uColor * dotFinal * 2.5 * uIntensityMultiplier * uBrightness;

    gl_FragColor = vec4(rgb, (baseAlpha + dotFinal) * uIntensityMultiplier);
  }
`,de={uniforms:{tDiffuse:{value:null},resolution:{value:new c(1,1)},blurStrength:{value:D}},vertexShader:`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,fragmentShader:`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float blurStrength;
    varying vec2 vUv;
    void main() {
      float mask = 1.0 - smoothstep(0.0, 0.35, vUv.y);
      float radius = mask * blurStrength;
      if (radius < 0.1) {
        gl_FragColor = texture2D(tDiffuse, vUv);
      } else {
        vec4 color = vec4(0.0);
        float total = 0.0;
        const float GA = 2.3999632;
        for (int i = 0; i < 32; i++) {
          float f = float(i);
          float r = sqrt(f) * radius;
          float theta = f * GA;
          vec2 offset = vec2(cos(theta), sin(theta)) * (r / resolution);
          color += texture2D(tDiffuse, vUv + offset);
          total += 1.0;
        }
        gl_FragColor = color / total;
      }
    }
  `},F=({container:f,width:p,height:D})=>{let F=0,I=0,L=0,R=0,z=1.6,B=h(f,p,D,z,{antialias:!0,powerPreference:`high-performance`});B.setClearColor(0,1),B.toneMapping=1,B.toneMappingExposure=ee;let V=new d;V.background=new l(0);let H=new i(55,p/D,1,2e3);H.position.set(0,N,M),H.lookAt(0,N,-50);let U=new u(p*z,D*z,{type:e,format:o}),W=new _(B,U);W.setPixelRatio(z),W.addPass(new y(V,H));let G=new b(new c(p,D),E,ne,re);W.addPass(G);let K=new v(de);K.uniforms.resolution.value.set(p*z,D*z),W.addPass(K),W.addPass(new x);let q=P.map(e=>new l(e)),fe=q.map(e=>{let t={h:0,s:0,l:0};return e.getHSL(t),t}),J=new l,pe=()=>{let e=new a(1e3,1e3,1,1500);e.rotateX(-Math.PI*.5);let t=e.attributes.position.array;for(let e=0;e<t.length;e+=3)if(t[e+2]<j){let n=j-t[e+2],r=A*Math.PI*.5;if(n<r){let i=n/r,a=(i*.4+i*i*(3-2*i)*.6)*(Math.PI*.5);t[e+1]=A*(1-Math.cos(a)),t[e+2]=j-Math.sin(a)*A}else t[e+1]=A+(n-r),t[e+2]=-160}return e.computeVertexNormals(),e},Y=new n({color:0,transparent:!0,opacity:.85,depthWrite:!1,side:2}),X=new t(pe(),Y);X.position.set(0,-.5,-.5),X.renderOrder=1,V.add(X);let Z=new r;V.add(Z);let me=282.75/(282.75+Math.PI*A*.5+190),Q=[];for(let e=0;e<S;e++){let n=e/99*2-1,r=n,i=Math.sign(n)*Math.abs(n)**1.2,a=(r*.5+i*.5)*80;a+=(Math.random()-.5)*2;let o=Math.random()*.2+.1,c=Math.floor(Math.random()*P.length),l=Math.random()*.4+.3,u={uTime:{value:0},uColor:{value:q[c].clone()},uColorIndex:{value:c},uSpeed:{value:Math.random()*.5+.2},uOffset:{value:Math.random()},uTailLength:{value:l},uIntensityMultiplier:{value:1},uBendUv:{value:me},uIsReflection:{value:0},uDotDensity:{value:ae},uDotSize:{value:O},uDotSpeed:{value:k},uBrightness:{value:T}},d=new g({vertexShader:le,fragmentShader:ue,uniforms:u,transparent:!0,depthWrite:!1,blending:2}),f=new ce(a,oe,-160,A,se),p=new s(f,C,o,w,!1),m=new t(p,d),h=d.clone();h.uniforms.uIntensityMultiplier.value=.4,h.uniforms.uIsReflection.value=1;let _=new s(f,C,o,w,!1),v=new t(_,h);v.scale.y=-1,v.position.y=-1,Z.add(m,v),Q.push({mainMat:d,refMat:h,mainGeo:p,refGeo:_,colorIdx:c,baseTailLength:l})}let $=0;return{resize(e,t){e!==0&&t!==0&&(H.aspect=e/t,H.updateProjectionMatrix(),B.setSize(e,t),W.setSize(e,t),G.setSize(e,t),K.uniforms.resolution.value.set(e*z,t*z))},frame({audio:e,settings:t,dt:n}){let r=e.spectrum({fftSize:2048,smoothing:.75}),i=r.length,a=e.sampleRate/2048,o=Math.min(Math.floor(60/a),i),s=Math.min(Math.floor(250/a),i),c=Math.min(Math.floor(2e3/a),i),l=Math.min(Math.floor(6e3/a),i),u=(e,t)=>{if(t<=e)return 0;let n=0;for(let i=e;i<t;i++)n+=r[i];return n/((t-e)*255)},d=u(0,o)*t.sensitivity,f=u(o,s)*t.sensitivity,p=u(s,c)*t.sensitivity,m=u(c,l)*t.sensitivity,h=u(l,i)*t.sensitivity;F+=(d-F)*.25,I+=(f-I)*.2,L+=(p-L)*.15,R+=((m+h)*.5-R)*.15,$+=n*ie*t.speed*(1+I*2.5),G.strength=Math.min(te,E+F*.2);let g=T*(1+F*.9),_=k*(1+R*2.5),v=O*(1+I*.6),y=1+L*.9,b=t.hueShift/360,x=fe.map(e=>(J.setHSL(((e.h+b)%1+1)%1,e.s,e.l),J.clone()));for(let e=0;e<Q.length;e++){let t=Q[e],n=t.mainMat.uniforms,r=t.refMat.uniforms,i=Math.min(.95,t.baseTailLength*y);n.uTime.value=$,r.uTime.value=$,n.uBrightness.value=g,r.uBrightness.value=g,n.uDotSpeed.value=_,r.uDotSpeed.value=_,n.uDotSize.value=v,r.uDotSize.value=v,n.uTailLength.value=i,r.uTailLength.value=i,n.uColor.value.copy(x[t.colorIdx]),r.uColor.value.copy(x[t.colorIdx])}let S=Math.max(.25,Math.min(4,t.scale));H.position.z=M/S,H.lookAt(0,N,-50),W.render()},dispose(){X.geometry.dispose(),Y.dispose();for(let e of Q)e.mainGeo.dispose(),e.refGeo.dispose(),e.mainMat.dispose(),e.refMat.dispose();for(let e of W.passes)e.dispose();W.dispose(),U.dispose(),m(B)}}};export{F as default};
import{A as e,K as t,Q as n,U as r,ct as i,d as a,et as o,o as s,r as c,s as l,t as u,tt as d,x as f}from"./three-_gmPQh3Y.js";import{n as p,t as m}from"./RenderPass-BLFX_71l.js";import{n as h,t as g}from"./OutputPass-VyDuAH0f.js";var _=({container:_,width:v,height:y,dpr:b})=>{let x=u(_,v,y,b,{antialias:!1,powerPreference:`high-performance`});x.outputColorSpace=n;let S=new o;S.fog=new f(0,.03);let C=new r(60,v/y,.1,1e3);C.position.set(0,0,30);let w=new m(S,C),T=new h(new i(v,y),.8,.4,.25),E=new p(x);E.addPass(w),E.addPass(T);let D=new g;E.addPass(D);let O=2e4,k=1e4,A=1.5,j=new l,M=new Float32Array(O*3),N=new Float32Array(O*3),P=new Float32Array(O),F=new a(65535),I=new a(16711731);for(let e=0;e<O;e++){let t=Math.round((Math.random()-.5)*60/A)*A,n=Math.round((Math.random()-.5)*60/A)*A,r=Math.round((Math.random()-.5)*60/A)*A;M[e*3]=t,M[e*3+1]=n,M[e*3+2]=r;let i=Math.max(0,Math.min(1,(t-n)/60+.5)),o=new a().lerpColors(F,I,i);N[e*3]=o.r,N[e*3+1]=o.g,N[e*3+2]=o.b,P[e]=Math.random()*2}j.setAttribute(`position`,new s(M,3)),j.setAttribute(`color`,new s(N,3)),j.setAttribute(`size`,new s(P,1));let L=new d({uniforms:{uTime:{value:0},uAudio:{value:0},uHueShift:{value:0},uBrightness:{value:1}},vertexShader:`
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      uniform float uTime;
      uniform float uAudio;

      void main() {
        vColor = color;
        vec3 pos = position;

        // Slight jitter based on audio
        pos.x += sin(uTime * 2.0 + pos.y) * 0.2 * uAudio;
        pos.y += cos(uTime * 2.0 + pos.x) * 0.2 * uAudio;

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = size * (300.0 / -mvPosition.z) * (1.0 + uAudio * 1.5);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,fragmentShader:`
      varying vec3 vColor;
      uniform float uHueShift;
      uniform float uBrightness;

      vec3 hueShift(vec3 color, float hue) {
          const vec3 k = vec3(0.57735, 0.57735, 0.57735);
          float cosAngle = cos(hue);
          return vec3(color * cosAngle + cross(k, color) * sin(hue) + k * dot(k, color) * (1.0 - cosAngle));
      }

      void main() {
        float dist = length(gl_PointCoord - vec2(0.5));
        if (dist > 0.5) discard;

        vec3 shiftedColor = hueShift(vColor, uHueShift) * uBrightness;
        float alpha = smoothstep(0.5, 0.1, dist);
        gl_FragColor = vec4(shiftedColor, alpha);
      }
    `,transparent:!0,blending:2,depthWrite:!1}),R=new t(j,L);S.add(R);let z=new l,B=new Float32Array(k*2*3),V=new Float32Array(k*2*3);for(let e=0;e<k;e++){let t=Math.round((Math.random()-.5)*60/A)*A,n=Math.round((Math.random()-.5)*60/A)*A,r=Math.round((Math.random()-.5)*60/A)*A,i=Math.random()>.5,o=Math.random()>.8,s=(Math.floor(Math.random()*4)+1)*A,c=t,l=n,u=r;o?u+=s:i?c+=s:l+=s,B[e*6]=t,B[e*6+1]=n,B[e*6+2]=r,B[e*6+3]=c,B[e*6+4]=l,B[e*6+5]=u;let d=Math.max(0,Math.min(1,(t-n)/60+.5)),f=new a().lerpColors(F,I,d);V[e*6]=f.r,V[e*6+1]=f.g,V[e*6+2]=f.b,V[e*6+3]=f.r,V[e*6+4]=f.g,V[e*6+5]=f.b}z.setAttribute(`position`,new s(B,3)),z.setAttribute(`color`,new s(V,3));let H=new d({uniforms:{uHueShift:{value:0},uOpacity:{value:.3}},vertexShader:`
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,fragmentShader:`
      varying vec3 vColor;
      uniform float uHueShift;
      uniform float uOpacity;

      vec3 hueShift(vec3 color, float hue) {
          const vec3 k = vec3(0.57735, 0.57735, 0.57735);
          float cosAngle = cos(hue);
          return vec3(color * cosAngle + cross(k, color) * sin(hue) + k * dot(k, color) * (1.0 - cosAngle));
      }

      void main() {
        vec3 shiftedColor = hueShift(vColor, uHueShift);
        gl_FragColor = vec4(shiftedColor, uOpacity);
      }
    `,transparent:!0,blending:2,depthWrite:!1}),U=new e(z,H);S.add(U);let W=0,G=0,K=e=>{let t=window.innerWidth/2,n=window.innerHeight/2;W=(e.clientX-t)/100,G=(e.clientY-n)/100};window.addEventListener(`mousemove`,K);let q=.3;return{resize(e,t,n){x.setPixelRatio(n),E.setPixelRatio(n),x.setSize(e,t),E.setSize(e,t),C.aspect=e/t,C.updateProjectionMatrix()},frame({audio:e,settings:t,time:n}){let r=e.spectrum({fftSize:512,smoothing:.8}),i=r.slice(0,5),a=r.slice(5,100),o=r.slice(100,200),s=i.reduce((e,t)=>e+t,0)/(i.length*255),c=a.reduce((e,t)=>e+t,0)/(a.length*255),l=o.reduce((e,t)=>e+t,0)/(o.length*255),u=n*t.speed;L.uniforms.uTime.value=u,L.uniforms.uAudio.value=s*t.sensitivity*.25,L.uniforms.uHueShift.value=t.hueShift*Math.PI/180;let d=.3+Math.floor(s*5)/5*2*t.sensitivity;q+=(d-q)*.15,L.uniforms.uBrightness.value=q,H.uniforms.uHueShift.value=t.hueShift*Math.PI/180,H.uniforms.uOpacity.value=.1+l*.1*t.sensitivity;let f=Math.sin(u*.3)*8,p=Math.cos(u*.2)*5;C.position.x+=(W*15+f-C.position.x)*.05,C.position.y+=(-G*15+p-C.position.y)*.05,C.lookAt(S.position),S.position.x=Math.sin(u*.15)*8*(1+s*t.sensitivity),S.position.y=Math.cos(u*.1)*5,S.position.z=Math.sin(u*.12)*4,S.rotation.y=u*.08+Math.sin(u*.25)*.3+c*.2*t.sensitivity,S.rotation.x=u*.03+Math.cos(u*.2)*.15,T.strength=.6+s*.6*t.sensitivity,S.scale.setScalar(t.scale),E.render()},dispose(){window.removeEventListener(`mousemove`,K),j.dispose(),L.dispose(),z.dispose(),H.dispose();for(let e of E.passes)e.dispose();E.dispose(),c(x)}}};export{_ as default};
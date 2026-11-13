import{$ as e,B as t,D as n,G as r,H as i,N as a,P as o,R as s,S as c,a as l,ct as u,d,et as f,i as p,m,o as h,r as g,s as ee,t as te,v as ne,x as re,z as ie}from"./three-DIyfzUHm.js";import{i as ae}from"./audio-Ds-N7sX7.js";var _=({container:_,width:v,height:y,dpr:oe})=>{let b=new e;b.fog=new re(65794,.004);let x=new i(70,v/y,1,3e3);x.position.set(0,8,160),x.lookAt(0,50,0);let S=te(_,v,y,oe,{alpha:!0,antialias:!0,powerPreference:`high-performance`});S.domElement.style.background=`#010102`;let C=new c;b.add(C);let se=new t(30,0),w=new s({color:2236962,emissive:0,roughness:.2,metalness:.8,wireframe:!0}),T=new a(se,w);T.position.set(0,60,-20),C.add(T);let E=new t(28,0),D=new o({color:0}),ce=new a(E,D);T.add(ce);let O=[],k=new l(4,100,4);for(let e=0;e<12;e++){let t=e<6,n=e%6,r=new s({color:1118481,emissive:0}),i=new a(k,r),o=(t?-1:1)*(40+n*15),c=-20+n*10,l=80-n*10;i.scale.y=l/100,i.position.set(o,l/2,c),i.rotation.z=(t?1:-1)*.1*n,C.add(i),O.push(i)}let A=6e3,j=new ee,M=new Float32Array(A*3),N=new Float32Array(A);for(let e=0;e<A;e++)M[e*3]=(Math.random()-.5)*300,M[e*3+1]=0,M[e*3+2]=20+Math.random()*200,N[e]=Math.random();j.setAttribute(`position`,new h(M,3)),j.setAttribute(`aRandom`,new h(N,1));let P=new f({uniforms:{uTime:{value:0},uBass:{value:0},uColor:{value:new d(1118481)}},vertexShader:`
      uniform float uTime;
      uniform float uBass;
      attribute float aRandom;

      void main() {
        vec3 pos = position;
        // Make the crowd jump to the bass
        float jump = max(0.0, sin(uTime * 15.0 + aRandom * 6.28)) * uBass * 4.0;
        pos.y += jump + aRandom * 2.0; // Base height + jump

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = (4.0 + aRandom * 3.0) * (200.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,fragmentShader:`
      uniform vec3 uColor;
      void main() {
        vec2 xy = gl_PointCoord.xy - vec2(0.5);
        if (length(xy) > 0.5) discard;
        gl_FragColor = vec4(uColor, 1.0);
      }
    `}),le=new r(j,P);C.add(le);let F=new m(.2,.8,1e3,4);F.translate(0,500,0),F.rotateX(Math.PI/2);let I=new o({color:16777215,transparent:!0,opacity:.6,blending:2,depthWrite:!1}),L=new n(F,I,50);C.add(L);let R=[],z=new ie,B=new d;for(let e=0;e<50;e++){let t,n,r,i,a,o,s;e<80?(t=0,n=60,r=-20,i=(Math.random()-.5)*Math.PI,a=(Math.random()-.5)*Math.PI,o=0,s=0):e<200?(t=-60-Math.random()*40,n=10+Math.random()*60,r=-10,i=-.2+(Math.random()-.5)*.4,a=Math.PI/4+(Math.random()-.5)*.8,o=0,s=1):(t=60+Math.random()*40,n=10+Math.random()*60,r=-10,i=-.2+(Math.random()-.5)*.4,a=-Math.PI/4+(Math.random()-.5)*.8,o=0,s=2),R.push({pos:new u(t,n,r),baseRot:new ne(i,a,o),speed:.2+Math.random()*1.5,phase:Math.random()*Math.PI*2,bank:s})}let V=new m(1,3,40,8);V.translate(0,20,0);let H=new o({color:16733440,transparent:!0,opacity:0,blending:2,depthWrite:!1}),U=new n(V,H,20);C.add(U);let W=[];for(let e=0;e<20;e++)W.push({x:(e-10)*12,z:10+Math.random()*10,active:0});let G=7e3,K=new ee,q=new Float32Array(G*3),J=new Float32Array(G*3),Y=new Float32Array(G);K.setAttribute(`position`,new h(q,3)),K.setAttribute(`color`,new h(J,3)),K.setAttribute(`size`,new h(Y,1));let ue=new f({vertexShader:`
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,fragmentShader:`
      varying vec3 vColor;
      void main() {
        vec2 xy = gl_PointCoord.xy - vec2(0.5);
        float ll = length(xy);
        if (ll > 0.5) discard;
        float alpha = (0.5 - ll) * 2.0;
        gl_FragColor = vec4(vColor, alpha);
      }
    `,transparent:!0,blending:2,depthWrite:!1}),de=new r(K,ue);C.add(de);let X=[],fe=new p(1118481);b.add(fe);let Z=0,Q=0,$=0;return{resize(e,t,n){S.setPixelRatio(n),S.setSize(e,t),x.aspect=e/t,x.updateProjectionMatrix()},frame({audio:e,settings:t,dt:n}){Z+=n*t.speed,Q>0&&(Q-=n),$>0&&($-=n);let r=e.spectrum({fftSize:512,smoothing:.6}),i=r.slice(0,6).reduce((e,t)=>e+t,0)/6,a=r.slice(6,40).reduce((e,t)=>e+t,0)/34,o=r.slice(40,150).reduce((e,t)=>e+t,0)/110,s=i/255,c=a/255,l=o/255,f=i>a*1.15&&i>o*1.2,p=ae(e)>=.5&&s>.25*(1.5-t.sensitivity)&&f;if(s>.85*(1.5-t.sensitivity)){let e=(s-.8)*10;x.position.x=(Math.random()-.5)*e,x.position.y=8+(Math.random()-.5)*e}else x.position.x+=(0-x.position.x)*.1,x.position.y+=(8-x.position.y)*.1;T.rotation.y=Z*.5,T.rotation.z=Math.sin(Z*.2)*.2;let m=1+s**3*.5*t.scale;T.scale.setScalar(m);let h=(Z*.1+t.hueShift/360)%1;D.color.setHSL(h,1,s*.5),w.emissive.setHSL(h,1,s*.8),O.forEach((e,t)=>{let n=e.material;l>.5&&t%2==Math.floor(Z*10)%2?n.emissive.setHSL((h+t*.05)%1,1,l):n.emissive.setHex(0)}),P.uniforms.uTime.value=Z,P.uniforms.uBass.value=s**4*t.sensitivity,P.uniforms.uColor.value.setHSL(h,.5,.1+c*.3);for(let e=0;e<50;e++){let n=R[e];z.position.copy(n.pos),z.rotation.copy(n.baseRot);let r=Math.sin(Z*n.speed*2+n.phase)*1.2*c*t.sensitivity;n.bank===0?(z.rotation.x+=r*.5,z.rotation.y+=r*.5):n.bank===1?z.rotation.y+=r:z.rotation.y-=r;let i=.1+c**2*3*t.scale;z.scale.set(1,1,i),z.updateMatrix(),L.setMatrixAt(e,z.matrix);let a=h;if(n.bank===1&&(a=(h-.1+1)%1),n.bank===2&&(a=(h+.1)%1),l>.8&&Math.random()>.8)B.setHSL(0,0,1);else{let e=.1+c**2*.9;B.setHSL(a,1,e)}L.setColorAt(e,B)}L.instanceMatrix.needsUpdate=!0,L.instanceColor&&(L.instanceColor.needsUpdate=!0),p&&Q<=0&&(Q=.4,W.forEach(e=>{Math.random()>.5&&(e.active=1)}));for(let e=0;e<20;e++){let r=W[e];r.active>0&&(r.active-=n*2,r.active<0&&(r.active=0)),z.position.set(r.x,0,r.z),z.scale.set(1+r.active,r.active*1.5*t.scale,1+r.active),z.updateMatrix(),U.setMatrixAt(e,z.matrix),B.setHSL(.05+r.active*.1,1,r.active*.6),U.setColorAt(e,B)}if(U.instanceMatrix.needsUpdate=!0,U.instanceColor&&(U.instanceColor.needsUpdate=!0),p&&$<=0){$=.25;let e=120+Math.random()*140,t=[-48,-24,0,24,48],n=t[Math.floor(Math.random()*t.length)];for(let t=0;t<e&&!(X.length>=G);t++){let e=(Math.random()-.5)*.8,t=(Math.random()-.5)*.8,r=55+Math.random()*75;X.push({pos:new u(n+(Math.random()-.5)*5,6,-8+(Math.random()-.5)*4),vel:new u(e*r,r,t*r),life:0,maxLife:1+Math.random()*1.3,color:new d().setHSL((h+Math.random()*.2)%1,1,.7),size:4+Math.random()*7})}}let g=0;for(let e=X.length-1;e>=0;e--){let r=X[e];if(r.life+=n,r.life>=r.maxLife){X.splice(e,1);continue}r.vel.y-=55*n,r.vel.multiplyScalar(.98),r.pos.addScaledVector(r.vel,n),q[g*3]=r.pos.x,q[g*3+1]=r.pos.y,q[g*3+2]=r.pos.z;let i=r.life/r.maxLife,a=1-i**2;J[g*3]=r.color.r*a,J[g*3+1]=r.color.g*a,J[g*3+2]=r.color.b*a,Y[g]=r.size*(1-i*.5)*t.scale,g++}K.setDrawRange(0,g),K.attributes.position.needsUpdate=!0,K.attributes.color.needsUpdate=!0,K.attributes.size.needsUpdate=!0,S.render(b,x)},dispose(){se.dispose(),w.dispose(),E.dispose(),D.dispose(),k.dispose();for(let e of O)e.material.dispose();j.dispose(),P.dispose(),F.dispose(),I.dispose(),L.dispose(),V.dispose(),H.dispose(),U.dispose(),K.dispose(),ue.dispose(),g(S)}}};export{_ as default};
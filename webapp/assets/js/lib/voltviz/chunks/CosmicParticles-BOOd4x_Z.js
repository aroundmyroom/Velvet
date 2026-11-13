import{$ as e,G as t,H as n,X as r,et as i,h as a,o,r as s,s as c,t as l}from"./three-DIyfzUHm.js";var u=({container:u,width:d,height:f,dpr:p})=>{let m=new Uint8Array(256),h=new e,g=new n(75,d/f,.1,1e3);g.position.z=120;let _=l(u,d,f,p,{alpha:!0,antialias:!0,powerPreference:`high-performance`});_.domElement.style.background=`#050014`;let v=new a(m,256,1,r);v.needsUpdate=!0;let y=6e4,b=new c,x=new Float32Array(y*3),S=new Float32Array(y);for(let e=0;e<y;e++){let t=20+Math.random()**2*60,n=Math.random()*Math.PI*2,r=Math.acos(2*Math.random()-1);x[e*3]=t*Math.sin(r)*Math.cos(n),x[e*3+1]=t*Math.sin(r)*Math.sin(n),x[e*3+2]=t*Math.cos(r),S[e]=Math.random()}b.setAttribute(`position`,new o(x,3)),b.setAttribute(`aRandom`,new o(S,1));let C=new i({uniforms:{uTime:{value:0},uAudio:{value:v},uHueShift:{value:0},uScale:{value:1},uSensitivity:{value:1}},vertexShader:`
      uniform float uTime;
      uniform sampler2D uAudio;
      uniform float uScale;
      uniform float uSensitivity;

      attribute float aRandom;

      varying float vAudio;
      varying float vRandom;

      void main() {
        vRandom = aRandom;

        // Sample audio based on random value (so different particles react to different frequencies)
        // We sample from the lower half of the frequencies for more impact
        vec4 audioData = texture2D(uAudio, vec2(aRandom * 0.5, 0.5));
        float audioVol = audioData.r;
        vAudio = audioVol;

        vec3 pos = position;
        vec3 dir = normalize(pos);

        // Swirling motion
        float angleX = uTime * (0.1 + aRandom * 0.2);
        float angleY = uTime * (0.15 + aRandom * 0.1);

        mat2 rotX = mat2(cos(angleX), -sin(angleX), sin(angleX), cos(angleX));
        mat2 rotY = mat2(cos(angleY), -sin(angleY), sin(angleY), cos(angleY));

        pos.yz = rotX * pos.yz;
        pos.xz = rotY * pos.xz;

        // Audio displacement (explode outwards)
        pos += dir * (audioVol * 80.0 * uSensitivity * uScale);

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);

        // Size attenuation based on depth and audio
        gl_PointSize = (2.0 + audioVol * 6.0) * (150.0 / -mvPosition.z) * uScale;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,fragmentShader:`
      uniform float uTime;
      uniform float uHueShift;

      varying float vAudio;
      varying float vRandom;

      vec3 hsl2rgb(vec3 c) {
          vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          return c.z + c.y * (rgb - 0.5) * (1.0 - abs(2.0 * c.z - 1.0));
      }

      void main() {
        // Circular particle
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);
        if (dist > 0.5) discard;

        // Color based on random value, time, and hue shift
        float hue = mod(vRandom * 0.5 + uTime * 0.05 + uHueShift / 360.0, 1.0);

        // Increase lightness and saturation when loud
        float saturation = 0.8 + vAudio * 0.2;
        float lightness = 0.4 + vAudio * 0.4;

        vec3 color = hsl2rgb(vec3(hue, saturation, lightness));

        // Soft glowing edge
        float alpha = smoothstep(0.5, 0.1, dist) * (0.3 + vAudio * 0.7);

        gl_FragColor = vec4(color, alpha);
      }
    `,transparent:!0,blending:2,depthWrite:!1}),w=new t(b,C);h.add(w);let T=0;return{resize(e,t,n){_.setPixelRatio(n),_.setSize(e,t),g.aspect=e/t,g.updateProjectionMatrix()},frame({audio:e,settings:t,dt:n}){T+=n*t.speed,m.set(e.spectrum({fftSize:512,smoothing:.8})),v.needsUpdate=!0,C.uniforms.uTime.value=T,C.uniforms.uHueShift.value=t.hueShift,C.uniforms.uScale.value=t.scale,C.uniforms.uSensitivity.value=t.sensitivity,g.position.x=Math.sin(T*.5)*30,g.position.y=Math.cos(T*.3)*30,g.lookAt(h.position),_.render(h,g)},dispose(){b.dispose(),C.dispose(),v.dispose(),s(_)}}};export{u as default};
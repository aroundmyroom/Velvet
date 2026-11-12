import{H as e,N as t,W as n,Y as r,Z as i,ct as a,dt as o,et as s,h as c,j as l,r as u,st as d,t as f,tt as p}from"./three-_gmPQh3Y.js";var m=({container:m,width:h,height:g})=>{let _=new Uint8Array(256),v=new Uint8Array(512),y=f(m,h,g,1,{alpha:!1,antialias:!1,powerPreference:`high-performance`});y.autoClear=!1;let b=new s,x=new e(-1,1,1,-1,0,1),S={minFilter:l,magFilter:l,format:r,type:d},C=new o(h,g,S),w=new o(h,g,S),T=new c(_,256,1,i);T.needsUpdate=!0;let E=new c(v,512,1,i);E.needsUpdate=!0;let D=new n(2,2),O=new p({uniforms:{uPrev:{value:C.texture},uFreq:{value:T},uWave:{value:E},uTime:{value:0},uSens:{value:1},uSpeed:{value:1},uHue:{value:0},uScale:{value:1},uRes:{value:new a(h,g)}},vertexShader:`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,fragmentShader:`
      precision highp float;
      varying vec2 vUv;

      uniform sampler2D uPrev;
      uniform sampler2D uFreq;
      uniform sampler2D uWave;
      uniform float uTime;
      uniform float uSens;
      uniform float uSpeed;
      uniform float uHue;
      uniform float uScale;
      uniform vec2 uRes;

      #define PI  3.14159265
      #define TAU 6.28318530

      vec3 hsl2rgb(float h, float s, float l) {
        vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
      }

      void main() {
        vec2 uv = vUv;
        float ar = uRes.x / uRes.y;
        vec2 p = (uv - 0.5) * vec2(ar, 1.0);
        float t = uTime;

        // --- Audio bands ---
        float bass   = texture2D(uFreq, vec2(0.04, 0.5)).r;
        float mid    = texture2D(uFreq, vec2(0.22, 0.5)).r;
        float treble = texture2D(uFreq, vec2(0.55, 0.5)).r;
        float energy = (bass * 2.0 + mid + treble * 0.5) / 3.5;

        float sB = bass   * uSens;
        float sM = mid    * uSens;
        float sT = treble * uSens;
        float sE = energy * uSens;

        // === MOTION VECTORS (MilkDrop-style per-pixel warp) ===
        float dist = length(p);

        // Zoom: slight pull toward center, bass-reactive
        float zoom = 1.0 - (0.006 + sB * 0.010) * uScale;
        p *= zoom;

        // Rotation: varies with distance for spiral feel
        float rot = (0.003 + sM * 0.007) * uSpeed * (1.0 - dist * 0.4);
        float cs = cos(rot), sn = sin(rot);
        p = mat2(cs, -sn, sn, cs) * p;

        // Per-pixel sinusoidal warp (multiple frequencies for organic motion)
        float wa = (0.003 + sT * 0.007) * uScale;
        float sp = uSpeed;
        p.x += sin(p.y * 7.0 + t * 1.3 * sp) * wa;
        p.y += cos(p.x * 7.0 + t * 1.1 * sp) * wa;
        p.x += sin(p.y * 3.5 - t * 0.7 * sp + sB * 4.0) * wa * 0.4;
        p.y += cos(p.x * 4.5 + t * 0.5 * sp + sM * 3.0) * wa * 0.4;

        // Sample previous frame with warped coordinates
        vec2 wUv = p / vec2(ar, 1.0) + 0.5;
        vec4 prev = texture2D(uPrev, wUv);

        // Decay (slight darkening to prevent saturation)
        prev.rgb *= 0.990 - sE * 0.008;

        // Edge vignette in feedback (creates tunnel/zoom effect)
        float vig = smoothstep(0.7, 0.3, dist);
        prev.rgb *= 0.97 + 0.03 * vig;

        // Hue rotation on existing feedback content
        if (uHue != 0.0) {
          float hr = uHue / 360.0 * 0.04 * TAU;
          float cH = cos(hr), sH = sin(hr);
          vec3 o = prev.rgb;
          prev.r = dot(o, vec3(0.299 + 0.701*cH + 0.168*sH, 0.587 - 0.587*cH + 0.330*sH, 0.114 - 0.114*cH - 0.497*sH));
          prev.g = dot(o, vec3(0.299 - 0.299*cH - 0.328*sH, 0.587 + 0.413*cH + 0.035*sH, 0.114 - 0.114*cH + 0.292*sH));
          prev.b = dot(o, vec3(0.299 - 0.300*cH + 1.250*sH, 0.587 - 0.588*cH - 1.050*sH, 0.114 + 0.886*cH - 0.203*sH));
        }

        // === NEW CONTENT ===
        vec3 nc = vec3(0.0);
        vec2 cp = (uv - 0.5) * vec2(ar, 1.0);
        float cDist = length(cp);
        float cAng = atan(cp.y, cp.x);

        // 1. Waveform circle (inner ring)
        float wn = (cAng + PI) / TAU;
        float wv = texture2D(uWave, vec2(wn, 0.5)).r;
        float wd = (wv - 0.5) * 0.12 * uSens * uScale;
        float rInner = 0.18 * uScale + wd;
        float innerLine = smoothstep(0.005, 0.0, abs(cDist - rInner));
        float h1 = mod(t * 0.12 * uSpeed + uHue / 360.0 + wn * 0.7, 1.0);
        nc += hsl2rgb(h1, 0.95, 0.6) * innerLine * (0.4 + sE * 0.6);

        // 2. Frequency spectrum ring (outer)
        float fv = texture2D(uFreq, vec2(wn * 0.5, 0.5)).r;
        float rOuter = 0.32 * uScale + fv * 0.07 * uSens * uScale;
        float outerLine = smoothstep(0.004, 0.0, abs(cDist - rOuter));
        float h2 = mod(t * 0.09 * uSpeed + uHue / 360.0 + 0.5 + wn * 0.5, 1.0);
        nc += hsl2rgb(h2, 0.85, 0.55) * outerLine * (0.3 + sE * 0.7);

        // 3. Kaleidoscope lines (6-fold symmetry)
        float nSym = 6.0;
        float sa = mod(cAng + t * 0.25 * uSpeed, TAU / nSym) - PI / nSym;
        vec2 sp2 = vec2(cos(sa), sin(sa)) * cDist;
        float symLine = smoothstep(0.003, 0.0, abs(sp2.y));
        symLine *= smoothstep(0.38 * uScale, 0.06, cDist);
        symLine *= sT;
        float h3 = mod(t * 0.14 * uSpeed + uHue / 360.0 + cDist * 2.5, 1.0);
        nc += hsl2rgb(h3, 0.8, 0.5) * symLine * 0.6;

        // 4. Center glow (bass pulse)
        float glow = exp(-cDist * (5.5 / max(uScale, 0.01))) * sE * 0.35;
        float hg = mod(t * 0.07 * uSpeed + uHue / 360.0 + 0.33, 1.0);
        nc += hsl2rgb(hg, 0.75, 0.6) * glow;

        // Combine with soft clamp to prevent harsh clipping
        vec3 col = prev.rgb + nc;
        col = col / (1.0 + col * 0.15);

        gl_FragColor = vec4(col, 1.0);
      }
    `,depthTest:!1,depthWrite:!1}),k=new p({uniforms:{uTex:{value:w.texture}},vertexShader:`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,fragmentShader:`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTex;
      void main() {
        vec3 col = texture2D(uTex, vUv).rgb;
        col = pow(col, vec3(0.95));
        gl_FragColor = vec4(col, 1.0);
      }
    `,depthTest:!1,depthWrite:!1}),A=new t(D,O);b.add(A);let j=0;return{resize(e,t){y.setPixelRatio(1),y.setSize(e,t),O.uniforms.uRes.value.set(e,t),C.setSize(e,t),w.setSize(e,t)},frame({audio:e,settings:t,dt:n}){j+=n*t.speed,_.set(e.spectrum({fftSize:512,smoothing:.82})),v.set(e.waveform({fftSize:512,smoothing:.82})),T.needsUpdate=!0,E.needsUpdate=!0,O.uniforms.uPrev.value=C.texture,O.uniforms.uTime.value=j,O.uniforms.uSens.value=t.sensitivity,O.uniforms.uSpeed.value=t.speed,O.uniforms.uHue.value=t.hueShift,O.uniforms.uScale.value=t.scale,A.material=O,y.setRenderTarget(w),y.clear(),y.render(b,x),k.uniforms.uTex.value=w.texture,A.material=k,y.setRenderTarget(null),y.clear(),y.render(b,x);let r=C;C=w,w=r},dispose(){D.dispose(),O.dispose(),k.dispose(),C.dispose(),w.dispose(),T.dispose(),E.dispose(),u(y)}}};export{m as default};
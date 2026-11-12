import{H as e,N as t,W as n,Y as r,Z as i,ct as a,dt as o,et as s,h as c,j as l,r as u,st as d,t as f,tt as p}from"./three-_gmPQh3Y.js";var m=({container:m,width:h,height:g})=>{let _=1024,v=new Uint8Array(512),y=new Uint8Array(_),b=f(m,h,g,1,{alpha:!1,antialias:!1,powerPreference:`high-performance`});b.autoClear=!1;let x=new s,S=new e(-1,1,1,-1,0,1),C={minFilter:l,magFilter:l,format:r,type:d},w=new o(h,g,C),T=new o(h,g,C),E=new c(v,512,1,i);E.needsUpdate=!0;let D=new c(y,_,1,i);D.needsUpdate=!0;let O=new n(2,2),k=new p({uniforms:{uPrev:{value:w.texture},uFreq:{value:E},uWave:{value:D},uTime:{value:0},uSens:{value:1},uSpeed:{value:1},uHue:{value:0},uScale:{value:1},uRes:{value:new a(h,g)}},vertexShader:`
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
        float ar = uRes.x / uRes.y;
        vec2 p = (vUv - 0.5) * vec2(ar, 1.0);
        float t = uTime;

        // --- Audio bands ---
        float bass   = texture2D(uFreq, vec2(0.03, 0.5)).r;
        float mid    = texture2D(uFreq, vec2(0.18, 0.5)).r;
        float treble = texture2D(uFreq, vec2(0.50, 0.5)).r;
        float energy = (bass * 2.0 + mid + treble) / 4.0;

        float sB = bass   * uSens;
        float sM = mid    * uSens;
        float sT = treble * uSens;
        float sE = energy * uSens;

        // === DEEP TUNNEL WARP ===
        float dist = length(p);
        float ang  = atan(p.y, p.x);

        // Strong inward zoom – bass kicks pull you deeper
        float zoom = 1.0 - (0.012 + sB * 0.018) * uScale;
        p *= zoom;

        // Spiral rotation – accelerates toward center for vortex feel
        float spiral = (0.008 + sM * 0.014) * uSpeed / (0.3 + dist);
        float cs = cos(spiral), sn = sin(spiral);
        p = mat2(cs, -sn, sn, cs) * p;

        // Radial breathing (expand/contract with mid)
        float breath = 1.0 + sin(t * 2.2 * uSpeed) * sM * 0.008 * uScale;
        p *= breath;

        // Hyperbolic warp – creates star/diamond distortion patterns
        float hStrength = (0.004 + sT * 0.008) * uScale;
        float hAng = ang * 4.0 + t * 0.6 * uSpeed;
        p += vec2(cos(hAng), sin(hAng)) * hStrength * (0.5 - dist);

        // Domain-warped displacement for organic complexity
        float wStr = (0.002 + sE * 0.005) * uScale;
        float wx = sin(p.y * 11.0 + t * 1.7 * uSpeed + sB * 5.0);
        float wy = cos(p.x * 13.0 - t * 1.3 * uSpeed + sM * 4.0);
        p.x += wx * wStr;
        p.y += wy * wStr;

        // Sample feedback
        vec2 wUv = p / vec2(ar, 1.0) + 0.5;
        vec4 prev = texture2D(uPrev, wUv);

        // Decay with color channel separation for chromatic drift
        float decayBase = 0.375 - sE * 0.010;
        prev.r *= decayBase + 0.002;
        prev.g *= decayBase;
        prev.b *= decayBase + 0.004;

        // Tunnel vignette: darken edges, preserve center depth
        float vig = smoothstep(0.75, 0.15, dist);
        prev.rgb *= 0.95 + 0.05 * vig;

        // Gradual hue rotation on feedback
        if (uHue != 0.0) {
          float hr = uHue / 360.0 * 0.06 * TAU;
          float cH = cos(hr), sH = sin(hr);
          vec3 o = prev.rgb;
          prev.r = dot(o, vec3(0.299 + 0.701*cH + 0.168*sH, 0.587 - 0.587*cH + 0.330*sH, 0.114 - 0.114*cH - 0.497*sH));
          prev.g = dot(o, vec3(0.299 - 0.299*cH - 0.328*sH, 0.587 + 0.413*cH + 0.035*sH, 0.114 - 0.114*cH + 0.292*sH));
          prev.b = dot(o, vec3(0.299 - 0.300*cH + 1.250*sH, 0.587 - 0.588*cH - 1.050*sH, 0.114 + 0.886*cH - 0.203*sH));
        }

        // === NEW CONTENT ===
        vec3 nc = vec3(0.0);
        vec2 cp = (vUv - 0.5) * vec2(ar, 1.0);
        float cDist = length(cp);
        float cAng = atan(cp.y, cp.x);

        // 1. Radial frequency bars – spectrum mapped around the center
        float nBars = 48.0;
        float barAng = mod(cAng + PI, TAU) / TAU;
        float barIdx = floor(barAng * nBars) / nBars;
        float barFrac = fract(barAng * nBars);
        float barGap = smoothstep(0.0, 0.08, barFrac) * smoothstep(1.0, 0.92, barFrac);
        float freqVal = texture2D(uFreq, vec2(barIdx * 0.6, 0.5)).r * uSens;
        float barLen = 0.08 + freqVal * 0.28 * uScale;
        float barStart = 0.06 * uScale;
        float barMask = step(barStart, cDist) * step(cDist, barStart + barLen) * barGap;
        float bH = mod(barIdx + t * 0.08 * uSpeed + uHue / 360.0, 1.0);
        nc += hsl2rgb(bH, 0.9, 0.45) * barMask * (0.3 + freqVal * 0.4);

        // 2. Waveform spiral – time-domain data drawn as a rotating spiral
        float spiralArms = 3.0;
        float spiralAng = mod(cAng + t * 0.4 * uSpeed, TAU);
        float armPhase = mod(spiralAng * spiralArms / TAU, 1.0);
        float wIdx = mod(armPhase + cDist * 2.0, 1.0);
        float wVal = texture2D(uWave, vec2(wIdx, 0.5)).r;
        float wDev = (wVal - 0.5) * 0.06 * uSens * uScale;
        float spiralR = 0.12 * uScale + cDist * 0.15 + wDev;
        float spiralLine = smoothstep(0.006, 0.0, abs(fract(spiralAng * spiralArms / TAU) - 0.5) - 0.46);
        spiralLine *= smoothstep(0.45 * uScale, 0.08, cDist) * smoothstep(0.04, 0.08, cDist);
        float sH = mod(cDist * 3.0 + t * 0.1 * uSpeed + uHue / 360.0 + 0.5, 1.0);
        nc += hsl2rgb(sH, 0.85, 0.4) * spiralLine * (0.2 + sE * 0.45);

        // 3. Pulsing concentric rings – tunnel depth markers
        float ringSpace = 0.09 * uScale;
        float ringPhase = mod(cDist - t * 0.15 * uSpeed * uScale, ringSpace);
        float ringLine = smoothstep(0.003, 0.0, abs(ringPhase - ringSpace * 0.5) - ringSpace * 0.45);
        float ringBrightness = (0.08 + sB * 0.14) * smoothstep(0.55 * uScale, 0.05, cDist);
        float rH = mod(cDist * 2.0 + t * 0.06 * uSpeed + uHue / 360.0 + 0.25, 1.0);
        nc += hsl2rgb(rH, 0.7, 0.45) * ringLine * ringBrightness;

        // 4. Center flare – energy burst
        float flare = exp(-cDist * (8.0 / max(uScale, 0.01))) * sE * 0.28;
        // Cross-shaped flare spikes
        float spike = max(
          exp(-abs(cp.x) * 40.0) * exp(-abs(cp.y) * 8.0),
          exp(-abs(cp.y) * 40.0) * exp(-abs(cp.x) * 8.0)
        ) * sE * 0.15;
        float fH = mod(t * 0.05 * uSpeed + uHue / 360.0, 1.0);
        nc += hsl2rgb(fH, 0.8, 0.55) * (flare + spike);

        // Combine
        vec3 col = prev.rgb + nc;
        col = col / (1.0 + col * 0.22);

        gl_FragColor = vec4(col, 1.0);
      }
    `,depthTest:!1,depthWrite:!1}),A=new p({uniforms:{uTex:{value:T.texture}},vertexShader:`
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
        col = pow(col, vec3(1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,depthTest:!1,depthWrite:!1}),j=new t(O,k);x.add(j);let M=0;return{resize(e,t){b.setPixelRatio(1),b.setSize(e,t),k.uniforms.uRes.value.set(e,t),w.setSize(e,t),T.setSize(e,t)},frame({audio:e,settings:t,dt:n}){M+=n*t.speed,v.set(e.spectrum({fftSize:_,smoothing:.78})),y.set(e.waveform({fftSize:_,smoothing:.78})),E.needsUpdate=!0,D.needsUpdate=!0,k.uniforms.uPrev.value=w.texture,k.uniforms.uTime.value=M,k.uniforms.uSens.value=t.sensitivity,k.uniforms.uSpeed.value=t.speed,k.uniforms.uHue.value=t.hueShift,k.uniforms.uScale.value=t.scale,j.material=k,b.setRenderTarget(T),b.clear(),b.render(x,S),A.uniforms.uTex.value=T.texture,j.material=A,b.setRenderTarget(null),b.clear(),b.render(x,S);let r=w;w=T,T=r},dispose(){O.dispose(),k.dispose(),A.dispose(),w.dispose(),T.dispose(),E.dispose(),D.dispose(),u(b)}}};export{m as default};
import{H as e,N as t,W as n,et as r,lt as i,r as a,t as o,tt as s}from"./three-_gmPQh3Y.js";var c={timeScale:.5,waveSpeed:1,waveHeight:1,wave1Freq:4.8,wave1Amp:.038,wave2Freq:.3,wave2Amp:-.09,wave3FreqX:-.6,wave3FreqZ:-.7,wave3Amp:.12,noiseAmount:.004,foldingOffset:9.291,stepBase:.146,glowIntensity:.0085,glowSpread:5.1},l=({container:l,width:u,height:d,dpr:f})=>{let p=0,m=0,h=0,g=0,_=o(l,u,d,f,{antialias:!1,powerPreference:`high-performance`}),v=new r,y=new e(-1,1,1,-1,0,1),b={iTime:{value:0},iResolution:{value:new i(u*f,d*f,1)},uTimeScale:{value:c.timeScale},uWaveSpeed:{value:c.waveSpeed},uWaveHeight:{value:c.waveHeight},uWave1Freq:{value:c.wave1Freq},uWave1Amp:{value:c.wave1Amp},uWave2Freq:{value:c.wave2Freq},uWave2Amp:{value:c.wave2Amp},uWave3FreqX:{value:c.wave3FreqX},uWave3FreqZ:{value:c.wave3FreqZ},uWave3Amp:{value:c.wave3Amp},uNoiseAmount:{value:c.noiseAmount},uFoldingOffset:{value:c.foldingOffset},uStepBase:{value:c.stepBase},uGlowIntensity:{value:c.glowIntensity},uGlowSpread:{value:c.glowSpread},uHue:{value:0}},x=new s({vertexShader:`
    void main() {
      gl_Position = vec4(position, 1.0);
    }
  `,fragmentShader:`
    uniform vec3 iResolution;
    uniform float iTime;

    uniform float uTimeScale;
    uniform float uWaveSpeed;
    uniform float uWaveHeight;

    uniform float uWave1Freq;
    uniform float uWave1Amp;
    uniform float uWave2Freq;
    uniform float uWave2Amp;
    uniform float uWave3FreqX;
    uniform float uWave3FreqZ;
    uniform float uWave3Amp;

    uniform float uNoiseAmount;
    uniform float uFoldingOffset;
    uniform float uStepBase;
    uniform float uGlowIntensity;
    uniform float uGlowSpread;
    uniform float uHue;

    float generateFineNoise(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 8.6231);
      p3 += dot(p3, p3.yzx + 67.92);
      return fract((p3.x + p3.y) * p3.z);
    }

    vec3 hueRotate(vec3 c, float a) {
      float ca = cos(a);
      float sa = sin(a);
      mat3 m = mat3(
        0.299 + 0.701 * ca + 0.168 * sa, 0.587 - 0.587 * ca + 0.330 * sa, 0.114 - 0.114 * ca - 0.497 * sa,
        0.299 - 0.299 * ca - 0.328 * sa, 0.587 + 0.413 * ca + 0.035 * sa, 0.114 - 0.114 * ca + 0.292 * sa,
        0.299 - 0.300 * ca + 1.250 * sa, 0.587 - 0.588 * ca - 1.050 * sa, 0.114 + 0.886 * ca - 0.203 * sa
      );
      return clamp(m * c, 0.0, 100.0);
    }

    void main() {
      vec2 fragCoord = gl_FragCoord.xy;
      vec2 uv = (2.0 * fragCoord - iResolution.xy) / iResolution.y;

      vec3 rayDir = normalize(vec3(uv, 1.0));

      vec4 finalColor = vec4(0.0);
      float totalDistance = 0.0;
      float timeElapsed = iTime * uTimeScale;

      float pixelNoise = generateFineNoise(fragCoord) * uNoiseAmount;

      for (int i = 0; i < 38; i++) {
        vec3 currentPos = rayDir * totalDistance;
        currentPos.z -= 2.0;

        float wTime = timeElapsed * uWaveSpeed;
        float waveHeight = (sin(currentPos.x * uWave1Freq + wTime) * uWave1Amp +
                            sin(currentPos.z * uWave2Freq - wTime * 0.6) * uWave2Amp +
                            sin((currentPos.x * uWave3FreqX) - (currentPos.z * uWave3FreqZ) + (wTime * 1.6)) * uWave3Amp) * uWaveHeight;

        float distToWave = abs(currentPos.y - waveHeight);

        currentPos /= uFoldingOffset;

        float stepSize = min(distToWave - 0.080, pixelNoise) + uStepBase;
        totalDistance += stepSize;

        float patternX = sin(currentPos.x + cos(currentPos.y) * cos(currentPos.z));
        float patternY = sin(currentPos.z + sin(currentPos.y) * cos(currentPos.x + timeElapsed));
        float basePattern = smoothstep(0.5, 0.7, patternX * patternY);

        float blendFactor = 0.15 / (distToWave * distToWave + 0.01);
        float mixedPattern = mix(basePattern, 1.0, blendFactor);

        float glow = uGlowIntensity / (uGlowSpread + stepSize);
        float distanceFade = smoothstep(36.5, 7.3, totalDistance);
        vec3 paletteColor = 1.0 + cos(totalDistance * 3.0 + vec3(0.0, 1.0, 2.0));

        finalColor.rgb += glow * mixedPattern * distanceFade * paletteColor;
      }

      if (uHue != 0.0) {
        finalColor.rgb = hueRotate(finalColor.rgb, uHue);
      }

      float dither = (generateFineNoise(fragCoord + vec2(12.34, 56.78)) - 0.5) / 128.0;
      finalColor.rgb += vec3(dither);

      gl_FragColor = vec4(finalColor.rgb, 1.0);
    }
  `,uniforms:b,depthTest:!1,depthWrite:!1}),S=new n(2,2),C=new t(S,x);v.add(C);let w=0;return{resize(e,t,n){_.setPixelRatio(n),_.setSize(e,t),b.iResolution.value.set(e*n,t*n,1)},frame({audio:e,settings:t,dt:n}){w+=n*t.speed;let r=e.spectrum({fftSize:1024,smoothing:.82}),i=r.length,a=Math.floor(i*.06),o=Math.floor(i*.25),s=Math.floor(i*.6),l=0;for(let e=2;e<a;e++)l+=r[e];l=l/Math.max(1,a-2)/255;let u=0;for(let e=a;e<o;e++)u+=r[e];u=u/Math.max(1,o-a)/255;let d=0;for(let e=o;e<s;e++)d+=r[e];d=d/Math.max(1,s-o)/255;let f=l*.55+u*.3+d*.15;p=p*.78+l*.22,m=m*.82+u*.18,h=h*.74+d*.26,g=g*.8+f*.2;let x=t.sensitivity,S=p*x,C=m*x,T=h*x,E=g*x;b.iTime.value=w,b.uTimeScale.value=c.timeScale*(1+E*.35),b.uWaveSpeed.value=c.waveSpeed*(1+C*.55),b.uWaveHeight.value=c.waveHeight*t.scale*(1+S*.7),b.uWave1Amp.value=c.wave1Amp*(1+S*.9),b.uWave2Amp.value=c.wave2Amp*(1+C*.6),b.uWave3Amp.value=c.wave3Amp*(1+S*.5+C*.3),b.uGlowIntensity.value=c.glowIntensity*(1+T*1.6+E*.4),b.uGlowSpread.value=c.glowSpread/Math.max(.4,t.scale),b.uHue.value=t.hueShift/360*Math.PI*2,_.render(v,y)},dispose(){S.dispose(),x.dispose(),a(_)}}};export{l as default};
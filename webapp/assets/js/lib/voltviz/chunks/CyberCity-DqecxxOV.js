import{$ as e,N as t,U as n,V as r,Z as i,d as a,et as o,r as s,st as c,t as l}from"./three-DIyfzUHm.js";import{i as u,r as d}from"./audio-Ds-N7sX7.js";var f=`
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`,p=`
  uniform float u_time;
  uniform vec2 u_resolution;
  uniform float u_flightSpeed;
  uniform float u_camPosY;
  uniform float u_camPitch;
  uniform vec3 u_dotColor;
  uniform vec3 u_scanColor;
  uniform vec3 u_buildingColor;
  uniform float u_dotDensity;
  uniform float u_fogDensity;
  uniform float u_scanPhase;
  uniform float u_scanPulse;
  uniform float u_lightFlash;
  uniform float u_planeFlash;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float map(vec3 p) {
    vec2 id = floor(p.xz);
    vec2 f = fract(p.xz) - 0.5;

    float d = p.y;

    for(int j = -1; j <= 1; j++) {
      for(int i = -1; i <= 1; i++) {
        vec2 offset = vec2(float(i), float(j));
        vec2 nId = id + offset;
        vec2 nF = f - offset;

        float height = hash(nId) * 4.0 + 1.0;

        vec3 q = vec3(nF.x, p.y - height * 0.5, nF.y);
        vec3 boxSize = vec3(0.35, height * 0.5, 0.35);

        vec3 distVec = abs(q) - boxSize;
        float boxDist = length(max(distVec, 0.0)) + min(max(distVec.x, max(distVec.y, distVec.z)), 0.0);

        d = min(d, boxDist);
      }
    }

    return d;
  }

  vec3 getNormal(vec3 p) {
    vec2 e = vec2(0.005, 0.0);
    return normalize(vec3(
      map(p + e.xyy) - map(p - e.xyy),
      map(p + e.yxy) - map(p - e.yxy),
      map(p + e.yyx) - map(p - e.yyx)
    ));
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / u_resolution.y;

    vec3 rayOrigin = vec3(0.0, u_camPosY, u_time * u_flightSpeed);
    vec3 rayDir = normalize(vec3(uv.x, uv.y - u_camPitch, 1.0));

    float distance = 0.0;
    vec3 p;

    for (int i = 0; i < 150; i++) {
      p = rayOrigin + rayDir * distance;
      float d = map(p);

      if (abs(d) < 0.001 || distance > 100.0) break;
      distance += d * 0.75;
    }

    vec3 fogColor = u_dotColor * 0.7;
    vec3 color = fogColor - uv.y * 0.2;

    float cycle = u_scanPhase;
    float scanY = (cycle < 4.0) ? (6.0 - cycle * 1.75) : -100.0;
    float scanEnvelope = smoothstep(0.0, 0.5, cycle) * smoothstep(4.0, 3.5, cycle);
    scanEnvelope *= u_scanPulse;

    if (distance < 100.0) {
      for(int j = 0; j < 3; j++) {
        distance += map(rayOrigin + rayDir * distance);
      }
      p = rayOrigin + rayDir * distance;

      vec3 normal = getNormal(p);
      vec3 absN = abs(normal);

      vec2 surfaceUV;
      if (absN.y > 0.5) {
        surfaceUV = p.xz;
      } else if (absN.z > 0.5) {
        surfaceUV = p.xy;
      } else {
        surfaceUV = p.zy;
      }

      float dotDensity = u_dotDensity;
      vec2 scaledUV = surfaceUV * dotDensity;
      vec2 gridUV = fract(scaledUV) - 0.5;

      float pixelSizeWorld = distance / u_resolution.y;
      float viewAngle = max(abs(dot(normal, rayDir)), 0.05);
      float pixelSizeUV = pixelSizeWorld / viewAngle;
      float pixelSizeTex = pixelSizeUV * dotDensity;

      float radius = 0.2;
      float distFromCenter = length(gridUV);
      float blur = max(pixelSizeTex * 0.8, 0.01);

      float dotPattern = smoothstep(radius + blur, radius - blur, distFromCenter);

      float fadeToAverage = smoothstep(0.15, 0.6, pixelSizeTex);
      dotPattern = mix(dotPattern, 0.125, fadeToAverage);

      float moireFade = smoothstep(25.0, 50.0, distance);
      dotPattern = mix(dotPattern, 0.125, moireFade);

      float distToScanner = abs(p.y - scanY);
      float scanCore = smoothstep(0.1, 0.0, distToScanner);
      float scanGlow = smoothstep(1.5, 0.0, distToScanner);

      // Window lights flash on the beat; each building gets its own weight so some light up more
      vec2 buildingId = floor(p.xz - normal.xz * 0.01);
      float lit = step(0.35, hash(buildingId + 7.0));
      vec3 dotBaseColor = u_dotColor * dotPattern * (1.0 + u_lightFlash * (0.6 + 2.4 * lit));
      vec3 materialColor = u_buildingColor + dotBaseColor;

      materialColor += u_scanColor * scanCore * 4.0 * scanEnvelope;
      materialColor += u_scanColor * scanGlow * dotPattern * 2.5 * scanEnvelope;

      vec3 lightDir = normalize(vec3(0.8, 0.6, -0.4));
      float diff = max(dot(normal, lightDir), 0.0);

      color = materialColor * diff + (materialColor * 0.3);
      color = mix(color, fogColor, 1.0 - exp(-u_fogDensity * distance));
    }

    float tPlane = (scanY - rayOrigin.y) / rayDir.y;

    if (tPlane > 0.0 && tPlane < min(distance, 100.0)) {
      vec3 planeHit = rayOrigin + rayDir * tPlane;

      // On the beat the grid lines thicken and burn hot, and the whole plate lights up
      float lineStart = 0.8 - 0.15 * u_planeFlash;
      float gridX = smoothstep(lineStart, 1.0, fract(planeHit.x * 2.0));
      float gridZ = smoothstep(lineStart, 1.0, fract(planeHit.z * 2.0));
      float planeGrid = max(gridX, gridZ);

      vec3 planeLayerColor = u_scanColor * (0.1 + planeGrid * 0.9 + u_planeFlash * 0.25)
        + vec3(planeGrid * u_planeFlash * 0.5);
      float planeAlpha = smoothstep(100.0, 0.0, tPlane) * (0.5 + u_planeFlash * 1.0) * scanEnvelope;

      color += planeLayerColor * planeAlpha;
    }

    color *= 1.0 - dot(uv, uv) * 0.5;

    gl_FragColor = vec4(color, 1.0);
  }
`,m=({container:m,width:h,height:g,dpr:_})=>{let v=0,y=1,b=Math.min(_,1)*.8,x=l(m,h,g,b,{antialias:!1});x.outputColorSpace=i;let S=new e,C=new r(-1,1,1,-1,.1,10);C.position.z=1;let w=new a(`#436e84`),T=new a(`#00ccff`),E=new a(`#1b202d`),D={h:0,s:0,l:0},O={h:0,s:0,l:0};w.getHSL(D),T.getHSL(O);let k=.5,A=.03,j=.6,M={u_time:{value:0},u_resolution:{value:new c(h*b,g*b)},u_flightSpeed:{value:k},u_camPosY:{value:10},u_camPitch:{value:j},u_dotColor:{value:w.clone()},u_scanColor:{value:T.clone()},u_buildingColor:{value:E.clone()},u_dotDensity:{value:12},u_fogDensity:{value:A},u_scanPhase:{value:0},u_scanPulse:{value:1},u_lightFlash:{value:0},u_planeFlash:{value:0}},N=new o({vertexShader:f,fragmentShader:p,uniforms:M}),P=new t(new n(2,2),N);S.add(P);let F=new a,I=new a,L=0,R=0,z=0,B=0,V=0;return{resize(e,t,n){b=Math.min(n,1)*.8,x.setPixelRatio(b),x.setSize(e,t),M.u_resolution.value.set(e*b,t*b)},frame({audio:e,settings:t,dt:n}){let r=performance.now(),i=e.spectrum({fftSize:2048,smoothing:.75}),a=i.length,o=e.sampleRate/2048,s=Math.min(Math.floor(60/o),a),c=Math.min(Math.floor(250/o),a),l=Math.min(Math.floor(2e3/o),a),f=Math.min(Math.floor(6e3/o),a),p=(e,t)=>{let n=0;for(let r=e;r<t;r++)n+=i[r];return t>e?n/((t-e)*255):0},m=p(0,s)*t.sensitivity,h=p(s,c)*t.sensitivity,g=p(c,l)*t.sensitivity,_=p(l,f)*t.sensitivity,b=p(f,a)*t.sensitivity;L+=((m+h)*.5-L)*.2,R+=(g-R)*.15,z+=((_+b)*.5-z)*.15;let w=d(e);w&&(v=r,y=u(e));let T=v>0?y*Math.max(0,1-(r-v)/200):0,E=n;M.u_time.value+=E*t.speed,M.u_flightSpeed.value=k*t.speed,B=(B+E*.7*t.speed*(1+R*1.4))%6,M.u_scanPhase.value=B,M.u_scanPulse.value=.85+T*1.4+z*.3,M.u_lightFlash.value=T,V=w?Math.max(y,V):V*Math.exp(-n/.18),M.u_planeFlash.value=Math.min(1.5,V*t.sensitivity),M.u_fogDensity.value=Math.max(.005,A-L*.018),M.u_dotDensity.value=12+z*6,M.u_camPosY.value=10,M.u_camPitch.value=j+R*.05;let N=1/Math.max(.5,Math.min(3,t.scale));M.u_camPosY.value*=N;let P=t.hueShift/360;F.setHSL((D.h+P+1)%1,D.s,D.l),I.setHSL((O.h+P+1)%1,O.s,O.l),M.u_dotColor.value.copy(F),M.u_scanColor.value.copy(I),x.render(S,C)},dispose(){P.geometry.dispose(),N.dispose(),s(x)}}};export{m as default};
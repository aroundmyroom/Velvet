import{H as e,N as t,Q as n,W as r,ct as i,d as a,et as o,lt as s,r as c,t as l,tt as u}from"./three-_gmPQh3Y.js";import{i as d,r as f}from"./audio-Ds-N7sX7.js";var p=`
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`,m=`
  precision highp float;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform int uMaxSteps;
  uniform int uFoldSteps;
  uniform float uKifsScale;
  uniform float uKifsOffset;
  uniform float uTextureScale;
  uniform float uBrightness;
  uniform float uSphereRadius;
  uniform float uInnerRadius;
  uniform vec3 uSphereCenter;
  uniform vec3 uBaseColor;
  uniform float uLightSpeed;
  uniform float uAutoRotationSpeed;
  uniform float uZoom;

  mat2 rotate2D(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c);
  }

  vec2 intersectSphere(vec3 rayOrigin, vec3 rayDir, vec3 center, float radius) {
    vec3 oc = rayOrigin - center;
    float b = dot(oc, rayDir);
    float c = dot(oc, oc) - radius * radius;
    float h = b * b - c;
    if (h < 0.0) return vec2(-1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  void main() {
    vec2 uvCenter = (2.0 * gl_FragCoord.xy - uResolution.xy) / uResolution.y;

    vec3 rayOriginWorld = vec3(0.0, 0.0, 0.0);
    vec3 rayDirectionWorld = normalize(vec3(uvCenter * uZoom, -1.0));

    vec3 localRayOrigin = rayOriginWorld - uSphereCenter;
    vec3 localRayDirection = rayDirectionWorld;

    vec2 hitOuter = intersectSphere(localRayOrigin, localRayDirection, vec3(0.0), uSphereRadius);

    if (hitOuter.x < 0.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    float tStart = max(0.0, hitOuter.x);
    float tEnd = hitOuter.y;

    float stepSize = (tEnd - tStart) / float(uMaxSteps);
    float currentDistance = tStart;

    vec4 accumulatedColor = vec4(0.0);

    for (int i = 0; i < 250; i++) {
      if (i >= uMaxSteps) break;

      vec3 localPos = localRayOrigin + localRayDirection * currentDistance;
      float distFromCenter = length(localPos);

      float wallMask = smoothstep(uInnerRadius, uInnerRadius + 1.0, distFromCenter)
                     * smoothstep(uSphereRadius, uSphereRadius - 0.2, distFromCenter);

      if (wallMask > 0.01) {
        vec3 currentPos = localPos * uTextureScale;

        currentPos.xy *= rotate2D(uTime * 0.15 * uAutoRotationSpeed);
        currentPos.xz *= rotate2D(uTime * 0.10 * uAutoRotationSpeed);

        currentPos = abs(currentPos);

        float timeVal = 2.6 + float(i) * 0.356;
        vec3 reflectionAxis = normalize(tan(timeVal + vec3(2.5, 1.0, 0.0)));
        currentPos = reflect(-currentPos, reflectionAxis) - vec3(-2.6, -1.0, 0.2);

        float accumulatedScale = 0.1;

        if (currentPos.x < currentPos.z) {
          currentPos = currentPos.zyx;
        }

        for (int k = 0; k < 16; k++) {
          if (k >= uFoldSteps) break;
          currentPos *= uKifsScale;
          accumulatedScale *= uKifsScale;
          currentPos.y += uKifsOffset;

          if (currentPos.y > currentPos.z) currentPos = currentPos.xzy;

          currentPos *= uKifsScale;
          accumulatedScale *= uKifsScale;
          currentPos.y += uKifsOffset;

          if (currentPos.x < currentPos.y) currentPos = currentPos.yxz;
        }

        float currentDensity = max(length(currentPos.xz) / accumulatedScale, 0.001);

        vec3 spatialPhase = currentPos.xyz;
        vec3 lightIntensity = exp(sin(uTime * uLightSpeed + spatialPhase)) / currentDensity;

        accumulatedColor.rgb += uBaseColor * lightIntensity * stepSize * uBrightness * wallMask;
      }

      currentDistance += stepSize;
    }

    gl_FragColor.rgb = tanh(accumulatedColor.rgb);
    gl_FragColor.a = 1.0;

    vec3 localHitPoint = localRayOrigin + localRayDirection * hitOuter.x;
    vec3 surfaceNormalLocal = normalize(localHitPoint);
    float edgeHighlight = 0.7 - max(dot(-localRayDirection, surfaceNormalLocal), 0.5);
    gl_FragColor.rgb += uBaseColor * 0.08 * pow(edgeHighlight, 4.0);
  }
`,h=({container:h,width:g,height:_,dpr:v})=>{let y=Math.min(v,1)*.8,b=l(h,g,_,y,{antialias:!1});b.outputColorSpace=n;let x=new o,S=new e(-1,1,1,-1,.1,10);S.position.z=1;let C=1.26,w=1.45,T=1.423,E=5.5,D=new a(`#7780ff`),O={h:0,s:0,l:0};D.getHSL(O);let k={uResolution:{value:new i(g*y,_*y)},uTime:{value:0},uMaxSteps:{value:148},uFoldSteps:{value:6},uKifsScale:{value:C},uKifsOffset:{value:8.9},uTextureScale:{value:w},uBrightness:{value:T},uSphereRadius:{value:15},uInnerRadius:{value:14},uSphereCenter:{value:new s(0,0,-25)},uBaseColor:{value:new s},uLightSpeed:{value:E},uAutoRotationSpeed:{value:1},uZoom:{value:1}},A=new u({vertexShader:p,fragmentShader:m,uniforms:k,depthWrite:!1,depthTest:!1}),j=new t(new r(2,2),A);x.add(j);let M=new a,N=0,P=0,F=0,I=0,L=1;return{resize(e,t,n){y=Math.min(n,1)*.8,b.setPixelRatio(y),b.setSize(e,t),k.uResolution.value.set(e*y,t*y)},frame({audio:e,settings:t,dt:n}){let r=performance.now(),i=e.spectrum({fftSize:2048,smoothing:.75}),a=i.length,o=e.sampleRate/2048,s=Math.min(Math.floor(60/o),a),c=Math.min(Math.floor(250/o),a),l=Math.min(Math.floor(2e3/o),a),u=Math.min(Math.floor(6e3/o),a),p=(e,t)=>{let n=0;for(let r=e;r<t;r++)n+=i[r];return t>e?n/((t-e)*255):0},m=p(0,s)*t.sensitivity,h=p(s,c)*t.sensitivity,g=p(c,l)*t.sensitivity,_=p(l,u)*t.sensitivity,v=p(u,a)*t.sensitivity;N+=((m+h)*.5-N)*.2,P+=(g-P)*.15,F+=((_+v)*.5-F)*.15,f(e)&&(I=r,L=d(e));let y=I>0?L*Math.max(0,1-(r-I)/200):0,D=n;k.uTime.value+=D*t.speed,k.uAutoRotationSpeed.value=1*t.speed*(1+P*.3),k.uLightSpeed.value=E*t.speed*(1+P*.5),k.uKifsScale.value=C+N*.04+y*.03,k.uTextureScale.value=w+F*.25,k.uBrightness.value=T*(1+N*.6)+y*1.2;let A=Math.max(.5,Math.min(3,t.scale));k.uZoom.value=1/A;let j=t.hueShift/360;M.setHSL((O.h+j+1)%1,O.s,O.l),k.uBaseColor.value.set(M.r*3,M.g*3,M.b*3),b.render(x,S)},dispose(){j.geometry.dispose(),A.dispose(),c(b)}}};export{h as default};
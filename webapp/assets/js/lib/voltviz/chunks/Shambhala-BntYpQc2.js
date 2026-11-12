import{H as e,N as t,W as n,ct as r,et as i,lt as a,r as o,t as s,tt as c}from"./three-_gmPQh3Y.js";var l=`
  void main() {
    gl_Position = vec4(position, 1.0);
  }
`,u=`
  uniform float iTime;
  uniform vec2 iResolution;
  uniform float u_speed;
  uniform float u_glowIntensity;
  uniform float u_exposure;
  uniform float u_voxelResolution;
  uniform float u_tunnelRadius;
  uniform vec3 u_colorPhasePrimary;
  uniform vec3 u_colorPhaseSecondary;
  uniform vec3 u_foldingAxis;

  #define MAX_RAY_STEPS 110
  #define STEP_MULTIPLIER 0.23

  vec3 custom_tanh(vec3 x) {
    vec3 e = exp(2.0 * x);
    return (e - 1.0) / (e + 1.0);
  }

  vec3 applySpaceReflection(vec3 position, vec3 axis) {
    return 36.4 * dot(axis, position) * axis - position;
  }

  vec3 calculateDisplacement(vec3 pos, float scale) {
    return (1.1 / scale) * sin(pos.zxy * scale + 3.0 * scale);
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - iResolution.xy) / iResolution.y;

    vec3 rayOrigin = vec3(0.0, 0.0, iTime * u_speed);
    vec3 rayDir = normalize(vec3(uv, 1.0));

    vec3 foldingAxis = normalize(tan(u_foldingAxis));

    float traveledDistance = 0.5;
    vec3 accumulatedColor = vec3(0.0);

    float tRot = iTime * 0.3;
    mat2 timeRotation = mat2(cos(tRot), cos(tRot + 8.0), cos(tRot + 30.0), cos(tRot));

    vec3 precomputedCoreAnim = u_glowIntensity * exp(sin(iTime * 2.0 + u_colorPhaseSecondary));

    vec3 currentPhase = u_colorPhasePrimary;

    for (int stepIndex = 0; stepIndex < MAX_RAY_STEPS; stepIndex++) {
      vec3 currentPos = rayOrigin + rayDir * traveledDistance;

      float tunnelDist = max(abs(currentPos.x), abs(currentPos.y)) - u_tunnelRadius;

      vec3 fractalPos = currentPos;

      fractalPos.z = abs(mod(fractalPos.z, 7.0) - 3.5);
      fractalPos = applySpaceReflection(fractalPos, foldingAxis);

      fractalPos = log(abs(fractalPos) + 1.03);

      fractalPos = ceil(fractalPos * u_voxelResolution) / u_voxelResolution;

      float maxIter = 21.0 - clamp(traveledDistance * 0.7, 0.0, 16.0);

      for (float iter = 2.0; iter <= 20.9; iter += 1.6) {
        if (iter > maxIter) break;
        fractalPos += calculateDisplacement(fractalPos, iter);
      }

      fractalPos.yz *= timeRotation;
      fractalPos += calculateDisplacement(fractalPos, 1.0);

      float localDensity = abs(tunnelDist) + abs(fractalPos.x) * 0.15 + 0.04;

      vec3 primaryEmission = exp(sin(currentPhase)) / localDensity;
      currentPhase += 0.2;

      float sqDistToCenter = dot(currentPos.xy, currentPos.xy);
      vec3 coreEmission = precomputedCoreAnim / (sqDistToCenter + 1.5);

      accumulatedColor += primaryEmission * 0.5 + coreEmission * 0.05;

      traveledDistance += localDensity * STEP_MULTIPLIER;

      if (traveledDistance > 45.0 || max(accumulatedColor.x, max(accumulatedColor.y, accumulatedColor.z)) > 1000.0) {
        break;
      }
    }

    gl_FragColor = vec4(custom_tanh(accumulatedColor / u_exposure), 1.0);
  }
`;function d(e,t){let n=new a(1,1,1).normalize(),r=Math.cos(t),i=Math.sin(t),o=e.x*n.x+e.y*n.y+e.z*n.z;return new a(e.x*r+(n.y*e.z-n.z*e.y)*i+n.x*o*(1-r),e.y*r+(n.z*e.x-n.x*e.z)*i+n.y*o*(1-r),e.z*r+(n.x*e.y-n.y*e.x)*i+n.z*o*(1-r))}var f=({container:f,width:p,height:m,dpr:h})=>{let g=Math.min(h,1)*.6,_=s(f,p,m,g,{antialias:!1}),v=new i,y=new e(-1,1,1,-1,0,1),b=.3,x=15.8,S=256.5,C=3.3,w=new a(.1,2,4),T=new a(0,1,2),E=new a(3.145,1.79,7.81),D={iTime:{value:0},iResolution:{value:new r(p*g,m*g)},u_speed:{value:b},u_glowIntensity:{value:x},u_exposure:{value:S},u_voxelResolution:{value:55},u_tunnelRadius:{value:C},u_colorPhasePrimary:{value:w.clone()},u_colorPhaseSecondary:{value:T.clone()},u_foldingAxis:{value:E.clone()}},O=new c({vertexShader:l,fragmentShader:u,uniforms:D}),k=new t(new n(2,2),O);v.add(k);let A=0,j=0,M=0,N=0,P=0;return{resize(e,t,n){g=Math.min(n,1)*.6,_.setPixelRatio(g),_.setSize(e,t),D.iResolution.value.set(e*g,t*g)},frame({audio:e,settings:t,dt:n}){let r=e.spectrum({fftSize:2048,smoothing:.75}),i=r.length,o=e.sampleRate/2048,s=Math.min(Math.floor(60/o),i),c=Math.min(Math.floor(250/o),i),l=Math.min(Math.floor(2e3/o),i),u=Math.min(Math.floor(6e3/o),i),f=(e,t)=>{let n=0;for(let i=e;i<t;i++)n+=r[i];return t>e?n/((t-e)*255):0},p=f(0,s)*t.sensitivity,m=f(s,c)*t.sensitivity,h=f(c,l)*t.sensitivity,g=f(l,u)*t.sensitivity,O=f(u,i)*t.sensitivity;A+=(p-A)*.25,j+=(m-j)*.2,M+=(h-M)*.15,N+=((g+O)*.5-N)*.15;let k=n;P+=k*(.3+N*1.5),D.iTime.value+=k*t.speed,D.u_speed.value=b*t.speed*(1+j*2.5),D.u_glowIntensity.value=x+A*35,D.u_exposure.value=Math.max(60,S-N*140),D.u_voxelResolution.value=55+M*40;let F=Math.max(.5,Math.min(3,t.scale));D.u_tunnelRadius.value=(C+j*1.2)*F;let I=M*.4;D.u_foldingAxis.value.set(E.x+Math.sin(P*.7)*I,E.y+Math.cos(P*.9)*I,E.z+Math.sin(P*1.1)*I);let L=P*.5,R=P*.3+j*2,z=new a(w.x+Math.sin(L)*.6,w.y+Math.sin(L+2)*.6,w.z+Math.sin(L+4)*.6),B=new a(T.x+Math.sin(R)*.8,T.y+Math.sin(R+1.5)*.8,T.z+Math.sin(R+3)*.8),V=t.hueShift/360*Math.PI*2;D.u_colorPhasePrimary.value.copy(d(z,V)),D.u_colorPhaseSecondary.value.copy(d(B,V)),_.render(v,y)},dispose(){k.geometry.dispose(),O.dispose(),o(_)}}};export{f as default};
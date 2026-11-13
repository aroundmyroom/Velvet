import{$ as e,H as t,N as n,Z as r,d as i,et as a,r as o,st as s,t as c,w as l}from"./three-DIyfzUHm.js";import{n as u,t as d}from"./RenderPass-dJHevfz0.js";import{n as f,t as p}from"./OutputPass-ZjOsIvyu.js";var m=`
  uniform float u_time;
  uniform float u_frequency;

  vec3 mod289(vec3 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
  }

  vec4 mod289(vec4 x) {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
  }

  vec4 permute(vec4 x) {
    return mod289(((x*34.0)+10.0)*x);
  }

  vec4 taylorInvSqrt(vec4 r) {
    return 1.79284291400159 - 0.85373472095314 * r;
  }

  vec3 fade(vec3 t) {
    return t*t*t*(t*(t*6.0-15.0)+10.0);
  }

  float pnoise(vec3 P, vec3 rep) {
    vec3 Pi0 = mod(floor(P), rep);
    vec3 Pi1 = mod(Pi0 + vec3(1.0), rep);
    Pi0 = mod289(Pi0);
    Pi1 = mod289(Pi1);
    vec3 Pf0 = fract(P);
    vec3 Pf1 = Pf0 - vec3(1.0);
    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
    vec4 iy = vec4(Pi0.yy, Pi1.yy);
    vec4 iz0 = Pi0.zzzz;
    vec4 iz1 = Pi1.zzzz;

    vec4 ixy = permute(permute(ix) + iy);
    vec4 ixy0 = permute(ixy + iz0);
    vec4 ixy1 = permute(ixy + iz1);

    vec4 gx0 = ixy0 * (1.0 / 7.0);
    vec4 gy0 = fract(floor(gx0) * (1.0 / 7.0)) - 0.5;
    gx0 = fract(gx0);
    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0);
    vec4 sz0 = step(gz0, vec4(0.0));
    gx0 -= sz0 * (step(0.0, gx0) - 0.5);
    gy0 -= sz0 * (step(0.0, gy0) - 0.5);

    vec4 gx1 = ixy1 * (1.0 / 7.0);
    vec4 gy1 = fract(floor(gx1) * (1.0 / 7.0)) - 0.5;
    gx1 = fract(gx1);
    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1);
    vec4 sz1 = step(gz1, vec4(0.0));
    gx1 -= sz1 * (step(0.0, gx1) - 0.5);
    gy1 -= sz1 * (step(0.0, gy1) - 0.5);

    vec3 g000 = vec3(gx0.x,gy0.x,gz0.x);
    vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
    vec3 g010 = vec3(gx0.z,gy0.z,gz0.z);
    vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
    vec3 g001 = vec3(gx1.x,gy1.x,gz1.x);
    vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
    vec3 g011 = vec3(gx1.z,gy1.z,gz1.z);
    vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);

    vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
    g000 *= norm0.x;
    g010 *= norm0.y;
    g100 *= norm0.z;
    g110 *= norm0.w;
    vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
    g001 *= norm1.x;
    g011 *= norm1.y;
    g101 *= norm1.z;
    g111 *= norm1.w;

    float n000 = dot(g000, Pf0);
    float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
    float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
    float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
    float n111 = dot(g111, Pf1);

    vec3 fade_xyz = fade(Pf0);
    vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
    float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
    return 2.2 * n_xyz;
  }

  void main() {
      float noise = 3.0 * pnoise(position + u_time, vec3(10.0));
      float displacement = (u_frequency / 30.) * (noise / 10.);
      vec3 newPosition = position + normal * displacement;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`,h=`
  uniform float u_red;
  uniform float u_blue;
  uniform float u_green;
  void main() {
      gl_FragColor = vec4(vec3(u_red, u_green, u_blue), 1. );
  }
`,g=({container:g,width:_,height:v,dpr:y})=>{let b=c(g,_,v,y,{antialias:!0});b.outputColorSpace=r;let x=new e,S=new t(45,_/v,.1,1e3);S.position.set(0,-2,14),S.lookAt(0,0,0);let C=new d(x,S),w=new f(new s(_,v),.5,.8,.1),T=new u(b);T.addPass(C),T.addPass(w);let E=new p;T.addPass(E);let D={u_time:{value:0},u_frequency:{value:0},u_red:{value:1},u_green:{value:1},u_blue:{value:1}},O=new a({uniforms:D,vertexShader:m,fragmentShader:h,wireframe:!0}),k=new l(4,30),A=new n(k,O);x.add(A);let j=0,M=0,N=e=>{let t=window.innerWidth/2,n=window.innerHeight/2;j=(e.clientX-t)/100,M=(e.clientY-n)/100};window.addEventListener(`mousemove`,N);let P=new i;return{resize(e,t,n){b.setPixelRatio(n),T.setPixelRatio(n),b.setSize(e,t),T.setSize(e,t),S.aspect=e/t,S.updateProjectionMatrix()},frame({audio:e,settings:t,time:n}){let r=e.spectrum({fftSize:256,smoothing:.8}),i=r.reduce((e,t)=>e+t,0)/r.length;S.position.x+=(j-S.position.x)*.05,S.position.y+=(-M-S.position.y)*.05,S.lookAt(x.position);let a=n;D.u_time.value=a*t.speed,D.u_frequency.value=i*t.scale;let o=(t.hueShift/360+a*.02)%1;P.setHSL(o,.7,.6),D.u_red.value=P.r,D.u_green.value=P.g,D.u_blue.value=P.b,T.render()},dispose(){window.removeEventListener(`mousemove`,N),k.dispose(),O.dispose();for(let e of T.passes)e.dispose();T.dispose(),o(b)}}};export{g as default};
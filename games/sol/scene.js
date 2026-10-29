import * as T from './vendor/three.module.min.js';
import {terrainHeight,valleyCenter,clamp} from './physics.js';
let seed=314159;function random(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;}
const sunDir=new T.Vector3(-.62,.34,-.48).normalize();
export function createWorld(canvas,route){
 const renderer=new T.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
 renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
 renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
 const scene=new T.Scene();scene.background=new T.Color('#aac2ce');scene.fog=new T.FogExp2('#b0c7cf',.000105);
 const camera=new T.PerspectiveCamera(57,innerWidth/innerHeight,.8,42000);
 scene.add(new T.HemisphereLight('#d4e6f1','#69644c',2));
 const sunlight=new T.DirectionalLight('#fff0d0',3.3);sunlight.position.copy(sunDir).multiplyScalar(1000);scene.add(sunlight);
 const sky=new T.Mesh(new T.SphereGeometry(35000,40,24),new T.ShaderMaterial({side:T.BackSide,depthWrite:false,uniforms:{sun:{value:sunDir}},vertexShader:`varying vec3 vDirection;void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,fragmentShader:`uniform vec3 sun;varying vec3 vDirection;void main(){vec3 d=normalize(vDirection);float h=max(d.y,0.);vec3 col=mix(vec3(.69,.77,.78),vec3(.20,.40,.60),pow(h,.45));float s=max(dot(d,sun),0.);col+=vec3(.38,.27,.13)*pow(s,9.);col+=vec3(2.8,2.25,1.4)*pow(s,3300.);gl_FragColor=vec4(col,1.);#include <tonemapping_fragment>\n#include <colorspace_fragment>}`.replace(';#include',';\n#include')}));
 sky.frustumCulled=false;sky.renderOrder=-10;scene.add(sky);
 const groundGeo=new T.PlaneGeometry(18000,37000,256,512);groundGeo.rotateX(-Math.PI/2);groundGeo.translate(0,0,-10500);
 const p=groundGeo.attributes.position,colors=[];const color=new T.Color();
 for(let i=0;i<p.count;i++){const x=p.getX(i),z=p.getZ(i),h=terrainHeight(x,z);p.setY(i,h);const noise=Math.sin(x*.007)*Math.cos(z*.009)*.09;color.setRGB(.28+noise,.32+noise,.22+noise);if(h>480)color.lerp(new T.Color('#8d8d79'),clamp((h-480)/500,0,.8));colors.push(color.r,color.g,color.b);}
 groundGeo.setAttribute('color',new T.Float32BufferAttribute(colors,3));groundGeo.computeVertexNormals();
 const groundMaterial=new T.MeshStandardMaterial({vertexColors:true,roughness:1,metalness:0});
 groundMaterial.onBeforeCompile=shader=>{
 shader.vertexShader='varying vec3 vLand;varying vec3 vLandNormal;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvLand=position;vLandNormal=normal;');
 shader.fragmentShader='varying vec3 vLand;varying vec3 vLandNormal;\nfloat hashLand(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\nfloat nLand(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hashLand(i),hashLand(i+vec2(1,0)),f.x),mix(hashLand(i+vec2(0,1)),hashLand(i+vec2(1,1)),f.x),f.y);}\n'+shader.fragmentShader;
 shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
 float grain=nLand(vLand.xz*.012)*.5+nLand(vLand.xz*.07)*.25+nLand(vLand.xz*.35)*.125;
 float slope=1.-abs(normalize(vLandNormal).y);float rock=smoothstep(.18,.65,slope);
 diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.41,.40,.34),rock*.8);
 diffuseColor.rgb*=.65+grain*.9;
 float strata=sin(vLand.y*.17+nLand(vLand.xz*.009)*6.);diffuseColor.rgb*=1.+strata*rock*.09;
 if(vLand.y<12.)diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.49,.46,.33),.65);`);
 };
 const ground=new T.Mesh(groundGeo,groundMaterial);scene.add(ground);
 const waterUniforms={time:{value:0},sun:{value:sunDir},eye:{value:camera.position}};
 const water=new T.Mesh(new T.PlaneGeometry(70000,70000),new T.ShaderMaterial({uniforms:waterUniforms,vertexShader:`varying vec3 vWorld;void main(){vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(vWorld,1.);}`,fragmentShader:`varying vec3 vWorld;uniform float time;uniform vec3 sun;uniform vec3 eye;
 void main(){vec2 p=vWorld.xz;float dist=length(eye-vWorld);float waveFade=1.-smoothstep(700.,4500.,dist);float w1=sin(p.x*.027+p.y*.039+time*.7);float w2=sin(p.x*.063-p.y*.022-time*.9);vec3 n=normalize(vec3(w1*.035*waveFade,1.,w2*.04*waveFade));vec3 v=normalize(eye-vWorld);float fres=pow(1.-max(dot(n,v),0.),3.);vec3 c=mix(vec3(.038,.12,.14),vec3(.29,.44,.48),fres*.8);float spec=pow(max(dot(reflect(-sun,n),v),0.),100.);c+=vec3(1.5,1.25,.8)*spec*.9;c=mix(c,vec3(.58,.69,.73),1.-exp(-dist*.000095));gl_FragColor=vec4(c,1.);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>}` }));
 water.rotation.x=-Math.PI/2;water.position.y=.2;scene.add(water);
 // A small procedural sprite is reused by every cloud instance; no network textures.
 const cc=document.createElement('canvas');cc.width=128;cc.height=128;const cx=cc.getContext('2d');const gradient=cx.createRadialGradient(64,64,0,64,64,63);gradient.addColorStop(0,'rgba(255,255,255,.7)');gradient.addColorStop(.45,'rgba(245,248,248,.45)');gradient.addColorStop(1,'rgba(224,231,234,0)');cx.fillStyle=gradient;cx.fillRect(0,0,128,128);const cloudTexture=new T.CanvasTexture(cc);
 const cloudMaterial=new T.ShaderMaterial({transparent:true,depthWrite:false,uniforms:{map:{value:cloudTexture}},vertexShader:`varying vec2 vUv;varying float vDepth;void main(){vUv=uv;vec4 mv=modelViewMatrix*instanceMatrix*vec4(0.,0.,0.,1.);float sx=length(instanceMatrix[0].xyz);float sy=length(instanceMatrix[1].xyz);mv.xy+=position.xy*vec2(sx,sy);vDepth=-mv.z;gl_Position=projectionMatrix*mv;}`,fragmentShader:`varying vec2 vUv;varying float vDepth;uniform sampler2D map;void main(){vec4 tex=texture2D(map,vUv);float fade=smoothstep(0.,180.,vDepth)*(1.-smoothstep(16000.,29000.,vDepth));vec3 c=mix(vec3(.63,.70,.74),vec3(.96,.95,.91),smoothstep(0.,1.,vUv.y));gl_FragColor=vec4(c,tex.a*.60*fade);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>}`});
 const clouds=new T.InstancedMesh(new T.PlaneGeometry(1,1),cloudMaterial,420);const dummy=new T.Object3D();
 for(let i=0;i<420;i++){const group=Math.floor(i/5);seed=group*5917+17;const x=(random()-.5)*17500,y=1200+random()*1400,z=4500-random()*33000;seed=i*9157+31;dummy.position.set(x+(random()-.5)*900,y+(random()-.5)*160,z+(random()-.5)*500);dummy.scale.set(650+random()*600,200+random()*250,1);dummy.updateMatrix();clouds.setMatrixAt(i,dummy.matrix);}clouds.frustumCulled=false;scene.add(clouds);
 const gates=route.map((g,i)=>{const group=new T.Group();group.position.set(g.x,g.y,g.z);const ring=new T.Mesh(new T.TorusGeometry(g.radius,1.7,8,72),new T.MeshBasicMaterial({color:i===0?'#ffd197':'#c4d8d8',transparent:true,opacity:i===0?.92:.3}));group.add(ring);const tickMat=new T.MeshBasicMaterial({color:'#f6ce96'});for(let k=0;k<4;k++){const tick=new T.Mesh(new T.BoxGeometry(15,2,2),tickMat);tick.position.set(Math.cos(k*Math.PI/2)*(g.radius+11),Math.sin(k*Math.PI/2)*(g.radius+11),0);tick.rotation.z=k*Math.PI/2;group.add(tick);}scene.add(group);return group;});
 const plane=createAircraft();scene.add(plane);
 const shadow=new T.Mesh(new T.CircleGeometry(1,32),new T.MeshBasicMaterial({color:'#172724',transparent:true,opacity:.13,depthWrite:false}));shadow.rotation.x=-Math.PI/2;scene.add(shadow);
 const exhausts=[];for(const x of [-1.8,1.8]){const mesh=new T.Mesh(new T.ConeGeometry(.7,7,16,1,true),new T.MeshBasicMaterial({color:'#f2ac6f',transparent:true,opacity:.5,side:T.DoubleSide,depthWrite:false}));mesh.rotation.x=Math.PI/2;mesh.position.set(x,-.1,9.7);plane.add(mesh);exhausts.push(mesh);}
 const trailsGeo=new T.BufferGeometry();const trailsPositions=new Float32Array(80*3*2);trailsGeo.setAttribute('position',new T.BufferAttribute(trailsPositions,3));const trails=new T.LineSegments(trailsGeo,new T.LineBasicMaterial({color:'#e4eef0',transparent:true,opacity:.18}));scene.add(trails);const history=[];
 let cockpit=false,quality='balanced',lastGate=-1;const cameraTarget=new T.Vector3(),desired=new T.Vector3(),forward=new T.Vector3(),look=new T.Vector3(),up=new T.Vector3(),q=new T.Quaternion();
 function resetCamera(s,menu=false){plane.position.set(s.x,s.y,s.z);plane.rotation.set(s.pitch,s.yaw,s.roll,'YXZ');desired.set(menu?-22:0,menu?8:10,menu?35:44).applyQuaternion(plane.quaternion).add(plane.position);camera.position.copy(desired);history.length=0;}
 function update(s,dt,mode,elapsed){const menu=mode==='menu';plane.position.set(s.x,s.y,s.z);plane.rotation.set(s.pitch,s.yaw,s.roll,'YXZ');if(menu){plane.rotation.z=-.10;plane.position.y+=Math.sin(elapsed*.6)*.45;}
  plane.visible=!cockpit||menu;forward.set(0,0,-1).applyQuaternion(plane.quaternion);q.copy(plane.quaternion);
  desired.set(cockpit&&!menu?0:menu?-22:0,cockpit&&!menu?1.9:menu?8:10,cockpit&&!menu?-6:menu?35:44).applyQuaternion(q).add(plane.position);
  desired.y=Math.max(desired.y,Math.max(0,terrainHeight(desired.x,desired.z))+6);
  camera.position.lerp(desired,1-Math.exp(-dt*(cockpit?16:5)));cameraTarget.copy(plane.position).addScaledVector(forward,cockpit?300:75);cameraTarget.y+=menu?2:5;
  up.set(0,1,0).applyQuaternion(q);if(!cockpit||menu)up.lerp(new T.Vector3(0,1,0),.85);camera.up.lerp(up,1-Math.exp(-dt*3)).normalize();camera.lookAt(cameraTarget);
  const speed=Math.hypot(s.vx,s.vy,s.vz);const targetFov=cockpit?66:57+clamp((speed-145)/35,0,7);camera.fov+=(targetFov-camera.fov)*Math.min(1,dt*2);camera.updateProjectionMatrix();
  sky.position.copy(camera.position);waterUniforms.time.value=elapsed;
  shadow.position.set(s.x,Math.max(.5,terrainHeight(s.x,s.z)+.7),s.z);shadow.scale.set(10+s.y*.01,7+s.y*.008,1);shadow.material.opacity=.12*clamp(1-(s.y-terrainHeight(s.x,s.z))/1000,0,1);
  exhausts.forEach((e,i)=>{e.scale.y=.45+s.throttle*.8+Math.sin(elapsed*21+i)*.05;e.material.opacity=.22+s.throttle*.4;});
  if(mode==='flying'){history.unshift(plane.position.clone());if(history.length>81)history.pop();for(let i=0;i<80;i++){const a=history[Math.min(i,history.length-1)]||plane.position,b=history[Math.min(i+1,history.length-1)]||a;trailsPositions.set([a.x,a.y-.6,a.z+8,b.x,b.y-.6,b.z+8],i*6);}trailsGeo.attributes.position.needsUpdate=true;trailsGeo.computeBoundingSphere();}trails.visible=mode==='flying'&&!cockpit&&s.throttle>.82;
  if(s.gate!==lastGate){gates.forEach((gate,i)=>{gate.visible=i>=s.gate&&i<s.gate+5;gate.children[0].material.color.set(i===s.gate?'#ffce8e':'#c4d8d8');gate.children[0].material.opacity=i===s.gate?.9:.25;});lastGate=s.gate;}
  renderer.render(scene,camera);
 }
 function setQuality(value){quality=value;renderer.setPixelRatio(Math.min(devicePixelRatio,value==='high'?2:value==='low'?1:1.5));clouds.count=value==='low'?160:420;renderer.setSize(innerWidth,innerHeight);}
 function resize(){camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);}
 return {renderer,scene,camera,plane,gates,update,resetCamera,setQuality,resize,toggleCamera(){cockpit=!cockpit;return cockpit;},get cockpit(){return cockpit;},projectTarget(g){return new T.Vector3(g.x,g.y,g.z).project(camera);},getStats(){return {calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,quality};}};
}
function createAircraft(){
 const root=new T.Group();const metal=new T.MeshStandardMaterial({color:'#a1adae',metalness:.55,roughness:.36});const dark=new T.MeshStandardMaterial({color:'#293738',metalness:.5,roughness:.4});const edge=new T.MeshStandardMaterial({color:'#c4ccca',metalness:.45,roughness:.32});const glass=new T.MeshPhysicalMaterial({color:'#345c66',metalness:.65,roughness:.15,clearcoat:1});
 const points=[new T.Vector2(.55,-7.5),new T.Vector2(1.05,-6.5),new T.Vector2(1.30,-3),new T.Vector2(1.40,1),new T.Vector2(1.10,5),new T.Vector2(.45,8),new T.Vector2(.03,10)];
 const body=new T.Mesh(new T.LatheGeometry(points,36),metal);body.rotation.x=-Math.PI/2;root.add(body);
 function sphere(x,y,z,sx,sy,sz,mat){const m=new T.Mesh(new T.SphereGeometry(1,24,16),mat);m.position.set(x,y,z);m.scale.set(sx,sy,sz);root.add(m);return m;}
 sphere(0,1.15,-3.4,.82,1.05,2.9,dark);sphere(0,1.45,-3.8,.73,.88,2.35,glass);
 function panel(vertices,mat,thickness=.13){const shape=new T.Shape();vertices.forEach(([x,z],i)=>i?shape.lineTo(x,z):shape.moveTo(x,z));shape.closePath();const geo=new T.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false});geo.rotateX(Math.PI/2);const m=new T.Mesh(geo,mat);root.add(m);return m;}
 for(const side of [-1,1]){
  panel([[side*1,-2.2],[side*8.7,3.6],[side*8.3,4.7],[side*1,4.2]],metal,.20);
  const flap=panel([[side*2.6,3.4],[side*7.5,4.1],[side*7.5,4.6],[side*2.6,4.2]],edge,.08);flap.position.y=.03;
  panel([[side*.8,5.5],[side*4.6,7.7],[side*4.1,8.6],[side*.7,7.6]],metal);
  const engine=new T.Mesh(new T.CylinderGeometry(.91,.78,8.7,28),metal);engine.rotation.x=Math.PI/2;engine.position.set(side*1.75,-.10,3.3);root.add(engine);
  const intake=new T.Mesh(new T.CircleGeometry(.76,28),dark);intake.rotation.y=Math.PI;intake.position.set(side*1.75,-.1,-1.06);root.add(intake);
  const nozzle=new T.Mesh(new T.CylinderGeometry(.70,.82,1.6,24,1,true),dark);nozzle.rotation.x=Math.PI/2;nozzle.position.set(side*1.75,-.1,7.9);root.add(nozzle);
  const throat=new T.Mesh(new T.CircleGeometry(.60,24),new T.MeshBasicMaterial({color:'#a8653c'}));throat.position.set(side*1.75,-.1,8.6);root.add(throat);
  const finShape=new T.Shape();finShape.moveTo(4.5,0);finShape.lineTo(6.9,3.5);finShape.lineTo(8.5,3.1);finShape.lineTo(8.6,0);finShape.closePath();const finGeo=new T.ExtrudeGeometry(finShape,{depth:.13,bevelEnabled:false});finGeo.rotateY(-Math.PI/2);const fin=new T.Mesh(finGeo,metal);fin.position.set(side*1.1,.6,0);fin.rotation.z=side*-.17;root.add(fin);
  const light=sphere(side*8.55,.14,4.15,.12,.09,.15,new T.MeshBasicMaterial({color:side<0?'#e9a789':'#b0d5ce'}));
  const stripe=panel([[side*5.6,1.45],[side*6,1.75],[side*5.6,4.3],[side*5.2,4.25]],dark,.04);stripe.position.y=.14;
  // Pylon fairings, wingtip rails and fine panel seams give the silhouette scale.
  for(const x of [3.8,6.5]){const rail=new T.Mesh(new T.CylinderGeometry(.08,.08,2.1,8),edge);rail.rotation.x=Math.PI/2;rail.position.set(x*side,-.25,3.1);root.add(rail);}
 }
 const seamMat=new T.LineBasicMaterial({color:'#596869',transparent:true,opacity:.55});const seams=[];for(const side of [-1,1]){for(const p of [[1.6,1,4.9,3.7],[2.4,.1,6.5,3.5]])seams.push(side*p[0],.16,p[1],side*p[2],.16,p[3]);}const seamGeo=new T.BufferGeometry();seamGeo.setAttribute('position',new T.Float32BufferAttribute(seams,3));root.add(new T.LineSegments(seamGeo,seamMat));return root;
}

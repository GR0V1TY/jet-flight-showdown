export const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function valleyCenter(z){return 240*Math.sin(z/3600)+100*Math.sin(z/1500);}
export function terrainHeight(x,z){
 const d=Math.abs(x-valleyCenter(z));
 const bank=clamp((d-310)/850,0,1);
 const ridge=390+280*Math.sin(z/1550+x/1900)+140*Math.cos(z/680-x/850);
 const detail=37*Math.sin(x/170+Math.sin(z/380))*Math.cos(z/210)+19*Math.sin(x/63)*Math.cos(z/94);
 return -23+bank*(220+Math.max(0,ridge))+bank*bank*(200+detail*2)+Math.max(0,d-1500)*.09;
}
export function makeRoute(){return Array.from({length:24},(_,i)=>{const z=100-i*1050;return {x:valleyCenter(z)+Math.sin(i*.6)*110,y:480+Math.sin(i*.45)*100,z,radius:105};});}
export function createFlight(){return {x:valleyCenter(700),y:480,z:700,vx:0,vy:0,vz:-145,pitch:0,roll:0,yaw:0,pitchRate:0,rollRate:0,throttle:.58,time:0,distance:0,score:0,gate:0,passed:0,missed:0,combo:0,stall:false,ended:false,reason:'',g:1};}
export function basis(s){const cy=Math.cos(s.yaw),sy=Math.sin(s.yaw),cp=Math.cos(s.pitch),sp=Math.sin(s.pitch),cr=Math.cos(s.roll),sr=Math.sin(s.roll);return {f:{x:-sy*cp,y:sp,z:-cy*cp},u:{x:-cy*sr+sy*sp*cr,y:cp*cr,z:sy*sr+cy*sp*cr}};}
export function stepFlight(s,input,dt,route){
 if(s.ended)return null;
 s.throttle=clamp(s.throttle+(input.throttle||0)*dt*.32,.05,1);
 const speed=Math.hypot(s.vx,s.vy,s.vz),authority=clamp(speed/110,.18,1.25);
 s.pitchRate+=((input.pitch||0)*.46*authority-s.pitchRate*2.8)*dt;
 s.rollRate+=((input.roll||0)*1.8-s.rollRate*3.2)*dt;
 s.pitch=clamp(s.pitch+s.pitchRate*dt,-1.22,1.22);
 s.roll=clamp(s.roll+s.rollRate*dt,-1.42,1.42);
 if(Math.abs(input.roll||0)<.02)s.roll*=Math.exp(-dt*.55);
 const turn=9.81*Math.tan(s.roll)/Math.max(speed,65);
 s.yaw+=(turn+(input.yaw||0)*.15)*dt;
 const {f,u}=basis(s),flightAngle=Math.atan2(s.vy,Math.hypot(s.vx,s.vz));
 const alpha=clamp(s.pitch-flightAngle,-.65,.65);
 s.stall=speed<78||Math.abs(alpha)>.32;
 let cl=clamp(.16+3.7*alpha,-.9,1.55);if(Math.abs(alpha)>.32)cl*=Math.max(.18,1-(Math.abs(alpha)-.32)*3);
 const q=.5*1.1*speed*speed*28,lift=q*cl,drag=q*(.061+.055*cl*cl)+(s.stall?8000:0),thrust=43000*s.throttle;
 const inv=1/5200,previous={x:s.x,y:s.y,z:s.z};
 // Lift acts normal to the wing; momentum is integrated independently of attitude.
 s.vx+=(f.x*thrust+u.x*lift-s.vx/Math.max(speed,1)*drag)*inv*dt;
 s.vy+=((f.y*thrust+u.y*lift-s.vy/Math.max(speed,1)*drag)*inv-9.81)*dt;
 s.vz+=(f.z*thrust+u.z*lift-s.vz/Math.max(speed,1)*drag)*inv*dt;
 // Vertical fin and assisted coordinated turn damp lateral slip without snapping velocity.
 const lateral=s.vx*Math.cos(s.yaw)-s.vz*Math.sin(s.yaw);
 s.vx-=lateral*Math.cos(s.yaw)*dt*.6;s.vz+=lateral*Math.sin(s.yaw)*dt*.6;
 s.x+=s.vx*dt;s.y+=s.vy*dt;s.z+=s.vz*dt;s.time+=dt;s.distance+=speed*dt;
 s.score+=dt*(speed/30)*(s.y-terrainHeight(s.x,s.z)<180?1.5:1);
 s.g=lift*inv/9.81;
 let event=null;
 // Sweep the path between steps against terrain and water to prevent tunneling.
 const segments=Math.max(1,Math.ceil(speed*dt/8));
 for(let i=1;i<=segments;i++){const a=i/segments,x=previous.x+(s.x-previous.x)*a,y=previous.y+(s.y-previous.y)*a,z=previous.z+(s.z-previous.z)*a;if(y<=Math.max(0,terrainHeight(x,z))+4){s.ended=true;s.reason=terrainHeight(x,z)>0?'撞击山体':'触及水面';return 'crash';}}
 if(Math.abs(s.x)>9000||s.y>5500||s.z>5000){s.ended=true;s.reason='飞出训练空域';return 'crash';}
 if(route&&s.gate<route.length){const g=route[s.gate];if(previous.z>g.z&&s.z<=g.z){const a=(previous.z-g.z)/(previous.z-s.z),x=previous.x+(s.x-previous.x)*a,y=previous.y+(s.y-previous.y)*a;if(Math.hypot(x-g.x,y-g.y)<g.radius-6){s.passed++;s.combo++;s.score+=500+Math.min(s.combo,5)*100;event='gate';}else{s.missed++;s.combo=0;event='miss';}s.gate++;}}
 if(route&&s.gate===route.length){s.ended=true;s.reason='航线完成';event='complete';}return event;
}

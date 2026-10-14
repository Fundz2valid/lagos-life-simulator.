import './style.css';
import * as THREE from 'three';
import { io } from 'socket.io-client';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('ll_token');
let player = null;
let registerMode = false;
let socket = null;
let scene, camera, renderer, avatar, clock, keys = {};
let worldReady = false;
const otherPlayers = new Map();
const buildings = [];
let toastTimer;
const jobNames = {dispatch:'Dispatch Rider', vendor:'Food Vendor', tech:'Freelance Tech'};
const money = n => '₦' + Number(n).toLocaleString('en-NG');

function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2500);
}
function setAuthMessage(message, success=false) {
  $('auth-message').textContent = message;
  $('auth-message').classList.toggle('success', success);
}
function showAuth() { $('auth-screen').classList.remove('hidden'); $('game-screen').classList.add('hidden'); }
function showGame() { $('auth-screen').classList.add('hidden'); $('game-screen').classList.remove('hidden'); }
function setMode(register) {
  registerMode = register;
  $('login-tab').classList.toggle('active', !register);
  $('register-tab').classList.toggle('active', register);
  $('email-label').classList.toggle('hidden', !register);
  $('email').required = register;
  $('auth-submit').textContent = register ? 'Create account' : 'Log in';
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  setAuthMessage('');
}
$('login-tab').addEventListener('click', () => setMode(false));
$('register-tab').addEventListener('click', () => setMode(true));

async function request(path, options={}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('auth-submit');
  button.disabled = true;
  setAuthMessage(registerMode ? 'Creating your account…' : 'Logging you in…');
  try {
    const body = { username:$('username').value.trim(), password:$('password').value };
    if (registerMode) body.email = $('email').value.trim();
    const result = await request(registerMode ? '/api/auth/register' : '/api/auth/login', {method:'POST', body:JSON.stringify(body)});
    token = result.token;
    localStorage.setItem('ll_token', token);
    player = result.player;
    await enterGame();
  } catch (error) { setAuthMessage(error.message); }
  finally { button.disabled = false; }
});
$('logout-button').addEventListener('click', () => {
  if (socket) socket.disconnect();
  socket = null; token = null; player = null;
  localStorage.removeItem('ll_token');
  showAuth();
});
$('save-button').addEventListener('click', async () => {
  try { await savePosition(); await refreshPlayer(); toast('Progress saved to your account ✓'); }
  catch(e) { toast(e.message); }
});
$('rent-button').addEventListener('click', async () => {
  try {
    const result = await request('/api/game/rent', {method:'POST',body:JSON.stringify({})});
    player = result.player; renderPlayer(); toast(result.message);
  } catch(e) { toast(e.message); }
});
document.querySelectorAll('[data-job]').forEach(button => button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const result = await request('/api/game/work', {method:'POST',body:JSON.stringify({job:button.dataset.job})});
    player = result.player; renderPlayer(); addActivity(`You worked as ${jobNames[button.dataset.job]} and earned ${money(result.earned)}.`, '💼');
    toast(`Shift complete: +${money(result.earned)} and ${result.xpEarned} XP`);
  } catch(e) { toast(e.message); }
  finally { button.disabled = false; }
}));

function renderPlayer() {
  if (!player) return;
  $('player-name').textContent = player.username;
  $('profile-name').textContent = player.username;
  $('avatar').textContent = player.username.slice(0,1).toUpperCase();
  $('wallet').textContent = money(player.wallet);
  $('career').textContent = player.career;
  $('home').textContent = player.hasHome ? 'Room rented' : 'No rent due';
  $('location').textContent = player.x < -8 ? 'Yaba District' : player.x > 8 ? 'Lekki District' : 'Ikeja District';
  $('coords').textContent = `X ${Math.round(player.x)} / Z ${Math.round(player.z)}`;
  $('level-chip').textContent = `Level ${player.level}`;
  $('xp-text').textContent = `${player.xp} XP earned`;
  $('xp-bar').style.width = `${player.xp % 100}%`;
}
async function refreshPlayer() {
  const result = await request('/api/me');
  player = result.player; renderPlayer();
}
async function savePosition() {
  if (avatar && player) {
    player.x = avatar.position.x; player.z = avatar.position.z;
  }
  const result = await request('/api/game/save', {method:'POST',body:JSON.stringify({x:player.x,z:player.z})});
  player = result.player;
}
async function enterGame() {
  showGame();
  renderPlayer();
  initWorld();
  if (!worldReady) requestAnimationFrame(animate);
  worldReady = true;
  try { await refreshPlayer(); } catch(e) { toast(e.message); }
  connectSocket();
}

function makeBuilding(x,z,w,h,d,color,label) {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(w,h,d);
  const material = new THREE.MeshStandardMaterial({color, roughness:.85});
  const body = new THREE.Mesh(geometry,material);
  body.position.y = h/2; body.castShadow = true; body.receiveShadow = true; group.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(w+.2,.18,d+.2),new THREE.MeshStandardMaterial({color:0x343e4b}));
  roof.position.y=h+.05; group.add(roof);
  for(let yy=1.3; yy<h-.5; yy+=1.2) {
    for(let xx=-w/2+.5; xx<w/2-.25; xx+=.8) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(.32,.42,.035),new THREE.MeshStandardMaterial({color:0x8ed3e8,emissive:0x15303c,roughness:.3}));
      win.position.set(xx,yy,d/2+.02); group.add(win);
      const win2=win.clone();win2.position.z=-d/2-.02;group.add(win2);
    }
  }
  group.position.set(x,0,z); group.userData.label=label; scene.add(group); buildings.push(group);
}
function initWorld() {
  if (renderer) { onResize(); return; }
  const container = $('world');
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x9bc8d1); scene.fog = new THREE.Fog(0x9bc8d1,45,120);
  camera = new THREE.PerspectiveCamera(60,container.clientWidth/container.clientHeight,.1,250);
  camera.position.set(0,8,12);
  renderer = new THREE.WebGLRenderer({antialias:true, powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.7)); renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace; container.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xe5f8ff,0x65715e,2.1));
  const sun = new THREE.DirectionalLight(0xffe2ac,3); sun.position.set(-15,25,10); sun.castShadow=true; scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160,160),new THREE.MeshStandardMaterial({color:0x879a76})); ground.rotation.x=-Math.PI/2; ground.receiveShadow=true;scene.add(ground);
  // Roads and pavements
  const roadMat=new THREE.MeshStandardMaterial({color:0x3d4650,roughness:1});
  const road=new THREE.Mesh(new THREE.PlaneGeometry(13,150),roadMat);road.rotation.x=-Math.PI/2;road.position.y=.025;scene.add(road);
  const cross=new THREE.Mesh(new THREE.PlaneGeometry(150,11),roadMat);cross.rotation.x=-Math.PI/2;cross.position.y=.03;scene.add(cross);
  const dashMat=new THREE.MeshStandardMaterial({color:0xf5d88b});
  for(let z=-70;z<75;z+=7){const dash=new THREE.Mesh(new THREE.BoxGeometry(.13,.035,3),dashMat);dash.position.set(0,.07,z);scene.add(dash);}
  for(let x=-70;x<75;x+=7){const dash=new THREE.Mesh(new THREE.BoxGeometry(3,.035,.13),dashMat);dash.position.set(x,.07,0);scene.add(dash);}
  const colors=[0xe8aa70,0xd8d4c7,0x8fb9c4,0xc8a3a0,0xe2ca7c,0xb3c6a0,0xc2b2dc,0xd8a78c];
  const spots=[[-12,-12,5,8,5,'Ikeja Market'],[12,-12,6,11,6,'City Apartments'],[-12,12,7,9,6,'Mainland Plaza'],[12,12,5,7,5,'Lagos Cafe'],[-23,-5,6,13,7,'Office Tower'],[23,5,6,10,6,'Shop'],[-5,-24,8,6,6,'Bus Station'],[5,24,8,8,6,'Community Hall']];
  spots.forEach((b,i)=>makeBuilding(...b.slice(0,5),colors[i],b[5]));
  // Decorative trees
  for(let i=0;i<28;i++){
    const x=(i%2?1:-1)*(18+(i%5)*4), z=-50+i*3.7;
    const trunk=new THREE.Mesh(new THREE.CylinderGeometry(.16,.22,1.3,7),new THREE.MeshStandardMaterial({color:0x6c4930}));trunk.position.set(x,.65,z);scene.add(trunk);
    const crown=new THREE.Mesh(new THREE.SphereGeometry(.9,8,7),new THREE.MeshStandardMaterial({color:i%2?0x3f8055:0x548e5c}));crown.position.set(x,1.8,z);crown.castShadow=true;scene.add(crown);
  }
  avatar = new THREE.Group();
  const body=new THREE.Mesh(new THREE.CapsuleGeometry(.38,.8,4,8),new THREE.MeshStandardMaterial({color:0x4c79d8}));body.position.y=1;body.castShadow=true;avatar.add(body);
  const head=new THREE.Mesh(new THREE.SphereGeometry(.29,12,10),new THREE.MeshStandardMaterial({color:0x8d5b3e}));head.position.y=1.72;head.castShadow=true;avatar.add(head);
  const hair=new THREE.Mesh(new THREE.SphereGeometry(.3,10,6,0,Math.PI*2,0,Math.PI*.55),new THREE.MeshStandardMaterial({color:0x191716}));hair.position.y=1.82;avatar.add(hair);
  avatar.position.set(player?.x||0,0,player?.z||4);scene.add(avatar);
  clock=new THREE.Clock();
  renderer.domElement.addEventListener('click', onWorldClick);
  renderer.domElement.addEventListener('pointerdown',e=>{renderer.domElement.dataset.pointerX=e.clientX;renderer.domElement.dataset.pointerY=e.clientY;});
  window.addEventListener('keydown',e=>{keys[e.key.toLowerCase()]=true;if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key))e.preventDefault();});
  window.addEventListener('keyup',e=>keys[e.key.toLowerCase()]=false);
  document.querySelectorAll('[data-move]').forEach(btn=>{
    const keyMap={forward:'w',back:'s',left:'a',right:'d'};
    const down=e=>{e.preventDefault();keys[keyMap[btn.dataset.move]]=true;};
    const up=e=>{e.preventDefault();keys[keyMap[btn.dataset.move]]=false;};
    btn.addEventListener('pointerdown',down);btn.addEventListener('pointerup',up);btn.addEventListener('pointerleave',up);btn.addEventListener('pointercancel',up);
  });
  window.addEventListener('resize',onResize);onResize();
}
function onWorldClick(event) {
  const rect=renderer.domElement.getBoundingClientRect();
  const pointer=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-((event.clientY-rect.top)/rect.height)*2+1);
  const ray=new THREE.Raycaster();ray.setFromCamera(pointer,camera);
  const hits=ray.intersectObjects(buildings,true);
  if(hits.length){let obj=hits[0].object;while(obj.parent && !obj.userData.label)obj=obj.parent;if(obj.userData.label)toast(`${obj.userData.label} · Explore the city to discover opportunities!`);}
}
function onResize(){if(!renderer||!camera)return;const el=$('world');camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();renderer.setSize(el.clientWidth,el.clientHeight,false);}
let lastNetwork = 0;
function animate() {
  requestAnimationFrame(animate);
  if(!renderer||!avatar)return;
  const dt=Math.min(clock.getDelta(),.05);
  let dx=0,dz=0;
  if(keys.w||keys.arrowup)dz-=1;if(keys.s||keys.arrowdown)dz+=1;if(keys.a||keys.arrowleft)dx-=1;if(keys.d||keys.arrowright)dx+=1;
  if(dx||dz){
    const len=Math.hypot(dx,dz);dx/=len;dz/=len;
    avatar.position.x=THREE.MathUtils.clamp(avatar.position.x+dx*7*dt,-70,70);
    avatar.position.z=THREE.MathUtils.clamp(avatar.position.z+dz*7*dt,-70,70);
    avatar.rotation.y=Math.atan2(dx,dz);
    avatar.children[0].position.y=1+Math.sin(performance.now()*.012)*.035;
  }
  camera.position.x+=(avatar.position.x-camera.position.x)*Math.min(1,dt*2.8);
  camera.position.z+=(avatar.position.z+10-camera.position.z)*Math.min(1,dt*2.8);
  camera.position.y+=(8-camera.position.y)*Math.min(1,dt*2);
  camera.lookAt(avatar.position.x,1,avatar.position.z-2);
  renderer.render(scene,camera);
  if(player){player.x=avatar.position.x;player.z=avatar.position.z;renderPlayer();}
  if(socket?.connected && performance.now()-lastNetwork>150){
    lastNetwork=performance.now();
    socket.emit('move',{x:avatar.position.x,z:avatar.position.z,rotation:avatar.rotation.y});
  }
}
function connectSocket(){
  if(socket)socket.disconnect();
  socket=io(API,{auth:{token}});
  socket.on('connect',()=>{addActivity('You entered the city.', '🚶');});
  socket.on('connect_error',err=>toast(`Multiplayer: ${err.message}`));
  socket.on('presence',data=>{
    $('online-count').textContent=`${data.count} online`;
    if(data.message)addActivity(data.message,'👋');
  });
  socket.on('players',list=>{
    list.forEach(p=>{if(p.id!==socket.id)upsertOther(p);});
    for(const [id,obj] of otherPlayers){if(!list.some(p=>p.id===id)){scene.remove(obj);otherPlayers.delete(id);}}
  });
  socket.on('player-joined',p=>{upsertOther(p);addActivity(`${p.username} joined the city.`, '👋');});
  socket.on('player-moved',p=>upsertOther(p));
  socket.on('player-left',p=>{const obj=otherPlayers.get(p.id);if(obj){scene.remove(obj);otherPlayers.delete(p.id);}addActivity(`${p.username} left the city.`, '🚪');});
}
function upsertOther(p){
  if(!scene||p.x===undefined)return;
  let obj=otherPlayers.get(p.id);
  if(!obj){
    obj=new THREE.Group();
    const body=new THREE.Mesh(new THREE.CapsuleGeometry(.36,.8,4,8),new THREE.MeshStandardMaterial({color:0xe8a24a}));body.position.y=1;obj.add(body);
    const head=new THREE.Mesh(new THREE.SphereGeometry(.28,10,8),new THREE.MeshStandardMaterial({color:0x8d5b3e}));head.position.y=1.7;obj.add(head);
    scene.add(obj);otherPlayers.set(p.id,obj);
  }
  obj.position.set(p.x,0,p.z);obj.rotation.y=p.rotation||0;
}
function addActivity(message,icon='✨'){
  const list=$('activity-list');
  if(list.querySelector('.muted'))list.innerHTML='';
  const item=document.createElement('div');item.className='activity-item';
  const glyph=document.createElement('span');glyph.className='activity-icon';glyph.textContent=icon;
  const copy=document.createElement('div');copy.textContent=message;
  const time=document.createElement('small');time.textContent='Just now';copy.appendChild(time);
  item.append(glyph,copy);list.prepend(item);
  while(list.children.length>5)list.lastElementChild.remove();
}
async function boot(){
  if(!token){showAuth();return;}
  try{
    const result=await request('/api/me');player=result.player;await enterGame();
  }catch{localStorage.removeItem('ll_token');token=null;showAuth();}
}
boot();

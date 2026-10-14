import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Set JWT_SECRET to a random string of at least 32 characters in .env');
  process.exit(1);
}
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173,https://localhost,capacitor://localhost')
  .split(',').map(value => value.trim()).filter(Boolean);
const corsOptions = { origin(origin, callback) {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error('Origin not allowed by CORS'));
}, credentials: false };
app.use(cors(corsOptions));
app.use(express.json({limit:'20kb'}));

const dbPath = process.env.DATABASE_PATH || path.join(__dirname,'lagos-life.sqlite');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS players (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL COLLATE NOCASE UNIQUE,
 email TEXT NOT NULL COLLATE NOCASE UNIQUE,
 password_hash TEXT NOT NULL,
 wallet INTEGER NOT NULL DEFAULT 2500,
 xp INTEGER NOT NULL DEFAULT 0,
 career TEXT NOT NULL DEFAULT 'New Hustler',
 has_home INTEGER NOT NULL DEFAULT 0,
 x REAL NOT NULL DEFAULT 0,
 z REAL NOT NULL DEFAULT 4,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS work_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
 job TEXT NOT NULL,
 earned INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const findByUsername = db.prepare('SELECT * FROM players WHERE username = ?');
const findByEmail = db.prepare('SELECT * FROM players WHERE email = ?');
const findById = db.prepare('SELECT * FROM players WHERE id = ?');
const publicPlayer = row => ({
  id:row.id, username:row.username, wallet:row.wallet, xp:row.xp,
  level:Math.floor(row.xp/100)+1, career:row.career, hasHome:Boolean(row.has_home),
  x:row.x, z:row.z
});
function makeToken(row) {
  return jwt.sign({sub:String(row.id), username:row.username},JWT_SECRET,{expiresIn:'7d',issuer:'lagos-life-api',audience:'lagos-life-client'});
}
function auth(req,res,next) {
  const value=req.headers.authorization||'';
  const [scheme,token]=value.split(' ');
  if(scheme!=='Bearer'||!token)return res.status(401).json({error:'Please log in.'});
  try{
    const payload=jwt.verify(token,JWT_SECRET,{issuer:'lagos-life-api',audience:'lagos-life-client'});
    const row=findById.get(Number(payload.sub));
    if(!row)return res.status(401).json({error:'Account no longer exists.'});
    req.player=row;next();
  }catch{return res.status(401).json({error:'Your session expired. Please log in again.'});}
}
function validUsername(name){return typeof name==='string'&&/^[a-zA-Z0-9_]{3,24}$/.test(name);}
function validPassword(p){return typeof p==='string'&&p.length>=8&&p.length<=72;}
const rateBuckets = new Map();
function rateLimit(req,res,next){
  const key=`${req.ip}:${req.path}`, now=Date.now(), bucket=rateBuckets.get(key)||{count:0,start:now};
  if(now-bucket.start>60_000){bucket.count=0;bucket.start=now;}
  bucket.count++;rateBuckets.set(key,bucket);
  if(bucket.count>12)return res.status(429).json({error:'Too many attempts. Please wait a minute.'});
  next();
}
app.get('/api/health',(req,res)=>res.json({ok:true,service:'lagos-life-api'}));
app.post('/api/auth/register',rateLimit,async(req,res)=>{
  const username=String(req.body.username||'').trim();
  const email=String(req.body.email||'').trim().toLowerCase();
  const password=req.body.password;
  if(!validUsername(username))return res.status(400).json({error:'Username must be 3–24 characters using letters, numbers or underscores.'});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.status(400).json({error:'Enter a valid email address.'});
  if(!validPassword(password))return res.status(400).json({error:'Password must be 8–72 characters.'});
  if(findByUsername.get(username))return res.status(409).json({error:'That username is already taken.'});
  if(findByEmail.get(email))return res.status(409).json({error:'That email is already registered.'});
  try{
    const hash=await bcrypt.hash(password,12);
    const result=db.prepare('INSERT INTO players(username,email,password_hash) VALUES(?,?,?)').run(username,email,hash);
    const row=findById.get(result.lastInsertRowid);
    res.status(201).json({token:makeToken(row),player:publicPlayer(row)});
  }catch(error){
    if(String(error).includes('UNIQUE'))return res.status(409).json({error:'Username or email already exists.'});
    console.error(error);res.status(500).json({error:'Could not create account.'});
  }
});
app.post('/api/auth/login',rateLimit,async(req,res)=>{
  const username=String(req.body.username||'').trim();
  const password=req.body.password;
  if(!username||typeof password!=='string')return res.status(400).json({error:'Enter your username and password.'});
  const row=findByUsername.get(username);
  if(!row||!(await bcrypt.compare(password,row.password_hash)))return res.status(401).json({error:'Incorrect username or password.'});
  res.json({token:makeToken(row),player:publicPlayer(row)});
});
app.get('/api/me',auth,(req,res)=>res.json({player:publicPlayer(req.player)}));

const jobs = {
 dispatch:{pay:1200,xp:25,career:'Dispatch Rider'},
 vendor:{pay:850,xp:18,career:'Food Vendor'},
 tech:{pay:1700,xp:35,career:'Freelance Tech'}
};
const workStatement=db.prepare('INSERT INTO work_log(player_id,job,earned) VALUES(?,?,?)');
const updateWork=db.prepare('UPDATE players SET wallet=wallet+?,xp=xp+?,career=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
app.post('/api/game/work',auth,(req,res)=>{
  const job=jobs[req.body.job];
  if(!job)return res.status(400).json({error:'Choose a valid job.'});
  const workCount=db.prepare("SELECT COUNT(*) n FROM work_log WHERE player_id=? AND created_at >= datetime('now','-1 hour')").get(req.player.id).n;
  if(workCount>=10)return res.status(429).json({error:'You have worked 10 shifts in the last hour. Take a break and try again later.'});
  const transaction=db.transaction(()=>{
    workStatement.run(req.player.id,req.body.job,job.pay);
    updateWork.run(job.pay,job.xp,job.career,req.player.id);
  });
  transaction();
  const row=findById.get(req.player.id);
  res.json({player:publicPlayer(row),earned:job.pay,xpEarned:job.xp});
});
app.post('/api/game/rent',auth,(req,res)=>{
  const cost=800;
  if(req.player.has_home)return res.status(409).json({error:'You already rent a room.'});
  if(req.player.wallet<cost)return res.status(400).json({error:`You need ${cost} naira to rent a room.`});
  db.prepare('UPDATE players SET wallet=wallet-?,has_home=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(cost,req.player.id);
  res.json({player:publicPlayer(findById.get(req.player.id)),message:'Room rented! You have a place to call home.'});
});
app.post('/api/game/save',auth,(req,res)=>{
  const x=Number(req.body.x),z=Number(req.body.z);
  if(!Number.isFinite(x)||!Number.isFinite(z)||Math.abs(x)>70||Math.abs(z)>70)return res.status(400).json({error:'Invalid player position.'});
  db.prepare('UPDATE players SET x=?,z=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(x,z,req.player.id);
  res.json({player:publicPlayer(findById.get(req.player.id))});
});

const io = new Server(httpServer,{cors:{origin:allowedOrigins,methods:['GET','POST']}});
const online = new Map();
const socketAuth = (socket,next)=>{
  try{
    const payload=jwt.verify(socket.handshake.auth?.token||'',JWT_SECRET,{issuer:'lagos-life-api',audience:'lagos-life-client'});
    const row=findById.get(Number(payload.sub));
    if(!row)return next(new Error('Account not found'));
    socket.player=publicPlayer(row);next();
  }catch{next(new Error('Please log in to join multiplayer'));}
};
io.use(socketAuth);
io.on('connection',socket=>{
  const p={id:socket.id,username:socket.player.username,x:socket.player.x,z:socket.player.z,rotation:0};
  online.set(socket.id,p);
  socket.emit('players',[...online.values()]);
  socket.broadcast.emit('player-joined',p);
  io.emit('presence',{count:online.size,message:`${p.username} is now in the city.`});
  socket.on('move',data=>{
    if(!data||!Number.isFinite(data.x)||!Number.isFinite(data.z)||Math.abs(data.x)>70||Math.abs(data.z)>70)return;
    p.x=data.x;p.z=data.z;p.rotation=Number.isFinite(data.rotation)?data.rotation:0;
    socket.broadcast.volatile.emit('player-moved',p);
  });
  socket.on('disconnect',()=>{
    online.delete(socket.id);
    io.emit('player-left',p);
    io.emit('presence',{count:online.size});
  });
});
httpServer.listen(PORT,()=>console.log(`Lagos Life API listening on http://localhost:${PORT}`));

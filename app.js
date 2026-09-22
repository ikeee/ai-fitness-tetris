import { FilesetResolver, PoseLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm";

const COLS = 10;
const ROWS = 20;
const DROP_MS = 720;
const COLORS = {
  I: "#00e9ff", J: "#2878ff", L: "#ff8a22", O: "#ffd82a", S: "#24ff39", T: "#b24cff", Z: "#ff3545",
};
const SHAPES = {
  I: [[1,1,1,1]], J: [[1,0,0],[1,1,1]], L: [[0,0,1],[1,1,1]], O: [[1,1],[1,1]],
  S: [[0,1,1],[1,1,0]], T: [[0,1,0],[1,1,1]], Z: [[1,1,0],[0,1,1]],
};
const PIECES = Object.keys(SHAPES);

const stage = document.getElementById("stage");
const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const octx = overlay.getContext("2d");
const boardCanvas = document.getElementById("board");
const bctx = boardCanvas.getContext("2d");
const nextCanvas = document.getElementById("nextCanvas");
const nctx = nextCanvas.getContext("2d");
const scoreEl = document.getElementById("score");
const comboEl = document.getElementById("combo");
const levelEl = document.getElementById("level");
const xpFill = document.getElementById("xpFill");
const floatLayer = document.getElementById("floatLayer");
const pauseOverlay = document.getElementById("pauseOverlay");
const pauseContinue = document.getElementById("pauseContinue");
const pauseRestart = document.getElementById("pauseRestart");
const cameraStatus = document.getElementById("cameraStatus");
const cameraDot = document.getElementById("cameraDot");
const ctlRotL = document.getElementById("ctlRotL");
const ctlDrop = document.getElementById("ctlDrop");
const ctlRotR = document.getElementById("ctlRotR");
const messageEl = document.getElementById("message");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const restartBtn = document.getElementById("restartBtn");
const mirrorToggle = document.getElementById("mirrorToggle");
const linesEl = document.getElementById("lines");
const bestEl = document.getElementById("bestScore");
const titleScreen = document.getElementById("titleScreen");
const titleStart = document.getElementById("titleStart");
const titleSkip = document.getElementById("titleSkip");
const clearFlash = document.getElementById("clearFlash");
const boardFrame = document.getElementById("boardFrame");
const tutChip = document.getElementById("tutChip");
const tutPop = document.getElementById("tutPop");
const tutorialSkip = document.getElementById("tutorialSkip");
const soundBtn = document.getElementById("soundBtn");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const goScore = document.getElementById("goScore");
const goLines = document.getElementById("goLines");
const goLevel = document.getElementById("goLevel");
const goBest = document.getElementById("goBest");
const goBestTag = document.getElementById("goBestTag");
const goPlay = document.getElementById("goPlay");
const goMenu = document.getElementById("goMenu");

let board = createBoard();
let active = null;
let nextQueue = [randomType(), randomType(), randomType()];
let best = 0;
try{ best = Number(localStorage.getItem("fitnessTetrisBest") || 0) || 0; }catch(e){ best = 0; }
let score = 0, lines = 0, level = 1, combo = 0;
let running = false, paused = false, gameOver = false;
let lastDrop = 0, lastPose = 0;
let poseLandmarker = null;
let stream = null;
let cameraReady = false;
let actionLatch = { left: false, right: false, both: false };
let lastActionAt = 0;
let lastHeadX = 0.5;
let headBaseline = null;
let poseState = "—";
let headSmooth = null;        // EMA 平滑后的头部位置
let leftHandSmooth = 0;       // EMA 平滑后的“手下压量”
let rightHandSmooth = 0;
let baselineSamples = [];     // 启动后采几帧求稳定基准
let lostFrames = 0;

function createBoard(){ return Array.from({length: ROWS}, () => Array(COLS).fill(null)); }
function randomType(){ return PIECES[Math.floor(Math.random() * PIECES.length)]; }
function cloneMatrix(m){ return m.map(r => [...r]); }
function rotateMatrix(m, dir){
  const h=m.length,w=m[0].length;
  const out = Array.from({length:w},()=>Array(h).fill(0));
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) out[dir>0?x:w-1-x][dir>0?h-1-y:y] = m[y][x];
  return out;
}
function makePiece(type=nextQueue[0]){
  const matrix=cloneMatrix(SHAPES[type]);
  return { type, matrix, x: Math.floor((COLS-matrix[0].length)/2), y: 0 };
}
function spawn(){
  active = makePiece(nextQueue.shift());
  nextQueue.push(randomType());
  if(collides(active,0,0,active.matrix)) { gameOver=true; running=false; pauseBtn.disabled=true; messageEl.textContent="Game over — press RESTART to play again."; showGameOver(); }
  drawNext();
}
function cellsFor(p, dx=0, dy=0, matrix=p.matrix){
  const cells=[];
  for(let y=0;y<matrix.length;y++) for(let x=0;x<matrix[y].length;x++) if(matrix[y][x]) cells.push([p.x+x+dx,p.y+y+dy]);
  return cells;
}
function collides(p,dx,dy,matrix){
  return cellsFor(p,dx,dy,matrix).some(([x,y])=> x<0 || x>=COLS || y>=ROWS || (y>=0 && board[y][x]));
}
function merge(){ for(const [x,y] of cellsFor(active)) if(y>=0) board[y][x]=COLORS[active.type]; }
function fmt(n){ return n.toLocaleString("en-US"); }
function setScore(){ scoreEl.textContent=fmt(score); updateBest(); }
function updateBest(){
  if(score>best){ best=score; try{ localStorage.setItem("fitnessTetrisBest",String(best)); }catch(e){} }
  if(bestEl) bestEl.textContent=fmt(best);
}
function updateHud(){
  levelEl.textContent=level;
  xpFill.style.width=`${(lines%10)*10}%`;
  comboEl.textContent=combo>1?`×${combo}`:"—";
  if(linesEl) linesEl.textContent=fmt(lines);
}
function floatText(text, cls=""){
  const el=document.createElement("div");
  el.className=`float-text ${cls}`; el.textContent=text;
  floatLayer.appendChild(el);
  el.addEventListener("animationend",()=>el.remove());
}
function clearLines(){
  let n=0;
  for(let y=ROWS-1;y>=0;y--){
    if(board[y].every(Boolean)){ board.splice(y,1); board.unshift(Array(COLS).fill(null)); n++; y++; }
  }
  const prevLevel=level;
  if(n){
    lines+=n; level=1+Math.floor(lines/10); combo++;
    const gained=[0,100,300,500,800][n]*level;
    score+=gained; setScore();
    floatText(n===4?"TETRIS!":`+${fmt(gained)}`, n===4?"tetris":"");
    if(combo>1 && n<4) floatText(`COMBO ×${combo}`);
    flashBoard();
    if(level>prevLevel) floatText("LEVEL UP","levelup");
    if(n>=4) SFX.tetris(); else SFX.clear(n);
    if(level>prevLevel) SFX.levelUp();
  }else{
    combo=0;
  }
  updateHud();
}
function flashBoard(){
  if(!clearFlash) return;
  clearFlash.classList.remove("on");
  void clearFlash.offsetWidth;
  clearFlash.classList.add("on");
}
function lock(){ merge(); SFX.lock(); clearLines(); spawn(); }
function move(dx){ if(!active||paused||gameOver) return; if(!collides(active,dx,0,active.matrix)){ active.x += dx; SFX.move(); lessonNotify("move"); } }
function softDrop(){ if(!active||paused||gameOver) return; if(!collides(active,0,1,active.matrix)) active.y++; else lock(); }
function hardDrop(){
  if(!active||paused||gameOver) return;
  let d=0; while(!collides(active,0,d+1,active.matrix)) d++;
  active.y += d; score += d*2; setScore(); SFX.drop(); lock(); lessonNotify("drop");
}
function rotate(dir){
  if(!active||paused||gameOver) return;
  const rotated=rotateMatrix(active.matrix,dir);
  const kicks=[0,-1,1,-2,2];
  for(const dx of kicks){ if(!collides(active,dx,0,rotated)){ active.matrix=rotated; active.x+=dx; SFX.rotate(); lessonNotify(dir<0?"rotL":"rotR"); return; } }
}
function resetGame(){
  board=createBoard(); score=0; lines=0; level=1; combo=0; gameOver=false; paused=false; running=false; setScore(); updateHud(); pauseOverlay.classList.remove("show"); pauseBtn.textContent="Pause"; nextQueue=[randomType(),randomType(),randomType()]; spawn(); draw();
  bestBeforeRun=best; hideGameOver();
  messageEl.textContent="Press START to run with camera, or play with the keyboard.";
}
function togglePause(){
  if(!running || gameOver) return;
  paused=!paused; pauseBtn.textContent=paused?"Resume":"Pause";
  pauseOverlay.classList.toggle("show",paused);
  if(paused) musicStop(); else musicStart();
  SFX.ui();
}

function resizeCanvas(canvas){ const dpr=window.devicePixelRatio||1; const rect=canvas.getBoundingClientRect(); canvas.width=Math.max(1,Math.floor(rect.width*dpr)); canvas.height=Math.max(1,Math.floor(rect.height*dpr)); return dpr; }
function setupOverlay(){ overlay.width=Math.floor(stage.clientWidth*devicePixelRatio); overlay.height=Math.floor(stage.clientHeight*devicePixelRatio); }
function drawGridAndPose(landmarks){
  const w=overlay.width, h=overlay.height; octx.clearRect(0,0,w,h);
  // —— 棋盘三边黄色 ‹› 标记：与棋盘 canvas 实际位置对齐（左/右逐行 + 底部逐列）——
  const dpr=window.devicePixelRatio||1;
  const sr=stage.getBoundingClientRect(), br=boardCanvas.getBoundingClientRect();
  const bx=(br.left-sr.left)*dpr, by=(br.top-sr.top)*dpr, bw=br.width*dpr, bh=br.height*dpr;
  octx.save();
  octx.fillStyle="#ffc900"; octx.font=`700 ${Math.max(14,15*dpr)}px "Courier New", monospace`;
  octx.textAlign="center"; octx.textBaseline="middle";
  const rowH=bh/ROWS, colW=bw/COLS;
  for(let r=0;r<ROWS;r++){
    const y=by+rowH*(r+.5);
    octx.fillText("‹›", bx-colW*.28, y);
    octx.fillText("‹›", bx+bw+colW*.28, y);
  }
  for(let c=0;c<COLS;c++){
    octx.fillText("‹›", bx+colW*(c+.5), by+bh+rowH*.28);
  }
  octx.restore();

  if(!landmarks) return;
  const pts = landmarks;
  const connections=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]];
  octx.save();
  octx.lineWidth=3; octx.strokeStyle="rgba(255,255,255,.86)";
  for(const [a,b] of connections){ const pa=pts[a],pb=pts[b]; if(!pa||!pb) continue; octx.beginPath(); octx.moveTo((1-pa.x)*w,pa.y*h); octx.lineTo((1-pb.x)*w,pb.y*h); octx.stroke(); }
  for(const idx of [0,11,12,15,16]){ const p=pts[idx]; if(!p) continue; octx.fillStyle=idx===0?"#fff":"#ffe100"; octx.beginPath(); octx.arc((1-p.x)*w,p.y*h, idx===0?6:7,0,Math.PI*2); octx.fill(); }
  // 手腕画白色方块，贴近原视频
  for(const idx of [15,16]){ const p=pts[idx]; if(!p) continue; octx.fillStyle="#fff"; octx.fillRect((1-p.x)*w-7,p.y*h-7,14,14); }
  octx.restore();
}

function roundRectPath(x,y,w,h,r){
  const p=new Path2D(); const rr=Math.min(r,w/2,h/2);
  p.moveTo(x+rr,y);
  p.arcTo(x+w,y,x+w,y+h,rr);
  p.arcTo(x+w,y+h,x,y+h,rr);
  p.arcTo(x,y+h,x,y,rr);
  p.arcTo(x,y,x+w,y,rr);
  p.closePath();
  return p;
}
function drawBlock(ctx,x,y,w,h,color){
  const r=Math.min(w,h)*0.16;
  const p=roundRectPath(x+2,y+2,w-4,h-4,r);
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=Math.max(8,w*0.3);
  ctx.fillStyle=color; ctx.fill(p);
  ctx.shadowBlur=0;
  const g=ctx.createLinearGradient(0,y,0,y+h);
  g.addColorStop(0,"rgba(255,255,255,.50)");
  g.addColorStop(.42,"rgba(255,255,255,.10)");
  g.addColorStop(1,"rgba(0,0,0,.32)");
  ctx.fillStyle=g; ctx.fill(p);
  ctx.strokeStyle="rgba(255,255,255,.52)"; ctx.lineWidth=Math.max(1.5,w*0.05); ctx.stroke(p);
  ctx.restore();
}
function drawGhost(ctx,x,y,w,h,color){
  const r=Math.min(w,h)*0.18;
  const p=roundRectPath(x+2.5,y+2.5,w-5,h-5,r);
  ctx.save();
  ctx.globalAlpha=.5; ctx.strokeStyle=color; ctx.lineWidth=Math.max(2,w*0.06); ctx.stroke(p);
  ctx.globalAlpha=.16; ctx.fillStyle=color; ctx.fill(p);
  ctx.restore();
}
function draw(){
  const w=boardCanvas.width, h=boardCanvas.height, cw=w/COLS, ch=h/ROWS;
  bctx.clearRect(0,0,w,h);
  const bg=bctx.createLinearGradient(0,0,0,h);
  bg.addColorStop(0,"rgba(8,16,28,.34)"); bg.addColorStop(1,"rgba(3,7,14,.5)");
  bctx.fillStyle=bg; bctx.fillRect(0,0,w,h);
  bctx.strokeStyle="rgba(150,205,255,.2)"; bctx.lineWidth=2;
  for(let x=0;x<=COLS;x++){ bctx.beginPath(); bctx.moveTo(x*cw+.5,0); bctx.lineTo(x*cw+.5,h); bctx.stroke(); }
  for(let y=0;y<=ROWS;y++){ bctx.beginPath(); bctx.moveTo(0,y*ch+.5); bctx.lineTo(w,y*ch+.5); bctx.stroke(); }
  if(active && !paused && !gameOver){
    let g=0; while(!collides(active,0,g+1,active.matrix)) g++;
    if(g>0) for(const [x,y] of cellsFor(active,0,g,active.matrix)) if(y>=0) drawGhost(bctx,x*cw,y*ch,cw,ch,COLORS[active.type]);
  }
  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) if(board[y][x]) drawBlock(bctx,x*cw,y*ch,cw,ch,board[y][x]);
  if(active) for(const [x,y] of cellsFor(active)) if(y>=0) drawBlock(bctx,x*cw,y*ch,cw,ch,COLORS[active.type]);
  if(boardFrame) boardFrame.classList.toggle("danger", !gameOver && board.slice(0,4).some(r=>r.some(Boolean)));
}
function drawNext(){
  const W=nextCanvas.width, H=nextCanvas.height;
  nctx.clearRect(0,0,W,H);
  const cell=20, slots=3, pad=10;
  const slotH=(H-pad*2)/slots;
  nctx.strokeStyle="rgba(122,196,255,.14)"; nctx.lineWidth=1;
  for(let i=0;i<slots;i++){
    const type=nextQueue[i]; if(!type) continue;
    const m=SHAPES[type];
    const ox=(W-m[0].length*cell)/2;
    const oy=pad+i*slotH+(slotH-m.length*cell)/2;
    for(let y=0;y<m.length;y++) for(let x=0;x<m[y].length;x++) if(m[y][x]) drawBlock(nctx,ox+x*cell,oy+y*cell,cell,cell,COLORS[type]);
    if(i<slots-1){ const ly=pad+(i+1)*slotH; nctx.beginPath(); nctx.moveTo(10,ly+.5); nctx.lineTo(W-10,ly+.5); nctx.stroke(); }
  }
}

async function initPose(){
  messageEl.textContent="Loading AI pose model — first load may take a moment…";
  const vision=await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm");
  poseLandmarker=await PoseLandmarker.createFromOptions(vision,{
    baseOptions:{modelAssetPath:"https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",delegate:"GPU"},
    runningMode:"VIDEO", numPoses:1,
    minPoseDetectionConfidence:0.6,
    minPosePresenceConfidence:0.6,
    minTrackingConfidence:0.6,
    outputSegmentationMasks:false,
  });
}
async function startCamera(){
  if(!navigator.mediaDevices?.getUserMedia) throw new Error("this browser cannot access the camera");
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user", width:{ideal:1280}, height:{ideal:720}}, audio:false});
  video.srcObject=stream; await video.play(); cameraReady=true; cameraDot.classList.add("live"); cameraStatus.textContent="CAMERA LIVE";
}

function setCtl(l,r,b){
  ctlRotL.classList.toggle("active",!!l&&!b);
  ctlRotR.classList.toggle("active",!!r&&!b);
  ctlDrop.classList.toggle("active",!!b);
}

/* ---------- 头部横移控制（纯逻辑，便于单测） ----------
   把"头部相对中性位的偏移量"量化成格子位移：
   - 只有"向外扩"(离中性位更远)才产生移动 —— 与距离成正比：偏 1 档走 1 格、偏 2 档走 2 格；
   - 回到中性位 / 回程途中一律不移动方块（修掉"头回位把方块带回一格"的问题）；
   - 单次最多 3 格，防止一帧跳太远。
   返回：>0 右移 n 格；<0 左移 n 格；0 不动。 */
const headState={zone:0,holdMs:0,lastT:0};
function headControl(delta,step,dead,st){
  const mag=Math.abs(delta);
  const zone = mag<=dead ? 0 : Math.sign(delta)*Math.min(4,Math.ceil((mag-dead)/step));
  let cells=0;
  if(zone!==st.zone){
    const sameSide = st.zone!==0 && Math.sign(zone)===Math.sign(st.zone);
    const base = sameSide ? Math.abs(st.zone) : 0;
    const out = Math.abs(zone)-base;          // 只有"向外"的部分才算位移
    if(out>0) cells=Math.sign(zone)*Math.min(out,3);
    st.zone=zone;
  }
  return cells;
}

function processPose(now){
  if(!poseLandmarker || !cameraReady || video.readyState<2) return;
  if(now-lastPose<40) return;
  lastPose=now;
  const r=poseLandmarker.detectForVideo(video,now);
  const lm=r.landmarks?.[0];
  drawGridAndPose(lm);
  if(!lm){
    if(++lostFrames>5){ poseState="未检测到人体"; setCtl(false,false,false); actionLatch={left:false,right:false,both:false}; headState.zone=0; headState.holdMs=0; }
    return;
  }
  lostFrames=0;
  const vis=p=>p&&(p.visibility??1)>=0.5;
  const nose=lm[0], ls=lm[11], rs=lm[12], lw=lm[15], rw=lm[16];
  if(!vis(nose)||!vis(ls)||!vis(rs)){ poseState="请站进画面"; setCtl(false,false,false); return; }

  // —— 头部移动：EMA 平滑 + 绝对中性位 + "只向外扩"棘轮（回程不带走方块）——
  const shoulderW=Math.max(0.05, Math.abs(ls.x-rs.x));
  const headX=1-nose.x;
  headSmooth = headSmooth===null ? headX : headSmooth*0.6 + headX*0.4;
  lastHeadX=headSmooth;
  if(baselineSamples.length<15){ baselineSamples.push(headSmooth); headBaseline=baselineSamples.reduce((a,b)=>a+b,0)/baselineSamples.length; }
  const centerDelta=headSmooth-headBaseline;
  const moveStep=Math.min(0.085,Math.max(0.035,shoulderW*0.26));   // 随肩宽自适应（含上下限：远距离不过敏、近距离不迟钝）
  const deadZone=Math.max(0.02,moveStep*0.6);
  const cells=headControl(centerDelta,moveStep,deadZone,headState);
  if(cells) for(let i=0,n=Math.abs(cells);i<n;i++) move(Math.sign(cells));
  // 停在中性位 >0.8s → 极缓慢重定基准（补偿站姿漂移）；回程过程中绝不重置、也不移动方块
  const hdt=Math.max(20,Math.min(150,now-(headState.lastT||now)));
  headState.lastT=now;
  if(Math.abs(centerDelta)<=deadZone){
    headState.holdMs+=hdt;
    if(headState.holdMs>800) headBaseline+=centerDelta*Math.min(0.25,hdt/1000*1.2);
  }else{
    headState.holdMs=0;
  }

  // —— 手下压：以肩为参考、肩宽归一、EMA 平滑 + 迟滞阈值（进入0.55/退出0.40）——
  const leftAmt=vis(lw)?(lw.y-ls.y)/shoulderW:0;
  const rightAmt=vis(rw)?(rw.y-rs.y)/shoulderW:0;
  leftHandSmooth=leftHandSmooth*0.55+leftAmt*0.45;
  rightHandSmooth=rightHandSmooth*0.55+rightAmt*0.45;
  const ENTER=0.55, EXIT=0.40;
  const leftDown=actionLatch.left ? leftHandSmooth>EXIT : leftHandSmooth>ENTER;
  const rightDown=actionLatch.right ? rightHandSmooth>EXIT : rightHandSmooth>ENTER;
  const bothDown=leftDown&&rightDown;
  const t=performance.now();
  let label="READY";
  if(bothDown){ label="BOTH DOWN · DROP"; }
  else if(leftDown){ label="L-DOWN · ROT_L"; }
  else if(rightDown){ label="R-DOWN · ROT_R"; }
  else if(Math.abs(centerDelta)>deadZone){ label=centerDelta<0?"HEAD · LEFT":"HEAD · RIGHT"; }
  poseState=label; setCtl(leftDown,rightDown,bothDown);
  if(t-lastActionAt>480){
    if(bothDown && !actionLatch.both){ hardDrop(); lastActionAt=t; }
    else if(leftDown && !actionLatch.left && !bothDown){ rotate(-1); lastActionAt=t; }
    else if(rightDown && !actionLatch.right && !bothDown){ rotate(1); lastActionAt=t; }
  }
  actionLatch={left:leftDown,right:rightDown,both:bothDown};
}

/* ---------- audio：BGM + SFX（WebAudio 合成，零素材） ---------- */
const sound={ctx:null,master:null,sfxBus:null,musicBus:null,on:true,musicPlaying:false,step:0,nextNote:0,timer:null};
try{ sound.on = localStorage.getItem("fitnessTetrisSound")!=="0"; }catch(e){}
function audioInit(){
  if(sound.ctx) return sound.ctx;
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) return null;
  sound.ctx=new AC();
  sound.master=sound.ctx.createGain(); sound.master.gain.value=sound.on?0.9:0; sound.master.connect(sound.ctx.destination);
  sound.sfxBus=sound.ctx.createGain(); sound.sfxBus.gain.value=0.6; sound.sfxBus.connect(sound.master);
  sound.musicBus=sound.ctx.createGain(); sound.musicBus.gain.value=0.15; sound.musicBus.connect(sound.master);
  return sound.ctx;
}
function audioResume(){ const c=audioInit(); if(c&&c.state==="suspended") c.resume(); }
document.addEventListener("pointerdown",audioResume);
window.addEventListener("keydown",audioResume);
function tone(freq,dur,o={}){
  const c=sound.ctx; if(!c||!sound.on) return;
  const t0=c.currentTime+(o.at||0);
  const osc=c.createOscillator(), g=c.createGain();
  osc.type=o.type||"square";
  osc.frequency.setValueAtTime(freq,t0);
  if(o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(40,o.to),t0+dur);
  g.gain.setValueAtTime(0.0001,t0);
  g.gain.exponentialRampToValueAtTime(o.gain||0.2,t0+0.01);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  osc.connect(g); g.connect(o.bus||sound.sfxBus);
  osc.start(t0); osc.stop(t0+dur+0.03);
}
function noiseBurst(dur=0.2,gain=0.35){
  const c=sound.ctx; if(!c||!sound.on) return;
  const n=Math.max(1,Math.floor(c.sampleRate*dur)), buf=c.createBuffer(1,n,c.sampleRate), d=buf.getChannelData(0);
  for(let i=0;i<n;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/n,2);
  const src=c.createBufferSource(); src.buffer=buf;
  const f=c.createBiquadFilter(); f.type="lowpass"; f.frequency.value=1100;
  const g=c.createGain(); g.gain.value=gain;
  src.connect(f); f.connect(g); g.connect(sound.sfxBus); src.start();
}
const SFX={
  move(){ tone(200,0.045,{type:"square",gain:0.06}); },
  rotate(){ tone(430,0.07,{type:"triangle",gain:0.15,to:680}); },
  lock(){ tone(130,0.09,{type:"sine",gain:0.22,to:80}); },
  drop(){ noiseBurst(0.22,0.42); tone(95,0.2,{type:"sine",gain:0.3,to:48}); },
  clear(n){ const notes=[523,659,784,1046]; for(let i=0;i<Math.max(2,n+1);i++) tone(notes[i%notes.length],0.13,{type:"square",gain:0.13,at:i*0.055}); },
  tetris(){ [523,659,784,1046,1318].forEach((f,i)=>tone(f,0.17,{type:"square",gain:0.15,at:i*0.07})); },
  levelUp(){ [392,523,659,880].forEach((f,i)=>tone(f,0.2,{type:"triangle",gain:0.17,at:i*0.08})); },
  lesson(){ tone(700,0.08,{type:"square",gain:0.13}); tone(1050,0.11,{type:"square",gain:0.11,at:0.08}); },
  success(){ [523,659,784,1046].forEach((f,i)=>tone(f,0.22,{type:"square",gain:0.15,at:i*0.09})); },
  gameOver(){ [440,392,330,262,196].forEach((f,i)=>tone(f,0.34,{type:"triangle",gain:0.2,at:i*0.17})); noiseBurst(0.6,0.2); },
  ui(){ tone(560,0.05,{type:"sine",gain:0.12,to:760}); }
};
const MUSIC={bpm:100,chords:[[220.0,261.63,329.63],[174.61,220.0,261.63],[196.0,246.94,293.66],[164.81,207.65,246.94]]};
function musicStart(){
  if(!sound.on||sound.musicPlaying) return;
  const c=audioInit(); if(!c) return;
  if(c.state==="suspended") c.resume();
  sound.musicPlaying=true; sound.step=0; sound.nextNote=c.currentTime+0.08;
  sound.timer=setInterval(musicTick,90);
}
function musicStop(){
  sound.musicPlaying=false;
  if(sound.timer){ clearInterval(sound.timer); sound.timer=null; }
}
function musicTick(){
  const c=sound.ctx; if(!c||!sound.musicPlaying||!sound.on) return;
  const stepDur=60/MUSIC.bpm/4;
  while(sound.nextNote<c.currentTime+0.25){
    const s=sound.step%64, bar=Math.floor(s/16), beat=s%16, chord=MUSIC.chords[bar], at=sound.nextNote-c.currentTime;
    if(beat%4===0) tone(chord[0]/2,stepDur*3.2,{type:"triangle",gain:0.5,bus:sound.musicBus,at});
    if(beat%2===0) tone(chord[(beat/2)%3]*2,stepDur*1.5,{type:"square",gain:0.17,bus:sound.musicBus,at});
    if(beat===8) tone(chord[1]*4,stepDur*1.2,{type:"sine",gain:0.12,bus:sound.musicBus,at});
    sound.step++; sound.nextNote+=stepDur;
  }
}
function setSound(on){
  sound.on=!!on;
  try{ localStorage.setItem("fitnessTetrisSound",sound.on?"1":"0"); }catch(e){}
  if(sound.master) sound.master.gain.value=sound.on?0.9:0;
  if(!sound.on) musicStop();
  else if(running&&!paused&&!gameOver) musicStart();
  if(soundBtn) soundBtn.textContent=sound.on?"🔊 Sound On":"🔇 Sound Off";
}

/* ---------- Game Over 弹屏 ---------- */
let bestBeforeRun=0, gameOverShown=false;
function showGameOver(){
  if(gameOverShown) return;
  gameOverShown=true;
  musicStop(); SFX.gameOver();
  const newBest=score>0 && score>bestBeforeRun;
  if(goScore) goScore.textContent=fmt(score);
  if(goLines) goLines.textContent=fmt(lines);
  if(goLevel) goLevel.textContent=String(level);
  if(goBest) goBest.textContent=fmt(Math.max(best,score));
  if(goBestTag) goBestTag.classList.toggle("show",newBest);
  if(gameOverOverlay) gameOverOverlay.classList.add("show");
  messageEl.textContent="";
}
function hideGameOver(){
  gameOverShown=false;
  if(gameOverOverlay) gameOverOverlay.classList.remove("show");
}
function restartRun(){
  hideGameOver();
  resetGame();
  pauseBtn.disabled=false;
  running=true;
  musicStart();
  requestAnimationFrame(loop);
}

/* ---------- Level 1 · 教导关（弹屏文字引导） ---------- */
const LESSON=[
  {key:"move", tag:"MOVE",      title:"◍ HEAD LEFT / RIGHT", sub:"TILT YOUR HEAD — OR ← → / A D", need:2},
  {key:"rotL", tag:"ROTATE ⟲",  title:"✋ LEFT HAND DOWN",    sub:"ROTATE ⟲ — OR Q / Z",           need:1},
  {key:"rotR", tag:"ROTATE ⟳",  title:"✋ RIGHT HAND DOWN",   sub:"ROTATE ⟳ — OR E / X / ↑",       need:1},
  {key:"drop", tag:"HARD DROP", title:"✋✋ BOTH HANDS DOWN",  sub:"HARD DROP ⚡ — OR SPACE",        need:1},
];
const LESSON_CAP={rotL:ctlRotL,rotR:ctlRotR,drop:ctlDrop};
let lessonActive=false, lessonIndex=0, lessonCount=0, lessonDone=false, popTimer=null;

function pop(text,sub="",cls=""){
  if(!tutPop) return;
  tutPop.className="tut-pop"+(cls?" "+cls:"");
  tutPop.innerHTML="<b>"+text+"</b>"+(sub?"<span>"+sub+"</span>":"");
  tutPop.classList.add("show");
  clearTimeout(popTimer);
  popTimer=setTimeout(()=>{ if(tutPop) tutPop.classList.remove("show"); },2400);
}
function hlCap(cap){
  [ctlRotL,ctlRotR,ctlDrop].forEach(c=>c&&c.classList.remove("hl"));
  if(cap) cap.classList.add("hl");
}
function renderLesson(){
  if(!tutChip) return;
  const cur=LESSON[lessonIndex]; if(!cur) return;
  tutChip.classList.add("show");
  tutChip.innerHTML="LESSON "+(lessonIndex+1)+"/"+LESSON.length+" · "+cur.tag+
    '<span class="dots">'+LESSON.map((s,i)=>'<i class="'+(i<lessonIndex?"on":(i===lessonIndex?"cur":""))+'"></i>').join("")+"</span>";
  hlCap(LESSON_CAP[cur.key]||null);
}
function popStep(){ const cur=LESSON[lessonIndex]; if(cur) pop(cur.title,cur.sub); }
function beginLesson(){
  if(lessonActive) return;
  lessonActive=true; lessonIndex=0; lessonCount=0;
  resetGame();
  running=true;
  if(stage) stage.classList.add("lesson");
  renderLesson(); popStep();
  messageEl.textContent="Level 1 · Lesson — follow the on-screen prompts (ESC to skip).";
  lastDrop=performance.now();
}
function finishLesson(skipped){
  if(!lessonActive) return;
  lessonActive=false; lessonDone=true;
  if(tutChip) tutChip.classList.remove("show");
  if(stage) stage.classList.remove("lesson");
  [ctlRotL,ctlRotR,ctlDrop].forEach(c=>c&&c.classList.remove("hl"));
  lastDrop=performance.now();
  try{ localStorage.setItem("fitnessTetrisLessonDone","1"); }catch(e){}
  if(skipped){ pop("LESSON SKIPPED"); messageEl.textContent="Lesson skipped — good luck!"; }
  else{ SFX.success(); pop("LEVEL 1 COMPLETE","FREE PLAY · BLOCKS NOW FALL BY THEMSELVES","good"); messageEl.textContent="Nice! Lesson complete — clear lines to score."; }
}
function lessonNotify(kind){
  if(!lessonActive) return;
  const cur=LESSON[lessonIndex]; if(!cur||cur.key!==kind) return;
  lessonCount++;
  if(lessonCount<cur.need) return;
  lessonCount=0; lessonIndex++;
  SFX.lesson();
  pop("✓ NICE!","","good");
  if(lessonIndex>=LESSON.length){ setTimeout(()=>finishLesson(false),950); return; }
  setTimeout(()=>{ renderLesson(); popStep(); },950);
}
function skipLesson(){ finishLesson(true); }
function showTitle(){ if(titleScreen) titleScreen.classList.remove("hidden"); }

async function start(){
  hideTitle();
  try{
    if(!poseLandmarker) await initPose();
    if(!cameraReady) await startCamera();
    running=true; paused=false; gameOver=false; pauseBtn.disabled=false; pauseBtn.textContent="Pause"; startBtn.textContent="Session Active"; startBtn.disabled=true; messageEl.textContent="Move your head left / right to steer — drop a hand to rotate — both hands down to hard-drop.";
    headSmooth=null; headBaseline=null; baselineSamples=[]; leftHandSmooth=0; rightHandSmooth=0; lostFrames=0; actionLatch={left:false,right:false,both:false};
    headState.zone=0; headState.holdMs=0; headState.lastT=0;
    if(!lessonDone) beginLesson();
    musicStart();
    requestAnimationFrame(loop);
  }catch(err){
    console.error(err); cameraStatus.textContent="CAMERA ERROR"; messageEl.textContent=`Camera unavailable: ${err.message || err} — keyboard still works.`;
    if(!lessonDone) beginLesson();
    musicStart();
    running=true; requestAnimationFrame(loop);
  }
}
function loop(now){
  if(running){
    processPose(now);
    if(!paused && !gameOver && active && !lessonActive && now-lastDrop>(DROP_MS-Math.min((level-1)*55,520))){ softDrop(); lastDrop=now; }
    handleHeldKeys(now);
    draw();
    requestAnimationFrame(loop);
  }
}

function titleVisible(){ return titleScreen && !titleScreen.classList.contains("hidden"); }
function hideTitle(){ if(titleScreen) titleScreen.classList.add("hidden"); }
function startKeyboard(){
  messageEl.textContent="Keyboard mode — ← → / A D move · Q Z / E X rotate · SPACE hard-drop.";
  if(!lessonDone) beginLesson();
  musicStart();
  running=true; requestAnimationFrame(loop);
}

/* ---------- keyboard：完整按键映射 + DAS 连发（由游戏主循环驱动，帧同步不丢） ---------- */
const DAS={delay:150,rate:45,downDelay:130,downRate:70};
const held={left:false,right:false,down:false};
const holdMeta={left:{t0:0,last:0},right:{t0:0,last:0},down:{t0:0,last:0}};
function pressHeld(name,fn){
  held[name]=true;
  const m=holdMeta[name], now=performance.now();
  m.t0=now; m.last=now;
  fn();
}
function releaseHeld(name){ held[name]=false; }
function releaseAllHeld(){ held.left=false; held.right=false; held.down=false; }
function handleHeldKeys(now){
  if(paused||gameOver) return;
  const step=(name,fn)=>{
    if(!held[name]) return;
    const m=holdMeta[name];
    const delay=name==="down"?DAS.downDelay:DAS.delay;
    const rate=name==="down"?DAS.downRate:DAS.rate;
    if(now-m.t0<delay || now-m.last<rate) return;
    fn(); m.last=now;
  };
  step("left",()=>move(-1));
  step("right",()=>move(1));
  step("down",()=>softDrop());
}

window.addEventListener("keydown",e=>{
  if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Space"].includes(e.code)) e.preventDefault();
  if(gameOverShown){ if(e.code==="Space"||e.code==="Enter") restartRun(); return; }
  if(e.code==="KeyM"){ setSound(!sound.on); return; }
  if(e.code==="Escape"){
    if(lessonActive){ finishLesson(true); return; }
    if(!titleVisible()) togglePause();
    return;
  }
  if(titleVisible()){
    if(!e.repeat && (e.code==="Space"||e.code==="Enter")){ hideTitle(); startKeyboard(); }
    return;
  }
  if(e.code==="ArrowLeft"||e.code==="KeyA"){ if(!e.repeat) pressHeld("left",()=>move(-1)); return; }
  if(e.code==="ArrowRight"||e.code==="KeyD"){ if(!e.repeat) pressHeld("right",()=>move(1)); return; }
  if(e.code==="ArrowDown"||e.code==="KeyS"){ if(!e.repeat) pressHeld("down",()=>softDrop()); return; }
  if(e.repeat) return;
  if(e.code==="KeyQ"||e.code==="KeyZ") rotate(-1);
  else if(e.code==="KeyE"||e.code==="KeyX"||e.code==="ArrowUp") rotate(1);
  else if(e.code==="Space") hardDrop();
  else if(e.code==="KeyP") togglePause();
  else if(e.code==="KeyR") { restartRun(); }
});
window.addEventListener("keyup",e=>{
  if(e.code==="ArrowLeft"||e.code==="KeyA") releaseHeld("left");
  else if(e.code==="ArrowRight"||e.code==="KeyD") releaseHeld("right");
  else if(e.code==="ArrowDown"||e.code==="KeyS") releaseHeld("down");
});
window.addEventListener("blur",releaseAllHeld);

/* ---------- 棋盘尺寸档位（S/M/L，为"2–3 米外看清"设计） ---------- */
function setBoardSize(s){
  const size=["s","m","l"].includes(s)?s:"m";
  document.documentElement.dataset.board=size;
  try{ localStorage.setItem("fitnessTetrisBoard",size); }catch(e){}
  document.querySelectorAll(".size-btn").forEach(b=>b.classList.toggle("active",b.dataset.board===size));
  setupOverlay(); draw();
  requestAnimationFrame(()=>drawGridAndPose(null));
}
document.querySelectorAll(".size-btn").forEach(b=>b.addEventListener("click",()=>setBoardSize(b.dataset.board)));

titleStart.addEventListener("click",()=>{ hideTitle(); start(); });
titleSkip.addEventListener("click",()=>{ hideTitle(); startKeyboard(); });
if(tutorialSkip) tutorialSkip.addEventListener("click",skipLesson);
startBtn.addEventListener("click",start);
pauseBtn.addEventListener("click",togglePause);
pauseContinue.addEventListener("click",togglePause);
pauseRestart.addEventListener("click",()=>{ restartBtn.click(); });
restartBtn.addEventListener("click",()=>{ if(lessonActive) finishLesson(true); restartRun(); });
mirrorToggle.addEventListener("change",()=>{ video.style.transform=mirrorToggle.checked?"scaleX(-1)":"scaleX(1)"; });
if(goPlay) goPlay.addEventListener("click",restartRun);
if(goMenu) goMenu.addEventListener("click",()=>{ hideGameOver(); resetGame(); showTitle(); });
if(soundBtn) soundBtn.addEventListener("click",()=>setSound(!sound.on));
if(soundBtn) soundBtn.textContent=sound.on?"🔊 Sound On":"🔇 Sound Off";
document.addEventListener("click",e=>{ const b=e.target&&e.target.closest&&e.target.closest("button"); if(b){ b.blur(); SFX.ui(); } });
window.addEventListener("resize",()=>{ setupOverlay(); draw(); });

setupOverlay(); video.style.transform="scaleX(-1)"; resetGame();
updateBest();
setBoardSize((()=>{ try{ return localStorage.getItem("fitnessTetrisBoard")||"m"; }catch(e){ return "m"; } })());
requestAnimationFrame(()=>drawGridAndPose(null));

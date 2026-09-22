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

let board = createBoard();
let active = null;
let nextType = randomType();
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
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) out[dir>0?x:h-1-y][dir>0?h-1-y:x] = m[y][x];
  return out;
}
function makePiece(type=nextType){
  const matrix=cloneMatrix(SHAPES[type]);
  return { type, matrix, x: Math.floor((COLS-matrix[0].length)/2), y: 0 };
}
function spawn(){
  active = makePiece(nextType);
  nextType = randomType();
  if(collides(active,0,0,active.matrix)) { gameOver=true; running=false; pauseBtn.disabled=true; messageEl.textContent="游戏结束：按“重新开始”继续挑战。"; }
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
function setScore(){ scoreEl.textContent=fmt(score); }
function updateHud(){
  levelEl.textContent=level;
  xpFill.style.width=`${(lines%10)*10}%`;
  comboEl.textContent=combo>1?`×${combo}`:"";
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
  if(n){
    lines+=n; level=1+Math.floor(lines/10); combo++;
    const gained=[0,100,300,500,800][n]*level;
    score+=gained; setScore();
    floatText(n===4?"TETRIS!":`+${fmt(gained)}`, n===4?"tetris":"");
    if(combo>1 && n<4) floatText(`COMBO ×${combo}`);
  }else{
    combo=0;
  }
  updateHud();
}
function lock(){ merge(); clearLines(); spawn(); }
function move(dx){ if(!active||paused||gameOver) return; if(!collides(active,dx,0,active.matrix)) active.x += dx; }
function softDrop(){ if(!active||paused||gameOver) return; if(!collides(active,0,1,active.matrix)) active.y++; else lock(); }
function hardDrop(){
  if(!active||paused||gameOver) return;
  let d=0; while(!collides(active,0,d+1,active.matrix)) d++;
  active.y += d; score += d*2; setScore(); lock();
}
function rotate(dir){
  if(!active||paused||gameOver) return;
  const rotated=rotateMatrix(active.matrix,dir);
  const kicks=[0,-1,1,-2,2];
  for(const dx of kicks){ if(!collides(active,dx,0,rotated)){ active.matrix=rotated; active.x+=dx; return; } }
}
function resetGame(){
  board=createBoard(); score=0; lines=0; level=1; combo=0; gameOver=false; paused=false; running=false; setScore(); updateHud(); pauseOverlay.classList.remove("show"); pauseBtn.textContent="暂停"; nextType=randomType(); spawn(); draw();
  messageEl.textContent="按“启动摄像头并开始”，或直接使用键盘试玩。";
}
function togglePause(){
  if(!running || gameOver) return;
  paused=!paused; pauseBtn.textContent=paused?"继续":"暂停";
  pauseOverlay.classList.toggle("show",paused);
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
  octx.fillStyle="#ffc900"; octx.font=`700 ${Math.max(11,12*dpr)}px "Courier New", monospace`;
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

function draw(){
  const w=boardCanvas.width, h=boardCanvas.height, cw=w/COLS, ch=h/ROWS;
  bctx.clearRect(0,0,w,h);
  bctx.fillStyle="rgba(8,8,8,.22)"; bctx.fillRect(0,0,w,h);
  // 先画方块（填满整格），再压网格线，贴近原视频观感
  for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) if(board[y][x]) drawBlock(bctx,x*cw,y*ch,cw,ch,board[y][x]);
  if(active) for(const [x,y] of cellsFor(active)) if(y>=0) drawBlock(bctx,x*cw,y*ch,cw,ch,COLORS[active.type],true);
  bctx.strokeStyle="rgba(255,255,255,.46)"; bctx.lineWidth=1;
  for(let x=0;x<=COLS;x++){ bctx.beginPath(); bctx.moveTo(x*cw+.5,0); bctx.lineTo(x*cw+.5,h); bctx.stroke(); }
  for(let y=0;y<=ROWS;y++){ bctx.beginPath(); bctx.moveTo(0,y*ch+.5); bctx.lineTo(w,y*ch+.5); bctx.stroke(); }
}
function drawBlock(ctx,x,y,w,h,color){
  ctx.fillStyle=color; ctx.fillRect(x,y,w,h);
}
function drawNext(){
  nctx.clearRect(0,0,nextCanvas.width,nextCanvas.height); const m=SHAPES[nextType], cell=20; const ox=(nextCanvas.width-m[0].length*cell)/2, oy=(nextCanvas.height-m.length*cell)/2+8;
  for(let y=0;y<m.length;y++) for(let x=0;x<m[y].length;x++) if(m[y][x]) drawBlock(nctx,ox+x*cell,oy+y*cell,cell,cell,COLORS[nextType]);
}

async function initPose(){
  messageEl.textContent="正在加载 AI 姿态模型…首次加载可能需要一点时间。";
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
  if(!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持摄像头访问。");
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user", width:{ideal:1280}, height:{ideal:720}}, audio:false});
  video.srcObject=stream; await video.play(); cameraReady=true; cameraDot.classList.add("live"); cameraStatus.textContent="摄像头已连接";
}

function setCtl(l,r,b){
  ctlRotL.classList.toggle("active",!!l&&!b);
  ctlRotR.classList.toggle("active",!!r&&!b);
  ctlDrop.classList.toggle("active",!!b);
}

function processPose(now){
  if(!poseLandmarker || !cameraReady || video.readyState<2) return;
  if(now-lastPose<40) return;
  lastPose=now;
  const r=poseLandmarker.detectForVideo(video,now);
  const lm=r.landmarks?.[0];
  drawGridAndPose(lm);
  if(!lm){
    if(++lostFrames>5){ poseState="未检测到人体"; setCtl(false,false,false); actionLatch={left:false,right:false,both:false}; }
    return;
  }
  lostFrames=0;
  const vis=p=>p&&(p.visibility??1)>=0.5;
  const nose=lm[0], ls=lm[11], rs=lm[12], lw=lm[15], rw=lm[16];
  if(!vis(nose)||!vis(ls)||!vis(rs)){ poseState="请站进画面"; setCtl(false,false,false); return; }

  // —— 头部移动：EMA 平滑 + 死区 + 移动量按肩宽自适应 ——
  const shoulderW=Math.max(0.05, Math.abs(ls.x-rs.x));
  const headX=1-nose.x;
  headSmooth = headSmooth===null ? headX : headSmooth*0.6 + headX*0.4;
  lastHeadX=headSmooth;
  if(baselineSamples.length<15){ baselineSamples.push(headSmooth); headBaseline=baselineSamples.reduce((a,b)=>a+b,0)/baselineSamples.length; }
  const centerDelta=headSmooth-headBaseline;
  const deadZone=0.025, moveStep=shoulderW*0.28;
  if(Math.abs(centerDelta)>deadZone+moveStep){ move(centerDelta<0?-1:1); headBaseline+=Math.sign(centerDelta)*moveStep; }

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

async function start(){
  try{
    if(!poseLandmarker) await initPose();
    if(!cameraReady) await startCamera();
    running=true; paused=false; gameOver=false; pauseBtn.disabled=false; pauseBtn.textContent="暂停"; startBtn.textContent="AI 体感运行中"; startBtn.disabled=true; messageEl.textContent="把头向左/右移动控制水平位置；单侧手臂下压旋转；双手同时下压快速落块。";
    headSmooth=null; headBaseline=null; baselineSamples=[]; leftHandSmooth=0; rightHandSmooth=0; lostFrames=0; actionLatch={left:false,right:false,both:false};
    requestAnimationFrame(loop);
  }catch(err){
    console.error(err); cameraStatus.textContent="摄像头启动失败"; messageEl.textContent=`启动失败：${err.message || err}。你仍可使用键盘试玩。`;
  }
}
function loop(now){
  if(running){
    processPose(now);
    if(!paused && !gameOver && active && now-lastDrop>(DROP_MS-Math.min((level-1)*55,520))){ softDrop(); lastDrop=now; }
    draw();
    requestAnimationFrame(loop);
  }
}

window.addEventListener("keydown",e=>{
  if(["ArrowLeft","ArrowRight","ArrowDown","Space"].includes(e.code)) e.preventDefault();
  if(e.code==="ArrowLeft") move(-1);
  else if(e.code==="ArrowRight") move(1);
  else if(e.code==="ArrowDown") softDrop();
  else if(e.code==="KeyQ") rotate(-1);
  else if(e.code==="KeyE") rotate(1);
  else if(e.code==="Space") hardDrop();
  else if(e.code==="KeyP") togglePause();
  else if(e.code==="KeyR") { resetGame(); running=true; requestAnimationFrame(loop); }
});
startBtn.addEventListener("click",start);
pauseBtn.addEventListener("click",togglePause);
pauseContinue.addEventListener("click",togglePause);
pauseRestart.addEventListener("click",()=>{ restartBtn.click(); });
restartBtn.addEventListener("click",()=>{ resetGame(); if(cameraReady){ running=true; requestAnimationFrame(loop); } });
mirrorToggle.addEventListener("change",()=>{ video.style.transform=mirrorToggle.checked?"scaleX(-1)":"scaleX(1)"; });
window.addEventListener("resize",()=>{ setupOverlay(); draw(); });

setupOverlay(); video.style.transform="scaleX(-1)"; resetGame();
messageEl.textContent="建议站在摄像头前 1.5–3 米，双手举起进入准备姿势。键盘也可直接试玩。";
requestAnimationFrame(()=>drawGridAndPose(null));

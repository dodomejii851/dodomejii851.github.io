// Cleaned chess script (single-file). Implements castling and en-passant.
const boardState = [
  ['r','n','b','q','k','b','n','r'],
  ['p','p','p','p','p','p','p','p'],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['P','P','P','P','P','P','P','P'],
  ['R','N','B','Q','K','B','N','R']
];

const INITIAL_BOARD = JSON.parse(JSON.stringify(boardState));

let selected = null;
let legalMoves = [];
let currentTurn = 'white';
let moveList = [];
let gameOver = false;
let lastMove = null;

// prevent scheduling AI move multiple times
let aiScheduled = false;

// missing globals used elsewhere
let opponentHistory = [];
const aiHistory = [];
let checkTimer = null, checkFadeTimer = null, checkVisible = false, lastCheckColor = null;
let prevWhiteInCheck = false, prevBlackInCheck = false;
// whether black side is controlled by AI (persisted)
// whether black side is controlled by AI (persisted). Default true for previous behavior
let blackIsAI = (function(){ try{ const v = localStorage.getItem('black_is_ai'); if(v===null) return true; return v === '1' || v === 'true'; }catch(e){ return true; } })();

// Helper to ensure AI is scheduled when it's black's turn
function maybeScheduleBlackAI(delay = 400){
  try{
    if(!blackIsAI){ try{ console.log('[AI] maybeScheduleBlackAI: blackIsAI is false, not scheduling'); }catch(e){} return; }
    if(currentTurn === 'black' && !gameOver){ try{ console.log('[AI] maybeScheduleBlackAI: scheduling AI in', delay, 'ms (currentTurn=', currentTurn, ')'); }catch(e){} scheduleAIMove(typeof delay === 'number' ? delay : 400); }
    else { try{ console.log('[AI] maybeScheduleBlackAI: not scheduling (currentTurn=', currentTurn, ', gameOver=', gameOver, ')'); }catch(e){} }
  }catch(e){ try{ console.error('[AI] maybeScheduleBlackAI error', e); }catch(_){} }
}


// AI思考中オーバーレイのユーティリティ
function showThinkingOverlay(){
  try{
    if(!document.getElementById('ai-thinking-overlay')){
      const ov = document.createElement('div'); ov.id = 'ai-thinking-overlay';
      ov.style.position = 'fixed'; ov.style.left = '50%'; ov.style.top = '50%'; ov.style.transform = 'translate(-50%,-50%)';
      ov.style.zIndex = 99999; ov.style.background = 'rgba(0,0,0,0.6)'; ov.style.color = '#fff'; ov.style.padding = '18px 24px'; ov.style.borderRadius = '10px'; ov.style.fontSize = '20px'; ov.style.fontWeight = '700'; ov.textContent = '思考中…';
      document.body.appendChild(ov);
    }
  }catch(e){}
}

function hideThinkingOverlay(){ try{ const ov = document.getElementById('ai-thinking-overlay'); if(ov) ov.remove(); }catch(e){} }

// AI tuning
const MATING_THRESHOLD = 4;
const AGGRESSIVE_EXTRA_DEPTH = 1;

function moveKey(m){ return `${m.from.row}${m.from.col}-${m.to.row}${m.to.col}`; }
function isRepeatMove(m){ if(aiHistory.length===0) return false; return aiHistory.includes(moveKey(m)); }
function distanceToNearestWhite(pos){ let best=Infinity; for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p=boardState[r][c]; if(p && getColor(p)==='white'){ const d=Math.abs(pos.row-r)+Math.abs(pos.col-c); if(d<best) best=d; } } return best===Infinity?100:best; }
function countPieces(color){ let n=0; for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p=boardState[r][c]; if(!p) continue; if(getColor(p)===color && p.toUpperCase()!=='K') n++; } return n; }

let whiteCastleK = true, whiteCastleQ = true, blackCastleK = true, blackCastleQ = true;
let enPassantTarget = null; // {row,col} or null

// Base piece values (relative to pawn=1). Bishop given slight edge over knight.
const PIECE_VALUE = { P:1, N:3, B:3.25, R:5, Q:9, K:1000 };
// AI evaluation tuning
const QUEEN_EARLY_PENALTY = 4; // large penalty (in pawns) for early queen development
const QUEEN_PENALTY_PHASE_PLY = 12; // apply queen penalty during first N plies
const CASTLING_LOST_PENALTY = 4; // penalty per lost castling right
const BISHOP_PAIR_BONUS = 0.5; // bonus for having the bishop pair
// Default search depth; may be overridden from persisted user setting
let SEARCH_DEPTH = 5;
// load persisted depth if available (number between 1 and 8)
try{
  const stored = parseInt(localStorage.getItem('ai_search_depth') || '', 10);
  if(!isNaN(stored) && stored >= 1 && stored <= 20) SEARCH_DEPTH = stored;
}catch(e){ }
// Worker pool for parallel evaluation (Web Worker)
let WORKER_COUNT = 1;
let workerPool = [];
try{ const sc = parseInt(localStorage.getItem('ai_worker_cores')||'',10); if(!isNaN(sc) && sc>=1 && sc<=8) WORKER_COUNT = sc; }catch(e){}

function createWorkers(count){ // terminate existing
  for(const w of workerPool){ try{ w.terminate(); }catch(e){} }
  workerPool = [];
  for(let i=0;i<count;i++){
    try{
      const w = new Worker('ai_worker.js');
      workerPool.push(w);
    }catch(e){ console.warn('Worker creation failed',e); break; }
  }
}

function setWorkerCount(n){ n = Math.max(1, Math.min(20, n)); WORKER_COUNT = n; try{ localStorage.setItem('ai_worker_cores', String(n)); }catch(e){} createWorkers(n); const el=document.getElementById('ai-log'); if(el) el.textContent += `[設定] 使用コア数を ${n} に設定しました\n`; }

// create initial pool
createWorkers(WORKER_COUNT);
// Persistence / user tracking
const SAVE_ENDPOINT = ''; // optional server endpoint (POST { userId, pgn }) - leave empty to use localStorage
let currentUserId = null;
let playerTendencies = null; // cached tendencies for current user
let gameAutoSaved = false; // ensure we autosave only once per game
let currentKifuRemoteId = null; // remote DB row id for autosave/update

function getStoredRemoteId(userId){ try{ return localStorage.getItem('kifu_remote_row_'+userId) || null; }catch(e){return null;} }
function setStoredRemoteId(userId,id){ try{ if(id) localStorage.setItem('kifu_remote_row_'+userId,String(id)); else localStorage.removeItem('kifu_remote_row_'+userId); }catch(e){} }

function getColor(piece){ if(!piece) return null; return piece===piece.toUpperCase()?'white':'black'; }
function oppositeColor(c){ return c==='white'?'black':'white'; }

function getPieceImage(piece){ if(!piece) return ''; const type=piece.toUpperCase(); const color=getColor(piece); const urls={white:{K:'https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg',Q:'https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg',R:'https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg',B:'https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg',N:'https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg',P:'https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg'},black:{K:'https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg',Q:'https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg',R:'https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg',B:'https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg',N:'https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg',P:'https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg'}}; return urls[color][type]; }

function renderBoard(){ const board=document.getElementById('board'); if(!board) return; board.innerHTML=''; const whiteInCheck=isKingInCheck('white'); const blackInCheck=isKingInCheck('black'); for(let r=0;r<8;r++){ for(let c=0;c<8;c++){ const sq=document.createElement('div'); sq.className='square '+((r+c)%2===0?'light':'dark'); if(lastMove){ if(lastMove.from.row===r && lastMove.from.col===c) sq.classList.add('move-from'); if(lastMove.to.row===r && lastMove.to.col===c) sq.classList.add('move-to'); } if(selected && selected.row===r && selected.col===c) sq.classList.add('selected'); if(legalMoves.some(m=>m.row===r && m.col===c)) sq.classList.add('highlight'); const p=boardState[r][c]; if(p){ const img=document.createElement('img'); img.src=getPieceImage(p); img.className='piece'; sq.appendChild(img); } if(p && p.toUpperCase()==='K'){ const col=getColor(p); if((col==='white'&&whiteInCheck)||(col==='black'&&blackInCheck)) sq.classList.add('in-check'); } sq.onclick=()=>handleClick(r,c); board.appendChild(sq); } } const files=document.createElement('div'); files.className='files'; for(let c=0;c<8;c++){ const sp=document.createElement('span'); sp.textContent=String.fromCharCode(97+c); files.appendChild(sp);} board.appendChild(files); const ranks=document.createElement('div'); ranks.className='ranks'; for(let r=0;r<8;r++){ const sp=document.createElement('span'); sp.textContent=8-r; ranks.appendChild(sp);} board.appendChild(ranks); }

function findKingPosition(color){ const target=color==='white'?'K':'k'; for(let r=0;r<8;r++) for(let c=0;c<8;c++) if(boardState[r][c]===target) return {row:r,col:c}; return null; }


function getCastlingSnapshot(){ return {whiteCastleK,whiteCastleQ,blackCastleK,blackCastleQ,enPassant: enPassantTarget?{row:enPassantTarget.row,col:enPassantTarget.col}:null}; }
function restoreCastlingSnapshot(s){ if(!s) return; whiteCastleK=!!s.whiteCastleK; whiteCastleQ=!!s.whiteCastleQ; blackCastleK=!!s.blackCastleK; blackCastleQ=!!s.blackCastleQ; enPassantTarget = s.enPassant?{row:s.enPassant.row,col:s.enPassant.col}:null; }

function applyMoveOnBoard(from,to){ const moving=boardState[from.row][from.col]; let captured=boardState[to.row][to.col]; const prev=getCastlingSnapshot(); let rookInfo=null; let enPassantCaptured=false; let capturedFrom=null;
  if(moving && moving.toUpperCase()==='K' && Math.abs(to.col-from.col)===2 && from.row===to.row){ // castling
    boardState[to.row][to.col]=moving; boardState[from.row][from.col]=''; if(to.col-from.col===2){ const rFrom={row:from.row,col:7}; const rTo={row:from.row,col:5}; const rp=boardState[rFrom.row][rFrom.col]; boardState[rTo.row][rTo.col]=rp; boardState[rFrom.row][rFrom.col]=''; rookInfo={from:rFrom,to:rTo,piece:rp}; } else { const rFrom={row:from.row,col:0}; const rTo={row:from.row,col:3}; const rp=boardState[rFrom.row][rFrom.col]; boardState[rTo.row][rTo.col]=rp; boardState[rFrom.row][rFrom.col]=''; rookInfo={from:rFrom,to:rTo,piece:rp}; } if(getColor(moving)==='white') whiteCastleK=whiteCastleQ=false; else blackCastleK=blackCastleQ=false; }
  else {
    // en-passant
    if(moving && moving.toUpperCase()==='P' && Math.abs(to.col-from.col)===1 && !boardState[to.row][to.col] && enPassantTarget && enPassantTarget.row===to.row && enPassantTarget.col===to.col){ const capRow=from.row; const capCol=to.col; captured=boardState[capRow][capCol]; enPassantCaptured=true; capturedFrom={row:capRow,col:capCol}; boardState[capRow][capCol]=''; boardState[to.row][to.col]=moving; boardState[from.row][from.col]=''; }
    else { boardState[to.row][to.col]=moving; boardState[from.row][from.col]=''; }
    if(moving && moving.toUpperCase()==='K'){ if(getColor(moving)==='white') whiteCastleK=whiteCastleQ=false; else blackCastleK=blackCastleQ=false; }
    if(moving && moving.toUpperCase()==='R'){ if(getColor(moving)==='white'){ if(from.row===7 && from.col===0) whiteCastleQ=false; if(from.row===7 && from.col===7) whiteCastleK=false; } else { if(from.row===0 && from.col===0) blackCastleQ=false; if(from.row===0 && from.col===7) blackCastleK=false; } }
    if(captured && captured.toUpperCase()==='R'){ if(getColor(captured)==='white'){ if(to.row===7 && to.col===0) whiteCastleQ=false; if(to.row===7 && to.col===7) whiteCastleK=false; } else { if(to.row===0 && to.col===0) blackCastleQ=false; if(to.row===0 && to.col===7) blackCastleK=false; } }
  }
  const prevEn=enPassantTarget; enPassantTarget=null; if(moving && moving.toUpperCase()==='P' && Math.abs(to.row-from.row)===2){ const mid=(to.row+from.row)/2; enPassantTarget={row:mid,col:from.col}; }
  return {moving,captured,prev,rookInfo,enPassantCaptured,capturedFrom,prevEn}; }

function undoMoveOnBoard(from,to,state){ boardState[from.row][from.col]=state.moving; boardState[to.row][to.col]=state.captured; if(state.rookInfo){ const rFrom=state.rookInfo.from; const rTo=state.rookInfo.to; boardState[rFrom.row][rFrom.col]=state.rookInfo.piece; boardState[rTo.row][rTo.col]=''; } if(state.enPassantCaptured && state.capturedFrom){ const cf=state.capturedFrom; boardState[cf.row][cf.col]=state.captured; boardState[to.row][to.col]=''; } restoreCastlingSnapshot(state.prev); enPassantTarget=state.prevEn; }
// animateMove supports an optional `state` (returned by applyMoveOnBoard) to also animate rook during castling
function animateMove(from,to,piece,state,cb){
  // allow previous signature where state was omitted
  if(typeof state === 'function'){ cb = state; state = null; }
  const boardEl=document.getElementById('board'); if(!boardEl){ if(cb) cb(); return; }
  const squares=boardEl.querySelectorAll('.square'); const srcIndex=from.row*8+from.col; const dstIndex=to.row*8+to.col; const srcEl=squares[srcIndex]; const dstEl=squares[dstIndex]; if(!srcEl||!dstEl){ renderBoard(); if(cb) cb(); return; }

  // highlight origin/destination
  srcEl.classList.add('move-from'); dstEl.classList.add('move-to');

  const img=document.createElement('img'); img.src=getPieceImage(piece); img.className='moving-piece'; document.body.appendChild(img);
  const srcRect=srcEl.getBoundingClientRect(); const dstRect=dstEl.getBoundingClientRect();
  img.style.position='absolute'; img.style.left=srcRect.left+'px'; img.style.top=srcRect.top+'px'; img.style.width=srcRect.width+'px'; img.style.height=srcRect.height+'px';
  const srcImg=srcEl.querySelector('img.piece'); const dstImg=dstEl.querySelector('img.piece'); if(srcImg) srcImg.style.visibility='hidden'; if(dstImg) dstImg.style.visibility='hidden';

  // optionally prepare rook image for castling animation
  let rookImg=null, rookSrcImg=null, rookDstImg=null, rookSrcEl=null, rookDstEl=null;
  if(state && state.rookInfo){ const rFrom=state.rookInfo.from, rTo=state.rookInfo.to, rPiece=state.rookInfo.piece; const rSrcIndex=rFrom.row*8+rFrom.col, rDstIndex=rTo.row*8+rTo.col; rookSrcEl = squares[rSrcIndex]; rookDstEl = squares[rDstIndex]; if(rookSrcEl && rookDstEl){ rookSrcEl.classList.add('move-from'); rookDstEl.classList.add('move-to'); rookImg=document.createElement('img'); rookImg.src=getPieceImage(rPiece); rookImg.className='moving-piece'; document.body.appendChild(rookImg); const rSrcRect=rookSrcEl.getBoundingClientRect(), rDstRect=rookDstEl.getBoundingClientRect(); rookImg.style.position='absolute'; rookImg.style.left=rSrcRect.left+'px'; rookImg.style.top=rSrcRect.top+'px'; rookImg.style.width=rSrcRect.width+'px'; rookImg.style.height=rSrcRect.height+'px'; rookSrcImg = rookSrcEl.querySelector('img.piece'); rookDstImg = rookDstEl.querySelector('img.piece'); if(rookSrcImg) rookSrcImg.style.visibility='hidden'; if(rookDstImg) rookDstImg.style.visibility='hidden'; } }

  // start transitions
  requestAnimationFrame(()=>{
    img.style.transition = 'left 320ms ease, top 320ms ease, transform 320ms ease';
    img.style.left = dstRect.left + 'px'; img.style.top = dstRect.top + 'px';
    if(rookImg && rookDstEl){ const rDstRect = rookDstEl.getBoundingClientRect(); rookImg.style.transition = 'left 320ms ease, top 320ms ease, transform 320ms ease'; rookImg.style.left = rDstRect.left + 'px'; rookImg.style.top = rDstRect.top + 'px'; }
  });

  setTimeout(()=>{
    if(img && img.parentNode) img.parentNode.removeChild(img);
    if(srcImg) srcImg.style.visibility=''; if(dstImg) dstImg.style.visibility=''; srcEl.classList.remove('move-from'); dstEl.classList.remove('move-to');
    if(rookImg){ if(rookImg.parentNode) rookImg.parentNode.removeChild(rookImg); if(rookSrcImg) rookSrcImg.style.visibility=''; if(rookDstImg) rookDstImg.style.visibility=''; if(rookSrcEl) rookSrcEl.classList.remove('move-from'); if(rookDstEl) rookDstEl.classList.remove('move-to'); }
    renderBoard(); if(cb) cb();
  }, 360);
}

// Schedule AI move but avoid scheduling multiple times
function scheduleAIMove(delay){
  if(gameOver){ try{ console.log('[AI] scheduleAIMove aborted: gameOver'); }catch(e){} return; }
  if(aiScheduled){ try{ console.log('[AI] scheduleAIMove aborted: already scheduled'); }catch(e){} return; }
  aiScheduled = true;
  try{ console.log('[AI] scheduleAIMove: scheduled to run in', delay, 'ms'); }catch(e){}
  setTimeout(()=>{ aiScheduled = false; if(!gameOver){ try{ console.log('[AI] scheduleAIMove: timeout reached, invoking makeAIMove'); }catch(e){} makeAIMove(); } else { try{ console.log('[AI] scheduleAIMove: timeout reached but gameOver=true, not invoking'); }catch(e){} } }, delay);
}

function evaluateBoard(){
  // Evaluation is from Black's perspective (positive = good for black)
  let s = 0;
  let whiteBishops = 0, blackBishops = 0;
  // Basic material count
  for(let r=0;r<8;r++){
    for(let c=0;c<8;c++){
      const p = boardState[r][c];
      if(!p) continue;
      const upper = p.toUpperCase();
      const val = PIECE_VALUE[upper] || 0;
      if(upper === 'B'){
        if(getColor(p) === 'white') whiteBishops++; else blackBishops++;
      }
      // white pieces subtract, black pieces add (evaluation from black POV)
      s += (getColor(p) === 'white') ? -val : val;
    }
  }

  // Bishop pair bonus
  if(blackBishops > 1) s += BISHOP_PAIR_BONUS;
  if(whiteBishops > 1) s -= BISHOP_PAIR_BONUS;

  // Count plies (number of half-moves made) to define opening phase
  let plyCount = 0;
  for(const mv of moveList){ if(mv.white) plyCount++; if(mv.black) plyCount++; }

  // Penalize early queen development strongly
  if(plyCount < QUEEN_PENALTY_PHASE_PLY){
    // white queen initial square: d1 -> row=7,col=3
    const wq = findPiecePosition('Q','white');
    if(!wq || wq.row !== 7 || wq.col !== 3) s += QUEEN_EARLY_PENALTY;
    // black queen initial square: d8 -> row=0,col=3
    const bq = findPiecePosition('q','black');
    if(!bq || bq.row !== 0 || bq.col !== 3) s -= QUEEN_EARLY_PENALTY;
  }

  // Penalize lost castling rights (early loss is severe)
  const whiteLost = (whiteCastleK?0:1) + (whiteCastleQ?0:1);
  const blackLost = (blackCastleK?0:1) + (blackCastleQ?0:1);
  if(whiteLost) s += whiteLost * CASTLING_LOST_PENALTY;
  if(blackLost) s -= blackLost * CASTLING_LOST_PENALTY;

  // --- Pawn structure heuristics ---
  const PASSED_PAWN_BASE = 0.6; // base bonus for a passed pawn
  const DOUBLED_PAWN_PENALTY = 0.25;
  const ISOLATED_PAWN_PENALTY = 0.2;
  // gather pawn info per file
  const pawnFilesW = new Array(8).fill(0);
  const pawnFilesB = new Array(8).fill(0);
  const pawnRowsW = Array.from({length:8}, ()=>[]);
  const pawnRowsB = Array.from({length:8}, ()=>[]);
  for(let r=0;r<8;r++){ for(let c=0;c<8;c++){ const p = boardState[r][c]; if(!p) continue; if(p.toUpperCase()==='P'){ if(getColor(p)==='white'){ pawnFilesW[c]++; pawnRowsW[c].push(r); } else { pawnFilesB[c]++; pawnRowsB[c].push(r); } } } }

  // doubled / isolated penalties and passed pawn bonuses
  for(let f=0;f<8;f++){
    if(pawnFilesW[f] > 1) s -= (pawnFilesW[f]-1) * DOUBLED_PAWN_PENALTY;
    if(pawnFilesB[f] > 1) s += (pawnFilesB[f]-1) * DOUBLED_PAWN_PENALTY;
    // isolated: no friendly pawn on adjacent files
    if(pawnFilesW[f] === 1){ if((pawnFilesW[f-1]||0)===0 && (pawnFilesW[f+1]||0)===0) s -= ISOLATED_PAWN_PENALTY; }
    if(pawnFilesB[f] === 1){ if((pawnFilesB[f-1]||0)===0 && (pawnFilesB[f+1]||0)===0) s += ISOLATED_PAWN_PENALTY; }
    // passed pawn: for each pawn in file, check enemy pawns on same or adjacent files ahead
    for(const r of pawnRowsW[f]){
      let blocked = false;
      for(let ef=Math.max(0,f-1); ef<=Math.min(7,f+1); ef++){
        for(const br of pawnRowsB[ef]){
          if(br < r) { blocked = true; break; } // black pawn is ahead (towards promotion) of this white pawn
        }
        if(blocked) break;
      }
      if(!blocked){ // passed white pawn
        const advancement = Math.max(0, 6 - r) / 6; // 0..1
        s -= PASSED_PAWN_BASE * (0.6 + 0.4*advancement); // good for white -> reduce black score
      }
    }
    for(const r of pawnRowsB[f]){
      let blocked = false;
      for(let ef=Math.max(0,f-1); ef<=Math.min(7,f+1); ef++){
        for(const wr of pawnRowsW[ef]){
          if(wr > r) { blocked = true; break; } // white pawn ahead of this black pawn
        }
        if(blocked) break;
      }
      if(!blocked){ // passed black pawn
        const advancement = Math.max(0, r - 1) / 6; // 0..1 (row increases toward white side)
        s += PASSED_PAWN_BASE * (0.6 + 0.4*advancement);
      }
    }
  }

  // --- Mobility / piece activity ---
  const MOBILITY_WEIGHT = 0.045; // pawns per legal move
  let whiteMob = 0, blackMob = 0;
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p = boardState[r][c]; if(!p) continue; const color = getColor(p); try{ const moves = getLegalMoves(r,c); if(color==='white') whiteMob += moves.length; else blackMob += moves.length; }catch(e){} }
  s += (blackMob - whiteMob) * MOBILITY_WEIGHT;

  // --- King safety heuristics ---
  const CASTLED_BONUS = 0.4; // bonus for having castled
  const SHIELD_IMPORTANCE = 0.28; // penalty per missing shield pawn below threshold
  const ATTACKER_PENALTY = 0.5; // per attacker near king

  function kingSafetyFor(color){
    const kpos = findKingPosition(color);
    if(!kpos) return 0;
    let score = 0;
    const isWhite = color==='white';
    // detect castled (simple heuristic: king on g/file (col6) or c/file (col2) on starting rank)
    if(isWhite){ if(kpos.row===7 && (kpos.col===6 || kpos.col===2)) score -= CASTLED_BONUS; }
    else { if(kpos.row===0 && (kpos.col===6 || kpos.col===2)) score += CASTLED_BONUS; }

    // pawn shield: count friendly pawns on 1-2 ranks in front of king and within adjacent files
    let shield = 0;
    const files = [kpos.col-1, kpos.col, kpos.col+1];
    for(const f of files){ if(f<0||f>7) continue; if(isWhite){ // front is row-1, row-2
        const r1 = kpos.row-1, r2 = kpos.row-2;
        if(r1>=0 && boardState[r1][f] && boardState[r1][f].toUpperCase()==='P' && getColor(boardState[r1][f])==='white') shield++;
        else if(r2>=0 && boardState[r2][f] && boardState[r2][f].toUpperCase()==='P' && getColor(boardState[r2][f])==='white') shield++;
      } else {
        const r1 = kpos.row+1, r2 = kpos.row+2;
        if(r1<8 && boardState[r1][f] && boardState[r1][f].toUpperCase()==='P' && getColor(boardState[r1][f])==='black') shield++;
        else if(r2<8 && boardState[r2][f] && boardState[r2][f].toUpperCase()==='P' && getColor(boardState[r2][f])==='black') shield++;
      } }
    // penalize missing shield (ideal ~2-3)
    if(shield < 2){ const miss = 2 - shield; if(isWhite) score += miss * SHIELD_IMPORTANCE; else score -= miss * SHIELD_IMPORTANCE; }

    // count attackers targeting king square or adjacent squares
    let attackers = 0;
    for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p = boardState[r][c]; if(!p) continue; if(getColor(p)===color) continue; const moves = getLegalMoves(r,c); for(const m of moves){ const dr = Math.abs(m.row - kpos.row), dc = Math.abs(m.col - kpos.col); if(dr<=1 && dc<=1){ attackers++; break; } } }
    if(attackers>0){ if(isWhite) score += attackers * ATTACKER_PENALTY; else score -= attackers * ATTACKER_PENALTY; }

    return score;
  }

  s += kingSafetyFor('black');
  s += kingSafetyFor('white');

  return s;
}

// Helper: find a piece of given symbol and color, return first occurrence or null
function findPiecePosition(symbol, color){
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p = boardState[r][c]; if(!p) continue; if(p.toUpperCase()===symbol.toUpperCase() && getColor(p)===color) return {row:r,col:c}; }
  return null;
}

// --- Zobrist hashing + Transposition Table for faster search ---
const ZOBRIST_PIECE = {}; // map pieceSymbol -> array[64]
const ZOBRIST_CASTLE = { wK: rand32(), wQ: rand32(), bK: rand32(), bQ: rand32() };
const ZOBRIST_EP = new Array(8).fill(0).map(()=>rand32());
const ZOBRIST_SIDE = rand32();
const TT = new Map(); // zob -> { depth, value, flag, bestMove }

// pseudo-random generator for deterministic 32-bit numbers
function rand32(seed){ // xorshift
  let x = (seed === undefined ? 0x9e3779b1 : seed) >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0;
}
// Initialize piece keys
(function(){ const pieces = ['P','N','B','R','Q','K','p','n','b','r','q','k']; for(const p of pieces){ const arr = new Array(64); for(let i=0;i<64;i++) arr[i]=rand32(i + p.charCodeAt(0)); ZOBRIST_PIECE[p]=arr; } })();

function computeZobristHash(){ let h = 0 >>> 0; for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p = boardState[r][c]; if(!p) continue; const idx = r*8 + c; const arr = ZOBRIST_PIECE[p]; if(arr) h = (h ^ arr[idx]) >>> 0; }
  if(whiteCastleK) h = (h ^ ZOBRIST_CASTLE.wK) >>> 0; if(whiteCastleQ) h = (h ^ ZOBRIST_CASTLE.wQ) >>> 0; if(blackCastleK) h = (h ^ ZOBRIST_CASTLE.bK) >>> 0; if(blackCastleQ) h = (h ^ ZOBRIST_CASTLE.bQ) >>> 0;
  if(enPassantTarget) { const file = enPassantTarget.col; if(file>=0 && file<8) h = (h ^ ZOBRIST_EP[file]) >>> 0; }
  if(currentTurn === 'white') h = (h ^ ZOBRIST_SIDE) >>> 0; return String(h);
}

function negamax(depth,color,alpha,beta){
  const zob = computeZobristHash();
  const ttEntry = TT.get(zob);
  const originalAlpha = alpha;
  if(ttEntry && ttEntry.depth >= depth){ if(ttEntry.flag === 'EXACT') return ttEntry.value; if(ttEntry.flag === 'LOWER' && ttEntry.value > alpha) alpha = ttEntry.value; if(ttEntry.flag === 'UPPER' && ttEntry.value < beta) beta = ttEntry.value; if(alpha >= beta) return ttEntry.value; }
  if(depth===0) return color==='black'? evaluateBoard(): -evaluateBoard();

  // generate all moves for color and order them
  const moves = [];
  for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p=boardState[r][c]; if(!p||getColor(p)!==color) continue; const legal=getLegalMovesFiltered(r,c); for(const mv of legal) moves.push({ from:{row:r,col:c}, to:mv, piece:p }); }
  if(moves.length===0) return color==='black'? evaluateBoard(): -evaluateBoard();

  // basic move ordering: prefer TT best move, captures (MVV-LVA), promotions
  moves.forEach(mv=>{
    let sc = 0;
    const target = boardState[mv.to.row][mv.to.col];
    if(target) sc += (PIECE_VALUE[target.toUpperCase()] - (PIECE_VALUE[mv.piece.toUpperCase()]||0)) * 100;
    if(mv.piece.toUpperCase()==='P'){ const colr=getColor(mv.piece); const promoRow = colr==='white'?0:7; if(mv.to.row===promoRow) sc += 500; }
    mv._order = sc;
  });
  if(ttEntry && ttEntry.bestMove){ moves.forEach(mv=>{ const bm=ttEntry.bestMove; if(mv.from.row===bm.from.row && mv.from.col===bm.from.col && mv.to.row===bm.to.row && mv.to.col===bm.to.col) mv._order += 10000; }); }
  moves.sort((a,b)=>b._order - a._order);

  let max = -Infinity; let bestLocal = null;
  for(const mv of moves){
    const st = applyMoveOnBoard(mv.from,mv.to);
    let promoted = null;
    if(st.moving && st.moving.toUpperCase()==='P'){ const colr=getColor(st.moving); const promoRow=colr==='white'?0:7; if(mv.to.row===promoRow){ promoted=boardState[mv.to.row][mv.to.col]; boardState[mv.to.row][mv.to.col]= colr==='white'?'Q':'q'; } }
    const val = -negamax(depth-1, oppositeColor(color), -beta, -alpha);
    if(promoted!==null) boardState[mv.to.row][mv.to.col]=promoted;
    undoMoveOnBoard(mv.from,mv.to,st);
    if(val > max){ max = val; bestLocal = mv; }
    if(val > alpha) alpha = val;
    if(alpha >= beta) break;
  }

  // store in transposition table
  const entry = { depth: depth, value: max, bestMove: bestLocal };
  if(max <= originalAlpha) entry.flag = 'UPPER';
  else if(max >= beta) entry.flag = 'LOWER';
  else entry.flag = 'EXACT';
  try{ TT.set(zob, entry); }catch(e){}
  return max;
}

function coord(pos){ return String.fromCharCode(97+pos.col)+(8-pos.row); }
function formatMove(piece, from, to, opts = {}) {
  // Generate SAN (PGN-style) for a single move.
  // Supports: castling (O-O/O-O-O), captures (including en-passant), promotions (=Q), disambiguation (file/rank), and check/mate markers (+/#).
  if (!piece) return '';
  const color = getColor(piece);
  const type = piece.toUpperCase();

  // Castling
  if (type === 'K' && Math.abs(to.col - from.col) === 2) {
    return (to.col > from.col) ? 'O-O' : 'O-O-O';
  }

  // Determine if this is a capture. Prefer explicit target in opts if provided (used when caller knows target before applying move).
  let target = (typeof opts.target !== 'undefined') ? opts.target : boardState[to.row][to.col];
  let isCapture = !!target;
  // en-passant detection: pawn moves to empty square but enPassantTarget was set
  if (!isCapture && type === 'P' && enPassantTarget && enPassantTarget.row === to.row && enPassantTarget.col === to.col) isCapture = true;

  // Promotion detection (if caller supplied promotion in opts, use it; otherwise infer from destination rank)
  let promotion = opts.promotion || null;
  if (!promotion && type === 'P') {
    const promoRow = color === 'white' ? 0 : 7;
    if (to.row === promoRow) promotion = 'Q';
  }

  let san = '';
  if (type === 'P') {
    // Pawn: use file on capture (exd5), otherwise destination only (e4)
    if (isCapture) san += String.fromCharCode(97 + from.col) + 'x' + coord(to);
    else san += coord(to);
    if (promotion) san += '=' + promotion.toUpperCase();
  } else {
    // Piece moves: letter + disambiguation (if needed) + optional 'x' + dest
    san += type;
    // Find other pieces of same type and color that can move to 'to'
    const others = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = boardState[r][c];
      if (!p) continue;
      if (p.toUpperCase() === type && getColor(p) === color) {
        if (r === from.row && c === from.col) continue;
        const legal = getLegalMovesFiltered(r, c);
        if (legal.some(m => m.row === to.row && m.col === to.col)) others.push({row: r, col: c});
      }
    }
    if (others.length > 0) {
      // need disambiguation: prefer file if it distinguishes, else rank, else both
      const fileDiffers = others.some(o => o.col !== from.col);
      const rankDiffers = others.some(o => o.row !== from.row);
      if (fileDiffers && !rankDiffers) san += String.fromCharCode(97 + from.col);
      else if (!fileDiffers && rankDiffers) san += (8 - from.row);
      else if (fileDiffers && rankDiffers) san += String.fromCharCode(97 + from.col) + (8 - from.row);
      else san += String.fromCharCode(97 + from.col); // fallback
    }
    if (isCapture) san += 'x';
    san += coord(to);
  }

  // Append check/mate markers by simulating the move
  const state = applyMoveOnBoard(from, to);
  const opponent = oppositeColor(color);
  let suffix = '';
  if (isCheckmate(opponent)) suffix = '#';
  else if (isKingInCheck(opponent)) suffix = '+';
  undoMoveOnBoard(from, to, state);

  return san + suffix;
}

function appendMoveToKifu(san,isAI=false){ if(isAI){ if(moveList.length===0||moveList[moveList.length-1].black) moveList.push({white:null,black:san}); else moveList[moveList.length-1].black=san; } else moveList.push({white:san,black:null}); renderKifu(); }
function renderKifu(){ const el=document.getElementById('moves'); if(!el) return; el.textContent = moveList.map((m,i)=>`${i+1}. ${m.white||''} ${m.black||''}`).join('\n'); }

function handleClick(row,col){ return handleClickMain ? handleClickMain(row,col) : null; }

/* Duplicate earlier async makeAIMove implementation removed. Using the primary makeAIMove() implementation later in this file. */

function setupKifuDownloadButtons(){ const btnP=document.getElementById('download-pgn'); if(btnP) btnP.onclick=()=>downloadText('game.pgn',generatePGN()); const btnT=document.getElementById('download-txt'); if(btnT) btnT.onclick=()=>downloadText('game.txt',generateTXT()); }
function generatePGN(){ const today=new Date().toISOString().slice(0,10); let header=`[Event "?"]\n[Site "?"]\n[Date "${today}"]\n[Round "?"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n`; const movesStr=moveList.map((m,i)=>`${i+1}. ${m.white||''}${m.black? ' '+m.black:''}`).join(' '); return header+movesStr+' *'; }
function generateTXT(){ return moveList.map((m,i)=>`${i+1}. ${m.white||''} ${m.black||''}`).join('\n'); }
function downloadText(filename,text){ const blob=new Blob([text],{type:'text/plain;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }

window.addEventListener('load', ()=>{ setupKifuDownloadButtons(); renderBoard();
  try{
    const inp = document.getElementById('search-depth-input');
    if(inp){ inp.value = String(SEARCH_DEPTH); inp.addEventListener('change', ()=>{
      let v = parseInt(inp.value,10); if(isNaN(v)) v = SEARCH_DEPTH; v = Math.max(1, Math.min(8, v)); inp.value = String(v);
      SEARCH_DEPTH = v;
      try{ localStorage.setItem('ai_search_depth', String(v)); }catch(e){}
      const el = document.getElementById('ai-log'); if(el) el.textContent += `[設定] 探索深さを ${v} に設定しました\n`;
    }); }
    const cores = document.getElementById('search-cores-input');
    if(cores){ cores.value = String(WORKER_COUNT); cores.addEventListener('change', ()=>{ let cv = parseInt(cores.value,10); if(isNaN(cv)) cv = WORKER_COUNT; cv = Math.max(1, Math.min(8, cv)); cores.value = String(cv); setWorkerCount(cv); }); }
  }catch(e){}
});

// --- Manual SAN/PGN input for White ---
function parseSAN(san){
  // Normalize
  if(!san || typeof san !== 'string') return null;
  san = san.trim();
  if(san==='') return null;
  // castling
  if(san === 'O-O' || san === '0-0') return {type:'castle',side:'k'};
  if(san === 'O-O-O' || san === '0-0-0') return {type:'castle',side:'q'};
  // promotion like e8=Q
  const promoMatch = san.match(/^([a-h][18])=([QRBN])$/i);
  if(promoMatch) return {type:'pawn',to:coordToPos(promoMatch[1]),promotion:promoMatch[2].toUpperCase()};
  // pawn capture exd5 or pawn move e4
  const pawnCap = san.match(/^([a-h])x([a-h][1-8])$/i);
  if(pawnCap) return {type:'pawn-capture',fromFile:pawnCap[1].toLowerCase(),to:coordToPos(pawnCap[2])};
  const pawnMove = san.match(/^([a-h][1-8])$/i);
  if(pawnMove) return {type:'pawn-move',to:coordToPos(pawnMove[1])};
  // piece move: Nbd2, Nbd2, Nxd2, Nbxd2
  const pieceRe = san.match(/^([KQRBN])([a-h1-8]?)(x?)([a-h][1-8])$/i);
  if(pieceRe){ return {type:'piece',piece:pieceRe[1].toUpperCase(),disamb:pieceRe[2]||'',capture:pieceRe[3]==='x',to:coordToPos(pieceRe[4])}; }
  return null;
}

function coordToPos(s){ if(!s || s.length<2) return null; const file=s[0].toLowerCase(); const rank=parseInt(s[1],10); return {row:8-rank, col: file.charCodeAt(0)-97}; }

function applySANAsWhite(sanStr){
  if(currentTurn !== 'white') return false;
  const parsed = parseSAN(sanStr);
  if(!parsed) return false;
  if(parsed.type === 'castle'){
    // find white king and check legal castling moves
    const kpos = findKingPosition('white');
    const legal = getLegalMovesFiltered(kpos.row,kpos.col,{includeCastling:true});
  for(const m of legal){ if(parsed.side==='k' && m.col===6){ handleMove(kpos.row,kpos.col,m.row,m.col); maybeScheduleBlackAI(400); return true; } if(parsed.side==='q' && m.col===2){ handleMove(kpos.row,kpos.col,m.row,m.col); maybeScheduleBlackAI(400); return true; } }
    return false;
  }
  if(parsed.type==='pawn-move' || parsed.type==='pawn-capture' || parsed.type==='pawn'){
    // find pawn(s) that can move to parsed.to
    const targets = [];
    for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p=boardState[r][c]; if(!p) continue; if(p.toUpperCase()!=='P') continue; if(getColor(p)!=='white') continue; const legal=getLegalMovesFiltered(r,c); if(legal.some(m=>m.row===parsed.to.row && m.col===parsed.to.col)){
      // if pawn-capture, ensure fromFile matches
      if(parsed.type==='pawn-capture' && c !== (parsed.fromFile.charCodeAt(0)-97)) continue;
      targets.push({from:{row:r,col:c},to:parsed.to});
    } }
    if(targets.length===1){ const t=targets[0]; handleMove(t.from.row,t.from.col,t.to.row,t.to.col); maybeScheduleBlackAI(400); return true; }
    if(targets.length>1){ // ambiguous, choose left-most as fallback
      const t=targets[0]; handleMove(t.from.row,t.from.col,t.to.row,t.to.col); maybeScheduleBlackAI(400); return true; }
    return false;
  }
  if(parsed.type==='piece'){
    const neededType = parsed.piece;
    const cand = [];
    for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p=boardState[r][c]; if(!p) continue; if(p.toUpperCase()!==neededType) continue; if(getColor(p)!=='white') continue; const legal=getLegalMovesFiltered(r,c); if(legal.some(m=>m.row===parsed.to.row && m.col===parsed.to.col)) cand.push({row:r,col:c}); }
    if(cand.length===0) return false;
    // apply disambiguation if present
    let chosen = null;
    if(parsed.disamb){ const d=parsed.disamb; if(/[a-h]/i.test(d)){ const col = d.toLowerCase().charCodeAt(0)-97; chosen = cand.find(x=>x.col===col); }
      if(!chosen && /[1-8]/.test(d)){ const row = 8-parseInt(d,10); chosen = cand.find(x=>x.row===row); }
    }
    if(!chosen){ if(cand.length===1) chosen=cand[0]; else chosen=cand[0]; }
    if(!chosen) return false;
  handleMove(chosen.row, chosen.col, parsed.to.row, parsed.to.col);
  maybeScheduleBlackAI(400);
  return true;
  }
  return false;
}

// wire UI
window.addEventListener('load', ()=>{
  const btn = document.getElementById('pgn-go');
  const inp = document.getElementById('pgn-input');
  if(btn && inp){ btn.onclick=()=>{ const v=inp.value.trim(); if(v) { const ok=applySANAsWhite(v); if(!ok) alert('その手は適用できません（白の手番か合法手か確認してください）'); else { inp.value=''; renderBoard(); } } }; }
});

// Mobile detection: add 'mobile' class when running on touch device / small viewport
function detectMobile(){
  try{
    const storedUA = (function(){ try{ return localStorage.getItem('ua_override')||''; }catch(e){return '';}})();
    const ua = storedUA || (navigator.userAgent || '');
    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const smallViewport = Math.min(window.innerWidth||9999, window.innerHeight||9999) <= 900;
    const mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);

    // Detect Windows platform (prefer navigator.platform as it's more reliable than UA overrides)
    const platform = (navigator.platform || '').toString();
    const isWindows = /Win(dows)?|Win32|Win64/i.test(platform) || /Windows NT|Win32|Win64|Windows/i.test(ua);

    // If we're on a real Windows platform and user hasn't explicitly chosen a display mode (auto),
    // prefer the desktop layout. This ensures traditional Windows desktops get the desktop UI even
    // when window is not fullscreen.
    // Note: display_mode user preference (stored) is checked below and will override this when set.
    if (isWindows) {
      document.body.classList.remove('mobile');
      document.body.classList.add('desktop');
      try{ setTimeout(forceBoardSizing, 40); }catch(e){}
      return;
    }

    // Detect non-fullscreen / windowed desktop: if the window inner size is noticeably smaller than the screen,
    // consider it 'not fullscreen' and prefer the mobile layout for better fit.
    const widthDiff = (screen.width || 0) - (window.innerWidth || 0);
    const heightDiff = (screen.height || 0) - (window.innerHeight || 0);
    const notFullScreen = (widthDiff > 120) || (heightDiff > 80);

    // if user has explicitly chosen a display mode, skip automatic toggling
    const pref = (function(){ try{ return localStorage.getItem('display_mode')||'auto'; }catch(e){ return 'auto'; } })();
    if(pref === 'desktop'){ document.body.classList.remove('mobile'); document.body.classList.add('desktop'); return; }
    if(pref === 'mobile'){ document.body.classList.add('mobile'); document.body.classList.remove('desktop'); return; }

    if(isTouch || mobileUA || smallViewport || notFullScreen){ document.body.classList.add('mobile'); document.body.classList.remove('desktop'); }
    else { document.body.classList.remove('mobile'); document.body.classList.add('desktop'); }
    // ensure board sizing after detection
    try{ setTimeout(forceBoardSizing, 40); }catch(e){}
  }catch(e){}
}
window.addEventListener('load', detectMobile);
window.addEventListener('resize', ()=>{ setTimeout(detectMobile, 120); });

// Display mode UI helpers (Auto / Desktop / Mobile)
function applyDisplayMode(pref){
  try{ localStorage.setItem('display_mode', pref); }catch(e){}
  const sel = document.getElementById('display-mode-select'); if(sel) sel.value = pref;
  if(pref === 'desktop'){ document.body.classList.remove('mobile'); document.body.classList.add('desktop'); }
  else if(pref === 'mobile'){ document.body.classList.add('mobile'); document.body.classList.remove('desktop'); }
  else { detectMobile(); }
  try{ setTimeout(forceBoardSizing, 40); }catch(e){}
}

// Ensure board element is visible and sized according to --square-size
function forceBoardSizing(){
  try{
    const board = document.getElementById('board'); if(!board) return;
    const root = getComputedStyle(document.documentElement);
    let sq = root.getPropertyValue('--square-size') || '60px'; sq = sq.trim();
    // compute total
    const match = sq.match(/^([0-9.]+)px$/);
    if(match){ const val = parseFloat(match[1]); const total = (val*8) + 'px'; board.style.width = total; board.style.height = total; board.style.minWidth = total; board.style.minHeight = total; }
    board.style.display = 'grid'; board.style.visibility = 'visible';
  }catch(e){}
}

window.addEventListener('load', ()=>{
  // wire display mode select
  const sel = document.getElementById('display-mode-select');
  try{
    const stored = localStorage.getItem('display_mode')||'auto';
    if(sel){ sel.value = stored; sel.addEventListener('change', ()=>{ applyDisplayMode(sel.value); }); }
    // apply initially
    applyDisplayMode(stored);
  }catch(e){}
});

// Ensure board sizing and initial render after full load
window.addEventListener('load', ()=>{ setTimeout(()=>{ try{ forceBoardSizing(); renderBoard(); }catch(e){} }, 120); });

// Browser info panel wiring
window.addEventListener('load', ()=>{
  try{
    const details = document.getElementById('browser-details');
    const uaInput = document.getElementById('ua-override-input');
    const btnApply = document.getElementById('ua-apply');
    const btnClear = document.getElementById('ua-clear');
    const actualUA = navigator.userAgent || '';
    const stored = localStorage.getItem('ua_override')||'';
    if(details) details.textContent = `Actual UA: ${actualUA}` + (stored? `\nOverride: ${stored}` : '');
    if(uaInput) uaInput.value = stored;
    if(btnApply) btnApply.onclick = ()=>{ const v = uaInput.value.trim(); try{ if(v) localStorage.setItem('ua_override', v); else localStorage.removeItem('ua_override'); }catch(e){} if(details) details.textContent = `Actual UA: ${actualUA}\nOverride: ${v}`; detectMobile(); };
    if(btnClear) btnClear.onclick = ()=>{ try{ localStorage.removeItem('ua_override'); }catch(e){} if(uaInput) uaInput.value=''; if(details) details.textContent = `Actual UA: ${actualUA}`; detectMobile(); };
  }catch(e){ }
});


function showCheck(color) {
  // show a centered colored 'チェック' for 2s then move it to bottom
  const el = document.getElementById('game-message');
  if (!el) return;
  // if already visible for same color, don't re-show (prevents re-trigger on piece selection)
  if (checkVisible && lastCheckColor === color) return;
  // clear any previous timers
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
  if (checkFadeTimer) { clearTimeout(checkFadeTimer); checkFadeTimer = null; }
  // set text and color
  el.innerHTML = `<div class="mate-text small">チェック</div>`;
  el.style.display = 'block';
  el.style.opacity = '1';
  el.className = 'show-message';
  // color background: white -> light, black -> dark
  if (color === 'white') { el.style.background = 'rgba(255,255,255,0.95)'; el.style.color = '#000'; }
  else { el.style.background = 'rgba(0,0,0,0.88)'; el.style.color = '#fff'; }
  // ensure it's centered (not moved)
  el.classList.remove('moved-to-bottom');
  checkVisible = true; lastCheckColor = color;
  // after 1 second, fade out and clear
  checkTimer = setTimeout(() => {
    el.style.transition = 'opacity 0.35s ease';
    el.style.opacity = '0';
    checkFadeTimer = setTimeout(() => {
      el.style.display = 'none';
      el.style.transition = '';
      el.innerHTML = '';
      el.style.background = '';
      el.style.color = '';
      checkVisible = false; lastCheckColor = null;
      checkTimer = null; checkFadeTimer = null;
    }, 350);
  }, 1000);
}

// チェックメイト判定（簡易）: king がチェックで、合法手が一つもない場合
function hasAnyLegalMove(color) {
  for (let r=0;r<8;r++){
    for (let c=0;c<8;c++){
      const p = boardState[r][c];
      if (!p || getColor(p)!==color) continue;
      const legal = getLegalMovesFiltered(r,c);
      if (legal.length>0) return true;
    }
  }
  return false;
}

function isCheckmate(color) {
  // Standard checkmate: king is in check and no legal move by any piece relieves the check
  if (!isKingInCheck(color)) return false;
  return !hasAnyLegalMove(color);
}

// After a move, check whether the side to move is in check or checkmate and show UI
function checkForCheckOrMate(){
  const sideToMove = currentTurn; // the side who will move (may be in check)
  if (isCheckmate(sideToMove)){
    const winner = oppositeColor(sideToMove);
    showGameMessage('チェックメイト', true, winner);
    renderBoard();
    return;
  }
  if (isKingInCheck(sideToMove)){
    showCheck(sideToMove);
  }
}

function showGameMessage(text, isMate=false, winnerColor=null) {
  const el = document.getElementById('game-message');
  if (!el) return;
  if (isMate) {
    el.innerHTML = `<div class="mate-text">${text}</div><button id="restart-btn">再スタート</button>`;
    gameOver = true;
  } else {
    el.innerHTML = `<div class="mate-text small">${text}</div>`;
  }
  el.className = 'show-message' + (isMate? ' mate-explosion':'');
  // style by winner color if provided (for mate)
  if (isMate && winnerColor) {
    if (winnerColor === 'white') {
      el.style.background = 'rgba(255,255,255,0.98)';
      el.style.color = '#000';
    } else {
      el.style.background = 'rgba(0,0,0,0.95)';
      el.style.color = '#fff';
    }
  }
  // ensure any previous fade/transition state is cleared so message is visible
  el.style.transition = '';
  el.style.opacity = '1';
  el.style.display = 'block';
  // attach restart handler when mate
  if (isMate) {
    const btn = document.getElementById('restart-btn');
    if (btn) {
      btn.onclick = resetGame;
      // style the button so it's visible against the winner background
      if (winnerColor === 'white') {
        btn.style.background = '#000'; btn.style.color = '#fff';
      } else {
        btn.style.background = '#fff'; btn.style.color = '#000';
      }
    }
  }
}

function hideGameMessage(){
  const el = document.getElementById('game-message'); if (!el) return;
  el.className=''; el.style.display='none'; el.innerHTML=''; gameOver = false;
  // clear any pending check timers and flags
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
  if (checkFadeTimer) { clearTimeout(checkFadeTimer); checkFadeTimer = null; }
  checkVisible = false; lastCheckColor = null;
  el.style.opacity = '';
  el.style.transition = '';
}

function resetGame() {
  // restore initial board
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) boardState[r][c] = INITIAL_BOARD[r][c];
  selected = null; legalMoves = []; currentTurn = 'white'; opponentHistory = []; moveList = []; aiHistory.length = 0; gameOver = false;
  const aiEl = document.getElementById('ai-log'); if (aiEl) aiEl.textContent = '';
  // clear any pending check timers and reset message/flags
  if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
  if (checkFadeTimer) { clearTimeout(checkFadeTimer); checkFadeTimer = null; }
  checkVisible = false; lastCheckColor = null; prevWhiteInCheck = false; prevBlackInCheck = false;
  const msg = document.getElementById('game-message'); if (msg) { msg.className=''; msg.style.display='none'; msg.innerHTML=''; msg.style.background=''; msg.style.color=''; msg.style.opacity=''; msg.style.transition=''; }
  renderKifu(); renderBoard();
}

// --------------------- Persistence: user ID + kifu save ---------------------
function generateUUID(){ // RFC4122 v4 simple
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{ const r=Math.random()*16|0; const v=c==='x'?r:(r&0x3|0x8); return v.toString(16); });
}
function setCookie(name,value,days=365){ const d=new Date(); d.setTime(d.getTime()+days*24*60*60*1000); document.cookie = `${name}=${value};expires=${d.toUTCString()};path=/`; }
function getCookie(name){ const m=document.cookie.match(new RegExp('(^| )'+name+'=([^;]+)')); return m?m[2]:null; }

function ensureUserId(){ if(currentUserId) return currentUserId; let id=getCookie('player_uuid'); if(!id){ id=generateUUID(); setCookie('player_uuid',id,3650); } currentUserId=id; return id; }
// Display a small badge on the page with the current user id and a copy button
function showUserIdBadge(){ try{
    const uid = ensureUserId();
    if(!uid) return;
    let badge = document.getElementById('user-id-badge');
    if(!badge){ badge = document.createElement('div'); badge.id = 'user-id-badge'; badge.style.position = 'fixed'; badge.style.left = '12px'; badge.style.bottom = '12px'; badge.style.padding = '8px 10px'; badge.style.background = 'rgba(0,0,0,0.6)'; badge.style.color = '#fff'; badge.style.fontSize = '12px'; badge.style.borderRadius = '6px'; badge.style.zIndex = 9999; badge.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)'; badge.style.backdropFilter = 'blur(4px)'; badge.style.display = 'flex'; badge.style.alignItems = 'center'; badge.style.gap = '8px';
      const span = document.createElement('span'); span.id = 'user-id-badge-text'; span.style.maxWidth = '320px'; span.style.overflow = 'hidden'; span.style.textOverflow = 'ellipsis'; span.style.whiteSpace = 'nowrap'; badge.appendChild(span);
      const btn = document.createElement('button'); btn.id = 'user-id-badge-copy'; btn.textContent = 'コピー'; btn.style.fontSize='12px'; btn.style.padding='4px 6px'; btn.style.border='none'; btn.style.borderRadius='4px'; btn.style.cursor='pointer'; btn.style.background='#fff'; btn.style.color='#000'; btn.onclick = ()=>{ const text = uid; if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(()=>{ btn.textContent='コピー済み'; setTimeout(()=>btn.textContent='コピー',1200); }).catch(()=>{ prompt('ユーザーIDをコピーしてください（Ctrl+C）', text); }); else { prompt('ユーザーIDをコピーしてください（Ctrl+C）', text); } };
      badge.appendChild(btn);
      // toggle: indicate whether black is controlled by AI
      const aiLabel = document.createElement('div'); aiLabel.id = 'user-black-ai-label'; aiLabel.style.fontSize='12px'; aiLabel.style.padding='4px 6px'; aiLabel.style.background='transparent'; aiLabel.style.color='#fff'; aiLabel.style.display='flex'; aiLabel.style.alignItems='center'; aiLabel.style.gap='6px';
      const aiText = document.createElement('span'); aiText.id = 'user-black-ai-text'; aiText.textContent = (blackIsAI? '黒: AI' : '黒: 人間'); aiLabel.appendChild(aiText);
      const aiToggle = document.createElement('button'); aiToggle.id = 'user-black-ai-toggle'; aiToggle.textContent = (blackIsAI? '切替' : '切替'); aiToggle.style.fontSize='12px'; aiToggle.style.padding='4px 6px'; aiToggle.style.border='none'; aiToggle.style.borderRadius='4px'; aiToggle.style.cursor='pointer'; aiToggle.onclick = ()=>{
        try{
          blackIsAI = !blackIsAI;
          localStorage.setItem('black_is_ai', blackIsAI? '1':'0');
          const t = document.getElementById('user-black-ai-text'); if(t) t.textContent = (blackIsAI? '黒: AI' : '黒: 人間');
        }catch(e){}
      };
      aiLabel.appendChild(aiToggle);
      badge.appendChild(aiLabel);
      document.body.appendChild(badge);
    }
    const txt = document.getElementById('user-id-badge-text'); if(txt) txt.textContent = 'ユーザーID: ' + uid;
  }catch(e){ console.warn('showUserIdBadge failed', e); } }

// add a persistent rematch button into the kifu-controls area
function ensureRematchButton(){ try{
  const controls = document.getElementById('kifu-controls'); if(!controls) return;
  if(document.getElementById('rematch-btn')) return; // already added
  const btn = document.createElement('button'); btn.id = 'rematch-btn'; btn.textContent = '再戦'; btn.title = '新しく対局を開始します';
  btn.style.marginLeft = '6px'; btn.onclick = ()=>{ resetGame(); };
  controls.appendChild(btn);
}catch(e){ console.warn('ensureRematchButton failed', e); }}

// call once at load
try{ window.addEventListener('load', ()=>{ ensureRematchButton(); showUserIdBadge(); }); }catch(e){}
// Compression and hashing helpers
async function compressStringToBase64(input){
  try{
    const encoder = new TextEncoder(); const u8 = encoder.encode(input);
    if(typeof CompressionStream === 'function'){
      const cs = new CompressionStream('gzip');
      const stream = new Response(u8).body.pipeThrough(cs);
      const ab = await new Response(stream).arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
      return b64;
    }
  }catch(e){}
  // fallback: base64 of UTF-8 bytes (no compression)
  const u8 = new TextEncoder().encode(input);
  let binary = '';
  const chunk = 0x8000;
  for(let i=0;i<u8.length;i+=chunk) binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i,i+chunk)));
  return btoa(binary);
}

async function decompressBase64ToString(b64){
  try{
    const bytes = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
    if(typeof DecompressionStream === 'function'){
      const ds = new DecompressionStream('gzip');
      try{
        const stream = new Response(bytes).body.pipeThrough(ds);
        const ab = await new Response(stream).arrayBuffer();
        return new TextDecoder().decode(ab);
      }catch(e){}
    }
    // fallback: decode UTF-8 bytes
    return new TextDecoder().decode(bytes);
  }catch(e){ return ''; }
}

async function hashStringSHA256(input){ try{ const data = new TextEncoder().encode(input); const hash = await crypto.subtle.digest('SHA-256', data); const b64 = btoa(String.fromCharCode(...new Uint8Array(hash))); return b64; }catch(e){ // fallback simple hash
    let h=0; for(let i=0;i<input.length;i++){ h = ((h<<5)-h)+input.charCodeAt(i); h |= 0; } return String(h>>>0); } }

// attempt remote save if endpoint configured; when SAVE_ENDPOINT is set we persist only to remote DB
async function saveKifuRecord(){
  const userId = ensureUserId();
  const pgn = generatePGN();
  const timestamp = new Date().toISOString();
  const hash = await hashStringSHA256(pgn);
  const payload = { userId, timestamp, hash };
  try{ payload.pgn = await compressStringToBase64(pgn); payload.compressed = true; }catch(e){ payload.pgn = pgn; payload.compressed = false; }
  // Try remote first when endpoint configured. If remote fails, fall back to local save so data isn't lost.
  if(SAVE_ENDPOINT){
    const rid = currentKifuRemoteId || getStoredRemoteId(userId);
    const base = SAVE_ENDPOINT.replace(/\/+$/,'');
    const url = rid ? (base + '/' + encodeURIComponent(rid)) : base;
    const method = rid ? 'PATCH' : 'POST';
    try{
      const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      if(!r.ok) throw new Error('http '+r.status);
      const data = await r.json().catch(()=>null);
      const newId = data && data.id ? data.id : (rid || null);
      if(newId){ currentKifuRemoteId = newId; setStoredRemoteId(userId,newId); }
      logSave('saved to remote');
      // also cache remote-saved record locally for offline viewing
      try{ const key = 'kifu_store_'+userId; const cur = JSON.parse(localStorage.getItem(key)||'[]'); cur.push(payload); while(cur.length>200) cur.shift(); localStorage.setItem(key, JSON.stringify(cur)); }catch(e){}
      return;
    }catch(err){
      console.warn('remote save failed, falling back to local', err);
      logSave('remote save failed — saved locally as fallback');
      try{ await localSave(payload); }catch(e){ console.warn('local save also failed', e); }
      return;
    }
  }

  // when no SAVE_ENDPOINT configured at all: store locally
  await localSave(payload);
}

async function localSave(payload){ // store by userId, keep last N; payload.pgn is compressed base64 if compressed
  const key = 'kifu_store_'+payload.userId;
  const cur = JSON.parse(localStorage.getItem(key)||'[]');
  // reuse same row if same hash
  const existingIdx = cur.findIndex(it=>it.hash && payload.hash && it.hash===payload.hash);
  if(existingIdx>=0) cur[existingIdx]=payload; else cur.push(payload);
  while(cur.length>200) cur.shift();
  localStorage.setItem(key, JSON.stringify(cur));
  logSave('saved locally');
}

// Try to delete a single record on the remote SAVE_ENDPOINT (best-effort).
// The server API is not strictly defined here; we attempt a DELETE with JSON body { userId, hash, timestamp }.
// Returns true if server responded OK, false otherwise.
async function tryRemoteDeleteRecord(userId, hash, timestamp){
  if(!SAVE_ENDPOINT) return false;
  try{
    // Best-effort delete by hash+timestamp for remote server.
    const url = SAVE_ENDPOINT.replace(/\/+$/,'');
    const resp = await fetch(url, { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ userId, hash, timestamp }) });
    return resp.ok;
  }catch(e){ console.warn('remote delete record failed', e); return false; }
}

// Try to delete all records for a user on the remote SAVE_ENDPOINT (best-effort).
// We attempt DELETE to SAVE_ENDPOINT+'/user/<userId>' if server supports it, otherwise we fallback to JSON body.
async function tryRemoteDeleteUser(userId){
  if(!SAVE_ENDPOINT) return false;
  try{
    // First try conventional RESTful path
    const url = (SAVE_ENDPOINT.replace(/\/+$/,'') + '/user/' + encodeURIComponent(userId));
    let resp = await fetch(url, { method: 'DELETE' });
    if(resp.ok) return true;
    // fallback: send DELETE with JSON body
    resp = await fetch(SAVE_ENDPOINT, { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ userId }) });
    return resp.ok;
  }catch(e){ console.warn('remote delete user failed', e); return false; }
}

// Fetch remote kifu list for a given user (returns array or null)
async function fetchRemoteKifuForUser(userId){
  if(!SAVE_ENDPOINT) return null;
  try{
    const url = SAVE_ENDPOINT.replace(/\/+$/,'') + '?userId=' + encodeURIComponent(userId);
    const r = await fetch(url, { method: 'GET' });
    if(!r.ok) return null;
    const data = await r.json().catch(()=>null);
    if(Array.isArray(data)){
      try{ const key='kifu_store_'+userId; const existing = JSON.parse(localStorage.getItem(key)||'[]'); for(const rec of data){ if(!existing.find(x=>x.hash===rec.hash && x.timestamp===rec.timestamp)) existing.push(rec); } while(existing.length>200) existing.shift(); localStorage.setItem(key, JSON.stringify(existing)); }catch(e){}
      return data;
    }
    return null;
  }catch(e){ console.warn('fetchRemoteKifuForUser failed', e); return null; }
}

// Fetch list of users from remote server (expects [{ userId, count }, ...])
async function fetchRemoteUsersList(){
  if(!SAVE_ENDPOINT) return null;
  try{
    const url = SAVE_ENDPOINT.replace(/\/+$/,'') + '/users';
    const r = await fetch(url, { method: 'GET' });
    if(!r.ok) return null;
    const data = await r.json().catch(()=>null);
    if(Array.isArray(data)){
      try{ // also cache a simple snapshot per-user locally
        for(const u of data){ const uid = u.userId || u.uid; if(!uid) continue; const key='kifu_store_'+uid; if(!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify([])); }
      }catch(e){}
      return data;
    }
    return null;
  }catch(e){ console.warn('fetchRemoteUsersList failed', e); return null; }
}

async function loadUserTendencies(){
  const userId = ensureUserId();
  const key = 'kifu_store_'+userId;
  const arr = JSON.parse(localStorage.getItem(key)||'[]');
  // compute simple tendencies across stored PGNs
  const t = { total:0, castleRate:0, queenEarlyRate:0, bishopOverKnightRatio:0, openings: {} };
  if(arr.length===0){ playerTendencies = null; return null; }
  let castleCount=0, queenEarlyCount=0, bishopCount=0, knightCount=0;
  for(const it of arr){
    t.total++;
    let pgn = it.pgn || '';
    try{ if(it.compressed) pgn = await decompressBase64ToString(it.pgn); }catch(e){}
    if(/O-O/.test(pgn)||/O-O-O/.test(pgn)) castleCount++;
    const tokens = pgn.split(/\s+/).slice(6,20).join(' '); if(/[Qq]/.test(tokens)) queenEarlyCount++;
    const bMatches = (pgn.match(/B[x]/g)||[]).length; const nMatches = (pgn.match(/N[x]/g)||[]).length; bishopCount+=bMatches; knightCount+=nMatches;
    const first = pgn.match(/1\.\s*([^\s]+)/); if(first && first[1]) { const mv = first[1]; t.openings[mv]=(t.openings[mv]||0)+1; }
  }
  t.castleRate = castleCount / t.total;
  t.queenEarlyRate = queenEarlyCount / t.total;
  t.bishopOverKnightRatio = (knightCount===0? (bishopCount>0? 99 : 1) : (bishopCount/knightCount));
  playerTendencies = t; return t;
}

function logSave(msg){ const el=document.getElementById('save-log'); if(!el) return; const time=new Date().toLocaleTimeString(); el.textContent += `[${time}] ${msg}\n`; el.scrollTop = el.scrollHeight; }

// Hook: autosave once per game end (mate/draw)
const origShowGameMessage = showGameMessage;
function showGameMessage(text,isMate=false,winnerColor=null){
  origShowGameMessage(text,isMate,winnerColor);
  if(isMate || text.toLowerCase().includes('引き分け')){
    if(!gameAutoSaved){ saveKifuRecord().catch(e=>console.warn('autosave failed',e)); gameAutoSaved = true; }
  }
}

// On load compute tendencies for current user
window.addEventListener('load', ()=>{ ensureUserId(); showUserIdBadge(); loadUserTendencies().catch(e=>console.warn('load tendencies failed',e)); });

// --- チェック判定ユーティリティ ---
function findKingPosition(color) {
  const target = color === 'white' ? 'K' : 'k';
  for (let r=0;r<8;r++) for (let c=0;c<8;c++) if (boardState[r][c]===target) return {row:r,col:c};
  return null;
}

function isSquareAttacked(row,col, byColor) {
  for (let r=0;r<8;r++){
    for (let c=0;c<8;c++){
      const p = boardState[r][c];
      if (!p) continue;
      if (getColor(p) !== byColor) continue;
      const legal = getLegalMoves(r,c);
      if (legal.some(l => l.row===row && l.col===col)) return true;
    }
  }
  return false;
}

function isKingInCheck(color) {
  const pos = findKingPosition(color);
  if (!pos) return false;
  return isSquareAttacked(pos.row, pos.col, oppositeColor(color));
}

// 合法手を生成して、自分の王がチェックされない手のみを返す
function getLegalMovesFiltered(row,col){
  const piece = boardState[row][col];
  if (!piece) return [];
  const color = getColor(piece);
  // include castling pseudo-moves when generating raw moves
  const raw = getLegalMoves(row,col,{includeCastling:true});
  const good = [];
  for (const m of raw){
    // Special handling for castling: ensure king is not currently in check and doesn't pass through attacked square
    if (piece.toUpperCase() === 'K' && Math.abs(m.col - col) === 2){
      if (isKingInCheck(color)) continue; // cannot castle out of check
      const dir = Math.sign(m.col - col);
      const passCol = col + dir; // square king passes through
      if (isSquareAttacked(row, passCol, oppositeColor(color))) continue;
    }
    const state = applyMoveOnBoard({row,col}, m);
    const inCheck = isKingInCheck(color);
    undoMoveOnBoard({row,col}, m, state);
    if (!inCheck) good.push(m);
  }
  return good;
}

// --- 駒クリック処理 ---
function handleClickMain(row, col) {
  if (gameOver) return; // no interactions after game over
  // if black is controlled by AI, ignore human clicks when it's black's turn
  if (blackIsAI && currentTurn === 'black') return;
  const piece = boardState[row][col];
  if (selected) {
    const move = legalMoves.find(m => m.row === row && m.col === col);
    if (move) {
      // player makes a move
      recordOpponentMove(selected.row, selected.col, row, col);
      handleMove(selected.row, selected.col, row, col);
      selected = null;
      legalMoves = [];
      renderBoard();
        maybeScheduleBlackAI(500);
    } else {
      // If a king is selected and user clicks the king's castling destination (two files away), attempt castling
      const selKingPiece = boardState[selected.row][selected.col];
      if (selKingPiece && selKingPiece.toUpperCase() === 'K' && selected.row === row && Math.abs(col - selected.col) === 2) {
        const rawKing = getLegalMoves(selected.row, selected.col, { includeCastling: true });
        for (const km of rawKing) {
          if (km.row === selected.row && km.col === col) {
            // perform castling by moving king to km
            recordOpponentMove(selected.row, selected.col, km.row, km.col);
            handleMove(selected.row, selected.col, km.row, km.col);
            selected = null; legalMoves = []; renderBoard(); maybeScheduleBlackAI(500);
            return;
          }
        }
      }
      // Special UX: if a king is selected and user clicks their rook, attempt castling
      const selPiece = boardState[selected.row][selected.col];
      if (selPiece && selPiece.toUpperCase()==='K' && piece && piece.toUpperCase()==='R' && getColor(piece)===getColor(selPiece)){
        // get king's legal moves with castling included
        const kingMoves = getLegalMovesFiltered(selected.row, selected.col).concat();
        // ensure castling pseudo-moves are present by directly using getLegalMoves with includeCastling
        const rawKing = getLegalMoves(selected.row, selected.col, {includeCastling:true});
        for(const km of rawKing){ if(km.row===selected.row && Math.abs(km.col-selected.col)===2){
            // determine rook origin square for this castling
            const rookFromCol = (km.col>selected.col)? 7 : 0;
            if(rookFromCol===col && row===selected.row){
              // perform castling by moving king to km
              recordOpponentMove(selected.row, selected.col, km.row, km.col);
              handleMove(selected.row, selected.col, km.row, km.col);
              selected = null; legalMoves = []; renderBoard(); maybeScheduleBlackAI(500);
              return;
            }
        } }
      }
      // if clicking another of player's pieces, switch selection
      if (piece && getColor(piece) === currentTurn) {
        selected = { row, col };
        legalMoves = getLegalMovesFiltered(row, col);
        renderBoard();
      } else {
        selected = null; legalMoves = []; renderBoard();
      }
    }
  } else if (piece && getColor(piece) === currentTurn) {
    selected = { row, col };
    // チェック中はチェックを防ぐ手のみ許可
    legalMoves = getLegalMovesFiltered(row, col);
    renderBoard();
  }
}

// --- 移動処理 ---
function handleMove(fromRow, fromCol, toRow, toCol) {
  const piece = boardState[fromRow][fromCol];
  const targetBefore = boardState[toRow][toCol];

  // If this was a human move, record SAN now. (Support black being human via blackIsAI flag)
  try{
    const isHumanMove = (currentTurn === 'white') || (currentTurn === 'black' && !blackIsAI);
    if (isHumanMove){
      const san = formatMove(piece, {row:fromRow,col:fromCol}, {row:toRow,col:toCol}, { target: targetBefore });
  // appendMoveToKifu: for human black moves store as {player:true} so we can mark them in UI
  const asBlack = (currentTurn === 'black');
  if (asBlack) appendMoveToKifu(san, { player: true }); else appendMoveToKifu(san, false);
    }
  }catch(e){/* ignore formatting errors */}

  // Apply move on board (handles castling/en-passant)
  const st = applyMoveOnBoard({row:fromRow,col:fromCol}, {row:toRow,col:toCol});

  // Promotion handling: if pawn reached promotion rank
  if (st.moving && st.moving.toUpperCase() === 'P'){
    const colr = getColor(st.moving);
    const promoRow = colr === 'white' ? 0 : 7;
    if (toRow === promoRow){
      // If human moved, show UI to choose promotion piece and defer finishing
      if (currentTurn === 'white'){
        showPromotionUI(toRow, toCol, colr, { from: {row:fromRow,col:fromCol}, piece: piece, targetBefore });
        // do not finalize turn yet; promotion UI will flip the turn
        return;
      } else {
        // AI: auto-queen
        boardState[toRow][toCol] = colr === 'white' ? 'Q' : 'q';
      }
    }
  }

  // finalize move: set last move, flip turn, animate and check for mate/check
  lastMove = { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } };
  const movingPiece = piece;
  try{ console.log('[TURN] flipping turn (before flip) =>', currentTurn); }catch(e){}
  currentTurn = oppositeColor(currentTurn);
  try{ console.log('[TURN] flipped turn (after flip) =>', currentTurn); }catch(e){}

  animateMove({row:fromRow,col:fromCol}, {row:toRow,col:toCol}, movingPiece, st, ()=>{
    renderBoard();
    checkForCheckOrMate();
  // if it's now black's turn, schedule AI move via helper
  maybeScheduleBlackAI(400);
  });

  // attempt per-move sync save
  saveKifuRecord().catch(e=>console.warn('save failed',e));
}


// --- プロモーションUI ---
function showPromotionUI(row, col, color, opts) {
  // opts may include: from (pos), piece (moving piece), targetBefore (captured piece)
  // remove any existing promotion UI first to avoid duplicates
  const prev = document.getElementById('promotion-ui'); if(prev && prev.parentNode) prev.parentNode.removeChild(prev);

  const ui = document.createElement("div");
  ui.id = "promotion-ui";
  ui.style.position = "absolute";
  ui.style.zIndex = 99999;
  ui.style.display = 'flex'; ui.style.gap = '6px'; ui.style.background = 'rgba(0,0,0,0.6)'; ui.style.padding = '6px'; ui.style.borderRadius = '8px'; ui.style.alignItems = 'center'; ui.style.backdropFilter = 'blur(4px)';

  // compute absolute page coordinates for the center of the target square so we can append to document.body
  const board = document.getElementById("board");
  let squareSize = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--square-size')) || 60;
  let boardRect = null;
  try{
    boardRect = board ? board.getBoundingClientRect() : null;
    if(boardRect && boardRect.width) squareSize = boardRect.width / 8;
  }catch(e){ boardRect = null; }

  let centerX = window.scrollX + (col + 0.5) * squareSize; // fallback if boardRect missing
  let centerY = window.scrollY + (row + 0.5) * squareSize;
  if (boardRect){
    centerX = window.scrollX + boardRect.left + (col + 0.5) * squareSize;
    centerY = window.scrollY + boardRect.top + (row + 0.5) * squareSize;
  }
  ui.style.left = `${centerX}px`;
  ui.style.top = `${centerY}px`;
  ui.style.transform = 'translate(-50%, -120%)'; // place slightly above center of square
  console.log('[PROMO] showPromotionUI', {row,col,color,squareSize,centerX,centerY,boardRect: !!boardRect});

  const choices = ["Q","R","B","N"];
  choices.forEach(type=>{
    const btn=document.createElement("button");
    btn.className = 'promo-btn';
  const img=document.createElement("img");
  img.src=getPieceImage(color==="white"?type:type.toLowerCase());
  img.className="promo-piece"; // avoid .piece absolute positioning used on board pieces
  img.style.width = '36px'; img.style.height = '36px'; img.style.pointerEvents='none';
    btn.appendChild(img);
    btn.onclick=()=>{
      // prevent double clicks: disable all promo buttons immediately
      const allBtns = ui.querySelectorAll('.promo-btn'); allBtns.forEach(b=>b.disabled=true);
      // set promoted piece on board
      boardState[row][col] = color==="white"?type:type.toLowerCase();
      // if opts provided, finalize the move: record SAN, lastMove, flip turn, animate already happened before showing UI
      if(opts && opts.from){
        try{
          const san = formatMove(opts.piece, opts.from, {row,col}, { target: opts.targetBefore, promotion: type });
          const isBlackHuman = (getColor(opts.piece)==='black' && !blackIsAI);
          if (isBlackHuman) appendMoveToKifu(san, { player: true }); else appendMoveToKifu(san, getColor(opts.piece)==='black');
        }catch(e){}
        lastMove = { from: opts.from, to: { row, col } };
        currentTurn = oppositeColor(color);
      }
      if (ui && ui.parentNode) ui.parentNode.removeChild(ui);
      renderBoard();
  checkForCheckOrMate();
  maybeScheduleBlackAI(500);
    };
    ui.appendChild(btn);
  });
  // append to body so it's not clipped by board overflow
  document.body.appendChild(ui);
}

// --- 合法手生成（ポーン・ナイトのみ簡易版） ---
function getLegalMoves(row,col, opts){
  const piece=boardState[row][col];
  if (!piece) return [];
  const type=piece.toUpperCase();
  const color=getColor(piece);
  opts = opts || {};
  const includeCastling = !!opts.includeCastling;
  const moves=[];
  if(type==="P"){
    const dir=color==="white"?-1:1;
    const startRow=color==="white"?6:1;
    if(boardState[row+dir]?.[col]===""){
      moves.push({row:row+dir,col});
      if(row===startRow && boardState[row+2*dir]?.[col]===""){
        moves.push({row:row+2*dir,col});
      }
    }
    for(let dx of [-1,1]){
      const r=row+dir,c=col+dx;
      if(r>=0&&r<8&&c>=0&&c<8){
        const target=boardState[r][c];
        if(target && getColor(target)!==color) moves.push({row:r,col:c});
      }
    }
    // en-passant: if an enPassantTarget is set and it's diagonally reachable, allow that pseudo-capture
    try{
      if(enPassantTarget){
        const ep = enPassantTarget;
        // capturing pawn moves to enPassantTarget (which is one row forward and one file left/right)
        if(ep.row === row + dir && Math.abs(ep.col - col) === 1){
          const capRow = row; const capCol = ep.col; // the pawn to be captured sits on same row as the capturer, at ep.col
          if(capCol>=0 && capCol<8 && boardState[capRow] && boardState[capRow][capCol]){
            const capPiece = boardState[capRow][capCol];
            if(capPiece && getColor(capPiece) !== color && capPiece.toUpperCase() === 'P'){
              // ensure destination is empty (sanity)
              if(!boardState[ep.row][ep.col]) moves.push({row: ep.row, col: ep.col});
            }
          }
        }
      }
    }catch(e){}
  }
  if(type==="N"){
    const deltas=[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for(const [dy,dx] of deltas){
      const r=row+dy,c=col+dx;
      if(r>=0&&r<8&&c>=0&&c<8){
        const target=boardState[r][c];
        if(!target || getColor(target)!==color) moves.push({row:r,col:c});
      }
    }
  }
  // スライディング駒（ルーク, ビショップ, クイーン）
  function addSliding(directions) {
    for (const [dy,dx] of directions) {
      let r = row + dy, c = col + dx;
      while (r >= 0 && r < 8 && c >= 0 && c < 8) {
        const target = boardState[r][c];
        if (!target) {
          moves.push({ row: r, col: c });
        } else {
          if (getColor(target) !== color) moves.push({ row: r, col: c });
          break; // blocked
        }
        r += dy; c += dx;
      }
    }
  }

  if (type === "R") {
    addSliding([[1,0],[-1,0],[0,1],[0,-1]]);
  }
  if (type === "B") {
    addSliding([[1,1],[1,-1],[-1,1],[-1,-1]]);
  }
  if (type === "Q") {
    addSliding([[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]);
  }

  // 王 (1マス移動)
  if (type === "K") {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dy === 0 && dx === 0) continue;
        const r = row + dy, c = col + dx;
        if (r >= 0 && r < 8 && c >= 0 && c < 8) {
          const target = boardState[r][c];
          if (!target || getColor(target) !== color) moves.push({ row: r, col: c });
        }
      }
    }
    // キャスリング（オプション）: 王が初期位置にいる場合のみ、ルークと経路が揃っていれば
    if (includeCastling) {
      try{
        if (color === 'white' && row === 7 && col === 4) {
          // kingside
          if (whiteCastleK && !boardState[7][5] && !boardState[7][6] && boardState[7][7] && boardState[7][7].toUpperCase()==='R') moves.push({row:7,col:6});
          // queenside (ensure b/c/d squares empty)
          if (whiteCastleQ && !boardState[7][1] && !boardState[7][2] && !boardState[7][3] && boardState[7][0] && boardState[7][0].toUpperCase()==='R') moves.push({row:7,col:2});
        } else if (color === 'black' && row === 0 && col === 4) {
          if (blackCastleK && !boardState[0][5] && !boardState[0][6] && boardState[0][7] && boardState[0][7].toUpperCase()==='R') moves.push({row:0,col:6});
          if (blackCastleQ && !boardState[0][1] && !boardState[0][2] && !boardState[0][3] && boardState[0][0] && boardState[0][0].toUpperCase()==='R') moves.push({row:0,col:2});
        }
      }catch(e){}
    }
  }
  return moves;
}

// --- 相手の行動履歴記録 ---
function recordOpponentMove(fromRow, fromCol, toRow, toCol) {
  // Record a compact history item for simple pattern-based responses.
  const fromPiece = boardState[fromRow]?.[fromCol] || "";
  const toPiece = boardState[toRow]?.[toCol] || "";
  const piece = fromPiece || toPiece || null;
  const dx = toCol - fromCol;
  const dy = toRow - fromRow;
  const action = toPiece ? "capture" : "move";
  opponentHistory.push({ piece: piece ? piece.toUpperCase() : null, dx, dy, action, from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } });
}

// --- AIの行動（捕獲優先＋簡易戦略） ---
function makeAIMove() {
  try{ console.log('[AI] makeAIMove: entry (currentTurn=', currentTurn, ', gameOver=', gameOver, ', aiScheduled=', aiScheduled, ')'); }catch(e){}
  // defensive: clear any stale aiScheduled flag in case makeAIMove was invoked directly
  try{ if(aiScheduled){ console.log('[AI] makeAIMove: clearing stale aiScheduled flag'); } }catch(e){}
  try{ aiScheduled = false; }catch(e){}
  if (gameOver) { try{ console.log('[AI] makeAIMove: aborted at entry because gameOver'); }catch(e){} return; }
  // show centered AI thinking overlay
  showThinkingOverlay();
  const allMoves = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = boardState[row][col];
      if (piece && getColor(piece) === "black") {
        // チェック中はチェックを防ぐ手のみ取得
        const legal = getLegalMovesFiltered(row, col);
        legal.forEach(move => {
          allMoves.push({ from: { row, col }, to: move });
        });
      }
    }
  }
  if (allMoves.length === 0){ hideThinkingOverlay(); return; }

  // 開局応手: AIの最初の手（黒の1手目）をランダムに選択する
  function attemptMove(fromRow, fromCol, toRow, toCol) {
    const piece = boardState[fromRow]?.[fromCol];
    if (!piece || getColor(piece) !== 'black') return null;
    const legal = getLegalMovesFiltered(fromRow, fromCol);
    if (legal.some(l => l.row === toRow && l.col === toCol)) {
      return { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } };
    }
    return null;
  }

  function chooseOpeningReply() {
    // only if white has just played and AI has no history
    if (aiHistory.length > 0) return null;
    if (moveList.length === 0) return null;
    // check common white first moves by inspecting board
    const replies = [];
    // e4
    if (boardState[4][4] === 'P') {
      replies.push({ from:[1,4], to:[3,4] }); // e7->e5
      replies.push({ from:[1,2], to:[3,2] }); // c7->c5
      replies.push({ from:[1,4], to:[2,4] }); // e7->e6
      replies.push({ from:[1,2], to:[2,2] }); // c7->c6
      replies.push({ from:[0,6], to:[2,5] }); // Ng8->f6
    }
    // d4
    if (boardState[4][3] === 'P') {
      replies.push({ from:[1,3], to:[3,3] }); // d7->d5
      replies.push({ from:[1,2], to:[3,2] }); // c7->c5
      replies.push({ from:[0,6], to:[2,5] }); // Ng8->f6
      replies.push({ from:[1,4], to:[2,4] }); // e7->e6
    }
    // c4 or f4
    if (boardState[4][2] === 'P' || boardState[4][5] === 'P') {
      replies.push({ from:[1,2], to:[3,2] }); // c7->c5
      replies.push({ from:[1,3], to:[3,3] }); // d7->d5
    }
    // Nf3 (white knight to f3)
    if (boardState[5][5] === 'N') {
      replies.push({ from:[0,6], to:[2,5] }); // Ng8->f6
      replies.push({ from:[1,3], to:[3,3] }); // d7->d5
      replies.push({ from:[1,2], to:[3,2] }); // c7->c5
    }

    // shuffle replies and return the first legal one
    for (let i = replies.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [replies[i], replies[j]] = [replies[j], replies[i]];
    }
    for (const r of replies) {
      const m = attemptMove(r.from[0], r.from[1], r.to[0], r.to[1]);
      if (m) return m;
    }
    return null;
  }

  // if it's AI's first move (black's 1st), try opening reply
  const opening = chooseOpeningReply();
  if (opening) {
    const choice = opening;
    aiLog(`開局応手をランダム選択: ${coord(choice.from)}→${coord(choice.to)}`);
    aiHistory.push(moveKey(choice));
    // execute as in normal flow
    const movingPiece = boardState[choice.from.row][choice.from.col];
    const sanAI = formatMove(movingPiece, choice.from, choice.to);
    appendMoveToKifu(sanAI, true);
    boardState[choice.to.row][choice.to.col] = movingPiece;
    boardState[choice.from.row][choice.from.col] = "";
  try{ console.log('[TURN] flipping turn (before flip) =>', currentTurn); }catch(e){}
  currentTurn = oppositeColor(currentTurn);
  try{ console.log('[TURN] flipped turn (after flip) =>', currentTurn); }catch(e){}
    renderBoard();
    // after AI opening reply, check for check/checkmate
    checkForCheckOrMate();
  // clear centered overlay (opening reply is immediate)
  hideThinkingOverlay();
    return;
  }

  // AIログ出力用ヘルパー
  function aiLog(text) {
    const el = document.getElementById('ai-log');
    if (!el) return;
    const time = new Date().toLocaleTimeString();
    el.textContent += `[${time}] ${text}\n`;
    // 自動スクロール
    el.scrollTop = el.scrollHeight;
  }
  // Negamax を用いた先読み評価（黒の視点で SEARCH_DEPTH を探索）
  // Heavy search is deferred to next tick so browser can paint the thinking overlay.
  (function scheduleSearch(){
    const whitePieceCount = countPieces('white');
    const useExtraDepth = whitePieceCount <= MATING_THRESHOLD;
    const searchDepth = SEARCH_DEPTH + (useExtraDepth ? AGGRESSIVE_EXTRA_DEPTH : 0);
    const aiSearchStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    aiLog(`候補手数: ${allMoves.length} 手。探索深さ: ${searchDepth} (白駒:${whitePieceCount})`);
    // schedule actual compute slightly in the future to allow DOM paint
    setTimeout(()=>{
      let bestVal = -Infinity;
      let bestMove = null;
      const scores = [];
      try{
        for (const m of allMoves) {
          const from = m.from; const to = m.to;
          const state = applyMoveOnBoard(from, to);
          // handle promotion for simulation (auto-queen)
          let promoted = null;
          if (state.moving && state.moving.toUpperCase() === 'P') {
            const colr = getColor(state.moving);
            const promoRow = colr === 'white' ? 0 : 7;
            if (to.row === promoRow) {
              promoted = boardState[to.row][to.col];
              boardState[to.row][to.col] = colr === 'white' ? 'Q' : 'q';
            }
          }

          // after black move, white to move
          const val = -negamax(searchDepth - 1, 'white', -Infinity, Infinity);

          // undo
          if (promoted !== null) boardState[to.row][to.col] = promoted;
          undoMoveOnBoard(from, to, state);

          // 調整: 繰り返しの手はペナルティ
          let adjusted = val;
          if (isRepeatMove(m)) adjusted -= 2;
          // 安全性: 移動先が次手で取られる可能性を簡易判定（同価値評価で負荷を減らす）
          let risky = false;
          const simState = applyMoveOnBoard(from,to);
          for (let r=0; r<8 && !risky; r++){
            for (let c=0; c<8 && !risky; c++){
              const p = boardState[r][c];
              if (p && getColor(p)==='white'){
                const legal = getLegalMoves(r,c);
                if (legal.some(l=>l.row===to.row && l.col===to.col)) risky = true;
              }
            }
          }
          undoMoveOnBoard(from,to,simState);

          // If we're in aggressive mode (few opponent pieces), prefer checking/mating lines
          let givesCheckBonus = 0;
          let givesMateBonus = 0;
          const tmp = applyMoveOnBoard(from,to);
          if (isKingInCheck('white')) givesCheckBonus = 4;
          if (isCheckmate('white')) givesMateBonus = 200;
          undoMoveOnBoard(from,to,tmp);

          if (risky) adjusted -= useExtraDepth ? 1 : 3;
          else {
            const beforeDist = distanceToNearestWhite(from);
            const afterDist = distanceToNearestWhite(to);
            if (afterDist < beforeDist) adjusted += 1.5;
          }

          adjusted += givesCheckBonus + givesMateBonus;

          scores.push({ move: m, score: val, adjusted });
          if (adjusted > bestVal) { bestVal = adjusted; bestMove = m; }
        }
      }catch(err){
        console.error('AI search failed', err);
      }finally{
        // always remove centered overlay
        hideThinkingOverlay();
      }

      const top = scores.slice(0,5).map(s=>`${pieceName(boardState[s.move.from.row][s.move.from.col])}${coord(s.move.from)}→${coord(s.move.to)} score:${s.score}`).join(' | ');
      if (top) aiLog(`上位候補: ${top}`);
      try{ if(top) console.log('[AI] top candidates:', top); }catch(e){}
      if (!bestMove) return;

      const aiSearchEnd = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const elapsedMs = Math.max(0, aiSearchEnd - (aiSearchStart||aiSearchEnd));
      const elapsedSec = (elapsedMs/1000).toFixed(2);
      aiLog(`選択: 探索で最良と評価された手 ${pieceName(boardState[bestMove.from.row][bestMove.from.col])}${coord(bestMove.from)}→${coord(bestMove.to)} (評価:${bestVal}) — 思考時間: ${elapsedSec}s`);
      const choice = bestMove;
      aiHistory.push(moveKey(choice));

      // execute AI move via applyMoveOnBoard so we have state for animation
      const from = choice.from;
      const to = choice.to;
      const movingPiece = boardState[from.row][from.col];
      const sanAI = formatMove(movingPiece, from, to);
      appendMoveToKifu(sanAI, true);
      try{ console.log('[AI] chosen move:', { from, to, piece: movingPiece, san: sanAI, bestVal }); }catch(e){}

      const st = applyMoveOnBoard(from, to);
      if (st.moving && st.moving.toUpperCase() === 'P'){
        const colr = getColor(st.moving);
        const promoRow = colr === 'white'?0:7;
        if (to.row === promoRow) boardState[to.row][to.col] = colr === 'white'?'Q':'q';
      }
      lastMove = {from:from,to:to};
      try{ console.log('[TURN] flipping turn (before flip) =>', currentTurn); }catch(e){}
      currentTurn = oppositeColor(currentTurn);
      try{ console.log('[TURN] flipped turn (after flip) =>', currentTurn); }catch(e){}
      animateMove(from,to,movingPiece,st,()=>{ renderBoard(); checkForCheckOrMate(); try{ console.log('[AI] animateMove callback: completed for', from, '->', to); }catch(e){} saveKifuRecord().catch(e=>console.warn('save failed',e)); });
    }, 30);
  })();
  try{ console.log('[AI] animateMove invoked for', { from, to }); }catch(e){}
}

// --- 棋譜関係ユーティリティ ---
function coord(pos) {
  const file = String.fromCharCode('a'.charCodeAt(0) + pos.col);
  const rank = 8 - pos.row;
  return `${file}${rank}`;
}

// formatMove is defined earlier (SAN generator)

// --- エクスポート機能 ---
function generatePGN() {
  const today = new Date().toISOString().slice(0,10);
  let header = `[Event "?"]\n[Site "?"]\n[Date "${today}"]\n[Round "?"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n`;
  function sanOf(v){ if(!v) return ''; if(typeof v === 'object') return v.san || ''; return v; }
  const movesStr = moveList.map((m,i)=>{
    const num = i+1;
    const white = sanOf(m.white) ? sanOf(m.white) : '';
    const black = sanOf(m.black) ? ' ' + sanOf(m.black) : '';
    return `${num}. ${white}${black}`;
  }).join(' ');
  return header + movesStr + ' *';
}

function generateTXT() {
  function sanOf(v){ if(!v) return ''; if(typeof v === 'object') return v.san || ''; return v; }
  return moveList.map((m,i)=>`${i+1}. ${sanOf(m.white)||''} ${sanOf(m.black)||''}`).join('\n');
}

function downloadText(filename, text) {
  const blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ボタンハンドラの接続（DOMがあれば）
function setupKifuDownloadButtons() {
  const btnPgn = document.getElementById('download-pgn');
  const btnTxt = document.getElementById('download-txt');
  if (btnPgn) btnPgn.onclick = ()=> downloadText('game.pgn', generatePGN());
  if (btnTxt) btnTxt.onclick = ()=> downloadText('game.txt', generateTXT());
}

// ページロード時にボタンを接続
window.addEventListener('load', ()=>{
  setupKifuDownloadButtons();
});

function appendMoveToKifu(san, where=false) {
  // where: false => white; true => black (AI or default string); object {player:true} => black player-marked
  if (where === true) {
    // black (AI or generic)
    if (moveList.length === 0 || moveList[moveList.length-1].black) {
      moveList.push({white: null, black: san});
    } else {
      moveList[moveList.length-1].black = san;
    }
  } else if (where && typeof where === 'object' && where.player) {
    // black move made by human player: store object so we can mark it in UI
    if (moveList.length === 0 || moveList[moveList.length-1].black) {
      moveList.push({white: null, black: { san: san, player: true }});
    } else {
      moveList[moveList.length-1].black = { san: san, player: true };
    }
  } else {
    // white
    moveList.push({white: san, black: null});
  }
  renderKifu();
}

function renderKifu() {
  const el = document.getElementById('moves');
  if (!el) return;
  function displaySan(v){ if(!v) return ''; if(typeof v === 'object') return (v.san || '') + (v.player? ' p':''); return v; }
  el.textContent = moveList.map((m,i)=>{
    const num = i+1;
    return `${num}. ${displaySan(m.white) || ''} ${displaySan(m.black) || ''}`;
  }).join('\n');
}

//  駒の名前（簡易、日語）
function p本ieceName(piece) {
  if (!piece) return '';
  const map = { K: '王', Q: '女王', R: 'ルーク', B: 'ビショップ', N: 'ナイト', P: 'ポーン' };
  const t = piece.toUpperCase();
  const name = map[t] || t;
  return (piece === piece.toUpperCase() ? '白' : '黒') + name;
}

// compatibility wrapper: pieceName is used in some places
function pieceName(piece){
  try{ return p本ieceName(piece); }catch(e){ try{ return '' + piece; }catch(e){} return '';} }

// initial render
renderBoard();

// Open a window listing saved kifu for the current user (from localStorage or remote if implemented)
function openKifuListWindow(){
  const userId = ensureUserId();
  const key = 'kifu_store_'+userId;
  const arr = JSON.parse(localStorage.getItem(key)||'[]').slice().reverse(); // show newest first
  const w = window.open('', 'kifu_list', 'width=800,height=600,scrollbars=yes');
  if(!w) { alert('ポップアップがブロックされています。ポップアップを許可してください。'); return; }
  const title = '保存棋譜一覧（' + arr.length + '件）';
  // transfer data to the opened window
  w._kifuData = arr;
  w._kifuUserId = userId;
  // write a minimal shell then populate via DOM to avoid complex string escaping
  const style = 'body{font-family:Arial,Helvetica,sans-serif;padding:12px;} .entry{border-bottom:1px solid #ddd;padding:8px 0;} .meta{font-size:12px;color:#666} button{margin-right:8px;height:30px;line-height:30px;padding:0 6px;font-size:14px} .user{padding:6px;border:1px solid #ccc;margin:6px 0;cursor:pointer}';
  w.document.open();
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>'+title+'</title><style>'+style+'</style></head><body><h2>'+title+'</h2><p>ヒント: U を押すとユーザー一覧を表示します</p><div id="controls"></div><div id="list-area"></div><div id="viewer" style="margin-top:12px;"></div></body></html>');
  w.document.close();

  // populate DOM safely
  (function initPopup(win){
    const doc = win.document;
    const controls = doc.getElementById('controls');
    const btnShow = doc.createElement('button'); btnShow.id='show-users'; btnShow.textContent='ユーザー一覧 (U)';
    const btnRefresh = doc.createElement('button'); btnRefresh.id='refresh'; btnRefresh.textContent='更新';
    const btnClose = doc.createElement('button'); btnClose.id='close'; btnClose.textContent='閉じる';
    controls.appendChild(btnShow); controls.appendChild(btnRefresh); controls.appendChild(btnClose);

    let currentShownUser = win._kifuUserId || '';

    async function renderListForData(data){
      const listArea = doc.getElementById('list-area');
      if(!listArea) return;
      listArea.innerHTML = '';
      if(!data || data.length === 0){ listArea.innerHTML = '<p>保存された棋譜はありません。</p>'; return; }
      for(let idx=0; idx<data.length; idx++){
        const it = data[idx];
        const when = new Date(it.timestamp).toLocaleString();
        let preview = '';
        try{
          if(it.compressed && window.opener && typeof window.opener.decompressBase64ToString === 'function'){
            preview = (await window.opener.decompressBase64ToString(it.pgn)).replace(/\n/g,' ').slice(0,200);
          } else {
            preview = (it.pgn||'').replace(/\n/g,' ').slice(0,200);
          }
        }catch(e){ preview = (it.pgn||'').toString().slice(0,120); }

        const entry = doc.createElement('div'); entry.className = 'entry';
        const meta = doc.createElement('div'); meta.className = 'meta'; meta.textContent = when;
        const pv = doc.createElement('div'); pv.style.margin='6px 0'; pv.textContent = preview;
        const vbtn = doc.createElement('button'); vbtn.dataset.idx = idx; vbtn.className = 'view'; vbtn.textContent = '表示';
        const pgbtn = doc.createElement('button'); pgbtn.dataset.idx = idx; pgbtn.className = 'dlpgn'; pgbtn.textContent = 'PGNをダウンロード';
        const txbtn = doc.createElement('button'); txbtn.dataset.idx = idx; txbtn.className = 'dltxt'; txbtn.textContent = 'TXTをダウンロード';
        const delbtn = doc.createElement('button'); delbtn.dataset.idx = idx; delbtn.className = 'delete'; delbtn.textContent = '削除'; delbtn.style.color = 'red';
        entry.appendChild(meta); entry.appendChild(pv); entry.appendChild(vbtn); entry.appendChild(pgbtn); entry.appendChild(txbtn); entry.appendChild(delbtn);
        listArea.appendChild(entry);
      }
    }

    async function loadAndRender(uid){
      currentShownUser = uid;
      let arr = null;
    try{
      if(window.opener && typeof window.opener.fetchRemoteKifuForUser === 'function'){
        arr = await window.opener.fetchRemoteKifuForUser(uid);
        // cache remote results locally for offline access
        try{ if(Array.isArray(arr)){ const key='kifu_store_'+uid; const existing = JSON.parse(win.localStorage.getItem(key)||'[]'); for(const rec of arr){ if(!existing.find(x=>x.hash===rec.hash && x.timestamp===rec.timestamp)) existing.push(rec); } while(existing.length>200) existing.shift(); win.localStorage.setItem(key, JSON.stringify(existing)); } }catch(e){}
      }
    }catch(e){ arr = null; }
      if(!Array.isArray(arr)){
        const key = 'kifu_store_' + uid; arr = JSON.parse(win.localStorage.getItem(key) || '[]');
      }
      arr = arr.slice().reverse();
      await renderListForData(arr);
      const v = doc.getElementById('viewer'); if(v) v.innerHTML = '<div style="margin-top:8px;font-size:12px;color:#666">表示中のユーザー: '+uid+' （件数: '+(arr?arr.length:0)+')</div>';
    }

    function showUserList(){
      const listArea = doc.getElementById('list-area'); listArea.innerHTML = '<h3>ユーザー一覧</h3>';
      (async ()=>{
        let list = null;
    try{ if(window.opener && typeof window.opener.fetchRemoteUsersList === 'function'){ list = await window.opener.fetchRemoteUsersList(); } }catch(e){ list = null; }
        if(!Array.isArray(list)){
          const keys = Object.keys(win.localStorage).filter(k=>k.indexOf('kifu_store_')===0);
          if(keys.length===0){ listArea.innerHTML += '<p>保存ユーザーが見つかりません</p>'; return; }
          list = keys.map(k=>{ const uid = k.replace('kifu_store_',''); const arr = JSON.parse(win.localStorage.getItem(k) || '[]'); return { uid: uid, count: arr.length, sample: arr[0]? (arr[0].pgn||'').slice(0,120) : '' }; });
        }
        list.forEach(u=>{
          const uid = u.uid || u.userId || u.userId;
          const count = u.count || u.c || 0;
          const sample = u.sample || '';
          const el = doc.createElement('div'); el.className='user'; el.dataset.uid = uid;
          el.style.display='flex'; el.style.alignItems='center'; el.style.justifyContent='space-between'; el.style.gap='8px'; el.style.padding='6px 0';
          const left = doc.createElement('div'); left.style.flex='1'; left.style.cursor='pointer';
          const title = doc.createElement('div'); title.innerHTML = '<strong>'+uid+'</strong> ('+count+'件)'; title.style.marginBottom='4px'; title.style.wordBreak='break-all';
          const sampleEl = doc.createElement('div'); sampleEl.style.color='#666'; sampleEl.textContent = sample;
          left.appendChild(title); left.appendChild(sampleEl);
          left.onclick = ()=>{ loadAndRender(uid); };
          const right = doc.createElement('div'); right.style.display='flex'; right.style.alignItems='center'; right.style.gap='6px';
          const loadBtn = doc.createElement('button'); loadBtn.textContent='表示'; loadBtn.onclick = ()=>{ loadAndRender(uid); };
          const copyBtn = doc.createElement('button'); copyBtn.textContent='コピー'; copyBtn.style.fontSize='12px'; copyBtn.onclick = ()=>{ const text = uid; try{ if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text); else prompt('ユーザーIDをコピーしてください', text); }catch(e){ prompt('ユーザーIDをコピーしてください', text); } };
          const delUserBtn = doc.createElement('button'); delUserBtn.textContent='ユーザー削除'; delUserBtn.dataset.uid=uid; delUserBtn.className='delete-user'; delUserBtn.style.color='red';
          right.appendChild(loadBtn); right.appendChild(copyBtn); right.appendChild(delUserBtn);
          el.appendChild(left); el.appendChild(right); listArea.appendChild(el);
          // wire deletion for popup user list: prefer remote delete, fallback to local with confirmation
          delUserBtn.onclick = async ()=>{
            if(!confirm('ユーザー "'+uid+'" の全データを削除しますか？')) return;
            let remoteOk = false;
            try{ if(window.opener && typeof window.opener.tryRemoteDeleteUser === 'function') remoteOk = await window.opener.tryRemoteDeleteUser(uid); }catch(e){ remoteOk = false; }
            if(remoteOk){ win.localStorage.removeItem('kifu_store_'+uid); alert('リモートとローカルのデータを削除しました'); showUserList(); return; }
            if(confirm('リモートでの削除に失敗しました。ローカルのデータのみ削除しますか？（サーバー上のデータは残ります）')){ win.localStorage.removeItem('kifu_store_'+uid); alert('ローカルから削除しました（サーバー上のデータは未変更）'); showUserList(); } else { alert('削除を中止しました'); }
          };
        });
        const back = doc.createElement('div'); back.style.marginTop='8px'; const backBtn = doc.createElement('button'); backBtn.id='back-to-list'; backBtn.textContent='戻る'; backBtn.onclick = ()=>{ loadAndRender(currentShownUser); }; back.appendChild(backBtn); listArea.appendChild(back);
      })();
    }

    // events
    btnShow.addEventListener('click', showUserList);
    btnClose.addEventListener('click', ()=>{ win.close(); });

    doc.addEventListener('click', async (e)=>{
      try{
        let node = e.target;
        while(node && node.nodeType === 3) node = node.parentNode;
        let btn = node;
        while(btn && btn.nodeName !== 'BUTTON') btn = btn.parentNode;
        if(!btn || !doc.contains(btn)) return;

        if(btn.id === 'refresh'){
          if(currentShownUser) await loadAndRender(currentShownUser);
          else await renderListForData(win._kifuData || []);
          return;
        }

        const keyPrefix = 'kifu_store_';

        if(btn.classList.contains('view')){
          const i = parseInt(btn.dataset.idx,10);
          const key = keyPrefix + (currentShownUser||win._kifuUserId||'');
          const data = JSON.parse(win.localStorage.getItem(key)||'[]').slice().reverse();
          const v = doc.getElementById('viewer');
          if(!data[i]){ if(v) v.innerHTML = '<div style="color:#c00">選択した棋譜が見つかりません。</div>'; return; }
          let pgnText = data[i].pgn||'';
          try{ if(data[i].compressed && window.opener && typeof window.opener.decompressBase64ToString === 'function'){ pgnText = await window.opener.decompressBase64ToString(data[i].pgn); } }catch(err){ console.warn('decompress failed',err); }
          v.innerHTML = '<h3>棋譜表示</h3><textarea style="width:100%;height:320px;">'+(pgnText||'')+'</textarea>';
          return;
        }

        if(btn.classList.contains('dlpgn')){
          const i = parseInt(btn.dataset.idx,10);
          const key = keyPrefix + (currentShownUser||win._kifuUserId||'');
          const data = JSON.parse(win.localStorage.getItem(key)||'[]').slice().reverse();
          if(!data[i]) return;
          let pgnText = data[i].pgn||'';
          try{ if(data[i].compressed && window.opener && typeof window.opener.decompressBase64ToString === 'function'){ pgnText = await window.opener.decompressBase64ToString(data[i].pgn); } }catch(err){ console.warn('decompress failed',err); }
          const blob = new Blob([pgnText||''],{type:'text/plain;charset=utf-8'});
          const url = URL.createObjectURL(blob); const a = doc.createElement('a'); a.href = url; a.download = 'game.pgn'; doc.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          return;
        }

        if(btn.classList.contains('dltxt')){
          const i = parseInt(btn.dataset.idx,10);
          const key = keyPrefix + (currentShownUser||win._kifuUserId||'');
          const data = JSON.parse(win.localStorage.getItem(key)||'[]').slice().reverse();
          if(!data[i]) return;
          let pgnText = data[i].pgn||'';
          try{ if(data[i].compressed && window.opener && typeof window.opener.decompressBase64ToString === 'function'){ pgnText = await window.opener.decompressBase64ToString(data[i].pgn); } }catch(err){ console.warn('decompress failed',err); }
          const txt = (pgnText||''); const blob = new Blob([txt],{type:'text/plain;charset=utf-8'}); const url = URL.createObjectURL(blob); const a = doc.createElement('a'); a.href = url; a.download = 'game.txt'; doc.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
          return;
        }

        if(btn.classList.contains('delete')){
          const i = parseInt(btn.dataset.idx,10);
          const key = keyPrefix + (currentShownUser||win._kifuUserId||'');
          const orig = JSON.parse(win.localStorage.getItem(key)||'[]');
          if(!Array.isArray(orig) || orig.length===0){ alert('削除対象が見つかりません'); return; }
          const origIndex = Math.max(0, orig.length - 1 - i);
          if(!confirm('この棋譜を削除しますか？')) return;
          try{
            const entry = orig[origIndex];
            if(window.opener && typeof window.opener.tryRemoteDeleteRecord === 'function'){
              await window.opener.tryRemoteDeleteRecord(currentShownUser||win._kifuUserId||'', entry.hash, entry.timestamp);
            }
          }catch(e){ console.warn('remote delete attempt failed', e); }
          orig.splice(origIndex,1);
          win.localStorage.setItem(key, JSON.stringify(orig));
          const arr = JSON.parse(win.localStorage.getItem(key)||'[]').slice().reverse(); await renderListForData(arr);
          const v = doc.getElementById('viewer'); if(v) v.innerHTML = '<div style="margin-top:8px;font-size:12px;color:#666">表示中のユーザー: '+(currentShownUser||win._kifuUserId||'')+' （件数: '+arr.length+')</div>';
          return;
        }

        if(btn.classList.contains('delete-user')){
          const uid = btn.dataset.uid || btn.getAttribute('data-uid');
          if(!uid) return;
          if(!confirm('ユーザー "'+uid+'" の全データを削除しますか？この操作は取り消せません。')) return;
          try{ if(window.opener && typeof window.opener.tryRemoteDeleteUser === 'function'){ await window.opener.tryRemoteDeleteUser(uid); } }catch(e){ console.warn('remote delete user failed', e); }
          win.localStorage.removeItem(keyPrefix + uid);
          showUserList();
          return;
        }
      }catch(err){ console.error('popup click handler failed', err); }
    });

    doc.addEventListener('keydown', (e)=>{ if(e.key==='u' || e.key==='U'){ showUserList(); } });
    // initial render
    renderListForData(win._kifuData || []);
  })(w);
}

// Key handler: press P to open saved-kifu window
// Key handler: press P to open saved-kifu view (inline tab view)
function openKifuListInline(){
  // If already open, focus/scroll to it
  const existing = document.getElementById('kifu-panel');
  if(existing){ existing.scrollIntoView({behavior:'smooth'}); return; }

  const userId = ensureUserId();
  const panel = document.createElement('div'); panel.id = 'kifu-panel';
  panel.style.position = 'fixed'; panel.style.left = '0'; panel.style.top = '0'; panel.style.right = '0'; panel.style.bottom = '0'; panel.style.background = '#fff'; panel.style.zIndex = 9999; panel.style.overflow = 'auto'; panel.style.padding = '12px'; panel.style.fontFamily='Arial,Helvetica,sans-serif';
  panel.innerHTML = `<style>#kifu-panel button{font-size:14px;height:30px;line-height:30px;padding:0 8px;background:transparent;border:1px solid transparent;cursor:pointer;border-radius:4px} #kifu-panel button:focus{outline:1px solid #ccc}</style><div style="display:flex;align-items:center;justify-content:space-between;"><h2>保存棋譜一覧</h2><div><button id="kifu-close">閉じる</button> <button id="kifu-refresh">更新</button> <button id="kifu-users">ユーザー一覧 (U)</button></div></div><div id="kifu-list-area" style="margin-top:12px"></div><div id="kifu-viewer" style="margin-top:12px"></div>`;
  document.body.appendChild(panel);

  const listArea = panel.querySelector('#kifu-list-area');
  const viewer = panel.querySelector('#kifu-viewer');
  const btnClose = panel.querySelector('#kifu-close');
  const btnRefresh = panel.querySelector('#kifu-refresh');
  const btnUsers = panel.querySelector('#kifu-users');

  btnClose.onclick = ()=>{ panel.remove(); };
  btnRefresh.onclick = ()=>{ loadAndRenderInline(currentShownInlineUser||userId); };
  btnUsers.onclick = ()=>{ showUserListInline(); };

  let currentShownInlineUser = userId;

  async function renderListForDataInline(data){
    listArea.innerHTML = '';
    if(!data || data.length===0){ listArea.innerHTML = '<p>保存された棋譜はありません。</p>'; return; }
    for(let idx=0; idx<data.length; idx++){
      const it = data[idx];
      const when = new Date(it.timestamp).toLocaleString();
      let preview = '';
      try{ if(it.compressed){ preview = (await decompressBase64ToString(it.pgn)).replace(/\n/g,' ').slice(0,200); } else { preview = (it.pgn||'').replace(/\n/g,' ').slice(0,200); } }catch(e){ preview = (it.pgn||'').toString().slice(0,120); }
      const entry = document.createElement('div'); entry.className='entry'; entry.style.borderBottom='1px solid #ddd'; entry.style.padding='8px 0';
      const meta = document.createElement('div'); meta.className='meta'; meta.style.fontSize='12px'; meta.style.color='#666'; meta.textContent = when;
      const pv = document.createElement('div'); pv.style.margin='6px 0'; pv.textContent = preview;
      const vbtn = document.createElement('button'); vbtn.dataset.idx = idx; vbtn.className='view'; vbtn.textContent='表示';
      const pgbtn = document.createElement('button'); pgbtn.dataset.idx = idx; pgbtn.className='dlpgn'; pgbtn.textContent='PGNをダウンロード';
      const txbtn = document.createElement('button'); txbtn.dataset.idx = idx; txbtn.className='dltxt'; txbtn.textContent='TXTをダウンロード';
      const delbtn = document.createElement('button'); delbtn.dataset.idx = idx; delbtn.className='delete'; delbtn.textContent='削除'; delbtn.style.color='red';
      entry.appendChild(meta); entry.appendChild(pv); entry.appendChild(vbtn); entry.appendChild(pgbtn); entry.appendChild(txbtn); entry.appendChild(delbtn);
      listArea.appendChild(entry);
    }
  }

  async function loadAndRenderInline(uid){
    currentShownInlineUser = uid;
    let arr = null;
    try{ if(typeof fetchRemoteKifuForUser === 'function'){ arr = await fetchRemoteKifuForUser(uid); } }catch(e){ arr = null; }
    if(!Array.isArray(arr)){
      const key = 'kifu_store_'+uid; arr = JSON.parse(localStorage.getItem(key)||'[]');
    }
    arr = arr.slice().reverse();
    await renderListForDataInline(arr);
    viewer.innerHTML = `<div style="margin-top:8px;font-size:12px;color:#666">表示中のユーザー: ${uid} （件数: ${arr?arr.length:0}）</div>`;
  }

  function showUserListInline(){
    listArea.innerHTML = '<h3>ユーザー一覧</h3>';
    (async ()=>{
      let list = null;
      try{ if(typeof fetchRemoteUsersList === 'function'){ list = await fetchRemoteUsersList(); } }catch(e){ list = null; }
      if(!Array.isArray(list)){
        const keys = Object.keys(localStorage).filter(k=>k.indexOf('kifu_store_')===0);
        if(keys.length===0){ listArea.innerHTML += '<p>保存ユーザーが見つかりません</p>'; return; }
        list = keys.map(k=>{ const uid=k.replace('kifu_store_',''); const arr = JSON.parse(localStorage.getItem(k)||'[]'); return { uid: uid, count: arr.length, sample: arr[0]? (arr[0].pgn||'').slice(0,120) : '' }; });
      }
      list.forEach(u=>{
        const uid = u.uid || u.userId || u.userId;
        const count = u.count || u.c || 0;
        const sample = u.sample || '';
        const el = document.createElement('div'); el.className='user'; el.dataset.uid = uid; el.style.padding='6px 0'; el.style.display='flex'; el.style.justifyContent='space-between';
        const left = document.createElement('div'); left.style.flex='1'; left.style.cursor='pointer'; left.innerHTML = `<strong>${uid}</strong> (${count}件)<div style="color:#666">${sample}</div>`;
        left.onclick = ()=>{ loadAndRenderInline(uid); };
        const right = document.createElement('div'); right.style.display='flex'; right.style.gap='6px';
        const loadBtn = document.createElement('button'); loadBtn.textContent='表示'; loadBtn.onclick = ()=>{ loadAndRenderInline(uid); };
        const copyBtn = document.createElement('button'); copyBtn.textContent='コピー'; copyBtn.style.fontSize='12px'; copyBtn.onclick = ()=>{ const text = uid; try{ if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text); else prompt('ユーザーIDをコピーしてください', text); }catch(e){ prompt('ユーザーIDをコピーしてください', text); } };
        const delUserBtn = document.createElement('button'); delUserBtn.textContent='ユーザー削除'; delUserBtn.dataset.uid=uid; delUserBtn.className='delete-user'; delUserBtn.style.color='red';
        delUserBtn.onclick = async ()=>{
          if(!confirm('ユーザー "'+uid+'" の全データを削除しますか？')) return;
          let remoteOk = false;
          try{ if(typeof tryRemoteDeleteUser === 'function') remoteOk = await tryRemoteDeleteUser(uid); }catch(e){ remoteOk = false; }
          if(remoteOk){
            localStorage.removeItem('kifu_store_'+uid);
            alert('リモートとローカルのデータを削除しました');
            showUserListInline();
            return;
          }
          // remote failed or not available
          if(confirm('リモートでの削除に失敗しました。ローカルのデータのみ削除しますか？（サーバー上のデータは残ります）')){
            localStorage.removeItem('kifu_store_'+uid);
            alert('ローカルから削除しました（サーバー上のデータは未変更）');
            showUserListInline();
          }else{
            alert('削除を中止しました');
          }
        };
        right.appendChild(loadBtn); right.appendChild(copyBtn); right.appendChild(delUserBtn);
        el.appendChild(right);
        listArea.appendChild(el);
      });
    })();
  }

  // delegate clicks for entries (view/download/delete)
  listArea.addEventListener('click', async (e)=>{
    let node = e.target; while(node && node.nodeType===3) node = node.parentNode; let btn = node; while(btn && btn.nodeName!=='BUTTON') btn = btn.parentNode; if(!btn) return;
    if(btn.classList.contains('view')){
      const i = parseInt(btn.dataset.idx,10);
      const key = 'kifu_store_'+(currentShownInlineUser||userId);
      const data = JSON.parse(localStorage.getItem(key)||'[]').slice().reverse(); if(!data[i]) return; let pgn = data[i].pgn||''; try{ if(data[i].compressed) pgn = await decompressBase64ToString(data[i].pgn); }catch(e){}
      viewer.innerHTML = '<h3>棋譜表示</h3><textarea style="width:100%;height:320px;">'+(pgn||'')+'</textarea>';
      return;
    }
    if(btn.classList.contains('dlpgn')){
      const i = parseInt(btn.dataset.idx,10);
      const key = 'kifu_store_'+(currentShownInlineUser||userId);
      const data = JSON.parse(localStorage.getItem(key)||'[]').slice().reverse(); if(!data[i]) return; let pgn = data[i].pgn||''; try{ if(data[i].compressed) pgn = await decompressBase64ToString(data[i].pgn); }catch(e){}
      const blob = new Blob([pgn||''],{type:'text/plain;charset=utf-8'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='game.pgn'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      return;
    }
    if(btn.classList.contains('dltxt')){
      const i = parseInt(btn.dataset.idx,10);
      const key = 'kifu_store_'+(currentShownInlineUser||userId);
      const data = JSON.parse(localStorage.getItem(key)||'[]').slice().reverse(); if(!data[i]) return; let pgn = data[i].pgn||''; try{ if(data[i].compressed) pgn = await decompressBase64ToString(data[i].pgn); }catch(e){}
      const blob = new Blob([pgn||''],{type:'text/plain;charset=utf-8'}); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='game.txt'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      return;
    }
    if(btn.classList.contains('delete')){
      const i = parseInt(btn.dataset.idx,10);
      const key = 'kifu_store_'+(currentShownInlineUser||userId);
      const orig = JSON.parse(localStorage.getItem(key)||'[]'); if(!Array.isArray(orig)||orig.length===0){ alert('削除対象が見つかりません'); return; }
      const origIndex = Math.max(0, orig.length - 1 - i);
      if(!confirm('この棋譜を削除しますか？')) return;
      const entry = orig[origIndex];
      let remoteOk = false;
      try{
        if(typeof tryRemoteDeleteRecord === 'function') remoteOk = await tryRemoteDeleteRecord(currentShownInlineUser||userId, entry.hash, entry.timestamp);
      }catch(e){ remoteOk = false; }
      if(remoteOk){
        // only remove local copy if remote deletion succeeded
        orig.splice(origIndex,1); localStorage.setItem(key, JSON.stringify(orig));
        loadAndRenderInline(currentShownInlineUser||userId);
        alert('リモートとローカルの両方から削除しました');
        return;
      }else{
        // remote deletion failed or not available — ask user whether to remove local copy anyway
        if(confirm('リモート削除に失敗しました。ローカルからのみ削除しますか？（サーバー上のデータは残ります）')){
          orig.splice(origIndex,1); localStorage.setItem(key, JSON.stringify(orig)); loadAndRenderInline(currentShownInlineUser||userId);
          alert('ローカルから削除しました（サーバー上のデータは未変更）');
        }else{
          alert('削除を中止しました（ローカルにデータを保持します）');
        }
        return;
      }
    }
  });

  // initial load
  loadAndRenderInline(userId).catch(e=>{ console.warn('load inline failed',e); renderListForDataInline([]); });
}

window.addEventListener('keydown', (e)=>{ if(e.key==='p' || e.key==='P'){ openKifuListInline(); } });



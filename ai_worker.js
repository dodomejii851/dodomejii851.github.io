// ai_worker.js - evaluates a single candidate move using a simplified negamax
// This worker receives messages of the form:
// { id: <unique id>, boardState: <2D array>, move: { from:{row,col}, to:{row,col} }, depth: <int>, extraParams: { PIECE_VALUE, QUEEN_EARLY_PENALTY, QUEEN_PENALTY_PHASE_PLY, CASTLING_LOST_PENALTY, BISHOP_PAIR_BONUS, whiteCastleK,... } }
// and responds with { id, score }

self.addEventListener('message', (ev)=>{
  const data = ev.data;
  const id = data.id;
  const boardState = data.boardState;
  const move = data.move;
  const depth = data.depth;
  const params = data.params || {};

  // Implement minimal helpers locally inside worker
  function getColor(piece){ if(!piece) return null; return piece===piece.toUpperCase() ? 'white' : 'black'; }
  function oppositeColor(c){ return c==='white' ? 'black' : 'white'; }

  // clone board utility
  function cloneBoard(b){ return b.map(r=>r.slice()); }

  // apply move (no animations) - returns state to undo
  function applyMove(b, from, to){ const moving = b[from.row][from.col]; const captured = b[to.row][to.col]; b[to.row][to.col] = moving; b[from.row][from.col] = ''; return { moving, captured }; }
  function undoMove(b, from, to, st){ b[from.row][from.col] = st.moving; b[to.row][to.col] = st.captured; }

  function evaluate(b){ // simplified eval using PIECE_VALUE from params
    const PV = params.PIECE_VALUE || { P:1, N:3, B:3.25, R:5, Q:9, K:1000 };
    let s = 0;
    for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p=b[r][c]; if(!p) continue; const up=p.toUpperCase(); const val = PV[up]||0; s += (getColor(p)==='white' ? -val : val); }
    return s;
  }

  function negamax(b, depth, color, alpha, beta){ if(depth===0) return color==='black'? evaluate(b) : -evaluate(b); let max=-Infinity; // generate simple moves (we'll only look at pseudo-legal moves for speed)
    for(let r=0;r<8;r++) for(let c=0;c<8;c++){ const p=b[r][c]; if(!p||getColor(p)!==color) continue; // basic moves generation (pawn, knight, sliding simplified)
      const type=p.toUpperCase(); if(type==='P'){ const dir=color==='white'?-1:1; const r1=r+dir; if(r1>=0&&r1<8){ if(!b[r1][c]){ const st=applyMove(b,{row:r,col:c},{row:r1,col:c}); const val=-negamax(b,depth-1,oppositeColor(color),-beta,-alpha); undoMove(b,{row:r,col:c},{row:r1,col:c},st); if(val>max) max=val; if(val>alpha) alpha=val; if(alpha>=beta) return alpha; } for(const dx of [-1,1]){ const c1=c+dx; if(c1<0||c1>7) continue; if(b[r1][c1] && getColor(b[r1][c1])!==color){ const st=applyMove(b,{row:r,col:c},{row:r1,col:c1}); const val=-negamax(b,depth-1,oppositeColor(color),-beta,-alpha); undoMove(b,{row:r,col:c},{row:r1,col:c1},st); if(val>max) max=val; if(val>alpha) alpha=val; if(alpha>=beta) return alpha; } } } }
      else if(type==='N'){ const deltas=[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]; for(const [dy,dx] of deltas){ const nr=r+dy,nc=c+dx; if(nr<0||nr>7||nc<0||nc>7) continue; if(!b[nr][nc]||getColor(b[nr][nc])!==color){ const st=applyMove(b,{row:r,col:c},{row:nr,col:nc}); const val=-negamax(b,depth-1,oppositeColor(color),-beta,-alpha); undoMove(b,{row:r,col:c},{row:nr,col:nc},st); if(val>max) max=val; if(val>alpha) alpha=val; if(alpha>=beta) return alpha; } } }
      else { // sliding pieces simplification: scan in all directions
        const dirs = (type==='B')?[[1,1],[1,-1],[-1,1],[-1,-1]]:(type==='R')?[[1,0],[-1,0],[0,1],[0,-1]]:[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
        for(const [dy,dx] of dirs){ let nr=r+dy,nc=c+dx; while(nr>=0&&nr<8&&nc>=0&&nc<8){ if(!b[nr][nc]){ const st=applyMove(b,{row:r,col:c},{row:nr,col:nc}); const val=-negamax(b,depth-1,oppositeColor(color),-beta,-alpha); undoMove(b,{row:r,col:c},{row:nr,col:nc},st); if(val>max) max=val; if(val>alpha) alpha=val; if(alpha>=beta) return alpha; } else { if(getColor(b[nr][nc])!==color){ const st=applyMove(b,{row:r,col:c},{row:nr,col:nc}); const val=-negamax(b,depth-1,oppositeColor(color),-beta,-alpha); undoMove(b,{row:r,col:c},{row:nr,col:nc},st); if(val>max) max=val; if(val>alpha) alpha=val; if(alpha>=beta) return alpha; } break; } nr+=dy; nc+=dx; } }
      }
    }
    if(max===-Infinity) return color==='black'? evaluate(b) : -evaluate(b); return max; }

  // run evaluation: clone board, apply candidate move, run negamax
  try{
    const b = cloneBoard(boardState);
    const st = applyMove(b, move.from, move.to);
    const score = -negamax(b, depth-1, 'white', -Infinity, Infinity);
    // respond
    self.postMessage({ id, score });
  }catch(err){ self.postMessage({ id, error: String(err) }); }
});

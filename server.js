// server.js
// Тюремные шахматы — сервер: матчмейкинг, правила, часы, вопросы, рейтинг

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;

// ---------- Конфиг игры ----------
const INITIAL_TIME_MS = 5 * 60 * 1000; // 5+0, меняй здесь
const QUESTION_MIN_INTERVAL_MS = 20_000;
const QUESTION_MAX_INTERVAL_MS = 40_000;
const QUESTION_TIME_LIMIT_MS = 10_000;
const QUESTION_PENALTY_CORRECT_MS = 3000;  // правильный ответ тоже режет время — это тюрьма
const QUESTION_PENALTY_WRONG_MS = 12000;   // неправильный — ещё больнее

// ---------- Сервер ----------
const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------- Память (без БД) ----------
const clients = new Map(); // clientId -> { ws, userId, name, rating, games, inGameId }
const ratings = new Map(); // userId -> { rating, games }
const profiles = new Map(); // userId -> name
const waitingQueue = [];   // массив clientId
const games = new Map();   // gameId -> gameState

// ---------- Вспомогалки ----------
function now() { return Date.now(); }
function choice(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function uid() { return uuidv4(); }

// ---------- Вопросы ----------
const QUESTION_POOL = [
  {
    text: 'Сколько клеток на шахматной доске?',
    options: ['64', '72', '81', '100'],
    correct: 0
  },
  {
    text: 'Можно ли королю рокировать через битое поле?',
    options: ['Да', 'Нет'],
    correct: 1
  },
  {
    text: 'Сколько ходов делает конь от угла a1 до угла h8 при наилучшем пути?',
    options: ['6', '7', '8', '5'],
    correct: 0
  },
  {
    text: 'Как называется ход пешки с поля начального расположения на две клетки с последующим особым взятием?',
    options: ['Гамбит', 'Взятие на проходе', 'Цугцванг', 'Превращение'],
    correct: 1
  },
  {
    text: 'Может ли пешка ходить назад?',
    options: ['Да', 'Нет', 'Только при превращении'],
    correct: 1
  },
  {
    text: 'Сколько максимум коней может иметь одна сторона в легальной позиции?',
    options: ['8', '9', '10', 'Лучше не думать об этом'],
    correct: 2
  },
  {
    text: 'Можно ли поставить мат одним конём и королём против короля?',
    options: ['Да', 'Нет'],
    correct: 1
  },
  {
    text: 'Сколько клеток контролирует слон с центра (d4) на пустой доске?',
    options: ['13', '14', '15', '16'],
    correct: 1
  }
];

// ---------- Простая генерация вопросов (без внешних зависимостей) ----------
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function makeQuestion(text, options, correctValue) {
  const opts = options.map(o => String(o));
  const correctStr = String(correctValue);
  const shuffled = shuffleArray(opts.slice());
  const correct = shuffled.indexOf(correctStr);
  return { text, options: shuffled, correct: correct >= 0 ? correct : 0 };
}

function generateDynamicQuestion() {
  const variant = Math.random();
  if (variant < 0.35) {
    // Время и штраф
    const startSec = pickInt(10, 60);
    const isCorrectPenalty = Math.random() < 0.5;
    const penaltySec = Math.round((isCorrectPenalty ? QUESTION_PENALTY_CORRECT_MS : QUESTION_PENALTY_WRONG_MS) / 1000);
    const remain = Math.max(0, startSec - penaltySec);
    const text = `У вас ${startSec}с. ${isCorrectPenalty ? 'Правильный' : 'Неправильный'} ответ на вопрос — штраф ${penaltySec}с. Сколько останется секунд?`;
    const options = [remain, remain + 3, Math.max(0, remain - 2), startSec];
    return makeQuestion(text, options, remain);
  } else if (variant < 0.6) {
    // Начальная раскладка: пешки суммарно
    const text = 'Сколько пешек у обеих сторон вместе в начальной позиции?';
    const correct = 16;
    const options = [16, 14, 18, 12];
    return makeQuestion(text, options, correct);
  } else if (variant < 0.85) {
    // Начальная раскладка: легальные фигуры (без пешек) у одной стороны
    const text = 'Сколько фигур (не пешек) у одной стороны в начальной позиции?';
    const correct = 8;
    const options = [8, 7, 9, 6];
    return makeQuestion(text, options, correct);
  }
  // Цвет клетки a1
  const text = 'Какого цвета клетка a1?';
  const options = ['Светлая', 'Тёмная'];
  const correct = 1; // a1 — тёмная
  return makeQuestion(text, options, options[correct]);
}

function getNextQuestion() {
  // С вероятностью 70% — динамический вопрос, иначе — из пула
  if (Math.random() < 0.7) return generateDynamicQuestion();
  return choice(QUESTION_POOL);
}

function scheduleNextQuestion(game) {
  game.nextQuestionAt = now() + (QUESTION_MIN_INTERVAL_MS + Math.floor(Math.random() * (QUESTION_MAX_INTERVAL_MS - QUESTION_MIN_INTERVAL_MS)));
}

// ---------- LLM генерация вопросов (опционально через Ollama) ----------
const OLLAMA_URL = process.env.OLLAMA_URL || null; // например, http://localhost:11434
const PRISON_QA_MODEL = process.env.PRISON_QA_MODEL || 'llama3.2:1b';

function buildLLMPrompt() {
  return (
    'Сгенерируй один тюремный викторинный вопрос на русском с тюремным сленгом по шахматам/времени/тактике. ' +
    'Ответь строго JSON c полями: "text" (строка), "options" (массив из 4 строк), "correct" (целое 0..3). ' +
    'Пример: {"text":"Вопрос?","options":["A","B","C","D"],"correct":1}. Без комментариев.'
  );
}

async function tryGenerateLLMQuestion() {
  if (!OLLAMA_URL || !globalThis.fetch) return null;
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: PRISON_QA_MODEL, prompt: buildLLMPrompt(), stream: false })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // Ollama { response: "..." }
    const text = data.response || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!parsed || !Array.isArray(parsed.options) || parsed.options.length < 2) return null;
    if (typeof parsed.correct !== 'number') return null;
    const options = parsed.options.slice(0, 4).map(String);
    const correct = Math.max(0, Math.min(options.length - 1, parsed.correct | 0));
    return { text: String(parsed.text || 'Вопрос'), options, correct };
  } catch (_) {
    return null;
  }
}

function deliverQuestion(g, forColor, q, nowTs) {
  g.pendingQuestion = {
    id: uid(),
    forColor,
    question: q,
    deadline: nowTs + QUESTION_TIME_LIMIT_MS
  };
  const targetClientId = (forColor === 'w') ? g.whiteClientId : g.blackClientId;
  const targetClient = clients.get(targetClientId);
  const isBot = !!targetClient && targetClient.isBot;
  if (!isBot) {
    sendTo(targetClientId, 'question', {
      id: g.pendingQuestion.id,
      text: q.text,
      options: q.options,
      timeLimitMs: QUESTION_TIME_LIMIT_MS
    });
  } else {
    // Bot answers immediately (random)
    const correct = Math.random() < 0.5;
    applyQuestionPenalty(g, forColor, correct);
    g.pendingQuestion = null;
    scheduleNextQuestion(g);
    const humanId = opponentClientId(g, targetClientId);
    sendTo(humanId, 'peer_question_result', { correctPeer: correct });
  }
  sendTo(opponentClientId(g, targetClientId), 'question_peer', { timeLimitMs: QUESTION_TIME_LIMIT_MS });
}

function sendTo(clientId, type, payload) {
  const c = clients.get(clientId);
  if (!c || !c.ws || c.ws.readyState !== 1) return;
  c.ws.send(JSON.stringify({ type, ...payload }));
}

function broadcast(game, type, payload) {
  [game.whiteClientId, game.blackClientId].forEach(cid => sendTo(cid, type, payload));
}

// ---------- Рейтинг (Elo) ----------
function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}
function kFactor(gamesPlayed) {
  if (gamesPlayed < 30) return 40;
  if (gamesPlayed < 100) return 20;
  return 16;
}
function applyElo(userA, userB, scoreA) {
  const recA = ratings.get(userA) || { rating: 1200, games: 0 };
  const recB = ratings.get(userB) || { rating: 1200, games: 0 };
  const expA = expectedScore(recA.rating, recB.rating);
  const expB = 1 - expA;
  const kA = kFactor(recA.games);
  const kB = kFactor(recB.games);
  const deltaA = Math.round(kA * (scoreA - expA));
  const deltaB = Math.round(kB * ((1 - scoreA) - expB));
  recA.rating += deltaA; recA.games += 1;
  recB.rating += deltaB; recB.games += 1;
  ratings.set(userA, recA);
  ratings.set(userB, recB);
  return { deltaA, deltaB, rA: recA.rating, rB: recB.rating };
}

// ---------- Шахматный движок (серверная валидация) ----------
const FILES = 'abcdefgh'.split('');
function idx(file, rank) { return (7 - (rank - 1)) * 8 + (file.charCodeAt(0) - 97); } // a1 -> 56 .. h8 -> 7
function sqToFr(idx) { const r = 7 - Math.floor(idx / 8) + 1; const f = String.fromCharCode(97 + (idx % 8)); return f + r; }
function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function rcToIdx(r, c) { return r * 8 + c; }
function idxToRC(i) { return [Math.floor(i/8), i%8]; }

function initialBoard() {
  // Represent each piece as { t: 'pnrqkb', c: 'w'|'b' }
  const b = new Array(64).fill(null);
  const back = ['r','n','b','q','k','b','n','r'];
  // Black back rank (row 0)
  for (let c=0;c<8;c++) b[rcToIdx(0,c)] = { t: back[c], c:'b' };
  // Black pawns (row 1)
  for (let c=0;c<8;c++) b[rcToIdx(1,c)] = { t:'p', c:'b' };
  // Empty rows 2..5
  // White pawns (row 6)
  for (let c=0;c<8;c++) b[rcToIdx(6,c)] = { t:'p', c:'w' };
  // White back rank (row 7)
  for (let c=0;c<8;c++) b[rcToIdx(7,c)] = { t: back[c], c:'w' };
  return b;
}

function cloneState(s) {
  return {
    board: s.board.map(p => p ? { t:p.t, c:p.c } : null),
    turn: s.turn,
    castling: { ...s.castling },
    ep: s.ep,
    halfmove: s.halfmove,
    fullmove: s.fullmove
  };
}

function squaresAttackedBy(board, attackerColor, targetIdx) {
  // Check if square targetIdx is attacked by attackerColor
  // We can generate pseudo-moves backwards
  const [tr, tc] = idxToRC(targetIdx);
  // Knight
  const kMoves = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (const [dr,dc] of kMoves) {
    const r = tr+dr, c = tc+dc;
    if (!inBounds(r,c)) continue;
    const p = board[rcToIdx(r,c)];
    if (p && p.c === attackerColor && p.t === 'n') return true;
  }
  // King
  for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) {
    if (dr===0 && dc===0) continue;
    const r = tr+dr, c = tc+dc;
    if (!inBounds(r,c)) continue;
    const p = board[rcToIdx(r,c)];
    if (p && p.c === attackerColor && p.t === 'k') return true;
  }
  // Pawns (attacking directions)
  if (attackerColor === 'w') {
    const coords = [[tr+1, tc-1], [tr+1, tc+1]];
    for (const [r,c] of coords) {
      if (!inBounds(r,c)) continue;
      const p = board[rcToIdx(r,c)];
      if (p && p.c === 'w' && p.t==='p') return true;
    }
  } else {
    const coords = [[tr-1, tc-1], [tr-1, tc+1]];
    for (const [r,c] of coords) {
      if (!inBounds(r,c)) continue;
      const p = board[rcToIdx(r,c)];
      if (p && p.c === 'b' && p.t==='p') return true;
    }
  }
  // Sliding: bishop/rook/queen
  const dirsB = [[-1,-1],[-1,1],[1,-1],[1,1]];
  const dirsR = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const [dr,dc] of dirsB) {
    let r = tr+dr, c = tc+dc;
    while (inBounds(r,c)) {
      const p = board[rcToIdx(r,c)];
      if (p) { if (p.c === attackerColor && (p.t === 'b' || p.t === 'q')) return true; else break; }
      r += dr; c += dc;
    }
  }
  for (const [dr,dc] of dirsR) {
    let r = tr+dr, c = tc+dc;
    while (inBounds(r,c)) {
      const p = board[rcToIdx(r,c)];
      if (p) { if (p.c === attackerColor && (p.t === 'r' || p.t === 'q')) return true; else break; }
      r += dr; c += dc;
    }
  }
  return false;
}

function findKing(board, color) {
  for (let i=0;i<64;i++) { const p = board[i]; if (p && p.t==='k' && p.c===color) return i; }
  return -1;
}

function isInCheck(state, color) {
  const kingIdx = findKing(state.board, color);
  if (kingIdx === -1) return true;
  const opp = color === 'w' ? 'b' : 'w';
  return squaresAttackedBy(state.board, opp, kingIdx);
}

function genMoves(state) {
  const { board, turn, castling, ep } = state;
  const moves = [];

  function pushMove(from, to, opts={}) { moves.push({ from, to, ...opts }); }

  for (let i=0;i<64;i++) {
    const p = board[i];
    if (!p || p.c !== turn) continue;
    const [r,c] = idxToRC(i);

    if (p.t === 'p') {
      const dir = (p.c === 'w') ? -1 : 1;
      const startRow = (p.c === 'w') ? 6 : 1;
      const promoRow = (p.c === 'w') ? 0 : 7;

      // forward one
      const r1 = r+dir, c1 = c;
      if (inBounds(r1,c1) && !board[rcToIdx(r1,c1)]) {
        if (r1 === promoRow) {
          ['q','r','b','n'].forEach(pr => pushMove(i, rcToIdx(r1,c1), { promotion: pr }));
        } else {
          pushMove(i, rcToIdx(r1,c1));
        }
        // forward two
        const r2 = r+2*dir;
        if (r === startRow && !board[rcToIdx(r2,c1)]) {
          pushMove(i, rcToIdx(r2,c1), { ep: rcToIdx(r1,c1) }); // ep square is passed square
        }
      }
      // captures
      for (const dc of [-1,1]) {
        const rr = r+dir, cc = c+dc;
        if (!inBounds(rr,cc)) continue;
        const j = rcToIdx(rr,cc);
        if (board[j] && board[j].c !== p.c) {
          if (rr === promoRow) ['q','r','b','n'].forEach(pr => pushMove(i,j,{ promotion: pr })); else pushMove(i,j);
        }
      }
      // en passant
      if (ep != null) {
        const [er, ec] = idxToRC(ep);
        if (er === r+dir && Math.abs(ec - c) === 1) {
          // capture to ep square
          pushMove(i, ep, { enPassant: true });
        }
      }
    }

    if (p.t === 'n') {
      const delta = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
      for (const [dr,dc] of delta) {
        const rr = r+dr, cc = c+dc;
        if (!inBounds(rr,cc)) continue;
        const j = rcToIdx(rr,cc);
        if (!board[j] || board[j].c !== p.c) pushMove(i,j);
      }
    }

    if (p.t === 'b' || p.t === 'r' || p.t === 'q') {
      const dirs = [];
      if (p.t !== 'r') dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
      if (p.t !== 'b') dirs.push([-1,0],[1,0],[0,-1],[0,1]);
      for (const [dr,dc] of dirs) {
        let rr = r+dr, cc = c+dc;
        while (inBounds(rr,cc)) {
          const j = rcToIdx(rr,cc);
          if (!board[j]) { pushMove(i,j); }
          else { if (board[j].c !== p.c) pushMove(i,j); break; }
          rr += dr; cc += dc;
        }
      }
    }

    if (p.t === 'k') {
      for (let dr=-1; dr<=1; dr++) for (let dc=-1; dc<=1; dc++) {
        if (dr===0 && dc===0) continue;
        const rr = r+dr, cc = c+dc;
        if (!inBounds(rr,cc)) continue;
        const j = rcToIdx(rr,cc);
        if (!board[j] || board[j].c !== p.c) pushMove(i,j);
      }
      // Castling
      if (!isInCheck(state, p.c)) {
        if (p.c === 'w') {
          // short: e1 to g1, rook h1
          if (castling.wK) {
            const e1 = rcToIdx(7,4), f1 = rcToIdx(7,5), g1 = rcToIdx(7,6), h1 = rcToIdx(7,7);
            if (i===e1 && !board[f1] && !board[g1]) {
              if (!squaresAttackedBy(board, 'b', f1) && !squaresAttackedBy(board, 'b', g1)) {
                pushMove(e1, g1, { castle: 'K' });
              }
            }
          }
          // long: e1 to c1, rook a1
          if (castling.wQ) {
            const e1 = rcToIdx(7,4), d1 = rcToIdx(7,3), c1 = rcToIdx(7,2), b1 = rcToIdx(7,1), a1 = rcToIdx(7,0);
            if (i===e1 && !board[d1] && !board[c1] && !board[b1]) {
              if (!squaresAttackedBy(board, 'b', d1) && !squaresAttackedBy(board, 'b', c1)) {
                pushMove(e1, c1, { castle: 'Q' });
              }
            }
          }
        } else {
          // black
          if (castling.bK) {
            const e8 = rcToIdx(0,4), f8 = rcToIdx(0,5), g8 = rcToIdx(0,6), h8 = rcToIdx(0,7);
            if (i===e8 && !board[f8] && !board[g8]) {
              if (!squaresAttackedBy(board, 'w', f8) && !squaresAttackedBy(board, 'w', g8)) {
                pushMove(e8, g8, { castle: 'k' });
              }
            }
          }
          if (castling.bQ) {
            const e8 = rcToIdx(0,4), d8 = rcToIdx(0,3), c8 = rcToIdx(0,2), b8 = rcToIdx(0,1), a8 = rcToIdx(0,0);
            if (i===e8 && !board[d8] && !board[c8] && !board[b8]) {
              if (!squaresAttackedBy(board, 'w', d8) && !squaresAttackedBy(board, 'w', c8)) {
                pushMove(e8, c8, { castle: 'q' });
              }
            }
          }
        }
      }
    }
  }

  // Отфильтровать ходы, оставляющие своего короля под шахом
  const legal = [];
  for (const m of moves) {
    const next = applyMoveNoCheck(state, m);
    if (!isInCheck(next, state.turn)) {
      legal.push(m);
    }
  }
  return legal;
}

function applyMoveNoCheck(state, move) {
  const s = cloneState(state);
  const { board } = s;
  const fromP = board[move.from];
  const toP = board[move.to];

  // Halfmove clock (для 50 ходов — мы не используем для ничьей, но считаем корректно)
  if (fromP.t === 'p' || toP) s.halfmove = 0; else s.halfmove += 1;

  // En passant capture
  if (move.enPassant) {
    const [tr, tc] = idxToRC(move.to);
    const dir = (fromP.c === 'w') ? 1 : -1; // пешка бьёт на проходе: срезать сзади
    const capIdx = rcToIdx(tr+dir, tc);
    board[capIdx] = null;
  }
  // Move piece
  board[move.to] = fromP;
  board[move.from] = null;

  // Promotion
  if (move.promotion) {
    board[move.to] = { t: move.promotion, c: fromP.c };
  }

  // Castling moves for rook
  if (move.castle) {
    if (move.castle === 'K') { // white short
      board[rcToIdx(7,5)] = board[rcToIdx(7,7)];
      board[rcToIdx(7,7)] = null;
    } else if (move.castle === 'Q') {
      board[rcToIdx(7,3)] = board[rcToIdx(7,0)];
      board[rcToIdx(7,0)] = null;
    } else if (move.castle === 'k') { // black short
      board[rcToIdx(0,5)] = board[rcToIdx(0,7)];
      board[rcToIdx(0,7)] = null;
    } else if (move.castle === 'q') {
      board[rcToIdx(0,3)] = board[rcToIdx(0,0)];
      board[rcToIdx(0,0)] = null;
    }
  }

  // Update castling rights
  function disableCastlingPiece(i, color) {
    const [r,c] = idxToRC(i);
    if (color === 'w') {
      if (r===7 && c===4) { s.castling.wK = false; s.castling.wQ = false; }
      if (r===7 && c===7) s.castling.wK = false;
      if (r===7 && c===0) s.castling.wQ = false;
    } else {
      if (r===0 && c===4) { s.castling.bK = false; s.castling.bQ = false; }
      if (r===0 && c===7) s.castling.bK = false;
      if (r===0 && c===0) s.castling.bQ = false;
    }
  }
  // If king or rooks moved/captured, adjust rights
  if (fromP.t === 'k') disableCastlingPiece(move.from, fromP.c);
  if (fromP.t === 'r') disableCastlingPiece(move.from, fromP.c);
  if (toP && toP.t === 'r') disableCastlingPiece(move.to, toP.c);

  // En passant target
  s.ep = null;
  if (fromP.t === 'p' && Math.abs(idxToRC(move.to)[0] - idxToRC(move.from)[0]) === 2) {
    // store ep square (passed square)
    s.ep = move.ep ?? null;
  }

  // Switch turn
  s.turn = (s.turn === 'w') ? 'b' : 'w';
  if (s.turn === 'w') s.fullmove += 1;

  return s;
}

function makeInitialState() {
  return {
    board: initialBoard(),
    turn: 'w',
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    ep: null,
    halfmove: 0,
    fullmove: 1
  };
}

function uciToIdx(uci) {
  // 'e2' -> index
  const file = uci[0];
  const rank = parseInt(uci[1], 10);
  return idx(file, rank);
}

function legalMove(state, move) {
  const legal = genMoves(state);
  return legal.find(m => m.from === move.from && m.to === move.to && (m.promotion || null) === (move.promotion || null));
}

function gameResult(state) {
  const legal = genMoves(state);
  if (legal.length > 0) return null;
  // No legal moves: checkmate or stalemate
  if (isInCheck(state, state.turn)) {
    return { type: 'checkmate', winner: (state.turn === 'w') ? 'b' : 'w' };
  }
  return { type: 'stalemate' };
}

// ---------- Игра ----------
function createGame(whiteClientId, blackClientId) {
  const g = {
    id: uid(),
    whiteClientId,
    blackClientId,
    state: makeInitialState(),
    time: { w: INITIAL_TIME_MS, b: INITIAL_TIME_MS },
    lastTickAt: now(),
    nextQuestionAt: null,
    pendingQuestion: null, // { id, forColor, question, deadline }
    questionGenerating: false,
    finished: false,
    interval: null,
    botTimeout: null
  };
  scheduleNextQuestion(g);
  games.set(g.id, g);
  clients.get(whiteClientId).inGameId = g.id;
  clients.get(blackClientId).inGameId = g.id;

  // Ticker
  g.interval = setInterval(() => tickGame(g.id), 200);
  return g;
}

function endGame(g, reason, winnerColor=null) {
  if (!g || g.finished) return;
  g.finished = true;
  clearInterval(g.interval);
  g.interval = null;
  if (g.botTimeout) { clearTimeout(g.botTimeout); g.botTimeout = null; }

  let resultText = '';
  let scoreWhite = 0.5, scoreBlack = 0.5;

  if (reason === 'checkmate') {
    resultText = `Мат. Победа ${winnerColor === 'w' ? 'белых' : 'чёрных'}.`;
    scoreWhite = (winnerColor === 'w') ? 1 : 0;
    scoreBlack = 1 - scoreWhite;
  } else if (reason === 'timeout') {
    resultText = `Флаг. Победа ${winnerColor === 'w' ? 'белых' : 'чёрных'}.`;
    scoreWhite = (winnerColor === 'w') ? 1 : 0;
    scoreBlack = 1 - scoreWhite;
  } else if (reason === 'resign') {
    resultText = `Сдача. Победа ${winnerColor === 'w' ? 'белых' : 'чёрных'}.`;
    scoreWhite = (winnerColor === 'w') ? 1 : 0;
    scoreBlack = 1 - scoreWhite;
  } else if (reason === 'stalemate') {
    resultText = 'Пат. Ничья.';
    scoreWhite = scoreBlack = 0.5;
  } else if (reason === 'draw') {
    resultText = 'Ничья по соглашению.';
    scoreWhite = scoreBlack = 0.5;
  } else {
    resultText = 'Игра окончена.';
  }

  const white = clients.get(g.whiteClientId);
  const black = clients.get(g.blackClientId);
  const whiteUser = white.userId;
  const blackUser = black.userId;

  const elo = applyElo(whiteUser, blackUser, scoreWhite);

  broadcast(g, 'game_over', {
    result: resultText,
    winner: winnerColor,
    rating: {
      whiteBefore: (ratings.get(whiteUser)?.rating ?? 1200) - elo.deltaA,
      whiteAfter: elo.rA,
      blackBefore: (ratings.get(blackUser)?.rating ?? 1200) - elo.deltaB,
      blackAfter: elo.rB,
      deltaWhite: elo.deltaA,
      deltaBlack: elo.deltaB
    },
    players: {
      white: { name: profiles.get(whiteUser) || 'Белые', id: whiteUser },
      black: { name: profiles.get(blackUser) || 'Чёрные', id: blackUser }
    }
  });

  // Detach clients from game
  [g.whiteClientId, g.blackClientId].forEach(cid => {
    const c = clients.get(cid);
    if (c) c.inGameId = null;
  });
  games.delete(g.id);
}

function colorOfClient(g, clientId) {
  return (g.whiteClientId === clientId) ? 'w' : 'b';
}

function opponentClientId(g, clientId) {
  return (g.whiteClientId === clientId) ? g.blackClientId : g.whiteClientId;
}

function currentColor(g) {
  return g.state.turn;
}

function tickGame(gameId) {
  const g = games.get(gameId);
  if (!g || g.finished) return;
  const t = now();
  const dt = t - g.lastTickAt;
  g.lastTickAt = t;

  const side = currentColor(g);
  g.time[side] = Math.max(0, g.time[side] - dt);

  // Timeout?
  if (g.time[side] <= 0) {
    const winner = (side === 'w') ? 'b' : 'w';
    endGame(g, 'timeout', winner);
    return;
  }

  // Question deadline
  if (g.pendingQuestion) {
    if (t >= g.pendingQuestion.deadline) {
      // Not answered => wrong
      applyQuestionPenalty(g, g.pendingQuestion.forColor, false);
      g.pendingQuestion = null;
      scheduleNextQuestion(g);
      broadcast(g, 'question_result', { correct: false, penaltyMs: QUESTION_PENALTY_WRONG_MS });
      // время поменялось — отправим состояние
      broadcast(g, 'state', serializeStateForClients(g));
    }
  } else {
    // Schedule question if time
    if (t >= g.nextQuestionAt && !g.questionGenerating) {
      const forColor = currentColor(g); // вопрос тому, чей ход
      g.questionGenerating = true;
      const fallback = getNextQuestion();
      // Попробовать LLM, иначе fallback
      Promise.resolve()
        .then(() => tryGenerateLLMQuestion())
        .then((llmQ) => {
          const q = llmQ || fallback;
          deliverQuestion(g, forColor, q, t);
        })
        .finally(() => {
          g.questionGenerating = false;
        });
    }
  }
}

function isBotClient(clientId) {
  const c = clients.get(clientId);
  return !!c && !!c.isBot;
}

function scheduleBotIfNeeded(g) {
  if (!g || g.finished) return;
  const side = currentColor(g);
  const botClientId = side === 'w' ? g.whiteClientId : g.blackClientId;
  if (!isBotClient(botClientId)) return;
  if (g.botTimeout) return; // already scheduled
  g.botTimeout = setTimeout(() => {
    g.botTimeout = null;
    tryBotMove(g.id);
  }, 200);
}

function tryBotMove(gameId) {
  const g = games.get(gameId);
  if (!g || g.finished) return;
  const side = currentColor(g);
  const botClientId = side === 'w' ? g.whiteClientId : g.blackClientId;
  if (!isBotClient(botClientId)) return;

  // Deduct time similar to player move
  const t = now();
  const dt = t - g.lastTickAt;
  g.lastTickAt = t;
  g.time[side] = Math.max(0, g.time[side] - dt);
  if (g.time[side] <= 0) {
    const winner = (side === 'w') ? 'b' : 'w';
    endGame(g, 'timeout', winner);
    return;
  }

  const legal = genMoves(g.state);
  if (legal.length === 0) {
    const res = gameResult(g.state);
    if (res) {
      if (res.type === 'checkmate') endGame(g, 'checkmate', res.winner);
      else if (res.type === 'stalemate') endGame(g, 'stalemate', null);
    }
    return;
  }

  const mv = choice(legal);
  g.state = applyMoveNoCheck(g.state, mv);
  g.lastMove = { from: mv.from, to: mv.to };
  const res = gameResult(g.state);
  broadcast(g, 'state', serializeStateForClients(g));
  if (res) {
    if (res.type === 'checkmate') endGame(g, 'checkmate', res.winner);
    else if (res.type === 'stalemate') endGame(g, 'stalemate', null);
    return;
  }
  // If it's still bot's turn (shouldn't happen), schedule again; otherwise stop
  scheduleBotIfNeeded(g);
}

function applyQuestionPenalty(g, color, correct) {
  const penalty = correct ? QUESTION_PENALTY_CORRECT_MS : QUESTION_PENALTY_WRONG_MS;
  g.time[color] = Math.max(0, g.time[color] - penalty);
  // If this flags the player — game over
  if (g.time[color] <= 0) {
    const winner = (color === 'w') ? 'b' : 'w';
    endGame(g, 'timeout', winner);
  }
}

// ---------- WS Протокол ----------
wss.on('connection', (ws) => {
  const clientId = uid();
  clients.set(clientId, { ws, userId: null, name: null, rating: 1200, games: 0, inGameId: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const c = clients.get(clientId);
    if (!c) return;

    // handshake
    if (msg.type === 'hello') {
      const userId = msg.userId || uid();
      const name = msg.name || ('Гость-' + userId.slice(0,4));
      const rec = ratings.get(userId) || { rating: 1200, games: 0 };
      c.userId = userId;
      c.name = name;
      c.rating = rec.rating;
      c.games = rec.games;
      ratings.set(userId, rec);
      profiles.set(userId, name);
      ws.send(JSON.stringify({ type: 'hello_ok', userId, name, rating: rec.rating, games: rec.games }));
      return;
    }

    if (msg.type === 'quick_play') {
      if (c.inGameId) return; // уже в игре
      // Добавить в очередь
      waitingQueue.push(clientId);
      // Попробовать сматчить
      if (waitingQueue.length >= 2) {
        // Вынимаем первых двоих, рандомим цвет
        const a = waitingQueue.shift();
        const b = waitingQueue.shift();
        const white = Math.random() < 0.5 ? a : b;
        const black = (white === a) ? b : a;
        const g = createGame(white, black);
        const cw = clients.get(white);
        const cb = clients.get(black);
        sendTo(white, 'game_start', {
          gameId: g.id,
          color: 'w',
          startTimeMs: INITIAL_TIME_MS,
          opp: { name: cb.name, rating: ratings.get(cb.userId)?.rating ?? 1200 }
        });
        sendTo(black, 'game_start', {
          gameId: g.id,
          color: 'b',
          startTimeMs: INITIAL_TIME_MS,
          opp: { name: cw.name, rating: ratings.get(cw.userId)?.rating ?? 1200 }
        });
        broadcast(g, 'state', serializeStateForClients(g));
        scheduleBotIfNeeded(g);
      } else {
        // Если нет соперника, мгновенно запускаем игру с ботом
        const human = waitingQueue.shift();
        // Создаём бот-клиента
        const botId = uid();
        clients.set(botId, { ws: null, userId: 'bot-' + botId.slice(0,6), name: 'Бот', rating: 1200, games: 0, inGameId: null, isBot: true });
        const whiteIsHuman = Math.random() < 0.5;
        const white = whiteIsHuman ? human : botId;
        const black = whiteIsHuman ? botId : human;
        const g = createGame(white, black);
        const humanColor = (g.whiteClientId === human) ? 'w' : 'b';
        const oppName = 'Бот';
        sendTo(human, 'game_start', {
          gameId: g.id,
          color: humanColor,
          startTimeMs: INITIAL_TIME_MS,
          opp: { name: oppName, rating: 1200 }
        });
        broadcast(g, 'state', serializeStateForClients(g));
        scheduleBotIfNeeded(g);
      }
      return;
    }

    if (msg.type === 'legal_moves') {
      const g = games.get(c.inGameId);
      if (!g || g.finished) return;
      // Игрок может запросить легальные ходы для клетки
      const from = uciToIdx(msg.from);
      const all = genMoves(g.state);
      const forFrom = all.filter(m => m.from === from).map(m => ({ to: m.to, promotion: m.promotion || null, enPassant: !!m.enPassant, castle: m.castle || null }));
      sendTo(clientId, 'legal_moves', { from: msg.from, moves: forFrom });
      return;
    }

    if (msg.type === 'move') {
      const g = games.get(c.inGameId);
      if (!g || g.finished) return;
      const color = colorOfClient(g, clientId);
      if (g.state.turn !== color) return;

      // Игнор, если вопрос открыт этому цвету — можно играть параллельно, тюрьма не ждёт? Нет, вопрос не блокирует ход.
      // Это делает механику жёстче: отвечать или играть — время всё равно тает.

      // Парсим и валидируем ход
      const mv = {
        from: uciToIdx(msg.from),
        to: uciToIdx(msg.to),
        promotion: msg.promotion ? msg.promotion.toLowerCase() : null
      };
      const lm = legalMove(g.state, mv);
      if (!lm) {
        sendTo(clientId, 'illegal', { reason: 'Нелегальный ход' });
        return;
      }

      // Применяем тик часов до момента хода
      const t = now();
      const dt = t - g.lastTickAt;
      g.lastTickAt = t;
      g.time[color] = Math.max(0, g.time[color] - dt);
      if (g.time[color] <= 0) {
        const winner = (color === 'w') ? 'b' : 'w';
        endGame(g, 'timeout', winner);
        return;
      }

      // Применить ход
      g.state = applyMoveNoCheck(g.state, lm);
      g.lastMove = { from: lm.from, to: lm.to };

      // Проверка окончания (мат/пат)
      const res = gameResult(g.state);
      broadcast(g, 'state', serializeStateForClients(g));
      if (res) {
        if (res.type === 'checkmate') endGame(g, 'checkmate', res.winner);
        else if (res.type === 'stalemate') endGame(g, 'stalemate', null);
      } else {
        // Если теперь ход бота — пусть он ответит
        scheduleBotIfNeeded(g);
      }
      return;
    }
        if (msg.type === 'resign') {
      const g = games.get(c.inGameId);
      if (!g || g.finished) return;
      const color = colorOfClient(g, clientId);
      const winner = (color === 'w') ? 'b' : 'w';
      endGame(g, 'resign', winner);
      return;
    }

    if (msg.type === 'answer_question') {
      const g = games.get(c.inGameId);
      if (!g || g.finished || !g.pendingQuestion) return;
      const color = colorOfClient(g, clientId);
      if (color !== g.pendingQuestion.forColor) return;

      const correct = (msg.optionIndex === g.pendingQuestion.question.correct);
      applyQuestionPenalty(g, color, correct);
      g.pendingQuestion = null;
      scheduleNextQuestion(g);

      sendTo(clientId, 'question_result', { correct, penaltyMs: correct ? QUESTION_PENALTY_CORRECT_MS : QUESTION_PENALTY_WRONG_MS });
      sendTo(opponentClientId(g, clientId), 'peer_question_result', { correctPeer: correct });
      // время поменялось — отправим состояние
      broadcast(g, 'state', serializeStateForClients(g));
      return;
    }
  });

  ws.on('close', () => {
    const c = clients.get(clientId);
    if (!c) return;
    // Если игрок в игре — автосдача
    if (c.inGameId) {
      const g = games.get(c.inGameId);
      if (g && !g.finished) {
        const color = colorOfClient(g, clientId);
        const winner = (color === 'w') ? 'b' : 'w';
        endGame(g, 'resign', winner);
      }
    }
    clients.delete(clientId);
    // Удалить из очереди ожидания
    const idxQ = waitingQueue.indexOf(clientId);
    if (idxQ >= 0) waitingQueue.splice(idxQ, 1);
  });
});

// ---------- Сериализация состояния ----------
function serializeStateForClients(g) {
  return {
    board: g.state.board.map(p => p ? (p.c + p.t) : null),
    turn: g.state.turn,
    time: g.time,
    fullmove: g.state.fullmove,
    lastMove: g.lastMove || null
  };
}

server.listen(PORT, () => {
  console.log(`Prison Chess server listening on http://localhost:${PORT}`);
});

// ---------- HTTP API: Таблица лидеров ----------
app.get('/api/leaderboard', (req, res) => {
  const top = Array.from(ratings.entries())
    .map(([userId, rec]) => ({ userId, name: profiles.get(userId) || 'Игрок', rating: rec.rating, games: rec.games }))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 20);
  res.json({ top });
});


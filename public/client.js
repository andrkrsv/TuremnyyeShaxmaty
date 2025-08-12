let ws;
let myColor;
let selectedSquare = null;
let boardState = [];
let gameStarted = false;
let timeWhite = 0, timeBlack = 0;
let turn = 'w';
let lastMove = null;
let legalFromMoves = new Map(); // fromIdx -> Set(toIdx)
let questionDeadlineAt = null;
let rafTimerId = null;

function drawBoard() {
  const boardDiv = document.getElementById('board');
  boardDiv.innerHTML = '';
  for (let r=0; r<8; r++) {
    for (let c=0; c<8; c++) {
      const idx = r*8 + c;
      const sq = document.createElement('div');
      sq.classList.add('square', 'animate-move');
      const light = (r+c) % 2 === 0;
      sq.classList.add(light ? 'light' : 'dark');
      if (lastMove && (lastMove.from === idx || lastMove.to === idx)) {
        sq.classList.add('last-move');
      }
      if (selectedSquare === idx) {
        sq.classList.add('selected');
      }
      const movesFrom = legalFromMoves.get(selectedSquare || -1);
      if (movesFrom && movesFrom.has(idx)) {
        sq.classList.add('move-hint');
      }
      const piece = boardState[idx];
      if (piece) {
        const color = piece[0];
        const type = piece[1];
        sq.textContent = pieceChar(color, type);
      }
      sq.addEventListener('click', () => onSquareClick(idx));
      boardDiv.appendChild(sq);
    }
  }
}

function pieceChar(color, type) {
  const map = {
    'wp': '♙', 'bp': '♟',
    'wr': '♖', 'br': '♜',
    'wn': '♘', 'bn': '♞',
    'wb': '♗', 'bb': '♝',
    'wq': '♕', 'bq': '♛',
    'wk': '♔', 'bk': '♚'
  };
  return map[color + type] || '?';
}

function onSquareClick(idx) {
  if (!gameStarted) return;
  // Если наш ход, поддерживаем выбор и отправку
  if (myColor === currentTurn()) {
    if (selectedSquare === null) {
      selectedSquare = idx;
      requestLegalMoves(idx);
    } else if (selectedSquare === idx) {
      selectedSquare = null;
      legalFromMoves.clear();
    } else {
      const fromUci = idxToUci(selectedSquare);
      const toUci = idxToUci(idx);
      let promotion = null;
      const piece = boardState[selectedSquare];
      if (piece) {
        const color = piece[0];
        const type = piece[1];
        const toRow = Math.floor(idx / 8);
        if (type === 'p' && ((color === 'w' && toRow === 0) || (color === 'b' && toRow === 7))) {
          promotion = 'q';
        }
      }
      ws.send(JSON.stringify({ type:'move', from: fromUci, to: toUci, promotion }));
      selectedSquare = null;
      legalFromMoves.clear();
    }
    drawBoard();
  }
}

function requestLegalMoves(fromIdx) {
  const fromUci = idxToUci(fromIdx);
  ws.send(JSON.stringify({ type: 'legal_moves', from: fromUci }));
}

function idxToUci(idx) {
  const file = 'abcdefgh'[idx % 8];
  const rank = 8 - Math.floor(idx / 8);
  return file + rank;
}

function currentTurn() {
  return turn;
}

document.getElementById('startQuick').onclick = () => {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type:'hello', name: document.getElementById('name').value }));
    ws.send(JSON.stringify({ type:'quick_play' }));
  };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'hello_ok') {
      console.log('hello', data);
    }
    if (data.type === 'game_start') {
      myColor = data.color;
      gameStarted = true;
      document.getElementById('login').style.display = 'none';
      document.getElementById('game').style.display = 'block';
      timeWhite = data.startTimeMs;
      timeBlack = data.startTimeMs;
      startTimerLoop();
    }
    if (data.type === 'state') {
      boardState = data.board;
      turn = data.turn;
      timeWhite = data.time.w;
      timeBlack = data.time.b;
      lastMove = data.lastMove || null;
      drawBoard();
      // время обновится в анимационном цикле
    }
    if (data.type === 'legal_moves') {
      const from = uciToIdx(data.from);
      const set = new Set(data.moves.map(m => m.to));
      legalFromMoves.set(from, set);
      drawBoard();
    }
    if (data.type === 'illegal') alert(data.reason);
    if (data.type === 'question') {
      showQuestion(data);
    }
    if (data.type === 'question_result') {
      hideQuestion();
      alert(`Ответ ${data.correct?'правильный':'неправильный'}, штраф ${data.penaltyMs/1000}с`);
    }
    if (data.type === 'game_over') {
      alert(`${data.result}\nВаш рейтинг: ${myColor==='w'?data.rating.whiteAfter:data.rating.blackAfter} (${myColor==='w'?data.rating.deltaWhite:data.rating.deltaBlack>=0?'+':''}${myColor==='w'?data.rating.deltaWhite:data.rating.deltaBlack})`);
      gameStarted = false;
      location.reload();
    }
  };
};

// Лидеры
async function refreshLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const div = document.getElementById('leaderboard');
    const rows = (data.top || []).map((r, i) => `<tr><td>${i+1}</td><td>${r.name}</td><td>${r.rating}</td><td>${r.games}</td></tr>`).join('');
    div.innerHTML = `<h3>Таблица лидеров</h3><table><thead><tr><th>#</th><th>Имя</th><th>Рейтинг</th><th>Игры</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch {}
}

setInterval(() => {
  if (gameStarted) refreshLeaderboard();
}, 5000);

function startTimerLoop() {
  function loop() {
    renderClocks();
    rafTimerId = requestAnimationFrame(loop);
  }
  if (rafTimerId) cancelAnimationFrame(rafTimerId);
  rafTimerId = requestAnimationFrame(loop);
}

function renderClocks() {
  document.getElementById('clocks').textContent = `Белые: ${(timeWhite/1000).toFixed(1)}с — Чёрные: ${(timeBlack/1000).toFixed(1)}с`;
}

document.getElementById('resign').onclick = () => {
  ws.send(JSON.stringify({ type:'resign' }));
};

function showQuestion(q) {
  const div = document.getElementById('question');
  div.style.display = 'block';
  const start = performance.now();
  const limit = q.timeLimitMs || 10000;
  questionDeadlineAt = start + limit;
  div.innerHTML = `<div>${q.text}</div><div class="timer">Осталось: <span id="qtime"></span></div>`;
  const update = () => {
    if (div.style.display === 'none') return;
    const t = performance.now();
    const remain = Math.max(0, questionDeadlineAt - t);
    const el = document.getElementById('qtime');
    if (el) el.textContent = (remain/1000).toFixed(1) + 'с';
    if (remain > 0) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
  q.options.forEach((opt,i) => {
    const btn = document.createElement('button');
    btn.textContent = opt;
    btn.onclick = () => {
      ws.send(JSON.stringify({ type:'answer_question', optionIndex: i }));
      hideQuestion();
    };
    div.appendChild(btn);
  });
}

function hideQuestion() {
  document.getElementById('question').style.display = 'none';
}


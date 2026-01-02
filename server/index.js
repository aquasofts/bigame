// /opt/game/server/index.js
// Matrix Game Server (Express + Socket.IO)
// Rule update: every round regenerates ALL 9 cells (18 numbers: a/b per cell).
// Fairness: uses common "reject-sampling + scoring" board generation + optional rubber-banding.

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

// Comma-separated list. Example:
// ALLOW_ORIGINS="http://8.209.231.192,http://8.209.231.192:80,http://localhost:5173"
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS ||
  "http://8.209.231.192,http://8.209.231.192:80,http://localhost:5173")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

// Fairness switches
const FAIR_MODE = String(process.env.FAIR_MODE || "1") === "1"; // 1=on,0=off
const RUBBER_BAND = String(process.env.RUBBER_BAND || "1") === "1"; // 1=on,0=off

// Tunables (safe defaults)
const CANDIDATES = Number(process.env.FAIR_CANDIDATES || 220); // candidate boards per round
const MEAN_LIMIT = Number(process.env.FAIR_MEAN_LIMIT || 12); // abs(mean rowSumA/colSumB) <=
const SPREAD_LIMIT = Number(process.env.FAIR_SPREAD_LIMIT || 90); // max-min <=
const EXTREME_START = Number(process.env.FAIR_EXTREME_START || 45); // penalty after abs(x)>45
const MAX_BIAS = Number(process.env.FAIR_MAX_BIAS || 6); // rubber band max bias magnitude
const BIAS_STEP = Number(process.env.FAIR_BIAS_STEP || 25); // scoreDiff/25 -> bias
const ROUND_DELAY_MS = Number(process.env.ROUND_DELAY_MS || 700);

function normOrigin(origin) {
  if (!origin) return "";
  return String(origin).trim().replace(/\/$/, "");
}
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl / same-machine / some cases
  const o = normOrigin(origin);
  return ALLOW_ORIGINS.includes(o);
}

const app = express();
app.use(express.json());

// ✅ Don't throw errors in CORS callback (prevents 500). Just deny.
app.use(
  cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
  })
);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
  },
  // keep defaults; nginx handles websocket upgrade
});

// --------------------- Utils ---------------------
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function mean(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function std(arr) {
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length;
  return Math.sqrt(v);
}

// --------------------- Fair board generation ---------------------
// Each board is 3x3: cell {a,b}, each in [-60,60].

function genPureRandomBoard() {
  const board = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      row.push({ a: randInt(-60, 60), b: randInt(-60, 60) });
    }
    board.push(row);
  }
  return board;
}

function scoreBoard(board) {
  const rowSumA = [0, 0, 0];
  const colSumB = [0, 0, 0];
  let extremePenalty = 0;

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const a = board[r][c].a;
      const b = board[r][c].b;
      rowSumA[r] += a;
      colSumB[c] += b;

      // discourage near ±60 "one-cell decides" boards
      extremePenalty += Math.max(0, Math.abs(a) - EXTREME_START) * 0.6;
      extremePenalty += Math.max(0, Math.abs(b) - EXTREME_START) * 0.6;
    }
  }

  const meanA = mean(rowSumA);
  const meanB = mean(colSumB);

  const spreadA = Math.max(...rowSumA) - Math.min(...rowSumA);
  const spreadB = Math.max(...colSumB) - Math.min(...colSumB);

  // weights
  const wStd = 1.2;
  const wMean = 1.2;
  const wSpread = 0.15;
  const wExtreme = 1.0;

  const score =
    wStd * (std(rowSumA) + std(colSumB)) +
    wMean * (Math.abs(meanA) + Math.abs(meanB)) +
    wSpread * (spreadA + spreadB) +
    wExtreme * extremePenalty;

  return { score, rowSumA, colSumB, meanA, meanB, spreadA, spreadB };
}

function genCandidateBoard(biasA, biasB) {
  const board = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const a = clamp(randInt(-60, 60) + biasA, -60, 60);
      const b = clamp(randInt(-60, 60) + biasB, -60, 60);
      row.push({ a, b });
    }
    board.push(row);
  }
  return board;
}

function genFairBoard(scores = { A: 0, B: 0 }) {
  if (!FAIR_MODE) return genPureRandomBoard();

  // rubber-banding: tiny bias against leader, for anti-snowball
  let biasA = 0;
  let biasB = 0;
  if (RUBBER_BAND) {
    const diff = (scores.A || 0) - (scores.B || 0); // A领先为正
    const bias = clamp(Math.round(diff / BIAS_STEP), -MAX_BIAS, MAX_BIAS);
    biasA = -bias;
    biasB = +bias;
  }

  let best = null;

  // pass 1: hard constraints
  for (let i = 0; i < CANDIDATES; i++) {
    const board = genCandidateBoard(biasA, biasB);
    const s = scoreBoard(board);

    if (Math.abs(s.meanA) > MEAN_LIMIT) continue;
    if (Math.abs(s.meanB) > MEAN_LIMIT) continue;
    if (s.spreadA > SPREAD_LIMIT) continue;
    if (s.spreadB > SPREAD_LIMIT) continue;

    if (!best || s.score < best.score) best = { board, ...s };
  }

  // pass 2: fallback — no hard constraint found, just pick the best score
  if (!best) {
    for (let i = 0; i < CANDIDATES; i++) {
      const board = genCandidateBoard(biasA, biasB);
      const s = scoreBoard(board);
      if (!best || s.score < best.score) best = { board, ...s };
    }
  }

  return best.board;
}

// --------------------- Rooms state ---------------------
const rooms = new Map();

function genRoomId() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function publicState(room) {
  return {
    roomId: room.id,
    players: { A: !!room.players.A, B: !!room.players.B },
    round: room.round, // 0 before start, 1..9 during
    scores: room.scores,
    picks: room.picks,
    board: room.board,
    active: room.active,
  };
}

function resetPicks(room) {
  room.picks = { A: null, B: null };
}

function bothPicked(room) {
  return room.picks.A !== null && room.picks.B !== null;
}

function startGame(room) {
  room.active = true;
  room.round = 1;
  room.scores = { A: 0, B: 0 };
  resetPicks(room);
  room.board = genFairBoard(room.scores); // ✅ round1 board
}

function resolveRound(room) {
  const row = room.picks.A;
  const col = room.picks.B;

  const cell = room.board[row][col];
  const deltaA = cell.a;
  const deltaB = cell.b;

  room.scores.A += deltaA;
  room.scores.B += deltaB;

  return {
    chosen: { row, col },
    delta: { A: deltaA, B: deltaB },
    scores: { ...room.scores },
  };
}

// --------------------- HTTP API ---------------------
app.post("/api/rooms", (req, res) => {
  let roomId = genRoomId();
  while (rooms.has(roomId)) roomId = genRoomId();

  rooms.set(roomId, {
    id: roomId,
    createdAt: Date.now(),
    players: { A: null, B: null },
    round: 0,
    scores: { A: 0, B: 0 },
    picks: { A: null, B: null },
    board: null,
    active: false,
  });

  res.json({ roomId });
});

// healthcheck (optional)
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    port: PORT,
    allowOrigins: ALLOW_ORIGINS,
    fairMode: FAIR_MODE,
    rubberBand: RUBBER_BAND,
  });
});

// --------------------- Socket.IO ---------------------
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id, "origin:", socket.handshake.headers.origin);

  socket.on("joinRoom", ({ roomId, team }) => {
    try {
      const rid = String(roomId || "").trim().toUpperCase();
      if (!rid) return socket.emit("errorMsg", { message: "房间号不能为空" });

      const room = rooms.get(rid);
      if (!room) return socket.emit("errorMsg", { message: "房间不存在" });

      if (team !== "A" && team !== "B") return socket.emit("errorMsg", { message: "队伍必须是 A 或 B" });

      // team capacity 1
      if (room.players[team] && room.players[team] !== socket.id) {
        return socket.emit("errorMsg", { message: `队伍 ${team} 已被占用` });
      }

      // if same socket previously in other team, remove it
      const other = team === "A" ? "B" : "A";
      if (room.players[other] === socket.id) room.players[other] = null;

      room.players[team] = socket.id;
      socket.join(rid);

      io.to(rid).emit("roomState", publicState(room));

      // auto start when both joined
      if (room.players.A && room.players.B && !room.active) {
        startGame(room);
        io.to(rid).emit("gameStart", publicState(room));
      } else if (!room.players.A || !room.players.B) {
        socket.emit("waiting", { message: "等待另一位玩家加入..." });
      }
    } catch (e) {
      console.error(e);
      socket.emit("errorMsg", { message: "joinRoom 发生错误" });
    }
  });

  socket.on("pickRow", ({ roomId, row }) => {
    const rid = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(rid);
    if (!room) return socket.emit("errorMsg", { message: "房间不存在" });
    if (!room.active) return socket.emit("errorMsg", { message: "对局未开始" });
    if (room.players.A !== socket.id) return socket.emit("errorMsg", { message: "你不是 A（选行玩家）" });

    const r = Number(row);
    if (![0, 1, 2].includes(r)) return socket.emit("invalidPick", { message: "行必须是 0/1/2", state: publicState(room) });
    if (room.picks.A !== null) return socket.emit("invalidPick", { message: "本回合你已选过行", state: publicState(room) });

    room.picks.A = r;
    io.to(rid).emit("roomState", publicState(room));

    if (bothPicked(room)) finishRound(rid, room);
  });

  socket.on("pickCol", ({ roomId, col }) => {
    const rid = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(rid);
    if (!room) return socket.emit("errorMsg", { message: "房间不存在" });
    if (!room.active) return socket.emit("errorMsg", { message: "对局未开始" });
    if (room.players.B !== socket.id) return socket.emit("errorMsg", { message: "你不是 B（选列玩家）" });

    const c = Number(col);
    if (![0, 1, 2].includes(c)) return socket.emit("invalidPick", { message: "列必须是 0/1/2", state: publicState(room) });
    if (room.picks.B !== null) return socket.emit("invalidPick", { message: "本回合你已选过列", state: publicState(room) });

    room.picks.B = c;
    io.to(rid).emit("roomState", publicState(room));

    if (bothPicked(room)) finishRound(rid, room);
  });

  socket.on("restartGame", ({ roomId }) => {
    const rid = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(rid);
    if (!room) return socket.emit("errorMsg", { message: "房间不存在" });

    const isPlayer = room.players.A === socket.id || room.players.B === socket.id;
    if (!isPlayer) return socket.emit("errorMsg", { message: "你不在这个房间" });

    if (!room.players.A || !room.players.B) {
      return socket.emit("errorMsg", { message: "双方都在房间后才能再战" });
    }
    if (room.active) {
      return socket.emit("errorMsg", { message: "当前对局尚未结束" });
    }

    startGame(room);
    io.to(rid).emit("gameStart", publicState(room));
  });

  function finishRound(rid, room) {
    const result = resolveRound(room);

    // send result for animation
    io.to(rid).emit("roundResult", {
      ...result,
      board: room.board,
      round: room.round,
    });

    // game over after round 9
    if (room.round >= 9) {
      room.active = false;
      const winner =
        room.scores.A === room.scores.B ? "DRAW" : room.scores.A > room.scores.B ? "A" : "B";

      io.to(rid).emit("gameOver", {
        finalScores: { ...room.scores },
        winner,
      });

      resetPicks(room);
      return;
    }

    // next round: regenerate full board
    setTimeout(() => {
      room.round += 1;
      resetPicks(room);
      room.board = genFairBoard(room.scores); // ✅ fairness-aware + optional rubber band

      io.to(rid).emit("nextRound", publicState(room));
    }, ROUND_DELAY_MS);
  }

  socket.on("disconnect", () => {
    for (const [rid, room] of rooms.entries()) {
      let changed = false;

      if (room.players.A === socket.id) {
        room.players.A = null;
        changed = true;
      }
      if (room.players.B === socket.id) {
        room.players.B = null;
        changed = true;
      }

      if (changed) {
        room.active = false;
        resetPicks(room);
        room.board = null;

        io.to(rid).emit("opponentLeft", { message: "对手已离开，当前对局结束" });
        io.to(rid).emit("roomState", publicState(room));
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log("ALLOW_ORIGINS:", ALLOW_ORIGINS.join(","));
  console.log("FAIR_MODE:", FAIR_MODE, "RUBBER_BAND:", RUBBER_BAND);
});

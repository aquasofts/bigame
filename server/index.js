// /opt/game/server/index.js
// Matrix Game Server (Express + Socket.IO)
// Rule update: every round regenerates ALL 9 cells (18 numbers: a/b per cell).
// Fairness: uses common "reject-sampling + scoring" board generation + optional rubber-banding.

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS || 60_000);

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
const CREATE_COOLDOWN_MS = Number(process.env.CREATE_COOLDOWN_MS || 3000);
const lastCreateByIp = new Map();

function getIp(req) {
  const forwarded = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) return forwarded;
  return req.ip || "unknown";
}

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
  let rowWorstA = [Infinity, Infinity, Infinity];
  let colWorstB = [Infinity, Infinity, Infinity];

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const a = board[r][c].a;
      const b = board[r][c].b;
      rowSumA[r] += a;
      colSumB[c] += b;
      rowWorstA[r] = Math.min(rowWorstA[r], a);
      colWorstB[c] = Math.min(colWorstB[c], b);

      // discourage near ±60 "one-cell decides" boards
      extremePenalty += Math.max(0, Math.abs(a) - EXTREME_START) * 0.6;
      extremePenalty += Math.max(0, Math.abs(b) - EXTREME_START) * 0.6;
    }
  }

  const meanA = mean(rowSumA);
  const meanB = mean(colSumB);

  const spreadA = Math.max(...rowSumA) - Math.min(...rowSumA);
  const spreadB = Math.max(...colSumB) - Math.min(...colSumB);

  // Game-theory guardrail: avoid "必输的选择"
  // A picks row, so its guaranteed payoff is the row whose minimum a is largest.
  // B picks col, so its guaranteed payoff is the column whose minimum b is largest.
  const guaranteeA = Math.max(...rowWorstA);
  const guaranteeB = Math.max(...colWorstB);

  // Penalize if the guaranteed value for either side is far from 0
  // (meaning one side has a dominating/losing pure strategy).
  const dominancePenalty =
    Math.max(0, Math.abs(guaranteeA) - 5) + Math.max(0, Math.abs(guaranteeB) - 5);

  // Extra penalty if any single row/col is catastrophic for its chooser.
  const catastrophicPenalty =
    rowWorstA.reduce((s, v) => s + Math.max(0, -v - 12), 0) +
    colWorstB.reduce((s, v) => s + Math.max(0, -v - 12), 0);

  // weights
  const wStd = 1.2;
  const wMean = 1.2;
  const wSpread = 0.15;
  const wExtreme = 1.0;
  const wDominance = 1.1;
  const wCatastrophic = 0.6;

  const score =
    wStd * (std(rowSumA) + std(colSumB)) +
    wMean * (Math.abs(meanA) + Math.abs(meanB)) +
    wSpread * (spreadA + spreadB) +
    wExtreme * extremePenalty +
    wDominance * dominancePenalty +
    wCatastrophic * catastrophicPenalty;

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

function resetRoomAfterLeave(room) {
  room.active = false;
  room.round = 0;
  room.scores = { A: 0, B: 0 };
  resetPicks(room);
  room.board = null;
  if (room.offlineSince) {
    room.offlineSince.A = null;
    room.offlineSince.B = null;
  }
  clearDisconnectTimer(room, "A");
  clearDisconnectTimer(room, "B");
}

function availableTeam(room) {
  const hasA = !!room.players.A;
  const hasB = !!room.players.B;
  if (hasA && !hasB) return "B";
  if (!hasA && hasB) return "A";
  return null;
}

function bothPicked(room) {
  return room.picks.A !== null && room.picks.B !== null;
}

function clearRoomIfEmpty(room) {
  if (room.players.A || room.players.B) return;
  resetRoomAfterLeave(room);
  room.round = 0;
}

function cleanupRoomAfterDeparture(roomId, room) {
  if (room.players.A || room.players.B) {
    resetRoomAfterLeave(room);
    return;
  }
  rooms.delete(roomId);
}

function initDisconnectTracking(room) {
  room.offlineSince = { A: null, B: null };
  room.disconnectTimers = { A: null, B: null };
}

function clearDisconnectTimer(room, team) {
  if (!room.disconnectTimers) return;
  if (room.disconnectTimers[team]) {
    clearTimeout(room.disconnectTimers[team]);
    room.disconnectTimers[team] = null;
  }
  if (room.offlineSince) {
    room.offlineSince[team] = null;
  }
}

function startGame(room) {
  room.active = true;
  room.round = 1;
  room.scores = { A: 0, B: 0 };
  resetPicks(room);
  room.board = genFairBoard(room.scores); // ✅ round1 board
  clearDisconnectTimer(room, "A");
  clearDisconnectTimer(room, "B");
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

function detachFromOtherRooms(socket, keepRoomId) {
  for (const [rid, room] of rooms.entries()) {
    if (rid === keepRoomId) continue;

    const leavingTeams = [];
    if (room.players.A === socket.id) leavingTeams.push("A");
    if (room.players.B === socket.id) leavingTeams.push("B");

    if (!leavingTeams.length) continue;

    leavingTeams.forEach((team) => {
      room.players[team] = null;
      clearDisconnectTimer(room, team);
      if (room.offlineSince) room.offlineSince[team] = null;
    });

    resetRoomAfterLeave(room);
    socket.leave(rid);

    io.to(rid).emit("opponentLeft", { message: "对手已离开，当前对局结束" });
    io.to(rid).emit("roomState", publicState(room));
    cleanupRoomAfterDeparture(rid, room);
  }
}

// --------------------- HTTP API ---------------------
app.post("/api/rooms", (req, res) => {
  const ip = getIp(req);
  const now = Date.now();
  const last = lastCreateByIp.get(ip) || 0;
  const diff = now - last;
  if (diff < CREATE_COOLDOWN_MS) {
    const wait = Math.ceil((CREATE_COOLDOWN_MS - diff) / 1000);
    return res.status(429).json({ message: `创建过于频繁，请 ${wait}s 后再试` });
  }
  lastCreateByIp.set(ip, now);

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

  initDisconnectTracking(rooms.get(roomId));

  res.json({ roomId });
});

function listRooms(req, res) {
  const withPlayers = Array.from(rooms.values())
    .filter((room) => room.players.A || room.players.B)
    .map((room) => ({
      roomId: room.id,
      availableTeam: availableTeam(room),
      players: { A: !!room.players.A, B: !!room.players.B },
      active: room.active,
      createdAt: room.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);

  res.json({ rooms: withPlayers });
}

app.get("/api/rooms/solo", listRooms); // legacy route name
app.get("/api/rooms/list", listRooms);

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

      // Ensure a socket can only live in one room to avoid ghost rooms
      detachFromOtherRooms(socket, rid);

      // team capacity 1
      if (room.players[team] && room.players[team] !== socket.id) {
        return socket.emit("errorMsg", { message: `队伍 ${team} 已被占用` });
      }

      // if same socket previously in other team, remove it
      const other = team === "A" ? "B" : "A";
      if (room.players[other] === socket.id) room.players[other] = null;

      room.players[team] = socket.id;
      clearDisconnectTimer(room, team);
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

  socket.on("leaveRoom", ({ roomId }) => {
    const rid = String(roomId || "").trim().toUpperCase();
    const room = rooms.get(rid);
    if (!room) return socket.emit("errorMsg", { message: "房间不存在" });

    const leavingTeams = [];
    if (room.players.A === socket.id) leavingTeams.push("A");
    if (room.players.B === socket.id) leavingTeams.push("B");

    if (!leavingTeams.length) return socket.emit("errorMsg", { message: "你不在这个房间" });

    leavingTeams.forEach((team) => {
      room.players[team] = null;
      clearDisconnectTimer(room, team);
      if (room.offlineSince) room.offlineSince[team] = null;
    });

    socket.leave(rid);

    const hasPlayers = !!room.players.A || !!room.players.B;
    if (hasPlayers) {
      resetRoomAfterLeave(room);
      io.to(rid).emit("opponentLeft", { message: "对手已离开，房间已重置等待新玩家" });
      io.to(rid).emit("roomState", publicState(room));
      io.to(rid).emit("waiting", { message: "等待另一位玩家加入..." });
    } else {
      resetRoomAfterLeave(room);
      rooms.delete(rid);
    }

    socket.emit("roomState", publicState(room));
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
      const finalScores = { ...room.scores };
      const winner =
        finalScores.A === finalScores.B ? "DRAW" : finalScores.A > finalScores.B ? "A" : "B";

      setTimeout(() => {
        room.active = false;
        resetPicks(room);

        io.to(rid).emit("gameOver", {
          finalScores,
          winner,
        });
      }, ROUND_DELAY_MS);
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
      const disconnectedTeams = [];

      if (room.players.A === socket.id) disconnectedTeams.push("A");
      if (room.players.B === socket.id) disconnectedTeams.push("B");

      if (disconnectedTeams.length) {
        disconnectedTeams.forEach((team) => {
          room.players[team] = null;
          clearDisconnectTimer(room, team);

          const offlineAt = Date.now();
          room.offlineSince[team] = offlineAt;
          room.disconnectTimers[team] = setTimeout(() => {
            if (room.offlineSince[team] !== offlineAt) return;

            room.active = false;
            resetPicks(room);
            room.board = null;
            room.disconnectTimers[team] = null;
            room.offlineSince[team] = null;

            io.to(rid).emit("opponentLeft", { message: "对手已离开，当前对局结束" });
            io.to(rid).emit("roomState", publicState(room));
          }, DISCONNECT_GRACE_MS);
        });

        io.to(rid).emit("roomState", publicState(room));
        io.to(rid).emit("opponentDisconnected", { message: "对手断线，等待 1 分钟内重连..." });
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log("ALLOW_ORIGINS:", ALLOW_ORIGINS.join(","));
  console.log("FAIR_MODE:", FAIR_MODE, "RUBBER_BAND:", RUBBER_BAND);
});

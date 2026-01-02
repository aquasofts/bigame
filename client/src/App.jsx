import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoom, fetchRooms } from "./api";
import { makeSocket } from "./socket";
import "./styles.css";

const TEAM_LABEL = (t) => (t === "A" ? "A（选行）" : t === "B" ? "B（选列）" : "未选择");

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function anyCellAvailableInRow(board, r) {
  if (!board) return true;
  for (let c = 0; c < 3; c++) if (!board[r][c]?.used) return true;
  return false;
}
function anyCellAvailableInCol(board, c) {
  if (!board) return true;
  for (let r = 0; r < 3; r++) if (!board[r][c]?.used) return true;
  return false;
}
function cellUsed(board, r, c) {
  return !!board?.[r]?.[c]?.used;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function App() {
  const socketRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState({ type: "info", text: "准备就绪" });

  const [team, setTeam] = useState("A");
  const [roomId, setRoomId] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");

  const [state, setState] = useState(null);
  const [lastChosen, setLastChosen] = useState(null);
  const [revealTick, setRevealTick] = useState(0);
  const [gameOver, setGameOver] = useState(null);
  const [roomListOpen, setRoomListOpen] = useState(false);
  const [availableRooms, setAvailableRooms] = useState([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [createCooldownUntil, setCreateCooldownUntil] = useState(0);
  const [, forceTick] = useState(0);

  const myTeam = useMemo(() => team, [team]);

  useEffect(() => {
    const s = makeSocket();
    socketRef.current = s;

    const info = (text) => setToast({ type: "info", text });
    const good = (text) => setToast({ type: "good", text });
    const bad = (text) => setToast({ type: "bad", text });

    s.on("connect", () => {
      setConnected(true);
      good("已连接服务器");
    });
    s.on("disconnect", () => {
      setConnected(false);
      bad("与服务器断开连接");
    });

    s.on("errorMsg", ({ message }) => bad(message));
    s.on("waiting", ({ message }) => info(message));
    s.on("roomState", (st) => setState(st));
    s.on("yourTeam", ({ team: t, roomId: rid }) => {
      if (t === "A" || t === "B") {
        setTeam(t);
        if (rid) {
          setRoomId(rid);
          setJoinRoomId(rid);
        }
        setToast({ type: "info", text: `服务器确认你是 ${TEAM_LABEL(t)}` });
      } else {
        setToast({ type: "info", text: "座位已释放，可重新选择队伍" });
      }
    });

    s.on("gameStart", (st) => {
      setGameOver(null);
      setLastChosen(null);
      setState(st);
      good("对局开始！");
    });

    s.on("invalidPick", ({ message, state: st }) => {
      bad(message);
      setState(st);
    });

    s.on("roundResult", (payload) => {
      setLastChosen(payload.chosen);
      setRevealTick((x) => x + 1);
      setState((prev) => ({
        ...(prev || {}),
        board: payload.board,
        scores: payload.scores,
        round: payload.round,
        picks: prev?.picks ?? { A: null, B: null },
        players: prev?.players ?? { A: null, B: null },
      }));
      info(
        `第 ${payload.round} 回合：回合结算  A${payload.delta.A >= 0 ? "+" : ""}${payload.delta.A}  B${payload.delta.B >= 0 ? "+" : ""}${payload.delta.B}`
      );
    });

    s.on("nextRound", (st) => {
      setState(st);
      setLastChosen(null);
      good(`进入第 ${st.round} 回合`);
    });

    s.on("gameOver", (payload) => {
      setState((prev) => (prev ? { ...prev, picks: { A: null, B: null } } : prev));
      setLastChosen(null);
      setGameOver(payload);
      good("对局结束！");
    });

    s.on("opponentLeft", ({ message }) => bad(message));

    return () => s.disconnect();
  }, []);

  useEffect(() => {
    const t = setInterval(() => forceTick((x) => x + 1), 300);
    return () => clearInterval(t);
  }, []);

  async function onCreateRoom() {
    const cooldownLeft = Math.max(0, Math.ceil((createCooldownUntil - Date.now()) / 1000));
    if (cooldownLeft > 0) {
      return setToast({ type: "bad", text: `创建过于频繁，请 ${cooldownLeft}s 后再试` });
    }

    try {
      setCreatingRoom(true);
      if (roomId) {
        socketRef.current?.emit("leaveRoom", { roomId });
      }
      const { roomId: rid } = await createRoom();
      setCreateCooldownUntil(Date.now() + 3000);
      setRoomId(rid);
      setJoinRoomId(rid);
      setState(null);
      setLastChosen(null);
      setRevealTick(0);
      setGameOver(null);
      setToast({ type: "good", text: `房间已创建并已加入：${rid}` });
      socketRef.current?.emit("joinRoom", { roomId: rid, team: myTeam });
    } catch (e) {
      setToast({ type: "bad", text: e.message || "创建房间失败" });
      if (String(e?.message || "").includes("频繁")) {
        setCreateCooldownUntil(Date.now() + 3000);
      }
    } finally {
      setCreatingRoom(false);
    }
  }

  function onJoin() {
    const rid = (joinRoomId || "").trim().toUpperCase();
    if (!rid) return setToast({ type: "bad", text: "请输入房间号" });
    setRoomId(rid);
    setGameOver(null);
    setLastChosen(null);
    socketRef.current?.emit("joinRoom", { roomId: rid, team: myTeam });
    setToast({ type: "info", text: `加入房间 ${rid}，队伍 ${myTeam}...` });
  }

  async function onShareRoom() {
    if (!roomId) return setToast({ type: "bad", text: "还没有房间号" });
    const ok = await copyText(roomId);
    setToast({ type: ok ? "good" : "bad", text: ok ? "房间号已复制" : "复制失败，请手动复制" });
  }

  function onLeaveRoom() {
    if (!roomId) return setToast({ type: "bad", text: "还没有房间号" });
    socketRef.current?.emit("leaveRoom", { roomId });
    setRoomId("");
    setJoinRoomId("");
    setState(null);
    setLastChosen(null);
    setRevealTick(0);
    setGameOver(null);
    setToast({ type: "info", text: "已退出房间" });
  }

  function onRestart() {
    if (!roomId) return setToast({ type: "bad", text: "还没有房间号" });
    setGameOver(null);
    setLastChosen(null);
    setState((prev) => (prev ? { ...prev, picks: { A: null, B: null } } : prev));
    socketRef.current?.emit("restartGame", { roomId });
    setToast({ type: "info", text: "请求再战一局..." });
  }

  async function loadRoomList() {
    try {
      setRoomsLoading(true);
      const { rooms } = await fetchRooms();
      setAvailableRooms(rooms || []);
    } catch (e) {
      setToast({ type: "bad", text: e.message || "获取房间列表失败" });
    } finally {
      setRoomsLoading(false);
    }
  }

  function openRoomList() {
    setRoomListOpen(true);
  }

  useEffect(() => {
    if (roomListOpen) loadRoomList();
  }, [roomListOpen]);

  const buildReplayRounds = (history) => {
    return (history || []).map((r) => {
      const boardNumbers = (r.board || []).map((row, ri) =>
        row.map((cell, ci) => ({
          row: ri,
          col: ci,
          a: cell?.a ?? 0,
          b: cell?.b ?? 0,
        }))
      );

      const pickedRow = r?.picks?.A ?? null;
      const pickedCol = r?.picks?.B ?? null;
      const chosenCell =
        pickedRow !== null && pickedCol !== null ? r.board?.[pickedRow]?.[pickedCol] : null;

      return {
        round: r.round,
        boardNumbers,
        picks: {
          A: {
            row: pickedRow,
            label: pickedRow !== null ? `行 ${pickedRow + 1}` : null,
          },
          B: {
            col: pickedCol,
            label: pickedCol !== null ? `列 ${pickedCol + 1}` : null,
          },
        },
        chosenCell:
          chosenCell && pickedRow !== null && pickedCol !== null
            ? { row: pickedRow, col: pickedCol, a: chosenCell.a, b: chosenCell.b }
            : null,
        delta: r.delta,
        scoresAfter: r.scoresAfter,
      };
    });
  };

  function onDownloadReplay() {
    if (!gameOver?.history?.length) {
      return setToast({ type: "bad", text: "暂无可下载的回放数据" });
    }

    const payload = {
      roomId: roomId || null,
      finishedAt: new Date().toISOString(),
      finalScores: gameOver.finalScores,
      winner: gameOver.winner,
      totalRounds: gameOver.history.length,
      replayVersion: 1,
      rounds: buildReplayRounds(gameOver.history),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `matrix-game-replay-${roomId || "room"}-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    setToast({ type: "good", text: "回放文件已开始下载" });
  }

  function joinAvailableRoom(room) {
    if (!room?.roomId || !room?.availableTeam) return;
    const rid = String(room.roomId || "").trim().toUpperCase();
    const teamToUse = room.availableTeam;

    setTeam(teamToUse);
    setJoinRoomId(rid);
    setRoomId(rid);
    setGameOver(null);
    setLastChosen(null);
    socketRef.current?.emit("joinRoom", { roomId: rid, team: teamToUse });
    setToast({ type: "info", text: `加入房间 ${rid}，队伍 ${teamToUse}...` });
    setRoomListOpen(false);
  }

  function pickRow(row) {
    if (!roomId) return;
    socketRef.current?.emit("pickRow", { roomId, row });
  }
  function pickCol(col) {
    if (!roomId) return;
    socketRef.current?.emit("pickCol", { roomId, col });
  }

  // ---- 兜底：把 state 拆出来都给默认值，避免 render 报错白屏 ----
  const safeState =
    state || { players: { A: null, B: null }, picks: { A: null, B: null }, scores: { A: 0, B: 0 }, round: 0, board: null, active: false };
  const board = safeState.board;
  const bothJoined = !!safeState.players?.A && !!safeState.players?.B;
  const inGame = !!safeState.active;

  const myPickLocked =
    (myTeam === "A" && safeState.picks?.A !== null) ||
    (myTeam === "B" && safeState.picks?.B !== null);

  const round = safeState.round ?? 0;
  const progress = clamp(Math.round(((round ? round - 1 : 0) / 9) * 100), 0, 100);

  const scoreA = safeState.scores?.A ?? 0;
  const scoreB = safeState.scores?.B ?? 0;

  const pickedRow = safeState.picks?.A ?? null;
  const pickedCol = safeState.picks?.B ?? null;
  const myPickValue = myTeam === "A" ? pickedRow : pickedCol;
  const myPickLabel = myPickValue !== null ? `${myTeam === "A" ? "行" : "列"} ${myPickValue + 1}` : "未选";
  const opponentPickValue = myTeam === "A" ? pickedCol : pickedRow;
  const opponentPickLabel = opponentPickValue !== null ? "已选择" : "未选";
  const createCooldownLeft = Math.max(0, Math.ceil((createCooldownUntil - Date.now()) / 1000));
  const createDisabled = creatingRoom || createCooldownLeft > 0 || inGame;
  const createBtnLabel = createCooldownLeft > 0 ? `创建新房间（${createCooldownLeft}s）` : "创建新房间";

  const disableRow = (r) => {
    if (!board) return false;
    if (pickedCol !== null) return cellUsed(board, r, pickedCol);
    return !anyCellAvailableInRow(board, r);
  };
  const disableCol = (c) => {
    if (!board) return false;
    if (pickedRow !== null) return cellUsed(board, pickedRow, c);
    return !anyCellAvailableInCol(board, c);
  };

  const winnerText =
    !gameOver
      ? ""
      : gameOver.winner === "DRAW"
      ? "平局"
      : gameOver.winner === "A"
      ? "A 获胜"
      : "B 获胜";
  const hasReplay = !!gameOver?.history?.length;

  return (
    <div className="gRoot">
      <header className="gTopbar">
        <div className="gBrand">
          <div className="gLogo">🃏</div>
          <div>
            <div className="gTitle">简约卡牌 · 3×3 对战</div>
            <div className="gSub">A 选行 · B 选列 · 交叉格结算（9 回合）</div>
          </div>
        </div>

        <div className="gStatusPills">
          <span className={`pill ${connected ? "pillOk" : "pillBad"}`}>
            <span className="dot" /> {connected ? "Online" : "Offline"}
          </span>
          <span className="pill">
            队伍：<b>{TEAM_LABEL(myTeam)}</b>
          </span>
          <span className="pill">
            房间：<b>{roomId || "—"}</b>
          </span>
          <button className="pill pillBtn" onClick={onShareRoom} disabled={!roomId}>
            复制房间号
          </button>
        </div>
      </header>

      <main className="gMain">
        <section className="panel panelLeft">
          <div className="panelHeader">
            <div className="panelTitle">房间</div>
            <div className="panelHint">创建 / 加入，然后开始对局</div>
          </div>

          <div className="panelStack">
            <div className="card cardSection">
              <div className="cardTitle">操作</div>

              <div className="formRow actionsRow">
                <button className="btn btnPrimary" onClick={onCreateRoom} disabled={!connected || createDisabled}>
                  {createBtnLabel}
                </button>
                <button className="btn" onClick={onShareRoom} disabled={!roomId || inGame}>复制房间号</button>
                <button className="btn btnGhost btnLeave" onClick={onLeaveRoom} disabled={!roomId}>退出房间</button>
              </div>

              <div className="formRow joinRow">
                <button className="btn btnGhost" onClick={openRoomList} disabled={!connected || inGame}>房间列表</button>
              </div>

              <div className="formRow inputRow">
                <input
                  className="input"
                  value={joinRoomId}
                  onChange={(e) => setJoinRoomId(e.target.value)}
                  placeholder="输入房间号（如 ABC123）"
                  disabled={inGame}
                />
              </div>

              <div className="formRow teamRow">
                <div className="seg">
                  <button className={`segBtn ${team === "A" ? "segOn" : ""}`} onClick={() => setTeam("A")} type="button" disabled={inGame}>
                    A（选行）
                  </button>
                  <button className={`segBtn ${team === "B" ? "segOn" : ""}`} onClick={() => setTeam("B")} type="button" disabled={inGame}>
                    B（选列）
                  </button>
                </div>
                <button className="btn" onClick={onJoin} disabled={!connected || inGame}>加入</button>
              </div>
            </div>

            <div className={`card toastCard ${toast.type}`}>
              <div className="toastDot" />
              <div className="toastText">{toast.text}</div>
            </div>

            <div className="card cardSection">
              <div className="cardTitle">玩家</div>
              <div className="players">
                <div className={`playerBox ${safeState.players?.A ? "ready" : ""}`}>
                  <div className="pHead"><span className="badgeA">A</span> <b>选行</b></div>
                  <div className="pSub">{safeState.players?.A ? "已加入" : "未加入"}</div>
                </div>
                <div className={`playerBox ${safeState.players?.B ? "ready" : ""}`}>
                  <div className="pHead"><span className="badgeB">B</span> <b>选列</b></div>
                  <div className="pSub">{safeState.players?.B ? "已加入" : "未加入"}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="panel panelRight">
          <div className="panelStack">
            <div className="card heroCard">
              <div className="boardTop">
                <div className="scoreCard">
                  <div className="scoreRow">
                    <div className="scoreLabel"><span className="badgeA">A</span><span>积分</span></div>
                    <span className="scoreNum">{scoreA}</span>
                  </div>
                  <div className="scoreRow">
                    <div className="scoreLabel"><span className="badgeB">B</span><span>积分</span></div>
                    <span className="scoreNum">{scoreB}</span>
                  </div>
                </div>

                <div className="roundCard">
                  <div className="roundTitle">回合</div>
                  <div className="roundValue">{round ? `${round}/9` : "—"}</div>
                  <div className="progress"><div className="bar" style={{ width: `${progress}%` }} /></div>

                  <div className="pickRow">
                    <div className="pickPill">
                      我方：<b>{myPickLabel}</b>
                    </div>
                    <div className="pickPill">
                      对手：<b>{opponentPickLabel}</b>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="card boardCard">
              <div className="boardWrap">
                {!bothJoined && (
                  <div className="boardEmpty">
                    <div className="emptyTitle">等待玩家</div>
                    <div className="emptySub">双方加入后自动开局</div>
                  </div>
                )}

                {bothJoined && !board && (
                  <div className="boardEmpty">
                    <div className="emptyTitle">发牌中…</div>
                    <div className="emptySub">服务器生成随机棋盘</div>
                  </div>
                )}

                {board && (
                  <>
                    <div className="boardGrid">
                      {Array.from({ length: 3 }).map((_, ri) =>
                        Array.from({ length: 3 }).map((__, ci) => {
                          const cell = board?.[ri]?.[ci] || { a: 0, b: 0, used: false };
                          const used = !!cell.used;
                          const chosen = lastChosen && lastChosen.row === ri && lastChosen.col === ci;
                          const reveal = chosen ? `reveal-${revealTick}` : "";
                          const cls = `tile ${used ? "used" : ""} ${chosen ? "chosen" : ""} ${reveal}`;

                          return (
                            <div key={`${ri}-${ci}`} className={cls}>
                              <div className="tileInner">
                                <div className="tileFace tileFront">
                                  <div className="tileTop">
                                    <span className="coord">{ri},{ci}</span>
                                    <span className={`stateTag ${used ? "tagUsed" : "tagNew"}`}>{used ? "已用" : "可用"}</span>
                                  </div>
                                  <div className="vals">
                                    <div className="valLine">
                                      <span className="badgeA">A</span>
                                      <span className={`val ${cell.a >= 0 ? "pos" : "neg"}`}>{cell.a >= 0 ? `+${cell.a}` : `${cell.a}`}</span>
                                    </div>
                                    <div className="valLine">
                                      <span className="badgeB">B</span>
                                      <span className={`val ${cell.b >= 0 ? "pos" : "neg"}`}>{cell.b >= 0 ? `+${cell.b}` : `${cell.b}`}</span>
                                    </div>
                                  </div>
                                </div>

                                <div className="tileFace tileBack">
                                  <div className="cardBack">
                                    <div className="backMark">CARD</div>
                                    <div className="backLine" />
                                    <div className="backMini">3×3 MATRIX</div>
                                  </div>
                                </div>
                              </div>
                              <div className="flash" />
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="actions">
                      {myTeam === "A" ? (
                        <>
                          <div className="actTitle">你的操作：<b>选择行</b></div>
                          <div className="btnRow">
                            {[0, 1, 2].map((r) => (
                              <button
                                key={r}
                                className="btn btnPrimary"
                                onClick={() => pickRow(r)}
                                disabled={myPickLocked || !!gameOver || disableRow(r)}
                              >
                                选第 {r + 1} 行
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="actTitle">你的操作：<b>选择列</b></div>
                          <div className="btnRow">
                            {[0, 1, 2].map((c) => (
                              <button
                                key={c}
                                className="btn btnPrimary"
                                onClick={() => pickCol(c)}
                                disabled={myPickLocked || !!gameOver || disableCol(c)}
                              >
                                选第 {c + 1} 列
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      {roomListOpen && (
        <div className="modalBack">
          <div className="modal roomListModal">
            <div className="modalTitle">房间列表</div>
            <div className="modalBody roomListBody">
              <div className="roomListActions">
                <button className="btn" onClick={loadRoomList} disabled={roomsLoading}>
                  {roomsLoading ? "刷新中…" : "刷新列表"}
                </button>
                <button className="btn" onClick={() => setRoomListOpen(false)}>关闭</button>
              </div>

              {roomsLoading && <div className="roomListEmpty">正在加载房间列表…</div>}
              {!roomsLoading && availableRooms.length === 0 && (
                <div className="roomListEmpty">暂时没有可用房间，稍后再试试。</div>
              )}
              {!roomsLoading && availableRooms.length > 0 && (
                <div className="roomList">
                  {availableRooms.map((r) => (
                    <div key={r.roomId} className="roomItem">
                      <div className="roomInfo">
                        <div className="roomId">{r.roomId}</div>
                        <div className="roomMeta">
                          <span className="roomTag">
                            {r.availableTeam ? `可加入：${TEAM_LABEL(r.availableTeam)}` : "房间已满"}
                          </span>
                          <span className="roomTag subtle">
                            A：{r.players?.A ? "有人" : "空"} · B：{r.players?.B ? "有人" : "空"}
                          </span>
                        </div>
                      </div>
                      {r.availableTeam ? (
                        <button className="btn btnPrimary" onClick={() => joinAvailableRoom(r)}>一键加入</button>
                      ) : (
                        <button className="btn" disabled>房间已满</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {gameOver && (
        <div className="modalBack">
          <div className="modal">
            <div className="modalTitle">对局结束</div>
            <div className="modalBody">
              <div className="modalRow">
                <span className="badgeA">A</span> <b>{gameOver.finalScores.A}</b>
                <span className="sep">vs</span>
                <span className="badgeB">B</span> <b>{gameOver.finalScores.B}</b>
              </div>
              <div className="modalWinner">
                {gameOver.winner === "DRAW" ? "平局" : gameOver.winner === "A" ? "A 获胜" : "B 获胜"}
              </div>
              <div className="modalHint">点击再战即可立刻开新局，或在左侧创建新房间。</div>
              <div className="modalHint">下载回放可查看 9 回合每个方格的数值，以及 A/B 的行列选择。</div>
            </div>
            <div className="modalActions">
              <button className="btn" onClick={onDownloadReplay} disabled={!hasReplay}>下载回放</button>
              <button className="btn" onClick={() => setGameOver(null)}>关闭</button>
              <button className="btn btnPrimary" onClick={onRestart}>再战一局</button>
            </div>
          </div>
        </div>
      )}

      <footer className="gFooter">
        <span>分享房间号：一个选 A，一个选 B，加入同一房间即可。</span>
      </footer>
    </div>
  );
}

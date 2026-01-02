import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoom } from "./api";
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

  async function onCreateRoom() {
    try {
      const { roomId: rid } = await createRoom();
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

  function onRestart() {
    if (!roomId) return setToast({ type: "bad", text: "还没有房间号" });
    setGameOver(null);
    setLastChosen(null);
    setState((prev) => (prev ? { ...prev, picks: { A: null, B: null } } : prev));
    socketRef.current?.emit("restartGame", { roomId });
    setToast({ type: "info", text: "请求再战一局..." });
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
  const safeState = state || { players: { A: null, B: null }, picks: { A: null, B: null }, scores: { A: 0, B: 0 }, round: 0, board: null };
  const board = safeState.board;
  const bothJoined = !!safeState.players?.A && !!safeState.players?.B;

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

              <div className="formRow">
                <button className="btn btnPrimary" onClick={onCreateRoom}>创建新房间</button>
                <button className="btn" onClick={onShareRoom} disabled={!roomId}>分享（复制）</button>
              </div>

              <div className="formRow">
                <input
                  className="input"
                  value={joinRoomId}
                  onChange={(e) => setJoinRoomId(e.target.value)}
                  placeholder="输入房间号（如 ABC123）"
                />
              </div>

              <div className="formRow">
                <div className="seg">
                  <button className={`segBtn ${team === "A" ? "segOn" : ""}`} onClick={() => setTeam("A")} type="button">
                    A（选行）
                  </button>
                  <button className={`segBtn ${team === "B" ? "segOn" : ""}`} onClick={() => setTeam("B")} type="button">
                    B（选列）
                  </button>
                </div>
                <button className="btn" onClick={onJoin} disabled={!connected}>加入</button>
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
            </div>
            <div className="modalActions">
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

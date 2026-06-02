import { useEffect, useMemo, useRef, useState } from "react";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { io, Socket } from "socket.io-client";

const CLIENT_ID = "1508095762242994317";
const SOCKET_URL = "";
const isDiscordActivity = window.location.search.includes("frame_id");
const discordSdk = isDiscordActivity ? new DiscordSDK(CLIENT_ID) : null;

type Side = "red" | "blue" | "green";
type GameStatus = "lobby" | "playing" | "finished";
type PieceName = "歩" | "と" | "騎" | "角" | "飛" | "王";
type Coord = { q: number; r: number };
type Piece = { side: Side; name: PieceName; promoted?: boolean };
type Cell = Coord & { key: string };
type BoardMap = Record<string, Piece | null>;

type Participant = {
  id: string;
  username?: string;
  global_name?: string;
  avatar?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
};

type Teams = Record<Side, Participant[]>;

type MoveRecord = {
  moveNumber: number;
  side: Side;
  playerName: string;
  text: string;
};

type SyncState = {
  gameStatus: GameStatus;
  board: BoardMap;
  teams: Teams;
  moveCount: number;
  hostId: string | null;
  message: string;
  moveHistory: MoveRecord[];
  aliveSides: Side[];
};

const SIDES: Side[] = ["red", "blue", "green"];

const SIDE_LABEL: Record<Side, string> = {
  red: "赤軍",
  blue: "青軍",
  green: "緑軍",
};

const SIDE_COLOR: Record<Side, string> = {
  red: "#ff7b72",
  blue: "#79c0ff",
  green: "#7ee787",
};

// axial hex directions: E, NE, NW, W, SW, SE
const DIRS: Coord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

// 各軍の「前」。赤は下、青は右上、緑は左上へ向かう想定。
const FORWARD_DIR_INDEX: Record<Side, number> = {
  red: 5,
  blue: 1,
  green: 3,
};

function keyOf(c: Coord) {
  return `${c.q},${c.r}`;
}

function add(a: Coord, b: Coord, scale = 1): Coord {
  return { q: a.q + b.q * scale, r: a.r + b.r * scale };
}

function sameCoord(a: Coord, b: Coord) {
  return a.q === b.q && a.r === b.r;
}

function createCells(radius = 4): Cell[] {
  const cells: Cell[] = [];

  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      const s = -q - r;
      if (Math.abs(s) <= radius) {
        cells.push({ q, r, key: keyOf({ q, r }) });
      }
    }
  }

  return cells;
}

const CELLS = createCells(4);
const CELL_SET = new Set(CELLS.map((c) => c.key));

function isInside(c: Coord) {
  return CELL_SET.has(keyOf(c));
}

function createEmptyBoard(): BoardMap {
  return Object.fromEntries(CELLS.map((c) => [c.key, null]));
}

function cloneBoard(board: BoardMap): BoardMap {
  return JSON.parse(JSON.stringify(board));
}

function put(board: BoardMap, q: number, r: number, piece: Piece) {
  board[keyOf({ q, r })] = piece;
}

function createInitialBoard(): BoardMap {
  const board = createEmptyBoard();

  // 初期配置は暫定です。公式PDFの盤面図に合わせて後で座標だけ調整してください。
  put(board, 0, -4, { side: "red", name: "王" });
  put(board, -1, -3, { side: "red", name: "角" });
  put(board, 1, -3, { side: "red", name: "飛" });
  put(board, 0, -3, { side: "red", name: "騎" });
  put(board, -1, -2, { side: "red", name: "歩" });
  put(board, 0, -2, { side: "red", name: "歩" });
  put(board, 1, -2, { side: "red", name: "歩" });

  put(board, -4, 0, { side: "blue", name: "王" });
  put(board, -3, 1, { side: "blue", name: "角" });
  put(board, -3, -1, { side: "blue", name: "飛" });
  put(board, -3, 0, { side: "blue", name: "騎" });
  put(board, -2, -1, { side: "blue", name: "歩" });
  put(board, -2, 0, { side: "blue", name: "歩" });
  put(board, -2, 1, { side: "blue", name: "歩" });

  put(board, 4, 0, { side: "green", name: "王" });
  put(board, 3, -1, { side: "green", name: "角" });
  put(board, 3, 1, { side: "green", name: "飛" });
  put(board, 3, 0, { side: "green", name: "騎" });
  put(board, 2, -1, { side: "green", name: "歩" });
  put(board, 2, 0, { side: "green", name: "歩" });
  put(board, 2, 1, { side: "green", name: "歩" });

  return board;
}

function getDisplayName(user: Participant | null | undefined) {
  if (!user) return "未参加";
  return user.global_name || user.username || `user-${user.id}`;
}

function nextSide(current: Side, aliveSides: Side[]) {
  const start = SIDES.indexOf(current);

  for (let i = 1; i <= SIDES.length; i++) {
    const candidate = SIDES[(start + i) % SIDES.length];
    if (aliveSides.includes(candidate)) return candidate;
  }

  return current;
}

function getTurnSide(moveCount: number, aliveSides: Side[]) {
  const alive = aliveSides.length ? aliveSides : SIDES;
  let side: Side = "red";

  for (let i = 0; i < moveCount; i++) {
    side = nextSide(side, alive);
  }

  return side;
}

function getForward(side: Side) {
  return DIRS[FORWARD_DIR_INDEX[side]];
}

function getRelativeDirs(side: Side) {
  const f = FORWARD_DIR_INDEX[side];

  return {
    forward: DIRS[f],
    back: DIRS[(f + 3) % 6],
    left: DIRS[(f + 2) % 6],
    right: DIRS[(f + 4) % 6],
    forwardLeft: DIRS[(f + 1) % 6],
    forwardRight: DIRS[(f + 5) % 6],
  };
}

function coordDiff(from: Coord, to: Coord): Coord {
  return { q: to.q - from.q, r: to.r - from.r };
}

function isSameDirection(diff: Coord, dir: Coord) {
  if (dir.q === 0 && diff.q !== 0) return false;
  if (dir.r === 0 && diff.r !== 0) return false;

  let k: number | null = null;

  if (dir.q !== 0) {
    k = diff.q / dir.q;
  } else if (dir.r !== 0) {
    k = diff.r / dir.r;
  }

  if (k === null) return false;
  if (!Number.isInteger(k) || k <= 0) return false;

  return (
    (dir.q === 0 || diff.q === dir.q * k) &&
    (dir.r === 0 || diff.r === dir.r * k)
  );
}

function stepCount(diff: Coord, dir: Coord) {
  if (!isSameDirection(diff, dir)) return 0;

  return Math.max(
    Math.abs(dir.q ? diff.q / dir.q : 0),
    Math.abs(dir.r ? diff.r / dir.r : 0)
  );
}

function isPathClear(
  board: BoardMap,
  from: Coord,
  to: Coord,
  dir: Coord,
  jumpEveryOther = false
) {
  const n = stepCount(coordDiff(from, to), dir);
  if (n <= 1) return true;

  for (let i = 1; i < n; i++) {
    if (jumpEveryOther && i % 2 === 1) continue;

    const mid = add(from, dir, i);
    if (board[keyOf(mid)]) return false;
  }

  return true;
}

function isLegalMove(board: BoardMap, piece: Piece, from: Coord, to: Coord) {
  if (!isInside(to)) return false;
  if (sameCoord(from, to)) return false;

  const target = board[keyOf(to)];
  if (target?.side === piece.side) return false;

  const diff = coordDiff(from, to);
  const abs = Math.max(
    Math.abs(diff.q),
    Math.abs(diff.r),
    Math.abs(-diff.q - diff.r)
  );
  const rel = getRelativeDirs(piece.side);

  if (piece.name === "王") return abs === 1;
  if (piece.name === "と") return abs === 1;
  if (piece.name === "歩") return sameCoord(diff, getForward(piece.side));

  // 騎: 暫定ナイト。前方2マス＋左右1マス相当のジャンプ。間の駒は無視。
  if (piece.name === "騎") {
    const candidates = [
      add(add({ q: 0, r: 0 }, rel.forward, 2), rel.forwardLeft, 1),
      add(add({ q: 0, r: 0 }, rel.forward, 2), rel.forwardRight, 1),
      add(add({ q: 0, r: 0 }, rel.back, 2), rel.left, 1),
      add(add({ q: 0, r: 0 }, rel.back, 2), rel.right, 1),
    ];

    return candidates.some((c) => sameCoord(c, diff));
  }

  // 角: 三国志三人将棋の騎兵相当として、六方向に何マスでも進める暫定実装。
  if (piece.name === "角") {
    return DIRS.some(
      (dir) =>
        isSameDirection(diff, dir) &&
        isPathClear(board, from, to, dir)
    );
  }

  // 飛: 横方向は何マスでも。前後方向は1マス飛びずつ何マスでも。
  if (piece.name === "飛") {
    const sideDirs = [rel.left, rel.right];
    const frontBackDirs = [rel.forward, rel.back];

    if (
      sideDirs.some(
        (dir) =>
          isSameDirection(diff, dir) &&
          isPathClear(board, from, to, dir)
      )
    ) {
      return true;
    }

    return frontBackDirs.some((dir) => {
      const n = stepCount(diff, dir);
      return (
        n >= 2 &&
        n % 2 === 0 &&
        isPathClear(board, from, to, dir, true)
      );
    });
  }

  return false;
}

function shouldPromote(piece: Piece, to: Coord) {
  if (piece.name !== "歩") return false;

  // 中央または敵陣深部に入ったら成る暫定処理。
  if (to.q === 0 && to.r === 0) return true;
  if (piece.side === "red" && to.r >= 2) return true;
  if (piece.side === "blue" && to.q >= 2) return true;
  if (piece.side === "green" && to.q <= -2) return true;

  return false;
}

function getCellPixel(c: Coord) {
  const size = 38;
  const x = size * Math.sqrt(3) * (c.q + c.r / 2);
  const y = size * 1.5 * c.r;

  return { x: x + 310, y: y + 310 };
}

export default function ThreeShogiApp() {
  const socketRef = useRef<Socket | null>(null);
  const roomIdRef = useRef("local-three-shogi-room");

  const [status, setStatus] = useState("起動中...");
  const [socketStatus, setSocketStatus] = useState("Socket未接続");
  const [currentUser, setCurrentUser] = useState<Participant | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [gameStatus, setGameStatus] = useState<GameStatus>("lobby");
  const [teams, setTeams] = useState<Teams>({ red: [], blue: [], green: [] });
  const [board, setBoard] = useState<BoardMap>(createInitialBoard());
  const [selected, setSelected] = useState<Coord | null>(null);
  const [moveCount, setMoveCount] = useState(0);
  const [message, setMessage] = useState(
    "三人将棋のテスト版です。まずは3軍に参加して開始してください。"
  );
  const [moveHistory, setMoveHistory] = useState<MoveRecord[]>([]);
  const [aliveSides, setAliveSides] = useState<Side[]>(SIDES);
  const [freeMoveMode, setFreeMoveMode] = useState(false);

  const isHost = !!currentUser && currentUser.id === hostId;

  const turnSide = useMemo(
    () => getTurnSide(moveCount, aliveSides),
    [moveCount, aliveSides]
  );

  const mySide = useMemo(() => {
    if (!currentUser) return null;

    return (
      SIDES.find((side) =>
        teams[side].some((u) => u.id === currentUser.id)
      ) ?? null
    );
  }, [currentUser, teams]);

  function emitSync(next: Partial<SyncState>) {
    const state: SyncState = {
      gameStatus,
      board,
      teams,
      moveCount,
      hostId,
      message,
      moveHistory,
      aliveSides,
      ...next,
    };

    socketRef.current?.emit("game-state", {
      roomId: roomIdRef.current,
      state,
    });
  }

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketStatus("Socket接続中");
      socket.emit("join-room", roomIdRef.current);
    });

    socket.on("connect_error", () => {
      setSocketStatus("Socketエラー");
    });

    socket.on("room-users", (ids: string[]) => {
    });

    socket.on("game-state", (state: SyncState) => {
      if (!state) return;

      setGameStatus(state.gameStatus);
      setBoard(state.board);
      setTeams(state.teams);
      setMoveCount(state.moveCount);
      setHostId(state.hostId);
      setMessage(state.message);
      setMoveHistory(state.moveHistory ?? []);
      setAliveSides(state.aliveSides ?? SIDES);
    });

    async function boot() {
      if (!discordSdk) {
        const localUser: Participant = {
          id: "local-user",
          username: "local-user",
        };

        setCurrentUser(localUser);
        setHostId(localUser.id);
        setStatus("ローカル起動中");

        socket.emit("register-user", {
          roomId: roomIdRef.current,
          userId: localUser.id,
        });

        return;
      }

      await discordSdk.ready();

      const { code } = await discordSdk.commands.authorize({
        client_id: CLIENT_ID,
        response_type: "code",
        state: "",
        prompt: "none",
        scope: ["identify", "guilds", "rpc.activities.write"],
      });

      const response = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      const { access_token } = await response.json();
      const auth = await discordSdk.commands.authenticate({ access_token });
      const me = auth.user as Participant;

      setCurrentUser(me);
      setHostId((prev) => prev ?? me.id);
      setStatus("Discord Activity起動中");

      socket.emit("register-user", {
        roomId: roomIdRef.current,
        userId: me.id,
      });
    }

    boot().catch((e) => {
      console.error(e);
      setStatus("起動エラー");
    });

    return () => {
        socket.disconnect();
  };}, []);

  function joinSide(side: Side) {
    if (!currentUser || gameStatus !== "lobby") return;

    const nextTeams: Teams = { red: [], blue: [], green: [] };

    for (const s of SIDES) {
      nextTeams[s] = teams[s].filter((u) => u.id !== currentUser.id);
    }

    nextTeams[side] = [...nextTeams[side], currentUser];

    const nextMessage = `${getDisplayName(currentUser)} が${SIDE_LABEL[side]}に参加しました。`;

    setTeams(nextTeams);
    setMessage(nextMessage);

    emitSync({
      teams: nextTeams,
      message: nextMessage,
    });
  }

  function resetGame() {
    if (!isHost) return;

    const nextBoard = createInitialBoard();
    const nextMessage = "盤面を初期化しました。";

    setGameStatus("lobby");
    setBoard(nextBoard);
    setSelected(null);
    setMoveCount(0);
    setMoveHistory([]);
    setAliveSides(SIDES);
    setMessage(nextMessage);

    emitSync({
      gameStatus: "lobby",
      board: nextBoard,
      moveCount: 0,
      moveHistory: [],
      aliveSides: SIDES,
      message: nextMessage,
    });
  }

  function startGame() {
    if (!isHost) return;

    const joined = SIDES.filter((s) => teams[s].length > 0);

    if (joined.length < 3) {
      setMessage("3軍すべてに最低1人ずつ参加してから開始してください。");
      return;
    }

    const nextBoard = createInitialBoard();

    setGameStatus("playing");
    setBoard(nextBoard);
    setSelected(null);
    setMoveCount(0);
    setMoveHistory([]);
    setAliveSides(SIDES);
    setMessage("対局開始。赤軍の手番です。");

    emitSync({
      gameStatus: "playing",
      board: nextBoard,
      moveCount: 0,
      moveHistory: [],
      aliveSides: SIDES,
      message: "対局開始。赤軍の手番です。",
    });
  }

  function eliminateSide(side: Side, nextAlive: Side[]) {
    if (nextAlive.length === 1) {
      const winner = nextAlive[0];
      return `${SIDE_LABEL[side]}の王を取りました。${SIDE_LABEL[winner]}の勝利です。`;
    }

    return `${SIDE_LABEL[side]}の王を取りました。${SIDE_LABEL[side]}は脱落です。`;
  }

  function onCellClick(cell: Cell) {
    if (gameStatus !== "playing") return;

    const piece = board[cell.key];

    if (!freeMoveMode) {
      if (!mySide) {
        setMessage("先にどこかの軍に参加してください。");
        return;
      }

      if (mySide !== turnSide) {
        setMessage(`今は${SIDE_LABEL[turnSide]}の手番です。`);
        return;
      }
    }

    if (!selected) {
      if (!piece) return;

      if (!freeMoveMode && piece.side !== turnSide) {
        setMessage(`今は${SIDE_LABEL[turnSide]}の駒だけ動かせます。`);
        return;
      }

      setSelected(cell);
      setMessage(`${SIDE_LABEL[piece.side]}の${piece.name}を選択しました。`);
      return;
    }

    const fromPiece = board[keyOf(selected)];

    if (!fromPiece) {
      setSelected(null);
      return;
    }

    if (piece?.side === fromPiece.side) {
      setSelected(cell);
      setMessage(`${SIDE_LABEL[piece.side]}の${piece.name}を選択しました。`);
      return;
    }

    if (!isLegalMove(board, fromPiece, selected, cell)) {
      setMessage("その動きはできません。駒の動きを確認してください。");
      return;
    }

    const nextBoard = cloneBoard(board);
    const captured = nextBoard[cell.key];

    const movedPiece: Piece = shouldPromote(fromPiece, cell)
      ? { ...fromPiece, name: "と", promoted: true }
      : fromPiece;

    nextBoard[keyOf(selected)] = null;
    nextBoard[cell.key] = movedPiece;

    let nextAlive = aliveSides;
    let nextStatus: GameStatus = "playing";
    let resultText = "";

    if (captured?.name === "王") {
      nextAlive = aliveSides.filter((s) => s !== captured.side);
      resultText = eliminateSide(captured.side, nextAlive);

      if (nextAlive.length === 1) {
        nextStatus = "finished";
      }
    }

    const nextMoveCount = moveCount + 1;

    const movedText = `${SIDE_LABEL[fromPiece.side]} ${fromPiece.name}${
      captured ? `x${captured.name}` : ""
    } (${selected.q},${selected.r})→(${cell.q},${cell.r})`;

    const nextHistory = [
      ...moveHistory,
      {
        moveNumber: nextMoveCount,
        side: fromPiece.side,
        playerName: getDisplayName(currentUser),
        text: movedText,
      },
    ];

    const followingSide =
      nextStatus === "finished"
        ? fromPiece.side
        : getTurnSide(nextMoveCount, nextAlive);

    const nextMessage =
      resultText ||
      `${movedText}。次は${SIDE_LABEL[followingSide]}の手番です。`;

    setBoard(nextBoard);
    setSelected(null);
    setMoveCount(nextMoveCount);
    setMoveHistory(nextHistory);
    setAliveSides(nextAlive);
    setGameStatus(nextStatus);
    setMessage(nextMessage);

    emitSync({
      board: nextBoard,
      moveCount: nextMoveCount,
      moveHistory: nextHistory,
      aliveSides: nextAlive,
      gameStatus: nextStatus,
      message: nextMessage,
    });
  }

  const boardSize = 640;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0d1117",
        color: "#f0f6fc",
        padding: 18,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>三人将棋 テスト版</h1>
          <div style={{ color: "#8b949e", fontSize: 13 }}>
            {status} / {socketStatus}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isHost && (
            <button onClick={startGame} style={buttonStyle("#238636")}>
              対局開始
            </button>
          )}

          {isHost && (
            <button onClick={resetGame} style={buttonStyle("#30363d")}>
              初期化
            </button>
          )}

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              checked={freeMoveMode}
              onChange={(e) => setFreeMoveMode(e.target.checked)}
            />
            テスト自由移動
          </label>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "260px 1fr 300px",
          gap: 16,
          alignItems: "start",
        }}
      >
        <aside style={panelStyle}>
          <h2 style={h2Style}>参加</h2>

          <div style={{ marginBottom: 8, color: "#8b949e", fontSize: 13 }}>
            あなた: {getDisplayName(currentUser)}
          </div>

          {SIDES.map((side) => (
            <div
              key={side}
              style={{
                border: `1px solid ${SIDE_COLOR[side]}`,
                borderRadius: 10,
                padding: 10,
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  color: SIDE_COLOR[side],
                  fontWeight: 800,
                  marginBottom: 6,
                }}
              >
                {SIDE_LABEL[side]}
              </div>

              <div style={{ minHeight: 24, fontSize: 13 }}>
                {teams[side].map(getDisplayName).join(" / ") || "未参加"}
              </div>

              <button
                disabled={gameStatus !== "lobby"}
                onClick={() => joinSide(side)}
                style={buttonStyle(SIDE_COLOR[side], true)}
              >
                この軍に入る
              </button>
            </div>
          ))}

          <div style={{ color: "#8b949e", fontSize: 12, lineHeight: 1.6 }}>
            ※ 騎・角の動きと初期配置は暫定です。公式盤面に合わせて座標だけ差し替えられるようにしています。
          </div>
        </aside>

        <main
          style={{
            ...panelStyle,
            display: "flex",
            justifyContent: "center",
            overflow: "auto",
          }}
        >
          <div style={{ position: "relative", width: boardSize, height: boardSize }}>
            {CELLS.map((cell) => {
              const p = getCellPixel(cell);
              const piece = board[cell.key];
              const isSelected =
                selected && selected.q === cell.q && selected.r === cell.r;

              return (
                <button
                  key={cell.key}
                  onClick={() => onCellClick(cell)}
                  title={`${cell.q},${cell.r}`}
                  style={{
                    position: "absolute",
                    left: p.x - 31,
                    top: p.y - 31,
                    width: 62,
                    height: 62,
                    clipPath:
                      "polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0% 50%)",
                    border: isSelected
                      ? "3px solid #f2cc60"
                      : "1px solid #30363d",
                    background: piece ? "#f0e0b6" : "#161b22",
                    color: piece ? "#0d1117" : "#8b949e",
                    cursor: "pointer",
                    fontWeight: 900,
                    fontSize: 20,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {piece ? (
                    <>
                      <span style={{ color: SIDE_COLOR[piece.side], fontSize: 11 }}>
                        {SIDE_LABEL[piece.side].slice(0, 1)}
                      </span>
                      <span>{piece.name}</span>
                    </>
                  ) : (
                    <span style={{ fontSize: 10 }}>
                      {cell.q},{cell.r}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </main>

        <aside style={panelStyle}>
          <h2 style={h2Style}>状態</h2>

          <div style={{ marginBottom: 8 }}>
            状態: <b>{gameStatus}</b>
          </div>

          <div style={{ marginBottom: 8 }}>
            手番:{" "}
            <b style={{ color: SIDE_COLOR[turnSide] }}>{SIDE_LABEL[turnSide]}</b>
          </div>

          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "#161b22",
              marginBottom: 12,
              lineHeight: 1.6,
            }}
          >
            {message}
          </div>

          <h2 style={h2Style}>棋譜</h2>

          <div style={{ maxHeight: 360, overflow: "auto", fontSize: 13, lineHeight: 1.7 }}>
            {moveHistory.length === 0 ? (
              <div style={{ color: "#8b949e" }}>まだ指し手はありません。</div>
            ) : (
              moveHistory
                .slice()
                .reverse()
                .map((m) => (
                  <div
                    key={m.moveNumber}
                    style={{
                      borderBottom: "1px solid #30363d",
                      padding: "5px 0",
                    }}
                  >
                    {m.moveNumber}.{" "}
                    <span style={{ color: SIDE_COLOR[m.side] }}>
                      {SIDE_LABEL[m.side]}
                    </span>{" "}
                    {m.text}
                  </div>
                ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function buttonStyle(bg: string, darkText = false): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 8,
    padding: "8px 12px",
    marginTop: 8,
    background: bg,
    color: darkText ? "#0d1117" : "white",
    fontWeight: 700,
    cursor: "pointer",
  };
}

const panelStyle: React.CSSProperties = {
  background: "#010409",
  border: "1px solid #30363d",
  borderRadius: 14,
  padding: 14,
};

const h2Style: React.CSSProperties = {
  fontSize: 16,
  margin: "0 0 10px",
};
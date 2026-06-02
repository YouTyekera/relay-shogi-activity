import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { io, Socket } from "socket.io-client";

const CLIENT_ID = "1508095762242994317";
const SOCKET_URL = "";

const isDiscordActivity = window.location.search.includes("frame_id");
const discordSdk = isDiscordActivity ? new DiscordSDK(CLIENT_ID) : null;

type Side = "red" | "blue" | "green";
type GameStatus = "lobby" | "playing" | "finished";
type PieceName = "歩" | "と" | "騎" | "角" | "飛" | "王";

type Coord = {
  q: number;
  r: number;
};

type Cell = Coord & {
  key: string;
};

type Piece = {
  side: Side;
  name: PieceName;
  promoted?: boolean;
};

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
  currentTurn: Side;
  moveNumber: number;
  hostId: string | null;
  message: string;
  moveHistory: MoveRecord[];
  aliveSides: Side[];
  pendingReturnSide: Side | null;
};

const SIDES: Side[] = ["red", "blue", "green"];

const SIDE_LABEL: Record<Side, string> = {
  red: "赤軍",
  blue: "青軍",
  green: "緑軍",
};

const SIDE_SHORT: Record<Side, string> = {
  red: "赤",
  blue: "青",
  green: "緑",
};

const SIDE_COLOR: Record<Side, string> = {
  red: "#ff7b72",
  blue: "#58a6ff",
  green: "#7ee787",
};

// 画面上の6方向
// 0:右 / 1:右上 / 2:左上 / 3:左 / 4:左下 / 5:右下
const DIRS: Coord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

const BOARD_RADIUS = 4;
const CENTER_KEY = "0,0";

function keyOf(c: Coord) {
  return `${c.q},${c.r}`;
}

function add(a: Coord, b: Coord, scale = 1): Coord {
  return {
    q: a.q + b.q * scale,
    r: a.r + b.r * scale,
  };
}

function sameCoord(a: Coord, b: Coord) {
  return a.q === b.q && a.r === b.r;
}

function createCells(radius = BOARD_RADIUS): Cell[] {
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

const CELLS = createCells();
const CELL_SET = new Set(CELLS.map((c) => c.key));

function isInside(c: Coord) {
  return CELL_SET.has(keyOf(c));
}

function createEmptyBoard(): BoardMap {
  return Object.fromEntries(CELLS.map((c) => [c.key, null]));
}

function cloneBoard(board: BoardMap): BoardMap {
  const next: BoardMap = {};

  for (const key of Object.keys(board)) {
    const p = board[key];
    next[key] = p ? { ...p } : null;
  }

  return next;
}

function put(board: BoardMap, q: number, r: number, piece: Piece) {
  const key = keyOf({ q, r });
  if (CELL_SET.has(key)) board[key] = piece;
}

function createInitialBoard(): BoardMap {
  const board = createEmptyBoard();

  // =====================================================
  // 赤軍：下の辺
  // 奥列 r=4 / 前列 r=3
  // 赤軍は下から中央を見る。
  // 王から見て左が角、右が飛。
  // =====================================================
  put(board, -4, 4, { side: "red", name: "騎" });
  put(board, -3, 4, { side: "red", name: "角" });
  put(board, -2, 4, { side: "red", name: "王" });
  put(board, -1, 4, { side: "red", name: "飛" });
  put(board, 0, 4, { side: "red", name: "騎" });

  put(board, -4, 3, { side: "red", name: "歩" });
  put(board, -3, 3, { side: "red", name: "歩" });
  put(board, -2, 3, { side: "red", name: "歩" });
  put(board, -1, 3, { side: "red", name: "歩" });
  put(board, 0, 3, { side: "red", name: "歩" });
  put(board, 1, 3, { side: "red", name: "歩" });

  // =====================================================
  // 青軍：右上の辺
  // 奥列 q=4 / 前列 q=3
  // 青軍は右上から中央を見る。
  // 王から見て左が角、右が飛になるように配置。
  // =====================================================
  put(board, 4, -4, { side: "blue", name: "騎" });
  put(board, 4, -3, { side: "blue", name: "飛" });
  put(board, 4, -2, { side: "blue", name: "王" });
  put(board, 4, -1, { side: "blue", name: "角" });
  put(board, 4, 0, { side: "blue", name: "騎" });

  put(board, 3, -4, { side: "blue", name: "歩" });
  put(board, 3, -3, { side: "blue", name: "歩" });
  put(board, 3, -2, { side: "blue", name: "歩" });
  put(board, 3, -1, { side: "blue", name: "歩" });
  put(board, 3, 0, { side: "blue", name: "歩" });
  put(board, 3, 1, { side: "blue", name: "歩" });

  // =====================================================
  // 緑軍：左上の辺
  // 奥列 q+r=-4 / 前列 q+r=-3
  // 緑軍は左上から中央を見る。
  // 王から見て左が角、右が飛になるように配置。
  // =====================================================
  put(board, -4, 0, { side: "green", name: "騎" });
  put(board, -3, -1, { side: "green", name: "飛" });
  put(board, -2, -2, { side: "green", name: "王" });
  put(board, -1, -3, { side: "green", name: "角" });
  put(board, 0, -4, { side: "green", name: "騎" });

  put(board, -4, 1, { side: "green", name: "歩" });
  put(board, -3, 0, { side: "green", name: "歩" });
  put(board, -2, -1, { side: "green", name: "歩" });
  put(board, -1, -2, { side: "green", name: "歩" });
  put(board, 0, -3, { side: "green", name: "歩" });
  put(board, 1, -4, { side: "green", name: "歩" });

  return board;
}

function getDisplayName(user: Participant | null | undefined) {
  if (!user) return "未参加";
  return user.global_name || user.username || `user-${user.id}`;
}

function getSideAxisDirs(side: Side) {
  if (side === "red") return [DIRS[0], DIRS[3]];
  if (side === "blue") return [DIRS[2], DIRS[5]];
  return [DIRS[1], DIRS[4]];
}

function getPawnForwardDirs(side: Side) {
  if (side === "red") return [DIRS[1], DIRS[2]];
  if (side === "blue") return [DIRS[3], DIRS[4]];
  return [DIRS[0], DIRS[5]];
}

function getBackDirs(side: Side) {
  return getPawnForwardDirs(side).map((dir) => ({
    q: -dir.q,
    r: -dir.r,
  }));
}

function getDiagonalDirs(side: Side) {
  const axis = getSideAxisDirs(side);
  return DIRS.filter(
    (dir) => !sameCoord(dir, axis[0]) && !sameCoord(dir, axis[1])
  );
}

function coordDiff(from: Coord, to: Coord): Coord {
  return {
    q: to.q - from.q,
    r: to.r - from.r,
  };
}

function hexDistance(a: Coord, b: Coord) {
  const diff = coordDiff(a, b);
  return Math.max(
    Math.abs(diff.q),
    Math.abs(diff.r),
    Math.abs(-diff.q - diff.r)
  );
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
  if (dir.q !== 0) return Math.abs(diff.q / dir.q);
  if (dir.r !== 0) return Math.abs(diff.r / dir.r);
  return 0;
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

function isLegalPieceMove(
  board: BoardMap,
  piece: Piece,
  from: Coord,
  to: Coord
) {
  if (!isInside(to)) return false;
  if (sameCoord(from, to)) return false;

  const target = board[keyOf(to)];
  if (target?.side === piece.side) return false;

  const diff = coordDiff(from, to);
  const distance = hexDistance(from, to);

  if (piece.name === "王") {
    return distance === 1;
  }

  if (piece.name === "と") {
    return distance === 1;
  }

  // 歩：その軍から見て前斜め2方向に1マス
  if (piece.name === "歩") {
    return getPawnForwardDirs(piece.side).some((dir) => sameCoord(diff, dir));
  }

  // 騎：旧「弓兵」。6方向に2マスジャンプ
  if (piece.name === "騎") {
    return DIRS.some((dir) => sameCoord(diff, add({ q: 0, r: 0 }, dir, 2)));
  }

  // 角：旧「騎兵」。その軍から見て斜め4方向に何マスでも
  if (piece.name === "角") {
    return getDiagonalDirs(piece.side).some(
      (dir) => isSameDirection(diff, dir) && isPathClear(board, from, to, dir)
    );
  }

  // 飛：その軍から見て横に何マスでも、前後方向は1マス飛びずつ何マスでも
  if (piece.name === "飛") {
    const sideAxisDirs = getSideAxisDirs(piece.side);
    const forwardBackDirs = [
      ...getPawnForwardDirs(piece.side),
      ...getBackDirs(piece.side),
    ];

    if (
      sideAxisDirs.some(
        (dir) => isSameDirection(diff, dir) && isPathClear(board, from, to, dir)
      )
    ) {
      return true;
    }

    return forwardBackDirs.some((dir) => {
      const n = stepCount(diff, dir);
      return n >= 2 && n % 2 === 0 && isPathClear(board, from, to, dir, true);
    });
  }

  return false;
}

function shouldPromote(piece: Piece, to: Coord) {
  if (piece.name !== "歩") return false;

  if (keyOf(to) === CENTER_KEY) return true;

  if (piece.side === "red" && to.r <= -2) return true;
  if (piece.side === "blue" && to.q <= -2) return true;

  const s = -to.q - to.r;
  if (piece.side === "green" && s <= -2) return true;

  return false;
}

function findKing(board: BoardMap, side: Side): Coord | null {
  for (const cell of CELLS) {
    const p = board[cell.key];
    if (p?.side === side && p.name === "王") {
      return { q: cell.q, r: cell.r };
    }
  }

  return null;
}

function isSideInCheck(board: BoardMap, side: Side, aliveSides: Side[]) {
  const king = findKing(board, side);
  if (!king) return false;

  for (const cell of CELLS) {
    const p = board[cell.key];
    if (!p) continue;
    if (p.side === side) continue;
    if (!aliveSides.includes(p.side)) continue;

    if (isLegalPieceMove(board, p, cell, king)) {
      return true;
    }
  }

  return false;
}

function simulateMove(board: BoardMap, from: Coord, to: Coord) {
  const next = cloneBoard(board);
  const moving = next[keyOf(from)];
  if (!moving) return next;

  next[keyOf(from)] = null;
  next[keyOf(to)] = shouldPromote(moving, to)
    ? { ...moving, name: "と", promoted: true }
    : moving;

  return next;
}

function isLegalMoveConsideringCheck(
  board: BoardMap,
  piece: Piece,
  from: Coord,
  to: Coord,
  aliveSides: Side[]
) {
  if (!isLegalPieceMove(board, piece, from, to)) return false;

  if (piece.name === "王" && keyOf(to) === CENTER_KEY) {
    return true;
  }

  const next = simulateMove(board, from, to);
  return !isSideInCheck(next, piece.side, aliveSides);
}

function getLegalDestinations(board: BoardMap, from: Coord, aliveSides: Side[]) {
  const piece = board[keyOf(from)];
  if (!piece) return [];

  return CELLS.filter((cell) =>
    isLegalMoveConsideringCheck(board, piece, from, cell, aliveSides)
  );
}

function hasAnyLegalMove(board: BoardMap, side: Side, aliveSides: Side[]) {
  for (const cell of CELLS) {
    const p = board[cell.key];
    if (!p || p.side !== side) continue;

    if (getLegalDestinations(board, cell, aliveSides).length > 0) {
      return true;
    }
  }

  return false;
}

function removeSidePieces(board: BoardMap, side: Side) {
  const next = cloneBoard(board);

  for (const key of Object.keys(next)) {
    if (next[key]?.side === side) {
      next[key] = null;
    }
  }

  return next;
}

function nextNormalSide(from: Side, aliveSides: Side[]) {
  const start = SIDES.indexOf(from);

  for (let i = 1; i <= SIDES.length; i++) {
    const candidate = SIDES[(start + i) % SIDES.length];
    if (aliveSides.includes(candidate)) return candidate;
  }

  return from;
}

function firstCheckedSideBy(board: BoardMap, attacker: Side, aliveSides: Side[]) {
  for (const side of SIDES) {
    if (side === attacker) continue;
    if (!aliveSides.includes(side)) continue;

    if (isSideInCheck(board, side, aliveSides)) {
      return side;
    }
  }

  return null;
}

function getCellPixel(c: Coord) {
  const size = 36;
  const x = size * Math.sqrt(3) * (c.q + c.r / 2);
  const y = size * 1.5 * c.r;

  return {
    x: x + 330,
    y: y + 330,
  };
}

function getMoveMarkForPiece(piece: Piece) {
  if (piece.name === "角") return "↗";
  if (piece.name === "飛") return "➜";
  return "●";
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
  const [currentTurn, setCurrentTurn] = useState<Side>("red");
  const [moveNumber, setMoveNumber] = useState(0);
  const [message, setMessage] = useState(
    "三人将棋ベータ版です。まずは軍に参加してください。"
  );
  const [moveHistory, setMoveHistory] = useState<MoveRecord[]>([]);
  const [aliveSides, setAliveSides] = useState<Side[]>(SIDES);
  const [pendingReturnSide, setPendingReturnSide] = useState<Side | null>(null);
  const [freeMoveMode, setFreeMoveMode] = useState(true);

  const isHost = !!currentUser && currentUser.id === hostId;

  const mySide = useMemo(() => {
    if (!currentUser) return null;

    return (
      SIDES.find((side) =>
        teams[side].some((u) => u.id === currentUser.id)
      ) ?? null
    );
  }, [currentUser, teams]);

  const legalDestinations = useMemo(() => {
    if (!selected) return [];
    return getLegalDestinations(board, selected, aliveSides);
  }, [selected, board, aliveSides]);

  const legalDestinationKeys = useMemo(
    () => new Set(legalDestinations.map((c) => c.key)),
    [legalDestinations]
  );

  function emitSync(next: Partial<SyncState>) {
    const state: SyncState = {
      gameStatus,
      board,
      teams,
      currentTurn,
      moveNumber,
      hostId,
      message,
      moveHistory,
      aliveSides,
      pendingReturnSide,
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

    socket.on("game-state", (state: SyncState) => {
      if (!state) return;

      setGameStatus(state.gameStatus);
      setBoard(state.board);
      setTeams(state.teams);
      setCurrentTurn(state.currentTurn);
      setMoveNumber(state.moveNumber);
      setHostId(state.hostId);
      setMessage(state.message);
      setMoveHistory(state.moveHistory ?? []);
      setAliveSides(state.aliveSides ?? SIDES);
      setPendingReturnSide(state.pendingReturnSide ?? null);
      setSelected(null);
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
    };
  }, []);

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

  function joinAllForSoloTest() {
    if (!currentUser || gameStatus !== "lobby") return;

    const nextTeams: Teams = {
      red: [{ ...currentUser, username: "赤軍テスト" }],
      blue: [{ ...currentUser, username: "青軍テスト" }],
      green: [{ ...currentUser, username: "緑軍テスト" }],
    };

    setTeams(nextTeams);
    setFreeMoveMode(true);
    setMessage("一人テスト用に3軍すべてへ参加しました。");

    emitSync({
      teams: nextTeams,
      message: "一人テスト用に3軍すべてへ参加しました。",
    });
  }

  function resetGame() {
    if (!isHost) return;

    const nextBoard = createInitialBoard();

    setGameStatus("lobby");
    setBoard(nextBoard);
    setSelected(null);
    setCurrentTurn("red");
    setMoveNumber(0);
    setMoveHistory([]);
    setAliveSides(SIDES);
    setPendingReturnSide(null);
    setMessage("盤面を初期化しました。");

    emitSync({
      gameStatus: "lobby",
      board: nextBoard,
      currentTurn: "red",
      moveNumber: 0,
      moveHistory: [],
      aliveSides: SIDES,
      pendingReturnSide: null,
      message: "盤面を初期化しました。",
    });
  }

  function startGame() {
    if (!isHost) return;

    const joinedSides = SIDES.filter((s) => teams[s].length > 0);

    if (joinedSides.length < 3 && !freeMoveMode) {
      setMessage("3軍すべてに最低1人ずつ参加してから開始してください。");
      return;
    }

    const nextBoard = createInitialBoard();

    setGameStatus("playing");
    setBoard(nextBoard);
    setSelected(null);
    setCurrentTurn("red");
    setMoveNumber(0);
    setMoveHistory([]);
    setAliveSides(SIDES);
    setPendingReturnSide(null);
    setMessage("対局開始。赤軍の手番です。");

    emitSync({
      gameStatus: "playing",
      board: nextBoard,
      currentTurn: "red",
      moveNumber: 0,
      moveHistory: [],
      aliveSides: SIDES,
      pendingReturnSide: null,
      message: "対局開始。赤軍の手番です。",
    });
  }

  function decideNextTurnAfterMove(
    nextBoard: BoardMap,
    mover: Side,
    currentAlive: Side[],
    currentPendingReturnSide: Side | null
  ) {
    const checkedSide = firstCheckedSideBy(nextBoard, mover, currentAlive);

    if (checkedSide) {
      if (!hasAnyLegalMove(nextBoard, checkedSide, currentAlive)) {
        const aliveAfterMate = currentAlive.filter((s) => s !== checkedSide);
        const boardAfterMate = removeSidePieces(nextBoard, checkedSide);

        if (aliveAfterMate.length === 1) {
          return {
            board: boardAfterMate,
            alive: aliveAfterMate,
            nextTurn: aliveAfterMate[0],
            nextPendingReturnSide: null,
            status: "finished" as GameStatus,
            extraMessage: `${SIDE_LABEL[checkedSide]}は詰みです。${SIDE_LABEL[aliveAfterMate[0]]}の勝利です。`,
          };
        }

        const turnAfterMate = nextNormalSide(checkedSide, aliveAfterMate);

        return {
          board: boardAfterMate,
          alive: aliveAfterMate,
          nextTurn: turnAfterMate,
          nextPendingReturnSide: null,
          status: "playing" as GameStatus,
          extraMessage: `${SIDE_LABEL[checkedSide]}は詰みです。次は${SIDE_LABEL[turnAfterMate]}の手番です。`,
        };
      }

      return {
        board: nextBoard,
        alive: currentAlive,
        nextTurn: checkedSide,
        nextPendingReturnSide: mover,
        status: "playing" as GameStatus,
        extraMessage: `王手！すぐに${SIDE_LABEL[checkedSide]}の手番です。対応後、王手を返さなければ${SIDE_LABEL[mover]}に手番が戻ります。`,
      };
    }

    if (currentPendingReturnSide && currentAlive.includes(currentPendingReturnSide)) {
      return {
        board: nextBoard,
        alive: currentAlive,
        nextTurn: currentPendingReturnSide,
        nextPendingReturnSide: null,
        status: "playing" as GameStatus,
        extraMessage: `${SIDE_LABEL[currentPendingReturnSide]}に手番が戻ります。`,
      };
    }

    const normalNext = nextNormalSide(mover, currentAlive);

    return {
      board: nextBoard,
      alive: currentAlive,
      nextTurn: normalNext,
      nextPendingReturnSide: null,
      status: "playing" as GameStatus,
      extraMessage: `次は${SIDE_LABEL[normalNext]}の手番です。`,
    };
  }

  function onCellClick(cell: Cell) {
    if (gameStatus !== "playing") return;

    const piece = board[cell.key];

    if (!selected) {
      if (!piece) return;

      if (!freeMoveMode) {
        if (!mySide) {
          setMessage("先にどこかの軍に参加してください。");
          return;
        }

        if (mySide !== currentTurn) {
          setMessage(`今は${SIDE_LABEL[currentTurn]}の手番です。`);
          return;
        }

        if (piece.side !== currentTurn) {
          setMessage(`今は${SIDE_LABEL[currentTurn]}の駒だけ動かせます。`);
          return;
        }
      } else if (piece.side !== currentTurn) {
        setMessage(
          `一人テスト中ですが、手番は${SIDE_LABEL[currentTurn]}です。手番の駒を選んでください。`
        );
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

    if (
      !isLegalMoveConsideringCheck(board, fromPiece, selected, cell, aliveSides)
    ) {
      setMessage("その動きはできません。駒の動き、または王手の状態を確認してください。");
      return;
    }

    const captured = board[cell.key];

    let nextBoard = cloneBoard(board);
    const movedPiece: Piece = shouldPromote(fromPiece, cell)
      ? { ...fromPiece, name: "と", promoted: true }
      : fromPiece;

    nextBoard[keyOf(selected)] = null;
    nextBoard[cell.key] = movedPiece;

    let nextAliveSides = [...aliveSides];
    let nextGameStatus: GameStatus = "playing";
    let nextTurn = currentTurn;
    let nextPendingReturnSide: Side | null = pendingReturnSide;

    let resultText = "";

    if (movedPiece.name === "王" && cell.key === CENTER_KEY) {
      nextGameStatus = "finished";
      resultText = `${SIDE_LABEL[fromPiece.side]}の王が中央マスに入りました。${SIDE_LABEL[fromPiece.side]}の勝利です。`;
    } else if (captured?.name === "王") {
      nextAliveSides = aliveSides.filter((s) => s !== captured.side);
      nextBoard = removeSidePieces(nextBoard, captured.side);

      if (nextAliveSides.length === 1) {
        nextGameStatus = "finished";
        resultText = `${SIDE_LABEL[captured.side]}の王を取りました。${SIDE_LABEL[nextAliveSides[0]]}の勝利です。`;
      } else {
        nextTurn = nextNormalSide(captured.side, nextAliveSides);
        nextPendingReturnSide = null;
        resultText = `${SIDE_LABEL[captured.side]}は脱落しました。次は${SIDE_LABEL[nextTurn]}の手番です。`;
      }
    } else {
      const decision = decideNextTurnAfterMove(
        nextBoard,
        fromPiece.side,
        nextAliveSides,
        pendingReturnSide
      );

      nextBoard = decision.board;
      nextAliveSides = decision.alive;
      nextTurn = decision.nextTurn;
      nextPendingReturnSide = decision.nextPendingReturnSide;
      nextGameStatus = decision.status;
      resultText = decision.extraMessage;
    }

    const nextMoveNumber = moveNumber + 1;

    const moveText = `${SIDE_LABEL[fromPiece.side]} ${fromPiece.name}${
      captured ? `x${captured.name}` : ""
    } (${selected.q},${selected.r})→(${cell.q},${cell.r})`;

    const nextHistory: MoveRecord[] = [
      ...moveHistory,
      {
        moveNumber: nextMoveNumber,
        side: fromPiece.side,
        playerName: getDisplayName(currentUser),
        text: moveText,
      },
    ];

    const nextMessage = `${moveText}。${resultText}`;

    setBoard(nextBoard);
    setSelected(null);
    setCurrentTurn(nextTurn);
    setMoveNumber(nextMoveNumber);
    setMoveHistory(nextHistory);
    setAliveSides(nextAliveSides);
    setPendingReturnSide(nextPendingReturnSide);
    setGameStatus(nextGameStatus);
    setMessage(nextMessage);

    emitSync({
      board: nextBoard,
      currentTurn: nextTurn,
      moveNumber: nextMoveNumber,
      moveHistory: nextHistory,
      aliveSides: nextAliveSides,
      pendingReturnSide: nextPendingReturnSide,
      gameStatus: nextGameStatus,
      message: nextMessage,
    });
  }

  const boardSize = 700;

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0 }}>三人将棋 ベータ版</h1>
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

          <label style={checkStyle}>
            <input
              type="checkbox"
              checked={freeMoveMode}
              onChange={(e) => setFreeMoveMode(e.target.checked)}
            />
            一人テスト
          </label>
        </div>
      </header>

      <div style={mainGridStyle}>
        <aside style={panelStyle}>
          <h2 style={h2Style}>ロビー</h2>

          <div style={{ marginBottom: 10, color: "#8b949e", fontSize: 13 }}>
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
                background: "#0d1117",
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

          <button
            disabled={gameStatus !== "lobby"}
            onClick={joinAllForSoloTest}
            style={{
              ...buttonStyle("#f2cc60", true),
              width: "100%",
              marginTop: 4,
            }}
          >
            一人テスト用に3軍参加
          </button>

          <div style={ruleBoxStyle}>
            <b>陣地</b>
            <br />
            左上：緑軍
            <br />
            右上：青軍
            <br />
            下：赤軍
            <br />
            <br />
            <b>勝利条件</b>
            <br />
            ・敵の王を取る
            <br />
            ・自分の王が中央マスに入る
            <br />
            ・最後の1軍になる
          </div>
        </aside>

        <main style={boardPanelStyle}>
          <div style={{ position: "relative", width: boardSize, height: boardSize }}>
            {CELLS.map((cell) => {
              const p = getCellPixel(cell);
              const piece = board[cell.key];
              const isSelected =
                selected && selected.q === cell.q && selected.r === cell.r;
              const isLegalDestination = legalDestinationKeys.has(cell.key);
              const isCenter = cell.key === CENTER_KEY;

              return (
                <button
                  key={cell.key}
                  onClick={() => onCellClick(cell)}
                  title={`${cell.q},${cell.r}`}
                  style={{
                    position: "absolute",
                    left: p.x - 30,
                    top: p.y - 30,
                    width: 60,
                    height: 60,
                    clipPath:
                      "polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0% 50%)",
                    border: isSelected
                      ? "3px solid #f2cc60"
                      : isCenter
                      ? "3px solid #ffdf5d"
                      : isLegalDestination
                      ? "2px solid #58a6ff"
                      : "1px solid #30363d",
                    background: piece
                      ? "#f0e0b6"
                      : isCenter
                      ? "#4b3b10"
                      : isLegalDestination
                      ? "#102a43"
                      : "#161b22",
                    color: piece ? "#0d1117" : "#8b949e",
                    cursor: "pointer",
                    fontWeight: 900,
                    fontSize: 20,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: isCenter
                      ? "0 0 18px rgba(255, 223, 93, 0.6)"
                      : "none",
                  }}
                >
                  {piece ? (
                    <>
                      <span style={{ color: SIDE_COLOR[piece.side], fontSize: 11 }}>
                        {SIDE_SHORT[piece.side]}
                      </span>
                      <span>{piece.name}</span>
                    </>
                  ) : isLegalDestination && selected ? (
                    <span style={{ color: "#58a6ff", fontSize: 20 }}>
                      {getMoveMarkForPiece(board[keyOf(selected)]!)}
                    </span>
                  ) : isCenter ? (
                    <span style={{ color: "#ffdf5d", fontSize: 12 }}>中央</span>
                  ) : (
                    <span style={{ fontSize: 9 }}>
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
            <b style={{ color: SIDE_COLOR[currentTurn] }}>
              {SIDE_LABEL[currentTurn]}
            </b>
          </div>

          {pendingReturnSide && (
            <div style={{ marginBottom: 8, color: "#f2cc60" }}>
              王手対応後、王手を返さなければ
              {SIDE_LABEL[pendingReturnSide]}へ戻ります。
            </div>
          )}

          <div style={messageStyle}>{message}</div>

          <h2 style={h2Style}>駒の動き</h2>
          <div style={ruleBoxStyle}>
            歩：自軍から見て前斜め1マス
            <br />
            と：6方向1マス
            <br />
            騎：6方向に2マスジャンプ
            <br />
            角：自軍から見て斜め4方向に何マスでも
            <br />
            飛：自軍から見て横に何マスでも、前後は1マス飛び
            <br />
            王：6方向1マス
          </div>

          <h2 style={h2Style}>棋譜</h2>

          <div style={{ maxHeight: 250, overflow: "auto", fontSize: 13, lineHeight: 1.7 }}>
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

function buttonStyle(bg: string, darkText = false): CSSProperties {
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

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#0d1117",
  color: "#f0f6fc",
  padding: 18,
  fontFamily: "system-ui, sans-serif",
  boxSizing: "border-box",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 16,
  alignItems: "center",
  marginBottom: 14,
};

const mainGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px minmax(720px, 1fr) 310px",
  gap: 16,
  alignItems: "start",
  overflowX: "auto",
};

const panelStyle: CSSProperties = {
  background: "#010409",
  border: "1px solid #30363d",
  borderRadius: 14,
  padding: 14,
};

const boardPanelStyle: CSSProperties = {
  ...panelStyle,
  display: "flex",
  justifyContent: "center",
  overflow: "auto",
};

const h2Style: CSSProperties = {
  fontSize: 16,
  margin: "0 0 10px",
};

const messageStyle: CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: "#161b22",
  marginBottom: 12,
  lineHeight: 1.6,
};

const ruleBoxStyle: CSSProperties = {
  marginTop: 12,
  padding: 10,
  borderRadius: 10,
  background: "#161b22",
  color: "#c9d1d9",
  fontSize: 13,
  lineHeight: 1.7,
};

const checkStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
};
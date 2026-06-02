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

type PieceName = "歩" | "と" | "騎" | "角" | "飛" | "王" | "馬" | "竜";
type DroppablePieceName = "歩" | "騎" | "角" | "飛";

type Coord = { q: number; r: number };
type Cell = Coord & { key: string };

type Piece = {
  side: Side;
  name: PieceName;
  promoted?: boolean;
};

type BoardMap = Record<string, Piece | null>;
type Hands = Record<Side, Partial<Record<DroppablePieceName, number>>>;

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
  board: BoardMap;
  hands: Hands;
};

type LastMove = {
  from?: string;
  to: string;
};

type SyncState = {
  gameStatus: GameStatus;
  board: BoardMap;
  hands: Hands;
  teams: Teams;
  currentTurn: Side;
  moveNumber: number;
  hostId: string | null;
  message: string;
  moveHistory: MoveRecord[];
  aliveSides: Side[];
  pendingReturnSide: Side | null;
  selectedHand: { side: Side; name: DroppablePieceName } | null;
  lastMove: LastMove | null;
  reviewMode: boolean;
  reviewIndex: number;
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
const HAND_PIECES: DroppablePieceName[] = ["歩", "騎", "角", "飛"];

function keyOf(c: Coord) {
  return `${c.q},${c.r}`;
}

function add(a: Coord, b: Coord, scale = 1): Coord {
  return { q: a.q + b.q * scale, r: a.r + b.r * scale };
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

function createEmptyHands(): Hands {
  return { red: {}, blue: {}, green: {} };
}

function cloneBoard(board: BoardMap): BoardMap {
  const next: BoardMap = {};

  for (const key of Object.keys(board)) {
    const p = board[key];
    next[key] = p ? { ...p } : null;
  }

  return next;
}

function cloneHands(hands: Hands): Hands {
  return {
    red: { ...hands.red },
    blue: { ...hands.blue },
    green: { ...hands.green },
  };
}

function put(board: BoardMap, q: number, r: number, piece: Piece) {
  const key = keyOf({ q, r });
  if (CELL_SET.has(key)) board[key] = piece;
}

function createInitialBoard(): BoardMap {
  const board = createEmptyBoard();

  // 赤軍：下
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

  // 青軍：右上
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

  // 緑軍：左上
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

function getAvatarUrl(user: Participant | null | undefined) {
  if (!user) return null;
  if (user.avatarUrl) return user.avatarUrl;
  if (user.avatar_url) return user.avatar_url;

  if (user.avatar && user.id) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
  }

  return null;
}

function demoteCapturedPiece(name: PieceName): DroppablePieceName | null {
  if (name === "王") return null;
  if (name === "と") return "歩";
  if (name === "馬") return "角";
  if (name === "竜") return "飛";
  return name as DroppablePieceName;
}

function addHand(hands: Hands, side: Side, captured: PieceName): Hands {
  const handName = demoteCapturedPiece(captured);
  const next = cloneHands(hands);

  if (!handName) return next;

  next[side][handName] = (next[side][handName] ?? 0) + 1;
  return next;
}

function removeHand(hands: Hands, side: Side, name: DroppablePieceName): Hands {
  const next = cloneHands(hands);
  const current = next[side][name] ?? 0;

  if (current <= 1) {
    delete next[side][name];
  } else {
    next[side][name] = current - 1;
  }

  return next;
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

function getRookForwardJumpDirs(side: Side): Coord[] {
  // 飛の真正面・真後ろ。
  // 赤軍の飛：例として -1,4 → 0,2 → 1,0 → 2,-2
  if (side === "red") return [{ q: 1, r: -2 }, { q: -1, r: 2 }];
  if (side === "blue") return [{ q: -2, r: 1 }, { q: 2, r: -1 }];
  return [{ q: 1, r: 1 }, { q: -1, r: -1 }];
}

function getDiagonalDirs(side: Side) {
  const axis = getSideAxisDirs(side);

  return DIRS.filter(
    (dir) => !sameCoord(dir, axis[0]) && !sameCoord(dir, axis[1])
  );
}

function coordDiff(from: Coord, to: Coord): Coord {
  return { q: to.q - from.q, r: to.r - from.r };
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

function isPathClear(board: BoardMap, from: Coord, to: Coord, dir: Coord) {
  const n = stepCount(coordDiff(from, to), dir);

  if (n <= 1) return true;

  for (let i = 1; i < n; i++) {
    const mid = add(from, dir, i);
    if (board[keyOf(mid)]) return false;
  }

  return true;
}

function promotePieceName(name: PieceName): PieceName {
  if (name === "歩") return "と";
  if (name === "角") return "馬";
  if (name === "飛") return "竜";
  return name;
}

function canPromote(piece: Piece) {
  return piece.name === "歩" || piece.name === "角" || piece.name === "飛";
}

function shouldPromote(piece: Piece, to: Coord) {
  if (!canPromote(piece)) return false;
  if (keyOf(to) === CENTER_KEY) return true;

  if (piece.side === "red" && to.r <= -2) return true;
  if (piece.side === "blue" && to.q <= -2) return true;

  const s = -to.q - to.r;
  if (piece.side === "green" && s <= -2) return true;

  return false;
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

  if (piece.name === "王") return distance === 1;
  if (piece.name === "と") return distance === 1;

  if (piece.name === "歩") {
    return getPawnForwardDirs(piece.side).some((dir) => sameCoord(diff, dir));
  }

  if (piece.name === "騎") {
    return DIRS.some((dir) => sameCoord(diff, add({ q: 0, r: 0 }, dir, 2)));
  }

  if (piece.name === "角") {
    return getDiagonalDirs(piece.side).some(
      (dir) => isSameDirection(diff, dir) && isPathClear(board, from, to, dir)
    );
  }

  if (piece.name === "飛") {
    const sideAxisDirs = getSideAxisDirs(piece.side);
    const forwardJumpDirs = getRookForwardJumpDirs(piece.side);

    if (
      sideAxisDirs.some(
        (dir) => isSameDirection(diff, dir) && isPathClear(board, from, to, dir)
      )
    ) {
      return true;
    }

    return forwardJumpDirs.some((dir) => {
      const n = stepCount(diff, dir);
      return n >= 1 && isPathClear(board, from, to, dir);
    });
  }

  if (piece.name === "馬") {
    if (distance === 1) return true;

    return getDiagonalDirs(piece.side).some(
      (dir) => isSameDirection(diff, dir) && isPathClear(board, from, to, dir)
    );
  }

  if (piece.name === "竜") {
    if (distance === 1) return true;

    const sideAxisDirs = getSideAxisDirs(piece.side);
    const forwardJumpDirs = getRookForwardJumpDirs(piece.side);

    if (
      sideAxisDirs.some(
        (dir) => isSameDirection(diff, dir) && isPathClear(board, from, to, dir)
      )
    ) {
      return true;
    }

    return forwardJumpDirs.some((dir) => {
      const n = stepCount(diff, dir);
      return n >= 1 && isPathClear(board, from, to, dir);
    });
  }

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
    ? { ...moving, name: promotePieceName(moving.name), promoted: true }
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

  const next = simulateMove(board, from, to);

  // 王が中央に入る場合でも、中央に敵駒の効きがあれば不可。
  return !isSideInCheck(next, piece.side, aliveSides);
}

function isLegalDrop(
  board: BoardMap,
  side: Side,
  name: DroppablePieceName,
  to: Coord,
  aliveSides: Side[]
) {
  if (!isInside(to)) return false;
  if (board[keyOf(to)]) return false;

  const next = cloneBoard(board);
  next[keyOf(to)] = { side, name };

  // 歩は、打った直後に最低1つ合法的に動ける場所がある場合のみ打てる。
  if (name === "歩") {
    const canMoveAfterDrop = CELLS.some((cell) =>
      isLegalPieceMove(next, { side, name: "歩" }, to, cell)
    );

    if (!canMoveAfterDrop) return false;
  }

  return !isSideInCheck(next, side, aliveSides);
}

function getLegalDestinations(board: BoardMap, from: Coord, aliveSides: Side[]) {
  const piece = board[keyOf(from)];
  if (!piece) return [];

  return CELLS.filter((cell) =>
    isLegalMoveConsideringCheck(board, piece, from, cell, aliveSides)
  );
}

function getLegalDropDestinations(
  board: BoardMap,
  side: Side,
  name: DroppablePieceName,
  aliveSides: Side[]
) {
  return CELLS.filter((cell) => isLegalDrop(board, side, name, cell, aliveSides));
}

function hasAnyLegalMove(
  board: BoardMap,
  side: Side,
  aliveSides: Side[],
  hands: Hands
) {
  for (const cell of CELLS) {
    const p = board[cell.key];
    if (!p || p.side !== side) continue;

    if (getLegalDestinations(board, cell, aliveSides).length > 0) {
      return true;
    }
  }

  for (const name of HAND_PIECES) {
    if ((hands[side][name] ?? 0) > 0) {
      if (getLegalDropDestinations(board, side, name, aliveSides).length > 0) {
        return true;
      }
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

function firstCheckedSideBy(
  board: BoardMap,
  attacker: Side,
  aliveSides: Side[]
) {
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
  const size = 32;
  const x = size * Math.sqrt(3) * (c.q + c.r / 2);
  const y = size * 1.5 * c.r;

  return {
    x: x + 300,
    y: y + 300,
  };
}

function getMoveMarkForPiece(piece: Piece | null) {
  if (!piece) return "●";
  if (piece.name === "角" || piece.name === "馬") return "↗";
  if (piece.name === "飛" || piece.name === "竜") return "➜";
  return "●";
}

function playTone(type: "move" | "capture" | "check" | "drop" | "win") {
  try {
    const AudioContextClass =
      window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const freq = {
      move: 440,
      capture: 180,
      check: 880,
      drop: 520,
      win: 660,
    }[type];

    osc.frequency.value = freq;
    osc.type = type === "check" ? "square" : "sine";
    gain.gain.value = 0.06;

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch {
    // 効果音が鳴らなくてもゲーム進行は止めない。
  }
}

export default function ThreeShogiApp() {
  const socketRef = useRef<Socket | null>(null);
  const roomIdRef = useRef("local-three-shogi-room");
  const bgmRef = useRef<HTMLAudioElement | null>(null);

  const [status, setStatus] = useState("起動中...");
  const [socketStatus, setSocketStatus] = useState("Socket未接続");
  const [currentUser, setCurrentUser] = useState<Participant | null>(null);

  const [hostId, setHostId] = useState<string | null>(null);
  const [gameStatus, setGameStatus] = useState<GameStatus>("lobby");
  const [teams, setTeams] = useState<Teams>({ red: [], blue: [], green: [] });
  const [board, setBoard] = useState<BoardMap>(createInitialBoard());
  const [hands, setHands] = useState<Hands>(createEmptyHands());
  const [selected, setSelected] = useState<Coord | null>(null);
  const [selectedHand, setSelectedHand] = useState<{
    side: Side;
    name: DroppablePieceName;
  } | null>(null);
  const [currentTurn, setCurrentTurn] = useState<Side>("red");
  const [moveNumber, setMoveNumber] = useState(0);
  const [message, setMessage] = useState(
    "三人将棋ベータ版です。まずは軍に参加してください。"
  );
  const [moveHistory, setMoveHistory] = useState<MoveRecord[]>([]);
  const [aliveSides, setAliveSides] = useState<Side[]>(SIDES);
  const [pendingReturnSide, setPendingReturnSide] = useState<Side | null>(null);
  const [freeMoveMode, setFreeMoveMode] = useState(true);
  const [lastMove, setLastMove] = useState<LastMove | null>(null);
  const [reviewMode, setReviewMode] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);

  const isHost = !!currentUser && currentUser.id === hostId;

  const displayBoard =
    reviewMode && reviewIndex > 0
      ? moveHistory[reviewIndex - 1]?.board ?? board
      : board;

  const displayHands =
    reviewMode && reviewIndex > 0
      ? moveHistory[reviewIndex - 1]?.hands ?? hands
      : hands;

  const mySide = useMemo(() => {
    if (!currentUser) return null;

    return (
      SIDES.find((side) =>
        teams[side].some((u) => u.id === currentUser.id)
      ) ?? null
    );
  }, [currentUser, teams]);

  const legalDestinations = useMemo(() => {
    if (reviewMode) return [];
    if (selected) return getLegalDestinations(board, selected, aliveSides);
    if (selectedHand) {
      return getLegalDropDestinations(
        board,
        selectedHand.side,
        selectedHand.name,
        aliveSides
      );
    }

    return [];
  }, [selected, selectedHand, board, aliveSides, reviewMode]);

  const legalDestinationKeys = useMemo(
    () => new Set(legalDestinations.map((c) => c.key)),
    [legalDestinations]
  );

  useEffect(() => {
    const audio = bgmRef.current;
    if (!audio) return;

    let src = "/bgm/main.mp3";
    if (reviewMode || gameStatus === "finished") {
      src = "/bgm/review.mp3";
    } else if (moveNumber >= 50) {
      src = "/bgm/calm.mp3";
    }

    if (!audio.src.endsWith(src)) {
      audio.src = src;
      audio.loop = true;
      audio.volume = 0.18;
      audio.play().catch(() => {});
    }
  }, [moveNumber, gameStatus, reviewMode]);

  function ensureBgmPlaying() {
    const audio = bgmRef.current;
    if (!audio) return;
    audio.volume = 0.18;
    audio.play().catch(() => {});
  }

  function emitSync(next: Partial<SyncState>) {
    const state: SyncState = {
      gameStatus,
      board,
      hands,
      teams,
      currentTurn,
      moveNumber,
      hostId,
      message,
      moveHistory,
      aliveSides,
      pendingReturnSide,
      selectedHand,
      lastMove,
      reviewMode,
      reviewIndex,
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
      setHands(state.hands ?? createEmptyHands());
      setTeams(state.teams);
      setCurrentTurn(state.currentTurn);
      setMoveNumber(state.moveNumber);
      setHostId(state.hostId);
      setMessage(state.message);
      setMoveHistory(state.moveHistory ?? []);
      setAliveSides(state.aliveSides ?? SIDES);
      setPendingReturnSide(state.pendingReturnSide ?? null);
      setSelectedHand(state.selectedHand ?? null);
      setLastMove(state.lastMove ?? null);
      setReviewMode(state.reviewMode ?? false);
      setReviewIndex(state.reviewIndex ?? 0);
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
    emitSync({ teams: nextTeams, message: nextMessage });
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
    const nextHands = createEmptyHands();

    setGameStatus("lobby");
    setBoard(nextBoard);
    setHands(nextHands);
    setSelected(null);
    setSelectedHand(null);
    setCurrentTurn("red");
    setMoveNumber(0);
    setMoveHistory([]);
    setAliveSides(SIDES);
    setPendingReturnSide(null);
    setLastMove(null);
    setReviewMode(false);
    setReviewIndex(0);
    setMessage("盤面を初期化しました。");

    emitSync({
      gameStatus: "lobby",
      board: nextBoard,
      hands: nextHands,
      currentTurn: "red",
      moveNumber: 0,
      moveHistory: [],
      aliveSides: SIDES,
      pendingReturnSide: null,
      selectedHand: null,
      lastMove: null,
      reviewMode: false,
      reviewIndex: 0,
      message: "盤面を初期化しました。",
    });
  }

  function startGame() {
    if (!isHost) return;

    ensureBgmPlaying();

    const joinedSides = SIDES.filter((s) => teams[s].length > 0);
    if (joinedSides.length < 3 && !freeMoveMode) {
      setMessage("3軍すべてに最低1人ずつ参加してから開始してください。");
      return;
    }

    const nextBoard = createInitialBoard();
    const nextHands = createEmptyHands();

    setGameStatus("playing");
    setBoard(nextBoard);
    setHands(nextHands);
    setSelected(null);
    setSelectedHand(null);
    setCurrentTurn("red");
    setMoveNumber(0);
    setMoveHistory([]);
    setAliveSides(SIDES);
    setPendingReturnSide(null);
    setLastMove(null);
    setReviewMode(false);
    setReviewIndex(0);
    setMessage("対局開始。赤軍の手番です。");

    emitSync({
      gameStatus: "playing",
      board: nextBoard,
      hands: nextHands,
      currentTurn: "red",
      moveNumber: 0,
      moveHistory: [],
      aliveSides: SIDES,
      pendingReturnSide: null,
      selectedHand: null,
      lastMove: null,
      reviewMode: false,
      reviewIndex: 0,
      message: "対局開始。赤軍の手番です。",
    });
  }

  function setReview(nextMode: boolean, nextIndex: number) {
    if (gameStatus !== "finished") return;

    const fixedIndex = Math.max(0, Math.min(nextIndex, moveHistory.length));

    setReviewMode(nextMode);
    setReviewIndex(fixedIndex);

    emitSync({
      reviewMode: nextMode,
      reviewIndex: fixedIndex,
      message: nextMode
        ? `感想戦中：${fixedIndex}手目を表示しています。`
        : "感想戦を終了しました。",
    });
  }

  function decideNextTurnAfterMove(
    nextBoard: BoardMap,
    nextHands: Hands,
    mover: Side,
    currentAlive: Side[],
    currentPendingReturnSide: Side | null
  ) {
    const checkedSide = firstCheckedSideBy(nextBoard, mover, currentAlive);

    if (checkedSide) {
      if (!hasAnyLegalMove(nextBoard, checkedSide, currentAlive, nextHands)) {
        const aliveAfterMate = currentAlive.filter((s) => s !== checkedSide);
        const boardAfterMate = removeSidePieces(nextBoard, checkedSide);

        if (aliveAfterMate.length === 1) {
          return {
            board: boardAfterMate,
            alive: aliveAfterMate,
            nextTurn: aliveAfterMate[0],
            nextPendingReturnSide: null,
            status: "finished" as GameStatus,
            sound: "win" as const,
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
          sound: "capture" as const,
          extraMessage: `${SIDE_LABEL[checkedSide]}は詰みです。次は${SIDE_LABEL[turnAfterMate]}の手番です。`,
        };
      }

      return {
        board: nextBoard,
        alive: currentAlive,
        nextTurn: checkedSide,
        nextPendingReturnSide: mover,
        status: "playing" as GameStatus,
        sound: "check" as const,
        extraMessage: `王手！すぐに${SIDE_LABEL[checkedSide]}の手番です。対応後、王手を返さなければ${SIDE_LABEL[mover]}に手番が戻ります。`,
      };
    }

    if (
      currentPendingReturnSide &&
      currentAlive.includes(currentPendingReturnSide)
    ) {
      return {
        board: nextBoard,
        alive: currentAlive,
        nextTurn: currentPendingReturnSide,
        nextPendingReturnSide: null,
        status: "playing" as GameStatus,
        sound: "move" as const,
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
      sound: "move" as const,
      extraMessage: `次は${SIDE_LABEL[normalNext]}の手番です。`,
    };
  }

  function canOperateSide(side: Side) {
    if (freeMoveMode) return side === currentTurn;
    if (!mySide) return false;
    return mySide === currentTurn && side === currentTurn;
  }

  function selectHandPiece(side: Side, name: DroppablePieceName) {
    if (reviewMode) return;
    if (gameStatus !== "playing") return;

    if (!canOperateSide(side)) {
      setMessage(`今は${SIDE_LABEL[currentTurn]}の手番です。`);
      return;
    }

    if ((hands[side][name] ?? 0) <= 0) return;

    setSelected(null);
    setSelectedHand({ side, name });
    setMessage(
      `${SIDE_LABEL[side]}の持ち駒「${name}」を選択しました。空きマスに打てます。`
    );
  }

  function onCellClick(cell: Cell) {
    if (reviewMode) return;
    if (gameStatus !== "playing") return;

    ensureBgmPlaying();

    const piece = board[cell.key];

    if (selectedHand) {
      if (
        !isLegalDrop(
          board,
          selectedHand.side,
          selectedHand.name,
          cell,
          aliveSides
        )
      ) {
        setMessage("そこには打てません。空きマス、歩の打ち込み位置、または王手の状態を確認してください。");
        return;
      }

      let nextBoard = cloneBoard(board);
      const nextHands = removeHand(hands, selectedHand.side, selectedHand.name);

      nextBoard[cell.key] = {
        side: selectedHand.side,
        name: selectedHand.name,
      };

      const decision = decideNextTurnAfterMove(
        nextBoard,
        nextHands,
        selectedHand.side,
        aliveSides,
        pendingReturnSide
      );

      nextBoard = decision.board;

      const nextMoveNumber = moveNumber + 1;
      const moveText = `${SIDE_LABEL[selectedHand.side]} ${selectedHand.name}打 (${cell.q},${cell.r})`;

      const nextHistory: MoveRecord[] = [
        ...moveHistory,
        {
          moveNumber: nextMoveNumber,
          side: selectedHand.side,
          playerName: getDisplayName(currentUser),
          text: moveText,
          board: nextBoard,
          hands: nextHands,
        },
      ];

      const nextMessage = `${moveText}。${decision.extraMessage}`;
      const nextLastMove: LastMove = { to: cell.key };

      playTone(decision.sound === "move" ? "drop" : decision.sound);

      setBoard(nextBoard);
      setHands(nextHands);
      setSelected(null);
      setSelectedHand(null);
      setCurrentTurn(decision.nextTurn);
      setMoveNumber(nextMoveNumber);
      setMoveHistory(nextHistory);
      setAliveSides(decision.alive);
      setPendingReturnSide(decision.nextPendingReturnSide);
      setGameStatus(decision.status);
      setLastMove(nextLastMove);
      setReviewIndex(nextHistory.length);
      setMessage(nextMessage);

      emitSync({
        board: nextBoard,
        hands: nextHands,
        currentTurn: decision.nextTurn,
        moveNumber: nextMoveNumber,
        moveHistory: nextHistory,
        aliveSides: decision.alive,
        pendingReturnSide: decision.nextPendingReturnSide,
        gameStatus: decision.status,
        selectedHand: null,
        lastMove: nextLastMove,
        reviewIndex: nextHistory.length,
        message: nextMessage,
      });

      return;
    }

    if (!selected) {
      if (!piece) return;

      if (!canOperateSide(piece.side)) {
        setMessage(`今は${SIDE_LABEL[currentTurn]}の駒だけ動かせます。`);
        return;
      }

      setSelected(cell);
      setSelectedHand(null);
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

    if (!isLegalMoveConsideringCheck(board, fromPiece, selected, cell, aliveSides)) {
      setMessage(
        "その動きはできません。王が中央に入る場合も、敵駒の効きがある中央には入れません。"
      );
      return;
    }

    const captured = board[cell.key];

    let nextBoard = cloneBoard(board);
    let nextHands = captured
      ? addHand(hands, fromPiece.side, captured.name)
      : cloneHands(hands);

    const movedPiece: Piece = shouldPromote(fromPiece, cell)
      ? { ...fromPiece, name: promotePieceName(fromPiece.name), promoted: true }
      : fromPiece;

    nextBoard[keyOf(selected)] = null;
    nextBoard[cell.key] = movedPiece;

    let nextAliveSides = [...aliveSides];
    let nextGameStatus: GameStatus = "playing";
    let nextTurn = currentTurn;
    let nextPendingReturnSide: Side | null = pendingReturnSide;
    let resultText = "";
    let sound: "move" | "capture" | "check" | "drop" | "win" = captured
      ? "capture"
      : "move";

    if (movedPiece.name === "王" && cell.key === CENTER_KEY) {
      nextGameStatus = "finished";
      resultText = `${SIDE_LABEL[fromPiece.side]}の王が中央マスに入りました。${SIDE_LABEL[fromPiece.side]}の勝利です。`;
      sound = "win";
    } else if (captured?.name === "王") {
      nextAliveSides = aliveSides.filter((s) => s !== captured.side);
      nextBoard = removeSidePieces(nextBoard, captured.side);

      if (nextAliveSides.length === 1) {
        nextGameStatus = "finished";
        resultText = `${SIDE_LABEL[captured.side]}の王を取りました。${SIDE_LABEL[nextAliveSides[0]]}の勝利です。`;
        sound = "win";
      } else {
        nextTurn = nextNormalSide(captured.side, nextAliveSides);
        nextPendingReturnSide = null;
        resultText = `${SIDE_LABEL[captured.side]}は脱落しました。次は${SIDE_LABEL[nextTurn]}の手番です。`;
        sound = "capture";
      }
    } else {
      const decision = decideNextTurnAfterMove(
        nextBoard,
        nextHands,
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
      sound = captured ? "capture" : decision.sound;
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
        board: nextBoard,
        hands: nextHands,
      },
    ];

    const nextMessage = `${moveText}。${resultText}`;
    const nextLastMove: LastMove = { from: keyOf(selected), to: cell.key };

    playTone(sound);

    setBoard(nextBoard);
    setHands(nextHands);
    setSelected(null);
    setSelectedHand(null);
    setCurrentTurn(nextTurn);
    setMoveNumber(nextMoveNumber);
    setMoveHistory(nextHistory);
    setAliveSides(nextAliveSides);
    setPendingReturnSide(nextPendingReturnSide);
    setGameStatus(nextGameStatus);
    setLastMove(nextLastMove);
    setReviewIndex(nextHistory.length);
    setMessage(nextMessage);

    emitSync({
      board: nextBoard,
      hands: nextHands,
      currentTurn: nextTurn,
      moveNumber: nextMoveNumber,
      moveHistory: nextHistory,
      aliveSides: nextAliveSides,
      pendingReturnSide: nextPendingReturnSide,
      gameStatus: nextGameStatus,
      selectedHand: null,
      lastMove: nextLastMove,
      reviewIndex: nextHistory.length,
      message: nextMessage,
    });
  }

  const boardSize = 620;

  return (
    <div style={pageStyle}>
      <audio ref={bgmRef} src="/bgm/main.mp3" loop />

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

          <button
            disabled={gameStatus !== "finished"}
            onClick={() =>
              setReview(!reviewMode, reviewMode ? moveHistory.length : reviewIndex)
            }
            style={{
              ...buttonStyle(gameStatus === "finished" ? "#8250df" : "#30363d"),
              opacity: gameStatus === "finished" ? 1 : 0.45,
            }}
          >
            {reviewMode ? "感想戦終了" : "感想戦"}
          </button>

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

          {SIDES.map((side) => {
            const isTurnSide = side === currentTurn && gameStatus === "playing";

            return (
              <div
                key={side}
                style={{
                  border: `2px solid ${SIDE_COLOR[side]}`,
                  boxShadow: isTurnSide
                    ? `0 0 18px ${SIDE_COLOR[side]}`
                    : "none",
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
                  {SIDE_LABEL[side]} {isTurnSide ? "手番" : ""}
                </div>

                <div style={{ minHeight: 24, fontSize: 13 }}>
                  {teams[side].length === 0 ? (
                    "未参加"
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      {teams[side].map((user) => {
                        const avatarUrl = getAvatarUrl(user);

                        return (
                          <div
                            key={`${side}-${user.id}`}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                            }}
                          >
                            {avatarUrl ? (
                              <img
                                src={avatarUrl}
                                alt=""
                                style={{
                                  width: 24,
                                  height: 24,
                                  borderRadius: "50%",
                                }}
                              />
                            ) : (
                              <div
                                style={{
                                  width: 24,
                                  height: 24,
                                  borderRadius: "50%",
                                  background: "#30363d",
                                }}
                              />
                            )}

                            <span>{getDisplayName(user)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <button
                  disabled={gameStatus !== "lobby"}
                  onClick={() => joinSide(side)}
                  style={buttonStyle(SIDE_COLOR[side], true)}
                >
                  この軍に入る
                </button>

                <div style={handBoxStyle}>
                  <b>持ち駒</b>

                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                      marginTop: 6,
                    }}
                  >
                    {HAND_PIECES.map((name) => {
                      const count = displayHands[side][name] ?? 0;
                      const active =
                        selectedHand?.side === side && selectedHand.name === name;

                      return (
                        <button
                          key={name}
                          disabled={
                            count <= 0 || gameStatus !== "playing" || reviewMode
                          }
                          onClick={() => selectHandPiece(side, name)}
                          style={{
                            ...handButtonStyle,
                            border: active
                              ? "2px solid #f2cc60"
                              : "1px solid #30363d",
                            opacity: count > 0 ? 1 : 0.35,
                          }}
                        >
                          {name}×{count}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}

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
        </aside>

        <main style={boardPanelStyle}>
          <div style={{ position: "relative", width: boardSize, height: boardSize }}>
            {CELLS.map((cell) => {
              const p = getCellPixel(cell);
              const piece = displayBoard[cell.key];
              const isSelected =
                selected && selected.q === cell.q && selected.r === cell.r;
              const isLegalDestination = legalDestinationKeys.has(cell.key);
              const isCenter = cell.key === CENTER_KEY;
              const isLastFrom = !reviewMode && lastMove?.from === cell.key;
              const isLastTo = !reviewMode && lastMove?.to === cell.key;

              return (
                <button
                  key={cell.key}
                  onClick={() => onCellClick(cell)}
                  title={`${cell.q},${cell.r}`}
                  style={{
                    position: "absolute",
                    left: p.x - 27,
                    top: p.y - 27,
                    width: 54,
                    height: 54,
                    clipPath:
                      "polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0% 50%)",
                    border: isSelected
                      ? "3px solid #f2cc60"
                      : isCenter
                      ? "3px solid #ffdf5d"
                      : isLegalDestination
                      ? "2px solid #58a6ff"
                      : isLastTo
                      ? "3px solid #ff9f43"
                      : isLastFrom
                      ? "2px solid #8b949e"
                      : "1px solid #30363d",
                    background: piece
                      ? "#f0e0b6"
                      : isCenter
                      ? "#4b3b10"
                      : isLegalDestination
                      ? "#102a43"
                      : isLastTo
                      ? "#3a2410"
                      : "#161b22",
                    color: piece ? "#0d1117" : "#8b949e",
                    cursor: reviewMode ? "default" : "pointer",
                    fontWeight: 900,
                    fontSize: 18,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: isCenter
                      ? "0 0 18px rgba(255, 223, 93, 0.6)"
                      : isLastTo
                      ? "0 0 18px rgba(255, 159, 67, 0.8)"
                      : "none",
                  }}
                >
                  {piece ? (
                    <>
                      <span
                        style={{
                          color: SIDE_COLOR[piece.side],
                          fontSize: 10,
                        }}
                      >
                        {SIDE_SHORT[piece.side]}
                      </span>
                      <span>{piece.name}</span>
                    </>
                  ) : isLegalDestination ? (
                    <span style={{ color: "#58a6ff", fontSize: 18 }}>
                      {selectedHand
                        ? "打"
                        : getMoveMarkForPiece(
                            selected ? board[keyOf(selected)] : null
                          )}
                    </span>
                  ) : isCenter ? (
                    <span style={{ color: "#ffdf5d", fontSize: 11 }}>中央</span>
                  ) : (
                    <span style={{ fontSize: 8 }}>{cell.q},{cell.r}</span>
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

          {reviewMode && (
            <div style={reviewBoxStyle}>
              <b>感想戦中</b>
              <div>
                {reviewIndex} / {moveHistory.length} 手目
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button
                  onClick={() => setReview(true, reviewIndex - 1)}
                  style={smallButtonStyle}
                >
                  前
                </button>
                <button
                  onClick={() => setReview(true, reviewIndex + 1)}
                  style={smallButtonStyle}
                >
                  次
                </button>
                <button onClick={() => setReview(true, 0)} style={smallButtonStyle}>
                  初期
                </button>
                <button
                  onClick={() => setReview(true, moveHistory.length)}
                  style={smallButtonStyle}
                >
                  最新
                </button>
              </div>
            </div>
          )}

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
            馬：角＋6方向1マス
            <br />
            飛：横に何マスでも、真正面・真後ろは一マス飛びずつ
            <br />
            竜：飛＋6方向1マス
            <br />
            王：6方向1マス
          </div>

          <h2 style={h2Style}>棋譜</h2>

          <div
            style={{
              maxHeight: 220,
              overflow: "auto",
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
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
  padding: 10,
  fontFamily: "system-ui, sans-serif",
  boxSizing: "border-box",
  overflow: "hidden",
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "center",
  marginBottom: 10,
};

const mainGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns:
    "minmax(220px, 260px) minmax(560px, 1fr) minmax(260px, 310px)",
  gap: 12,
  alignItems: "start",
  width: "100%",
  maxWidth: "100vw",
  overflowX: "auto",
};

const panelStyle: CSSProperties = {
  background: "#010409",
  border: "1px solid #30363d",
  borderRadius: 14,
  padding: 12,
};

const boardPanelStyle: CSSProperties = {
  ...panelStyle,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  overflow: "auto",
  minWidth: 0,
  maxHeight: "calc(100vh - 96px)",
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

const handBoxStyle: CSSProperties = {
  marginTop: 10,
  padding: 8,
  borderRadius: 8,
  background: "#010409",
  fontSize: 12,
};

const handButtonStyle: CSSProperties = {
  background: "#161b22",
  color: "#f0f6fc",
  borderRadius: 6,
  padding: "4px 6px",
  cursor: "pointer",
};

const reviewBoxStyle: CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: "#1f1336",
  border: "1px solid #8250df",
  marginBottom: 12,
  fontSize: 13,
};

const smallButtonStyle: CSSProperties = {
  background: "#30363d",
  color: "#f0f6fc",
  border: "none",
  borderRadius: 6,
  padding: "4px 8px",
  cursor: "pointer",
};

const checkStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
};
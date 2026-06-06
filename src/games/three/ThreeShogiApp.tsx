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
type PieceName = "歩" | "と" | "騎" | "香" | "杏" | "角" | "飛" | "王" | "馬" | "竜";
type DroppablePieceName = "歩" | "騎" | "香" | "角" | "飛";

type Coord = { q: number; r: number };
type Cell = Coord & { key: string };

type Piece = {
  side: Side;
  name: PieceName;
  promoted?: boolean;
  inactive?: boolean;
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
  updatedAt?: number;
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
const HAND_PIECES: DroppablePieceName[] = ["歩", "騎", "香", "角", "飛"];

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
      if (Math.abs(s) <= radius) cells.push({ q, r, key: keyOf({ q, r }) });
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

  put(board, -4, 4, { side: "red", name: "騎" });
  put(board, -3, 4, { side: "red", name: "角" });
  put(board, -2, 4, { side: "red", name: "王" });
  put(board, -1, 4, { side: "red", name: "飛" });
  put(board, 0, 4, { side: "red", name: "香" });
  put(board, -4, 3, { side: "red", name: "歩" });
  put(board, -3, 3, { side: "red", name: "歩" });
  put(board, -2, 3, { side: "red", name: "歩" });
  put(board, -1, 3, { side: "red", name: "歩" });
  put(board, 0, 3, { side: "red", name: "歩" });
  put(board, 1, 3, { side: "red", name: "歩" });

  put(board, 4, -4, { side: "blue", name: "香" });
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

  put(board, -4, 0, { side: "green", name: "香" });
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
  if (name === "杏") return "香";
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
  if (current <= 1) delete next[side][name];
  else next[side][name] = current - 1;
  return next;
}

function rotateCoordForViewer(c: Coord, viewer: Side | null): Coord {
  if (viewer === "blue") return { q: -c.q - c.r, r: c.q };
  if (viewer === "green") return { q: c.r, r: -c.q - c.r };
  return c;
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
  if (dir.q !== 0) k = diff.q / dir.q;
  else if (dir.r !== 0) k = diff.r / dir.r;

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
  if (name === "香") return "杏";
  return name;
}

function canPromote(piece: Piece) {
  return (
    piece.name === "歩" ||
    piece.name === "角" ||
    piece.name === "飛" ||
    piece.name === "香"
  );
}

function isInPromotionZone(side: Side, to: Coord) {
  // どの陣営から見ても「敵陣奥側2行」だけ。
  if (side === "red") return to.r <= -3;
  if (side === "blue") return to.q <= -3;
  const s = -to.q - to.r;
  return s <= -3;
}

function shouldPromote(piece: Piece, from: Coord, to: Coord) {
  if (!canPromote(piece)) return false;

  // 中央に打ち込まれた駒が中央から外へ出るときは成る。
  if (keyOf(from) === CENTER_KEY && keyOf(to) !== CENTER_KEY) return true;

  // 通常は、各陣営から見た敵陣の奥側2行に到達したときだけ成る。
  return isInPromotionZone(piece.side, to);
}

function isLegalPieceMove(
  board: BoardMap,
  piece: Piece,
  from: Coord,
  to: Coord
) {
  if (piece.inactive) return false;
  if (!isInside(to)) return false;
  if (sameCoord(from, to)) return false;

  const target = board[keyOf(to)];
  if (target?.side === piece.side) return false;
  if (target?.inactive && target.name === "王") return false;

  const diff = coordDiff(from, to);
  const distance = hexDistance(from, to);

  if (piece.name === "王") return distance === 1;
  if (piece.name === "と") return distance === 1;
  if (piece.name === "杏") return distance === 1;

  if (piece.name === "歩") {
    return getPawnForwardDirs(piece.side).some((dir) => sameCoord(diff, dir));
  }

  if (piece.name === "騎") {
    return DIRS.some((dir) => sameCoord(diff, add({ q: 0, r: 0 }, dir, 2)));
  }

  if (piece.name === "香") {
    // 歩と同じ前斜め2方向に1マス。
    const pawnLikeForward = getPawnForwardDirs(piece.side).some((dir) =>
      sameCoord(diff, dir)
    );
    if (pawnLikeForward) return true;

    // 真正面には「一マス飛び」を何回でも繰り返して進める。後ろには下がれない。
    const forwardJumpDir = getRookForwardJumpDirs(piece.side)[0];
    const n = stepCount(diff, forwardJumpDir);
    return n >= 1 && isPathClear(board, from, to, forwardJumpDir);
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
    if (p?.side === side && p.name === "王") return { q: cell.q, r: cell.r };
  }
  return null;
}

function isSideInCheck(board: BoardMap, side: Side, aliveSides: Side[]) {
  const king = findKing(board, side);
  if (!king) return false;

  for (const cell of CELLS) {
    const p = board[cell.key];
    if (!p) continue;
    if (p.inactive) continue;
    if (p.side === side) continue;
    if (!aliveSides.includes(p.side)) continue;
    if (isLegalPieceMove(board, p, cell, king)) return true;
  }

  return false;
}

function simulateMove(board: BoardMap, from: Coord, to: Coord) {
  const next = cloneBoard(board);
  const moving = next[keyOf(from)];
  if (!moving) return next;

  next[keyOf(from)] = null;
  next[keyOf(to)] = shouldPromote(moving, from, to)
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

function deactivateSidePieces(board: BoardMap, side: Side) {
  const next = cloneBoard(board);

  for (const key of Object.keys(next)) {
    if (next[key]?.side === side) {
      next[key] = { ...next[key]!, inactive: true };
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

function nextSideAfterElimination(
  mover: Side,
  eliminated: Side,
  aliveAfterElimination: Side[]
) {
  const candidates = aliveAfterElimination.filter((side) => side !== mover);

  if (candidates.length > 0) {
    const start = SIDES.indexOf(eliminated);

    for (let i = 1; i <= SIDES.length; i++) {
      const candidate = SIDES[(start + i) % SIDES.length];
      if (candidates.includes(candidate)) return candidate;
    }

    return candidates[0];
  }

  return mover;
}

function checkedSidesBy(board: BoardMap, attacker: Side, aliveSides: Side[]) {
  return SIDES.filter((side) => {
    if (side === attacker) return false;
    if (!aliveSides.includes(side)) return false;
    return isSideInCheck(board, side, aliveSides);
  });
}

function getCellPixel(c: Coord, boardSize: number) {
  const size = boardSize / 19.4;
  const x = size * Math.sqrt(3) * (c.q + c.r / 2);
  const y = size * 1.5 * c.r;

  return {
    x: x + boardSize / 2,
    y: y + boardSize / 2,
  };
}

function getPixelForLogicalCoord(
  c: Coord,
  viewerSide: Side | null,
  boardSize: number
) {
  const visual = rotateCoordForViewer(c, viewerSide);
  return getCellPixel(visual, boardSize);
}

function getHexPolygonPoints(cx: number, cy: number, size: number) {
  const w = size;
  const h = size;
  const x = cx - w / 2;
  const y = cy - h / 2;

  return [
    `${x + w * 0.25},${y + h * 0.04}`,
    `${x + w * 0.75},${y + h * 0.04}`,
    `${x + w},${y + h * 0.5}`,
    `${x + w * 0.75},${y + h * 0.96}`,
    `${x + w * 0.25},${y + h * 0.96}`,
    `${x},${y + h * 0.5}`,
  ].join(" ");
}

function getFacingVector(side: Side): Coord {
  if (side === "red") return { q: 1, r: -2 };
  if (side === "blue") return { q: -2, r: 1 };
  return { q: 1, r: 1 };
}

function axialToPixelVector(v: Coord) {
  return {
    x: Math.sqrt(3) * (v.q + v.r / 2),
    y: 1.5 * v.r,
  };
}

function getPieceRotationDeg(pieceSide: Side, viewerSide: Side | null) {
  const origin = rotateCoordForViewer({ q: 0, r: 0 }, viewerSide);
  const front = rotateCoordForViewer(getFacingVector(pieceSide), viewerSide);

  const v = {
    q: front.q - origin.q,
    r: front.r - origin.r,
  };

  const p = axialToPixelVector(v);
  return (Math.atan2(p.x, -p.y) * 180) / Math.PI;
}

function getMoveMarkForPiece(piece: Piece | null) {
  if (!piece) return "●";
  if (piece.name === "角" || piece.name === "馬") return "↗";
  if (piece.name === "飛" || piece.name === "竜") return "➜";
  if (piece.name === "香" || piece.name === "杏") return "●";
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
    // 効果音が鳴らなくても進行は止めない
  }
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 900, height: 700 });

  useEffect(() => {
    if (!ref.current) return;

    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      setSize({ width: rect.width, height: rect.height });
    });

    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

export default function ThreeShogiApp() {
  const socketRef = useRef<Socket | null>(null);
  const roomIdRef = useRef("local-three-shogi-room");
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const currentUserRef = useRef<Participant | null>(null);
  const { ref: boardWrapRef, size: boardWrapSize } =
    useElementSize<HTMLDivElement>();

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
  const [volume, setVolume] = useState(0.18);

  const isHost = true;

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  const mySide = useMemo(() => {
    if (!currentUser) return null;
    return (
      SIDES.find((side) =>
        teams[side].some((u) => u.id === currentUser.id)
      ) ?? null
    );
  }, [currentUser, teams]);

  const viewerSide = mySide ?? currentTurn;

  const boardSize = Math.max(
    420,
    Math.min(boardWrapSize.width - 8, boardWrapSize.height - 8, 900)
  );

  const displayBoard =
    reviewMode && reviewIndex > 0
      ? moveHistory[reviewIndex - 1]?.board ?? board
      : board;

  const displayHands =
    reviewMode && reviewIndex > 0
      ? moveHistory[reviewIndex - 1]?.hands ?? hands
      : hands;

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
    audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = bgmRef.current;
    if (!audio) return;

    let src = "/bgm/main.mp3";
    if (reviewMode || gameStatus === "finished") src = "/bgm/review.mp3";
    else if (moveNumber >= 40) src = "/bgm/calm.mp3";

    if (!audio.src.endsWith(src)) {
      audio.src = src;
      audio.loop = true;
      audio.volume = volume;
      audio.play().catch(() => {});
    }
  }, [moveNumber, gameStatus, reviewMode, volume]);

  function ensureBgmPlaying() {
    const audio = bgmRef.current;
    if (!audio) return;
    audio.volume = volume;
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

  function applyState(state: SyncState) {
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
  }

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });

    socketRef.current = socket;

    const register = (user: Participant | null) => {
      socket.emit("join-room", roomIdRef.current);
      socket.emit("request-state", roomIdRef.current);

      if (user) {
        socket.emit("register-user", {
          roomId: roomIdRef.current,
          userId: user.id,
          user,
        });
      }
    };

    socket.on("connect", () => {
      setSocketStatus("Socket接続中");
      register(currentUserRef.current);
    });

    socket.io.on("reconnect", () => {
      setSocketStatus("Socket再接続済み");
      register(currentUserRef.current);
    });

    socket.on("disconnect", () => {
      setSocketStatus("Socket切断中");
    });

    socket.on("connect_error", () => {
      setSocketStatus("Socketエラー");
    });

    socket.on("game-state", (state: SyncState) => {
      if (!state) return;
      applyState(state);
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
        register(localUser);
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
      register(me);
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
    const checkedSides = checkedSidesBy(nextBoard, mover, currentAlive);
    const checkedSide =
      currentPendingReturnSide && checkedSides.includes(currentPendingReturnSide)
        ? currentPendingReturnSide
        : checkedSides[0] ?? null;

    if (checkedSide) {
      if (!hasAnyLegalMove(nextBoard, checkedSide, currentAlive, nextHands)) {
        const aliveAfterMate = currentAlive.filter((s) => s !== checkedSide);
        const boardAfterMate = deactivateSidePieces(nextBoard, checkedSide);

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

        const turnAfterMate = nextSideAfterElimination(
          mover,
          checkedSide,
          aliveAfterMate
        );

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
        nextPendingReturnSide:
          checkedSides.length >= 2 && currentPendingReturnSide ? null : mover,
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
    if (!aliveSides.includes(side)) return false;
    if (freeMoveMode) return side === currentTurn;
    if (!mySide) return false;
    return mySide === currentTurn && side === currentTurn;
  }

  function selectHandPiece(side: Side, name: DroppablePieceName) {
    if (reviewMode || gameStatus !== "playing") return;

    if (!canOperateSide(side)) {
      setMessage(`今は${SIDE_LABEL[currentTurn]}の手番です。`);
      return;
    }

    if ((hands[side][name] ?? 0) <= 0) return;

    if (selectedHand?.side === side && selectedHand.name === name) {
      setSelectedHand(null);
      setMessage("持ち駒の選択を解除しました。");
      return;
    }

    setSelected(null);
    setSelectedHand({ side, name });
    setMessage(
      `${SIDE_LABEL[side]}の持ち駒「${name}」を選択しました。もう一度押すと解除できます。`
    );
  }

  function onCellClick(cell: Cell) {
    if (reviewMode || gameStatus !== "playing") return;

    ensureBgmPlaying();

    const piece = board[cell.key];

    if (selectedHand && piece && canOperateSide(piece.side)) {
      setSelected(cell);
      setSelectedHand(null);
      setMessage(`${SIDE_LABEL[piece.side]}の${piece.name}を選択しました。`);
      return;
    }

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
        setMessage("そこには打てません。空きマス、または王手の状態を確認してください。");
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

    const movedPiece: Piece = shouldPromote(fromPiece, selected, cell)
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
      nextBoard = deactivateSidePieces(nextBoard, captured.side);

      if (nextAliveSides.length === 1) {
        nextGameStatus = "finished";
        resultText = `${SIDE_LABEL[captured.side]}の王を取りました。${SIDE_LABEL[nextAliveSides[0]]}の勝利です。`;
        sound = "win";
      } else {
        nextTurn = nextSideAfterElimination(
          fromPiece.side,
          captured.side,
          nextAliveSides
        );
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

  return (
    <div style={pageStyle}>
      <audio ref={bgmRef} src="/bgm/main.mp3" loop />

      <header style={headerStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, lineHeight: 1.1 }}>
            三人将棋 ベータ版
          </h1>
          <div style={{ color: "#8b949e", fontSize: 13 }}>
            {status} / {socketStatus}
          </div>
        </div>

        <div style={topButtonRowStyle}>
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

        <main ref={boardWrapRef} style={boardPanelStyle}>
          <div style={{ position: "relative", width: boardSize, height: boardSize }}>
            <svg
              width={boardSize}
              height={boardSize}
              style={{
                position: "absolute",
                inset: 0,
                pointerEvents: "none",
                zIndex: 3,
              }}
            >
              <defs>
                <mask id="axis-mask-three-shogi">
                  <rect x="0" y="0" width={boardSize} height={boardSize} fill="white" />

                  {CELLS.filter(
                    (cell) => displayBoard[cell.key] || cell.key === CENTER_KEY
                  ).map((cell) => {
                    const p = getPixelForLogicalCoord(cell, viewerSide, boardSize);
                    const cellSizeForMask = Math.max(
                      38,
                      Math.min(56, boardSize / 11.2)
                    );

                    return (
                      <polygon
                        key={`mask-${cell.key}`}
                        points={getHexPolygonPoints(p.x, p.y, cellSizeForMask + 4)}
                        fill="black"
                      />
                    );
                  })}
                </mask>
              </defs>

              {[
                {
                  a: { q: -4, r: 0 },
                  b: { q: 4, r: 0 },
                  color: "#58a6ff",
                },
                {
                  a: { q: 0, r: -4 },
                  b: { q: 0, r: 4 },
                  color: "#ff7b72",
                },
                {
                  a: { q: -4, r: 4 },
                  b: { q: 4, r: -4 },
                  color: "#7ee787",
                },
              ].map((axis, index) => {
                const p1 = getPixelForLogicalCoord(axis.a, viewerSide, boardSize);
                const p2 = getPixelForLogicalCoord(axis.b, viewerSide, boardSize);

                return (
                  <line
                    key={index}
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    stroke={axis.color}
                    strokeWidth="2.5"
                    strokeOpacity="0.55"
                    mask="url(#axis-mask-three-shogi)"
                  />
                );
              })}
            </svg>

            {CELLS.map((cell) => {
              const visualCell = rotateCoordForViewer(cell, viewerSide);
              const p = getCellPixel(visualCell, boardSize);
              const piece = displayBoard[cell.key];
              const isSelected =
                selected && selected.q === cell.q && selected.r === cell.r;
              const isLegalDestination = legalDestinationKeys.has(cell.key);
              const isCenter = cell.key === CENTER_KEY;
              const isLastFrom = !reviewMode && lastMove?.from === cell.key;
              const isLastTo = !reviewMode && lastMove?.to === cell.key;
              const cellSize = Math.max(38, Math.min(56, boardSize / 11.2));

              return (
                <button
                  key={cell.key}
                  onClick={() => onCellClick(cell)}
                  title={`${cell.q},${cell.r}`}
                  style={{
                    position: "absolute",
                    left: p.x - cellSize / 2,
                    top: p.y - cellSize / 2,
                    width: cellSize,
                    height: cellSize,
                    zIndex: 2,
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
                      ? piece.inactive
                        ? "#8b7355"
                        : "#f0e0b6"
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
                    fontSize: Math.max(14, Math.min(18, boardSize / 36)),
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    boxShadow: isCenter
                      ? "0 0 18px rgba(255, 223, 93, 0.6)"
                      : isLastTo
                      ? "0 0 18px rgba(255, 159, 67, 0.8)"
                      : "none",
                  }}
                >
                  {piece ? (
                    <div
                      style={{
                        transform: `rotate(${getPieceRotationDeg(
                          piece.side,
                          viewerSide
                        )}deg)`,
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        lineHeight: 1,
                        opacity: piece.inactive ? 0.55 : 1,
                        position: "relative",
                        zIndex: 2,
                      }}
                    >
                      <span
                        style={{
                          color: SIDE_COLOR[piece.side],
                          fontSize: 10,
                        }}
                      >
                        {SIDE_SHORT[piece.side]}
                      </span>
                      <span>{piece.name}</span>
                    </div>
                  ) : isLegalDestination ? (
                    <span
                      style={{
                        color: "#58a6ff",
                        fontSize: 18,
                        position: "relative",
                        zIndex: 2,
                      }}
                    >
                      {selectedHand
                        ? "打"
                        : getMoveMarkForPiece(
                            selected ? board[keyOf(selected)] : null
                          )}
                    </span>
                  ) : isCenter ? (
                    <span
                      style={{
                        color: "#ffdf5d",
                        fontSize: 11,
                        position: "relative",
                        zIndex: 2,
                      }}
                    >
                      中央
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 8,
                        position: "relative",
                        zIndex: 2,
                      }}
                    >
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
            手番: {" "}
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
            騎：6方向に1マスジャンプ
            <br />
            香：前斜め2方向に1マス、または真正面に一マス飛びを何回でも
            <br />
            杏：6方向1マス
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
            <br />
            成り：自軍から見て敵陣奥側2行に入ると自動で成ります。
          </div>

          <h2 style={h2Style}>音量</h2>
          <div style={ruleBoxStyle}>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              style={{ width: "100%" }}
            />
            <div>{Math.round(volume * 100)}%</div>
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
                    {m.moveNumber}. {" "}
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
  height: "100vh",
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
  marginBottom: 6,
  flexWrap: "wrap",
};

const topButtonRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const mainGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns:
    "minmax(220px, 260px) minmax(420px, 1fr) minmax(240px, 310px)",
  gap: 10,
  alignItems: "stretch",
  width: "100%",
  height: "calc(100vh - 74px)",
  minHeight: 0,
};

const panelStyle: CSSProperties = {
  background: "#010409",
  border: "1px solid #30363d",
  borderRadius: 14,
  padding: 12,
  overflow: "auto",
  minHeight: 0,
};

const boardPanelStyle: CSSProperties = {
  ...panelStyle,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  padding: 6,
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

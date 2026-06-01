import { useEffect, useRef, useState } from "react";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { io, Socket } from "socket.io-client";

const CLIENT_ID = "1508095762242994317";
const isDiscordActivity = window.location.search.includes("frame_id");
const discordSdk = isDiscordActivity ? new DiscordSDK(CLIENT_ID) : null;

const DEFAULT_TURNS_PER_PLAYER = 1;
const SOCKET_URL = "";

type BgmTrackId = "none" | "main" | "calm";

const BGM_TRACKS: { id: BgmTrackId; label: string; url: string }[] = [
  { id: "none", label: "なし", url: "" },
  { id: "main", label: "通常BGM", url: "/bgm/main.mp3" },
  { id: "calm", label: "BGM", url: "/bgm/calm.mp3" },
];

type Participant = {
  id: string;
  username?: string;
  global_name?: string;
  avatar?: string | null;
  avatarUrl?: string | null;
  avatar_url?: string | null;
};
type TeamSide = "black" | "white";
type GameStatus = "lobby" | "playing" | "finished";
type PieceName =
  | "歩" | "香" | "桂" | "銀" | "金" | "角" | "飛" | "玉"
  | "と" | "成香" | "成桂" | "成銀" | "馬" | "龍";
type HandPieceName = "歩" | "香" | "桂" | "銀" | "金" | "角" | "飛";
type Piece = { side: TeamSide; name: PieceName };
type Board = (Piece | null)[][];
type SquarePos = { row: number; col: number };
type Hands = { black: HandPieceName[]; white: HandPieceName[] };
type SelectedHandPiece = { side: TeamSide; name: HandPieceName };
type MoveRecord = {
  moveNumber: number;
  side: TeamSide;
  playerName: string;
  text: string;
  capturedPieceName?: PieceName;
  from?: SquarePos;
  to?: SquarePos;
  kind?: "move" | "drop" | "skip";
};
type TurnInfo = {
  moveNumber: number;
  side: TeamSide;
  player: Participant;
  playerIndex: number;
  repeatIndex: number;
};
type PendingPromotion = {
  from: SquarePos;
  to: SquarePos;
  movingPiece: Piece;
  targetPiece: Piece | null;
};
type SyncState = {
  gameStatus: GameStatus;
  moveCount: number;
  board: Board;
  hands: Hands;
  blackTeam: Participant[];
  whiteTeam: Participant[];
  moveHistory: MoveRecord[];
  boardHistory: Board[];
  message: string;
  hostId: string | null;
  turnsPerPlayer: number;
  bgmTrackId?: BgmTrackId;
  bgmEnabled?: boolean;
};

function createInitialBoard(): Board {
  return [
    [
      { side: "white", name: "香" }, { side: "white", name: "桂" }, { side: "white", name: "銀" },
      { side: "white", name: "金" }, { side: "white", name: "玉" }, { side: "white", name: "金" },
      { side: "white", name: "銀" }, { side: "white", name: "桂" }, { side: "white", name: "香" },
    ],
    [null, { side: "white", name: "飛" }, null, null, null, null, null, { side: "white", name: "角" }, null],
    Array.from({ length: 9 }, () => ({ side: "white", name: "歩" as PieceName })),
    Array.from({ length: 9 }, () => null),
    Array.from({ length: 9 }, () => null),
    Array.from({ length: 9 }, () => null),
    Array.from({ length: 9 }, () => ({ side: "black", name: "歩" as PieceName })),
    [null, { side: "black", name: "角" }, null, null, null, null, null, { side: "black", name: "飛" }, null],
    [
      { side: "black", name: "香" }, { side: "black", name: "桂" }, { side: "black", name: "銀" },
      { side: "black", name: "金" }, { side: "black", name: "玉" }, { side: "black", name: "金" },
      { side: "black", name: "銀" }, { side: "black", name: "桂" }, { side: "black", name: "香" },
    ],
  ];
}

function App() {
  const socketRef = useRef<Socket | null>(null);
  const roomIdRef = useRef("local-room");
  const audioContextRef = useRef<AudioContext | null>(null);
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const urgentOscRef = useRef<OscillatorNode | null>(null);
  const urgentGainRef = useRef<GainNode | null>(null);
  const lastTimerBeepSecondRef = useRef<number | null>(null);

  const [status, setStatus] = useState("起動中...");
  const [socketStatus, setSocketStatus] = useState("Socket未接続");
  const [instanceId, setInstanceId] = useState("未取得");
  const [currentUser, setCurrentUser] = useState<Participant | null>(null);
  const currentUserRef = useRef<Participant | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [hostId, setHostId] = useState<string | null>(null);
  const [blackTeam, setBlackTeam] = useState<Participant[]>([]);
  const [whiteTeam, setWhiteTeam] = useState<Participant[]>([]);
  const [gameStatus, setGameStatus] = useState<GameStatus>("lobby");
  const [moveCount, setMoveCount] = useState(0);
  const [board, setBoard] = useState<Board>(createInitialBoard());
  const [hands, setHands] = useState<Hands>({ black: [], white: [] });
  const [selectedSquare, setSelectedSquare] = useState<SquarePos | null>(null);
  const [selectedHandPiece, setSelectedHandPiece] = useState<SelectedHandPiece | null>(null);
  const [moveHistory, setMoveHistory] = useState<MoveRecord[]>([]);
  const [boardHistory, setBoardHistory] = useState<Board[]>([createInitialBoard()]);
  const [reviewIndex, setReviewIndex] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [testFreeMoveMode, setTestFreeMoveMode] = useState(false);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState(Date.now());
  const [timerNow, setTimerNow] = useState(Date.now());
  const [pendingConfirm, setPendingConfirm] = useState<"resign" | "reset" | "skip" | null>(null);
  const [pendingResignSide, setPendingResignSide] = useState<TeamSide | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [socketError, setSocketError] = useState("");
  const [socketConnectedAt, setSocketConnectedAt] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState("");
  const [roomUserIds, setRoomUserIds] = useState<string[]>([]);
  const [turnsPerPlayer, setTurnsPerPlayer] = useState(DEFAULT_TURNS_PER_PLAYER);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [showHelpPanel, setShowHelpPanel] = useState(false);
  const [timerSoundEnabled, setTimerSoundEnabled] = useState(true);
  const [bgmTrackId, setBgmTrackId] = useState<BgmTrackId>("none");
  const [bgmEnabled, setBgmEnabled] = useState(false);
  const [bgmVolume, setBgmVolume] = useState(0.35);
  const [teamMuteNoticeEnabled, setTeamMuteNoticeEnabled] = useState(false);

  function formatNow() {
    return new Date().toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function getSocketStatusColor() {
    if (socketStatus.includes("接続中")) return "#7ee787";
    if (socketStatus.includes("エラー")) return "#ff7b72";
    return "#ffd166";
  }

  function playSound(type: "move" | "capture" | "check" | "finish" | "error") {
    if (!soundEnabled) return;

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextClass();
      }

      const ctx = audioContextRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      const config = {
        move: { freq: 520, duration: 0.07, volume: 0.035 },
        capture: { freq: 320, duration: 0.11, volume: 0.05 },
        check: { freq: 760, duration: 0.13, volume: 0.045 },
        finish: { freq: 880, duration: 0.22, volume: 0.05 },
        error: { freq: 180, duration: 0.12, volume: 0.045 },
      }[type];

      osc.type = "sine";
      osc.frequency.value = config.freq;
      gain.gain.setValueAtTime(config.volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + config.duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + config.duration);
    } catch {
      // 効果音に失敗してもゲームは止めない
    }
  }


  function getAudioContext() {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;

    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContextClass();
    }

    return audioContextRef.current;
  }

  function playTimerBeep() {
    if (!soundEnabled || !timerSoundEnabled) return;

    try {
      const ctx = getAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "square";
      osc.frequency.value = 980;
      gain.gain.setValueAtTime(0.045, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
    } catch {
      // タイマー音に失敗してもゲームは止めない
    }
  }

  function startUrgentTimerTone() {
    if (!soundEnabled || !timerSoundEnabled) return;
    if (urgentOscRef.current) return;

    try {
      const ctx = getAudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.value = 740;
      gain.gain.setValueAtTime(0.025, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      urgentOscRef.current = osc;
      urgentGainRef.current = gain;
    } catch {
      urgentOscRef.current = null;
      urgentGainRef.current = null;
    }
  }

  function stopUrgentTimerTone() {
    try {
      if (urgentGainRef.current && audioContextRef.current) {
        urgentGainRef.current.gain.setValueAtTime(0.001, audioContextRef.current.currentTime);
      }

      if (urgentOscRef.current) {
        urgentOscRef.current.stop();
      }
    } catch {
      // 既に停止済みの場合は何もしない
    }

    urgentOscRef.current = null;
    urgentGainRef.current = null;
  }

  function getSelectedBgmTrack() {
    return BGM_TRACKS.find((track) => track.id === bgmTrackId) ?? BGM_TRACKS[0];
  }

  async function applyBgmPlayback(nextEnabled: boolean, nextTrackId: BgmTrackId) {
    const audio = bgmAudioRef.current;
    const track = BGM_TRACKS.find((item) => item.id === nextTrackId) ?? BGM_TRACKS[0];

    if (!audio) return;

    audio.volume = bgmVolume;

    if (!nextEnabled || track.id === "none") {
      audio.pause();
      audio.currentTime = 0;
      return;
    }

    try {
      await audio.play();
    } catch {
      setMessage("BGMの自動再生がブロックされました。BGM再生ボタンをもう一度押してください。");
    }
  }

  function changeBgmTrack(nextTrackId: BgmTrackId) {
    if (!isCurrentUserHost()) {
      setMessage("BGM設定はホストだけが変更できます。");
      playSound("error");
      return;
    }

    setBgmTrackId(nextTrackId);

    const nextEnabled = nextTrackId !== "none" ? bgmEnabled : false;

    if (nextTrackId === "none") {
      setBgmEnabled(false);
    }

    syncGameState({
      bgmTrackId: nextTrackId,
      bgmEnabled: nextEnabled,
      message: nextTrackId === "none" ? "BGMを停止しました。" : `BGMを「${BGM_TRACKS.find((item) => item.id === nextTrackId)?.label ?? "BGM"}」に設定しました。`,
    });
  }

  function toggleServerBgm() {
    if (!isCurrentUserHost()) {
      setMessage("BGMの再生/停止はホストだけが操作できます。");
      playSound("error");
      return;
    }

    if (bgmTrackId === "none") {
      setMessage("先にBGMを選んでください。");
      playSound("error");
      return;
    }

    const nextEnabled = !bgmEnabled;
    setBgmEnabled(nextEnabled);
    applyBgmPlayback(nextEnabled, bgmTrackId);

    syncGameState({
      bgmTrackId,
      bgmEnabled: nextEnabled,
      message: nextEnabled ? "BGMを再生しました。" : "BGMを停止しました。",
    });
  }

  function replayBgmLocally() {
    applyBgmPlayback(bgmEnabled, bgmTrackId);
  }

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      path: "/socket.io",
      transports: ["polling"],
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketStatus("Socket接続中");
      setSocketError("");
      setSocketConnectedAt(formatNow());
      joinCurrentRoom();
    });

    socket.on("disconnect", (reason) => {
      setSocketStatus("Socket切断中");
      setSocketError(`切断理由: ${reason}`);
    });

    socket.on("connect_error", (error) => {
      setSocketStatus("Socket接続エラー");
      setSocketError(error.message);
      console.error("Socket接続エラー:", error);
    });

    socket.on("room-users", (userIds: string[]) => {
      setRoomUserIds(userIds.map(String));
    });

    socket.on("game-state", (state: SyncState) => {
      setGameStatus(state.gameStatus);
      setMoveCount(state.moveCount);
      setBoard(state.board);
      setHands(state.hands);
      setBlackTeam(state.blackTeam);
      setWhiteTeam(state.whiteTeam);
      setMoveHistory(state.moveHistory);
      setBoardHistory(state.boardHistory ?? [createInitialBoard()]);
      setReviewIndex(null);
      setMessage(state.message);
      setHostId(state.hostId ?? null);
      setTurnsPerPlayer(state.turnsPerPlayer ?? DEFAULT_TURNS_PER_PLAYER);
      setBgmTrackId(state.bgmTrackId ?? "none");
      setBgmEnabled(state.bgmEnabled ?? false);
      setLastSyncedAt(formatNow());
      setSelectedSquare(null);
      setSelectedHandPiece(null);
      setPendingPromotion(null);
      setPendingConfirm(null);
      setPendingResignSide(null);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (gameStatus === "playing") {
      setTurnStartedAt(Date.now());
    }
  }, [moveCount, gameStatus]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTimerNow(Date.now());
    }, 500);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const remainingSeconds = getTurnRemainingSeconds();

    if (gameStatus !== "playing" || !soundEnabled || !timerSoundEnabled) {
      stopUrgentTimerTone();
      lastTimerBeepSecondRef.current = null;
      return;
    }

    if (remainingSeconds <= 5 && remainingSeconds > 0) {
      startUrgentTimerTone();
    } else {
      stopUrgentTimerTone();
    }

    if ([20, 10, 6].includes(remainingSeconds) && lastTimerBeepSecondRef.current !== remainingSeconds) {
      playTimerBeep();
      lastTimerBeepSecondRef.current = remainingSeconds;
    }

    if (remainingSeconds === 0) {
      stopUrgentTimerTone();
    }
  }, [timerNow, gameStatus, soundEnabled, timerSoundEnabled, turnStartedAt]);

  useEffect(() => {
    applyBgmPlayback(bgmEnabled, bgmTrackId);
  }, [bgmTrackId, bgmEnabled]);

  useEffect(() => {
    if (bgmAudioRef.current) {
      bgmAudioRef.current.volume = bgmVolume;
    }
  }, [bgmVolume]);

  useEffect(() => {
    return () => {
      stopUrgentTimerTone();
      if (bgmAudioRef.current) {
        bgmAudioRef.current.pause();
      }
    };
  }, []);

  function syncGameState(next: Partial<SyncState>) {
    const state: SyncState = {
      gameStatus,
      moveCount,
      board,
      hands,
      blackTeam,
      whiteTeam,
      moveHistory,
      boardHistory,
      message,
      hostId,
      turnsPerPlayer,
      bgmTrackId,
      bgmEnabled,
      ...next,
    };

    socketRef.current?.emit("game-state", { roomId: roomIdRef.current, state });
    setLastSyncedAt(formatNow());
  }



  function joinCurrentRoom() {
    const socket = socketRef.current;
    if (!socket) return;

    socket.emit("join-room", roomIdRef.current);

    if (currentUserRef.current) {
      socket.emit("register-user", {
        roomId: roomIdRef.current,
        userId: currentUserRef.current.id,
      });
    }
  }

  useEffect(() => {
    async function setupDiscord() {
      try {
        if (!discordSdk) {
          const localUser = normalizeParticipant({
            id: "local-user",
            username: "ローカルテスト",
            global_name: "ローカルテスト",
            avatar: null,
          });

          roomIdRef.current = "local-browser-room";
          setInstanceId("local-browser-room");
          currentUserRef.current = localUser;
          setCurrentUser(localUser);
          setParticipants([localUser]);
          setStatus("ローカルブラウザ表示中（Discord外）");

          socketRef.current?.emit("join-room", "local-browser-room");
          socketRef.current?.emit("register-user", {
            roomId: "local-browser-room",
            userId: localUser.id,
          });

          return;
        }

        setStatus("Discord SDK接続中...");
        await discordSdk.ready();

        const activityChannelId = (discordSdk as any).channelId ?? (discordSdk as any).channel_id;
        const activityInstanceId = (discordSdk as any).instanceId ?? (discordSdk as any).instance_id;
        const stableRoomId = activityChannelId
          ? `channel-${activityChannelId}`
          : activityInstanceId
            ? `instance-${activityInstanceId}`
            : "local-room";

        roomIdRef.current = stableRoomId;
        setInstanceId(stableRoomId);
        joinCurrentRoom();

        setStatus("Discord認証コード取得中...");
        const { code } = await discordSdk.commands.authorize({
          client_id: CLIENT_ID,
          response_type: "code",
          state: "",
          prompt: "none",
          scope: ["identify", "guilds"],
        });

        setStatus("認証サーバーへ送信中...");
        const tokenResponse = await fetch("/api/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) throw new Error("アクセストークン取得に失敗しました");

        setStatus("Discord認証中...");
        const auth = await discordSdk.commands.authenticate({ access_token: tokenData.access_token });
        if (!auth) throw new Error("Discord authenticate に失敗しました");

        const user = (auth as any).user;
        if (user) {
          const me = normalizeParticipant({
            id: user.id,
            username: user.username,
            global_name: user.global_name,
            avatar: user.avatar,
            avatarUrl: user.avatarUrl,
            avatar_url: user.avatar_url,
          });
          currentUserRef.current = me;
          setCurrentUser(me);

          socketRef.current?.emit("register-user", {
            roomId: roomIdRef.current,
            userId: user.id,
          });
        }

        setStatus("Discordに接続・認証できました");
        await refreshParticipants();
      } catch (error) {
        console.error("setupDiscord error:", error);
        setStatus("エラーが発生しました。Consoleを確認してください。");
      }
    }

    setupDiscord();
  }, []);

  async function refreshParticipants() {
    try {
      if (!discordSdk) {
        const user = currentUserRef.current;
        setParticipants(user ? [user] : []);
        setMessage("ローカルブラウザではDiscord参加者は取得しません。");
        return;
      }

      const connectedParticipants = await discordSdk.commands.getInstanceConnectedParticipants();
      const rawParticipants = (connectedParticipants as any).participants ?? [];
      const normalizedParticipants = rawParticipants.map((participant: any) =>
        normalizeParticipant(participant)
      );

      setParticipants(normalizedParticipants);
      setMessage("参加者一覧を更新しました。");
    } catch (error) {
      console.error("refreshParticipants error:", error);
      setMessage("参加者一覧の更新に失敗しました。");
    }
  }

  async function reconnectAndResync() {
    const socket = socketRef.current;
    const user = currentUserRef.current;
    const roomId = roomIdRef.current;

    if (!socket) {
      setMessage("Socketがまだ準備できていません。画面を再読み込みしてください。");
      playSound("error");
      return;
    }

    if (!socket.connected) {
      socket.connect();
    }

    socket.emit("join-room", roomId);

    if (user) {
      socket.emit("register-user", {
        roomId,
        userId: user.id,
      });
    }

    await refreshParticipants();
    setMessage("部屋への再接続と参加者更新を実行しました。");
  }

  function getDisplayName(participant: Participant) {
    return participant.global_name ?? participant.username ?? participant.id;
  }

  function getAvatarUrl(participant: Participant | null) {
    if (participant === null) return null;
    if (participant.avatarUrl) return participant.avatarUrl;
    if (participant.avatar_url) return participant.avatar_url;

    if (participant.avatar) {
      const extension = participant.avatar.startsWith("a_") ? "gif" : "png";
      return `https://cdn.discordapp.com/avatars/${participant.id}/${participant.avatar}.${extension}?size=64`;
    }

    return null;
  }

  function normalizeParticipant(rawParticipant: any): Participant {
    const participant: Participant = {
      id: String(rawParticipant.id),
      username: rawParticipant.username,
      global_name: rawParticipant.global_name,
      avatar: rawParticipant.avatar ?? rawParticipant.avatar_hash ?? null,
      avatarUrl:
        rawParticipant.avatarUrl ??
        rawParticipant.avatar_url ??
        rawParticipant.image_url ??
        rawParticipant.imageUrl ??
        null,
    };

    return participant;
  }

  function getSideLabel(side: TeamSide) {
    return side === "black" ? "先手" : "後手";
  }

  function getOpponentSide(side: TeamSide): TeamSide {
    return side === "black" ? "white" : "black";
  }

  function getHostName() {
    const host =
      participants.find((p) => p.id === hostId) ??
      blackTeam.find((p) => p.id === hostId) ??
      whiteTeam.find((p) => p.id === hostId) ??
      (currentUser?.id === hostId ? currentUser : null);
    return host ? getDisplayName(host) : "未設定";
  }

  function isOnline(participant: Participant) {
    return roomUserIds.includes(participant.id);
  }

  function getOnlineCountText() {
    if (roomUserIds.length === 0) return "未取得";
    return `${roomUserIds.length}人`;
  }

  function isCurrentUserHost() {
    if (testFreeMoveMode) return true;
    const user = currentUserRef.current ?? currentUser;
    return user !== null && hostId === user.id;
  }

  function claimHost() {
    if (!currentUser) {
      setMessage("ユーザー情報がまだ取得できていません。");
      playSound("error");
      return;
    }

    if (hostId && hostId !== currentUser.id && !testFreeMoveMode) {
      setMessage("すでにホストがいます。");
      playSound("error");
      return;
    }

    const nextMessage = `${getDisplayName(currentUser)} がホストになりました。`;
    setHostId(currentUser.id);
    setMessage(nextMessage);
    syncGameState({ hostId: currentUser.id, message: nextMessage });
  }

  function releaseHost() {
    if (!isCurrentUserHost()) {
      setMessage("ホストだけがホスト解除できます。");
      playSound("error");
      return;
    }

    setHostId(null);
    setMessage("ホストを解除しました。");
    syncGameState({ hostId: null, message: "ホストを解除しました。" });
  }

  function getCurrentUserSide(): TeamSide | "spectator" {
    if (!currentUser) return "spectator";
    if (blackTeam.some((p) => p.id === currentUser.id)) return "black";
    if (whiteTeam.some((p) => p.id === currentUser.id)) return "white";
    return "spectator";
  }

  function getCurrentUserRoleText() {
    const side = getCurrentUserSide();
    if (testFreeMoveMode) return "テストモード中：制限なし";
    const hostText = currentUser?.id === hostId ? " / ホスト" : "";
    if (side === "black") return `あなたは先手チームです${hostText}`;
    if (side === "white") return `あなたは後手チームです${hostText}`;
    return `あなたは観戦者です${hostText}`;
  }

  function getTurnInfo(currentMoveCount: number): TurnInfo | null {
    if (blackTeam.length === 0 || whiteTeam.length === 0) return null;

    const side: TeamSide = currentMoveCount % 2 === 0 ? "black" : "white";
    const team = side === "black" ? blackTeam : whiteTeam;
    const sideTurnNumber = Math.floor(currentMoveCount / 2);
    const playerIndex = Math.floor(sideTurnNumber / turnsPerPlayer) % team.length;
    const repeatIndex = sideTurnNumber % turnsPerPlayer;

    return { moveNumber: currentMoveCount + 1, side, player: team[playerIndex], playerIndex, repeatIndex };
  }

  function canOperateNow(side: TeamSide) {
    if (testFreeMoveMode) return true;

    const currentTurn = getTurnInfo(moveCount);
    const user = currentUserRef.current ?? currentUser;

    if (!user || !currentTurn || gameStatus !== "playing") return false;

    return currentTurn.side === side && currentTurn.player.id === user.id;
  }

  function cloneBoard(sourceBoard: Board) {
    return sourceBoard.map((row) => row.map((piece) => (piece ? { ...piece } : null)));
  }

  function cloneHands(sourceHands: Hands): Hands {
    return { black: [...sourceHands.black], white: [...sourceHands.white] };
  }

  function isInsideBoard(row: number, col: number) {
    return row >= 0 && row < 9 && col >= 0 && col < 9;
  }

  function canEditParticipantTeam(participant: Participant) {
    if (testFreeMoveMode) return true;
    if (isCurrentUserHost()) return true;
    const user = currentUserRef.current ?? currentUser;
    return user !== null && participant.id === user.id;
  }

  function addToTeam(participant: Participant, side: TeamSide) {
    if (!canEditParticipantTeam(participant)) {
      setMessage("チーム変更は、ホストまたは本人だけが操作できます。");
      playSound("error");
      return;
    }

    if (gameStatus === "finished") {
      setMessage("対局終了後は、ロビーに戻ってからチーム変更してください。");
      playSound("error");
      return;
    }

    const newBlackTeam = blackTeam.filter((p) => p.id !== participant.id);
    const newWhiteTeam = whiteTeam.filter((p) => p.id !== participant.id);

    if (side === "black") {
      newBlackTeam.push(participant);
    } else {
      newWhiteTeam.push(participant);
    }

    setBlackTeam(newBlackTeam);
    setWhiteTeam(newWhiteTeam);

    syncGameState({
      blackTeam: newBlackTeam,
      whiteTeam: newWhiteTeam,
      message:
        gameStatus === "playing"
          ? `${getDisplayName(participant)} が途中参加で${getSideLabel(side)}チームに入りました。`
          : `${getDisplayName(participant)} を${getSideLabel(side)}に入れました。`,
    });
  }

  function removeFromTeams(participant: Participant) {
    if (!canEditParticipantTeam(participant)) {
      setMessage("チーム変更は、ホストまたは本人だけが操作できます。");
      playSound("error");
      return;
    }

    if (gameStatus === "finished") {
      setMessage("対局終了後は、ロビーに戻ってからチーム変更してください。");
      playSound("error");
      return;
    }

    const newBlackTeam = blackTeam.filter((p) => p.id !== participant.id);
    const newWhiteTeam = whiteTeam.filter((p) => p.id !== participant.id);

    setBlackTeam(newBlackTeam);
    setWhiteTeam(newWhiteTeam);

    syncGameState({
      blackTeam: newBlackTeam,
      whiteTeam: newWhiteTeam,
      message: `${getDisplayName(participant)} をチームから外しました。`,
    });
  }

  function clearTeams() {
    if (!isCurrentUserHost() || gameStatus !== "lobby") {
      setMessage("チーム初期化はロビーでホストだけが操作できます。");
      playSound("error");
      return;
    }
    setBlackTeam([]);
    setWhiteTeam([]);
    syncGameState({ blackTeam: [], whiteTeam: [], message: "チームを初期化しました。" });
  }

  function autoSplitTeams() {
    if (!isCurrentUserHost() || gameStatus !== "lobby") {
      setMessage("自動チーム分けはロビーでホストだけが操作できます。");
      playSound("error");
      return;
    }

    const uniqueParticipants = participants.filter((p, index, array) => array.findIndex((x) => x.id === p.id) === index);
    if (uniqueParticipants.length < 2) {
      setMessage("自動チーム分けには最低2人必要です。");
      playSound("error");
      return;
    }

    const newBlackTeam: Participant[] = [];
    const newWhiteTeam: Participant[] = [];
    uniqueParticipants.forEach((participant, index) => (index % 2 === 0 ? newBlackTeam : newWhiteTeam).push(participant));

    setBlackTeam(newBlackTeam);
    setWhiteTeam(newWhiteTeam);
    syncGameState({ blackTeam: newBlackTeam, whiteTeam: newWhiteTeam, message: "参加者を自動でチーム分けしました。" });
  }


  function shuffleTeams() {
    if (!isCurrentUserHost() || gameStatus !== "lobby") {
      setMessage("チームシャッフルはロビーでホストだけが操作できます。");
      playSound("error");
      return;
    }

    const allPlayers = [...blackTeam, ...whiteTeam].filter(
      (p, index, array) => array.findIndex((x) => x.id === p.id) === index
    );

    if (allPlayers.length < 2) {
      setMessage("シャッフルには最低2人必要です。");
      playSound("error");
      return;
    }

    const shuffled = [...allPlayers].sort(() => Math.random() - 0.5);
    const newBlackTeam: Participant[] = [];
    const newWhiteTeam: Participant[] = [];

    shuffled.forEach((player, index) => {
      if (index % 2 === 0) newBlackTeam.push(player);
      else newWhiteTeam.push(player);
    });

    setBlackTeam(newBlackTeam);
    setWhiteTeam(newWhiteTeam);
    syncGameState({
      blackTeam: newBlackTeam,
      whiteTeam: newWhiteTeam,
      message: "現在のチームメンバーをシャッフルしました。",
    });
  }

  function swapTeams() {
    if (!isCurrentUserHost() || gameStatus !== "lobby") {
      setMessage("先手後手の入れ替えはロビーでホストだけが操作できます。");
      playSound("error");
      return;
    }

    const newBlackTeam = [...whiteTeam];
    const newWhiteTeam = [...blackTeam];

    setBlackTeam(newBlackTeam);
    setWhiteTeam(newWhiteTeam);
    syncGameState({
      blackTeam: newBlackTeam,
      whiteTeam: newWhiteTeam,
      message: "先手チームと後手チームを入れ替えました。",
    });
  }

  function changeTurnsPerPlayer(value: number) {
    if (!isCurrentUserHost() || gameStatus !== "lobby") {
      setMessage("交代手数の変更はロビーでホストだけが操作できます。");
      playSound("error");
      return;
    }

    setTurnsPerPlayer(value);
    syncGameState({
      turnsPerPlayer: value,
      message: `交代設定を1人${value}手に変更しました。`,
    });
  }

  function addDummyPlayers() {
    if (!isCurrentUserHost()) {
      setMessage("テスト用プレイヤー追加はホストだけが操作できます。");
      playSound("error");
      return;
    }

    const dummyPlayers: Participant[] = [
      { id: "dummy-1", username: "テスト先手1" },
      { id: "dummy-2", username: "テスト先手2" },
      { id: "dummy-3", username: "テスト後手1" },
      { id: "dummy-4", username: "テスト後手2" },
    ];
    const newParticipants = [...participants];
    for (const dummy of dummyPlayers) {
      if (!newParticipants.some((p) => p.id === dummy.id)) newParticipants.push(dummy);
    }

    const newBlackTeam = [dummyPlayers[0], dummyPlayers[1]];
    const newWhiteTeam = [dummyPlayers[2], dummyPlayers[3]];
    setParticipants(newParticipants);
    setBlackTeam(newBlackTeam);
    setWhiteTeam(newWhiteTeam);
    syncGameState({ blackTeam: newBlackTeam, whiteTeam: newWhiteTeam, message: "テスト用4人を追加しました。" });
  }

  function canStartGame() {
    return blackTeam.length > 0 && whiteTeam.length > 0;
  }

  function startGame() {
    if (!isCurrentUserHost()) {
      setMessage("ゲーム開始はホストだけが操作できます。");
      playSound("error");
      return;
    }
    if (!canStartGame()) {
      alert("先手チームと後手チームに最低1人ずつ必要です。");
      return;
    }

    const newBoard = createInitialBoard();
    const newHands: Hands = { black: [], white: [] };
    const newMoveHistory: MoveRecord[] = [];

    setMoveCount(0);
    setBoard(newBoard);
    setHands(newHands);
    setSelectedSquare(null);
    setSelectedHandPiece(null);
    setMoveHistory(newMoveHistory);
    setBoardHistory([newBoard]);
    setReviewIndex(null);
    setMessage("対局を開始しました。");
    setPendingPromotion(null);
    setGameStatus("playing");
    playSound("move");

    syncGameState({ gameStatus: "playing", moveCount: 0, board: newBoard, hands: newHands, moveHistory: newMoveHistory, boardHistory: [newBoard], message: "対局を開始しました。" });
  }

  function rematchGame() {
    if (gameStatus !== "finished") {
      setMessage("再戦は対局終了後に使えます。");
      playSound("error");
      return;
    }

    if (!canStartGame()) {
      setMessage("再戦には先手チームと後手チームに最低1人ずつ必要です。");
      playSound("error");
      return;
    }

    const newBoard = createInitialBoard();
    const newHands: Hands = { black: [], white: [] };
    const newMoveHistory: MoveRecord[] = [];

    setMoveCount(0);
    setBoard(newBoard);
    setHands(newHands);
    setSelectedSquare(null);
    setSelectedHandPiece(null);
    setMoveHistory(newMoveHistory);
    setBoardHistory([newBoard]);
    setReviewIndex(null);
    setMessage("同じチームで再戦を開始しました。");
    setPendingPromotion(null);
    setPendingConfirm(null);
    setPendingResignSide(null);
    setGameStatus("playing");
    playSound("move");

    syncGameState({
      gameStatus: "playing",
      moveCount: 0,
      board: newBoard,
      hands: newHands,
      moveHistory: newMoveHistory,
      boardHistory: [newBoard],
      message: "同じチームで再戦を開始しました。",
    });
  }

  function resetGame() {
    setPendingConfirm("reset");
    setPendingResignSide(null);
    setMessage("ロビーに戻る確認中です。下の『ロビーに戻る』をもう一度押してください。");
    playSound("move");
  }

  function executeResetGame() {
    const newBoard = createInitialBoard();
    const newHands: Hands = { black: [], white: [] };
    const newMoveHistory: MoveRecord[] = [];

    setMoveCount(0);
    setBoard(newBoard);
    setHands(newHands);
    setSelectedSquare(null);
    setSelectedHandPiece(null);
    setMoveHistory(newMoveHistory);
    setBoardHistory([newBoard]);
    setReviewIndex(null);
    setMessage("ロビーに戻りました。必要ならチームを組み直してください。");
    setPendingPromotion(null);
    setPendingConfirm(null);
    setPendingResignSide(null);
    setGameStatus("lobby");
    playSound("finish");

    syncGameState({
      gameStatus: "lobby",
      moveCount: 0,
      board: newBoard,
      hands: newHands,
      moveHistory: newMoveHistory,
      boardHistory: [newBoard],
      message: "ロビーに戻りました。必要ならチームを組み直してください。",
    });
  }

  function resignGame() {
    if (gameStatus !== "playing") {
      setMessage("対局中ではないため投了できません。やり直す場合はロビーに戻ってください。");
      playSound("error");
      return;
    }

    const user = currentUserRef.current ?? currentUser;
    const userSide = getCurrentUserSide();
    const currentTurn = getTurnInfo(moveCount);

    let resignSide: TeamSide | null = null;

    if (testFreeMoveMode) {
      resignSide = currentTurn?.side ?? (userSide === "white" ? "white" : "black");
    } else if (userSide === "black" || userSide === "white") {
      resignSide = userSide;
    } else if (user && blackTeam.some((p) => p.id === user.id)) {
      resignSide = "black";
    } else if (user && whiteTeam.some((p) => p.id === user.id)) {
      resignSide = "white";
    }

    if (resignSide === null) {
      setMessage("投了できるのは先手チームまたは後手チームの参加者だけです。途中参加したい場合はチームに入ってください。");
      playSound("error");
      return;
    }

    setPendingConfirm("resign");
    setPendingResignSide(resignSide);
    setMessage(`${getSideLabel(resignSide)}として投了する確認中です。下の『投了する』を押してください。`);
    playSound("move");
  }

  function executeResignGame() {
    const resignSide = pendingResignSide;

    if (resignSide === null) {
      setMessage("投了するチームを確認できませんでした。もう一度投了ボタンを押してください。");
      setPendingConfirm(null);
      playSound("error");
      return;
    }

    const winnerSide = getOpponentSide(resignSide);
    const resignMessage = `${getSideLabel(resignSide)}が投了しました。${getSideLabel(winnerSide)}の勝ちです。`;

    setGameStatus("finished");
    setMessage(resignMessage);
    setSelectedSquare(null);
    setSelectedHandPiece(null);
    setPendingPromotion(null);
    setPendingConfirm(null);
    setPendingResignSide(null);
    playSound("finish");

    syncGameState({
      gameStatus: "finished",
      message: resignMessage,
    });
  }


  function skipTurn() {
    if (gameStatus !== "playing") {
      setMessage("対局中ではないため手番スキップはできません。");
      playSound("error");
      return;
    }

    const currentTurn = getTurnInfo(moveCount);

    if (currentTurn === null) {
      setMessage("手番情報がありません。ロビーに戻ると復旧できます。");
      playSound("error");
      return;
    }

    setPendingConfirm("skip");
    setPendingResignSide(null);
    setMessage(`${getDisplayName(currentTurn.player)} の手番をスキップする確認中です。`);
    playSound("move");
  }

  function executeSkipTurn() {
    const currentTurn = getTurnInfo(moveCount);

    if (currentTurn === null) {
      setMessage("手番情報がありません。ロビーに戻ると復旧できます。");
      setPendingConfirm(null);
      playSound("error");
      return;
    }

    const newMoveCount = moveCount + 1;
    const skippedPlayerName = getDisplayName(currentTurn.player);
    const skipMessage = `${getSideLabel(currentTurn.side)} ${skippedPlayerName} の手番をスキップしました。`;

    const newMoveHistory: MoveRecord[] = [
      {
        moveNumber: currentTurn.moveNumber,
        side: currentTurn.side,
        playerName: skippedPlayerName,
        text: "手番スキップ",
        kind: "skip",
      },
      ...moveHistory,
    ];

    const newBoardHistory = [...boardHistory, cloneBoard(board)];

    setMoveCount(newMoveCount);
    setMoveHistory(newMoveHistory);
    setBoardHistory(newBoardHistory);
    setReviewIndex(null);
    setSelectedSquare(null);
    setSelectedHandPiece(null);
    setPendingPromotion(null);
    setPendingConfirm(null);
    setPendingResignSide(null);
    setMessage(skipMessage);
    playSound("move");

    syncGameState({
      moveCount: newMoveCount,
      moveHistory: newMoveHistory,
      boardHistory: newBoardHistory,
      message: skipMessage,
    });
  }

  function cancelConfirm() {
    setPendingConfirm(null);
    setPendingResignSide(null);
    setMessage("操作をキャンセルしました。");
  }

  function isSelected(row: number, col: number) {
    return selectedSquare?.row === row && selectedSquare?.col === col;
  }

  function isPathClearOnBoard(targetBoard: Board, from: SquarePos, to: SquarePos) {
    const rowDiff = to.row - from.row;
    const colDiff = to.col - from.col;
    const rowStep = Math.sign(rowDiff);
    const colStep = Math.sign(colDiff);
    let currentRow = from.row + rowStep;
    let currentCol = from.col + colStep;

    while (currentRow !== to.row || currentCol !== to.col) {
      if (targetBoard[currentRow][currentCol] !== null) return false;
      currentRow += rowStep;
      currentCol += colStep;
    }
    return true;
  }

  function isGoldLike(pieceName: PieceName) {
    return ["金", "と", "成香", "成桂", "成銀"].includes(pieceName);
  }

  function isLegalSimpleMoveOnBoard(targetBoard: Board, piece: Piece, from: SquarePos, to: SquarePos) {
    if (!isInsideBoard(to.row, to.col)) return false;
    const targetPiece = targetBoard[to.row][to.col];
    if (targetPiece && targetPiece.side === piece.side) return false;

    const rowDiff = to.row - from.row;
    const colDiff = to.col - from.col;
    const forward = piece.side === "black" ? -1 : 1;
    const absRow = Math.abs(rowDiff);
    const absCol = Math.abs(colDiff);

    if (rowDiff === 0 && colDiff === 0) return false;
    if (piece.name === "歩") return rowDiff === forward && colDiff === 0;
    if (piece.name === "香") return colDiff === 0 && rowDiff * forward > 0 && isPathClearOnBoard(targetBoard, from, to);
    if (piece.name === "桂") return rowDiff === forward * 2 && absCol === 1;
    if (piece.name === "銀") return (rowDiff === forward && absCol <= 1) || (rowDiff === -forward && absCol === 1);
    if (isGoldLike(piece.name)) return (rowDiff === forward && absCol <= 1) || (rowDiff === 0 && absCol === 1) || (rowDiff === -forward && colDiff === 0);
    if (piece.name === "角") return absRow === absCol && isPathClearOnBoard(targetBoard, from, to);
    if (piece.name === "飛") return (rowDiff === 0 || colDiff === 0) && isPathClearOnBoard(targetBoard, from, to);
    if (piece.name === "馬") return (absRow === absCol && isPathClearOnBoard(targetBoard, from, to)) || (absRow <= 1 && absCol <= 1);
    if (piece.name === "龍") return ((rowDiff === 0 || colDiff === 0) && isPathClearOnBoard(targetBoard, from, to)) || (absRow <= 1 && absCol <= 1);
    if (piece.name === "玉") return absRow <= 1 && absCol <= 1;
    return false;
  }

  function findKing(targetBoard: Board, side: TeamSide): SquarePos | null {
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const piece = targetBoard[row][col];
        if (piece?.side === side && piece.name === "玉") return { row, col };
      }
    }
    return null;
  }

  function isSquareAttackedBySide(targetBoard: Board, square: SquarePos, attackerSide: TeamSide) {
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const piece = targetBoard[row][col];
        if (!piece || piece.side !== attackerSide) continue;
        if (isLegalSimpleMoveOnBoard(targetBoard, piece, { row, col }, square)) return true;
      }
    }
    return false;
  }

  function isKingInCheck(targetBoard: Board, side: TeamSide) {
    const kingSquare = findKing(targetBoard, side);
    if (!kingSquare) return true;
    return isSquareAttackedBySide(targetBoard, kingSquare, getOpponentSide(side));
  }

  function canPromote(pieceName: PieceName) {
    return ["歩", "香", "桂", "銀", "角", "飛"].includes(pieceName);
  }

  function promotePieceName(pieceName: PieceName): PieceName {
    if (pieceName === "歩") return "と";
    if (pieceName === "香") return "成香";
    if (pieceName === "桂") return "成桂";
    if (pieceName === "銀") return "成銀";
    if (pieceName === "角") return "馬";
    if (pieceName === "飛") return "龍";
    return pieceName;
  }

  function demotePieceName(pieceName: PieceName): HandPieceName | null {
    if (pieceName === "と") return "歩";
    if (pieceName === "成香") return "香";
    if (pieceName === "成桂") return "桂";
    if (pieceName === "成銀") return "銀";
    if (pieceName === "馬") return "角";
    if (pieceName === "龍") return "飛";
    if (pieceName === "玉") return null;
    return pieceName as HandPieceName;
  }

  function isInPromotionZone(side: TeamSide, row: number) {
    return side === "black" ? row <= 2 : row >= 6;
  }

  function isForcedPromotion(piece: Piece, to: SquarePos) {
    if (piece.name === "歩" || piece.name === "香") return piece.side === "black" ? to.row === 0 : to.row === 8;
    if (piece.name === "桂") return piece.side === "black" ? to.row <= 1 : to.row >= 7;
    return false;
  }

  function shouldAskPromotion(piece: Piece, from: SquarePos, to: SquarePos) {
    if (!canPromote(piece.name)) return false;
    if (isForcedPromotion(piece, to)) return false;
    return isInPromotionZone(piece.side, from.row) || isInPromotionZone(piece.side, to.row);
  }

  function getPromotionChoices(piece: Piece, from: SquarePos, to: SquarePos) {
    if (!canPromote(piece.name)) return [false];
    if (isForcedPromotion(piece, to)) return [true];
    if (isInPromotionZone(piece.side, from.row) || isInPromotionZone(piece.side, to.row)) return [false, true];
    return [false];
  }

  function makeBoardAfterMove(sourceBoard: Board, from: SquarePos, to: SquarePos, movingPiece: Piece, promote: boolean) {
    const nextBoard = cloneBoard(sourceBoard);
    nextBoard[to.row][to.col] = { ...movingPiece, name: promote ? promotePieceName(movingPiece.name) : movingPiece.name };
    nextBoard[from.row][from.col] = null;
    return nextBoard;
  }

  function hasUnpromotedPawnInFileOnBoard(targetBoard: Board, side: TeamSide, col: number) {
    for (let row = 0; row < 9; row++) {
      const piece = targetBoard[row][col];
      if (piece?.side === side && piece.name === "歩") return true;
    }
    return false;
  }

  function isDropImpossibleByRank(pieceName: HandPieceName, side: TeamSide, to: SquarePos) {
    const lastRow = side === "black" ? 0 : 8;
    const knightBadRows = side === "black" ? [0, 1] : [7, 8];
    if ((pieceName === "歩" || pieceName === "香") && to.row === lastRow) return true;
    if (pieceName === "桂" && knightBadRows.includes(to.row)) return true;
    return false;
  }

  function canDropOnBoardWithoutUchifuzume(targetBoard: Board, pieceName: HandPieceName, side: TeamSide, to: SquarePos) {
    if (!isInsideBoard(to.row, to.col)) return false;
    if (targetBoard[to.row][to.col]) return false;
    if (pieceName === "歩" && hasUnpromotedPawnInFileOnBoard(targetBoard, side, to.col)) return false;
    if (isDropImpossibleByRank(pieceName, side, to)) return false;

    const nextBoard = cloneBoard(targetBoard);
    nextBoard[to.row][to.col] = { side, name: pieceName };
    return !isKingInCheck(nextBoard, side);
  }

  function hasAnyLegalMove(targetBoard: Board, targetHands: Hands, side: TeamSide) {
    for (let fromRow = 0; fromRow < 9; fromRow++) {
      for (let fromCol = 0; fromCol < 9; fromCol++) {
        const piece = targetBoard[fromRow][fromCol];
        if (!piece || piece.side !== side) continue;
        const from = { row: fromRow, col: fromCol };
        for (let toRow = 0; toRow < 9; toRow++) {
          for (let toCol = 0; toCol < 9; toCol++) {
            const to = { row: toRow, col: toCol };
            if (!isLegalSimpleMoveOnBoard(targetBoard, piece, from, to)) continue;
            for (const promote of getPromotionChoices(piece, from, to)) {
              const nextBoard = makeBoardAfterMove(targetBoard, from, to, piece, promote);
              if (!isKingInCheck(nextBoard, side)) return true;
            }
          }
        }
      }
    }

    const uniqueHandPieces = Array.from(new Set(targetHands[side]));
    for (const pieceName of uniqueHandPieces) {
      for (let row = 0; row < 9; row++) {
        for (let col = 0; col < 9; col++) {
          if (canDropOnBoardWithoutUchifuzume(targetBoard, pieceName, side, { row, col })) return true;
        }
      }
    }
    return false;
  }

  function isCheckmate(targetBoard: Board, targetHands: Hands, side: TeamSide) {
    if (!isKingInCheck(targetBoard, side)) return false;
    return !hasAnyLegalMove(targetBoard, targetHands, side);
  }

  function isPawnDropCheckmate(targetBoard: Board, targetHands: Hands, side: TeamSide, to: SquarePos) {
    const nextBoard = cloneBoard(targetBoard);
    nextBoard[to.row][to.col] = { side, name: "歩" };
    return isCheckmate(nextBoard, targetHands, getOpponentSide(side));
  }

  function validateDropMove(pieceName: HandPieceName, side: TeamSide, to: SquarePos) {
    if (board[to.row][to.col]) return "駒がある場所には打てません。";
    if (pieceName === "歩" && hasUnpromotedPawnInFileOnBoard(board, side, to.col)) return "二歩です。同じ筋に自分の歩があるため、ここには歩を打てません。";
    if (isDropImpossibleByRank(pieceName, side, to)) return pieceName === "桂" ? "桂馬は次に動けない段には打てません。" : `${pieceName}はこれ以上前に進めない段には打てません。`;

    const nextBoard = cloneBoard(board);
    nextBoard[to.row][to.col] = { side, name: pieceName };
    if (isKingInCheck(nextBoard, side)) return "王手を放置する駒打ちはできません。";
    if (pieceName === "歩" && isPawnDropCheckmate(board, hands, side, to)) return "打ち歩詰めです。歩を打って即詰みにすることはできません。";
    return null;
  }

  function formatSquareForKifu(square: SquarePos) {
    const file = 9 - square.col;
    const ranks = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
    return `${file}${ranks[square.row]}`;
  }

  function finishMessageAfterMove(nextBoard: Board, nextHands: Hands, movedSide: TeamSide, capturedPiece: Piece | null) {
    if (capturedPiece?.name === "玉") {
      return { nextGameStatus: "finished" as GameStatus, nextMessage: `${getSideLabel(movedSide)}の勝ちです。王を取りました。`, sound: "finish" as const };
    }
    const opponentSide = getOpponentSide(movedSide);
    if (isCheckmate(nextBoard, nextHands, opponentSide)) {
      return { nextGameStatus: "finished" as GameStatus, nextMessage: `${getSideLabel(movedSide)}の勝ちです。詰みです。`, sound: "finish" as const };
    }
    if (isKingInCheck(nextBoard, opponentSide)) {
      return { nextGameStatus: "playing" as GameStatus, nextMessage: `${getSideLabel(opponentSide)}に王手です。`, sound: "check" as const };
    }
    return { nextGameStatus: "playing" as GameStatus, nextMessage: "", sound: capturedPiece ? "capture" as const : "move" as const };
  }

  function applyMove(data: PendingPromotion, promote: boolean, currentTurn: TurnInfo) {
    const { from, to, movingPiece, targetPiece } = data;
    const finalPiece: Piece = { ...movingPiece, name: promote ? promotePieceName(movingPiece.name) : movingPiece.name };
    const newBoard = cloneBoard(board);
    newBoard[to.row][to.col] = finalPiece;
    newBoard[from.row][from.col] = null;

    const newHands = cloneHands(hands);
    if (targetPiece) {
      const capturedName = demotePieceName(targetPiece.name);
      if (capturedName) newHands[movingPiece.side] = [...newHands[movingPiece.side], capturedName];
    }

    const finish = finishMessageAfterMove(newBoard, newHands, movingPiece.side, targetPiece);
    const kifuText = `${formatSquareForKifu(to)}${movingPiece.name}${promote ? "成" : ""}`;
    const newMoveHistory: MoveRecord[] = [
      { moveNumber: currentTurn.moveNumber, side: currentTurn.side, playerName: getDisplayName(currentTurn.player), text: kifuText, capturedPieceName: targetPiece?.name, from, to, kind: "move" },
      ...moveHistory,
    ];
    const newMoveCount = moveCount + 1;
    const newBoardHistory = [...boardHistory, cloneBoard(newBoard)];

    setBoard(newBoard);
    setHands(newHands);
    setMoveHistory(newMoveHistory);
    setBoardHistory(newBoardHistory);
    setReviewIndex(null);
    setMoveCount(newMoveCount);
    setSelectedSquare(null);
    setSelectedHandPiece(null);
    setPendingPromotion(null);
    setMessage(finish.nextMessage);
    setGameStatus(finish.nextGameStatus);
    playSound(finish.sound);

    syncGameState({ board: newBoard, hands: newHands, moveHistory: newMoveHistory, boardHistory: newBoardHistory, moveCount: newMoveCount, message: finish.nextMessage, gameStatus: finish.nextGameStatus });
  }

  function completeMove(promote: boolean) {
    const currentTurn = getTurnInfo(moveCount);
    if (!pendingPromotion || !currentTurn) {
      setMessage("成り処理に失敗しました。");
      playSound("error");
      return;
    }
    if (!canOperateNow(pendingPromotion.movingPiece.side)) {
      setMessage("現在指す人だけが成りを選べます。");
      playSound("error");
      return;
    }
    applyMove(pendingPromotion, promote, currentTurn);
  }

  function movePiece(from: SquarePos, to: SquarePos) {
    if (gameStatus !== "playing") return;
    const currentTurn = getTurnInfo(moveCount);
    if (!currentTurn) {
      setMessage("手番情報がありません。");
      playSound("error");
      return;
    }

    const movingPiece = board[from.row][from.col];
    const targetPiece = board[to.row][to.col];
    if (!movingPiece) return;
    if (!canOperateNow(movingPiece.side)) {
      setMessage("現在指す人だけが操作できます。観戦者や他のチームメンバーは操作できません。");
      playSound("error");
      return;
    }
    if (targetPiece && targetPiece.side === movingPiece.side) {
      setMessage("味方の駒がある場所には動かせません。");
      playSound("error");
      return;
    }
    if (!isLegalSimpleMoveOnBoard(board, movingPiece, from, to)) {
      setMessage("その駒はその場所には動けません。");
      playSound("error");
      return;
    }

    const forcedPromotion = isForcedPromotion(movingPiece, to);
    const nextBoardForSafety = makeBoardAfterMove(board, from, to, movingPiece, forcedPromotion);
    if (isKingInCheck(nextBoardForSafety, movingPiece.side)) {
      setMessage("王手を放置する手、または自分の王を危険にする手は指せません。");
      playSound("error");
      return;
    }

    const moveData: PendingPromotion = { from, to, movingPiece, targetPiece };
    if (forcedPromotion) {
      applyMove(moveData, true, currentTurn);
      return;
    }
    if (shouldAskPromotion(movingPiece, from, to)) {
      setPendingPromotion(moveData);
      setMessage("成りますか？");
      return;
    }
    applyMove(moveData, false, currentTurn);
  }

  function dropHandPiece(to: SquarePos) {
    if (gameStatus !== "playing" || !selectedHandPiece) return;
    const currentTurn = getTurnInfo(moveCount);
    if (!currentTurn) return;
    if (!canOperateNow(selectedHandPiece.side)) {
      setMessage("現在指す人だけが持ち駒を打てます。");
      playSound("error");
      return;
    }

    const dropError = validateDropMove(selectedHandPiece.name, selectedHandPiece.side, to);
    if (dropError) {
      setMessage(dropError);
      playSound("error");
      return;
    }

    const hand = hands[selectedHandPiece.side];
    const handIndex = hand.findIndex((name) => name === selectedHandPiece.name);
    if (handIndex === -1) {
      setMessage("その持ち駒はありません。");
      playSound("error");
      return;
    }

    const newBoard = cloneBoard(board);
    newBoard[to.row][to.col] = { side: selectedHandPiece.side, name: selectedHandPiece.name };
    const newHands = cloneHands(hands);
    newHands[selectedHandPiece.side].splice(handIndex, 1);
    const finish = finishMessageAfterMove(newBoard, newHands, selectedHandPiece.side, null);
    const newMoveHistory: MoveRecord[] = [
      { moveNumber: currentTurn.moveNumber, side: currentTurn.side, playerName: getDisplayName(currentTurn.player), text: `${formatSquareForKifu(to)}${selectedHandPiece.name}打`, to, kind: "drop" },
      ...moveHistory,
    ];
    const newMoveCount = moveCount + 1;
    const newBoardHistory = [...boardHistory, cloneBoard(newBoard)];

    setBoard(newBoard);
    setHands(newHands);
    setMoveHistory(newMoveHistory);
    setBoardHistory(newBoardHistory);
    setReviewIndex(null);
    setMoveCount(newMoveCount);
    setSelectedSquare(null);
    setSelectedHandPiece(null);
    setMessage(finish.nextMessage);
    setGameStatus(finish.nextGameStatus);
    playSound(finish.sound);

    syncGameState({ board: newBoard, hands: newHands, moveHistory: newMoveHistory, boardHistory: newBoardHistory, moveCount: newMoveCount, message: finish.nextMessage, gameStatus: finish.nextGameStatus });
  }

  function handleSquareClick(row: number, col: number) {
    if (reviewIndex !== null) {
      setMessage("感想戦表示中です。最新局面に戻ると操作できます。");
      return;
    }

    if (gameStatus !== "playing") return;
    if (pendingPromotion) {
      setMessage("成る/成らないを選んでください。");
      return;
    }
    if (selectedHandPiece) {
      dropHandPiece({ row, col });
      return;
    }
    const clickedPiece = board[row][col];
    if (!selectedSquare) {
      if (!clickedPiece) {
        setMessage("駒を選択してください。");
        return;
      }
      if (!canOperateNow(clickedPiece.side)) {
        setMessage("現在指す人だけが駒を選択できます。");
        playSound("error");
        return;
      }
      setSelectedSquare({ row, col });
      setMessage("");
      return;
    }
    if (selectedSquare.row === row && selectedSquare.col === col) {
      setSelectedSquare(null);
      setMessage("選択を解除しました。");
      return;
    }
    movePiece(selectedSquare, { row, col });
  }

  function selectHandPiece(side: TeamSide, name: HandPieceName) {
    if (reviewIndex !== null) {
      setMessage("感想戦表示中です。最新局面に戻ると操作できます。");
      return;
    }

    if (gameStatus !== "playing") return;
    if (!canOperateNow(side)) {
      setMessage("現在指す人だけが持ち駒を選択できます。");
      playSound("error");
      return;
    }
    if (pendingPromotion) {
      setMessage("成る/成らないを選んでください。");
      return;
    }
    setSelectedSquare(null);
    setSelectedHandPiece({ side, name });
    setMessage(`${getSideLabel(side)}の${name}を選択中`);
  }

  function cancelSelection() {
    setSelectedSquare(null);
    setSelectedHandPiece(null);
    setPendingPromotion(null);
    setMessage("選択を解除しました。");
  }

  function countHandPieces(hand: HandPieceName[]) {
    const result: Partial<Record<HandPieceName, number>> = {};
    for (const pieceName of hand) result[pieceName] = (result[pieceName] ?? 0) + 1;
    return result;
  }

  const currentTurn = getTurnInfo(moveCount);
  const nextTurnPreview = getTurnInfo(moveCount + 1);
  const viewerBottomSide: TeamSide = getCurrentUserSide() === "white" ? "white" : "black";
  const upperHandSide: TeamSide = viewerBottomSide === "black" ? "white" : "black";
  const lowerHandSide: TeamSide = viewerBottomSide;

  function getDisplayBoardCells() {
    const displayBoard = reviewIndex !== null ? boardHistory[reviewIndex] ?? board : board;
    const cells: { row: number; col: number; square: Piece | null }[] = [];

    const rowOrder = viewerBottomSide === "black"
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
      : [8, 7, 6, 5, 4, 3, 2, 1, 0];

    const colOrder = viewerBottomSide === "black"
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
      : [8, 7, 6, 5, 4, 3, 2, 1, 0];

    for (const row of rowOrder) {
      for (const col of colOrder) {
        cells.push({ row, col, square: displayBoard[row][col] });
      }
    }

    return cells;
  }

  function getDisplayedMove() {
    if (reviewIndex !== null) {
      return moveHistory.find((move) => move.moveNumber === reviewIndex) ?? null;
    }

    return moveHistory[0] ?? null;
  }

  function isLastMoveDestination(row: number, col: number) {
    const lastMove = getDisplayedMove();

    if (!lastMove?.to) {
      return false;
    }

    return lastMove.to.row === row && lastMove.to.col === col;
  }

  function getTurnRemainingSeconds() {
    if (gameStatus !== "playing") {
      return 30;
    }

    const elapsedSeconds = Math.floor((timerNow - turnStartedAt) / 1000);
    return Math.max(0, 30 - elapsedSeconds);
  }
  const hostControlDisabled = !isCurrentUserHost();

  function Avatar(props: { participant: Participant | null; size?: number }) {
    const size = props.size ?? 32;
    const avatarUrl = getAvatarUrl(props.participant);
    const name = props.participant ? getDisplayName(props.participant) : "?";
    const firstLetter = name.slice(0, 1);

    if (avatarUrl) {
      return (
        <img
          src={avatarUrl}
          alt={name}
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            objectFit: "cover",
            border: "2px solid #555",
            background: "#333",
            flexShrink: 0,
          }}
        />
      );
    }

    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#4a4d55",
          color: "white",
          fontWeight: "bold",
          border: "2px solid #555",
          flexShrink: 0,
        }}
      >
        {firstLetter}
      </span>
    );
  }


  function getSpectators() {
    return participants.filter(
      (participant) =>
        !blackTeam.some((member) => member.id === participant.id) &&
        !whiteTeam.some((member) => member.id === participant.id)
    );
  }

  function SpectatorList() {
    const spectators = getSpectators();

    return (
      <section
        style={{
          maxWidth: 760,
          margin: "12px auto",
          padding: 12,
          borderRadius: 12,
          background: "#24262b",
          border: "1px solid #444",
        }}
      >
        <strong>観戦者</strong>
        {spectators.length === 0 ? (
          <p style={{ margin: "8px 0 0", color: "#bbb" }}>現在、観戦者はいません。</p>
        ) : (
          <div style={{ marginTop: 10, display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
            {spectators.map((participant) => (
              <span key={participant.id}><PlayerCard participant={participant} side="spectator" compact /></span>
            ))}
          </div>
        )}
      </section>
    );
  }
  function PlayerCard(props: { participant: Participant; side?: TeamSide | "spectator"; compact?: boolean }) {
    const borderColor =
      props.side === "black" ? "#f0c978" : props.side === "white" ? "#7b9cff" : "#555";

    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: props.compact ? "4px 8px" : "6px 10px",
          border: `1px solid ${borderColor}`,
          borderRadius: 999,
          background: "#2b2d31",
          color: "white",
          maxWidth: 220,
        }}
      >
        <span
          title={isOnline(props.participant) ? "オンライン" : "未接続/未取得"}
          style={{
            width: 10,
            height: 10,
            borderRadius: 999,
            background: isOnline(props.participant) ? "#7ee787" : "#666",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        <Avatar participant={props.participant} size={props.compact ? 24 : 32} />
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {getDisplayName(props.participant)}
        </span>
      </span>
    );
  }

  function TeamList(props: { title: string; side: TeamSide; members: Participant[] }) {
    return (
      <section
        style={{
          minWidth: 220,
          padding: 12,
          borderRadius: 12,
          background: "#2b2d31",
          border: `2px solid ${props.side === "black" ? "#f0c978" : "#7b9cff"}`,
        }}
      >
        <h3 style={{ marginTop: 0 }}>{props.title}</h3>

        {props.members.length === 0 ? (
          <p>未設定</p>
        ) : (
          <ol style={{ paddingLeft: 20, textAlign: "left" }}>
            {props.members.map((member) => (
              <li key={member.id} style={{ marginBottom: 8 }}>
                <PlayerCard participant={member} side={props.side} compact />
              </li>
            ))}
          </ol>
        )}
      </section>
    );
  }


  function getOperationGuideText() {
    if (gameStatus === "lobby") {
      return "ロビーです。チーム分けをしてゲームを開始してください。";
    }

    if (gameStatus === "finished") {
      return "対局は終了しています。同じチームで再戦するか、ロビーに戻れます。";
    }

    if (testFreeMoveMode) {
      return "テストモード中です。手番やチーム制限を無視して操作できます。";
    }

    if (currentTurn === null) {
      return "手番情報を作成できません。ロビーに戻ると復旧できます。";
    }

    if (currentUser === null) {
      return "あなたのユーザー情報を取得中です。少し待ってから操作してください。";
    }

    const mySide = getCurrentUserSide();

    if (mySide === "spectator") {
      return "あなたは観戦者です。盤面を見ることはできますが、駒は動かせません。";
    }

    if (currentTurn.player.id === currentUser.id) {
      return "あなたの手番です。駒を選んで指してください。";
    }

    if (currentTurn.side === mySide) {
      return `味方の ${getDisplayName(currentTurn.player)} さんの手番です。`;
    }

    return "相手チームの手番です。";
  }

  function TurnBanner() {
    if (gameStatus === "finished") {
      return (
        <div
          style={{
            maxWidth: 760,
            margin: "12px auto",
            padding: 14,
            borderRadius: 12,
            background: "#2f2a1f",
            border: "2px solid #ffd166",
          }}
        >
          <strong>対局終了</strong>
          <p style={{ margin: "8px 0 0" }}>{message || "対局が終了しました。"}</p>
        </div>
      );
    }

    if (currentTurn === null) {
      return (
        <div
          style={{
            maxWidth: 760,
            margin: "12px auto",
            padding: 14,
            borderRadius: 12,
            background: "#332424",
            border: "2px solid #aa4444",
          }}
        >
          <strong>手番情報エラー</strong>
          <p style={{ margin: "8px 0 0" }}>ロビーに戻ると復旧できます。</p>
        </div>
      );
    }

    const canMove = testFreeMoveMode || (currentUser !== null && currentTurn.player.id === currentUser.id);

    return (
      <div
        style={{
          maxWidth: 760,
          margin: "12px auto",
          padding: 14,
          borderRadius: 12,
          background: canMove ? "#1f3325" : "#24262b",
          border: `2px solid ${canMove ? "#7ee787" : currentTurn.side === "black" ? "#f0c978" : "#7b9cff"}`,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: "bold", marginBottom: 8 }}>
          {canMove ? "あなたが操作できます" : "現在の手番"}
        </div>

        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>{currentTurn.moveNumber}手目</span>
          <span>{getSideLabel(currentTurn.side)}</span>
          <PlayerCard participant={currentTurn.player} side={currentTurn.side} compact />
        </div>

        <p style={{ margin: "10px 0 0", color: "#ddd" }}>{getOperationGuideText()}</p>

        {nextTurnPreview && gameStatus === "playing" && (
          <p style={{ margin: "6px 0 0", color: "#aaa", fontSize: 13 }}>
            次の手番: {getSideLabel(nextTurnPreview.side)} - {getDisplayName(nextTurnPreview.player)}
          </p>
        )}
      </div>
    );
  }


  function LastMovePanel() {
    const lastMove = getDisplayedMove();

    if (!lastMove) {
      return (
        <div
          style={{
            maxWidth: 760,
            margin: "10px auto",
            padding: 10,
            borderRadius: 10,
            border: "1px solid #444",
            background: "#24262b",
            color: "#bbb",
          }}
        >
          直近の指し手: まだありません
        </div>
      );
    }

    return (
      <div
        style={{
          maxWidth: 760,
          margin: "10px auto",
          padding: 12,
          borderRadius: 10,
          border: "1px solid #5f6f88",
          background: "#202734",
        }}
      >
        <strong>{reviewIndex !== null ? "表示中の指し手" : "直近の指し手"}</strong>
        <div style={{ marginTop: 6 }}>
          {lastMove.moveNumber}手目 / {getSideLabel(lastMove.side)} / {lastMove.playerName} / {lastMove.text}
          {lastMove.capturedPieceName ? `（${lastMove.capturedPieceName}を取得）` : ""}
        </div>
      </div>
    );
  }


  function ReviewControls() {
    if (boardHistory.length <= 1) {
      return null;
    }

    const currentReviewIndex = reviewIndex ?? boardHistory.length - 1;
    const displayedMove = getDisplayedMove();
    const isLive = reviewIndex === null;

    function setSafeReviewIndex(nextIndex: number | null) {
      if (nextIndex === null) {
        setReviewIndex(null);
        return;
      }

      const safeIndex = Math.min(Math.max(nextIndex, 0), boardHistory.length - 1);
      setReviewIndex(safeIndex);
    }

    return (
      <section
        style={{
          maxWidth: 760,
          margin: "12px auto",
          padding: 12,
          borderRadius: 12,
          background: isLive ? "#24262b" : "#2b2a1f",
          border: `1px solid ${isLive ? "#444" : "#ffd166"}`,
        }}
      >
        <strong>感想戦</strong>
        <p style={{ margin: "6px 0", color: "#ddd", fontSize: 13 }}>
          {isLive
            ? "現在は最新局面です。"
            : `${currentReviewIndex}手目を表示中です。感想戦中は駒を動かせません。`}
        </p>
        {displayedMove && (
          <p style={{ margin: "4px 0", color: "#bbb", fontSize: 13 }}>
            表示中の手: {displayedMove.moveNumber}手目 / {getSideLabel(displayedMove.side)} / {displayedMove.text}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <button onClick={() => setSafeReviewIndex(0)}>初期局面</button>
          <button onClick={() => setSafeReviewIndex(currentReviewIndex - 1)}>一手戻る</button>
          <button onClick={() => setSafeReviewIndex(currentReviewIndex + 1)}>一手進む</button>
          <button onClick={() => setSafeReviewIndex(null)}>最新局面に戻る</button>
        </div>
      </section>
    );
  }

  function BoardTurnHeader() {
    if (gameStatus === "finished") {
      return (
        <div
          style={{
            width: 396,
            margin: "0 auto 8px",
            padding: "10px 12px",
            borderRadius: 10,
            border: "2px solid #ffd166",
            background: "#2f2a1f",
            boxSizing: "border-box",
          }}
        >
          <strong>対局終了</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>{message || "対局が終了しました。"}</div>
        </div>
      );
    }

    if (currentTurn === null) {
      return (
        <div
          style={{
            width: 396,
            margin: "0 auto 8px",
            padding: "10px 12px",
            borderRadius: 10,
            border: "2px solid #aa4444",
            background: "#332424",
            boxSizing: "border-box",
          }}
        >
          <strong>手番情報エラー</strong>
          <div style={{ marginTop: 4, fontSize: 13 }}>ロビーに戻ると復旧できます。</div>
        </div>
      );
    }

    const canMove = testFreeMoveMode || (currentUser !== null && currentTurn.player.id === currentUser.id);
    const remainingSeconds = getTurnRemainingSeconds();

    return (
      <div
        style={{
          width: 396,
          margin: "0 auto 8px",
          padding: "10px 12px",
          borderRadius: 10,
          border: `2px solid ${canMove ? "#7ee787" : currentTurn.side === "black" ? "#f0c978" : "#7b9cff"}`,
          background: canMove ? "#1f3325" : "#24262b",
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontWeight: "bold", marginBottom: 6 }}>
          {canMove ? "あなたの手番です" : "現在の手番"}
        </div>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span>{currentTurn.moveNumber}手目</span>
          <span>{getSideLabel(currentTurn.side)}</span>
          <PlayerCard participant={currentTurn.player} side={currentTurn.side} compact />
        </div>
        <div style={{ marginTop: 6, color: remainingSeconds === 0 ? "#ff8b8b" : "#ddd", fontSize: 13 }}>
          目安時間: {remainingSeconds}秒 / 超過しても罰則はありません
        </div>
      </div>
    );
  }

  function HandArea(props: { side: TeamSide; hand: HandPieceName[] }) {
    const entries = Object.entries(countHandPieces(props.hand)) as [HandPieceName, number][];
    if (entries.length === 0) return <p>なし</p>;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
        {entries.map(([pieceName, count]) => {
          const isSelectedHand = selectedHandPiece?.side === props.side && selectedHandPiece?.name === pieceName;
          return (
            <button
              key={pieceName}
              onClick={() => selectHandPiece(props.side, pieceName)}
              style={{
                padding: "6px 10px",
                background: isSelectedHand ? "#f7d774" : "#f0c978",
                color: "#111",
                fontWeight: "bold",
                border: "1px solid #8b5a2b",
                cursor: canOperateNow(props.side) ? "pointer" : "not-allowed",
                opacity: canOperateNow(props.side) ? 1 : 0.5,
              }}
            >
              {pieceName}{count > 1 ? `×${count}` : ""}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <main style={{ padding: 24, color: "white", background: "#1e1f22", minHeight: "100vh", fontFamily: "sans-serif", textAlign: "center" }}>
      <h1>リレー将棋</h1>
      <p>状態: {status}</p>
      <p>通信: {socketStatus}</p>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 8 }}>
        <span>あなた:</span>
        {currentUser ? <PlayerCard participant={currentUser} compact /> : <span>未取得</span>}
      </div>
      <p>ホスト: {getHostName()}</p>
      <p>{getCurrentUserRoleText()}</p>
      <p>Instance ID:</p>
      <code>{instanceId}</code>

      <div style={{ marginTop: 12 }}>
        <button onClick={claimHost} disabled={currentUser === null || (hostId !== null && currentUser?.id !== hostId && !testFreeMoveMode)}>ホストになる</button>
        <button onClick={releaseHost} disabled={!isCurrentUserHost()} style={{ marginLeft: 8 }}>ホスト解除</button>
        <button onClick={refreshParticipants} style={{ marginLeft: 8 }}>参加者再取得</button>
        <button onClick={reconnectAndResync} style={{ marginLeft: 8 }}>再接続/同期</button>
        <button onClick={() => setSoundEnabled((v) => !v)} style={{ marginLeft: 8 }}>{soundEnabled ? "効果音ON" : "効果音OFF"}</button>
        <button onClick={() => setTimerSoundEnabled((v) => !v)} style={{ marginLeft: 8 }}>{timerSoundEnabled ? "時計音ON" : "時計音OFF"}</button>
      </div>

      <section
        style={{
          maxWidth: 760,
          margin: "12px auto 0",
          padding: 12,
          borderRadius: 10,
          background: "#24262b",
          border: "1px solid #444",
        }}
      >
        <strong>BGM・通話メモ</strong>
        <div style={{ marginTop: 8, display: "flex", justifyContent: "center", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            BGM
            <select
              value={bgmTrackId}
              onChange={(event) => changeBgmTrack(event.target.value as BgmTrackId)}
              disabled={!isCurrentUserHost()}
            >
              {BGM_TRACKS.map((track) => (
                <option key={track.id} value={track.id}>{track.label}</option>
              ))}
            </select>
          </label>

          <button onClick={toggleServerBgm} disabled={!isCurrentUserHost() || bgmTrackId === "none"}>
            {bgmEnabled ? "BGM停止" : "BGM再生"}
          </button>

          <button onClick={replayBgmLocally}>自分だけBGM再開</button>

          <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            音量
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={bgmVolume}
              onChange={(event) => setBgmVolume(Number(event.target.value))}
            />
          </label>

          <button onClick={() => setTeamMuteNoticeEnabled((value) => !value)}>
            {teamMuteNoticeEnabled ? "味方ミュート案内ON" : "味方ミュート案内OFF"}
          </button>
        </div>

        <p style={{ margin: "8px 0 0", color: "#bbb", fontSize: 13 }}>
          BGMファイルは <code>public/bgm/main.mp3</code> と <code>public/bgm/calm.mp3</code> に置くと全員が同じBGMを選べます。
          ブラウザの仕様で自動再生が止まった場合は「自分だけBGM再開」を押してください。
        </p>

        {teamMuteNoticeEnabled && gameStatus === "playing" && currentTurn && getCurrentUserSide() === currentTurn.side && (
          <p style={{ margin: "8px 0 0", color: "#ffd166", fontWeight: "bold" }}>
            味方チームの手番です。相談禁止で遊ぶ場合は、味方はDiscord側でミュートしてください。
          </p>
        )}

        {getSelectedBgmTrack().url && <audio ref={bgmAudioRef} src={getSelectedBgmTrack().url} loop />}
      </section>

      <section
        style={{
          maxWidth: 760,
          margin: "16px auto 0",
          padding: 12,
          border: "1px solid #444",
          borderRadius: 10,
          background: "#2b2d31",
          textAlign: "left",
          fontSize: 14,
          lineHeight: 1.7,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <strong>接続状態</strong>
          <span style={{ color: getSocketStatusColor(), fontWeight: "bold" }}>{socketStatus}</span>
          <button onClick={() => setShowDebugPanel((value) => !value)}>
            {showDebugPanel ? "詳細を隠す" : "詳細を表示"}
          </button>
        </div>

        <div style={{ marginTop: 6 }}>現在接続中: {getOnlineCountText()} / 最終同期: {lastSyncedAt || "まだ同期なし"}</div>

        {showDebugPanel && (
          <div style={{ marginTop: 10, borderTop: "1px solid #444", paddingTop: 10 }}>
            <div>Socket接続先: <code>{SOCKET_URL || "Vite proxy /socket.io"}</code></div>
            <div>部屋ID: <code>{instanceId}</code></div>
            <div>接続時刻: {socketConnectedAt || "未接続"}</div>
            {socketError && <div style={{ color: "#ff7b72" }}>エラー詳細: {socketError}</div>}
          </div>
        )}
      </section>



      <section
        style={{
          maxWidth: 760,
          margin: "12px auto 0",
          padding: 12,
          border: "1px solid #444",
          borderRadius: 10,
          background: "#24262b",
          textAlign: "left",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <strong>遊び方メモ</strong>
          <button onClick={() => setShowHelpPanel((value) => !value)}>
            {showHelpPanel ? "閉じる" : "開く"}
          </button>
        </div>
        {showHelpPanel && (
          <ul style={{ margin: "10px 0 0", color: "#ddd", lineHeight: 1.7 }}>
            <li>ホストがチーム分けと開始を行います。</li>
            <li>途中参加した人は「途中参加・チーム変更」から先手/後手に入れます。</li>
            <li>進行不能になったら「再接続/同期」→「手番スキップ」→「ロビーに戻る」の順で復旧してください。</li>
            <li>対局終了後は「同じチームで再戦」か「ロビーに戻る」を使います。</li>
          </ul>
        )}
      </section>

      <hr style={{ margin: "20px 0" }} />


      <div
        style={{
          margin: "12px auto",
          padding: 14,
          border: "1px solid #555",
          borderRadius: 10,
          maxWidth: 760,
          background: "#24262b",
        }}
      >
        <strong>対局操作</strong>
        <p style={{ margin: "6px 0 10px", color: "#bbb", fontSize: 13 }}>
          動作が変になった場合は、「再接続/同期」「手番スキップ」「ロビーに戻る」で復旧してください。
        </p>
        <p style={{ margin: "0 0 10px", color: "#ffd166", fontWeight: "bold" }}>
          {getOperationGuideText()}
        </p>

        {pendingConfirm === null && (
          <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
            {gameStatus === "finished" && (
              <button
                onClick={rematchGame}
                style={{
                  minWidth: 160,
                  padding: "10px 16px",
                  background: "#2f6f3e",
                  color: "white",
                  border: "1px solid #5fbf72",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontWeight: "bold",
                }}
              >
                同じチームで再戦
              </button>
            )}
            <button
              onClick={resignGame}
              style={{
                minWidth: 140,
                padding: "10px 16px",
                background: "#7b1e1e",
                color: "white",
                border: "1px solid #aa4444",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              投了する
            </button>
            <button
              onClick={skipTurn}
              style={{
                minWidth: 160,
                padding: "10px 16px",
                background: "#4a4f58",
                color: "white",
                border: "1px solid #777",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              手番スキップ
            </button>
            <button
              onClick={resetGame}
              style={{
                minWidth: 180,
                padding: "10px 16px",
                background: "#3b3f46",
                color: "white",
                border: "1px solid #666",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              ロビーに戻る
            </button>
          </div>
        )}

        {pendingConfirm === "resign" && (
          <div
            style={{
              marginTop: 10,
              padding: 12,
              border: "1px solid #7b1e1e",
              borderRadius: 8,
              background: "#331c1c",
              color: "#ffd166",
            }}
          >
            <p style={{ marginTop: 0 }}>
              本当に{pendingResignSide ? getSideLabel(pendingResignSide) : "このチーム"}として投了しますか？
            </p>
            <button
              onClick={executeResignGame}
              style={{
                marginRight: 8,
                padding: "10px 16px",
                background: "#b3261e",
                color: "white",
                border: "1px solid #ff6b6b",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              はい、投了する
            </button>
            <button
              onClick={cancelConfirm}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              キャンセル
            </button>
          </div>
        )}

        {pendingConfirm === "skip" && (
          <div
            style={{
              marginTop: 10,
              padding: 12,
              border: "1px solid #777",
              borderRadius: 8,
              background: "#303238",
              color: "#ffd166",
            }}
          >
            <p style={{ marginTop: 0 }}>
              本当に現在の手番をスキップしますか？離席・通信切れの復旧用です。
            </p>
            <button
              onClick={executeSkipTurn}
              style={{
                marginRight: 8,
                padding: "10px 16px",
                background: "#5865f2",
                color: "white",
                border: "1px solid #7b84ff",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              はい、スキップする
            </button>
            <button
              onClick={cancelConfirm}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              キャンセル
            </button>
          </div>
        )}

        {pendingConfirm === "reset" && (
          <div
            style={{
              marginTop: 10,
              padding: 12,
              border: "1px solid #666",
              borderRadius: 8,
              background: "#303238",
              color: "#ffd166",
            }}
          >
            <p style={{ marginTop: 0 }}>
              本当にロビーに戻りますか？現在の対局・棋譜・持ち駒は初期化されます。
            </p>
            <button
              onClick={executeResetGame}
              style={{
                marginRight: 8,
                padding: "10px 16px",
                background: "#5865f2",
                color: "white",
                border: "1px solid #7b84ff",
                borderRadius: 8,
                cursor: "pointer",
                fontWeight: "bold",
              }}
            >
              はい、ロビーに戻る
            </button>
            <button
              onClick={cancelConfirm}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              キャンセル
            </button>
          </div>
        )}
      </div>

      {gameStatus === "lobby" && (
        <>
          <h2>ロビー</h2>
          <p style={{ color: "#bbb" }}>緑の丸が表示されている人は、この部屋に現在接続中です。</p>
          <div style={{ marginBottom: 16 }}>
            <button onClick={addDummyPlayers} disabled={hostControlDisabled}>テスト用4人を追加</button>
            <button onClick={autoSplitTeams} disabled={hostControlDisabled} style={{ marginLeft: 8 }}>自動チーム分け</button>
            <button onClick={shuffleTeams} disabled={hostControlDisabled} style={{ marginLeft: 8 }}>チームシャッフル</button>
            <button onClick={swapTeams} disabled={hostControlDisabled} style={{ marginLeft: 8 }}>先手後手を入れ替え</button>
            <button onClick={clearTeams} disabled={hostControlDisabled} style={{ marginLeft: 8 }}>チーム初期化</button>
          </div>

          <div
            style={{
              margin: "0 auto 18px",
              padding: 12,
              maxWidth: 520,
              border: "1px solid #444",
              borderRadius: 10,
              background: "#24262b",
            }}
          >
            <strong>交代設定</strong>
            <p style={{ margin: "6px 0 10px", color: "#bbb" }}>友達間では1手交代が基本、2手交代はじっくり考えたい時向けです。</p>
            <button
              onClick={() => changeTurnsPerPlayer(1)}
              disabled={hostControlDisabled}
              style={{
                marginRight: 8,
                padding: "8px 12px",
                borderRadius: 8,
                border: turnsPerPlayer === 1 ? "2px solid #7ee787" : "1px solid #555",
                background: turnsPerPlayer === 1 ? "#1f6f3a" : "#2b2d31",
                color: "white",
                cursor: hostControlDisabled ? "not-allowed" : "pointer",
              }}
            >
              1手交代
            </button>
            <button
              onClick={() => changeTurnsPerPlayer(2)}
              disabled={hostControlDisabled}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: turnsPerPlayer === 2 ? "2px solid #7ee787" : "1px solid #555",
                background: turnsPerPlayer === 2 ? "#1f6f3a" : "#2b2d31",
                color: "white",
                cursor: hostControlDisabled ? "not-allowed" : "pointer",
              }}
            >
              2手交代
            </button>
          </div>

          {participants.length === 0 ? <p>参加者なし</p> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
              {participants.map((participant) => (
                <div
                  key={participant.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <PlayerCard participant={participant} compact />
                  <button onClick={() => addToTeam(participant, "black")} disabled={hostControlDisabled}>先手へ</button>
                  <button onClick={() => addToTeam(participant, "white")} disabled={hostControlDisabled}>後手へ</button>
                  <button onClick={() => removeFromTeams(participant)} disabled={hostControlDisabled}>外す</button>
                </div>
              ))}
            </div>
          )}

          <h2>チーム分け</h2>
          <div style={{ display: "flex", justifyContent: "center", gap: 24, alignItems: "stretch", flexWrap: "wrap" }}>
            <TeamList title="先手チーム" side="black" members={blackTeam} />
            <TeamList title="後手チーム" side="white" members={whiteTeam} />
          </div>

          <SpectatorList />

          <button onClick={startGame} disabled={!canStartGame() || hostControlDisabled} style={{ marginTop: 24, padding: "10px 20px", fontSize: 16 }}>ゲーム開始</button>
          <p style={{ marginTop: 12 }}>現在の設定：1人あたり連続{turnsPerPlayer}回</p>
          {message && <p style={{ color: "#ffd166", fontWeight: "bold" }}>{message}</p>}
        </>
      )}

      {(gameStatus === "playing" || gameStatus === "finished") && (
        <>
          <h2>{gameStatus === "playing" ? "対局中" : "対局終了"}</h2>

          <section
            style={{
              maxWidth: 760,
              margin: "12px auto 16px",
              padding: 12,
              border: "1px solid #444",
              borderRadius: 10,
              background: "#24262b",
            }}
          >
            <strong>現在のチーム</strong>
            <p style={{ margin: "6px 0 12px", color: "#bbb", fontSize: 13 }}>
              誰が先手・後手に入っているかを確認できます。緑の丸は現在接続中です。
            </p>
            <div style={{ display: "flex", justifyContent: "center", gap: 16, alignItems: "stretch", flexWrap: "wrap" }}>
              <TeamList title="先手チーム" side="black" members={blackTeam} />
              <TeamList title="後手チーム" side="white" members={whiteTeam} />
            </div>
            <SpectatorList />
          </section>

          {currentTurn === null ? <p>手番情報を作成できません。</p> : (
            <section>
              <TurnBanner />

              <LastMovePanel />
              <ReviewControls />

              <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                <input type="checkbox" checked={testFreeMoveMode} onChange={(event) => setTestFreeMoveMode(event.target.checked)} />
                テスト用：制限を無視する
              </label>
              <button onClick={cancelSelection} style={{ marginLeft: 12, padding: "4px 10px" }}>選択解除</button>
              <button
                onClick={resignGame}
                style={{
                  marginLeft: 12,
                  padding: "4px 10px",
                  background: "#7b1e1e",
                  color: "white",
                  border: "1px solid #aa4444",
                  cursor: "pointer",
                }}
              >
                投了
              </button>
              <button
                onClick={skipTurn}
                style={{
                  marginLeft: 12,
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                手番スキップ
              </button>
              <button
                onClick={resetGame}
                style={{
                  marginLeft: 12,
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                ロビーに戻る
              </button>

              <div style={{ marginTop: 12, padding: 10, border: "1px solid #444", borderRadius: 8, display: "inline-block" }}>
                <strong>途中参加・チーム変更</strong>
                <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                  {participants.map((participant) => (
                    <div key={participant.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <PlayerCard participant={participant} compact />
                      <button onClick={() => addToTeam(participant, "black")}>先手へ</button>
                      <button onClick={() => addToTeam(participant, "white")}>後手へ</button>
                      <button onClick={() => removeFromTeams(participant)}>外す</button>
                    </div>
                  ))}
                </div>
                <p style={{ margin: "8px 0 0", color: "#bbb", fontSize: 13 }}>ホストは全員を変更できます。本人は自分だけ途中参加できます。</p>
              </div>

              {message && <p style={{ color: "#ffd166", fontWeight: "bold" }}>{message}</p>}

              {pendingPromotion && (
                <div style={{ margin: "12px 0" }}>
                  <button onClick={() => completeMove(true)} style={{ marginRight: 8, padding: "8px 14px" }}>成る</button>
                  <button onClick={() => completeMove(false)} style={{ padding: "8px 14px" }}>成らない</button>
                </div>
              )}

              <p style={{ marginTop: 12 }}>
                盤面表示: {viewerBottomSide === "black" ? "先手を下に表示" : "後手を下に表示"}
              </p>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "150px 396px 150px",
                  justifyContent: "center",
                  gap: 24,
                  alignItems: "start",
                  marginTop: 16,
                  minHeight: 470,
                }}
              >
                <section style={{ width: 150, minHeight: 420 }}>
                  <h3>{getSideLabel(upperHandSide)} 持ち駒</h3>
                  <HandArea side={upperHandSide} hand={hands[upperHandSide]} />
                </section>

                <section style={{ width: 396 }}>
                  <BoardTurnHeader />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(9, 44px)",
                      gridTemplateRows: "repeat(9, 44px)",
                      width: 396,
                      height: 396,
                      justifyContent: "center",
                      border: "2px solid #d6a85c",
                      boxSizing: "content-box",
                    }}
                  >
                    {getDisplayBoardCells().map(({ row, col, square }) => {
                      const isLastDestination = isLastMoveDestination(row, col);

                      return (
                        <button
                          key={`${row}-${col}`}
                          onClick={() => handleSquareClick(row, col)}
                          style={{
                            width: 44,
                            height: 44,
                            border: isLastDestination ? "2px solid #4caf6a" : "1px solid #8b5a2b",
                            background: isSelected(row, col)
                              ? "#f7d774"
                              : isLastDestination
                                ? "#bfe8b6"
                                : "#f0c978",
                            boxShadow: isLastDestination ? "inset 0 0 0 999px rgba(46, 160, 67, 0.18)" : "none",
                            color: square?.side === "black" ? "#111" : "#7b1e1e",
                            fontWeight: "bold",
                            fontSize: 18,
                            cursor: gameStatus === "playing" ? "pointer" : "not-allowed",
                            transform: square && square.side !== viewerBottomSide ? "rotate(180deg)" : "none",
                            boxSizing: "border-box",
                          }}
                        >
                          {square ? square.name : ""}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section style={{ width: 150, minHeight: 420 }}>
                  <h3>{getSideLabel(lowerHandSide)} 持ち駒</h3>
                  <HandArea side={lowerHandSide} hand={hands[lowerHandSide]} />
                </section>
              </div>

              <p style={{ marginTop: 12 }}>友達間で遊ぶ用の一旦完成版です。観戦者は操作不可、現在指す人だけが操作できます。</p>

              <h3 style={{ marginTop: 24 }}>棋譜ログ</h3>
              {moveHistory.length === 0 ? <p>まだ指し手はありません。</p> : (
                <ol style={{ display: "inline-block", textAlign: "left", maxHeight: 220, overflowY: "auto" }}>
                  {moveHistory.map((move) => (
                    <li key={move.moveNumber}>
                      {move.moveNumber}手目: {getSideLabel(move.side)} {move.playerName} / {move.text}{move.capturedPieceName ? `（${move.capturedPieceName}を取得）` : ""}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}

export default App;

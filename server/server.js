import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3001;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1508095762242994317";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const roomStates = {};
const roomUsers = {};
const hostDisconnectTimers = {};

app.post("/api/token", async (req, res) => {
  try {
    if (!CLIENT_SECRET) {
      return res.status(500).json({
        error: "DISCORD_CLIENT_SECRET is not set",
      });
    }

    const { code } = req.body;

    if (!code) {
      return res.status(400).json({
        error: "code is required",
      });
    }

    const response = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Discord token error:", data);
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error("/api/token error:", error);
    res.status(500).json({
      error: "token exchange failed",
    });
  }
});

function getRoomUserIds(roomId) {
  if (!roomUsers[roomId]) return [];
  return Array.from(new Set(Object.values(roomUsers[roomId]).filter(Boolean)));
}

function emitRoomUsers(roomId) {
  io.to(roomId).emit("room-users", getRoomUserIds(roomId));
}

function cancelHostTimer(roomId) {
  if (hostDisconnectTimers[roomId]) {
    clearTimeout(hostDisconnectTimers[roomId]);
    delete hostDisconnectTimers[roomId];
  }
}

function scheduleHostHandoff(roomId, leavingUserId) {
  cancelHostTimer(roomId);

  hostDisconnectTimers[roomId] = setTimeout(() => {
    const state = roomStates[roomId];
    if (!state) return;
    if (state.hostId !== leavingUserId) return;

    const remainingUserIds = getRoomUserIds(roomId).filter(
      (id) => id !== leavingUserId
    );

    const nextHostId = remainingUserIds.length > 0 ? remainingUserIds[0] : null;

    const nextState = {
      ...state,
      hostId: nextHostId,
      message:
        nextHostId === null
          ? "ホストが退出しました。必要なら誰かがホストになってください。"
          : "ホストが退出したため、別の参加者にホストを引き継ぎました。",
    };

    roomStates[roomId] = nextState;
    io.to(roomId).emit("game-state", nextState);

    delete hostDisconnectTimers[roomId];
  }, 5000);
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join-room", (roomId) => {
    if (!roomId) return;

    socket.join(roomId);
    socket.data.roomId = roomId;

    if (!roomUsers[roomId]) {
      roomUsers[roomId] = {};
    }

    if (roomStates[roomId]) {
      socket.emit("game-state", roomStates[roomId]);
    }

    emitRoomUsers(roomId);
  });

  socket.on("register-user", ({ roomId, userId }) => {
    if (!roomId || !userId) return;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userId = userId;

    if (!roomUsers[roomId]) {
      roomUsers[roomId] = {};
    }

    roomUsers[roomId][socket.id] = userId;

    const state = roomStates[roomId];

    if (state?.hostId === userId) {
      cancelHostTimer(roomId);
    }

    if (state) {
      socket.emit("game-state", state);
    }

    emitRoomUsers(roomId);
  });

  socket.on("game-state", ({ roomId, state }) => {
    if (!roomId || !state) return;

    roomStates[roomId] = state;
    socket.to(roomId).emit("game-state", state);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    const userId = socket.data.userId;

    if (!roomId || !roomUsers[roomId]) return;

    delete roomUsers[roomId][socket.id];
    emitRoomUsers(roomId);

    const state = roomStates[roomId];

    if (!state || !userId) return;

    const sameUserStillConnected = getRoomUserIds(roomId).includes(userId);

    if (state.hostId === userId && !sameUserStillConnected) {
      scheduleHostHandoff(roomId, userId);
    }
  });
});

const distPath = path.join(__dirname, "../dist");
app.use(express.static(distPath));

app.use((req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

server.listen(PORT, () => {
  console.log(`Relay Shogi production server running on port ${PORT}`);
});
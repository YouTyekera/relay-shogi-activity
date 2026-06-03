import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "1508095762242994317";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/token", async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: "code is required" });
    }

    if (!CLIENT_SECRET) {
      return res.status(500).json({ error: "CLIENT_SECRET is not set" });
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
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error("token error:", error);
    res.status(500).json({ error: "token exchange failed" });
  }
});

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

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

    io.to(roomId).emit("room-users", Object.keys(roomUsers[roomId]));
  });

  socket.on("register-user", ({ roomId, userId, user }) => {
    if (!roomId || !userId) return;

    if (!roomUsers[roomId]) {
      roomUsers[roomId] = {};
    }

    roomUsers[roomId][userId] = {
      socketId: socket.id,
      userId,
      user: user || null,
      lastSeen: Date.now(),
    };

    socket.data.roomId = roomId;
    socket.data.userId = userId;

    socket.join(roomId);

    if (roomStates[roomId]) {
      socket.emit("game-state", roomStates[roomId]);
    }

    io.to(roomId).emit("room-users", Object.keys(roomUsers[roomId]));
  });

  socket.on("game-state", ({ roomId, state }) => {
    if (!roomId || !state) return;

    roomStates[roomId] = {
      ...state,
      updatedAt: Date.now(),
    };

    socket.to(roomId).emit("game-state", roomStates[roomId]);
  });

  socket.on("request-state", (roomId) => {
    if (!roomId) return;

    if (roomStates[roomId]) {
      socket.emit("game-state", roomStates[roomId]);
    }
  });

  socket.on("clear-room-state", (roomId) => {
    if (!roomId) return;

    delete roomStates[roomId];
    io.to(roomId).emit("game-state-cleared");
  });

  socket.on("disconnect", () => {
    const { roomId, userId } = socket.data;

    if (roomId && userId && roomUsers[roomId]?.[userId]) {
      delete roomUsers[roomId][userId];
      io.to(roomId).emit("room-users", Object.keys(roomUsers[roomId]));
    }

    console.log("socket disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`server listening on port ${PORT}`);
});
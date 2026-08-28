import "dotenv/config";

import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "node:crypto";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import cron from "node-cron";
import { Resvg } from "@resvg/resvg-js";

import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

/* =========================================================
 * 基本設定
 * ======================================================= */

const PORT = process.env.PORT || 3001;

/*
 * =========================
 * 三人将棋 Discord
 * =========================
 *
 * 既存の環境変数をそのまま使用します。
 */
const SHOGI_CLIENT_ID =
  process.env.DISCORD_CLIENT_ID ||
  "1508095762242994317";

const SHOGI_CLIENT_SECRET =
  process.env.DISCORD_CLIENT_SECRET;

/*
 * =========================
 * ことばル Discord
 * =========================
 *
 * 三人将棋とは別Applicationなので、
 * 環境変数も完全に分けます。
 */
const KOTOBARU_CLIENT_ID =
  process.env.KOTOBARU_DISCORD_CLIENT_ID?.trim();


const KOTOBARU_CLIENT_SECRET =
  process.env.KOTOBARU_DISCORD_CLIENT_SECRET?.trim();

const KOTOBARU_BOT_TOKEN =
  process.env.KOTOBARU_DISCORD_TOKEN?.trim();

const KOTOBARU_LOG_ENCRYPTION_KEY =
  process.env.KOTOBARU_LOG_ENCRYPTION_KEY?.trim() ||
  "";

/* =========================================================
 * Discord REST API
 *
 * ことばルの主要処理は、
 * Discord Gateway接続に依存せず
 * REST APIで実行します。
 * ======================================================= */

const DISCORD_API =
  "https://discord.com/api/v10";

function wait(
  milliseconds
) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        milliseconds
      )
  );
}

async function discordRest(
  endpoint,
  options = {},
  attempt = 1
) {
  if (
    !KOTOBARU_BOT_TOKEN
  ) {
    throw new Error(
      "KOTOBARU_DISCORD_TOKEN がありません"
    );
  }

  const response =
    await fetch(
      `${DISCORD_API}${endpoint}`,
      {
        ...options,

        headers: {
          Authorization:
            `Bot ${KOTOBARU_BOT_TOKEN}`,

          "Content-Type":
            "application/json",

          ...(options.headers ||
            {}),
        },
      }
    );

  /*
   * Discordの429
   * Rate Limit
   */
  if (
    response.status ===
      429 &&
    attempt <= 5
  ) {
    let retryAfter =
      2;

    try {
      const data =
        await response.json();

      retryAfter =
        Number(
          data.retry_after
        ) || 2;
    } catch {
      // JSONでなくても2秒待つ
    }

    console.warn(
      `Discord REST Rate Limit。${retryAfter}秒待って再試行します。`
    );

    await wait(
      Math.ceil(
        retryAfter *
          1000
      )
    );

    return discordRest(
      endpoint,
      options,
      attempt + 1
    );
  }

  return response;
}

async function discordRestMultipart(
  endpoint,
  method,
  payload,
  files = [],
  attempt = 1
) {
  if (
    !KOTOBARU_BOT_TOKEN
  ) {
    throw new Error(
      "KOTOBARU_DISCORD_TOKEN がありません"
    );
  }

  const form =
    new FormData();

  form.append(
    "payload_json",
    JSON.stringify(payload)
  );

  files.forEach(
    (file, index) => {
      form.append(
        `files[${index}]`,
        new Blob(
          [file.data],
          {
            type:
              file.contentType ||
              "application/octet-stream",
          }
        ),
        file.name
      );
    }
  );

  const response =
    await fetch(
      `${DISCORD_API}${endpoint}`,
      {
        method,
        headers: {
          Authorization:
            `Bot ${KOTOBARU_BOT_TOKEN}`,
        },
        body: form,
      }
    );

  if (
    response.status ===
      429 &&
    attempt <= 5
  ) {
    let retryAfter = 2;

    try {
      const data =
        await response.json();

      retryAfter =
        Number(
          data.retry_after
        ) || 2;
    } catch {
      // JSONでなくても2秒待つ
    }

    console.warn(
      `Discord REST Rate Limit。${retryAfter}秒待って再試行します。`
    );

    await wait(
      Math.ceil(
        retryAfter *
          1000
      )
    );

    return discordRestMultipart(
      endpoint,
      method,
      payload,
      files,
      attempt + 1
    );
  }

  return response;
}

  /* =========================================================
 * パス
 * ======================================================= */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

/* =========================================================
 * Preview画像用 日本語フォント
 *
 * Renderには日本語フォントが入っていないことがあるため、
 * npmパッケージとしてSource Han Sansを読み込みます。
 * ======================================================= */

const KOTOBARU_FONT_DIR =
  path.join(
    process.cwd(),
    "node_modules",
    "@fontpkg",
    "source-han-sans-hw"
  );

function findKotobaruFontFile(
  filename
) {
  if (
    !fs.existsSync(
      KOTOBARU_FONT_DIR
    )
  ) {
    return null;
  }

  const queue = [
    KOTOBARU_FONT_DIR,
  ];

  while (
    queue.length
  ) {
    const current =
      queue.shift();

    let entries;

    try {
      entries =
        fs.readdirSync(
          current,
          {
            withFileTypes:
              true,
          }
        );
    } catch {
      continue;
    }

    for (
      const entry of
      entries
    ) {
      const fullPath =
        path.join(
          current,
          entry.name
        );

      if (
        entry.isDirectory()
      ) {
        queue.push(
          fullPath
        );
      } else if (
        entry.name ===
          filename
      ) {
        return fullPath;
      }
    }
  }

  return null;
}

const KOTOBARU_FONT_FILES = [
  findKotobaruFontFile(
    "SourceHanSansHW-Regular.otf"
  ),
  findKotobaruFontFile(
    "SourceHanSansHW-Bold.otf"
  ),
].filter(Boolean);

if (
  !KOTOBARU_FONT_FILES.length
) {
  console.warn(
    "ことばルPreview用の日本語フォントが見つかりません。@fontpkg/source-han-sans-hw をインストールしてください。"
  );
}

/* =========================================================
 * Express
 * ======================================================= */

const app = express();

app.use(
  express.json({
    limit: "100kb",
  })
);

const server =
  http.createServer(app);

/* =========================================================
 * Socket.IO
 *
 * ここから三人将棋用
 * ======================================================= */

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: [
      "GET",
      "POST",
    ],
  },
});

const roomStates = {};
const roomUsers = {};
const hostDisconnectTimers = {};

/* =========================================================
 * 三人将棋 OAuth
 *
 * 既存URLをそのまま維持。
 * ======================================================= */

app.post(
  "/api/token",
  async (req, res) => {
    try {
      if (!SHOGI_CLIENT_SECRET) {
        return res
          .status(500)
          .json({
            error:
              "DISCORD_CLIENT_SECRET is not set",
          });
      }

      const { code } =
        req.body;

      if (!code) {
        return res
          .status(400)
          .json({
            error:
              "code is required",
          });
      }

      const response =
        await fetch(
          "https://discord.com/api/oauth2/token",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded",
            },

            body:
              new URLSearchParams({
                client_id:
                  SHOGI_CLIENT_ID,

                client_secret:
                  SHOGI_CLIENT_SECRET,

                grant_type:
                  "authorization_code",

                code,
              }),
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        console.error(
          "Discord token error:",
          data
        );

        return res
          .status(
            response.status
          )
          .json(data);
      }

      return res.json(data);
    } catch (error) {
      console.error(
        "/api/token error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "token exchange failed",
        });
    }
  }
);

/* =========================================================
 * 三人将棋
 * Socket.IO補助関数
 * ======================================================= */

function getRoomUserIds(
  roomId
) {
  if (!roomUsers[roomId]) {
    return [];
  }

  return Array.from(
    new Set(
      Object.values(
        roomUsers[roomId]
      ).filter(Boolean)
    )
  );
}

function emitRoomUsers(
  roomId
) {
  io.to(roomId).emit(
    "room-users",
    getRoomUserIds(roomId)
  );
}

function cancelHostTimer(
  roomId
) {
  if (
    hostDisconnectTimers[
      roomId
    ]
  ) {
    clearTimeout(
      hostDisconnectTimers[
        roomId
      ]
    );

    delete hostDisconnectTimers[
      roomId
    ];
  }
}

function scheduleHostHandoff(
  roomId,
  leavingUserId
) {
  cancelHostTimer(roomId);

  hostDisconnectTimers[
    roomId
  ] = setTimeout(() => {
    const state =
      roomStates[roomId];

    if (!state) return;

    if (
      state.hostId !==
      leavingUserId
    ) {
      return;
    }

    const remainingUserIds =
      getRoomUserIds(
        roomId
      ).filter(
        (id) =>
          id !== leavingUserId
      );

    const nextHostId =
      remainingUserIds.length >
      0
        ? remainingUserIds[0]
        : null;

    const nextState = {
      ...state,

      hostId:
        nextHostId,

      message:
        nextHostId === null
          ? "ホストが退出しました。必要なら誰かがホストになってください。"
          : "ホストが退出したため、別の参加者にホストを引き継ぎました。",
    };

    roomStates[
      roomId
    ] = nextState;

    io.to(roomId).emit(
      "game-state",
      nextState
    );

    delete hostDisconnectTimers[
      roomId
    ];
  }, 5000);
}

/* =========================================================
 * 三人将棋 Socket.IO
 * ======================================================= */

io.on(
  "connection",
  (socket) => {
    console.log(
      "Socket connected:",
      socket.id
    );

    socket.on(
      "join-room",
      (roomId) => {
        if (!roomId) {
          return;
        }

        socket.join(
          roomId
        );

        socket.data.roomId =
          roomId;

        if (
          !roomUsers[
            roomId
          ]
        ) {
          roomUsers[
            roomId
          ] = {};
        }

        if (
          roomStates[
            roomId
          ]
        ) {
          socket.emit(
            "game-state",
            roomStates[
              roomId
            ]
          );
        }

        emitRoomUsers(
          roomId
        );
      }
    );

    socket.on(
      "register-user",
      ({
        roomId,
        userId,
      }) => {
        if (
          !roomId ||
          !userId
        ) {
          return;
        }

        socket.join(
          roomId
        );

        socket.data.roomId =
          roomId;

        socket.data.userId =
          userId;

        if (
          !roomUsers[
            roomId
          ]
        ) {
          roomUsers[
            roomId
          ] = {};
        }

        roomUsers[
          roomId
        ][socket.id] =
          userId;

        const state =
          roomStates[
            roomId
          ];

        if (
          state?.hostId ===
          userId
        ) {
          cancelHostTimer(
            roomId
          );
        }

        if (state) {
          socket.emit(
            "game-state",
            state
          );
        }

        emitRoomUsers(
          roomId
        );
      }
    );

    socket.on(
      "game-state",
      ({
        roomId,
        state,
      }) => {
        if (
          !roomId ||
          !state
        ) {
          return;
        }

        roomStates[
          roomId
        ] = state;

        socket
          .to(roomId)
          .emit(
            "game-state",
            state
          );
      }
    );

    socket.on(
      "disconnect",
      () => {
        const roomId =
          socket.data.roomId;

        const userId =
          socket.data.userId;

        if (
          !roomId ||
          !roomUsers[
            roomId
          ]
        ) {
          return;
        }

        delete roomUsers[
          roomId
        ][socket.id];

        emitRoomUsers(
          roomId
        );

        const state =
          roomStates[
            roomId
          ];

        if (
          !state ||
          !userId
        ) {
          return;
        }

        const sameUserStillConnected =
          getRoomUserIds(
            roomId
          ).includes(
            userId
          );

        if (
          state.hostId ===
            userId &&
          !sameUserStillConnected
        ) {
          scheduleHostHandoff(
            roomId,
            userId
          );
        }
      }
    );
  }
);

/* =========================================================
 *
 * ここから「ことばル」
 *
 * ======================================================= */

/* =========================================================
 * ことばルBot
 * ======================================================= */

const kotobaruBot =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });

const RECORD_PREFIX =
  "KOTOBARU_RECORD:";

const PROGRESS_PREFIX =
  "KOTOBARU_PROGRESS:";

const SUMMARY_MARKER_PREFIX =
  "KOTOBARU_SUMMARY_POSTED:";

const LIVE_CARD_MARKER_PREFIX =
  "KOTOBARU_LIVE_CARD:";

const LIVE_SESSION_MARKER_PREFIX =
  "KOTOBARU_LIVE_SESSION:";

const CONFIG_TOPIC_PREFIX =
  "KOTOBARU_LOG_CHANNEL:";

const LIVE_SESSION_WINDOW_MS =
  60 * 60 * 1000;

const SUPPRESS_NOTIFICATIONS_FLAG =
  1 << 12;

/*
 * 今日プレイ中の途中経過。
 * セッションごとに分けて保持します。
 */
const liveProgressByGuild =
  new Map();

/*
 * ユーザーがどのセッションで遊び始めたか。
 * 1時間を超えて遊んでも、その人の盤面は開始した枠を更新します。
 */
const liveSessionByUser =
  new Map();

/*
 * 各サーバー・日付で現在使っているセッション。
 */
const liveSessionCache =
  new Map();

const finishedRecordsCache =
  new Map();

/*
 * 1ユーザー・1日につき1件の暗号化LOGメッセージ。
 * Render再起動時はDiscordログから再探索します。
 */
const progressLogMessageIds =
  new Map();

/*
 * Discord CDNのアイコン画像を毎回取り直さないためのキャッシュ。
 */
const avatarDataCache =
  new Map();

/*
 * サーバーごとの設定を
 * メモリにもキャッシュします。
 *
 * 本体はDiscordのチャンネルトピックに
 * 保存されるので、
 * Render再起動でも復元できます。
 */
const guildConfigs =
  new Map();

/*
 * 起動カード掃除の多重実行を防ぐための管理。
 * 同じチャンネルで複数人がほぼ同時にActivityを起動しても、
 * 1セットの走査だけを実行します。
 */
const launchCleanupScheduledUntil =
  new Map();

/* =========================================================
 * 日本時間
 * ======================================================= */

function jstDateKey(
  date = new Date()
) {
  return new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone:
        "Asia/Tokyo",

      year:
        "numeric",

      month:
        "2-digit",

      day:
        "2-digit",
    }
  ).format(date);
}

function previousJstDateKey() {
  const today =
    jstDateKey();

  const [
    year,
    month,
    day,
  ] = today
    .split("-")
    .map(Number);

  return jstDateKey(
    new Date(
      Date.UTC(
        year,
        month - 1,
        day - 1,
        12
      )
    )
  );
}

/* =========================================================
 * 回答単語の暗号化
 *
 * DiscordのLOGには平文を残さず、翌日の集計時だけ復号します。
 * KOTOBARU_LOG_ENCRYPTION_KEY は32byteのBase64を想定します。
 * ======================================================= */

function getKotobaruEncryptionKey() {
  if (!KOTOBARU_LOG_ENCRYPTION_KEY) {
    return null;
  }

  try {
    const key =
      Buffer.from(
        KOTOBARU_LOG_ENCRYPTION_KEY,
        "base64"
      );

    return key.length === 32
      ? key
      : null;
  } catch {
    return null;
  }
}

function encryptKotobaruGuesses(
  guesses
) {
  if (
    !Array.isArray(guesses) ||
    guesses.length === 0
  ) {
    return null;
  }

  const key =
    getKotobaruEncryptionKey();

  if (!key) {
    console.warn(
      "KOTOBARU_LOG_ENCRYPTION_KEY が未設定または不正なため、回答単語はLOGへ保存しません。"
    );

    return null;
  }

  const iv =
    crypto.randomBytes(12);

  const cipher =
    crypto.createCipheriv(
      "aes-256-gcm",
      key,
      iv
    );

  const plain =
    JSON.stringify(guesses);

  const encrypted =
    Buffer.concat([
      cipher.update(
        plain,
        "utf8"
      ),
      cipher.final(),
    ]);

  const tag =
    cipher.getAuthTag();

  return {
    version: 1,
    algorithm:
      "aes-256-gcm",
    iv:
      iv.toString("base64"),
    tag:
      tag.toString("base64"),
    data:
      encrypted.toString("base64"),
  };
}

function decryptKotobaruGuesses(
  encrypted
) {
  if (
    !encrypted ||
    encrypted.version !== 1 ||
    encrypted.algorithm !==
      "aes-256-gcm"
  ) {
    return null;
  }

  const key =
    getKotobaruEncryptionKey();

  if (!key) {
    return null;
  }

  try {
    const decipher =
      crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(
          encrypted.iv,
          "base64"
        )
      );

    decipher.setAuthTag(
      Buffer.from(
        encrypted.tag,
        "base64"
      )
    );

    const plain =
      Buffer.concat([
        decipher.update(
          Buffer.from(
            encrypted.data,
            "base64"
          )
        ),
        decipher.final(),
      ]).toString("utf8");

    const guesses =
      JSON.parse(plain);

    return Array.isArray(guesses)
      ? guesses.filter(
          (guess) =>
            typeof guess ===
              "string"
        )
      : null;
  } catch (error) {
    console.warn(
      "ことばル回答単語の復号に失敗しました:",
      error?.message || error
    );

    return null;
  }
}

function validateOptionalGuesses(
  body
) {
  if (
    body.guesses ===
      undefined
  ) {
    /*
     * 旧バージョンのActivityとも互換性を保ちます。
     */
    return true;
  }

  if (
    !Array.isArray(
      body.guesses
    ) ||
    body.guesses.length < 1 ||
    body.guesses.length > 6 ||
    body.guesses.length !==
      body.pattern.length
  ) {
    return false;
  }

  return body.guesses.every(
    (guess) =>
      typeof guess ===
        "string" &&
      Array.from(guess).length >= 1 &&
      Array.from(guess).length <= 20
  );
}

/* =========================================================
 * ことばル結果の検証
 * ======================================================= */

function validateKotobaruResult(
  body
) {
  if (
    !body ||
    typeof body !==
      "object"
  ) {
    return false;
  }

  const requiredStrings = [
    "guildId",
    "userId",
    "displayName",
    "date",
  ];

  if (
    requiredStrings.some(
      (key) =>
        typeof body[
          key
        ] !==
          "string" ||
        !body[
          key
        ]
    )
  ) {
    return false;
  }

  if (
    !Number.isInteger(
      body.puzzleNumber
    ) ||
    body.puzzleNumber <
      1
  ) {
    return false;
  }

  if (
    typeof body.won !==
    "boolean"
  ) {
    return false;
  }

  if (
    body.attempts !==
      null &&
    (
      !Number.isInteger(
        body.attempts
      ) ||
      body.attempts <
        1 ||
      body.attempts >
        6
    )
  ) {
    return false;
  }

  if (
    !Array.isArray(
      body.pattern
    ) ||
    body.pattern.length <
      1 ||
    body.pattern.length >
      6
  ) {
    return false;
  }

  return (
    body.pattern.every(
      (row) =>
        typeof row ===
          "string" &&
        /^[🟩🟨🟪⬛]{5}$/u.test(
          row
        )
    ) &&
    validateOptionalGuesses(
      body
    )
  );
}

/* =========================================================
 * ことばル途中経過の検証
 * ======================================================= */

function validateKotobaruProgress(
  body
) {
  if (
    !body ||
    typeof body !==
      "object"
  ) {
    return false;
  }

  const requiredStrings = [
    "guildId",
    "userId",
    "displayName",
    "date",
  ];

  if (
    requiredStrings.some(
      (key) =>
        typeof body[key] !==
          "string" ||
        !body[key]
    )
  ) {
    return false;
  }

  if (
    !Number.isInteger(
      body.puzzleNumber
    ) ||
    body.puzzleNumber < 1
  ) {
    return false;
  }

  if (
    typeof body.finished !==
      "boolean" ||
    typeof body.won !==
      "boolean"
  ) {
    return false;
  }

  if (
    body.attempts !== null &&
    (
      !Number.isInteger(
        body.attempts
      ) ||
      body.attempts < 1 ||
      body.attempts > 6
    )
  ) {
    return false;
  }

  if (
    !Array.isArray(
      body.pattern
    ) ||
    body.pattern.length < 1 ||
    body.pattern.length > 6
  ) {
    return false;
  }

  return (
    body.pattern.every(
      (row) =>
        typeof row ===
          "string" &&
        /^[🟩🟨🟪⬛]{5}$/u.test(
          row
        )
    ) &&
    validateOptionalGuesses(
      body
    )
  );
}

/* =========================================================
 * Discordチャンネルから
 * ことばル設定を読む
 * ======================================================= */

function configFromTopic(
  channel
) {
  if (
    channel.type !==
    ChannelType.GuildText
  ) {
    return null;
  }

  const topic =
    channel.topic || "";

  if (
    !topic.startsWith(
      CONFIG_TOPIC_PREFIX
    )
  ) {
    return null;
  }

  const configHead =
    topic
      .slice(
        CONFIG_TOPIC_PREFIX.length
      )
      .split(
        /\s|\|/
      )[0]
      ?.trim();

  if (!configHead) {
    return null;
  }

  const [
    summaryChannelId,
    updatedAtRaw,
  ] = configHead.split(":");

  if (
    !summaryChannelId
  ) {
    return null;
  }

  return {
    guildId:
      channel.guildId,

    logChannelId:
      channel.id,

    summaryChannelId,

    updatedAt:
      Number(updatedAtRaw) ||
      0,
  };
}

async function refreshKotobaruGuildConfig(
  guild
) {
  await guild.channels
    .fetch()
    .catch(
      () => null
    );

  const configs = [];

  for (
    const channel of
    guild.channels.cache.values()
  ) {
    const config =
      configFromTopic(
        channel
      );

    if (config) {
      configs.push(
        config
      );
    }
  }

  if (!configs.length) {
    guildConfigs.delete(
      guild.id
    );

    return null;
  }

  configs.sort(
    (a, b) =>
      b.updatedAt -
      a.updatedAt
  );

  const newest =
    configs[0];

  guildConfigs.set(
    guild.id,
    newest
  );

  return newest;
}

async function getKotobaruGuildConfig(
  guildId
) {
  const cached =
    guildConfigs.get(
      guildId
    );

  if (cached) {
    return cached;
  }

  try {
    const response =
      await discordRest(
        `/guilds/${guildId}/channels`
      );

    if (!response.ok) {
      console.error(
        "ことばル設定取得失敗:",
        response.status,
        await response
          .text()
          .catch(
            () => ""
          )
      );

      return null;
    }

    const channels =
      await response.json();

    const configs = [];

    for (
      const channel of
      channels
    ) {
      if (
        channel.type !== 0
      ) {
        continue;
      }

      const topic =
        channel.topic || "";

      if (
        !topic.startsWith(
          CONFIG_TOPIC_PREFIX
        )
      ) {
        continue;
      }

      const configHead =
        topic
          .slice(
            CONFIG_TOPIC_PREFIX.length
          )
          .split(
            /\s|\|/
          )[0]
          ?.trim();

      if (!configHead) {
        continue;
      }

      const [
        summaryChannelId,
        updatedAtRaw,
      ] = configHead.split(":");

      if (
        !summaryChannelId
      ) {
        continue;
      }

      configs.push({
        guildId,

        logChannelId:
          channel.id,

        summaryChannelId,

        updatedAt:
          Number(updatedAtRaw) ||
          0,
      });
    }

    if (!configs.length) {
      return null;
    }

    configs.sort(
      (a, b) =>
        b.updatedAt -
        a.updatedAt
    );

    const newest =
      configs[0];

    guildConfigs.set(
      guildId,
      newest
    );

    return newest;

  } catch (error) {
    console.error(
      "ことばル設定REST取得エラー:",
      error
    );
  }

  return null;
}

async function getKotobaruTextChannel(
  channelId
) {
  if (!channelId) {
    return null;
  }

  const channel =
    await kotobaruBot.channels
      .fetch(
        channelId
      )
      .catch(
        () => null
      );

  return channel
    ?.isTextBased()
    ? channel
    : null;
}
/* =========================================================
 * Bot Ready待機
 *
 * Render起動直後に結果が来ても
 * 即503にしないため。
 * ======================================================= */

async function waitForKotobaruBotReady(
  timeoutMs = 20000
) {
  if (
    kotobaruBot.isReady()
  ) {
    return true;
  }

  const started =
    Date.now();

  while (
    Date.now() -
      started <
    timeoutMs
  ) {
    if (
      kotobaruBot.isReady()
    ) {
      return true;
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          500
        )
    );
  }

  return kotobaruBot.isReady();
}
/* =========================================================
 * Discord RESTでチャンネル履歴を読む
 * ======================================================= */

async function fetchRecentKotobaruMessagesRest(
  channelId,
  max = 500
) {
  const result = [];
  let before;

  while (
    result.length < max
  ) {
    const limit =
      Math.min(
        100,
        max - result.length
      );

    const query =
      new URLSearchParams({
        limit:
          String(limit),
      });

    if (before) {
      query.set(
        "before",
        before
      );
    }

    const response =
      await discordRest(
        `/channels/${channelId}/messages?${query.toString()}`
      );

    if (!response.ok) {
      throw new Error(
        `Discordメッセージ取得失敗: HTTP ${response.status}`
      );
    }

    const batch =
      await response.json();

    if (
      !Array.isArray(batch) ||
      !batch.length
    ) {
      break;
    }

    result.push(
      ...batch
    );

    before =
      batch[
        batch.length - 1
      ]?.id;

    if (
      batch.length < limit
    ) {
      break;
    }
  }

  return result;
}

/* =========================================================
 * 指定日の終了済み結果を読む
 * ======================================================= */

async function loadKotobaruParticipantsForDate(
  guildId,
  date
) {
  const config =
    await getKotobaruGuildConfig(
      guildId
    );

  if (!config) {
    return [];
  }

  const messages =
    await fetchRecentKotobaruMessagesRest(
      config.logChannelId,
      1000
    );

  const byUser =
    new Map();

  /*
   * 新形式：1ユーザー1日1メッセージ。
   * 編集によって最新状態が入っているので、これを最優先します。
   */
  for (
    const message of
    messages
  ) {
    if (
      !message.author?.bot ||
      typeof message.content !==
        "string" ||
      !message.content.startsWith(
        PROGRESS_PREFIX
      )
    ) {
      continue;
    }

    try {
      const record =
        JSON.parse(
          message.content.slice(
            PROGRESS_PREFIX.length
          )
        );

      if (
        record.guildId !==
          guildId ||
        record.date !==
          date ||
        typeof record.userId !==
          "string"
      ) {
        continue;
      }

      byUser.set(
        record.userId,
        {
          ...record,
          logMessageId:
            message.id,
        }
      );
    } catch {
      // 壊れた進捗記録は無視
    }
  }

  /*
   * 旧形式 RECORD は後方互換用。
   * 新形式がない人だけ読み込みます。
   */
  for (
    const message of
    messages
  ) {
    if (
      !message.author?.bot ||
      typeof message.content !==
        "string" ||
      !message.content.startsWith(
        RECORD_PREFIX
      )
    ) {
      continue;
    }

    try {
      const record =
        JSON.parse(
          message.content.slice(
            RECORD_PREFIX.length
          )
        );

      if (
        record.guildId !==
          guildId ||
        record.date !==
          date ||
        byUser.has(
          record.userId
        )
      ) {
        continue;
      }

      byUser.set(
        record.userId,
        {
          ...record,
          finished: true,
        }
      );
    } catch {
      // 壊れた旧記録は無視
    }
  }

  return [
    ...byUser.values(),
  ];
}

async function loadKotobaruResultsForDate(
  guildId,
  date
) {
  const participants =
    await loadKotobaruParticipantsForDate(
      guildId,
      date
    );

  return participants.filter(
    (record) =>
      record.finished === true
  );
}

/* =========================================================
 * 暗号化した途中経過LOGを1ユーザー1日1件で更新
 * ======================================================= */

function progressLogCacheKey(
  guildId,
  date,
  userId
) {
  return `${guildId}:${date}:${userId}`;
}

async function findKotobaruProgressLogMessageId(
  config,
  guildId,
  date,
  userId
) {
  const key =
    progressLogCacheKey(
      guildId,
      date,
      userId
    );

  const cached =
    progressLogMessageIds.get(
      key
    );

  if (cached) {
    return cached;
  }

  const messages =
    await fetchRecentKotobaruMessagesRest(
      config.logChannelId,
      1000
    );

  for (
    const message of
    messages
  ) {
    if (
      !message.author?.bot ||
      typeof message.content !==
        "string" ||
      !message.content.startsWith(
        PROGRESS_PREFIX
      )
    ) {
      continue;
    }

    try {
      const record =
        JSON.parse(
          message.content.slice(
            PROGRESS_PREFIX.length
          )
        );

      if (
        record.guildId ===
          guildId &&
        record.date ===
          date &&
        record.userId ===
          userId
      ) {
        progressLogMessageIds.set(
          key,
          message.id
        );

        return message.id;
      }
    } catch {
      // 壊れたメッセージは無視
    }
  }

  return null;
}

async function upsertKotobaruProgressLog(
  config,
  record,
  guesses
) {
  const encrypted =
    encryptKotobaruGuesses(
      guesses
    );

  const safeRecord = {
    guildId:
      record.guildId,
    userId:
      record.userId,
    displayName:
      record.displayName,
    avatarHash:
      record.avatarHash ??
      null,
    sessionId:
      record.sessionId ??
      null,
    puzzleNumber:
      record.puzzleNumber,
    date:
      record.date,
    attempts:
      record.attempts,
    won:
      Boolean(
        record.won
      ),
    finished:
      Boolean(
        record.finished
      ),
    pattern:
      record.pattern,
    guessesEncrypted:
      encrypted,
    updatedAt:
      new Date()
        .toISOString(),
    ...(record.finished
      ? {
          savedAt:
            record.savedAt ||
            new Date()
              .toISOString(),
        }
      : {}),
  };

  const content =
    `${PROGRESS_PREFIX}${JSON.stringify(
      safeRecord
    )}`;

  const existingId =
    await findKotobaruProgressLogMessageId(
      config,
      record.guildId,
      record.date,
      record.userId
    );

  if (existingId) {
    const response =
      await discordRest(
        `/channels/${config.logChannelId}/messages/${existingId}`,
        {
          method:
            "PATCH",
          body:
            JSON.stringify({
              content,
            }),
        }
      );

    if (response.ok) {
      return existingId;
    }

    console.warn(
      "ことばル進捗LOG更新失敗。新規作成へ切り替えます:",
      response.status
    );
  }

  const response =
    await discordRest(
      `/channels/${config.logChannelId}/messages`,
      {
        method:
          "POST",
        body:
          JSON.stringify({
            content,
            flags:
              SUPPRESS_NOTIFICATIONS_FLAG,
          }),
      }
    );

  if (!response.ok) {
    throw new Error(
      `ことばル進捗LOG保存失敗: HTTP ${response.status}`
    );
  }

  const created =
    await response.json();

  progressLogMessageIds.set(
    progressLogCacheKey(
      record.guildId,
      record.date,
      record.userId
    ),
    created.id
  );

  return created.id;
}

/* =========================================================
 * 終了済み結果のキャッシュ
 * ======================================================= */

async function getCachedKotobaruResults(
  guildId,
  date
) {
  const key =
    `${guildId}:${date}`;

  if (
    finishedRecordsCache.has(
      key
    )
  ) {
    return [
      ...finishedRecordsCache
        .get(key)
        .values(),
    ];
  }

  const records =
    await loadKotobaruResultsForDate(
      guildId,
      date
    );

  const byUser =
    new Map(
      records.map(
        (record) => [
          record.userId,
          record,
        ]
      )
    );

  finishedRecordsCache.set(
    key,
    byUser
  );

  return records;
}

function cacheFinishedKotobaruRecord(
  record
) {
  const key =
    `${record.guildId}:${record.date}`;

  let byUser =
    finishedRecordsCache.get(
      key
    );

  if (!byUser) {
    byUser = new Map();

    finishedRecordsCache.set(
      key,
      byUser
    );
  }

  byUser.set(
    record.userId,
    record
  );
}

/* =========================================================
 * 今日の途中経過・1時間単位のプレビュー枠
 * ======================================================= */

function liveSessionKey(
  guildId,
  date,
  sessionId
) {
  return `${guildId}:${date}:${sessionId}`;
}

function liveUserSessionKey(
  guildId,
  date,
  userId
) {
  return `${guildId}:${date}:${userId}`;
}

function setKotobaruLiveProgress(
  progress,
  sessionId
) {
  const key =
    liveSessionKey(
      progress.guildId,
      progress.date,
      sessionId
    );

  let map =
    liveProgressByGuild.get(
      key
    );

  if (!map) {
    map = new Map();

    liveProgressByGuild.set(
      key,
      map
    );
  }

  const next = {
    ...progress,
    sessionId,
    updatedAt:
      Date.now(),
  };

  map.set(
    progress.userId,
    next
  );

  liveSessionByUser.set(
    liveUserSessionKey(
      progress.guildId,
      progress.date,
      progress.userId
    ),
    sessionId
  );

  return next;
}

function getKotobaruLiveProgress(
  guildId,
  date,
  sessionId
) {
  const key =
    liveSessionKey(
      guildId,
      date,
      sessionId
    );

  const map =
    liveProgressByGuild.get(
      key
    );

  if (!map) {
    return [];
  }

  const now =
    Date.now();

  /*
   * 3時間以上更新されていない未完了盤面は
   * 「挑戦中」から外します。
   */
  for (
    const [
      userId,
      progress,
    ] of map
  ) {
    if (
      !progress.finished &&
      now -
        progress.updatedAt >
        3 * 60 * 60 * 1000
    ) {
      map.delete(
        userId
      );
    }
  }

  return [
    ...map.values(),
  ];
}

function parseKotobaruLiveSessionMarker(
  content
) {
  if (
    typeof content !==
      "string" ||
    !content.startsWith(
      LIVE_SESSION_MARKER_PREFIX
    )
  ) {
    return null;
  }

  try {
    const value =
      JSON.parse(
        content.slice(
          LIVE_SESSION_MARKER_PREFIX.length
        )
      );

    if (
      typeof value.date !==
        "string" ||
      typeof value.sessionId !==
        "string" ||
      typeof value.messageId !==
        "string" ||
      !Number.isFinite(
        value.startedAt
      )
    ) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

async function findLatestKotobaruSession(
  logChannelId,
  date
) {
  const messages =
    await fetchRecentKotobaruMessagesRest(
      logChannelId,
      100
    );

  const sessions =
    messages
      .map(
        (message) =>
          parseKotobaruLiveSessionMarker(
            message.content
          )
      )
      .filter(
        (session) =>
          session &&
          session.date ===
            date
      )
      .sort(
        (a, b) =>
          b.startedAt -
          a.startedAt
      );

  return sessions[0] ||
    null;
}

async function findKotobaruSessionById(
  logChannelId,
  date,
  sessionId
) {
  const messages =
    await fetchRecentKotobaruMessagesRest(
      logChannelId,
      100
    );

  for (
    const message of
    messages
  ) {
    const session =
      parseKotobaruLiveSessionMarker(
        message.content
      );

    if (
      session?.date ===
        date &&
      session.sessionId ===
        sessionId
    ) {
      return session;
    }
  }

  return null;
}

async function cleanupLegacyKotobaruLiveCard(
  config,
  date
) {
  try {
    const messages =
      await fetchRecentKotobaruMessagesRest(
        config.logChannelId,
        100
      );

    const prefix =
      `${LIVE_CARD_MARKER_PREFIX}${date}:`;

    const legacyMarker =
      messages.find(
        (message) =>
          typeof message.content ===
            "string" &&
          message.content.startsWith(
            prefix
          )
      );

    if (!legacyMarker) {
      return;
    }

    const oldMessageId =
      legacyMarker.content
        .slice(
          prefix.length
        )
        .trim();

    if (oldMessageId) {
      await discordRest(
        `/channels/${config.summaryChannelId}/messages/${oldMessageId}`,
        {
          method:
            "DELETE",
        }
      ).catch(
        () => null
      );
    }

    await discordRest(
      `/channels/${config.logChannelId}/messages/${legacyMarker.id}`,
      {
        method:
          "DELETE",
      }
    ).catch(
      () => null
    );
  } catch (error) {
    console.warn(
      "旧形式のことばルPreview整理に失敗しました:",
      error
    );
  }
}

async function getCurrentKotobaruSession(
  config,
  guildId,
  date
) {
  const cacheKey =
    `${guildId}:${date}`;

  const now =
    Date.now();

  const cached =
    liveSessionCache.get(
      cacheKey
    );

  if (
    cached &&
    now -
      cached.startedAt <=
      LIVE_SESSION_WINDOW_MS
  ) {
    return cached;
  }

  const latest =
    await findLatestKotobaruSession(
      config.logChannelId,
      date
    );

  if (
    latest &&
    now -
      latest.startedAt <=
      LIVE_SESSION_WINDOW_MS
  ) {
    liveSessionCache.set(
      cacheKey,
      latest
    );

    return latest;
  }

  if (!latest) {
    await cleanupLegacyKotobaruLiveCard(
      config,
      date
    );
  }

  const session = {
    date,
    sessionId:
      `${now}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    messageId: null,
    startedAt: now,
  };

  liveSessionCache.set(
    cacheKey,
    session
  );

  return session;
}

async function getKotobaruSessionForUser(
  config,
  guildId,
  date,
  userId
) {
  const userKey =
    liveUserSessionKey(
      guildId,
      date,
      userId
    );

  const knownSessionId =
    liveSessionByUser.get(
      userKey
    );

  if (knownSessionId) {
    const current =
      liveSessionCache.get(
        `${guildId}:${date}`
      );

    if (
      current?.sessionId ===
        knownSessionId
    ) {
      return current;
    }

    const persisted =
      await findKotobaruSessionById(
        config.logChannelId,
        date,
        knownSessionId
      );

    if (persisted) {
      return persisted;
    }

    return {
      date,
      sessionId:
        knownSessionId,
      messageId: null,
      startedAt:
        Date.now(),
    };
  }

  const session =
    await getCurrentKotobaruSession(
      config,
      guildId,
      date
    );

  liveSessionByUser.set(
    userKey,
    session.sessionId
  );

  return session;
}

async function saveKotobaruLiveSessionMarker(
  logChannelId,
  session
) {
  const response =
    await discordRest(
      `/channels/${logChannelId}/messages`,
      {
        method:
          "POST",

        body:
          JSON.stringify({
            content:
              `${LIVE_SESSION_MARKER_PREFIX}${JSON.stringify(
                session
              )}`,
            flags:
              SUPPRESS_NOTIFICATIONS_FLAG,
          }),
      }
    );

  return response.ok;
}

/* =========================================================
 * Discordアイコン
 *
 * Previewでは「サーバー専用アイコン」を最優先します。
 * それがなければグローバルアイコン、最後に既定アイコンへ
 * フォールバックします。
 * ======================================================= */

function discordDefaultAvatarIndex(
  userId,
  discriminator = "0"
) {
  if (
    discriminator &&
    discriminator !== "0"
  ) {
    const number =
      Number(discriminator);

    if (
      Number.isFinite(number)
    ) {
      return number % 5;
    }
  }

  try {
    return Number(
      (BigInt(userId) >>
        22n) %
        6n
    );
  } catch {
    return 0;
  }
}

function discordUserAvatarUrl(
  userId,
  avatarHash,
  discriminator = "0"
) {
  if (avatarHash) {
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=128`;
  }

  return `https://cdn.discordapp.com/embed/avatars/${discordDefaultAvatarIndex(
    userId,
    discriminator
  )}.png`;
}

function discordGuildMemberAvatarUrl(
  guildId,
  userId,
  avatarHash
) {
  return `https://cdn.discordapp.com/guilds/${guildId}/users/${userId}/avatars/${avatarHash}.png?size=128`;
}

async function getDiscordGuildMemberProfile(
  guildId,
  userId
) {
  try {
    const response =
      await discordRest(
        `/guilds/${guildId}/members/${userId}`
      );

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn(
      "Discordメンバー情報取得失敗:",
      error
    );

    return null;
  }
}

async function fetchImageAsDataUri(
  url
) {
  try {
    const response =
      await fetch(url);

    if (!response.ok) {
      return null;
    }

    const bytes =
      Buffer.from(
        await response.arrayBuffer()
      );

    const contentType =
      response.headers.get(
        "content-type"
      ) || "image/png";

    return `data:${contentType};base64,${bytes.toString(
      "base64"
    )}`;
  } catch (error) {
    console.warn(
      "Discordアイコン画像取得失敗:",
      error
    );

    return null;
  }
}

async function getDiscordPreviewProfile(
  guildId,
  entry
) {
  const cacheKey =
    `${guildId}:${entry.userId}:${entry.avatarHash || "default"}`;

  const cached =
    avatarDataCache.get(
      cacheKey
    );

  if (cached) {
    return cached;
  }

  const member =
    await getDiscordGuildMemberProfile(
      guildId,
      entry.userId
    );

  const memberAvatarHash =
    member?.avatar ||
    null;

  const globalAvatarHash =
    member?.user?.avatar ||
    entry.avatarHash ||
    null;

  const discriminator =
    member?.user?.discriminator ||
    "0";

  const avatarUrl =
    memberAvatarHash
      ? discordGuildMemberAvatarUrl(
          guildId,
          entry.userId,
          memberAvatarHash
        )
      : discordUserAvatarUrl(
          entry.userId,
          globalAvatarHash,
          discriminator
        );

  let avatarDataUri =
    await fetchImageAsDataUri(
      avatarUrl
    );

  /*
   * サーバー専用アイコンの取得だけ失敗した場合は
   * グローバルアイコンでもう一度試します。
   */
  if (
    !avatarDataUri &&
    memberAvatarHash
  ) {
    avatarDataUri =
      await fetchImageAsDataUri(
        discordUserAvatarUrl(
          entry.userId,
          globalAvatarHash,
          discriminator
        )
      );
  }

  const profile = {
    avatarDataUri,

    displayName:
      member?.nick ||
      member?.user?.global_name ||
      entry.displayName ||
      member?.user?.username ||
      "挑戦者",
  };

  avatarDataCache.set(
    cacheKey,
    profile
  );

  return profile;
}

/* =========================================================
 * 「今日の挑戦」Preview画像
 * ======================================================= */

function emojiColor(
  emoji
) {
  if (emoji === "🟩") {
    return "#4aa340";
  }

  if (emoji === "🟨") {
    return "#d5b222";
  }

  if (emoji === "🟪") {
    return "#9057a3";
  }

  return "#686868";
}

function escapeXml(
  value = ""
) {
  return String(value)
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#39;"
    );
}

function shortenDisplayName(
  value,
  max = 12
) {
  const chars =
    Array.from(
      value || "挑戦者"
    );

  if (
    chars.length <=
    max
  ) {
    return chars.join("");
  }

  return `${chars
    .slice(0, max)
    .join("")}…`;
}

function buildKotobaruLiveEntries(
  records,
  liveProgress,
  sessionId
) {
  const byUser =
    new Map();

  for (
    const progress of
    liveProgress
  ) {
    byUser.set(
      progress.userId,
      progress
    );
  }

  for (
    const record of
    records
  ) {
    if (
      record.sessionId !==
        sessionId
    ) {
      continue;
    }

    byUser.set(
      record.userId,
      {
        ...record,
        finished: true,
      }
    );
  }

  return [
    ...byUser.values(),
  ].sort(
    (a, b) => {
      if (
        Boolean(a.finished) !==
        Boolean(b.finished)
      ) {
        return a.finished
          ? 1
          : -1;
      }

      if (
        a.finished &&
        b.finished
      ) {
        if (
          a.won !==
          b.won
        ) {
          return a.won
            ? -1
            : 1;
        }

        if (
          a.won &&
          b.won
        ) {
          return (
            a.attempts -
            b.attempts
          );
        }
      }

      return (
        b.pattern.length -
        a.pattern.length
      );
    }
  );
}

function kotobaruStatusText(
  entry
) {
  if (
    !entry.finished
  ) {
    return entry.historical
      ? `${entry.pattern.length}手`
      : `${entry.pattern.length}/6 挑戦中`;
  }

  if (entry.won) {
    return `${entry.attempts}/6`;
  }

  return "×/6";
}

function countKotobaruStatus(
  entries
) {
  return {
    activeCount:
      entries.filter(
        (entry) =>
          !entry.finished
      ).length,

    finishedCount:
      entries.filter(
        (entry) =>
          entry.finished
      ).length,
  };
}

function activityLinkButton(
  label = "Play now!"
) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label,
          url:
            `https://discord.com/activities/${KOTOBARU_CLIENT_ID}`,
        },
      ],
    },
  ];
}

function buildKotobaruLiveCardPayload(
  entries,
  puzzleNumber,
  date,
  silent = true
) {
  const {
    activeCount,
    finishedCount,
  } = countKotobaruStatus(
    entries
  );

  const description = [
    activeCount > 0
      ? `${activeCount}人がいま挑戦中です。`
      : null,

    finishedCount > 0
      ? `${finishedCount}人がこの時間帯の挑戦を終えました。`
      : null,
  ]
    .filter(Boolean)
    .join(
      "\n"
    );

  return {
    content:
      `**ことばル　第${puzzleNumber}問**`,

    embeds: [
      {
        description,

        color:
          0x4aa340,

        image: {
          url:
            "attachment://preview.png",
        },

        footer: {
          text:
            date,
        },
      },
    ],

    attachments: [
      {
        id: 0,
        filename:
          "preview.png",
        description:
          "ことばルの挑戦状況プレビュー",
      },
    ],

    components:
      activityLinkButton(
        "Play now!"
      ),

    ...(silent
      ? {
          flags:
            SUPPRESS_NOTIFICATIONS_FLAG,
        }
      : {}),
  };
}

async function enrichKotobaruEntriesWithAvatars(
  entries,
  guildId
) {
  return Promise.all(
    entries.map(
      async (entry) => {
        const profile =
          await getDiscordPreviewProfile(
            guildId,
            entry
          );

        return {
          ...entry,
          displayName:
            profile.displayName,
          avatarDataUri:
            profile.avatarDataUri,
        };
      }
    )
  );
}

function previewColumnCount(
  count
) {
  if (count <= 1) {
    return 1;
  }

  if (count <= 5) {
    return count;
  }

  if (count <= 6) {
    return 3;
  }

  if (count <= 8) {
    return 4;
  }

  return 5;
}

function buildKotobaruPreviewSvg(
  entries,
  puzzleNumber
) {
  const previewEntries =
    entries;

  const columnCount =
    previewColumnCount(
      Math.max(
        1,
        previewEntries.length
      )
    );
  const rowCount =
    Math.max(
      1,
      Math.ceil(
        previewEntries.length /
          columnCount
      )
    );
  const panelWidth =
    columnCount === 1
      ? 270
      : 220;
  const panelHeight = 370;
  const panelGapX = 28;
  const panelGapY = 30;
  const horizontalPadding = 70;
  const width =
    Math.max(
      560,
      horizontalPadding * 2 +
        columnCount *
          panelWidth +
        (columnCount - 1) *
          panelGapX
    );
  const height =
    105 +
    rowCount *
      panelHeight +
    (rowCount - 1) *
      panelGapY +
    55;
  const tileSize = 30;
  const tileGap = 5;
  const gridWidth =
    tileSize * 5 +
    tileGap * 4;
  const startY = 100;

  let cards = "";

  previewEntries.forEach(
    (entry, index) => {
      const row =
        Math.floor(
          index /
            columnCount
        );
      const col =
        index %
        columnCount;
      const itemsThisRow =
        row ===
        rowCount - 1
          ? previewEntries.length -
            row *
              columnCount
          : columnCount;
      const thisRowWidth =
        itemsThisRow *
          panelWidth +
        (itemsThisRow - 1) *
          panelGapX;
      const rowStartX =
        Math.round(
          (width -
            thisRowWidth) /
            2
        );
      const x =
        rowStartX +
        col *
          (panelWidth +
            panelGapX);
      const y =
        startY +
        row *
          (panelHeight +
            panelGapY);
      const clipId =
        `avatar-${index}`;
      const safeName =
        escapeXml(
          shortenDisplayName(
            entry.displayName,
            16
          )
        );
      const safeStatus =
        escapeXml(
          kotobaruStatusText(
            entry
          )
        );

      let avatar = `
        <circle cx="${x + panelWidth / 2}" cy="${y + 58}" r="50" fill="#3a3a3c" />
        <circle cx="${x + panelWidth / 2}" cy="${y + 44}" r="16" fill="#818384" />
        <path d="M ${x + panelWidth / 2 - 30} ${y + 84} Q ${x + panelWidth / 2} ${y + 61} ${x + panelWidth / 2 + 30} ${y + 84}" stroke="#818384" stroke-width="13" stroke-linecap="round" fill="none" />`;

      if (
        entry.avatarDataUri
      ) {
        avatar = `
          <defs>
            <clipPath id="${clipId}">
              <circle cx="${x + panelWidth / 2}" cy="${y + 58}" r="50" />
            </clipPath>
          </defs>
          <image href="${entry.avatarDataUri}" x="${x + panelWidth / 2 - 50}" y="${y + 8}" width="100" height="100" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" />`;
      }

      let tiles = "";

      for (
        let gridRow = 0;
        gridRow < 6;
        gridRow += 1
      ) {
        const rowText =
          entry.pattern[
            gridRow
          ] || "";
        const chars =
          Array.from(
            rowText
          );

        for (
          let gridCol = 0;
          gridCol < 5;
          gridCol += 1
        ) {
          const tx =
            x +
            Math.round(
              (panelWidth -
                gridWidth) /
                2
            ) +
            gridCol *
              (tileSize +
                tileGap);
          const ty =
            y + 185 +
            gridRow *
              (tileSize +
                tileGap);
          const emoji =
            chars[
              gridCol
            ];
          const fill = emoji
            ? emojiColor(
                emoji
              )
            : "#121213";
          const stroke = emoji
            ? fill
            : "#3a3a3c";

          tiles += `
            <rect x="${tx}" y="${ty}" width="${tileSize}" height="${tileSize}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="2" />`;
        }
      }

      /*
       * プレイヤーごとの外枠は描きません。
       * アイコン・名前・盤面だけを直接配置します。
       */
      cards += `
        <g>
          ${avatar}
          <text x="${x + panelWidth / 2}" y="${y + 132}" text-anchor="middle" font-family="Source Han Sans HW" font-size="25" font-weight="700" fill="#ffffff">${safeName}</text>
          <text x="${x + panelWidth / 2}" y="${y + 164}" text-anchor="middle" font-family="Source Han Sans HW" font-size="19" font-weight="400" fill="#d7dadc">${safeStatus}</text>
          ${tiles}
        </g>`;
    }
  );

  if (
    previewEntries.length === 0
  ) {
    cards = `
      <g>
        <text x="${width / 2}" y="250" text-anchor="middle" font-family="Source Han Sans HW" font-size="28" font-weight="700" fill="#ffffff">まだ挑戦者はいません</text>
        <text x="${width / 2}" y="292" text-anchor="middle" font-family="Source Han Sans HW" font-size="20" font-weight="400" fill="#d7dadc">最初の挑戦者になりましょう</text>
      </g>`;
  }

  return `
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#121213" />
    <text x="${width / 2}" y="56" text-anchor="middle" font-family="Source Han Sans HW" font-size="34" font-weight="700" fill="#ffffff">ことばル 第${puzzleNumber}問</text>
    ${cards}
  </svg>`;
}

function toHiraganaForSummary(
  value
) {
  return String(value || "")
    .replace(
      /[ァ-ヶ]/g,
      (char) =>
        String.fromCharCode(
          char.charCodeAt(0) -
            0x60
        )
    );
}

function buildKotobaruWordsSvg(
  entries,
  puzzleNumber
) {
  const columnCount =
    entries.length <= 1
      ? 1
      : 2;
  const rowCount =
    Math.max(
      1,
      Math.ceil(
        entries.length /
          columnCount
      )
    );
  const itemWidth = 520;
  const itemHeight = 285;
  const gapX = 34;
  const gapY = 26;
  const width =
    Math.max(
      680,
      90 * 2 +
        columnCount *
          itemWidth +
        (columnCount - 1) *
          gapX
    );
  const height =
    110 +
    rowCount *
      itemHeight +
    (rowCount - 1) *
      gapY +
    45;

  let content = "";

  entries.forEach(
    (entry, index) => {
      const row =
        Math.floor(
          index /
            columnCount
        );
      const col =
        index %
        columnCount;
      const x =
        90 +
        col *
          (itemWidth +
            gapX);
      const y =
        95 +
        row *
          (itemHeight +
            gapY);
      const clipId =
        `word-avatar-${index}`;
      const safeName =
        escapeXml(
          shortenDisplayName(
            entry.displayName,
            18
          )
        );
      const status =
        entry.won
          ? `${entry.attempts}/6`
          : entry.finished
            ? "×/6"
            : `${entry.pattern?.length || 0}手`;

      let avatar = `
        <circle cx="${x + 47}" cy="${y + 48}" r="42" fill="#3a3a3c" />`;

      if (
        entry.avatarDataUri
      ) {
        avatar = `
          <defs>
            <clipPath id="${clipId}">
              <circle cx="${x + 47}" cy="${y + 48}" r="42" />
            </clipPath>
          </defs>
          <image href="${entry.avatarDataUri}" x="${x + 5}" y="${y + 6}" width="84" height="84" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})" />`;
      }

      const guesses =
        Array.isArray(
          entry.guessesDecrypted
        )
          ? entry.guessesDecrypted
          : [];

      let lines = "";

      if (
        guesses.length === 0
      ) {
        lines = `
          <text x="${x + 110}" y="${y + 134}" font-family="Source Han Sans HW" font-size="21" fill="#818384">回答履歴なし</text>`;
      } else {
        guesses.forEach(
          (guess, guessIndex) => {
            const display =
              escapeXml(
                toHiraganaForSummary(
                  guess
                )
              );
            const number =
              guessIndex + 1;
            const lineY =
              y + 125 +
              guessIndex * 30;

            lines += `
              <text x="${x + 110}" y="${lineY}" font-family="Source Han Sans HW" font-size="22" fill="#f1f1f1">${number}. ${display}</text>`;
          }
        );
      }

      content += `
        <g>
          ${avatar}
          <text x="${x + 110}" y="${y + 42}" font-family="Source Han Sans HW" font-size="26" font-weight="700" fill="#ffffff">${safeName}</text>
          <text x="${x + 110}" y="${y + 72}" font-family="Source Han Sans HW" font-size="19" fill="#d7dadc">${escapeXml(status)}</text>
          ${lines}
        </g>`;
    }
  );

  return `
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#121213" />
    <text x="${width / 2}" y="58" text-anchor="middle" font-family="Source Han Sans HW" font-size="34" font-weight="700" fill="#ffffff">第${puzzleNumber}問　みんなが使ったことば</text>
    ${content}
  </svg>`;
}

async function renderKotobaruPreviewPng(
  entries,
  puzzleNumber,
  guildId
) {
  const enriched =
    await enrichKotobaruEntriesWithAvatars(
      entries,
      guildId
    );

  const svg =
    buildKotobaruPreviewSvg(
      enriched,
      puzzleNumber
    );

  const resvg =
    new Resvg(svg, {
      languages: [
        "ja",
      ],
      font: {
        fontFiles:
          KOTOBARU_FONT_FILES,
        loadSystemFonts:
          true,
        defaultFontFamily:
          "Source Han Sans HW",
        sansSerifFamily:
          "Source Han Sans HW",
      },
    });

  return resvg
    .render()
    .asPng();
}

async function renderKotobaruWordsPng(
  entries,
  puzzleNumber,
  guildId
) {
  const enriched =
    await enrichKotobaruEntriesWithAvatars(
      entries,
      guildId
    );

  const svg =
    buildKotobaruWordsSvg(
      enriched,
      puzzleNumber
    );

  const resvg =
    new Resvg(svg, {
      languages: [
        "ja",
      ],
      font: {
        fontFiles:
          KOTOBARU_FONT_FILES,
        loadSystemFonts:
          true,
        defaultFontFamily:
          "Source Han Sans HW",
        sansSerifFamily:
          "Source Han Sans HW",
      },
    });

  return resvg
    .render()
    .asPng();
}

async function upsertKotobaruLiveCard(
  guildId,
  date,
  puzzleNumber,
  session
) {
  const config =
    await getKotobaruGuildConfig(
      guildId
    );

  if (!config) {
    return false;
  }

  const targetSession =
    session ||
    await getCurrentKotobaruSession(
      config,
      guildId,
      date
    );

  const records =
    await getCachedKotobaruResults(
      guildId,
      date
    );

  const liveProgress =
    getKotobaruLiveProgress(
      guildId,
      date,
      targetSession.sessionId
    );

  const entries =
    buildKotobaruLiveEntries(
      records,
      liveProgress,
      targetSession.sessionId
    );

  const payload =
    buildKotobaruLiveCardPayload(
      entries,
      puzzleNumber,
      date,
      true
    );

  const previewPng =
    await renderKotobaruPreviewPng(
      entries,
      puzzleNumber,
      guildId
    );

  const files = [
    {
      name: "preview.png",
      data: previewPng,
      contentType:
        "image/png",
    },
  ];

  if (
    targetSession.messageId
  ) {
    const editPayload = {
      ...payload,
    };

    delete editPayload.flags;

    const editResponse =
      await discordRestMultipart(
        `/channels/${config.summaryChannelId}/messages/${targetSession.messageId}`,
        "PATCH",
        editPayload,
        files
      );

    if (
      editResponse.ok
    ) {
      return true;
    }

    console.warn(
      "ことばルPreviewを更新できなかったため再作成します:",
      editResponse.status
    );
  }

  const createResponse =
    await discordRestMultipart(
      `/channels/${config.summaryChannelId}/messages`,
      "POST",
      payload,
      files
    );

  if (!createResponse.ok) {
    console.error(
      "ことばルPreview作成失敗:",
      createResponse.status,
      await createResponse
        .text()
        .catch(
          () => ""
        )
    );

    return false;
  }

  const created =
    await createResponse.json();

  targetSession.messageId =
    created.id;

  liveSessionCache.set(
    `${guildId}:${date}`,
    targetSession
  );

  await saveKotobaruLiveSessionMarker(
    config.logChannelId,
    targetSession
  );

  return true;
}

/* =========================================================
 * 昨日の結果投稿
/* =========================================================
 * 昨日の結果投稿
 * ======================================================= */

async function postKotobaruSummaryForGuild(
  guildId,
  date =
    previousJstDateKey()
) {
  const config =
    await getKotobaruGuildConfig(
      guildId
    );

  if (!config) {
    return false;
  }

  /*
   * 終了済みだけではなく、途中で止めた人も含めて読みます。
   */
  const records =
    await loadKotobaruParticipantsForDate(
      guildId,
      date
    );

  if (
    !records.length
  ) {
    return false;
  }

  const puzzleNumber =
    Math.max(
      ...records.map(
        (record) =>
          record.puzzleNumber
      )
    );

  /*
   * 1. 正解者
   * 2. 少ない手数
   * 3. 同手数なら終了時刻
   * 4. 不正解・途中終了は後ろ
   */
  const sorted =
    [...records].sort(
      (a, b) => {
        if (
          a.won !==
          b.won
        ) {
          return a.won
            ? -1
            : 1;
        }

        if (
          a.won &&
          b.won &&
          a.attempts !==
            b.attempts
        ) {
          return (
            a.attempts -
            b.attempts
          );
        }

        if (
          Boolean(a.finished) !==
          Boolean(b.finished)
        ) {
          return a.finished
            ? -1
            : 1;
        }

        return (
          new Date(
            a.savedAt ||
            a.updatedAt ||
            0
          ).getTime() -
          new Date(
            b.savedAt ||
            b.updatedAt ||
            0
          ).getTime()
        );
      }
    );

  const entries =
    sorted.map(
      (record) => ({
        ...record,
        historical: true,
        guessesDecrypted:
          decryptKotobaruGuesses(
            record.guessesEncrypted
          ),
      })
    );

  const previewPng =
    await renderKotobaruPreviewPng(
      entries,
      puzzleNumber,
      guildId
    );

  const wordsPng =
    await renderKotobaruWordsPng(
      entries,
      puzzleNumber,
      guildId
    );

  const payload = {
    content:
      `**ことばル 第${puzzleNumber}問　昨日の結果**`,

    embeds: [
      {
        title:
          "昨日の順位",
        description:
          `${sorted.length}人が挑戦しました。`,
        color:
          0x4aa340,
        image: {
          url:
            "attachment://preview.png",
        },
        footer: {
          text:
            date,
        },
      },
      {
        title:
          "みんなが使ったことば",
        color:
          0x4aa340,
        image: {
          url:
            "attachment://words.png",
        },
      },
    ],

    attachments: [
      {
        id: 0,
        filename:
          "preview.png",
        description:
          "ことばルの昨日の順位",
      },
      {
        id: 1,
        filename:
          "words.png",
        description:
          "ことばルで昨日使われたことば",
      },
    ],

    components:
      activityLinkButton(
        "Play now!"
      ),

    flags:
      SUPPRESS_NOTIFICATIONS_FLAG,
  };

  const response =
    await discordRestMultipart(
      `/channels/${config.summaryChannelId}/messages`,
      "POST",
      payload,
      [
        {
          name:
            "preview.png",
          data:
            previewPng,
          contentType:
            "image/png",
        },
        {
          name:
            "words.png",
          data:
            wordsPng,
          contentType:
            "image/png",
        },
      ]
    );

  if (!response.ok) {
    console.error(
      "ことばル昨日結果投稿失敗:",
      response.status,
      await response
        .text()
        .catch(
          () => ""
        )
    );
  }

  return response.ok;
}

async function postYesterdayKotobaruSummary() {
  const date =
    previousJstDateKey();

  for (
    const guild of
    kotobaruBot.guilds.cache.values()
  ) {
    await postKotobaruSummaryForGuild(
      guild.id,
      date
    ).catch(
      (error) => {
        console.error(
          `ことばル集計エラー (${guild.id}):`,
          error
        );
      }
    );
  }
}

/* =========================================================
 * 昨日の結果を1日1回だけ投稿
 * ======================================================= */

async function ensureYesterdaySummaryForGuild(
  guildId
) {
  const config =
    await getKotobaruGuildConfig(
      guildId
    );

  if (!config) {
    return {
      configured: false,
      posted: false,
    };
  }

  const today =
    jstDateKey();

  const yesterday =
    previousJstDateKey();

  const marker =
    `${SUMMARY_MARKER_PREFIX}${today}:${yesterday}`;

  const recent =
    await fetchRecentKotobaruMessagesRest(
      config.logChannelId,
      100
    );

  const alreadyDone =
    recent.some(
      (message) =>
        message.author?.bot &&
        message.content ===
          marker
    );

  if (alreadyDone) {
    return {
      configured: true,
      posted: false,
      alreadyDone: true,
    };
  }

  const posted =
    await postKotobaruSummaryForGuild(
      guildId,
      yesterday
    );

  await discordRest(
    `/channels/${config.logChannelId}/messages`,
    {
      method:
        "POST",

      body:
        JSON.stringify({
          content:
            marker,
          flags:
            SUPPRESS_NOTIFICATIONS_FLAG,
        }),
    }
  );

  return {
    configured: true,
    posted,
    alreadyDone: false,
  };
}

/* =========================================================
 * /ことばル設定
 * ======================================================= */

async function createKotobaruSetup(
  interaction
) {
  if (
    !interaction.guild
  ) {
    await interaction.reply({
      content:
        "サーバー内で実行してください。",
      ephemeral:
        true,
    });

    return;
  }

  if (
    !interaction.memberPermissions?.has(
      PermissionFlagsBits.ManageChannels
    )
  ) {
    await interaction.reply({
      content:
        "この設定には「チャンネルの管理」権限が必要です。",
      ephemeral:
        true,
    });

    return;
  }

  const summaryChannel =
    interaction.options.getChannel(
      "表示先",
      true
    );

  const logChannel =
    interaction.options.getChannel(
      "記録先",
      true
    );

  if (
    summaryChannel.type !==
      ChannelType.GuildText ||
    logChannel.type !==
      ChannelType.GuildText
  ) {
    await interaction.reply({
      content:
        "表示先・記録先にはテキストチャンネルを指定してください。",
      ephemeral:
        true,
    });

    return;
  }

  if (
    summaryChannel.id ===
    logChannel.id
  ) {
    await interaction.reply({
      content:
        "表示先と記録先は別のチャンネルを指定してください。記録先には内部データが保存されます。",
      ephemeral:
        true,
    });

    return;
  }

  const botMember =
    interaction.guild.members.me;

  if (botMember) {
    const summaryPermissions =
      summaryChannel.permissionsFor(
        botMember
      );

    const logPermissions =
      logChannel.permissionsFor(
        botMember
      );

    const missingSummary = [];
    const missingLog = [];

    const summaryChecks = [
      [
        PermissionFlagsBits.ViewChannel,
        "チャンネルを見る",
      ],
      [
        PermissionFlagsBits.SendMessages,
        "メッセージを送信",
      ],
      [
        PermissionFlagsBits.EmbedLinks,
        "埋め込みリンク",
      ],
      [
        PermissionFlagsBits.AttachFiles,
        "ファイルを添付",
      ],
      [
        PermissionFlagsBits.ReadMessageHistory,
        "メッセージ履歴を読む",
      ],
      [
        PermissionFlagsBits.ManageMessages,
        "メッセージの管理",
      ],
    ];

    const logChecks = [
      [
        PermissionFlagsBits.ViewChannel,
        "チャンネルを見る",
      ],
      [
        PermissionFlagsBits.SendMessages,
        "メッセージを送信",
      ],
      [
        PermissionFlagsBits.ReadMessageHistory,
        "メッセージ履歴を読む",
      ],
      [
        PermissionFlagsBits.ManageChannels,
        "チャンネルの管理",
      ],
    ];

    for (
      const [
        permission,
        label,
      ] of summaryChecks
    ) {
      if (
        !summaryPermissions?.has(
          permission
        )
      ) {
        missingSummary.push(
          label
        );
      }
    }

    for (
      const [
        permission,
        label,
      ] of logChecks
    ) {
      if (
        !logPermissions?.has(
          permission
        )
      ) {
        missingLog.push(
          label
        );
      }
    }

    if (
      missingSummary.length ||
      missingLog.length
    ) {
      const lines = [
        "ことばルBotの権限が不足しています。",
      ];

      if (
        missingSummary.length
      ) {
        lines.push(
          `・表示先：${missingSummary.join("、")}`
        );
      }

      if (
        missingLog.length
      ) {
        lines.push(
          `・記録先：${missingLog.join("、")}`
        );
      }

      await interaction.reply({
        content:
          lines.join("\n"),
        ephemeral:
          true,
      });

      return;
    }
  }

  await interaction.deferReply({
    ephemeral:
      true,
  });

  const configuredAt =
    Date.now();

  /*
   * 記録先チャンネルのトピックに設定を保存します。
   * 古い方式の自動作成チャンネルが残っていても、
   * updatedAtが新しい設定を優先するため誤認しません。
   */
  const previousTopic =
    logChannel.topic || "";

  let preservedTopic =
    previousTopic;

  if (
    previousTopic.startsWith(
      CONFIG_TOPIC_PREFIX
    )
  ) {
    preservedTopic =
      previousTopic.includes("|")
        ? previousTopic
            .split("|")
            .slice(1)
            .join("|")
            .trim()
        : "";
  }

  if (
    preservedTopic ===
    "ことばルの結果記録用"
  ) {
    preservedTopic = "";
  }

  const configTopic =
    `${CONFIG_TOPIC_PREFIX}${summaryChannel.id}:${configuredAt}` +
    (preservedTopic
      ? ` | ${preservedTopic}`
      : " | ことばルの結果記録用");

  try {
    await logChannel.setTopic(
      configTopic.slice(
        0,
        1024
      )
    );
  } catch (error) {
    console.error(
      "ことばル記録先トピック設定失敗:",
      error
    );

    await interaction.editReply(
      "記録先チャンネルの設定を書き込めませんでした。ことばルBotに、そのチャンネルの「チャンネルの管理」「チャンネルを見る」「メッセージを送信」「メッセージ履歴を読む」権限があるか確認してください。"
    );

    return;
  }

  const config = {
    guildId:
      interaction.guild.id,

    logChannelId:
      logChannel.id,

    summaryChannelId:
      summaryChannel.id,

    updatedAt:
      configuredAt,
  };

  guildConfigs.set(
    interaction.guild.id,
    config
  );

  await interaction.editReply(
    [
      "ことばルの設定が完了しました。",
      `・挑戦状況・昨日の結果：${summaryChannel}`,
      `・内部記録：${logChannel}`,
      "",
      "記録先チャンネルは自動作成しません。必要に応じてサーバー側で一般メンバーから非表示にしてください。",
      "以前の自動作成チャンネルがある場合も自動削除はしません。不要なら確認後に手動で削除できます。",
    ].join("\n")
  );
}

/* =========================================================
 * 設定確認
 * ======================================================= */

async function showKotobaruSetup(
  interaction
) {
  if (
    !interaction.guild
  ) {
    await interaction.reply({
      content:
        "サーバー内で実行してください。",
      ephemeral:
        true,
    });

    return;
  }

  /*
   * まずDiscordへ
   * 「処理中」と返す。
   */
  await interaction.deferReply({
    ephemeral:
      true,
  });

  const config =
    await refreshKotobaruGuildConfig(
      interaction.guild
    );

  if (!config) {
    await interaction.editReply(
      "まだ設定されていません。`/ことばル設定` で表示先と記録先を指定してください。"
    );

    return;
  }

  await interaction.editReply(
    [
      "現在の設定",
      `・昨日の結果：<#${config.summaryChannelId}>`,
      `・記録用：<#${config.logChannelId}>`,
    ].join("\n")
  );
}

/* =========================================================
 * スラッシュコマンド
 * ======================================================= */

const kotobaruCommands = [
  new SlashCommandBuilder()
    .setName(
      "ことばル設定"
    )
    .setDescription(
      "ことばルの表示先と記録先を設定します"
    )
    .addChannelOption(
      (option) =>
        option
          .setName(
            "表示先"
          )
          .setDescription(
            "挑戦状況や昨日の結果を表示するチャンネル"
          )
          .addChannelTypes(
            ChannelType.GuildText
          )
          .setRequired(
            true
          )
    )
    .addChannelOption(
      (option) =>
        option
          .setName(
            "記録先"
          )
          .setDescription(
            "内部記録を保存するチャンネル（非公開推奨）"
          )
          .addChannelTypes(
            ChannelType.GuildText
          )
          .setRequired(
            true
          )
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageChannels
    ),

  new SlashCommandBuilder()
    .setName(
      "ことばル設定確認"
    )
    .setDescription(
      "ことばルの現在の設定を確認します"
    ),

  new SlashCommandBuilder()
    .setName(
      "ことばル集計テスト"
    )
    .setDescription(
      "昨日の結果をテスト投稿します"
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageChannels
    ),
].map(
  (command) =>
    command.toJSON()
);

async function registerKotobaruCommandsForGuild(
  guild
) {
  try {
    await guild.commands.set(
      kotobaruCommands
    );

    console.log(
      `ことばルコマンド同期完了: ${guild.name}`
    );

    return true;
  } catch (error) {
    console.error(
      `ことばルコマンド同期エラー: ${guild.name}`,
      error
    );

    return false;
  }
}

async function registerKotobaruCommands() {
  for (
    const guild of
    kotobaruBot.guilds.cache.values()
  ) {
    await registerKotobaruCommandsForGuild(
      guild
    );
  }
}

/*
 * 新しいサーバーへ導入された場合も、Render再起動を待たず
 * そのサーバーへ設定コマンドを登録します。
 */
kotobaruBot.on(
  Events.GuildCreate,
  async (guild) => {
    await registerKotobaruCommandsForGuild(
      guild
    );

    await refreshKotobaruGuildConfig(
      guild
    ).catch(
      () => null
    );
  }
);

/* =========================================================
 * スラッシュコマンド実行
 * ======================================================= */

/* =========================================================
 * Renderが起きている間は、起動カードをリアルタイムで削除
 * ======================================================= */

kotobaruBot.on(
  Events.MessageCreate,
  async (message) => {
    try {
      if (
        !isKotobaruLaunchCardMessage(
          message
        )
      ) {
        return;
      }

      console.log(
        "ことばル起動カードをGatewayで検知:",
        JSON.stringify(
          summarizeKotobaruMessageForLog(
            message
          )
        )
      );

      const channelId =
        message.channelId ??
        message.channel_id;

      if (!channelId) {
        return;
      }

      const response =
        await discordRest(
          `/channels/${channelId}/messages/${message.id}`,
          {
            method: "DELETE",
          }
        );

      if (
        response.ok ||
        response.status === 404
      ) {
        console.log(
          `ことばル起動カード即時削除: ${message.id}`
        );
      } else {
        console.warn(
          "ことばル起動カード即時削除失敗:",
          message.id,
          response.status,
          await response
            .text()
            .catch(
              () => ""
            )
        );
      }
    } catch (error) {
      console.warn(
        "ことばル起動カードGateway整理エラー:",
        error
      );
    }
  }
);

kotobaruBot.on(
  Events.InteractionCreate,
  async (interaction) => {
    if (
      !interaction.isChatInputCommand()
    ) {
      return;
    }

    try {
      if (
        interaction.commandName ===
        "ことばル設定"
      ) {
        await createKotobaruSetup(
          interaction
        );

        return;
      }

      if (
        interaction.commandName ===
        "ことばル設定確認"
      ) {
        await showKotobaruSetup(
          interaction
        );

        return;
      }

      if (
        interaction.commandName ===
        "ことばル集計テスト"
      ) {
        if (
          !interaction.guild
        ) {
          return;
        }

        await interaction.deferReply({
          ephemeral:
            true,
        });

        const posted =
          await postKotobaruSummaryForGuild(
            interaction.guild.id
          );

        await interaction.editReply(
          posted
            ? "前日の結果を投稿しました。"
            : "前日分の記録がありません。"
        );
      }
    } catch (error) {
      console.error(
        "ことばルコマンドエラー:",
        error
      );

      const text =
        "処理中にエラーが発生しました。";

      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction
          .editReply(
            text
          )
          .catch(
            () => null
          );
      } else {
        await interaction
          .reply({
            content:
              text,

            ephemeral:
              true,
          })
          .catch(
            () => null
          );
      }
    }
  }
);

/* =========================================================
 * ことばル OAuth
 *
 * 三人将棋の /api/token とは分離。
 * ======================================================= */

app.post(
  "/api/kotobaru/token",
  async (req, res) => {
    if (
      !KOTOBARU_CLIENT_ID ||
      !KOTOBARU_CLIENT_SECRET
    ) {
      return res
        .status(503)
        .json({
          error:
            "Kotobaru Discord OAuth is not configured",
        });
    }

    const code =
      req.body?.code;

    if (!code) {
      return res
        .status(400)
        .json({
          error:
            "code is required",
        });
    }

    try {
      const response =
        await fetch(
          "https://discord.com/api/oauth2/token",
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded",
            },

            body:
              new URLSearchParams({
                client_id:
                  KOTOBARU_CLIENT_ID,

                client_secret:
                  KOTOBARU_CLIENT_SECRET,

                grant_type:
                  "authorization_code",

                code,
              }),
          }
        );

      const data =
        await response.json();

      if (
        !response.ok
      ) {
        console.error(
          "ことばルOAuthエラー:",
          data
        );

        return res
          .status(
            response.status
          )
          .json(
            data
          );
      }

      return res.json({
        access_token:
          data.access_token,
      });
    } catch (error) {
      console.error(
        "ことばル token error:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "token exchange failed",
        });
    }
  }
);

/* =========================================================
 * ことばル途中経過
 *
 * 1手ごとに公開チャンネルの「今日の挑戦」を更新します。
 * 答えの文字そのものは受け取りません。
 * ======================================================= */

app.post(
  "/api/kotobaru/progress",
  async (req, res) => {
    if (
      !validateKotobaruProgress(
        req.body
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "invalid progress",
        });
    }

    try {
      const config =
        await getKotobaruGuildConfig(
          req.body.guildId
        );

      /*
       * 未設定サーバーでもゲーム自体は遊べるよう、
       * 公開カードだけ作らず正常終了します。
       */
      if (!config) {
        return res.json({
          ok: true,
          configured: false,
          cardUpdated: false,
        });
      }

      const session =
        await getKotobaruSessionForUser(
          config,
          req.body.guildId,
          req.body.date,
          req.body.userId
        );

      const progress = {
        guildId:
          req.body.guildId,

        userId:
          req.body.userId,

        displayName:
          req.body.displayName
            .slice(
              0,
              80
            ),

        avatarHash:
          typeof req.body.avatarHash ===
            "string"
            ? req.body.avatarHash
            : null,

        puzzleNumber:
          req.body.puzzleNumber,

        date:
          req.body.date,

        attempts:
          req.body.attempts,

        won:
          req.body.won,

        finished:
          req.body.finished,

        pattern:
          req.body.pattern,
      };

      setKotobaruLiveProgress(
        progress,
        session.sessionId
      );

      /*
       * 平文の回答単語はDiscordへ保存せず、
       * AES-256-GCMで暗号化した状態だけをLOGへ更新します。
       */
      await upsertKotobaruProgressLog(
        config,
        {
          ...progress,
          sessionId:
            session.sessionId,
        },
        req.body.guesses
      ).catch(
        (error) => {
          console.error(
            "ことばル暗号化進捗LOG保存エラー:",
            error
          );
        }
      );

      const updated =
        await upsertKotobaruLiveCard(
          progress.guildId,
          progress.date,
          progress.puzzleNumber,
          session
        );

      return res.json({
        ok: true,
        configured: true,
        cardUpdated:
          updated,
        sessionId:
          session.sessionId,
      });
    } catch (error) {
      console.error(
        "ことばル途中経過反映エラー:",
        error
      );

      /*
       * 公開Previewの失敗でゲームを止めません。
       */
      return res.json({
        ok: true,
        cardUpdated: false,
      });
    }
  }
);

/* =========================================================
 * ことばル結果保存
 *
 * Discord Gatewayには依存しません。
 * ======================================================= */

app.post(
  "/api/kotobaru/result",
  async (req, res) => {

    /* =========================
     * 内容チェック
     * ======================= */

    if (
      !validateKotobaruResult(
        req.body
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "invalid result",
        });
    }

    try {
      /* =========================
       * 保存先取得
       * ======================= */

      const config =
        await getKotobaruGuildConfig(
          req.body.guildId
        );

      if (!config) {
        return res
          .status(503)
          .json({
            error:
              "ことばル設定が行われていません",
          });
      }

      const session =
        await getKotobaruSessionForUser(
          config,
          req.body.guildId,
          req.body.date,
          req.body.userId
        );

      /* =========================
       * 保存内容
       * ======================= */

      const record = {
        guildId:
          req.body.guildId,

        userId:
          req.body.userId,

        displayName:
          req.body.displayName
            .slice(
              0,
              80
            ),

        avatarHash:
          typeof req.body.avatarHash ===
            "string"
            ? req.body.avatarHash
            : null,

        sessionId:
          session.sessionId,

        puzzleNumber:
          req.body.puzzleNumber,

        date:
          req.body.date,

        attempts:
          req.body.attempts,

        won:
          req.body.won,

        finished:
          true,

        pattern:
          req.body.pattern,

        savedAt:
          new Date()
            .toISOString(),
      };

      /* =========================
       * 同じ進捗LOGメッセージを終了状態へ更新
       * 回答単語は暗号化して保存します。
       * ======================= */

      try {
        await upsertKotobaruProgressLog(
          config,
          record,
          req.body.guesses
        );
      } catch (error) {
        console.error(
          "ことばル結果LOG保存失敗:",
          error
        );

        return res
          .status(502)
          .json({
            error:
              "Discord result save failed",
          });
      }

      /*
       * 公開カードも終了状態へ更新。
       */
      setKotobaruLiveProgress(
        {
          ...record,
          finished: true,
        },
        session.sessionId
      );

      cacheFinishedKotobaruRecord(
        record
      );

      await upsertKotobaruLiveCard(
        record.guildId,
        record.date,
        record.puzzleNumber,
        session
      ).catch(
        (error) => {
          console.error(
            "ことばル公開カード更新エラー:",
            error
          );
        }
      );

      console.log(
        `ことばル結果保存成功: ${record.displayName} / 第${record.puzzleNumber}問 / ${
          record.won
            ? `${record.attempts}/6`
            : "失敗"
        }`
      );

      return res.json({
        ok: true,
      });

    } catch (error) {
      console.error(
        "ことばル結果保存エラー:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "result save failed",
        });
    }
  }
);

/* =========================================================
 * ヘルスチェック
 * ======================================================= */

app.get(
  "/api/kotobaru/health",
  (_req, res) => {
    res.json({
      ok: true,

      service:
        "kotobaru",

      /*
       * Gatewayは補助機能。
       */
      gatewayReady:
        kotobaruBot.isReady(),

      /*
       * ゲームの結果保存に必要なのは
       * REST APIの方。
       */
      restMode:
        true,

      tokenConfigured:
        Boolean(
          KOTOBARU_BOT_TOKEN
        ),

      encryptionConfigured:
        Boolean(
          getKotobaruEncryptionKey()
        ),
    });
  }
);

function getKotobaruMessageApplicationId(
  message
) {
  return (
    message?.application_id ??
    message?.applicationId ??
    message?.application?.id ??
    message?.interaction?.application_id ??
    message?.interaction?.applicationId ??
    null
  );
}

function getKotobaruMessageWebhookId(
  message
) {
  return (
    message?.webhook_id ??
    message?.webhookId ??
    null
  );
}

function getKotobaruMessageType(
  message
) {
  const value =
    message?.type?.value ??
    message?.type;

  return Number.isFinite(
    Number(value)
  )
    ? Number(value)
    : null;
}

function isKotobaruLaunchCardMessage(
  message
) {
  const applicationId =
    getKotobaruMessageApplicationId(
      message
    );

  const webhookId =
    getKotobaruMessageWebhookId(
      message
    );

  const type =
    getKotobaruMessageType(
      message
    );

  const hasInteractionMetadata =
    Boolean(
      message?.interaction_metadata ||
      message?.interactionMetadata ||
      message?.interaction
    );

  /*
   * DISCORD_LAUNCH_ACTIVITY が作るフォローアップは、
   * ことばル Application に紐づくメッセージです。
   *
   * 通常のPreview投稿はBot Tokenで作った普通のメッセージなので、
   * application_id / webhook_id / Interaction metadata の組み合わせには
   * 基本的に入りません。
   *
   * 以前は interaction_metadata 必須にしていたため、
   * Discord側の自動フォローアップで metadata が省略されるケースを
   * 取りこぼしていました。
   */
  const isKotobaruApplication =
    applicationId ===
      KOTOBARU_CLIENT_ID;

  const looksLikeInteractionFollowup =
    hasInteractionMetadata ||
    Boolean(webhookId) ||
    type === 20;

  return (
    isKotobaruApplication &&
    looksLikeInteractionFollowup
  );
}

function summarizeKotobaruMessageForLog(
  message
) {
  return {
    id:
      message?.id ?? null,
    type:
      getKotobaruMessageType(
        message
      ),
    authorId:
      message?.author?.id ?? null,
    applicationId:
      getKotobaruMessageApplicationId(
        message
      ),
    webhookId:
      getKotobaruMessageWebhookId(
        message
      ),
    hasInteractionMetadata:
      Boolean(
        message?.interaction_metadata ||
        message?.interactionMetadata ||
        message?.interaction
      ),
  };
}

async function cleanupOldKotobaruLaunchMessages(
  channelId
) {
  if (
    typeof channelId !==
      "string" ||
    !channelId
  ) {
    return {
      scanned: 0,
      matched: 0,
      deleted: 0,
      forbidden: false,
    };
  }

  const result = {
    scanned: 0,
    matched: 0,
    deleted: 0,
    forbidden: false,
  };

  try {
    /*
     * Activityを起動したチャンネルだけを走査します。
     * サーバー全体を検索しないので、負荷と誤削除を抑えます。
     * Discord APIの上限は1回100件です。
     */
    const response =
      await discordRest(
        `/channels/${channelId}/messages?limit=100`
      );

    if (!response.ok) {
      console.warn(
        "ことばル起動カード走査失敗:",
        channelId,
        response.status
      );

      if (
        response.status === 403
      ) {
        console.warn(
          "起動カード走査に必要な権限が不足しています。対象チャンネルで「チャンネルを見る」「メッセージ履歴を読む」を確認してください。"
        );
      }

      return result;
    }

    const messages =
      await response.json();

    result.scanned =
      Array.isArray(messages)
        ? messages.length
        : 0;

    /*
     * DiscordのDISCORD_LAUNCH_ACTIVITYが作ったカードは
     * 「ことばルApplicationに紐づくInteraction由来メッセージ」
     * として判定します。
     *
     * type === 20 だけに頼らないのが重要です。
     * Discordの返却形式が変わった場合でも、application_id と
     * interaction_metadata / interaction を使って識別できます。
     *
     * Previewは通常のBot投稿なので interaction_metadata がなく、
     * この条件には入りません。
     */
    const launchMessages =
      messages.filter(
        (message) =>
          isKotobaruLaunchCardMessage(
            message
          )
      );

    /*
     * 該当0件でも必ずログを残します。
     * これで「awake自体が来ていない」のか
     * 「走査したがカードを識別できない」のかを切り分けられます。
     */
    console.log(
      `ことばル起動カード走査: channel=${channelId} / 走査${result.scanned}件 / 該当${launchMessages.length}件`
    );

    if (
      launchMessages.length === 0
    ) {
      const diagnostic =
        messages
          .slice(0, 12)
          .map(
            summarizeKotobaruMessageForLog
          );

      console.log(
        "ことばル起動カード診断:",
        JSON.stringify(
          diagnostic
        )
      );
    }

    result.matched =
      launchMessages.length;

    for (
      const message of
      launchMessages
    ) {
      const deleteResponse =
        await discordRest(
          `/channels/${channelId}/messages/${message.id}`,
          {
            method:
              "DELETE",
          }
        );

      if (
        deleteResponse.ok ||
        deleteResponse.status ===
          404
      ) {
        result.deleted += 1;

        console.log(
          `ことばル起動カード削除: ${message.id}`
        );

        continue;
      }

      if (
        deleteResponse.status ===
          403
      ) {
        result.forbidden =
          true;

        console.warn(
          `ことばル起動カード削除権限不足: ${message.id}`
        );

        console.warn(
          "対象チャンネルでBotに「メッセージの管理」を付与してください。"
        );

        continue;
      }

      console.warn(
        "ことばル起動カード削除失敗:",
        message.id,
        deleteResponse.status,
        await deleteResponse
          .text()
          .catch(
            () => ""
          )
      );
    }

    if (
      result.matched > 0
    ) {
      console.log(
        `ことばル起動カード整理完了: 走査${result.scanned}件 / 該当${result.matched}件 / 削除${result.deleted}件`
      );
    }

    return result;
  } catch (error) {
    console.warn(
      "ことばル起動カード整理に失敗しました:",
      error
    );

    return result;
  }
}

function scheduleKotobaruLaunchCleanup(
  channelId
) {
  if (
    typeof channelId !==
      "string" ||
    !channelId
  ) {
    return;
  }

  console.log(
    `ことばル起動カード整理を予約: channel=${channelId}`
  );

  const now =
    Date.now();

  const scheduledUntil =
    launchCleanupScheduledUntil.get(
      channelId
    ) || 0;

  /*
   * ほぼ同時に複数人がActivityを開いた場合でも、
   * 同じチャンネルを何重にも走査しません。
   */
  if (
    scheduledUntil > now
  ) {
    return;
  }

  const windowMs =
    40000;

  launchCleanupScheduledUntil.set(
    channelId,
    now + windowMs
  );

  /*
   * Renderが起きた直後に1回。
   * Discord側で起動カード生成が少し遅れるケースに備えて、
   * 4秒・12秒・25秒後にも再確認します。
   */
  const delays = [
    0,
    4000,
    12000,
    25000,
  ];

  for (
    const delay of delays
  ) {
    setTimeout(
      () => {
        cleanupOldKotobaruLaunchMessages(
          channelId
        ).catch(
          () => null
        );
      },
      delay
    );
  }

  setTimeout(
    () => {
      const current =
        launchCleanupScheduledUntil.get(
          channelId
        );

      if (
        current &&
        current <=
          Date.now()
      ) {
        launchCleanupScheduledUntil.delete(
          channelId
        );
      }
    },
    windowMs + 1000
  );
}

app.post(
  "/api/kotobaru/awake",
  async (req, res) => {
    const guildId =
      req.body?.guildId;

    const channelId =
      req.body?.channelId;

    if (
      typeof guildId !==
        "string" ||
      !guildId
    ) {
      return res
        .status(400)
        .json({
          error:
            "guildId is required",
        });
    }

    try {
      console.log(
        `ことばル awake受信: guild=${guildId} / activityChannel=${channelId || "なし"}`
      );

      /*
       * 昨日の結果確認はREST APIで行うため、
       * Discord GatewayのReady待ちは不要です。
       */
      const summary =
        await ensureYesterdaySummaryForGuild(
          guildId
        );

      /*
       * Activity SDK の channelId と、ことばル設定の表示先チャンネルが
       * 必ずしも同じとは限りません。
       *
       * Play now! はPreviewのある表示先から押されるため、
       * 設定済みの summaryChannelId も必ず走査対象へ含めます。
       */
      const config =
        await getKotobaruGuildConfig(
          guildId
        );

      const cleanupChannels =
        new Set(
          [
            channelId,
            config?.summaryChannelId,
          ].filter(Boolean)
        );

      console.log(
        "ことばル起動カード整理対象:",
        JSON.stringify(
          [...cleanupChannels]
        )
      );

      for (
        const cleanupChannelId of
        cleanupChannels
      ) {
        scheduleKotobaruLaunchCleanup(
          cleanupChannelId
        );
      }

      return res.json({
        ok: true,
        gatewayReady:
          kotobaruBot.isReady(),
        cleanupChannels:
          [...cleanupChannels],
        summary,
      });
    } catch (error) {
      console.error(
        "ことばル起動確認エラー:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          gatewayReady:
            kotobaruBot.isReady(),
        });
    }
  }
);

/* =========================================================
 * 毎日0:05
 * ======================================================= */

cron.schedule(
  "5 0 * * *",
  () => {
    postYesterdayKotobaruSummary()
      .catch(
        (error) => {
          console.error(
            "ことばル日次集計エラー:",
            error
          );
        }
      );
  },
  {
    timezone:
      "Asia/Tokyo",
  }
);

/* =========================================================
 * ことばルBot起動
 * ======================================================= */
async function startKotobaruBot() {
  if (!KOTOBARU_BOT_TOKEN) {
    console.warn(
      "KOTOBARU_DISCORD_TOKEN が未設定です。"
    );

    return;
  }

  console.log(
    "ことばルBot起動処理を開始します。"
  );

  console.log(
    `KOTOBARU_DISCORD_TOKEN: 設定済み / 文字数 ${KOTOBARU_BOT_TOKEN.length}`
  );

  console.log(
    `KOTOBARU_LOG_ENCRYPTION_KEY: ${
      getKotobaruEncryptionKey()
        ? "設定済み"
        : "未設定または不正"
    }`
  );

  /*
   * BotがDiscordに接続できたとき
   */
  kotobaruBot.once(
    Events.ClientReady,
    async (readyClient) => {
      console.log(
        `ことばル Bot ready: ${readyClient.user.tag}`
      );

      /*
       * スラッシュコマンド同期
       */
      try {
        await registerKotobaruCommands();
      } catch (error) {
        console.error(
          "ことばルコマンド同期処理エラー:",
          error
        );
      }

      /*
       * Discordチャンネルから設定復元
       */
      for (
        const guild of
        readyClient.guilds.cache.values()
      ) {
        await refreshKotobaruGuildConfig(
          guild
        ).catch(
          (error) => {
            console.error(
              `ことばル設定復元エラー: ${guild.name}`,
              error
            );
          }
        );
      }
    }
  );

  /*
   * Discord Clientエラー
   */
  kotobaruBot.on(
    Events.Error,
    (error) => {
      console.error(
        "ことばルDiscord Client Error:",
        error
      );
    }
  );

  console.log(
    "Discord Gatewayへ接続を開始します..."
  );

  /*
   * 90秒経ってもReadyにならない場合だけ警告
   */
  const timeout = setTimeout(
    () => {
      if (!kotobaruBot.isReady()) {
        console.warn(
          "ことばルBot: 90秒経過してもDiscord Gatewayへの接続が完了していません。"
        );
      }
    },
    90000
  );

  try {
    await kotobaruBot.login(
      KOTOBARU_BOT_TOKEN
    );

    clearTimeout(timeout);

    console.log(
      "Discord login() 処理完了"
    );
  } catch (error) {
    clearTimeout(timeout);

    console.error(
      "ことばルBotログイン失敗:",
      error
    );
  }
}


/*
 * Bot起動
 */
startKotobaruBot().catch(
  (error) => {
    console.error(
      "ことばルBot起動処理全体でエラー:",
      error
    );
  }
);

/* =========================================================
 * 三人将棋のdist配信
 *
 * 既存処理を最後に残します。
 * APIより前に置かないことが重要です。
 * ======================================================= */

const distPath =
  path.join(
    __dirname,
    "../dist"
  );

app.use(
  express.static(
    distPath
  )
);

app.use(
  (req, res) => {
    res.sendFile(
      path.join(
        distPath,
        "index.html"
      )
    );
  }
);

/* =========================================================
 * サーバー起動
 * ======================================================= */

server.listen(
  PORT,
  () => {
    console.log(
      `Relay Shogi + Kotobaru production server running on port ${PORT}`
    );
  }
);
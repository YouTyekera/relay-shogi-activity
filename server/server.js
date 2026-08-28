import "dotenv/config";

import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import cron from "node-cron";

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

  /* =========================================================
 * パス
 * ======================================================= */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

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
    ],
  });

const RECORD_PREFIX =
  "KOTOBARU_RECORD:";

const SUMMARY_MARKER_PREFIX =
  "KOTOBARU_SUMMARY_POSTED:";

const LIVE_CARD_MARKER_PREFIX =
  "KOTOBARU_LIVE_CARD:";

const CONFIG_TOPIC_PREFIX =
  "KOTOBARU_LOG_CHANNEL:";

/*
 * 今日プレイ中の途中経過。
 * Render再起動時には消えますが、終了済み結果は
 * #ことばル-記録 から復元されるため問題ありません。
 */
const liveProgressByGuild =
  new Map();

/*
 * Discord APIへの不要な再取得を減らすためのキャッシュ。
 * Render再起動時は自動的に作り直されます。
 */
const liveCardMessageIds =
  new Map();

const finishedRecordsCache =
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

  return body.pattern.every(
    (row) =>
      typeof row ===
        "string" &&
      /^[🟩🟨🟪⬛]{5}$/u.test(
        row
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

  return body.pattern.every(
    (row) =>
      typeof row ===
        "string" &&
      /^[🟩🟨🟪⬛]{5}$/u.test(
        row
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

  const summaryChannelId =
    topic
      .slice(
        CONFIG_TOPIC_PREFIX.length
      )
      .split(
        /\s|\|/
      )[0]
      ?.trim();

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

  for (
    const channel of
    guild.channels.cache.values()
  ) {
    const config =
      configFromTopic(
        channel
      );

    if (config) {
      guildConfigs.set(
        guild.id,
        config
      );

      return config;
    }
  }

  guildConfigs.delete(
    guild.id
  );

  return null;
}

async function getKotobaruGuildConfig(
  guildId
) {
  /*
   * メモリキャッシュがあれば
   * まずそれを使用。
   */
  const cached =
    guildConfigs.get(
      guildId
    );

  if (cached) {
    return cached;
  }

  /*
   * Gatewayに頼らず
   * Discord REST APIから
   * サーバーのチャンネル一覧を取得。
   */
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

    /*
     * CONFIG_TOPIC_PREFIX
     * が付いているテキストチャンネルを探す。
     */
    for (
      const channel of
      channels
    ) {
      /*
       * Discord Channel Type 0
       * = Guild Text
       */
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

      const summaryChannelId =
        topic
          .slice(
            CONFIG_TOPIC_PREFIX.length
          )
          .split(
            /\s|\|/
          )[0]
          ?.trim();

      if (
        !summaryChannelId
      ) {
        continue;
      }

      const config = {
        guildId,

        logChannelId:
          channel.id,

        summaryChannelId,
      };

      guildConfigs.set(
        guildId,
        config
      );

      return config;
    }

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

async function loadKotobaruResultsForDate(
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
          date
      ) {
        continue;
      }

      /*
       * Discordは新しいメッセージから返すので、
       * 最初に見つけたものがその人の最新結果。
       */
      if (
        !byUser.has(
          record.userId
        )
      ) {
        byUser.set(
          record.userId,
          record
        );
      }
    } catch {
      // 壊れた記録は無視
    }
  }

  return [
    ...byUser.values(),
  ];
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
 * 今日の途中経過をメモリへ保存
 * ======================================================= */

function setKotobaruLiveProgress(
  progress
) {
  const key =
    `${progress.guildId}:${progress.date}`;

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

  map.set(
    progress.userId,
    {
      ...progress,
      updatedAt:
        Date.now(),
    }
  );
}

function getKotobaruLiveProgress(
  guildId,
  date
) {
  const key =
    `${guildId}:${date}`;

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
   * 3時間以上更新されていない途中経過は
   * 「挑戦中」扱いから外します。
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

/* =========================================================
 * 「今日の挑戦」公開カード
 * ======================================================= */

function activityLinkButton(
  label = "すぐ遊ぶ"
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
  records,
  liveProgress,
  puzzleNumber,
  date
) {
  const byUser =
    new Map();

  /*
   * まず途中経過を入れる。
   */
  for (
    const progress of
    liveProgress
  ) {
    byUser.set(
      progress.userId,
      progress
    );
  }

  /*
   * 終了済み記録がある場合はそちらを優先。
   */
  for (
    const record of
    records
  ) {
    byUser.set(
      record.userId,
      {
        ...record,
        finished: true,
      }
    );
  }

  const entries =
    [
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

  const fields =
    entries
      .slice(
        0,
        20
      )
      .map(
        (entry) => {
          let status;

          if (
            !entry.finished
          ) {
            status =
              `${entry.pattern.length}/6　挑戦中`;
          } else if (
            entry.won
          ) {
            status =
              `${entry.attempts}/6`;
          } else {
            status =
              "×/6";
          }

          return {
            name:
              `${
                entry.finished
                  ? entry.won
                    ? "✓ "
                    : ""
                  : "✏️ "
              }${entry.displayName}　${status}`,

            value:
              entry.pattern.join(
                "\n"
              ),

            inline: true,
          };
        }
      );

  const activeCount =
    entries.filter(
      (entry) =>
        !entry.finished
    ).length;

  const finishedCount =
    entries.filter(
      (entry) =>
        entry.finished
    ).length;

  const description = [
    activeCount > 0
      ? `${activeCount}人がいま挑戦中です。`
      : null,

    finishedCount > 0
      ? `${finishedCount}人が今日の挑戦を終えました。`
      : null,

    "答えの文字は伏せたまま、色の並びだけを表示しています。",
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
        title:
          "今日の挑戦",

        description,

        color:
          0x4aa340,

        fields:
          fields.length
            ? fields
            : [
                {
                  name:
                    "まだ挑戦者はいません",
                  value:
                    "最初の挑戦者になりましょう。",
                  inline:
                    false,
                },
              ],

        footer: {
          text:
            date,
        },
      },
    ],

    components:
      activityLinkButton(
        "すぐ遊ぶ"
      ),
  };
}

async function findKotobaruLiveCardMessageId(
  logChannelId,
  date
) {
  const cacheKey =
    `${logChannelId}:${date}`;

  const cachedId =
    liveCardMessageIds.get(
      cacheKey
    );

  if (cachedId) {
    return cachedId;
  }

  const messages =
    await fetchRecentKotobaruMessagesRest(
      logChannelId,
      100
    );

  const prefix =
    `${LIVE_CARD_MARKER_PREFIX}${date}:`;

  const marker =
    messages.find(
      (message) =>
        message.author?.bot &&
        typeof message.content ===
          "string" &&
        message.content.startsWith(
          prefix
        )
    );

  if (!marker) {
    return null;
  }

  const messageId =
    marker.content
      .slice(
        prefix.length
      )
      .trim() || null;

  if (messageId) {
    liveCardMessageIds.set(
      cacheKey,
      messageId
    );
  }

  return messageId;
}

async function saveKotobaruLiveCardMarker(
  logChannelId,
  date,
  messageId
) {
  await discordRest(
    `/channels/${logChannelId}/messages`,
    {
      method:
        "POST",

      body:
        JSON.stringify({
          content:
            `${LIVE_CARD_MARKER_PREFIX}${date}:${messageId}`,
        }),
    }
  );

  liveCardMessageIds.set(
    `${logChannelId}:${date}`,
    messageId
  );
}

async function upsertKotobaruLiveCard(
  guildId,
  date,
  puzzleNumber
) {
  const config =
    await getKotobaruGuildConfig(
      guildId
    );

  if (!config) {
    return false;
  }

  const records =
    await getCachedKotobaruResults(
      guildId,
      date
    );

  const liveProgress =
    getKotobaruLiveProgress(
      guildId,
      date
    );

  const payload =
    buildKotobaruLiveCardPayload(
      records,
      liveProgress,
      puzzleNumber,
      date
    );

  const existingId =
    await findKotobaruLiveCardMessageId(
      config.logChannelId,
      date
    );

  if (existingId) {
    const editResponse =
      await discordRest(
        `/channels/${config.summaryChannelId}/messages/${existingId}`,
        {
          method:
            "PATCH",

          body:
            JSON.stringify(
              payload
            ),
        }
      );

    if (
      editResponse.ok
    ) {
      return true;
    }

    console.warn(
      "今日の挑戦カードを更新できなかったため再作成します:",
      editResponse.status
    );
  }

  const createResponse =
    await discordRest(
      `/channels/${config.summaryChannelId}/messages`,
      {
        method:
          "POST",

        body:
          JSON.stringify(
            payload
          ),
      }
    );

  if (!createResponse.ok) {
    console.error(
      "今日の挑戦カード作成失敗:",
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

  await saveKotobaruLiveCardMarker(
    config.logChannelId,
    date,
    created.id
  );

  return true;
}

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

  const records =
    await loadKotobaruResultsForDate(
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

  const sorted =
    records.sort(
      (a, b) => {
        if (
          a.won !==
          b.won
        ) {
          return a.won
            ? -1
            : 1;
        }

        if (!a.won) {
          return 0;
        }

        return (
          a.attempts -
          b.attempts
        );
      }
    );

  const fields =
    sorted
      .slice(
        0,
        20
      )
      .map(
        (record, index) => ({
          name:
            `${
              index === 0 &&
              record.won
                ? "👑 "
                : ""
            }${record.displayName}　${
              record.won
                ? `${record.attempts}/6`
                : "×/6"
            }`,

          value:
            record.pattern.join(
              "\n"
            ),

          inline:
            true,
        })
      );

  const response =
    await discordRest(
      `/channels/${config.summaryChannelId}/messages`,
      {
        method:
          "POST",

        body:
          JSON.stringify({
            content:
              "**今日のことばルも遊べます！**",

            embeds: [
              {
                title:
                  `ことばル 第${puzzleNumber}問　昨日の結果`,

                description:
                  `${sorted.length}人が挑戦しました。`,

                color:
                  0x4aa340,

                fields,

                footer: {
                  text:
                    date,
                },
              },
            ],

            components:
              activityLinkButton(
                "今日も遊ぶ"
              ),
          }),
      }
    );

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
    !interaction.guild ||
    !interaction.channel ||
    interaction.channel.type !==
      ChannelType.GuildText
  ) {
    await interaction.reply({
      content:
        "サーバーのテキストチャンネルで実行してください。",

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

  await interaction.deferReply({
    ephemeral:
      true,
  });

  const guild =
    interaction.guild;

  const summaryChannel =
    interaction.channel;

  const config =
    await refreshKotobaruGuildConfig(
      guild
    );

  let logChannel =
    config
      ? guild.channels.cache.get(
          config.logChannelId
        )
      : null;

  if (
    !logChannel ||
    logChannel.type !==
      ChannelType.GuildText
  ) {
    logChannel =
      await guild.channels.create({
        name:
          "ことばル-記録",

        type:
          ChannelType.GuildText,

        parent:
          summaryChannel.parentId ??
          undefined,

        topic:
          `${CONFIG_TOPIC_PREFIX}${summaryChannel.id} | ことばルの結果記録用`,

        permissionOverwrites: [
          {
            id:
              guild.roles
                .everyone
                .id,

            deny: [
              PermissionFlagsBits.ViewChannel,
            ],
          },

          {
            id:
              kotobaruBot
                .user.id,

            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ],

        reason:
          "ことばルの結果記録用",
      });
  } else {
    await logChannel.setTopic(
      `${CONFIG_TOPIC_PREFIX}${summaryChannel.id} | ことばルの結果記録用`
    );
  }

  guildConfigs.set(
    guild.id,
    {
      guildId:
        guild.id,

      logChannelId:
        logChannel.id,

      summaryChannelId:
        summaryChannel.id,
    }
  );

  await interaction.editReply(
    [
      "ことばルの設定が完了しました。",
      `・昨日の結果：${summaryChannel}`,
      `・記録用：${logChannel}`,
      "",
      "記録用チャンネルは一般メンバーから非表示です。",
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
      "まだ設定されていません。結果を表示したいチャンネルで `/ことばル設定` を実行してください。"
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
      "このチャンネルを昨日の結果の投稿先に設定します"
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

async function registerKotobaruCommands() {
  for (
    const guild of
    kotobaruBot.guilds.cache.values()
  ) {
    try {
      await guild.commands.set(
        kotobaruCommands
      );

      console.log(
        `ことばルコマンド同期完了: ${guild.name}`
      );
    } catch (error) {
      console.error(
        `ことばルコマンド同期エラー: ${guild.name}`,
        error
      );
    }
  }
}

/* =========================================================
 * スラッシュコマンド実行
 * ======================================================= */

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
      progress
    );

    try {
      const updated =
        await upsertKotobaruLiveCard(
          progress.guildId,
          progress.date,
          progress.puzzleNumber
        );

      return res.json({
        ok: true,
        cardUpdated:
          updated,
      });
    } catch (error) {
      console.error(
        "ことばル途中経過反映エラー:",
        error
      );

      /*
       * ゲーム本体を止めないため、途中経過の表示失敗は
       * 200で返し、記録処理とは切り離します。
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

        puzzleNumber:
          req.body.puzzleNumber,

        date:
          req.body.date,

        attempts:
          req.body.attempts,

        won:
          req.body.won,

        pattern:
          req.body.pattern,

        savedAt:
          new Date()
            .toISOString(),
      };

      /* =========================
       * Discord REST APIで
       * #ことばル-記録へ投稿
       * ======================= */

      const response =
        await discordRest(
          `/channels/${config.logChannelId}/messages`,
          {
            method:
              "POST",

            body:
              JSON.stringify({
                content:
                  `${RECORD_PREFIX}${JSON.stringify(
                    record
                  )}`,
              }),
          }
        );

      if (!response.ok) {
        const text =
          await response
            .text()
            .catch(
              () => ""
            );

        console.error(
          "ことばル結果Discord保存失敗:",
          response.status,
          text
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
      setKotobaruLiveProgress({
        ...record,
        finished: true,
      });

      cacheFinishedKotobaruRecord(
        record
      );

      await upsertKotobaruLiveCard(
        record.guildId,
        record.date,
        record.puzzleNumber
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
    });
  }
);

app.post(
  "/api/kotobaru/awake",
  async (req, res) => {
    const guildId =
      req.body?.guildId;

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
      /*
       * 昨日の結果確認はREST APIで行うため、
       * Discord GatewayのReady待ちは不要です。
       */
      const summary =
        await ensureYesterdaySummaryForGuild(
          guildId
        );

      return res.json({
        ok: true,
        gatewayReady:
          kotobaruBot.isReady(),
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
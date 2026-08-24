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

const CONFIG_TOPIC_PREFIX =
  "KOTOBARU_LOG_CHANNEL:";

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
  const cached =
    guildConfigs.get(
      guildId
    );

  if (cached) {
    return cached;
  }

  const guild =
    await kotobaruBot.guilds
      .fetch(guildId)
      .catch(
        () => null
      );

  if (!guild) {
    return null;
  }

  return refreshKotobaruGuildConfig(
    guild
  );
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
 * 記録チャンネル読み込み
 * ======================================================= */

async function fetchRecentKotobaruMessages(
  channel,
  max = 1000
) {
  const result = [];

  let before;

  while (
    result.length <
    max
  ) {
    const batch =
      await channel.messages.fetch({
        limit: 100,

        ...(before
          ? {
              before,
            }
          : {}),
      });

    if (
      !batch.size
    ) {
      break;
    }

    result.push(
      ...batch.values()
    );

    before =
      batch.last()?.id;

    if (
      batch.size < 100
    ) {
      break;
    }
  }

  return result;
}

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

  const channel =
    await getKotobaruTextChannel(
      config.logChannelId
    );

  if (
    !channel ||
    !(
      "messages" in
      channel
    )
  ) {
    return [];
  }

  const messages =
    await fetchRecentKotobaruMessages(
      channel
    );

  const byUser =
    new Map();

  for (
    const message of
    messages
  ) {
    if (
      !message.author.bot ||
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

  const summaryChannel =
    await getKotobaruTextChannel(
      config.summaryChannelId
    );

  if (
    !summaryChannel ||
    !(
      "send" in
      summaryChannel
    )
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
        (
          record,
          index
        ) => ({
          name:
            `${
              index ===
                0 &&
              record.won
                ? "👑 "
                : ""
            }${
              record.displayName
            }　${
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

  const embed =
    new EmbedBuilder()
      .setTitle(
        `ことばル 第${puzzleNumber}問　昨日の結果`
      )
      .setDescription(
        `${sorted.length}人が挑戦しました。`
      )
      .addFields(
        fields
      )
      .setFooter({
        text:
          date,
      });

  await summaryChannel.send({
    content:
      "**今日のことばルも遊べます！**",

    embeds: [
      embed,
    ],
  });

  return true;
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
    return;
  }

  const config =
    await refreshKotobaruGuildConfig(
      interaction.guild
    );

  if (!config) {
    await interaction.reply({
      content:
        "まだ設定されていません。結果を表示したいチャンネルで `/ことばル設定` を実行してください。",

      ephemeral:
        true,
    });

    return;
  }

  await interaction.reply({
    content:
      [
        "現在の設定",
        `・昨日の結果：<#${config.summaryChannelId}>`,
        `・記録用：<#${config.logChannelId}>`,
      ].join("\n"),

    ephemeral:
      true,
  });
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
 * ことばル結果保存
 * ======================================================= */

app.post(
  "/api/kotobaru/result",
  async (req, res) => {
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

    if (
      !kotobaruBot.isReady()
    ) {
      return res
        .status(503)
        .json({
          error:
            "Kotobaru Bot is not ready",
        });
    }

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

    const channel =
      await getKotobaruTextChannel(
        config.logChannelId
      );

    if (
      !channel ||
      !(
        "send" in
        channel
      )
    ) {
      return res
        .status(503)
        .json({
          error:
            "記録チャンネルを利用できません",
        });
    }

    const record = {
      guildId:
        req.body.guildId,

      userId:
        req.body.userId,

      displayName:
        req.body.displayName.slice(
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
        new Date().toISOString(),
    };

    await channel.send(
      `${RECORD_PREFIX}${JSON.stringify(
        record
      )}`
    );

    return res.json({
      ok: true,
    });
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

      botReady:
        kotobaruBot.isReady(),
    });
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

if (KOTOBARU_BOT_TOKEN) {

  console.log(
    "ことばルBot起動処理を開始します。"
  );

  console.log(
    `KOTOBARU_DISCORD_TOKEN: 設定済み / 文字数 ${KOTOBARU_BOT_TOKEN.length}`
  );

  kotobaruBot.once(
    Events.ClientReady,
    async (readyClient) => {

      console.log(
        `ことばル Bot ready: ${readyClient.user.tag}`
      );

      await registerKotobaruCommands();

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
    "Discord Botへログインを試みます..."
  );

  kotobaruBot
    .login(
      KOTOBARU_BOT_TOKEN
    )
    .then(() => {
      console.log(
        "Discord login() 呼び出し成功"
      );
    })
    .catch(
      (error) => {
        console.error(
          "ことばルBotログイン失敗:",
          error
        );
      }
    );

} else {

  console.warn(
    "KOTOBARU_DISCORD_TOKEN が未設定です。"
  );
}

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
import { loadConfig } from "../../src/config/io.js";
import { sendMessageDiscord } from "../../src/discord/send.outbound.js";
import { deliverOutboundPayloads } from "../../src/infra/outbound/deliver.js";
import { resolveOutboundTarget } from "../../src/infra/outbound/targets.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { sendMessageSignal } from "../../src/signal/send.js";
import { sendMessageSlack } from "../../src/slack/send.js";
import { sendMessageTelegram } from "../../src/telegram/send.js";
import { authManager } from "./src/auth-manager.js";
import { config } from "./src/config.js";
import { qrCodeAuthProvider } from "./src/providers/qr-code.js";
import { startHttpServer, setNotifyCallback } from "./src/server.js";
import type { AuthSession } from "./src/types.js";

let serverStarted = false;

export default function register(api: OpenClawPluginApi) {
  authManager.registerProvider(qrCodeAuthProvider);

  setNotifyCallback(async (session: AuthSession) => {
    api.logger.info(`[mfa-auth] User ${session.userId} verified`);

    try {
      const cfg = loadConfig();
      const commandBody = session.originalContext.commandBody;
      const channel = session.originalContext.channel;
      const triggerType = session.originalContext.triggerType || "sensitive_operation";

      const isFirstMessageAuth = triggerType === "first_message";

      if (!channel || channel === "web") {
        api.logger.info(
          `[mfa-auth] Web channel detected or no channel for ${session.userId}. Sending fallback notification.`,
        );
        await deliverOutboundPayloads({
          cfg,
          channel: "web",
          to: "",
          accountId: session.originalContext.accountId,
          payloads: [
            {
              text: isFirstMessageAuth
                ? `🎉 首次认证成功！请重新发送消息以继续对话。`
                : `✅ 二次认证成功！\n\n请回到聊天窗口，重新发送之前的命令（或回复'确认'）即可执行。`,
            },
          ],
        });
        return;
      }

      const to = session.originalContext.to || session.userId;
      const accountId = session.originalContext.accountId;

      let resolvedTo = to;
      try {
        const resolved = resolveOutboundTarget({
          channel,
          to,
          cfg,
          accountId,
          mode: "explicit",
        });

        if (resolved.ok) {
          resolvedTo = resolved.to;
        }
      } catch (e) {
        api.logger.warn(`[mfa-auth] Error resolving target: ${e}. Proceeding with original 'to'.`);
      }

      const finalTo = resolvedTo.startsWith(`${channel}:`) ? resolvedTo.slice(`${channel}:`.length) : resolvedTo;

      if (isFirstMessageAuth) {
        await deliverOutboundPayloads({
          cfg,
          channel,
          to: finalTo,
          accountId,
          payloads: [
            {
              text: `🎉 首次认证成功！请重新发送消息以继续对话。`,
            },
          ],
        });
        return;
      }

      try {
        switch (channel) {
          case "telegram":
            await sendMessageTelegram(finalTo, commandBody, { accountId });
            break;
          case "discord":
            await sendMessageDiscord(finalTo, commandBody, { accountId });
            break;
          case "slack":
            await sendMessageSlack(finalTo, commandBody, { accountId });
            break;
          case "whatsapp":
          case "signal":
            await sendMessageSignal(finalTo, commandBody, { accountId });
            break;
          default:
            api.logger.warn(
              `[mfa-auth] Unsupported channel for auto-execution: ${channel}. Sending fallback notification.`,
            );
            await deliverOutboundPayloads({
              cfg,
              channel,
              to: finalTo,
              accountId,
              payloads: [
                {
                  text: `✅ 二次认证成功！\n\n请重新发送之前的命令以执行操作。`,
                },
              ],
            });
            return;
        }

        api.logger.info(`[mfa-auth] Auto-executed command for ${session.userId} via ${channel}`);
      } catch (error) {
        api.logger.error(`[mfa-auth] Failed to auto-execute command: ${String(error)}`);
        await deliverOutboundPayloads({
          cfg,
          channel,
          to: finalTo,
          accountId,
          payloads: [
            {
              text: `✅ 二次认证成功！\n\n自动执行失败，请重新发送之前的命令以执行操作。`,
            },
          ],
        });
      }
    } catch (error) {
      api.logger.error(`[mfa-auth] Failed in notify callback: ${String(error)}`);
    }
  });

  api.on("before_tool_call", async (event, ctx) => {
    const { toolName, params } = event;

    api.logger.info(`[mfa-auth] Tool call detected: ${toolName}`);

    const sensitiveTools = ["bash", "exec", "runCommand", "command", "process"];
    if (!sensitiveTools.includes(toolName)) {
      api.logger.info(`[mfa-auth] Tool ${toolName} is not in sensitive list, allowing`);
      return undefined;
    }

    const command =
      typeof params?.command === "string"
        ? params.command
        : typeof params?.cmd === "string"
          ? params.cmd
          : typeof params?.input === "string"
            ? params.input
            : typeof params?.args === "string"
              ? params.args
              : "";

    api.logger.info(`[mfa-auth] Extracted command from ${toolName}: ${command}`);

    if (!command) {
      api.logger.info(`[mfa-auth] No command found in params, allowing`);
      return undefined;
    }

    const { isSensitive, preview } = checkSensitiveOperation(command);
    if (!isSensitive) {
      api.logger.info(`[mfa-auth] Command is not sensitive, allowing`);
      return undefined;
    }

    const userId = ctx.sessionKey || "unknown";

    if (authManager.isUserVerifiedForSensitiveOps(userId)) {
      api.logger.info(`[mfa-auth] User ${userId} is verified for sensitive ops, allowing`);
      return undefined;
    }

    api.logger.info(`[mfa-auth] User ${userId} is NOT verified for sensitive ops.`);

    const sessionKey = ctx.sessionKey || "";
    const sessionKeyParts = sessionKey.split(":").filter(Boolean);

    const parsedChannel = sessionKeyParts[2] || undefined;
    const parsedAccountId = sessionKeyParts[3] || undefined;
    const parsedTo = sessionKeyParts[sessionKeyParts.length - 1] || undefined;

    api.logger.info(
      `[mfa-auth] Parsed from sessionKey: channel=${parsedChannel}, accountId=${parsedAccountId}, to=${parsedTo}`,
    );

    const session = authManager.generateSession(userId, {
      sessionKey,
      senderId: userId,
      commandBody: command,
      channel: parsedChannel,
      to: parsedTo,
      accountId: parsedAccountId,
      toolName,
      toolParams: params,
      timestamp: Date.now(),
      triggerType: "sensitive_operation",
    });

    if (!session) {
      api.logger.error(`[mfa-auth] Failed to generate session for user ${userId}`);
      return undefined;
    }

    const authUrl = `http://localhost:${config.port}/mfa-auth/${session.sessionId}`;

    api.logger.info(`[mfa-auth] Blocking sensitive tool call: ${toolName} from ${userId}`);

    if (parsedChannel && parsedChannel !== "web") {
      const cfg = loadConfig();
      const to = parsedTo || userId;
      let resolvedTo = to;

      try {
        api.logger.info(
          `[mfa-auth] Sensitive operation params: channel=${parsedChannel}, to=${to}, accountId=${parsedAccountId}, userId=${userId}`,
        );

        try {
          const resolved = resolveOutboundTarget({
            channel: parsedChannel,
            to,
            cfg,
            accountId: parsedAccountId,
            mode: "explicit",
          });

          if (resolved.ok) {
            resolvedTo = resolved.to;
            api.logger.info(
              `[mfa-auth] Sensitive operation resolved target: resolvedTo=${resolvedTo}`,
            );
          } else {
            api.logger.warn(
              `[mfa-auth] Sensitive operation failed to resolve target: ${String(resolved.error)}`,
            );
          }
        } catch (e) {
          api.logger.warn(`[mfa-auth] Sensitive operation error resolving target: ${e}`);
        }

        const finalTo = resolvedTo.startsWith(`${parsedChannel}:`)
          ? resolvedTo.slice(`${parsedChannel}:`.length)
          : resolvedTo;

        await deliverOutboundPayloads({
          cfg,
          channel: parsedChannel,
          to: finalTo,
          accountId: parsedAccountId,
          payloads: [
            {
              text: `🔐 该操作需要二次认证\n\n检测到敏感操作: ${preview}\n\n请点击链接完成验证:\n${authUrl}\n\n验证有效期: ${Math.floor(config.timeout / 60000)} 分钟\n\n验证成功后，请回复"确认"或者重新发送之前的命令以继续执行。`,
            },
          ],
        });
      } catch (error) {
        const errorDetails = error instanceof Error ? error.message : String(error);
        api.logger.error(
          `[mfa-auth] Failed to send sensitive operation auth notification: ${errorDetails}`,
        );
        api.logger.error(
          `[mfa-auth] Sensitive operation notification details: channel=${parsedChannel}, to=${resolvedTo}, accountId=${parsedAccountId}`,
        );
      }
    }

    authManager.registerPendingExecution(userId, session.sessionId);

    return {
      block: true,
      blockReason: `🔐 该操作需要二次认证`,
    };
  });

  api.on("message_received", async (event, ctx) => {
    if (!config.requireAuthOnFirstMessage) {
      return;
    }

    const userId = event.from || ctx.conversationId || "unknown";

    if (authManager.isUserVerifiedForFirstMessage(userId)) {
      return;
    }

    api.logger.info(`[mfa-auth] First message from unauthenticated user ${userId}, requiring auth`);

    const parsedChannel = ctx.channelId;
    const parsedAccountId = ctx.accountId;
    const parsedTo = event.from;

    const session = authManager.generateSession(userId, {
      sessionKey: `${ctx.channelId}:${ctx.accountId}:${event.from}`,
      senderId: userId,
      commandBody: event.content || "",
      channel: parsedChannel,
      to: parsedTo,
      accountId: parsedAccountId,
      toolName: "",
      toolParams: {},
      timestamp: Date.now(),
      triggerType: "first_message",
    });

    if (!session) {
      api.logger.error(
        `[mfa-auth] Failed to generate first message auth session for user ${userId}`,
      );
      return;
    }

    const authUrl = `http://localhost:${config.port}/mfa-auth/${session.sessionId}`;

    api.logger.info(`[mfa-auth] Blocking first message from ${userId}`);

    if (parsedChannel && parsedChannel !== "web") {
      const cfg = loadConfig();
      let to = parsedTo || userId;
      let resolvedTo = to;

      try {
        api.logger.info(
          `[mfa-auth] First message auth params: channel=${parsedChannel}, to=${to}, accountId=${parsedAccountId}, userId=${userId}`,
        );

        try {
          const resolved = resolveOutboundTarget({
            channel: parsedChannel,
            to,
            cfg,
            accountId: parsedAccountId,
            mode: "explicit",
          });

          if (resolved.ok) {
            to = resolved.to;
            resolvedTo = resolved.to;
            api.logger.info(
              `[mfa-auth] Resolved target: resolvedTo=${resolvedTo}, resolved.ok=${resolved.ok}`,
            );
          } else {
            api.logger.warn(`[mfa-auth] Failed to resolve target: ${String(resolved.error)}`);
          }
        } catch (e) {
          api.logger.warn(`[mfa-auth] Error resolving target: ${e}`);
        }

        const finalTo = resolvedTo.startsWith(`${parsedChannel}:`)
          ? resolvedTo.slice(`${parsedChannel}:`.length)
          : resolvedTo;

        await deliverOutboundPayloads({
          cfg,
          channel: parsedChannel,
          to: finalTo,
          accountId: parsedAccountId,
          payloads: [
            {
              text: `🔐 首次对话需要进行认证\n\n为了您的账户安全，首次对话前需要完成身份验证。\n\n请点击链接完成验证:\n${authUrl}\n\n验证有效期: ${Math.floor(config.timeout / 60000)} 分钟`,
            },
          ],
        });
      } catch (error) {
        const errorDetails = error instanceof Error ? error.message : String(error);
        api.logger.error(
          `[mfa-auth] Failed to send first message auth notification: ${errorDetails}`,
        );
        api.logger.error(
          `[mfa-auth] Notification details: channel=${parsedChannel}, to=${resolvedTo}, accountId=${parsedAccountId}`,
        );
      }
    }
  });

  api.registerCommand({
    name: "reauth",
    description: "重新进行首次对话认证",
    acceptsArgs: false,
    requireAuth: false,
    handler: async (ctx) => {
      const userId = ctx.from || ctx.senderId || "unknown";

      authManager.clearFirstMessageAuth(userId);

      const parsedChannel = ctx.channel;
      const parsedAccountId = ctx.accountId;
      const parsedTo = ctx.to;

      const session = authManager.generateSession(userId, {
        sessionKey: `${parsedChannel}:${parsedAccountId}:${userId}`,
        senderId: userId,
        commandBody: "/reauth",
        channel: parsedChannel,
        to: parsedTo,
        accountId: parsedAccountId,
        toolName: "",
        toolParams: {},
        timestamp: Date.now(),
        triggerType: "first_message",
      });

      if (!session) {
        api.logger.error(`[mfa-auth] Failed to generate reauth session for user ${userId}`);
        return { text: "❌ 认证会话创建失败，请稍后重试。" };
      }

      const authUrl = `http://localhost:${config.port}/mfa-auth/${session.sessionId}`;

      api.logger.info(`[mfa-auth] Reauth requested by user ${userId}`);

      try {
        let resolvedTo = parsedTo || userId;
        try {
          const resolved = resolveOutboundTarget({
            channel: parsedChannel,
            to: parsedTo || userId,
            cfg: ctx.config,
            accountId: parsedAccountId,
            mode: "explicit",
          });

          if (resolved.ok) {
            resolvedTo = resolved.to;
            api.logger.info(`[mfa-auth] Reauth resolved target: resolvedTo=${resolvedTo}`);
          } else {
            api.logger.warn(
              `[mfa-auth] Reauth failed to resolve target: ${String(resolved.error)}`,
            );
            return { text: "❌ 解析目标地址失败，请稍后重试。" };
          }
        } catch (e) {
          api.logger.warn(`[mfa-auth] Reauth error resolving target: ${e}`);
          return { text: "❌ 解析目标地址失败，请稍后重试。" };
        }

        const finalTo = resolvedTo.startsWith(`${parsedChannel}:`)
          ? resolvedTo.slice(`${parsedChannel}:`.length)
          : resolvedTo;

        await deliverOutboundPayloads({
          cfg: ctx.config,
          channel: parsedChannel,
          to: finalTo,
          accountId: parsedAccountId,
          payloads: [
            {
              text: `🔐 重新认证\n\n请点击以下链接完成身份验证:\n${authUrl}\n\n验证有效期: ${Math.floor(config.timeout / 60000)} 分钟`,
            },
          ],
        });

        return { text: "📱 认证链接已发送，请查收。" };
      } catch (error) {
        api.logger.error(`[mfa-auth] Failed to send reauth notification: ${String(error)}`);
        return { text: "❌ 认证链接发送失败，请稍后重试。" };
      }
    },
  });

  if (!serverStarted) {
    api.logger.info("mfa-auth: Starting HTTP server...");
    startHttpServer();
    serverStarted = true;
    api.logger.info("mfa-auth plugin loaded");
  }
}

function checkSensitiveOperation(text: string): { isSensitive: boolean; preview: string } {
  const lowerText = text.toLowerCase();

  for (const keyword of config.sensitiveKeywords) {
    if (lowerText.includes(keyword.toLowerCase())) {
      const preview = text;
      return { isSensitive: true, preview };
    }
  }

  return { isSensitive: false, preview: "" };
}

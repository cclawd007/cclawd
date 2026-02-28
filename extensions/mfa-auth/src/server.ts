import http from "node:http";
import { authManager } from "./auth-manager.js";
import { config } from "./config.js";
import { dabbyClient } from "./dabby-client.js";
import { qrCodeAuthProvider } from "./providers/qr-code.js";
import { renderQrPngBase64 } from "./qr.js";
import type { AuthSession } from "./types.js";

let notifyCallback: ((session: AuthSession) => void | Promise<void>) | null = null;

export function setNotifyCallback(callback: (session: AuthSession) => void | Promise<void>): void {
  console.log("[mfa-auth] setNotifyCallback called");
  notifyCallback = callback;
}

export function startHttpServer(): void {
  console.log("[mfa-auth] startHttpServer called, attempting to start server on port", config.port);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
      return;
    }

    if (url.pathname.startsWith("/mfa-auth/")) {
      if (url.pathname === "/mfa-auth/verify") {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk.toString();
          });
          req.on("end", async () => {
            try {
              const { sessionId } = JSON.parse(body);
              const session = authManager.getSession(sessionId);
              if (!session) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Session not found" }));
                return;
              }

              const result = await authManager.verifySession(sessionId);

              if (result.success) {
                authManager.markUserVerified(session.userId);
                if (notifyCallback) {
                  await notifyCallback(session);
                }
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            } catch (error) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: "Invalid request" }));
            }
          });
          return;
        }
      }

      if (url.pathname === "/mfa-auth/refresh") {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk.toString();
          });
          req.on("end", async () => {
            try {
              const { sessionId } = JSON.parse(body);
              const session = authManager.getSession(sessionId);
              if (!session) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Session not found" }));
                return;
              }

              const tokenInfo = await dabbyClient.getQrCode();
              session.certToken = tokenInfo.certToken;
              session.qrcodeContent = tokenInfo.qrcodeContent;
              session.expireTimeMs = tokenInfo.expireTimeMs;

              authManager.updateAuthStatus(sessionId, "pending");
              console.log(`[mfa-auth] QR code refreshed for session ${session.sessionId}`);

              const qrcodeBase64 = await renderQrPngBase64(session.qrcodeContent);

              // 计算剩余时间
              const remainingTime = Math.max(
                0,
                Math.ceil((config.timeout - (Date.now() - session.timestamp)) / 1000),
              );

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  success: true,
                  qrcodeBase64,
                  expireTimeMs: session.expireTimeMs,
                  remainingTime,
                }),
              );
            } catch (error) {
              console.error(`[mfa-auth] Failed to refresh QR code: ${error}`);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: String(error) }));
            }
          });
          return;
        }
      }

      const sessionId = url.pathname.split("/")[2];
      if (req.method === "GET" && sessionId) {
        const session = authManager.getSession(sessionId);

        if (config.debug) {
          console.log(`[mfa-auth] GET request for sessionId: ${sessionId}`);
          console.log(`[mfa-auth] Session found: ${!!session}`);
          console.log(
            `[mfa-auth] All sessions: ${Array.from(authManager.getSessionIds()).join(", ")}`,
          );
        }

        if (!session) {
          if (config.debug) {
            console.log(`[mfa-auth] Session not found or expired: ${sessionId}`);
          }
          res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>验证码不存在</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
    h1 { color: #e53e3e; margin-top: 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>❌ 验证二维码不存在或已过期</h1>
    <p>请重新执行敏感操作以获取新的验证二维码</p>
  </div>
</body>
</html>
          `);
          return;
        }

        try {
          const provider = authManager.getProvider(session.authMethod);
          if (!provider) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Provider not found");
            return;
          }

          await provider.initialize(session);

          const authUrl = `http://localhost:${config.port}/mfa-auth/${session.sessionId}`;
          const html = await provider.generateAuthPage(session, authUrl);

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (error) {
          console.error(`[mfa-auth] Error generating auth page: ${error}`);
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>错误</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; }
    h1 { color: #e53e3e; margin-top: 0; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>❌ 生成认证页面失败</h1>
    <p>错误信息: ${String(error)}</p>
    <p>请稍后重试</p>
  </div>
</body>
</html>
          `);
        }
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(config.port, () => {
    console.log(`[mfa-auth] HTTP server running on http://localhost:${config.port}`);
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[mfa-auth] Port ${config.port} is already in use`);
    } else {
      console.error("[mfa-auth] Server error:", err);
    }
  });
}

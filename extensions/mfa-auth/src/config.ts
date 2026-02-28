import type { MfaConfig, DabbyConfig } from "./types.js";

function parseBooleanEnv(envValue?: string): boolean {
  if (!envValue) return false;
  const value = envValue.toLowerCase().trim();
  return value === "true" || value === "1" || value === "yes";
}

function parseStringArray(envValue?: string): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export const config: MfaConfig = {
  timeout: 5 * 60 * 1000, // 二维码倒计时有效期，默认5分钟
  verificationDuration:
    Number.parseInt(process.env.MFA_VERIFICATION_DURATION || "", 10) || 2 * 60 * 1000,
  port: 18801,
  debug: true,
  sensitiveKeywords: parseStringArray(process.env.MFA_SENSITIVE_KEYWORDS) || [
    "delete",
    "remove",
    "rm",
    "unlink",
    "rmdir",
    "format",
    "wipe",
    "erase",
    "exec",
    "eval",
    "system",
    "shell",
    "bash",
    "sudo",
    "su",
    "chmod",
    "chown",
    "restart",
    "shutdown",
    "reboot",
    "gateway",
  ],
  allowlistUsers: [],
  enabledAuthMethods: ["qr-code"],
  defaultAuthMethod: "qr-code",
  persistAuthStateDir: process.env.MFA_AUTH_STATE_DIR || "~/.openclaw/mfa-auth/",
  requireAuthOnFirstMessage: parseBooleanEnv(process.env.MFA_REQUIRE_AUTH_ON_FIRST_MESSAGE) ?? true,
  firstMessageAuthDuration:
    Number.parseInt(process.env.MFA_FIRST_MESSAGE_AUTH_DURATION || "", 10) || 24 * 60 * 60 * 1000,
};

export const dabbyConfig: DabbyConfig = {
  clientId: process.env.DABBY_CLIENT_ID || "",
  clientSecret: process.env.DABBY_CLIENT_SECRET || "",
  apiBaseUrl: "https://api.dabby.com.cn/v2/api",
  tokenCacheDuration: 7000000,
  pollInterval: 2000,
};

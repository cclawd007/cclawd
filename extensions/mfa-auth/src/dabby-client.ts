import { dabbyConfig } from "./config.js";
import type {
  DabbyConfig,
  DabbyAccessTokenResponse,
  DabbyQrCodeResponse,
  DabbyAuthResultResponse,
} from "./types.js";

const resolveFetch = (): typeof fetch => {
  const resolved = globalThis.fetch;
  if (!resolved) {
    throw new Error("fetch is not available in this environment");
  }
  return resolved;
};

export class DabbyClient {
  private cachedAccessToken: string | null = null;
  private tokenExpiryTime: number = 0;

  constructor(private config: DabbyConfig = dabbyConfig) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error("Dabby clientId and clientSecret are not configured");
    }

    if (!forceRefresh && this.cachedAccessToken && Date.now() < this.tokenExpiryTime) {
      return this.cachedAccessToken;
    }

    const url = `${this.config.apiBaseUrl}/getaccesstoken`;
    const params = new URLSearchParams({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
    const fetch = resolveFetch();
    const fullUrl = `${url}?${params.toString()}`;
    console.log(`[mfa-auth] Fetching accessToken from: ${fullUrl}`);

    let lastError: any;
    for (let i = 0; i < 3; i++) {
      try {
        const response = await fetch(fullUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "OpenClaw/1.0 (mfa-auth)",
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data: DabbyAccessTokenResponse = await response.json();

        if (data.retCode !== 0) {
          throw new Error(`Dabby API error: ${data.retMessage}`);
        }

        this.cachedAccessToken = data.accessToken;
        this.tokenExpiryTime = Date.now() + data.expireSeconds * 1000;

        console.log(`[mfa-auth] Dabby accessToken refreshed, expires in ${data.expireSeconds}s`);

        return this.cachedAccessToken;
      } catch (error: any) {
        console.error(`[mfa-auth] Attempt ${i + 1} failed to get accessToken: ${error.message}`);
        if (error.cause) {
          console.error(`[mfa-auth] Failure cause:`, error.cause);
        }
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1s before retry
      }
    }

    console.error(`[mfa-auth] Failed to get accessToken after 3 attempts`);
    throw lastError;
  }

  async refreshAccessToken(): Promise<string> {
    return this.getAccessToken(true);
  }

  async getQrCode(): Promise<DabbyQrCodeResponse["tokenInfo"]> {
    const accessToken = await this.getAccessToken();
    const fetch = resolveFetch();

    const url = `${this.config.apiBaseUrl}/authreq`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "OpenClaw/1.0 (mfa-auth)",
      },
      body: JSON.stringify({
        accessToken,
        authType: "ScanAuth",
        mode: 66,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: DabbyQrCodeResponse = await response.json();

    if (data.retCode !== 0) {
      throw new Error(`Dabby API error: ${data.retMessage}`);
    }

    console.log(`[mfa-auth] QR code generated, certToken: ${data.tokenInfo.certToken}`);

    return data.tokenInfo;
  }

  async getAuthResult(certToken: string): Promise<{
    status: "pending" | "verified" | "failed" | "expired";
    error?: string;
    authObject?: { idNum: string; fullName: string };
  }> {
    const accessToken = await this.getAccessToken();
    const fetch = resolveFetch();

    const url = `${this.config.apiBaseUrl}/authhist`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "OpenClaw/1.0 (mfa-auth)",
      },
      body: JSON.stringify({
        accessToken,
        authHistQry: { certToken },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data: DabbyAuthResultResponse = await response.json();

    // 处理特定的“等待中”状态码
    // 4401: 该 certToken 未进行认证 -> 视为 Pending 状态，继续轮询
    if (data.retCode !== 0) {
      if (data.retCode === 4401) {
        return { status: "pending" };
      }
      // 其他错误才抛出异常
      throw new Error(`Dabby API error: ${data.retMessage} (code: ${data.retCode})`);
    }

    const resCode = data.authData.resCode;
    const authObject = data.authData.authObject;

    if (resCode === 0) {
      return { status: "verified", authObject };
    }

    return { status: "failed", error: `认证失败 (resCode: ${resCode})` };
  }

  async checkQrCodeExpired(certToken: string, expireTimeMs: number): Promise<boolean> {
    return Date.now() > expireTimeMs;
  }
}

export const dabbyClient = new DabbyClient();

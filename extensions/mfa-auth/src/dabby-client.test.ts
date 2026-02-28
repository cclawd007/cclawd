import { describe, it, expect, vi, beforeEach } from "vitest";
import { dabbyConfig } from "./config.js";
import { DabbyClient } from "./dabby-client.js";

describe("DabbyClient", () => {
  let client: DabbyClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as any;
    client = new DabbyClient(dabbyConfig);
  });

  describe("getAccessToken", () => {
    it("should fetch and cache access token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          accessToken: "test-token-123",
          expireSeconds: 7200,
          apiVersion: "3.3.0",
          timestamp: Date.now(),
        }),
      });

      const token = await client.getAccessToken();
      expect(token).toBe("test-token-123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should use cached token if not expired", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          accessToken: "test-token-123",
          expireSeconds: 7200,
          apiVersion: "3.3.0",
          timestamp: Date.now(),
        }),
      });

      await client.getAccessToken();
      await client.getAccessToken();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should refresh token when forced", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          accessToken: "new-token-456",
          expireSeconds: 7200,
          apiVersion: "3.3.0",
          timestamp: Date.now(),
        }),
      });

      await client.getAccessToken();
      await client.refreshAccessToken();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should throw error when clientId or clientSecret is missing", async () => {
      const emptyClient = new DabbyClient({
        clientId: "",
        clientSecret: "",
        apiBaseUrl: "https://api.dabby.com.cn/v2/api",
        tokenCacheDuration: 7000000,
        pollInterval: 2000,
      });

      await expect(emptyClient.getAccessToken()).rejects.toThrow(
        "Dabby clientId and clientSecret are not configured",
      );
    });

    it("should throw error when API returns non-zero retCode", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 1001,
          retMessage: "认证失败",
          accessToken: "",
          expireSeconds: 0,
          apiVersion: "3.3.0",
          timestamp: Date.now(),
        }),
      });

      await expect(client.getAccessToken()).rejects.toThrow("Dabby API error: 认证失败");
    });
  });

  describe("getQrCode", () => {
    it("should fetch QR code with access token", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          accessToken: "test-token",
          expireSeconds: 7200,
          apiVersion: "3.3.0",
          timestamp: Date.now(),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          apiVersion: "3.3.0",
          tokenInfo: {
            authType: "ScanAuth",
            certToken: "cert-token-789",
            createdAt: "2024-01-01 00:00:00",
            expireAt: "2024-01-01 00:05:00",
            expireTimeMs: Date.now() + 5 * 60 * 1000,
            qrcodeContent: "https://h5.dabby.com.cn/authhtml/#/auth?certToken=cert-token-789",
            timestamp: Date.now(),
          },
        }),
      });

      const result = await client.getQrCode();
      expect(result.certToken).toBe("cert-token-789");
      expect(result.qrcodeContent).toContain("h5.dabby.com.cn");
    });
  });

  describe("getAuthResult", () => {
    it("should return verified status when resCode is 0", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          accessToken: "test-token",
          expireSeconds: 7200,
          apiVersion: "3.3.0",
          timestamp: Date.now(),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          apiVersion: "3.3.0",
          authData: {
            authMode: 66,
            authObject: {
              idNum: "44000000000000",
              fullName: "张三",
            },
            authType: "ScanAuth",
            portrait: "",
            resCode: 0,
            resStr: "00XX",
          },
          authInfo: {},
        }),
      });

      const result = await client.getAuthResult("cert-token-789");
      expect(result.status).toBe("verified");
      expect(result.authObject?.fullName).toBe("张三");
    });

    it("should return failed status when resCode is not 0", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          accessToken: "test-token",
          expireSeconds: 7200,
          apiVersion: "3.3.0",
          timestamp: Date.now(),
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          retCode: 0,
          retMessage: "成功",
          apiVersion: "3.3.0",
          authData: {
            authMode: 66,
            authObject: {
              idNum: "",
              fullName: "",
            },
            authType: "ScanAuth",
            portrait: "",
            resCode: 1002,
            resStr: "01XX",
          },
          authInfo: {},
        }),
      });

      const result = await client.getAuthResult("cert-token-789");
      expect(result.status).toBe("failed");
      expect(result.error).toContain("认证失败");
    });
  });

  describe("checkQrCodeExpired", () => {
    it("should return true when QR code is expired", () => {
      const expiredTime = Date.now() - 1000;
      const isExpired = client.checkQrCodeExpired("cert-token", expiredTime);
      expect(isExpired).toBe(true);
    });

    it("should return false when QR code is not expired", () => {
      const futureTime = Date.now() + 5 * 60 * 1000;
      const isExpired = client.checkQrCodeExpired("cert-token", futureTime);
      expect(isExpired).toBe(false);
    });
  });
});

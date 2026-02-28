import crypto from "node:crypto";
import { config } from "./config.js";
import type { AuthSession, AuthMethodProvider, AuthResult, PendingAuthContext } from "./types.js";

interface FirstMessageAuthRecord {
  verifiedAt: number;
}

export class AuthManager {
  private sessions = new Map<string, AuthSession>();
  public verifiedForSensitiveOps = new Map<string, number>();
  private verifiedForFirstMessage = new Map<string, number>();
  private providers = new Map<string, AuthMethodProvider>();
  private config = config;
  private pendingExecutions = new Map<string, { sessionId: string; timestamp: number }>();
  private persistDir: string;

  constructor() {
    this.persistDir = this.resolvePersistDir();
    this.loadPersistedFirstMessageAuth();
    setInterval(() => this.cleanup(), 30000);
  }

  private resolvePersistDir(): string {
    const dir = this.config.persistAuthStateDir || "~/.openclaw/mfa-auth/";
    if (dir.startsWith("~/")) {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "";
      return dir.replace("~", homeDir);
    }
    return dir;
  }

  private getPersistFilePath(): string {
    return `${this.persistDir}/first-message-auth.json`;
  }

  registerProvider(provider: AuthMethodProvider): void {
    this.providers.set(provider.methodType, provider);
  }

  loadPersistedFirstMessageAuth(): void {
    const filePath = this.getPersistFilePath();
    try {
      const fs = require("node:fs");
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const records = JSON.parse(content) as Record<string, FirstMessageAuthRecord>;
        const now = Date.now();
        const duration = this.config.firstMessageAuthDuration || 24 * 60 * 60 * 1000;

        for (const [userId, record] of Object.entries(records)) {
          if (now - record.verifiedAt < duration) {
            this.verifiedForFirstMessage.set(userId, record.verifiedAt);
          }
        }

        if (this.config.debug) {
          console.log(
            `[mfa-auth] Loaded ${this.verifiedForFirstMessage.size} first message auth records from ${filePath}`,
          );
        }
      }
    } catch (error) {
      console.error(`[mfa-auth] Failed to load persisted auth state: ${String(error)}`);
    }
  }

  persistFirstMessageAuth(userId: string): void {
    const filePath = this.getPersistFilePath();
    try {
      const fs = require("node:fs");
      const path = require("node:path");

      const records: Record<string, FirstMessageAuthRecord> = {};
      this.verifiedForFirstMessage.forEach((timestamp, id) => {
        records[id] = { verifiedAt: timestamp };
      });

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf-8");

      if (this.config.debug) {
        console.log(`[mfa-auth] Persisted first message auth state for ${userId} to ${filePath}`);
      }
    } catch (error) {
      console.error(`[mfa-auth] Failed to persist auth state: ${String(error)}`);
    }
  }

  clearFirstMessageAuth(userId: string): void {
    this.verifiedForFirstMessage.delete(userId);
    this.persistFirstMessageAuth(userId);
    if (this.config.debug) {
      console.log(`[mfa-auth] Cleared first message auth for user ${userId}`);
    }
  }

  isUserVerifiedForFirstMessage(userId: string): boolean {
    const verifiedTime = this.verifiedForFirstMessage.get(userId);
    if (!verifiedTime) return false;

    const duration = this.config.firstMessageAuthDuration || 24 * 60 * 60 * 1000;
    if (Date.now() - verifiedTime > duration) {
      this.verifiedForFirstMessage.delete(userId);
      this.persistFirstMessageAuth(userId);
      return false;
    }

    return true;
  }

  isUserVerifiedForSensitiveOps(userId: string): boolean {
    const verifiedTime = this.verifiedForSensitiveOps.get(userId);
    if (!verifiedTime) return false;

    if (Date.now() - verifiedTime > this.config.verificationDuration) {
      this.verifiedForSensitiveOps.delete(userId);
      return false;
    }

    return true;
  }

  getProvider(methodType: string): AuthMethodProvider | undefined {
    return this.providers.get(methodType);
  }

  generateSession(
    userId: string,
    originalContext: PendingAuthContext,
    authMethod: string = this.config.defaultAuthMethod,
    extraFields?: Partial<AuthSession>,
  ): AuthSession | null {
    const provider = this.getProvider(authMethod);
    if (!provider) {
      console.error(`[mfa-auth] Auth provider not found: ${authMethod}`);
      return null;
    }

    const sessionId = crypto.randomUUID();
    const session: AuthSession = {
      sessionId,
      userId,
      authMethod: authMethod as any,
      timestamp: Date.now(),
      originalContext,
      ...extraFields,
    };

    this.sessions.set(sessionId, session);

    if (this.config.debug) {
      console.log(`[mfa-auth] Generated session: ${sessionId}`);
      console.log(`[mfa-auth] User ID: ${userId}`);
      console.log(`[mfa-auth] Auth method: ${authMethod}`);
      console.log(`[mfa-auth] Total sessions: ${this.sessions.size}`);
    }

    return session;
  }

  async verifySession(sessionId: string, userInput?: string): Promise<AuthResult> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return { success: false, error: "Session not found" };
    }

    if (Date.now() - session.timestamp > this.config.timeout) {
      this.sessions.delete(sessionId);
      return { success: false, error: "Session expired" };
    }

    const provider = this.getProvider(session.authMethod);
    if (!provider) {
      return { success: false, error: "Provider not found" };
    }

    const result = await provider.verify(sessionId, userInput);

    if (result.success) {
      const triggerType = session.originalContext.triggerType || "sensitive_operation";

      if (triggerType === "first_message") {
        this.verifiedForFirstMessage.set(session.userId, Date.now());
        this.persistFirstMessageAuth(session.userId);
      } else {
        this.verifiedForSensitiveOps.set(session.userId, Date.now());
      }

      this.sessions.delete(sessionId);

      if (this.config.debug) {
        console.log(`[mfa-auth] Session verified and deleted: ${sessionId}`);
        console.log(`[mfa-auth] User ${session.userId} marked as verified (${triggerType})`);
      }
    }

    return result;
  }

  isUserVerified(userId: string): boolean {
    return this.isUserVerifiedForSensitiveOps(userId);
  }

  getSession(sessionId: string): AuthSession | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  updateAuthStatus(
    sessionId: string,
    status: "pending" | "scanned" | "verified" | "failed" | "expired",
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.authStatus = status;
      if (this.config.debug) {
        console.log(`[mfa-auth] Session ${sessionId} status updated to: ${status}`);
      }
    }
  }

  getCertToken(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session?.certToken;
  }

  cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.timestamp > this.config.timeout) {
        const provider = this.getProvider(session.authMethod);
        if (provider) {
          provider.cleanup(id);
        }
        this.sessions.delete(id);
        cleanedCount++;
      }
    }

    for (const [userId, verifiedTime] of this.verifiedForSensitiveOps.entries()) {
      if (now - verifiedTime > this.config.verificationDuration) {
        this.verifiedForSensitiveOps.delete(userId);
        cleanedCount++;
      }
    }

    const firstMessageDuration = this.config.firstMessageAuthDuration || 24 * 60 * 60 * 1000;
    for (const [userId, verifiedTime] of this.verifiedForFirstMessage.entries()) {
      if (now - verifiedTime > firstMessageDuration) {
        this.verifiedForFirstMessage.delete(userId);
        this.persistFirstMessageAuth(userId);
        cleanedCount++;
      }
    }

    for (const [userId, pending] of this.pendingExecutions.entries()) {
      if (now - pending.timestamp > 10 * 60 * 1000) {
        this.pendingExecutions.delete(userId);
        cleanedCount++;
      }
    }

    if (this.config.debug && cleanedCount > 0) {
      console.log(`[mfa-auth] Cleanup: removed ${cleanedCount} expired entries`);
    }
  }

  registerPendingExecution(userId: string, sessionId: string): void {
    this.pendingExecutions.set(userId, { sessionId, timestamp: Date.now() });
    if (this.config.debug) {
      console.log(`[mfa-auth] Registered pending execution for user ${userId}: ${sessionId}`);
    }
  }

  getAndClearPendingExecution(userId: string): string | null {
    const pending = this.pendingExecutions.get(userId);
    if (pending) {
      this.pendingExecutions.delete(userId);
      if (this.config.debug) {
        console.log(
          `[mfa-auth] Cleared pending execution for user ${userId}: ${pending.sessionId}`,
        );
      }
      return pending.sessionId;
    }
    return null;
  }

  hasPendingExecution(userId: string): boolean {
    const pending = this.pendingExecutions.get(userId);
    if (!pending) return false;
    const now = Date.now();
    return now - pending.timestamp < 10 * 60 * 1000;
  }

  markUserVerified(
    userId: string,
    triggerType: "first_message" | "sensitive_operation" = "sensitive_operation",
  ): void {
    if (triggerType === "first_message") {
      this.verifiedForFirstMessage.set(userId, Date.now());
      this.persistFirstMessageAuth(userId);
    } else {
      this.verifiedForSensitiveOps.set(userId, Date.now());
    }
    if (this.config.debug) {
      console.log(`[mfa-auth] Marked user ${userId} as verified (${triggerType})`);
    }
  }
}

export const authManager = new AuthManager();

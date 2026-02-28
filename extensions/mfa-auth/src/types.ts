export type AuthMethodType = "qr-code" | "image-captcha" | "sms" | "email";

export type AuthStatus = "pending" | "scanned" | "verified" | "failed" | "expired";

export interface AuthSession {
  sessionId: string;
  userId: string;
  authMethod: AuthMethodType;
  timestamp: number;
  originalContext: PendingAuthContext;
  certToken?: string;
  qrcodeContent?: string;
  expireTimeMs?: number;
  authStatus?: AuthStatus;
}

export type AuthTriggerType = "first_message" | "sensitive_operation";

export interface PendingAuthContext {
  sessionKey: string;
  senderId: string;
  commandBody: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: number;
  toolName: string;
  toolParams: Record<string, unknown>;
  timestamp: number;
  pendingExecutionId?: string;
  triggerType?: AuthTriggerType;
}

export interface MfaConfig {
  timeout: number;
  verificationDuration: number;
  port: number;
  debug: boolean;
  sensitiveKeywords: string[];
  allowlistUsers: string[];
  enabledAuthMethods: AuthMethodType[];
  defaultAuthMethod: AuthMethodType;
  persistAuthStateDir?: string;
  requireAuthOnFirstMessage?: boolean;
  firstMessageAuthDuration?: number;
}

export interface AuthMethodProvider {
  readonly methodType: AuthMethodType;
  readonly name: string;
  readonly description: string;

  initialize(session: AuthSession): Promise<void>;
  verify(sessionId: string, userInput?: string): Promise<AuthResult>;
  cleanup(sessionId: string): void;
  generateAuthPage(session: AuthSession, authUrl: string): Promise<string>;
}

export interface AuthResult {
  success: boolean;
  error?: string;
  status?: AuthStatus;
}

export interface DabbyConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  tokenCacheDuration: number;
  pollInterval: number;
}

export interface DabbyAccessTokenResponse {
  accessToken: string;
  apiVersion: string;
  expireSeconds: number;
  retCode: number;
  retMessage: string;
  timestamp: number;
}

export interface DabbyQrCodeResponse {
  apiVersion: string;
  retCode: number;
  retMessage: string;
  tokenInfo: {
    authType: string;
    certToken: string;
    createdAt: string;
    expireAt: string;
    expireTimeMs: number;
    qrcodeContent: string;
    timestamp: number;
  };
}

export interface DabbyAuthResultResponse {
  apiVersion: string;
  authData: {
    authMode: number;
    authObject: {
      idNum: string;
      fullName: string;
    };
    authType: string;
    portrait: string;
    resCode: number;
    resStr: string;
  };
  authInfo: Record<string, unknown>;
  retCode: number;
  retMessage: string;
}

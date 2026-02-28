import type { AuthMethodProvider, AuthMethodType, AuthResult, AuthSession } from "../types.js";

export abstract class BaseAuthProvider implements AuthMethodProvider {
  abstract readonly methodType: AuthMethodType;
  abstract readonly name: string;
  abstract readonly description: string;

  abstract initialize(session: AuthSession): Promise<void>;
  abstract verify(sessionId: string, userInput?: string): Promise<AuthResult>;
  abstract generateAuthPage(session: AuthSession, authUrl: string): Promise<string>;

  cleanup(sessionId: string): void {}
}

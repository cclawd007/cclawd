# OpenClaw MFA Auth Plugin

A multi-factor authentication plugin for OpenClaw with pluggable authentication providers. Supports QR code authentication with real Dabby third-party authentication system.

## Features

- **Pluggable Auth Providers**: Easy-to-extend architecture for adding new authentication methods
- **QR Code Authentication**: Real scan authentication powered by Dabby API
- **Sensitive Command Protection**: Intercepts sensitive operations requiring verification
- **Multi-Channel Support**: Works with Discord, Telegram, Slack, WhatsApp, Signal, and Feishu
- **Auto-Execute After Auth**: Commands automatically execute after successful verification (no need to re-send)
- **User Verification State**: 2-minute verification window after successful auth
- **Automatic Cleanup**: Periodic cleanup of expired sessions and pending executions
- **Real-time Status Updates**: Frontend polling for authentication status

## Architecture

### Plugin Structure

```
extensions/mfa-auth/
├── index.ts                      # Plugin entry point
├── package.json                  # NPM configuration
├── openclaw.plugin.json         # Plugin metadata
├── README.md                     # Documentation
├── src/
│   ├── types.ts                 # TypeScript type definitions
│   ├── config.ts                # Plugin configuration
│   ├── dabby-client.ts          # Dabby API client
│   ├── dabby-client.test.ts     # Unit tests for Dabby client
│   ├── auth-manager.ts          # Core authentication manager
│   ├── providers/               # Authentication providers
│   │   ├── base.ts              # Base provider interface
│   │   └── qr-code.ts           # QR code auth provider
│   ├── server.ts                # HTTP server for auth pages
│   └── qr.ts                    # QR code generation utilities
```

### Core Components

#### AuthManager

Manages authentication sessions and user verification state:

- Session generation and tracking
- Provider registration and lookup
- User verification state management
- Pending execution tracking (for auto-execute feature)
- Automatic cleanup of expired data (sessions, verified users, pending executions)
- Authentication status updates

#### Dabby Client

Handles communication with Dabby third-party authentication API:

- Access token management with caching (2-hour TTL)
- QR code generation
- Authentication result polling
- Error handling and retry logic

#### QR Code Provider

Implements QR code authentication with:

- Dabby API integration for real QR codes
- Frontend polling mechanism (2-second interval)
- Authentication status display (pending → scanned → verified)
- Success/failure feedback

## Dabby Authentication System

### Dabby API Integration

This plugin integrates with the Dabby third-party authentication system to provide real scan authentication.

**Three main APIs:**

1. **Get Access Token** (`GET /getaccesstoken`)
   - Parameters: `clientId`, `clientSecret`
   - Returns: `accessToken`, `expireSeconds: 7200`
   - Cached for 2 hours

2. **Generate QR Code** (`POST /authreq`)
   - Parameters: `accessToken`, `authType: 'ScanAuth'`, `mode: 66`
   - Returns: `certToken`, `qrcodeContent`, `expireTimeMs`
   - QR code valid for 5 minutes

3. **Query Auth Result** (`POST /authhist`)
   - Parameters: `accessToken`, `authHistQry: { certToken }`
   - Returns: `authData: { resCode, authObject }`
   - `resCode: 0` = authentication success

### Configuration

To use Dabby authentication, configure the following environment variables or update `src/config.ts`:

```typescript
export const dabbyConfig: DabbyConfig = {
  clientId: process.env.DABBY_CLIENT_ID || "",
  clientSecret: process.env.DABBY_CLIENT_SECRET || "",
  apiBaseUrl: "https://api.dabby.com.cn/v2/api",
  tokenCacheDuration: 7000000, // 2 hours - 100s buffer
  pollInterval: 2000, // 2 seconds
};
```

**Environment Variables:**

- `DABBY_CLIENT_ID`: Your Dabby client ID
- `DABBY_CLIENT_SECRET`: Your Dabby client secret

## Authentication Flow

1. User sends sensitive command
2. Plugin intercepts and blocks command
3. Dabby client gets access token (cached if available)
4. Dabby client generates QR code with `certToken`
5. User receives verification link via chat
6. User opens link → QR code page displayed (with Dabby QR content)
7. Frontend polls verification status every 2 seconds
8. User scans QR code with Dabby mobile app
9. Status updates: `pending` → `scanned` → `verified`
10. Success page displayed → notification sent back
11. **Command automatically executes** (no need to re-send)

### Authentication States

- **pending**: Waiting for user to scan QR code
- **scanned**: QR code scanned, waiting for user confirmation
- **verified**: Authentication successful
- **failed**: Authentication failed
- **expired**: QR code expired (5 minutes)

### Auto-Execute Feature

After successful authentication, the plugin automatically re-sends the original command through the same channel. This eliminates the need for users to manually re-send commands.

**How it works:**

1. When a command is intercepted, the plugin stores the command context
2. After successful verification, the plugin sends the original command via `api.runtime.channel.*`
3. The command is processed normally (without interception since user is verified)
4. Verification state is cached for 2 minutes

**Limitations:**

- **Web channel**: Not supported (falls back to manual notification)
- **Channel errors**: If sending the command fails, users receive a fallback notification
- **Pending execution timeout**: Stored commands expire after 10 minutes

## Configuration

Edit `src/config.ts` to customize:

```typescript
{
  timeout: 5 * 60 * 1000,           // Auth session timeout: 5 minutes
  verificationDuration: 2 * 60 * 1000, // Verified user grace period: 2 minutes
  port: 18801,                        // HTTP server port
  debug: true,                        // Debug logging
  sensitiveKeywords: [                 // Sensitive command keywords
    "delete", "remove", "rm", "unlink", "rmdir",
    "format", "wipe", "erase",
    "exec", "eval", "system", "shell", "bash",
    "sudo", "su", "chmod", "chown",
    "restart", "shutdown", "reboot", "gateway"
  ],
  allowlistUsers: [],                 // Users exempt from verification
  enabledAuthMethods: ["qr-code"],     // Enabled auth methods
  defaultAuthMethod: "qr-code",        // Default auth method
}
```

## Adding New Authentication Providers

### Step 1: Create Provider File

Create `src/providers/my-provider.ts`:

```typescript
import { BaseAuthProvider } from "./base.js";
import type { AuthSession, AuthResult } from "../types.js";

export class MyAuthProvider extends BaseAuthProvider {
  readonly methodType = "my-method" as const;
  readonly name = "My Authentication";
  readonly description = "Custom authentication method";

  async initialize(session: AuthSession): Promise<void> {
    // Initialize your auth method (send SMS, generate captcha, etc.)
  }

  async verify(sessionId: string, userInput?: string): Promise<AuthResult> {
    // Verify user input
    return { success: true, status: "verified" };
  }

  generateAuthPage(session: AuthSession, authUrl: string): Promise<string> {
    // Return HTML for your auth page
    return `<html>...</html>`;
  }
}
```

### Step 2: Register Provider

Import and register in `index.ts`:

```typescript
import { MyAuthProvider } from "./src/providers/my-provider.js";

export default function register(api: OpenClawPluginApi) {
  authManager.registerProvider(new MyAuthProvider());
  // ...
}
```

### Step 3: Update Config

Add to `src/config.ts`:

```typescript
enabledAuthMethods: ["qr-code", "my-method"],
defaultAuthMethod: "qr-code",
```

## Future Provider Examples

### Image Captcha Provider

```typescript
class ImageCaptchaAuthProvider extends BaseAuthProvider {
  readonly methodType = "image-captcha" as const;
  // Uses svg-captcha to generate verification codes
}
```

### SMS Provider

```typescript
class SmsAuthProvider extends BaseAuthProvider {
  readonly methodType = "sms" as const;
  // Sends SMS codes via SMS gateway
}
```

### Email Provider

```typescript
class EmailAuthProvider extends BaseAuthProvider {
  readonly methodType = "email" as const;
  // Sends email codes via SMTP
}
```

## API Endpoints

- `GET /health` - Health check
- `GET /mfa-auth/:sessionId` - Display authentication page
- `POST /mfa-auth/verify` - Verify authentication session

**Verify Endpoint Response:**

```json
{
  "success": true,
  "status": "verified",
  "error": "error message (if any)"
}
```

## Installation

1. Navigate to `extensions/mfa-auth`
2. Run `npm install` (or `pnpm install`)
3. Configure Dabby credentials:
   - Set `DABBY_CLIENT_ID` and `DABBY_CLIENT_SECRET` environment variables
   - Or update `src/config.ts` directly
4. Start OpenClaw gateway

## Testing

Test QR code authentication:

1. Send a sensitive command via a supported channel
2. Click the verification link
3. Scan the QR code with Dabby mobile app
4. Wait for status update (pending → scanned → verified)
5. See success message
6. **Command executes automatically** (no need to re-send)

### Unit Tests

Run unit tests for the Dabby client:

```bash
pnpm test src/dabby-client.test.ts
```

## Troubleshooting

- **Port already in use**: Change `port` in `src/config.ts`
- **Sessions not found**: Check debug logs for session IDs
- **Notifications not sending**: Verify channel configuration in OpenClaw config
- **Dabby API errors**:
  - Verify `clientId` and `clientSecret` are correct
  - Check network connectivity to `https://api.dabby.com.cn`
  - Review debug logs for detailed error messages
- **QR code not loading**: Ensure Dabby API is accessible and `accessToken` is valid
- **Authentication timeout**: Increase `timeout` in `src/config.ts` if needed

## License

Same as OpenClaw project.

import type { Credentials } from '../secrets.js';
import { userAgent } from '../version.js';

export type FetchLike = typeof fetch;

/** Halaxy documents tokens as valid for 15 minutes. */
const MAX_TOKEN_SECONDS = 900;
const REFRESH_MARGIN_SECONDS = 60;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface CachedToken {
  token: string;
  refreshAt: number;
}

/**
 * OAuth2 client-credentials token provider. The token is cached in memory only.
 * https://developers.halaxy.com/docs/authentication
 */
export class TokenProvider {
  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly base: string,
    private readonly loadCredentials: () => Promise<Credentials>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.refreshAt) return this.cached.token;
    if (!this.inflight) {
      this.inflight = this.fetchToken().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<string> {
    const { clientId, clientSecret } = await this.loadCredentials();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/fhir+json',
          'User-Agent': userAgent(),
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
    } catch {
      throw new AuthError('Could not reach Halaxy to obtain an access token (network error).');
    }
    if (!res.ok) {
      throw new AuthError(
        res.status === 401 || res.status === 400
          ? 'Halaxy rejected the API credentials. Re-run "halaxy-mcp setup" with a valid key.'
          : `Halaxy token request failed with HTTP ${res.status}.`,
        res.status,
      );
    }
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new AuthError('Halaxy token response was not JSON.');
    }
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new AuthError('Halaxy token response did not include an access_token.');
    }
    const expiresIn =
      typeof body.expires_in === 'number' && body.expires_in > 0
        ? Math.min(body.expires_in, MAX_TOKEN_SECONDS)
        : MAX_TOKEN_SECONDS;
    const lifetime = Math.max(expiresIn - REFRESH_MARGIN_SECONDS, 0);
    this.cached = { token: body.access_token, refreshAt: this.now() + lifetime * 1000 };
    return body.access_token;
  }
}

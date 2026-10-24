/**
 * Client credentials live only in the OS keychain (macOS Keychain, Windows Credential
 * Manager, libsecret). They are never read from env vars, CLI args or files.
 */

export const KEYCHAIN_SERVICE = 'halaxy-mcp';
export const ACCOUNT_CLIENT_ID = 'client_id';
export const ACCOUNT_CLIENT_SECRET = 'client_secret';

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export class KeychainStore implements SecretStore {
  private async entry(account: string) {
    // Lazy import so tests and `version` don't need the native module loaded.
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry(KEYCHAIN_SERVICE, account);
  }

  async get(account: string): Promise<string | undefined> {
    const value = (await this.entry(account)).getPassword();
    return value ?? undefined;
  }

  async set(account: string, value: string): Promise<void> {
    (await this.entry(account)).setPassword(value);
  }

  async delete(account: string): Promise<boolean> {
    try {
      return (await this.entry(account)).deletePassword();
    } catch {
      return false;
    }
  }
}

export class MissingCredentialsError extends Error {
  constructor() {
    super('Halaxy credentials are not in the keychain. A human needs to run "halaxy-mcp setup".');
    this.name = 'MissingCredentialsError';
  }
}

export async function readCredentials(store: SecretStore): Promise<Credentials> {
  const [clientId, clientSecret] = await Promise.all([
    store.get(ACCOUNT_CLIENT_ID),
    store.get(ACCOUNT_CLIENT_SECRET),
  ]);
  if (!clientId || !clientSecret) throw new MissingCredentialsError();
  return { clientId, clientSecret };
}

export async function writeCredentials(store: SecretStore, creds: Credentials): Promise<void> {
  await store.set(ACCOUNT_CLIENT_ID, creds.clientId);
  await store.set(ACCOUNT_CLIENT_SECRET, creds.clientSecret);
}

export async function deleteCredentials(store: SecretStore): Promise<void> {
  await store.delete(ACCOUNT_CLIENT_ID);
  await store.delete(ACCOUNT_CLIENT_SECRET);
}

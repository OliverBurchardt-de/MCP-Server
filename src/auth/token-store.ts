import fs from 'node:fs';
import path from 'node:path';

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix-Millisekunden, zu denen der Access-Token abläuft. */
  expiresAt: number;
  scope?: string;
  idToken?: string;
}

export class FileTokenStore {
  constructor(private readonly filePath: string) {}

  load(): StoredTokens | undefined {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredTokens;
      if (typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'number') {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  save(tokens: StoredTokens): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // Datei existiert nicht — nichts zu tun.
    }
  }
}

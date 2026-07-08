import crypto from 'node:crypto';
import type { DatevConfig } from '../config.js';
import type { StoredTokens } from './token-store.js';

export type FetchLike = typeof globalThis.fetch;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export const createPkcePair = (): PkcePair => {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

export const createState = (): string => crypto.randomBytes(16).toString('base64url');

export const buildAuthorizeUrl = (config: DatevConfig, state: string, challenge: string): string => {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
};

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

const toStoredTokens = (response: TokenResponse): StoredTokens => ({
  accessToken: response.access_token,
  refreshToken: response.refresh_token,
  expiresAt: Date.now() + (response.expires_in ?? 300) * 1000,
  scope: response.scope,
  idToken: response.id_token
});

const requestTokens = async (
  config: DatevConfig,
  body: URLSearchParams,
  fetchImpl: FetchLike
): Promise<StoredTokens> => {
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
      Accept: 'application/json'
    },
    body: body.toString()
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `DATEV-Token-Endpunkt antwortete mit HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  }

  return toStoredTokens(JSON.parse(text) as TokenResponse);
};

export const exchangeAuthorizationCode = (
  config: DatevConfig,
  code: string,
  verifier: string,
  fetchImpl: FetchLike = fetch
): Promise<StoredTokens> =>
  requestTokens(
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier
    }),
    fetchImpl
  );

export const refreshAccessToken = (
  config: DatevConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch
): Promise<StoredTokens> =>
  requestTokens(
    config,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }),
    fetchImpl
  );

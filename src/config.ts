import os from 'node:os';
import path from 'node:path';

export type DatevEnvironment = 'sandbox' | 'production';

export interface DatevConfig {
  environment: DatevEnvironment;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectPort: number;
  redirectUri: string;
  scopes: string[];
  accountingClientsBaseUrl: string;
  accountingDataExchangeBaseUrl: string;
  tokenStorePath: string;
}

const ENDPOINTS: Record<DatevEnvironment, { authorize: string; token: string; basePath: string }> = {
  sandbox: {
    authorize: 'https://login.datev.de/openidsandbox/authorize',
    token: 'https://sandbox-api.datev.de/token',
    basePath: 'platform-sandbox'
  },
  production: {
    authorize: 'https://login.datev.de/openid/authorize',
    token: 'https://api.datev.de/token',
    basePath: 'platform'
  }
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): DatevConfig => {
  const environment: DatevEnvironment = env.DATEV_ENV === 'production' ? 'production' : 'sandbox';
  const endpoints = ENDPOINTS[environment];
  const redirectPort = Number.parseInt(env.DATEV_REDIRECT_PORT ?? '53682', 10);

  return {
    environment,
    clientId: env.DATEV_CLIENT_ID ?? '',
    clientSecret: env.DATEV_CLIENT_SECRET ?? '',
    authorizeUrl: endpoints.authorize,
    tokenUrl: endpoints.token,
    redirectPort,
    redirectUri: env.DATEV_REDIRECT_URI ?? `http://localhost:${redirectPort}/callback`,
    scopes: (env.DATEV_SCOPES ?? 'openid profile offline_access datev:accounting:clients datev:accounting:exchange').split(
      /\s+/
    ),
    accountingClientsBaseUrl: `https://accounting-clients.api.datev.de/${endpoints.basePath}/v2`,
    accountingDataExchangeBaseUrl: `https://accounting-data-exchange.api.datev.de/${endpoints.basePath}/v1`,
    tokenStorePath:
      env.DATEV_TOKEN_STORE ?? path.join(os.homedir(), '.datev-mcp', `tokens-${environment}.json`)
  };
};

export const config = loadConfig();

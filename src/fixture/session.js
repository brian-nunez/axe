const SAAS_SERVER_URL = 'https://axe.deque.com';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function serverUrlFromEnv() {
  return requireEnv('AXE_SERVER_URL').replace(/\/+$/, '');
}

export function credentialsFromEnv() {
  return {
    username: requireEnv('AXE_USER_EMAIL_ADDRESS'),
    password: requireEnv('AXE_USER_PASSWORD'),
  };
}

/**
 * Build the `sso-config` record the extension keeps in chrome.storage.local.
 *
 * The shape mirrors the extension's own `get-sso-config` handler. The refresh
 * routine reads `tokenUrl` and `publicClientId` from it, so a session seeded
 * without this record cannot renew itself.
 */
export async function discoverSso(serverUrl) {
  const response = await fetch(`${serverUrl}/api/sso-config`);
  if (!response.ok) {
    throw new Error(`GET /api/sso-config failed with ${response.status}`);
  }
  const { url, realm, publicClientId } = await response.json();
  const openIdConnectUrl = `${url}/auth/realms/${realm}/protocol/openid-connect`;

  const redirectUrl = new URL(serverUrl);
  redirectUrl.searchParams.set('fromextension', 'true');

  const loginUrl = new URL(`${openIdConnectUrl}/auth`);
  loginUrl.searchParams.set('redirect_uri', redirectUrl.href);
  loginUrl.searchParams.set('client_id', publicClientId);
  loginUrl.searchParams.set('response_type', 'code');
  loginUrl.searchParams.set('response_mode', 'query');
  loginUrl.searchParams.set('scope', 'openid');

  return {
    authUrl: url,
    realm,
    publicClientId,
    redirectUrl: redirectUrl.href,
    loginUrl: loginUrl.href,
    logoutUrl: `${openIdConnectUrl}/logout`,
    tokenUrl: `${openIdConnectUrl}/token`,
  };
}

function withExpiry(token) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ...token,
    expires_at: now + token.expires_in,
    refresh_expires_at: now + token.refresh_expires_in,
  };
}

async function postToken(tokenUrl, params) {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`token endpoint returned ${response.status}: ${body.error ?? 'unknown error'}`);
  }
  return withExpiry(body);
}

/**
 * Mint a session with a direct grant.
 *
 * The extension's own login is an authorization-code redirect through a
 * Keycloak HTML form. Driving that form in a container is the brittle part of
 * fixture setup and buys nothing: the same public client accepts a direct
 * grant, and the extension cannot tell the difference once the tokens land in
 * storage.
 */
export function mintSession(ssoConfig, { username, password }) {
  return postToken(ssoConfig.tokenUrl, {
    grant_type: 'password',
    client_id: ssoConfig.publicClientId,
    username,
    password,
    scope: 'openid',
  });
}

export function refreshSession(ssoConfig, session) {
  return postToken(ssoConfig.tokenUrl, {
    grant_type: 'refresh_token',
    client_id: ssoConfig.publicClientId,
    refresh_token: session.refresh_token,
  });
}

/** The record the extension stores under `user`, from the same endpoint it uses. */
export async function fetchUser(serverUrl, accessToken) {
  const response = await fetch(`${serverUrl}/api/logged-in`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`GET /api/logged-in failed with ${response.status}`);
  }
  return response.json();
}

/** The extension treats the literal "default" as the hosted server. */
export function storedServerUrl(serverUrl) {
  return serverUrl === SAAS_SERVER_URL ? 'default' : serverUrl;
}

import { chromium } from 'playwright';
import {
  discoverSso,
  fetchUser,
  mintSession,
  storedServerUrl,
} from './session.js';

const EXTENSION_ID = 'lhdoppojpmngadmnindnejefpokejbdd';
const SERVICE_WORKER_TIMEOUT_MS = 30_000;

async function extensionWorker(context) {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  return context.waitForEvent('serviceworker', { timeout: SERVICE_WORKER_TIMEOUT_MS });
}

/**
 * Launch a browser with the axe extension loaded and already signed in.
 *
 * Runs at fixture setup, before any agent exists, so that the agent never
 * handles credentials and never touches a login form.
 */
export async function launchSignedIn({
  extensionPath,
  userDataDir,
  serverUrl,
  credentials,
  headless = true,
  openDevtools = false,
}) {
  const ssoConfig = await discoverSso(serverUrl);
  const session = await mintSession(ssoConfig, credentials);
  const user = await fetchUser(serverUrl, session.access_token);

  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ];
  if (openDevtools) args.push('--auto-open-devtools-for-tabs');

  // The bundled headless shell cannot load extensions; the "chromium" channel
  // runs the full browser in headless mode, which can.
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args,
  });

  const worker = await extensionWorker(context);
  const loadedId = new URL(worker.url()).host;
  if (loadedId !== EXTENSION_ID) {
    await context.close();
    throw new Error(
      `extension loaded as ${loadedId}, expected ${EXTENSION_ID}; ` +
        'the bundle has lost its manifest key and managed policy will not apply',
    );
  }

  await worker.evaluate(async (record) => {
    await chrome.storage.local.set(record);
  }, {
    session,
    'sso-config': ssoConfig,
    user,
    axeServerURL: storedServerUrl(serverUrl),
    hasSeenFirstTimeContent: true,
  });

  return { context, worker, extensionId: loadedId, ssoConfig, session, user };
}

export async function readStoredSession(worker) {
  return worker.evaluate(async () => {
    const { session, 'sso-config': ssoConfig, user } =
      await chrome.storage.local.get(['session', 'sso-config', 'user']);
    return {
      hasSession: Boolean(session),
      hasRefreshToken: Boolean(session?.refresh_token),
      expiresAt: session?.expires_at ?? null,
      refreshExpiresAt: session?.refresh_expires_at ?? null,
      tokenUrl: ssoConfig?.tokenUrl ?? null,
      publicClientId: ssoConfig?.publicClientId ?? null,
      userId: user?.id ?? null,
    };
  });
}

export { EXTENSION_ID };

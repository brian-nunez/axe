import { refreshSession } from './session.js';

/** Renew at half the access token's life, so one failed attempt is not fatal. */
const RENEWAL_FRACTION = 0.5;
const MIN_INTERVAL_MS = 5_000;

/**
 * Keep the extension's session valid for the life of a run.
 *
 * The extension renews its own token only when the DevTools panel mounts. It
 * does not renew on expiry, and re-mounting the panel to force one would
 * destroy the saved test — the only record of findings until submission. So the
 * harness renews out of band: refresh grant, write the result into
 * chrome.storage.local, and announce it on the same BroadcastChannel the
 * extension uses, so a mounted panel picks up the new token.
 */
export function startSessionKeepAlive({ worker, ssoConfig, session, intervalMs, onError }) {
  const period = Math.max(
    MIN_INTERVAL_MS,
    intervalMs ?? session.expires_in * 1000 * RENEWAL_FRACTION,
  );

  let current = session;
  let stopped = false;

  const write = (next) =>
    worker.evaluate(async (record) => {
      await chrome.storage.local.set({ session: record });
      new BroadcastChannel('auth').postMessage({ topic: 'auth:session', message: record });
    }, next);

  const tick = async () => {
    if (stopped) return;
    try {
      current = await refreshSession(ssoConfig, current);
      await write(current);
    } catch (error) {
      if (onError) onError(error);
      else throw error;
    }
  };

  const timer = setInterval(tick, period);
  timer.unref?.();

  return {
    get session() {
      return current;
    },
    renewNow: tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

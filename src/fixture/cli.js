import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsFromEnv, refreshSession, serverUrlFromEnv } from './session.js';
import { launchSignedIn, readStoredSession } from './launch.js';
import { startSessionKeepAlive } from './keepalive.js';


const fingerprint = (token) => createHash('sha256').update(token).digest('hex').slice(0, 12);
const minutes = (seconds) => `${Math.round(seconds / 60)} min`;

function parseArgs(argv) {
  const args = { keepOpen: false, proveKeepAlive: false, headless: true };
  for (const arg of argv) {
    if (arg.startsWith('--extension=')) args.extensionPath = arg.slice(12);
    else if (arg.startsWith('--profile=')) args.userDataDir = arg.slice(10);
    else if (arg === '--keep-open') args.keepOpen = true;
    else if (arg === '--headed') args.headless = false;
    else if (arg === '--prove-keepalive') args.proveKeepAlive = true;
    else throw new Error(`unrecognised argument: ${arg}`);
  }
  if (!args.extensionPath) throw new Error('--extension=<unpacked directory> is required');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverUrl = serverUrlFromEnv();
  const credentials = credentialsFromEnv();

  const userDataDir = args.userDataDir ?? (await mkdtemp(join(tmpdir(), 'axe-fixture-')));
  const ephemeral = !args.userDataDir;

  console.log(`server     ${new URL(serverUrl).host}`);
  console.log(`extension  ${args.extensionPath}`);

  const { context, worker, extensionId, ssoConfig, session } = await launchSignedIn({
    extensionPath: args.extensionPath,
    userDataDir,
    serverUrl,
    credentials,
    headless: args.headless,
  });

  console.log(`loaded as  ${extensionId}`);
  console.log(`realm      ${ssoConfig.realm} / ${ssoConfig.publicClientId}`);
  console.log(`access     ${minutes(session.expires_in)} (${fingerprint(session.access_token)})`);
  console.log(`refresh    ${minutes(session.refresh_expires_in)}`);

  const stored = await readStoredSession(worker);
  console.log('\nstored in chrome.storage.local:');
  console.log(`  session          ${stored.hasSession}`);
  console.log(`  refresh_token    ${stored.hasRefreshToken}`);
  console.log(`  sso-config       ${Boolean(stored.tokenUrl)}`);
  console.log(`  user             ${stored.userId ? 'present' : 'missing'}`);

  const renewed = await refreshSession(ssoConfig, session);
  console.log(`\nrefresh grant    accepted, new access token ${fingerprint(renewed.access_token)}`);

  if (args.proveKeepAlive) {
    console.log('\nkeep-alive check (10s period, three renewals):');
    const readToken = () => worker.evaluate(async () =>
      (await chrome.storage.local.get('session')).session?.access_token ?? null);
    const seen = new Set([fingerprint(await readToken())]);
    const keepAlive = startSessionKeepAlive({
      worker, ssoConfig, session, intervalMs: 10_000,
      onError: (error) => console.log(`  renewal failed: ${error.message}`),
    });
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      const token = await readToken();
      const mark = fingerprint(token);
      seen.add(mark);
      const expiresAt = (await readStoredSession(worker)).expiresAt;
      const remaining = expiresAt - Math.floor(Date.now() / 1000);
      console.log(`  renewal ${i + 1}  ${mark}  valid for ${minutes(remaining)}`);
    }
    keepAlive.stop();
    console.log(seen.size >= 4
      ? '  PASS  the harness sustains the session without touching the panel'
      : `  FAIL  only ${seen.size - 1} renewals landed in storage`);
    if (seen.size < 4) process.exitCode = 1;
  }

  if (!args.keepOpen) {
    await context.close();
    if (ephemeral) await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

/**
 * Live check of the HostPanel connection. Creates one real test website on your panel,
 * suspends it, unsuspends it, removes it and cleans up. Run it from a machine whose address
 * is allowed by the API key.
 *
 *   HOSTPANEL_URL=https://panel.example.com \
 *   HOSTPANEL_KEY=hpk_xxxxxxxx_... \
 *   SMOKE_DOMAIN=hbtest.example.com \
 *   pnpm panel:smoke
 *
 * Optional: SMOKE_EMAIL (default hbtest@<SMOKE_DOMAIN>), HOSTPANEL_ALLOW_PRIVATE_HOSTS=true.
 */
import { randomUUID } from 'node:crypto';
import { HostPanelClient, HostPanelError } from '../src/hostpanel-client.js';
import { panelUsername } from '../src/panel-sync.js';

const url = process.env.HOSTPANEL_URL;
const apiKey = process.env.HOSTPANEL_KEY;
const domain = process.env.SMOKE_DOMAIN?.trim().toLowerCase();

if (!url || !apiKey || !domain) {
  console.error(
    'Set HOSTPANEL_URL, HOSTPANEL_KEY and SMOKE_DOMAIN. See the comment at the top of this file.',
  );
  process.exit(2);
}

const client = new HostPanelClient(
  { baseUrl: url, apiKey },
  { allowPrivateHosts: process.env.HOSTPANEL_ALLOW_PRIVATE_HOSTS === 'true', timeoutMs: 60_000 },
);

const customerId = randomUUID();
const username = panelUsername(customerId);
const email = process.env.SMOKE_EMAIL ?? `hbtest@${domain}`;
const externalId = `hb-smoke-${randomUUID()}`;
let created = false;
let failed = false;

async function step(name: string, run: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await run();
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
    return true;
  } catch (error) {
    failed = true;
    const reason =
      error instanceof HostPanelError ? `${error.code}: ${error.message}` : String(error);
    console.log(`FAIL  ${name}\n      ${reason}`);
    return false;
  }
}

async function waitForTask(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!(await client.currentTask()).running) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error('The panel is still busy after 5 minutes');
}

const input = {
  domain,
  username,
  email,
  externalId,
  type: 'php',
  plan: 'Smoke test',
  limits: { diskMb: 500, bandwidthMb: 5_000 },
};

console.log(`Panel ${url}\nTest website ${domain} (login ${username})\n`);

if (await step('Reach the panel and accept the key', () => client.ping())) {
  await step('Read server details', async () => {
    const info = await client.serverInfo();
    return `HostPanel ${String(info.version ?? '?')}, PHP ${JSON.stringify(info.php ?? info.phpVersions ?? '?')}`;
  });

  created = await step('Create the website', async () => {
    const result = await client.provision(input);
    if (!result.created) throw new Error('Expected a new website but the panel reported a replay');
    const credentials = result.credentials as {
      panel?: { url?: string; username?: string };
    } | null;
    return `first login would be shown once: ${credentials?.panel?.username ?? 'none'}`;
  });

  if (created) {
    await step('Repeat the create call safely (no second site, no new password)', async () => {
      const result = await client.provision(input);
      if (result.created || result.credentials !== null) {
        throw new Error('A repeated call must not create anything or return credentials again');
      }
    });
    await step('Look the website up', async () => {
      const service = await client.service(domain);
      return JSON.stringify(service).slice(0, 80);
    });
    await step('Suspend', () => client.suspend(domain));
    await step('Unsuspend', () => client.unsuspend(domain));

    const removed = await step('Remove the website (final backup runs first)', async () => {
      await client.terminate(domain);
      await waitForTask();
    });

    if (removed) {
      await step('Confirm the website is gone', async () => {
        try {
          await client.service(domain);
        } catch (error) {
          if (error instanceof HostPanelError && error.status === 404) return;
          throw error;
        }
        throw new Error('The website still exists on the panel');
      });
      await step('Remove the test login', () => client.deleteClient(username));
    } else {
      console.log(`\nClean up by hand: remove ${domain} and the login ${username} in the panel.`);
    }
  }
}

console.log(failed ? '\nSome checks failed. Send me this output.' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);

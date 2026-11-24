import type { PrismaClient } from '@hostbilling/database';
import { HostPanelClient, HostPanelError, type ClientOptions } from './hostpanel-client.js';
import { decryptSecret } from './secrets.js';

export interface PanelDeps {
  secretsKey: Buffer | null;
  clientOptions: ClientOptions;
}

type PanelStateValue = 'NOT_SYNCED' | 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';

export type PanelOutcome =
  | { kind: 'not-configured' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'synced'; panelState: PanelStateValue; credentials: unknown }
  | { kind: 'failed'; error: string; panelState: PanelStateValue };

// A stable login name per customer, so one customer's sites share one panel login.
export const panelUsername = (customerId: string): string =>
  `c${customerId.replace(/-/g, '').slice(0, 12)}`;

// HostPanel plan labels allow a narrow character set and must start with a letter or digit.
export function panelPlanLabel(name: string): string | undefined {
  const label = name
    .replace(/[^A-Za-z0-9 ._:/-]/g, '')
    .replace(/^[^A-Za-z0-9]+/, '')
    .trim()
    .slice(0, 64);
  return label || undefined;
}

/**
 * Makes HostPanel match the subscription: active means a running site, suspended means a
 * suspended site, cancelled means a terminated site. Every step is safe to repeat, so staff
 * can retry after a failure. Panel calls happen outside any database transaction, and each
 * completed step is saved immediately so a later failure does not lose it.
 */
export async function syncSubscriptionToPanel(
  db: PrismaClient,
  deps: PanelDeps,
  tenantId: string,
  subscriptionId: string,
): Promise<PanelOutcome> {
  const connection = await db.hostPanelConnection.findFirst({ where: { tenantId } });

  if (!connection) {
    return { kind: 'not-configured' };
  }

  const subscription = await db.subscription.findFirst({
    where: { id: subscriptionId, tenantId },
    include: { customer: true, plan: true },
  });

  if (!subscription) {
    return { kind: 'skipped', reason: 'Subscription not found' };
  }

  let state: PanelStateValue = subscription.panelState;

  const record = async (error: string | null): Promise<void> => {
    await db.subscription.updateMany({
      where: { id: subscriptionId, tenantId },
      data: {
        panelState: state,
        panelSyncedAt: new Date(),
        panelError: error ? error.slice(0, 500) : null,
      },
    });
  };

  const fail = async (error: string): Promise<PanelOutcome> => {
    await record(error);
    return { kind: 'failed', error, panelState: state };
  };

  if (subscription.status === 'PENDING') {
    return { kind: 'skipped', reason: 'Nothing is created until the subscription is activated' };
  }

  if (subscription.status === 'CANCELLED' && (state === 'NOT_SYNCED' || state === 'TERMINATED')) {
    return { kind: 'skipped', reason: 'There is no website to remove' };
  }

  if (!deps.secretsKey) {
    return fail('SECRETS_KEY is not configured on this server');
  }

  let apiKey: string;

  try {
    apiKey = decryptSecret(connection.apiKeyCiphertext, deps.secretsKey);
  } catch {
    return fail('The saved panel key could not be decrypted. Save the connection again.');
  }

  const client = new HostPanelClient({ baseUrl: connection.baseUrl, apiKey }, deps.clientOptions);
  let credentials: unknown = null;

  try {
    if (subscription.status === 'CANCELLED') {
      try {
        if (subscription.domain) {
          await client.terminate(subscription.domain);
        }
      } catch (error) {
        // Already gone on the panel side counts as done.
        if (!(error instanceof HostPanelError && error.status === 404)) {
          throw error;
        }
      }
      state = 'TERMINATED';
      await record(null);
      return { kind: 'synced', panelState: state, credentials };
    }

    const domain = subscription.domain;

    if (!domain) {
      return fail('This subscription has no domain, so no website can be created');
    }

    if (state === 'NOT_SYNCED' || state === 'TERMINATED') {
      const email = subscription.customer.email;

      if (!email) {
        return fail('The customer has no email address, which the panel login needs');
      }

      const plan = panelPlanLabel(subscription.plan.name);
      const result = await client.provision({
        domain,
        username: panelUsername(subscription.customerId),
        email,
        externalId: subscription.id,
        type: connection.defaultType,
        ...(connection.defaultPhp ? { php: connection.defaultPhp } : {}),
        ...(plan ? { plan } : {}),
        limits: {
          diskMb: subscription.plan.diskQuotaMb,
          bandwidthMb: subscription.plan.bandwidthQuotaMb,
        },
      });
      credentials = result.created ? result.credentials : null;
      state = 'ACTIVE';
      await record(null);
    }

    if (subscription.status === 'ACTIVE' && state === 'SUSPENDED') {
      await client.unsuspend(domain);
      state = 'ACTIVE';
      await record(null);
    }

    if (subscription.status === 'SUSPENDED' && state === 'ACTIVE') {
      await client.suspend(domain);
      state = 'SUSPENDED';
      await record(null);
    }

    return { kind: 'synced', panelState: state, credentials };
  } catch (error) {
    if (error instanceof HostPanelError) {
      return fail(error.message);
    }
    throw error;
  }
}

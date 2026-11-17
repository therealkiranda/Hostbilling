import { useEffect, useState } from 'react';
import { ApiError, fetchPlans, type Plan, type ProviderPlans } from './api';
import { OrderDialog } from './components/OrderDialog';
import { Plans } from './components/Plans';
import { resolveProviderSlug } from './provider';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: ProviderPlans }
  | { kind: 'not-found' }
  | { kind: 'error' };

const providerSlug = resolveProviderSlug(
  window.location.pathname,
  import.meta.env.VITE_TENANT_SLUG,
);

const STEPS = [
  {
    title: 'Place your order',
    body: 'Choose a plan and enter your domain name. No payment is taken.',
  },
  {
    title: 'We review it',
    body: 'The provider checks your order and gets in touch to confirm the details.',
  },
  {
    title: 'Your hosting starts',
    body: 'Hosting is set up and your first invoice is issued.',
  },
];

function Notice({
  title,
  children,
  action,
}: {
  title: string;
  children: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="notice" role="status">
      <h2 className="notice__title">{title}</h2>
      <p className="notice__body">{children}</p>
      {action ? (
        <button type="button" className="button button--quiet" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function PlansSkeleton() {
  return (
    <div className="skeleton" aria-hidden="true">
      {[0, 1, 2].map((item) => (
        <div key={item} className="skeleton__plan">
          <span className="skeleton__bar skeleton__bar--title" />
          <span className="skeleton__bar skeleton__bar--price" />
          <span className="skeleton__bar" />
          <span className="skeleton__bar" />
          <span className="skeleton__bar" />
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [state, setState] = useState<LoadState>(
    providerSlug ? { kind: 'loading' } : { kind: 'not-found' },
  );
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<Plan | null>(null);

  useEffect(() => {
    if (!providerSlug) {
      return;
    }

    const controller = new AbortController();
    setState({ kind: 'loading' });

    fetchPlans(providerSlug, controller.signal)
      .then((data) => setState({ kind: 'ready', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setState(
          error instanceof ApiError && error.status === 404
            ? { kind: 'not-found' }
            : { kind: 'error' },
        );
      });

    return () => controller.abort();
  }, [attempt]);

  const providerName = state.kind === 'ready' ? state.data.tenant.name : null;

  useEffect(() => {
    document.title = providerName ? `${providerName} hosting plans` : 'Hosting plans';
  }, [providerName]);

  let plans;

  if (state.kind === 'loading') {
    plans = <PlansSkeleton />;
  } else if (state.kind === 'not-found') {
    plans = (
      <Notice title="We could not find this hosting provider">
        Check the address you were given, or ask the provider for their ordering link.
      </Notice>
    );
  } else if (state.kind === 'error') {
    plans = (
      <Notice
        title="We could not load the plans"
        action={{ label: 'Try again', onClick: () => setAttempt((count) => count + 1) }}
      >
        Check your connection and try again.
      </Notice>
    );
  } else if (state.data.plans.length === 0) {
    plans = (
      <Notice title="No plans are available right now">
        {`Check back soon, or contact ${state.data.tenant.name} to ask about hosting.`}
      </Notice>
    );
  } else {
    plans = <Plans plans={state.data.plans} onOrder={setSelected} />;
  }

  return (
    <>
      <a className="skip-link" href="#plans">
        Skip to plans
      </a>

      <header className="masthead">
        <div className="wrap masthead__bar">
          {providerName ? (
            <p className="wordmark">{providerName}</p>
          ) : (
            <span className="wordmark wordmark--pending" aria-hidden="true" />
          )}
          <nav aria-label="Page sections" className="masthead__nav">
            <a href="#plans">Plans</a>
            <a href="#after-you-order">After you order</a>
          </nav>
        </div>
      </header>

      <main>
        <section className="wrap hero" aria-labelledby="hero-title">
          <h1 className="hero__title" id="hero-title">
            Choose the hosting that fits your website.
          </h1>
          <div className="hero__aside">
            <p className="hero__copy">
              Compare what each plan includes, then order in a minute. No payment is taken when you
              order.
              {providerName
                ? ` ${providerName} reviews your order and gets in touch to start your hosting.`
                : ''}
            </p>
          </div>
        </section>

        <section className="wrap plans" id="plans" aria-labelledby="plans-title">
          <h2 className="visually-hidden" id="plans-title">
            Hosting plans
          </h2>
          {plans}
        </section>

        <section className="wrap steps" id="after-you-order" aria-labelledby="steps-title">
          <h2 className="steps__title" id="steps-title">
            After you order
          </h2>
          <ol className="steps__list">
            {STEPS.map((step) => (
              <li key={step.title} className="step">
                <h3 className="step__title">{step.title}</h3>
                <p className="step__body">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="wrap footer">
        <p>{providerName ?? 'Hosting'}</p>
        <p>Plans and prices are set by the provider.</p>
      </footer>

      <OrderDialog
        plan={selected}
        providerName={providerName ?? 'The provider'}
        providerSlug={providerSlug ?? ''}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

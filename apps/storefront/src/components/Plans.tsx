import type { ReactNode } from 'react';
import type { Plan } from '../api';
import {
  formatCount,
  formatPrice,
  formatPriceParts,
  formatStorage,
  intervalLabel,
  meterRatio,
} from '../format';
import { useMediaQuery } from '../useMediaQuery';
import { Meter } from './Meter';

interface Resource {
  key:
    | 'diskQuotaMb'
    | 'bandwidthQuotaMb'
    | 'maxDomains'
    | 'maxEmailAccounts'
    | 'maxDatabases'
    | 'maxFtpAccounts';
  label: string;
  format: (value: number) => string;
}

const RESOURCES: Resource[] = [
  { key: 'diskQuotaMb', label: 'Disk space', format: formatStorage },
  { key: 'bandwidthQuotaMb', label: 'Data transfer', format: formatStorage },
  { key: 'maxDomains', label: 'Domains', format: (value) => formatCount(value) },
  { key: 'maxEmailAccounts', label: 'Email accounts', format: (value) => formatCount(value) },
  { key: 'maxDatabases', label: 'Databases', format: (value) => formatCount(value) },
  { key: 'maxFtpAccounts', label: 'FTP accounts', format: (value) => formatCount(value) },
];

// The side-by-side sheet needs room for a label column plus each plan.
const SHEET_MAX_PLANS = 4;

function Price({ plan }: { plan: Plan }) {
  const { symbol, amount } = formatPriceParts(plan.priceMinorUnits, plan.currency);

  return (
    <>
      <p className="price">
        <span className="price__symbol">{symbol}</span>
        <span className="price__amount">{amount}</span>
        <span className="price__interval">
          {intervalLabel(plan.billingInterval, plan.intervalCount)}
        </span>
      </p>
      <p className="price__setup">
        {plan.setupFeeMinorUnits > 0
          ? `${formatPrice(plan.setupFeeMinorUnits, plan.currency)} one-time setup fee`
          : 'No setup fee'}
      </p>
    </>
  );
}

function PlanIntro({ plan, headingLevel }: { plan: Plan; headingLevel: 'h3' | 'h2' }) {
  const Heading = headingLevel;

  return (
    <>
      <Heading className="plan__name">{plan.name}</Heading>
      {plan.description ? <p className="plan__description">{plan.description}</p> : null}
      <Price plan={plan} />
    </>
  );
}

function OrderButton({ plan, onOrder }: { plan: Plan; onOrder: (plan: Plan) => void }) {
  return (
    <button type="button" className="button" onClick={() => onOrder(plan)}>
      Order {plan.name}
    </button>
  );
}

function maxima(plans: Plan[]): Record<Resource['key'], number> {
  return Object.fromEntries(
    RESOURCES.map((resource) => [
      resource.key,
      Math.max(...plans.map((plan) => plan[resource.key])),
    ]),
  ) as Record<Resource['key'], number>;
}

function Value({
  resource,
  plan,
  max,
  column,
}: {
  resource: Resource;
  plan: Plan;
  max: number;
  column: number;
}) {
  const value = plan[resource.key];

  return (
    <>
      <span className={value === 0 ? 'spec__value spec__value--none' : 'spec__value'}>
        {resource.format(value)}
      </span>
      <Meter ratio={meterRatio(value, max)} column={column} />
    </>
  );
}

function Sheet({ plans, onOrder }: { plans: Plan[]; onOrder: (plan: Plan) => void }) {
  const max = maxima(plans);

  return (
    <div className="sheet">
      <table className="sheet__table">
        <caption className="visually-hidden">Hosting plans and what each one includes</caption>
        <thead>
          <tr>
            <td className="sheet__corner" />
            {plans.map((plan) => (
              <th key={plan.id} scope="col" className="sheet__head">
                <PlanIntro plan={plan} headingLevel="h3" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {RESOURCES.map((resource) => (
            <tr key={resource.key}>
              <th scope="row" className="sheet__label">
                {resource.label}
              </th>
              {plans.map((plan, column) => (
                <td key={plan.id} className="sheet__cell">
                  <Value resource={resource} plan={plan} max={max[resource.key]} column={column} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="sheet__corner" />
            {plans.map((plan) => (
              <td key={plan.id} className="sheet__action">
                <OrderButton plan={plan} onOrder={onOrder} />
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Stack({ plans, onOrder }: { plans: Plan[]; onOrder: (plan: Plan) => void }) {
  const max = maxima(plans);

  return (
    <ul className="stack">
      {plans.map((plan, column) => (
        <li key={plan.id} className="plan">
          <PlanIntro plan={plan} headingLevel="h3" />
          <dl className="plan__specs">
            {RESOURCES.map((resource) => (
              <div key={resource.key} className="spec">
                <dt className="spec__label">{resource.label}</dt>
                <dd className="spec__body">
                  <Value resource={resource} plan={plan} max={max[resource.key]} column={column} />
                </dd>
              </div>
            ))}
          </dl>
          <OrderButton plan={plan} onOrder={onOrder} />
        </li>
      ))}
    </ul>
  );
}

export function Plans({
  plans,
  onOrder,
}: {
  plans: Plan[];
  onOrder: (plan: Plan) => void;
}): ReactNode {
  const wide = useMediaQuery('(min-width: 64rem)');

  return wide && plans.length <= SHEET_MAX_PLANS ? (
    <Sheet plans={plans} onOrder={onOrder} />
  ) : (
    <Stack plans={plans} onOrder={onOrder} />
  );
}

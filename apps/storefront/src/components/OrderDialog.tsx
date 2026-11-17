import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, placeOrder, type OrderReceipt, type Plan } from '../api';
import { formatPrice, intervalLabel } from '../format';
import {
  FIELD_MESSAGES,
  FIELD_ORDER,
  normalizeDomain,
  validateOrder,
  type OrderErrors,
  type OrderField,
  type OrderFormValues,
} from '../validation';

interface OrderDialogProps {
  plan: Plan | null;
  providerName: string;
  providerSlug: string;
  onClose: () => void;
}

type Phase =
  | { kind: 'form' }
  | { kind: 'sending' }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; receipt: OrderReceipt; email: string };

const EMPTY: OrderFormValues = { name: '', email: '', phone: '', companyName: '', domain: '' };

interface TextFieldProps {
  field: OrderField;
  label: string;
  value: string;
  error: string | undefined;
  type?: 'text' | 'email' | 'tel';
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'tel' | 'url';
  hint?: string;
  optional?: boolean;
  onChange: (field: OrderField, value: string) => void;
  onBlur?: () => void;
}

function TextField({
  field,
  label,
  value,
  error,
  type = 'text',
  autoComplete,
  inputMode,
  hint,
  optional = false,
  onChange,
  onBlur,
}: TextFieldProps) {
  const id = `order-${field}`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
        {optional ? <span className="field__optional"> (optional)</span> : null}
      </label>
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        className="field__input"
        type={type}
        name={field}
        value={value}
        autoComplete={autoComplete}
        inputMode={inputMode}
        autoCapitalize={field === 'domain' || field === 'email' ? 'none' : undefined}
        spellCheck={field === 'name' || field === 'companyName'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(field, event.target.value)}
        onBlur={onBlur}
      />
      {error ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'This plan is no longer available. Close this window and choose another plan.';
    }

    if (error.status === 429) {
      return 'There have been too many orders from this device. Wait a minute and try again.';
    }

    if (error.status === 409 || error.status === 422) {
      return error.message;
    }
  }

  return 'We could not send your order. Check your connection and try again.';
}

export function OrderDialog({ plan, providerName, providerSlug, onClose }: OrderDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const [values, setValues] = useState<OrderFormValues>(EMPTY);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<OrderErrors>({});
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (plan && !dialog.open) {
      setValues(EMPTY);
      setSubmitted(false);
      setServerErrors({});
      setPhase({ kind: 'form' });
      dialog.showModal();
    } else if (!plan && dialog.open) {
      dialog.close();
    }
  }, [plan]);

  useEffect(() => {
    if (phase.kind === 'done') {
      resultRef.current?.focus();
    }
  }, [phase.kind]);

  const errors: OrderErrors = submitted ? { ...validateOrder(values), ...serverErrors } : {};

  function change(field: OrderField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setServerErrors((current) => {
      if (!current[field]) {
        return current;
      }

      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!plan || phase.kind === 'sending') {
      return;
    }

    setSubmitted(true);
    setServerErrors({});

    const found = validateOrder(values);
    const firstInvalid = FIELD_ORDER.find((field) => found[field]);

    if (firstInvalid) {
      document.getElementById(`order-${firstInvalid}`)?.focus();
      return;
    }

    const phone = values.phone.trim();
    const companyName = values.companyName.trim();
    const email = values.email.trim();

    setPhase({ kind: 'sending' });

    try {
      const receipt = await placeOrder(providerSlug, {
        planId: plan.id,
        name: values.name.trim(),
        email,
        ...(phone ? { phone } : {}),
        ...(companyName ? { companyName } : {}),
        domain: normalizeDomain(values.domain),
      });

      setPhase({ kind: 'done', receipt, email });
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        const fieldErrors: OrderErrors = {};

        for (const field of error.fields) {
          if (field in FIELD_MESSAGES) {
            fieldErrors[field as OrderField] = FIELD_MESSAGES[field as OrderField];
          }
        }

        setServerErrors(fieldErrors);
        setPhase({ kind: 'failed', message: 'Check the marked fields and try again.' });
        return;
      }

      setPhase({ kind: 'failed', message: failureMessage(error) });
    }
  }

  function close() {
    dialogRef.current?.close();
  }

  let body: ReactNode = null;

  if (plan && phase.kind === 'done') {
    body = (
      <div className="receipt">
        <h2 className="order__title" id={titleId} ref={resultRef} tabIndex={-1}>
          Order placed
        </h2>
        <p className="receipt__reference">
          <span className="receipt__label">Order reference</span>
          <strong className="receipt__code">{phase.receipt.reference}</strong>
        </p>
        <p className="order__copy">
          Nothing has been charged. {providerName} will contact you at{' '}
          <strong>{phase.email}</strong> to confirm your order and start hosting for{' '}
          <strong>{phase.receipt.domain}</strong>.
        </p>
        <div className="order__actions">
          <button type="button" className="button" onClick={close}>
            Done
          </button>
        </div>
      </div>
    );
  } else if (plan) {
    const firstInvoice = plan.priceMinorUnits + plan.setupFeeMinorUnits;
    const sending = phase.kind === 'sending';

    body = (
      <form noValidate onSubmit={submit} aria-labelledby={titleId}>
        <h2 className="order__title" id={titleId}>
          Order {plan.name}
        </h2>
        <p className="order__summary">
          {formatPrice(plan.priceMinorUnits, plan.currency)}{' '}
          {intervalLabel(plan.billingInterval, plan.intervalCount)}
          {plan.setupFeeMinorUnits > 0
            ? `, plus a ${formatPrice(plan.setupFeeMinorUnits, plan.currency)} setup fee on your first invoice (${formatPrice(firstInvoice, plan.currency)} in total).`
            : '. There is no setup fee.'}
        </p>

        {phase.kind === 'failed' ? (
          <p className="order__alert" role="alert">
            {phase.message}
          </p>
        ) : null}

        <TextField
          field="name"
          label="Full name"
          value={values.name}
          error={errors.name}
          autoComplete="name"
          onChange={change}
        />
        <TextField
          field="email"
          label="Email address"
          type="email"
          inputMode="email"
          value={values.email}
          error={errors.email}
          autoComplete="email"
          onChange={change}
        />
        <TextField
          field="domain"
          label="Domain name"
          hint="The website address you want to host, for example mystore.com."
          inputMode="url"
          value={values.domain}
          error={errors.domain}
          onChange={change}
          onBlur={() => {
            if (values.domain.trim()) {
              change('domain', normalizeDomain(values.domain));
            }
          }}
        />
        <div className="field-row">
          <TextField
            field="phone"
            label="Phone number"
            type="tel"
            inputMode="tel"
            optional
            value={values.phone}
            error={errors.phone}
            autoComplete="tel"
            onChange={change}
          />
          <TextField
            field="companyName"
            label="Company"
            optional
            value={values.companyName}
            error={errors.companyName}
            autoComplete="organization"
            onChange={change}
          />
        </div>

        <p className="order__copy order__copy--note">
          No payment is taken now. {providerName} reviews your order and gets in touch to start your
          hosting.
        </p>

        <div className="order__actions">
          <button type="button" className="button button--quiet" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={sending} aria-busy={sending}>
            {sending ? 'Placing order…' : 'Place order'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      className="order"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          close();
        }
      }}
    >
      <div className="order__panel">{body}</div>
    </dialog>
  );
}

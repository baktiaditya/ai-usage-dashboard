'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import {
  FloatingFocusManager,
  FloatingOverlay,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  useTransitionStatus,
} from '@floating-ui/react';
import { X } from 'lucide-react';
import { CREDENTIAL_PROVIDERS } from '@/lib/domain';
import type { CredentialProvider, CredentialStatus } from '@/lib/domain';
import { formatAge } from '@/lib/time';
import { cn } from '@/lib/cn';

export interface SettingsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const FIELD_LABELS: Record<CredentialProvider, string> = {
  deepseek: 'DeepSeek API Key',
  openrouter: 'OpenRouter Management Key',
  claude: 'Claude Token (optional)',
  opencode_go: 'OpenCode Go API Key',
};

/** Fields that render a help paragraph, which their input must reference. */
const HAS_HELP: ReadonlySet<CredentialProvider> = new Set(['openrouter', 'claude', 'opencode_go']);

const UNREACHABLE = 'Could not reach the local dashboard server.';

const BUTTON =
  'border-border bg-surface hover:bg-surface-muted inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60';

type InputRefs = Record<CredentialProvider, RefObject<HTMLInputElement | null>>;

type Outcome =
  | { readonly ok: true; readonly credential: CredentialStatus }
  | { readonly ok: false; readonly message: string };

interface ApiBody {
  readonly credential?: CredentialStatus;
  readonly credentials?: CredentialStatus[];
  readonly error?: { readonly message?: string };
}

async function readBody(res: Response): Promise<ApiBody | null> {
  try {
    return (await res.json()) as ApiBody;
  } catch {
    return null;
  }
}

/**
 * Save (`secret` given) or remove (`null`) one provider's key. The secret goes
 * only into the PUT body: never the URL, the console, or browser storage.
 */
async function sendCredential(
  provider: CredentialProvider,
  secret: string | null,
): Promise<Outcome> {
  try {
    const res = await fetch(
      `/api/settings/credentials/${provider}`,
      secret === null
        ? { method: 'DELETE', credentials: 'same-origin' }
        : {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret }),
          },
    );
    const body = await readBody(res);
    if (res.ok && body?.credential) return { ok: true, credential: body.credential };
    return {
      ok: false,
      message: body?.error?.message ?? `The dashboard server answered ${res.status}.`,
    };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

function statusText(status: CredentialStatus | undefined, now: number): string {
  if (!status) return '';
  if (!status.configured) return 'Not set';
  const saved = status.hint === null ? 'Saved' : `Saved ••••${status.hint}`;
  if (status.updatedAt === null) return saved;
  const age = formatAge(Math.max(0, now - Date.parse(status.updatedAt)));
  return `${saved} · updated ${age === 'just now' ? age : `${age} ago`}`;
}

/**
 * Provider keys, entered here and stored in the local database (plan §3.5).
 *
 * The server only ever returns whether a key is saved, its last four
 * characters, and when it was saved, so the inputs always start empty. The form
 * mounts on every open, which drops anything typed before a close.
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const { context } = useFloating({ open, onOpenChange, elements: { floating: panel } });
  // On `click`, not the default `pointerdown`: the `mousedown` that follows a
  // pointerdown dismissal would move focus to the page after it had returned to
  // the Settings button.
  const dismiss = useDismiss(context, { outsidePressEvent: 'click' });
  const role = useRole(context, { role: 'dialog' });
  const { getFloatingProps } = useInteractions([dismiss, role]);
  // Stays mounted through the close transition; focus returns to the Settings
  // button when it unmounts. Matches the 100ms transitions below.
  const { isMounted, status } = useTransitionStatus(context, { duration: 100 });
  const headingId = useId();
  const deepseekInput = useRef<HTMLInputElement>(null);
  const openrouterInput = useRef<HTMLInputElement>(null);
  const claudeInput = useRef<HTMLInputElement>(null);
  const opencodeGoInput = useRef<HTMLInputElement>(null);

  if (!isMounted) return null;

  // shadcn/ui's dialog motion, shortened to 100ms: the blurred backdrop fades,
  // and the panel fades and zooms from 95%. They are siblings, so the
  // backdrop's fade never dims the panel.
  return (
    <FloatingPortal>
      <FloatingOverlay
        lockScroll
        className="z-50 flex items-center justify-center"
        data-testid="settings-overlay"
      >
        <div
          aria-hidden
          data-status={status}
          className="fixed inset-0 bg-black/50 opacity-0 transition-opacity duration-100 ease-[ease] data-[status=open]:opacity-100 supports-backdrop-filter:backdrop-blur-xs"
        />
        {/* Returns focus to the element that opened it: the Settings button. */}
        <FloatingFocusManager context={context} initialFocus={deepseekInput}>
          <div
            ref={setPanel}
            aria-labelledby={headingId}
            data-testid="settings-dialog"
            data-status={status}
            className="bg-surface border-border relative m-4 max-h-[calc(100dvh-2rem)] w-full max-w-md scale-95 overflow-y-auto rounded-xl border opacity-0 shadow-sm transition-[opacity,scale] duration-100 ease-[ease] data-[status=open]:scale-100 data-[status=open]:opacity-100"
            {...getFloatingProps()}
          >
            <SettingsForm
              headingId={headingId}
              inputRefs={{
                deepseek: deepseekInput,
                openrouter: openrouterInput,
                claude: claudeInput,
                opencode_go: opencodeGoInput,
              }}
              onClose={() => onOpenChange(false)}
            />
            {/* shadcn/ui's corner close button, last in tab order, level with the heading. */}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
              data-testid="settings-dismiss"
              className="text-muted-foreground hover:text-foreground absolute top-5 right-5 inline-flex size-6 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </FloatingFocusManager>
      </FloatingOverlay>
    </FloatingPortal>
  );
}

function SettingsForm({
  headingId,
  inputRefs,
  onClose,
}: {
  readonly headingId: string;
  readonly inputRefs: InputRefs;
  readonly onClose: () => void;
}) {
  const [statuses, setStatuses] = useState<Partial<Record<CredentialProvider, CredentialStatus>>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(0);
  const [values, setValues] = useState<Record<CredentialProvider, string>>({
    deepseek: '',
    openrouter: '',
    claude: '',
    opencode_go: '',
  });
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings/credentials', { credentials: 'same-origin' })
      .then(
        async (res): Promise<CredentialStatus[] | string> => {
          const body = await readBody(res);
          if (res.ok && body?.credentials) return body.credentials;
          return body?.error?.message ?? 'Could not load the saved keys.';
        },
        () => UNREACHABLE,
      )
      .then((result) => {
        if (cancelled) return;
        if (typeof result === 'string') {
          setError(result);
        } else {
          // Save stays enabled while this loads. Anything already in state came
          // from a PUT or DELETE answered after this GET was sent, so it wins.
          setStatuses((prev) => ({
            ...Object.fromEntries(result.map((status) => [status.provider, status])),
            ...prev,
          }));
          setNow(Date.now());
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Ages tick forward like the dashboard's. A status saved after the last tick
  // is newer than `now`, which the age clamps to "just now".
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  function applyStatus(credential: CredentialStatus): void {
    setStatuses((prev) => ({ ...prev, [credential.provider]: credential }));
  }

  const filled = CREDENTIAL_PROVIDERS.filter((provider) => values[provider] !== '');

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending || filled.length === 0) return;
    setPending(true);
    setSaved(false);
    setError(null);

    // One PUT per filled field, in order. A failure keeps its value so it can be
    // corrected; a success clears its input.
    const failures: string[] = [];
    let succeeded = 0;
    for (const provider of filled) {
      const outcome = await sendCredential(provider, values[provider]);
      if (outcome.ok) {
        succeeded += 1;
        applyStatus(outcome.credential);
        setValues((prev) => ({ ...prev, [provider]: '' }));
      } else {
        failures.push(
          filled.length > 1 ? `${FIELD_LABELS[provider]}: ${outcome.message}` : outcome.message,
        );
      }
    }

    setSaved(succeeded > 0);
    setError(failures.length > 0 ? failures.join(' ') : null);
    setPending(false);
  }

  async function remove(provider: CredentialProvider): Promise<void> {
    if (pending) return;
    setPending(true);
    setSaved(false);
    setError(null);
    const outcome = await sendCredential(provider, null);
    if (outcome.ok) {
      applyStatus(outcome.credential);
      // The Remove button is about to disappear; keep focus inside the dialog.
      inputRefs[provider].current?.focus();
    } else {
      setError(outcome.message);
    }
    setPending(false);
  }

  return (
    <form onSubmit={(event) => void save(event)} noValidate className="flex flex-col gap-5 p-5">
      <div className="flex flex-col gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Settings
        </h2>
        <p className="text-muted-foreground text-sm">
          Keys are stored in the local dashboard database and used from the next collection. Use
          Refresh on a card to collect now.
        </p>
      </div>

      {CREDENTIAL_PROVIDERS.map((provider) => {
        const status = statuses[provider];
        const inputId = `${headingId}-${provider}`;
        const helpId = `${inputId}-help`;
        const statusId = `${inputId}-status`;
        return (
          <div key={provider} className="flex flex-col gap-2">
            <label htmlFor={inputId} className="text-sm font-medium">
              {FIELD_LABELS[provider]}
            </label>
            {provider === 'openrouter' ? (
              <p id={helpId} className="text-muted-foreground text-xs">
                Must be a Management key; ordinary inference keys are rejected.{' '}
                <a
                  href="https://openrouter.ai/settings/management-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground underline underline-offset-2"
                >
                  Create a Management key
                </a>
              </p>
            ) : provider === 'claude' ? (
              <p id={helpId} className="text-muted-foreground text-xs">
                Optional. Claude still reports quota through the status line without it. With a
                token from <code>claude setup-token</code>, the collector also reads quota when no
                session is reporting, by sending a one-token Claude Haiku request at most once every
                five minutes. Each request counts toward your Claude usage. Removing the token here
                does not revoke it.
              </p>
            ) : provider === 'opencode_go' ? (
              <p id={helpId} className="text-muted-foreground text-xs">
                The dashboard only reads your Go usage windows with it, but the same key can run
                models and spend Zen balance, so treat it like a password. Removing it here does not
                revoke it.{' '}
                <a
                  href="https://opencode.ai/auth"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground underline underline-offset-2"
                >
                  Open the OpenCode console
                </a>
              </p>
            ) : null}
            <input
              ref={inputRefs[provider]}
              id={inputId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={values[provider]}
              readOnly={pending}
              onChange={(event) => {
                const next = event.target.value;
                setValues((prev) => ({ ...prev, [provider]: next }));
              }}
              aria-describedby={HAS_HELP.has(provider) ? `${helpId} ${statusId}` : statusId}
              data-testid={`settings-input-${provider}`}
              className="border-border bg-background w-full rounded-lg border px-3 py-1.5 text-sm"
            />
            <div className="flex min-h-7 items-center justify-between gap-2">
              <p
                id={statusId}
                className="text-muted-foreground text-xs"
                data-testid={`settings-status-${provider}`}
              >
                {statusText(status, now)}
              </p>
              {status?.configured ? (
                <button
                  type="button"
                  onClick={() => void remove(provider)}
                  disabled={pending}
                  data-testid={`settings-remove-${provider}`}
                  className={BUTTON}
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        );
      })}

      {saved ? (
        <p className="text-healthy text-xs" role="status" data-testid="settings-success">
          Saved.
        </p>
      ) : null}
      {error ? (
        <p
          className="bg-danger-bg text-danger rounded-lg px-3 py-2 text-xs"
          role="alert"
          data-testid="settings-error"
        >
          {error}
        </p>
      ) : null}

      {/* shadcn/ui's dialog footer: below `sm` the buttons stack full width with
          Save on top, under the loading note; from `sm` they sit right-aligned in
          one row beside it. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {loading ? (
          <p className="text-muted-foreground text-xs" data-testid="settings-loading">
            Loading saved keys…
          </p>
        ) : null}

        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
          <button
            type="button"
            onClick={onClose}
            data-testid="settings-close"
            className={cn(BUTTON, 'justify-center')}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending || filled.length === 0}
            data-testid="settings-save"
            className={cn(
              BUTTON,
              'bg-foreground text-background hover:bg-foreground/90 justify-center',
            )}
          >
            Save
          </button>
        </div>
      </div>
    </form>
  );
}

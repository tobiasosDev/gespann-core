import { useState } from "react";
import { api } from "../api.ts";
import { Button, Input } from "./ui.tsx";

function showModal(d: HTMLDialogElement | null): void {
  if (d && !d.open) d.showModal();
}

/**
 * After the first sign-in, when no sign-in brought an address: where gespann sends mail. The address
 * counts once the user opens the link mailed to it. Only a mail that could not be sent lets them go on
 * without one.
 */
export function EmailDialog({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ confirmed: boolean }>("/settings/email", { email });
      if (r.confirmed) onDone();
      else setSent(email.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={showModal}
      aria-labelledby="email-title"
      // Escape does not close it: the address is needed.
      onCancel={(e) => e.preventDefault()}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50"
    >
      {sent ? (
        <div className="space-y-3 p-5">
          <h2 id="email-title" className="text-title font-semibold">
            Check your inbox
          </h2>
          <p className="text-body text-muted-foreground">
            We sent a link to <span className="font-medium text-foreground">{sent}</span>. Open it to confirm the address. You can change it later in Settings.
          </p>
          <div className="flex justify-end">
            <Button autoFocus onClick={onDone}>
              OK
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2 id="email-title" className="text-title font-semibold">
            Where should we send mail?
          </h2>
          <p className="text-body text-muted-foreground">gespann mails you when a project's PR tests keep failing. Your sign-in did not give us an address.</p>
          <label className="block space-y-1">
            <span className="text-small text-muted-foreground">Email</span>
            <Input autoFocus type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          {error && <p className="text-body text-bad">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            {error && (
              <Button type="button" variant="ghost" onClick={onDone}>
                Skip for now
              </Button>
            )}
            <Button type="submit" disabled={busy || !email.trim()}>
              Send confirmation link
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

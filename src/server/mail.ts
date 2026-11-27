import { createTransport } from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  /** Plain text; gespann sends no HTML mail. */
  text: string;
}

/** Sends gespann's mail: over SMTP when `SMTP_URL` is set, otherwise only into the log. */
export interface Mailer {
  /** False without `SMTP_URL`: nothing leaves the server, so nobody is asked for an address. */
  readonly sends: boolean;
  send(m: Mail): Promise<void>;
}

/**
 * `SMTP_URL` names any SMTP server: `smtps://user:pass@smtp.example.com:465` (TLS from the start) or
 * `smtp://user:pass@smtp.example.com:587` (upgrades with STARTTLS, and refuses to send without it,
 * except to a relay on the same machine, `localhost` or `127.0.0.1`).
 * `MAIL_FROM` is the sender, e.g. `gespann <noreply@example.com>`.
 * A server that does not answer within `timeoutMs` fails the send: the dialog that asks for an address
 * waits on it, and the SMTP library alone would wait minutes.
 */
export function createMailer(o: { smtpUrl: string; from: string; timeoutMs?: number }): Mailer {
  if (!o.smtpUrl) {
    return {
      sends: false,
      async send(m) {
        console.log(JSON.stringify({ level: "info", message: "mail not sent: SMTP_URL is not set", to: m.to, subject: m.subject, text: m.text }));
      },
    };
  }
  const url = new URL(o.smtpUrl);
  const timeout = o.timeoutMs ?? 15_000;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const transport = createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "smtps:" ? 465 : 587,
    secure: url.protocol === "smtps:",
    requireTLS: url.protocol === "smtp:" && !local,
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    sends: true,
    async send(m) {
      await transport.sendMail({ from: o.from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}

/** `SMTP_URL` and `MAIL_FROM` as the config reads them; throws on a value that cannot work. */
export function mailSettings(env: NodeJS.ProcessEnv): { smtpUrl: string; from: string } {
  const smtpUrl = (env.SMTP_URL ?? "").trim();
  const from = (env.MAIL_FROM ?? "").trim();
  if (!smtpUrl) return { smtpUrl: "", from };
  let url: URL;
  try {
    url = new URL(smtpUrl);
  } catch {
    throw new Error("SMTP_URL is not a URL; write smtps://user:password@host:465 or smtp://user:password@host:587");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") throw new Error(`SMTP_URL must start with smtp:// or smtps://, not ${url.protocol}//`);
  if (!from) throw new Error("SMTP_URL is set but MAIL_FROM is not; set the sender, e.g. gespann <noreply@example.com>");
  return { smtpUrl, from };
}

/** A plausible address: one @, no spaces, a dot in the domain. Confirmation proves the rest. */
export function validEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:]+$/.test(s);
}

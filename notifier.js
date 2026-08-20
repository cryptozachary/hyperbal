import nodemailer from 'nodemailer';

// Email transport behind a two-property interface — `configured` and `send` — so
// the runner never branches on whether mail is really set up, and the tests never
// open a socket.
//
// With no SMTP_HOST or no ALERT_EMAIL_TO this returns a logging no-op reporting
// `configured: false`: rules still evaluate and still advance their state, they
// just don't leave the machine. That keeps the app runnable with an empty .env,
// matching how DEFAULT_WALLET is already optional.
//
// `send` resolves `{sent}` rather than throwing on the unconfigured path, because
// "no mail was set up" is not a failure worth retrying. A real transport error DOES
// throw — that one is.
export function createNotifier(cfg, { transportFactory = nodemailer.createTransport } = {}) {
  if (!cfg.smtpHost || !cfg.alertEmailTo) {
    return {
      configured: false,
      async send({ subject }) {
        console.log(`[alerts] email not configured; would have sent: ${subject}`);
        return { sent: false, reason: 'not-configured' };
      },
    };
  }

  const transport = transportFactory({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    // 465 is implicit TLS from the first byte; 587 and friends open in the clear
    // and upgrade via STARTTLS, which nodemailer negotiates on its own.
    secure: cfg.smtpPort === 465,
    // Omitted entirely rather than passed empty — a local relay on port 25
    // typically wants no auth at all, and an empty credential pair is not the same
    // thing as none.
    auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
  });

  return {
    configured: true,
    async send({ subject, text }) {
      await transport.sendMail({
        from: cfg.smtpFrom || cfg.smtpUser,
        to: cfg.alertEmailTo,
        subject,
        text,
      });
      return { sent: true };
    },
  };
}

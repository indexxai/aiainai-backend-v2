import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { codeEmail, type CodeEmailKind } from './templates.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends email through Resend. Without RESEND_API_KEY (local development only — production
 * refuses to start without it) the email is written to the server log instead, so codes
 * can still be used while developing.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger('Email');

  constructor(private readonly config: ConfigService<Env, true>) {}

  sendCode(to: string, code: string, kind: CodeEmailKind): Promise<void> {
    return this.send({ to, ...codeEmail(kind, code, to) });
  }

  async send(mail: OutgoingEmail): Promise<void> {
    const key = this.config.get('RESEND_API_KEY', { infer: true });
    if (!key) {
      this.logger.warn(`[dev email — not sent] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: this.config.get('EMAIL_FROM', { infer: true }),
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });
    if (!res.ok) {
      // Never log the code itself in production; the subject is enough to trace it.
      this.logger.error(`Email to ${mail.to} failed (${res.status}): ${await res.text().catch(() => '')}`);
      throw new Error('Email delivery failed');
    }
  }
}

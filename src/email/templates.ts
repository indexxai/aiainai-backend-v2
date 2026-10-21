/**
 * Code emails, following the email designs (Account → Verify email / Reset password).
 * Plain and light, with a text version for every email.
 */
export type CodeEmailKind = 'email-verification' | 'forget-password' | 'sign-in' | 'change-email';

const COPY: Record<
  CodeEmailKind,
  { subject: (c: string) => string; heading: string; intro: (to: string) => string; expires: string }
> = {
  'email-verification': {
    subject: (c) => `Your aiainai code: ${c}`,
    heading: 'Confirm your email',
    intro: () => 'Enter this code in aiainai to finish creating your account.',
    expires: 'The code expires in 10 minutes. If you didn’t sign up for aiainai, you can ignore this email.',
  },
  'forget-password': {
    subject: () => 'Reset your aiainai password',
    heading: 'Reset your password',
    intro: (to) =>
      `We got a request to reset the password for ${to}. Use this code to choose a new password.`,
    expires:
      'The code expires in 10 minutes. If you didn’t ask for this, ignore this email; your password won’t change.',
  },
  'sign-in': {
    subject: (c) => `Your aiainai sign-in code: ${c}`,
    heading: 'Sign in to aiainai',
    intro: () => 'Enter this code to sign in.',
    expires: 'The code expires in 10 minutes. If you didn’t try to sign in, you can ignore this email.',
  },
  'change-email': {
    subject: () => 'Confirm your new email address',
    heading: 'Confirm your new email',
    intro: () => 'Enter this code in Settings to change your aiainai email.',
    expires: 'The code expires in 10 minutes.',
  },
};

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function codeEmail(
  kind: CodeEmailKind,
  code: string,
  to: string,
): { subject: string; text: string; html: string } {
  const c = COPY[kind];
  const spaced = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  const security = 'We’ll never ask for your password or payment details by email.';
  const text = `${c.heading}\n\n${c.intro(to)}\n\n${spaced}\n\n${c.expires}\n\n${security}\naiainai.ai`;
  const html = `<!doctype html><html><body style="margin:0;background:#f0f0f2;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
<tr><td style="padding:40px">
<p style="margin:0 0 20px;font-size:15px;font-weight:bold">aiainai</p>
<h1 style="margin:0 0 12px;font-size:22px;line-height:30px">${escape(c.heading)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:24px">${escape(c.intro(to))}</p>
<p style="margin:0 0 20px;padding:16px;background:#f0f0f2;border-radius:10px;text-align:center;font-family:'Courier New',monospace;font-size:32px;line-height:40px;letter-spacing:6px;font-weight:bold">${escape(spaced)}</p>
<p style="margin:0 0 20px;font-size:13px;line-height:20px;color:#56565e">${escape(c.expires)}</p>
<p style="margin:0;padding-top:16px;border-top:1px solid #e4e4e7;font-size:12px;line-height:18px;color:#6e6e76">${escape(security)}<br>aiainai.ai</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: c.subject(spaced), text, html };
}

/** "Someone shared a document with you" (view only), with a button to open it. */
export function docSharedEmail(input: { from: string; title: string; url: string; message?: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const heading = `${input.from} shared a document with you`;
  const note = 'You can view it after signing in with this email address. You can’t edit it.';
  const text = [
    heading,
    `“${input.title}”`,
    input.message ? `Message from ${input.from}: ${input.message}` : '',
    `Open the document: ${input.url}`,
    note,
    'aiainai.ai',
  ]
    .filter(Boolean)
    .join('\n\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f0f0f2;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px">
<tr><td style="padding:40px">
<p style="margin:0 0 20px;font-size:15px;font-weight:bold">aiainai</p>
<h1 style="margin:0 0 12px;font-size:22px;line-height:30px">${escape(heading)}</h1>
<p style="margin:0 0 20px;padding:16px;background:#f0f0f2;border-radius:10px;font-size:16px;line-height:24px;font-weight:bold">${escape(input.title)}</p>
${input.message ? `<p style="margin:0 0 20px;font-size:15px;line-height:24px;color:#3f3f46">“${escape(input.message)}”</p>` : ''}
<p style="margin:0 0 24px"><a href="${escape(input.url)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;padding:12px 20px;border-radius:10px">Open document</a></p>
<p style="margin:0 0 20px;font-size:13px;line-height:20px;color:#56565e">${escape(note)}</p>
<p style="margin:0;padding-top:16px;border-top:1px solid #e4e4e7;font-size:12px;line-height:18px;color:#6e6e76">aiainai.ai</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: `${input.from} shared “${input.title}” with you`, text, html };
}

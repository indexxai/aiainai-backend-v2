import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';

/**
 * Stand-in model for local development and tests: streams a short sample answer word by word,
 * so the whole flow (credits, streaming, Stop, usage) can be built before provider keys exist.
 * Refused in production by env validation.
 */
export class DemoLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'demo';
  readonly supportedUrls = {};
  /** The latest prompts it was given (newest last), so tests can check what a model would see. */
  static readonly prompts: string[] = [];
  private static remember(options: LanguageModelV4CallOptions) {
    DemoLanguageModel.prompts.push(JSON.stringify(options.prompt));
    if (DemoLanguageModel.prompts.length > 50) DemoLanguageModel.prompts.shift();
  }

  constructor(
    readonly modelId: string,
    private readonly displayName: string,
    private readonly delayMs = 25,
  ) {}

  async doGenerate(options: LanguageModelV4CallOptions) {
    DemoLanguageModel.remember(options);
    const text =
      options.responseFormat?.type === 'json' ? JSON.stringify(sampleObject(options)) : this.answer(options);
    return {
      content: [{ type: 'text' as const, text }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: usage(options, text),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV4CallOptions) {
    DemoLanguageModel.remember(options);
    const text = this.answer(options);
    const words = text.match(/\S+\s*/g) ?? [text];
    const delay = this.delayMs;
    const signal = options.abortSignal;
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 't0' });
        for (const w of words) {
          if (signal?.aborted) {
            controller.error(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (delay) await new Promise((r) => setTimeout(r, delay));
          controller.enqueue({ type: 'text-delta', id: 't0', delta: w });
        }
        controller.enqueue({ type: 'text-end', id: 't0' });
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: usage(options, text),
        });
        controller.close();
      },
    });
    return { stream };
  }

  private answer(options: LanguageModelV4CallOptions): string {
    const doc = sampleDocument(options);
    if (doc) return doc;
    const asked = lastUserText(options).trim().replace(/\s+/g, ' ');
    const quoted = asked.length > 120 ? `${asked.slice(0, 117)}…` : asked;
    return [
      `This is a sample answer from the stand-in for **${this.displayName}**.`,
      quoted ? `You asked: “${quoted}”` : '',
      'What works already:',
      '- **Streaming**, Stop and Continue\n- **Credits**: held before the answer, charged when it finishes\n- **History**: earlier messages are sent as context',
      'Real answers start as soon as the provider key is added on the server.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}

function lastUserText(options: LanguageModelV4CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i--) {
    const m = options.prompt[i]!;
    if (m.role !== 'user') continue;
    return m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
  }
  return '';
}

/** Rough token estimate (4 characters ≈ 1 token); good enough for a stand-in. */
function usage(options: LanguageModelV4CallOptions, text: string) {
  const inChars = JSON.stringify(options.prompt).length;
  const input = Math.ceil(inChars / 4);
  const output = Math.ceil(text.length / 4);
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/* ── Sample structured output and documents (AI Docs) ─────────────────────────── */

const OUTLINES: Record<string, string[]> = {
  proposal: ['Summary', 'Scope', 'Timeline', 'Team', 'Next steps'],
  report: ['Summary', 'Results', 'What changed', 'Next steps'],
  letter: ['Opening', 'Main points', 'Closing'],
  plan: ['Goal', 'Steps', 'Owners and dates', 'Risks'],
  article: ['Introduction', 'The problem', 'What to do instead', 'Conclusion'],
  'meeting-notes': ['Attendees', 'Decisions', 'Action items'],
  other: ['Overview', 'Details', 'Next steps'],
};

/** A plausible object for the requested JSON schema (outline-shaped when asked for sections). */
function sampleObject(options: LanguageModelV4CallOptions): unknown {
  const fmt = options.responseFormat;
  const schema = (fmt?.type === 'json' ? fmt.schema : undefined) as
    { properties?: Record<string, unknown> } | undefined;
  const text = allText(options);
  if (schema?.properties && 'sections' in schema.properties) {
    const type = /Type:\s*([a-z-]+)/i.exec(text)?.[1]?.toLowerCase() ?? 'other';
    const brief = /Brief:\s*(.+)/i.exec(text)?.[1]?.trim() ?? 'Your document';
    const headings = OUTLINES[type] ?? OUTLINES.other!;
    return {
      title: (() => {
        const t = brief.length > 60 ? `${brief.slice(0, 57).trimEnd()}…` : brief;
        return t.charAt(0).toUpperCase() + t.slice(1);
      })(),
      sections: headings.map((heading, i) => ({
        heading,
        note:
          i === 0
            ? 'From your brief'
            : i === headings.length - 1
              ? 'Suggested'
              : 'Suggested — common in this kind of document',
      })),
    };
  }
  if (schema?.properties && 'memories' in schema.properties) return sampleMemories(lastUserText(options));
  if (schema?.properties && 'jackSteps' in schema.properties)
    return sampleJackPlan(
      lastUserText(options),
      /calendar: read the person/.test(text),
      /email: read the person/.test(text),
      /browse: use Jack/.test(text),
      /drive: search the person/.test(text),
      /slack: read recent/.test(text),
    );
  if (schema?.properties && 'prompt' in schema.properties) {
    const asked = (/^Prompt:\s*(.+)$/m.exec(text)?.[1] ?? 'your idea').trim().replace(/[.\s]+$/, '');
    return {
      prompt: `${asked.charAt(0).toUpperCase()}${asked.slice(1)}, in a calm, well-lit scene with soft natural light, warm colours and a clean, uncluttered composition (sample prompt from the stand-in model)`,
    };
  }
  if (schema?.properties && 'reply' in schema.properties) return sampleAssistant(lastUserText(options));
  if (schema?.properties && 'text' in schema.properties)
    return { text: sampleRewrite(lastUserText(options)) };
  return {};
}

/* ── Jack (v2): lasting facts from a message, from simple first-person phrases ── */

function sampleMemories(message: string) {
  const found: { text: string; group: string }[] = [];
  const add = (text: string, group: string) => {
    const t = text.trim().replace(/[.!]+$/, '');
    if (t && found.length < 2) found.push({ text: t.charAt(0).toUpperCase() + t.slice(1), group });
  };
  // Sentences, and "… and …" parts of them, one fact each.
  for (const part of message.split(/(?<=[.!?])\s+|\n|,\s+and\s+|\s+and\s+(?=I\b|my\b)/i)) {
    const s = part.trim();
    let m: RegExpExecArray | null;
    if ((m = /\bI (?:live|am based) in ([^,.;]+)/i.exec(s))) add(`Lives in ${m[1]}`, 'about');
    else if ((m = /\bI (?:prefer|always want|like to have) ([^.;]+)/i.exec(s)))
      add(`Prefers ${m[1]}`, 'preferences');
    else if (
      (m =
        /\bmy (mum|mom|mother|dad|father|wife|husband|brother|sister|son|daughter|partner)(?:’s|'s| is)? ([^.;]+)/i.exec(
          s,
        ))
    )
      add(`${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1)} — ${m[2]}`, 'people');
    else if (
      (m = /\bevery (monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|week) I ([^.;]+)/i.exec(
        s,
      ))
    )
      add(`Every ${m[1]!.toLowerCase()}: ${m[2]}`, 'habits');
  }
  return { memories: found };
}

/* ── Jack (v2): which tools to use, from words in the message ── */

function sampleJackPlan(
  message: string,
  calendarAvailable = false,
  emailAvailable = false,
  browserAvailable = false,
  driveAvailable = false,
  slackAvailable = false,
) {
  const m = message.trim().replace(/\s+/g, ' ');
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const short = (t: string) => cap(t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t);
  // "… a proposal document for a free roof inspection offer, make …" → "a free roof inspection offer"
  const topic = /\bfor ([^,.;]+?)(?:,| and | then |\.|$)/i.exec(m)?.[1]?.trim() ?? m;
  type S = {
    tool: string;
    title: string;
    brief: string;
    docType: string;
    count: number;
    to: string;
    when: string;
  };
  const steps: S[] = [];
  const push = (x: Omit<S, 'to' | 'when'> & Partial<Pick<S, 'to' | 'when'>>) =>
    steps.push({ to: '', when: '', ...x });
  const doc = /\b(document|doc|report|checklist|proposal|letter|plan for|write[- ]?up|meeting notes)\b/i.exec(
    m,
  );
  if (doc) {
    const type = /proposal/i.test(m)
      ? 'proposal'
      : /report/i.test(m)
        ? 'report'
        : /letter/i.test(m)
          ? 'letter'
          : /meeting notes/i.test(m)
            ? 'meeting-notes'
            : /plan|checklist/i.test(m)
              ? 'plan'
              : 'other';
    const kind = /checklist/i.test(m)
      ? 'Checklist'
      : cap(type === 'other' ? 'document' : type.replace('-', ' '));
    push({ tool: 'doc', title: short(`${kind} — ${topic}`), brief: m, docType: type, count: 1 });
  }
  const pic = /\b(images?|pictures?|posters?|logos?|photos?|illustrations?|graphics?|flyers?)\b/i.exec(m);
  if (pic) {
    const n = /\b([1-4]|two|three|four)\b/i.exec(m)?.[1]?.toLowerCase();
    const count = n ? (({ two: 2, three: 3, four: 4 } as Record<string, number>)[n] ?? Number(n)) : 1;
    const what = pic[1]!.toLowerCase().replace(/s$/, '');
    push({
      tool: 'image',
      title: short(`${count} ${what}${count === 1 ? '' : 's'} — ${topic}`),
      brief: m,
      docType: 'other',
      count,
    });
  }
  const address = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/.exec(m)?.[0];
  if (emailAvailable && address && /\b(email|send|write to)\b/i.test(m)) {
    const about = /\babout ([^,.;]+)/i.exec(m)?.[1]?.trim() ?? 'Following up';
    push({
      tool: 'send_email',
      title: cap(about),
      brief: `Hi,\n\nI wanted to get in touch about ${about}. Could you let me know what works for you?\n\nThanks`,
      docType: 'other',
      count: 1,
      to: address,
    });
  } else if (calendarAvailable && /\b(add|put|schedule)\b.*\b(calendar)\b/i.test(m)) {
    const what =
      /\b(?:add|put|schedule) (?:an? )?([^,.;]+?) (?:to|on|in) (?:my )?calendar/i.exec(m)?.[1] ?? 'Event';
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(17, 30, 0, 0);
    push({
      tool: 'add_event',
      title: cap(what),
      brief: m,
      docType: 'other',
      count: 1,
      when: d.toISOString(),
    });
  } else if (calendarAvailable && /\b(calendar|schedule|this week|meetings?|appointments?)\b/i.test(m)) {
    push({ tool: 'calendar', title: 'Check your calendar', brief: m, docType: 'other', count: 1 });
  }
  if (emailAvailable && !address && /\b(emails?|inbox|mail)\b/i.test(m)) {
    push({ tool: 'email', title: 'Check your email', brief: m, docType: 'other', count: 1 });
  }
  if (driveAvailable && /\b(drive|my files?)\b/i.test(m)) {
    const words =
      /\b(?:find|search|look for|read)\s+(?:my |the )?([^,.;?]+?)(?:\s+(?:in|on|from) (?:my )?(?:google )?drive|[,.;?]|$)/i.exec(
        m,
      )?.[1] ?? '';
    push({
      tool: 'drive',
      title: 'Search Google Drive',
      brief: words.replace(/\b(files?|drive)\b/gi, '').trim(),
      docType: 'other',
      count: 1,
    });
  }
  const channel = /#([a-z0-9._-]+)/i.exec(m)?.[1]?.toLowerCase() ?? '';
  if (slackAvailable && /\b(post|send|tell|message)\b/i.test(m) && /\bslack\b/i.test(m) && channel) {
    const said = /\b(?:saying|that|:)\s+(.+)$/i.exec(m)?.[1]?.trim() ?? 'Quick update from me.';
    push({
      tool: 'send_slack',
      title: short(said),
      brief: cap(said),
      docType: 'other',
      count: 1,
      to: channel,
    });
  } else if (slackAvailable && /\bslack\b/i.test(m)) {
    push({ tool: 'slack', title: 'Check Slack', brief: m, docType: 'other', count: 1, to: channel });
  }
  if (browserAvailable && /\b(book|buy|order|purchase|find me|compare prices|reserve)\b/i.test(m) && !doc) {
    push({
      tool: 'browse',
      title: short(m.replace(/^(please\s+)?/i, '')),
      brief: m,
      docType: 'other',
      count: 1,
    });
  }
  return { jackSteps: steps };
}

/** Ask AI stand-in: a visible but sensible change for each quick action. */
function sampleRewrite(prompt: string): string {
  const original = /<<<\n([\s\S]*)\n>>>/.exec(prompt)?.[1] ?? '';
  const action = /^Action:\s*(\S+)/m.exec(prompt)?.[1] ?? 'custom';
  const sentences = original.match(/[^.!?]+[.!?]*\s*/g) ?? [original];
  switch (action) {
    case 'shorter': {
      const keep = sentences
        .slice(0, Math.max(1, Math.ceil(sentences.length / 2)))
        .join('')
        .trim();
      const words = keep.split(/\s+/);
      return words.length > 24
        ? `${words
            .slice(0, 24)
            .join(' ')
            .replace(/[,;:]$/, '')}.`
        : keep;
    }
    case 'formal':
      return original
        .replace(/\bdon['’]t\b/gi, 'do not')
        .replace(/\bcan['’]t\b/gi, 'cannot')
        .replace(/\bwon['’]t\b/gi, 'will not')
        .replace(/\bit['’]s\b/gi, 'it is')
        .replace(/\bwe['’]re\b/gi, 'we are')
        .replace(/\bwe['’]ll\b/gi, 'we will')
        .replace(/\bget\b/gi, 'obtain')
        .replace(/\bhelp\b/gi, 'assist');
    case 'simpler':
      return sentences
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) =>
          x.split(/\s+/).length > 14
            ? `${x
                .split(/\s+/)
                .slice(0, 14)
                .join(' ')
                .replace(/[,;:]$/, '')}.`
            : x,
        )
        .join(' ');
    case 'grammar': {
      const t = original
        .trim()
        .replace(/\s+([,.!?])/g, '$1')
        .replace(/\s{2,}/g, ' ');
      const c = t.charAt(0).toUpperCase() + t.slice(1);
      return /[.!?)\]]$/.test(c) ? c : `${c}.`;
    }
    case 'translate': {
      const lang = /Translate it into (.+?)\.$/m.exec(prompt)?.[1] ?? 'the chosen language';
      return `[Sample translation into ${lang}] ${original}`;
    }
    default:
      return `${original.trim()} (Sample rewrite — the real model follows your instruction.)`;
  }
}

/** Assistant stand-in: drafts or rewrites a section when asked, otherwise talks about the document. */
function sampleAssistant(prompt: string) {
  const request = /^Request:\s*([\s\S]+)$/m.exec(prompt)?.[1]?.trim() ?? '';
  const headings = /^Sections:\s*(.+)$/m.exec(prompt)?.[1]?.split(' · ') ?? [];
  const words = (/^Document:\n([\s\S]*?)\n\nRequest:/m.exec(prompt)?.[1] ?? '')
    .split(/\s+/)
    .filter(Boolean).length;
  const target = headings.find((h) => request.toLowerCase().includes(h.toLowerCase()));
  if (target && /\b(tighten|shorten|rewrite|improve|simplify)\b/i.test(request)) {
    return {
      reply: `I rewrote “${target}” to be shorter and clearer. Accept or reject it in the document.`,
      insert: {
        heading: target,
        markdown: `## ${target}\n\nThis is a shorter “${target}” from the stand-in model. With a provider key, it is rewritten from your text.`,
        after: null,
        replaces: target,
      },
    };
  }
  if (/\b(write|add|draft|create)\b/i.test(request)) {
    const named = /(?:an?|the)\s+(.+?)\s+section/i.exec(request)?.[1];
    const heading = named ? named.charAt(0).toUpperCase() + named.slice(1) : 'Next steps';
    return {
      reply: `I drafted a “${heading}” section. It’s shown in the document for you to add or discard.`,
      insert: {
        heading,
        markdown: `## ${heading}\n\nThis is a sample “${heading}” section from the stand-in model. With a provider key, it is written from your document and request.\n\n- [First point]\n- [Second point]\n- [Third point]`,
        after: null,
        replaces: null,
      },
    };
  }
  return {
    reply: [
      `This document has ${headings.length || 'no'} section${headings.length === 1 ? '' : 's'} and about ${words} words.`,
      headings.length ? `Sections: ${headings.join(', ')}.` : '',
      'This is a sample answer from the stand-in model; with a provider key, I answer from your document.',
    ]
      .filter(Boolean)
      .join(' '),
    insert: null,
  };
}

/** When asked to write a document section by section, write a sample paragraph under each heading. */
function sampleDocument(options: LanguageModelV4CallOptions): string | null {
  const text = lastUserText(options);
  if (!/^Write the document/m.test(text)) return null;
  const headings = [...text.matchAll(/^\d+\.\s+(.+?)(?:\s+—.*)?$/gm)].map((m) => m[1]!.trim());
  if (!headings.length) return null;
  return headings
    .map(
      (h) =>
        `## ${h}\n\nThis is sample text for “${h}” from the stand-in model. Once the provider key is added, this section is written from your brief, in the tone and length you chose.\n\nYou can edit any of this text, and the document is saved as you type.`,
    )
    .join('\n\n');
}

function allText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '),
    )
    .join('\n');
}

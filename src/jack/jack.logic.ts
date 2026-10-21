import { z } from 'zod';
import { DOC_TYPES } from '../database/schemas/document.schema.js';
import { JACK_TOOLS, type JackStep } from '../database/schemas/chat.schema.js';

export const MAX_STEPS = 3;
/** Room for MAX_STEPS steps at their longest (about 1,700 tokens), with headroom. */
export const PLAN_MAX_TOKENS = 3000;

/**
 * What Jack decides before answering: which of his tools to use. Every field is required (strict
 * structured output); fields that don't apply to a tool get a neutral value.
 */
export const jackPlanSchema = z.object({
  jackSteps: z
    .array(
      z.object({
        tool: z.enum(JACK_TOOLS),
        title: z.string().max(120),
        brief: z.string().max(2000),
        docType: z.enum(DOC_TYPES),
        count: z.number().int().min(1).max(4),
        to: z.string().max(200),
        when: z.string().max(40),
      }),
    )
    .max(MAX_STEPS),
});
export type JackPlan = z.infer<typeof jackPlanSchema>;

export interface ToolsAvailable {
  calendar: boolean;
  email: boolean;
  browser: boolean;
  drive: boolean;
  slack: boolean;
}

/** Which availability each tool needs. */
const NEEDS: Record<JackPlan['jackSteps'][number]['tool'], keyof ToolsAvailable | null> = {
  doc: null,
  image: null,
  calendar: 'calendar',
  email: 'email',
  browse: 'browser',
  send_email: 'email',
  add_event: 'calendar',
  drive: 'drive',
  slack: 'slack',
  send_slack: 'slack',
};

export const PLANNER_SYSTEM = (opts: { today: string; space: string; name?: string } & ToolsAvailable) =>
  [
    `You decide which tools ${opts.name ?? 'Jack'} uses for the latest message in Jack's AI. ${opts.name ?? 'Jack'} is the`,
    `person's assistant. This is the person's ${opts.space} space. Today is ${opts.today}.`,
    'Tools:',
    '- doc: write a document in AI Docs (proposal, report, plan, checklist, letter, meeting notes, article).',
    '  Only when the person asks for a document or a written deliverable to keep, not for a normal answer.',
    '- image: make images in AI Image (pictures, posters, logos, illustrations, social graphics).',
    opts.calendar
      ? '- calendar: read the person’s Google Calendar for the next 7 days, when the answer needs their schedule.'
      : '- calendar: not connected. Never use it.',
    opts.email
      ? '- email: read the person’s latest Gmail (last 7 days), when the answer needs their email.'
      : '- email: not connected. Never use it.',
    opts.browser
      ? `- browse: use ${opts.name ?? 'Jack'}’s own web browser to find, compare, book or buy something on a website. Paying always waits for the person’s OK.`
      : '- browse: not available. Never use it.',
    opts.email
      ? '- send_email: write an email from the person’s Gmail (to: the address; title: the subject; brief: the full text). Their Gmail setting decides whether it is a draft, waits for their OK, or is sent.'
      : '- send_email: Gmail not connected. Never use it.',
    opts.drive
      ? '- drive: search the person’s Google Drive and read the best matching files, when the answer needs their files (brief: the words to search for, e.g. "Q3 sales report"; empty brief for their latest files).'
      : '- drive: Google Drive not connected. Never use it.',
    opts.slack
      ? '- slack: read recent messages in the person’s Slack (to: a channel name without #, or "" for their channels).'
      : '- slack: Slack not connected. Never use it.',
    opts.slack
      ? '- send_slack: post a message in Slack as the person (to: the channel name without #; title: a short name; brief: the full message). Their Slack setting decides whether it waits for their OK.'
      : '- send_slack: Slack not connected. Never use it.',
    opts.calendar
      ? '- add_event: add an event to their Google Calendar (title; when: start as YYYY-MM-DDTHH:mm in their time; brief: details).'
      : '- add_event: Google Calendar not connected. Never use it.',
    'Most messages need no tool: then return an empty list. Use at most 3 steps and each tool at most once.',
    'For each step give: tool; title (a short name for the plan list); brief (doc: what the document must',
    'cover, with every detail the person gave; image: a detailed image prompt; browse:',
    ' the goal with every detail — dates, budget, site); docType (for a doc, else',
    '"other"); count (for images 1 to 4, else 1); to (send_email: the address; slack and send_slack: the',
    'channel name, or "" for slack; else ""); when (add_event, else "").',
  ]
    .filter(Boolean)
    .join('\n');

/** Tools that read and may run without a brief. */
const READS: string[] = ['calendar', 'email', 'drive', 'slack'];

/** The plan, cleaned: known tools only, once each, and only tools this space has. */
export function cleanPlan(plan: JackPlan, opts: ToolsAvailable): JackPlan['jackSteps'] {
  const seen = new Set<string>();
  return plan.jackSteps
    .filter((s) => s.title.trim() && (s.brief.trim() || READS.includes(s.tool)))
    .filter((s) => {
      const need = NEEDS[s.tool];
      return need ? opts[need] : true;
    })
    .filter((s) => !seen.has(s.tool) && !!seen.add(s.tool))
    .slice(0, MAX_STEPS);
}

/** Told to the answering model, so the answer says what was started and what happens next. */
/**
 * For the conversation history: what an earlier answer's tools did or found, as of now (a browser
 * search may have finished after the answer was written). Lets Jack answer "what did you find?".
 */
export function toolResultsNote(
  steps: { tool: string; title: string; status: string; detail: string; result?: string }[],
): string {
  if (!steps.length) return '';
  const lines = steps.map((s) => {
    const state =
      s.status === 'done'
        ? 'finished'
        : s.status === 'running'
          ? 'still working'
          : s.status === 'waiting'
            ? 'waiting for the person’s OK'
            : 'did not finish';
    const head = `- ${s.tool === 'browse' ? 'Your browser' : s.tool}: "${s.title}" (${state}): ${s.detail}`;
    return s.result ? `${head}\n  What it found:\n${s.result.replace(/^/gm, '  ')}` : head;
  });
  return `\n\n[Your tools for this answer, as of now:\n${lines.join('\n')}]`;
}

export function stepsContext(steps: JackStep[], reads: string[] = []): string {
  if (!steps.length) return '';
  const lines = steps.map((s) => {
    if (s.status === 'done') return `- ${s.title}: ${s.detail}.`;
    if (s.status === 'started') {
      if (s.tool === 'doc')
        return `- Started writing the document "${s.title}" in AI Docs (ready to edit in a minute).`;
      if (s.tool === 'image') return `- Started making images in AI Image: "${s.title}".`;
      return `- ${s.title}: ${s.detail}.`;
    }
    const what: Record<JackStep['tool'], string> = {
      doc: 'write the document',
      image: 'make the images',
      calendar: 'read the calendar',
      email: 'read email',
      browse: 'use the browser for',
      send_email: 'prepare the email',
      add_event: 'prepare the event',
      drive: 'search Google Drive for',
      slack: 'read Slack for',
      send_slack: 'prepare the Slack message',
    };
    return `- Could not ${what[s.tool]} "${s.title}": ${s.detail}`;
  });
  return [
    '',
    'Before this answer you used your tools. They keep working in the app and the person sees their',
    'progress next to your answer:',
    ...lines,
    ...(reads.length ? ['', 'What you read (answer from this; it is private to the person):', ...reads] : []),
    'In your answer, say briefly what you started and what happens next. Do not write out the whole',
    'document or describe images in detail, and do not make up links.',
    ...(steps.some((s) => s.tool === 'browse' && s.status === 'started')
      ? [
          'Your browser keeps working after this answer. What it finds appears under its card in this',
          'chat when it is done; you cannot send a message later, so say it will show up there and that',
          'the person can ask you about it. Do not guess what it will find.',
        ]
      : []),
  ].join('\n');
}

export const JACK_SYSTEM_PROMPT = (
  today: string,
  who: { name: string; custom: boolean } = { name: 'Jack', custom: false },
  space: 'personal' | 'business' = 'personal',
) =>
  [
    space === 'business'
      ? "You are Captain Jack, the business assistant in Jack's AI: you help run the person's business,"
      : who.custom
        ? `You are ${who.name}, the person's own assistant in Jack's AI. They named you ${who.name}: always call yourself ${who.name}. You help with everyday life,`
        : "You are Jack, the person's assistant in Jack's AI. People call you Jack of all trades: you help with everyday life,",
    'and you ask before anything important.',
    `Today is ${today}.`,
    'Answer clearly and directly. Use short paragraphs and Markdown lists or tables when they help.',
    'If you are not sure about a fact, say so instead of guessing.',
  ].join(' ');

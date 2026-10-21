import type { SpaceKind } from '../database/schemas/workspace.schema.js';

export interface Suggestion {
  icon: string;
  text: string;
}

/**
 * Starter ideas under "Jack suggests" until Jack has memory and connected apps to suggest from
 * (Days 2–3 of v2). Tapping one puts it in the message box; nothing runs on its own.
 */
export const STARTER_SUGGESTIONS: Record<SpaceKind, Suggestion[]> = {
  personal: [
    { icon: 'calendar', text: 'Plan my week and remind me what’s due' },
    { icon: 'mail', text: 'Help me reply to a tricky email' },
    { icon: 'utensils-crossed', text: 'Make this week’s meal plan and grocery list' },
  ],
  business: [
    { icon: 'mail', text: 'Draft friendly replies to my newest leads' },
    { icon: 'megaphone', text: 'Plan next week’s social media posts' },
    { icon: 'chart-column', text: 'Write this week’s update for the team' },
  ],
};

/** "3 images", "1 image". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const shorten = (text: string, max = 80) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

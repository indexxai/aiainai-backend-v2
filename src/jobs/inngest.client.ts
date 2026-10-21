import { Inngest } from 'inngest';

/**
 * One Inngest client for every background job (AI Crews agents, research, file reading,
 * image batches, schedules, emails). Dev: INNGEST_DEV=1 + the Inngest dev server.
 * Production: INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY.
 */
export const inngest = new Inngest({ id: 'aiainai' });

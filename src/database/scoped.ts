import { Types, type QueryFilter } from 'mongoose';

/**
 * Every query on workspace data goes through this, so a request can only ever touch its own
 * workspace's records, and soft-deleted records stay hidden unless asked for.
 */
export function scoped<T>(
  workspaceId: Types.ObjectId | string,
  filter: QueryFilter<T> = {},
  opts: { includeDeleted?: boolean } = {},
): QueryFilter<T> {
  const ws = typeof workspaceId === 'string' ? new Types.ObjectId(workspaceId) : workspaceId;
  if ('workspaceId' in (filter as object)) {
    throw new Error('Pass the workspace as the first argument to scoped(), not inside the filter');
  }
  return {
    ...filter,
    workspaceId: ws,
    ...(opts.includeDeleted ? {} : { deletedAt: null }),
  } as QueryFilter<T>;
}

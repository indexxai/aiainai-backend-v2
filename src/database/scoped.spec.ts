import { Types } from 'mongoose';
import { scoped } from './scoped.js';

describe('scoped', () => {
  const ws = new Types.ObjectId();

  it('always adds the workspace and hides deleted records', () => {
    expect(scoped(ws, { title: 'x' })).toEqual({ title: 'x', workspaceId: ws, deletedAt: null });
  });

  it('can include deleted records for restore screens', () => {
    expect(scoped(ws, {}, { includeDeleted: true })).toEqual({ workspaceId: ws });
  });

  it('refuses a workspace inside the filter (it could be overwritten by user input)', () => {
    expect(() => scoped(ws, { workspaceId: new Types.ObjectId() } as never)).toThrow();
  });
});

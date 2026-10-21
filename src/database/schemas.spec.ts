import { MODELS } from './data.module.js';
import { CreditAccountSchema, CreditEntrySchema } from '../credits/credit.schema.js';

/**
 * Building every schema catches decorator mistakes (e.g. a field whose type Mongoose can't
 * work out) before the app or a migration hits them at startup.
 */
describe('database schemas', () => {
  it('all build, with the expected key indexes', () => {
    expect(MODELS.length).toBeGreaterThan(10);
    for (const { schema } of MODELS) expect(schema.paths).toBeTruthy();
    const idx = CreditEntrySchema.indexes().map(([fields, opts]) => ({ fields, unique: !!opts?.unique }));
    expect(idx).toContainEqual({ fields: { workspaceId: 1, idempotencyKey: 1, bucket: 1 }, unique: true });
    expect(CreditAccountSchema.path('workspaceId').options.unique).toBe(true);
  });

  it('every workspace-owned collection requires a workspace', () => {
    const exempt = new Set(['Workspace', 'AiModel']);
    for (const { name, schema } of MODELS) {
      if (exempt.has(name)) continue;
      const ws = schema.paths.workspaceId as { isRequired?: boolean } | undefined;
      expect({ name, required: ws?.isRequired }).toEqual({ name, required: true });
    }
  });
});

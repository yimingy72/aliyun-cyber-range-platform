import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { resultOutputSchema } from '../src/tools/output-schemas';

describe('tool output envelopes', () => {
  const schema = resultOutputSchema(z.object({ id: z.string().min(1), state: z.literal('ready') }).strict());

  it('retains each tool success contract while accepting the existing platform error envelope', () => {
    expect(schema.safeParse({ result: { id: 'resource-1', state: 'ready' } }).success).toBe(true);
    for (const error of [
      { status: 404, message: 'Platform resource not found' },
      { statusCode: 400, message: ['cpu must be an integer'], error: 'Bad Request' },
      { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirmation-1', idempotencyKey: 'stable-key', summary: { targetName: 'range-1' } },
      { message: { code: 'CONFIRMATION_REQUIRED', confirmationId: 'confirmation-1', idempotencyKey: 'stable-key' } },
    ]) expect(schema.parse({ result: { error } })).toEqual({ result: { error } });
  });

  it('does not accept incomplete successes or mixed success/error results through the error branch', () => {
    for (const result of [{}, { id: 'resource-1' }, { id: 'resource-1', state: 'running' }, { error: { status: 400 }, id: 'resource-1' }, { error: undefined }]) {
      expect(schema.safeParse({ result }).success).toBe(false);
    }
    expect(schema.safeParse({}).success).toBe(false);
  });
});

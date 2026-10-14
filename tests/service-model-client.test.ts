import { test } from 'node:test';
import * as assert from 'node:assert';
import { buildProviderMessages, extractUsage } from '../src/service/model-client';

test('buildProviderMessages prepends system and maps history', () => {
  const messages = buildProviderMessages(' You are X. ', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'next' },
  ]);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0], { role: 'system', content: 'You are X.' });
  assert.deepEqual(messages[1], { role: 'user', content: 'hi' });
  assert.deepEqual(messages[2], { role: 'assistant', content: 'hello' });
  assert.deepEqual(messages[3], { role: 'user', content: 'next' });
});

test('buildProviderMessages skips empty system prompt', () => {
  const messages = buildProviderMessages('   ', [{ role: 'user', content: 'hi' }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
});

test('extractUsage maps token fields with defaults', () => {
  assert.deepEqual(extractUsage(undefined), { promptTokens: 0, completionTokens: 0 });
  assert.deepEqual(
    extractUsage({ content: 'x', usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 } }),
    { promptTokens: 3, completionTokens: 5 },
  );
});

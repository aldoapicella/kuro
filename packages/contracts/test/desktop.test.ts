import test from 'node:test';
import assert from 'node:assert/strict';
import { AppCommands, AppOutputSchemas, DesktopCommands, DesktopOutputSchemas } from '../src/index.js';

test('every AppPort command has a strict reply validator', () => {
  assert.deepEqual(Object.keys(AppOutputSchemas).sort(), Object.keys(AppCommands).sort());
  assert.equal(AppOutputSchemas.approveDraft.safeParse({ responseId: 'a'.repeat(32), path: '/private' }).success, false);
});
test('desktop OS actions accept no arbitrary path, actor, or channel', () => {
  for (const key of ['selectText', 'selectPairing', 'getInfo'] as const) {
    assert.equal(DesktopCommands[key].safeParse({ path: '/etc/passwd' }).success, false);
    assert.equal(DesktopCommands[key].safeParse({}).success, true);
  }
  assert.equal(DesktopCommands.setScenario.safeParse({ scenario: 'real' }).success, false);
  assert.equal(DesktopOutputSchemas.selectText.safeParse({ selectionId: 'a'.repeat(32), displayName: 'example.txt', localPath: '/private/example.txt' }).success, false);
});

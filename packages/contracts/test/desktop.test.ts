import test from 'node:test';
import assert from 'node:assert/strict';
import { AppCommands, AppOutputSchemas, DesktopCommands, DesktopOutputSchemas, DesktopNetworkSchema } from '../src/index.js';

test('every AppPort command has a strict reply validator', () => {
  assert.deepEqual(Object.keys(AppOutputSchemas).sort(), Object.keys(AppCommands).sort());
  assert.equal(AppOutputSchemas.approveDraft.safeParse({ responseId: 'a'.repeat(32), path: '/private' }).success, false);
});
test('setup accepts bounded network settings and named model preparation only', () => {
  assert.deepEqual(Object.keys(DesktopCommands).sort(), Object.keys(DesktopOutputSchemas).sort());
  const network = { bootstrap: [{ host: '192.168.1.20', port: 49737 }], localPort: null, bootstrapPort: null };
  assert.equal(DesktopNetworkSchema.safeParse(network).success, true);
  for (const host of ['https://example.com', 'localhost/path', '', 'a'.repeat(254)]) {
    assert.equal(DesktopNetworkSchema.safeParse({ ...network, bootstrap: [{ host, port: 49737 }] }).success, false);
  }
  assert.equal(DesktopCommands.prepareModel.safeParse({ kind: 'summary' }).success, true);
  assert.equal(DesktopCommands.prepareModel.safeParse({ kind: 'summary', url: 'https://example.com/model' }).success, false);
  assert.equal(DesktopCommands.saveProfile.safeParse({ displayName: 'Owner', network, memberId: 'a'.repeat(32) }).success, false);
  assert.equal(DesktopCommands.exportInvitation.safeParse({ spaceId: 'a'.repeat(32), authorityKey: 'b'.repeat(64) }).success, false);
});
test('desktop OS actions accept no arbitrary path, actor, or channel', () => {
  for (const key of ['selectText', 'selectPairing', 'getInfo'] as const) {
    assert.equal(DesktopCommands[key].safeParse({ path: '/etc/passwd' }).success, false);
    assert.equal(DesktopCommands[key].safeParse({}).success, true);
  }
  assert.equal(DesktopCommands.setScenario.safeParse({ scenario: 'real' }).success, false);
  assert.equal(DesktopOutputSchemas.selectText.safeParse({ selectionId: 'a'.repeat(32), displayName: 'example.txt', localPath: '/private/example.txt' }).success, false);
});

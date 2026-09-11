import assert from 'node:assert/strict';
import { heartbeat, close } from '@qvac/sdk';

// Exercise the installed Bare executable and SDK worker without loading models.
// Scripted adapter tests cannot catch missing platform assets in a fresh install.
try {
  assert.equal((await heartbeat()).type, 'heartbeat');
  console.log('QVAC worker heartbeat passed (no model inference).');
} finally {
  await close();
}

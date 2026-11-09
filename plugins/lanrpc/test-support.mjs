import { randomUUID } from 'node:crypto';
import { ArtifactStore } from './artifacts.mjs';
import { RequestController } from './controller.mjs';

export async function transportController(t, root, sessionId = 'transport-test') {
  const instanceId = randomUUID();
  const artifactStore = new ArtifactStore({ root, cwd: root, instanceId });
  await artifactStore.init();
  const controller = new RequestController({
    sessionId, cwd: root, instanceId, artifactStore,
    isIdle: () => true,
    hasPendingMessages: () => false,
    execute: async () => { throw new Error('Transport-only test unexpectedly dispatched inference'); },
  });
  t.after(() => controller.close());
  return controller;
}

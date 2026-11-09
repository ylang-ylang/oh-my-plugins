export async function createHostAdapter(pi, context = {}) {
  if (!pi || typeof pi !== 'object') throw new TypeError('Host extension API must be an object');
  if (typeof pi.pi?.AgentRegistry?.global === 'function') {
    const { createOmpHostAdapter } = await import('./omp.mjs');
    return createOmpHostAdapter(pi, context);
  }
  const { createPiHostAdapter } = await import('./pi.mjs');
  return createPiHostAdapter(pi, context);
}

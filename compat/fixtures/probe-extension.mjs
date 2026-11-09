const KEY = Symbol.for('oh-my-plugins.compat.probe');

export default function compatProbe(api) {
  const state = globalThis[KEY] ??= {
    api,
    factoryCalls: 0,
    events: [],
    contexts: [],
    toolCalls: [],
  };
  state.api = api;
  state.factoryCalls += 1;

  for (const type of ['session_start', 'session_shutdown', 'before_agent_start', 'context', 'input']) {
    api.on(type, (event, ctx) => {
      state.events.push({ type, eventType: event?.type, source: event?.source });
      if (ctx) {
        state.contexts.push({
          type,
          ctx,
          hasUI: ctx.hasUI,
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager?.getSessionId?.(),
        });
      }
    });
  }

  api.registerCommand('compat_probe', {
    description: 'Compatibility fixture command',
    handler: async (_args, ctx) => {
      state.events.push({ type: 'command', hasUI: ctx.hasUI });
    },
  });

  api.registerTool({
    name: 'compat_echo',
    label: 'Compatibility echo',
    description: 'Echo a value through the real harness extension tool registry.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      state.toolCalls.push({ toolCallId, params, hasSignal: Boolean(signal), hasUpdate: typeof onUpdate === 'function', hasContext: Boolean(ctx) });
      if (params.value === 'wait-for-abort') {
        await new Promise((resolve, reject) => {
          const abort = () => reject(signal?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return { content: [{ type: 'text', text: params.value }], details: { echoed: params.value } };
    },
  });
}

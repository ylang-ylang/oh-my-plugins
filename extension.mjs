import { RequestController } from './controller.mjs';
import { startServer } from './server.mjs';

// Installed user-scope plugins load automatically for normal `omp` launches.
// This is a message-only API to the existing session, not native stdio RPC and
// not a sandbox. A token grants the same agent/tool trust as local prompting.
export default function lanRpc(pi) {
  let controller;
  let server;
  let timer;
  let timerContext;
  let serial = Promise.resolve();

  function report(ctx, error) {
    ctx.ui.notify(`LAN RPC: ${error.message || error}`, 'error');
  }

  async function stop() {
    if (timer) timerContext.clearTimer(timer);
    timer = undefined;
    controller?.close();
    controller = undefined;
    const previous = server;
    server = undefined;
    await previous?.close();
  }

  async function start(ctx) {
    await stop();
    const current = new RequestController({
      sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
      isIdle: () => ctx.isIdle(), hasPendingMessages: () => ctx.hasPendingMessages(),
      deliver: message => pi.sendMessage(message, { deliverAs: 'followUp', triggerTurn: true }),
    });
    controller = current;
    try {
      server = await startServer({
        getSession: () => current.session(),
        submit: request => {
          // SessionManager is live: even before the committed switch hook runs,
          // never enqueue a message into a different session than this endpoint.
          if (ctx.sessionManager.getSessionId() !== current.sessionId) {
            throw Object.assign(new Error('Session changed'), { status: 409, code: 'generation_mismatch' });
          }
          return current.submit(request);
        },
        getRequest: request => current.get(request),
        onError: error => report(ctx, error),
      });
      timerContext = ctx;
      timer = ctx.setInterval(() => current.tick(), 100);
      ctx.ui.setStatus('lan-rpc', `LAN RPC ${server.endpoint}`);
    } catch (error) {
      current.close('Endpoint startup failed');
      controller = undefined;
      report(ctx, error);
    }
  }

  // Lifecycle callbacks can overlap (reload/shutdown/switch). One ordered chain
  // owns publication; no stale server can reappear after a later stop.
  function schedule(action) {
    serial = serial.then(action, action);
    return serial;
  }

  pi.on('session_start', (_event, ctx) => {
    // Headless task/print sessions must not unexpectedly publish listeners.
    if (ctx.hasUI) return schedule(() => start(ctx));
  });
  for (const event of ['session_switch', 'session_branch', 'session_tree']) {
    pi.on(event, (_event, ctx) => {
      if (ctx.hasUI) return schedule(() => start(ctx));
    });
  }
  for (const event of ['session_before_switch', 'session_before_branch', 'session_before_tree']) {
    pi.on(event, async (_event, ctx) => {
      if (controller?.hasWork()) {
        ctx.ui.notify('LAN RPC has pending requests. Finish them or /lan-rpc stop before switching sessions.', 'warning');
        return { cancel: true };
      }
      // If another extension cancels the switch, this deliberately stays closed;
      // /lan-rpc start restores it. Safety beats publishing a provisional session.
      await schedule(stop);
      ctx.ui.setStatus('lan-rpc', undefined);
    });
  }
  pi.on('session_shutdown', (_event, ctx) => schedule(async () => {
    await stop();
    ctx.ui.setStatus('lan-rpc', undefined);
  }));
  pi.on('message_start', event => controller?.observe(event.message));
  pi.on('message_end', event => {
    controller?.observe(event.message);
    controller?.assistant(event.message);
  });
  pi.on('agent_end', event => controller?.end(event));

  pi.registerCommand('lan-rpc', {
    description: 'LAN session access: status | start | stop | restart (token rotates on restart)',
    handler: async (args, ctx) => {
      const command = args.trim() || 'status';
      if (command === 'status') {
        ctx.ui.notify(server ? `${server.endpoint} instance=${server.instanceId} ${JSON.stringify(controller.session())}` : 'LAN RPC stopped', 'info');
      } else if (command === 'stop') {
        await schedule(stop);
        ctx.ui.setStatus('lan-rpc', undefined);
        ctx.ui.notify('LAN RPC stopped; active agent work is not aborted', 'info');
      } else if (command === 'start' || command === 'restart') {
        if (controller?.hasWork()) {
          ctx.ui.notify('Finish pending requests or /lan-rpc stop explicitly before restart', 'warning');
          return;
        }
        await schedule(() => start(ctx));
      } else {
        ctx.ui.notify('Usage: /lan-rpc [status|start|stop|restart]', 'error');
      }
    },
  });
}

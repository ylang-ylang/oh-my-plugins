import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { RequestController } from '../controller.mjs';
import { isLoopbackHost, readConfig, rootDir, writeConfig } from '../config.mjs';
import { startServer } from '../server.mjs';
import { StatusIndicator } from '../status.mjs';
import { ArtifactStore } from '../artifacts.mjs';
import { OperationsLog } from '../operations.mjs';
import { prepareTls } from '../tls.mjs';
import { createRequestExecutor } from './execution.mjs';
import { createHostAdapter } from './adapters/index.mjs';

// HTTPS token holders, or anyone reaching HTTP, can drive the agent and its tools.
export default async function lanRpc(pi) {
  const adapter = await createHostAdapter(pi);
  const adaptContext = ctx => ctx && adapter.adaptContext ? adapter.adaptContext(ctx) : ctx;
  const operations = new OperationsLog(rootDir());
  const indicator = new StatusIndicator({
    statusMode: adapter.capabilities.statusMode ?? 'native',
    loadSettings: () => adapter.loadSettings(),
    hasUI: ctx => (adapter.capabilities.statusMode === 'extension' || adapter.capabilities.features.statusSettings) && ctx.hasUI,
    setStatus: (ctx, key, value) => ctx.ui.setStatus(key, value),
  });
  let controller;
  let executor;
  let server;
  let timer;
  let timerContext;
  let changing = false;
  let serial = Promise.resolve();

  function report(ctx, error) {
    ctx.ui.notify(`LAN RPC: ${error.message || error}`, 'error');
  }

  function operationFields(ctx, current = controller) {
    return {
      sessionId: ctx?.sessionManager?.getSessionId?.() ?? current?.sessionId,
      instanceId: current?.instanceId,
      generation: current?.generation,
    };
  }

  function log(event, ctx, fields = {}) {
    operations.emit(event, { ...operationFields(ctx), ...fields });
  }

  function mode() {
    if (!server) return 'off';
    if (controller?.closed) return 'error';
    const host = new URL(server.endpoint).hostname.replace(/^\[|\]$/g, '');
    return isLoopbackHost(host) ? 'local' : 'lan';
  }

  async function stop(ctx, code = 'endpoint_closed', message, trigger = 'listener_stop') {
    if (timer) timerContext.clearTimer(timer);
    timer = undefined;
    timerContext = undefined;

    const previousController = controller;
    const previousExecutor = executor;
    const previousServer = server;
    if (previousController || previousServer || previousExecutor) {
      log('host.listener.stop_requested', ctx, {
        sessionId: previousController?.sessionId,
        instanceId: previousController?.instanceId,
        generation: previousController?.generation,
        state: 'stopping',
        reason: trigger,
      });
    }
    controller = undefined;
    executor = undefined;
    server = undefined;
    // close() fences RPC work synchronously; native conversation cleanup owns
    // only its temporary tools and never disposes the selected session.
    const controllerClosing = previousController?.close(code, message);
    const closing = [previousServer?.close(), controllerClosing, previousExecutor?.drainTools()].filter(Boolean);
    const outcomes = await Promise.allSettled(closing);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    const closeError = rejected?.reason;
    indicator.set(ctx, 'off');
    if (previousController || previousServer || previousExecutor) {
      log('host.listener.stopped', ctx, {
        sessionId: previousController?.sessionId,
        instanceId: previousController?.instanceId,
        generation: previousController?.generation,
        state: closeError ? 'failed' : 'stopped',
        reason: trigger,
        errorCode: closeError?.code,
        errorType: closeError?.name,
      });
    }
    if (closeError) throw closeError;
  }

  async function start(ctx, trigger = 'listener_start') {
    await indicator.activate(ctx);
    log('host.listener.start_requested', ctx, { state: 'starting', reason: trigger });
    await stop(ctx, 'endpoint_closed', undefined, trigger);
    const instanceId = randomUUID();
    log('host.instance.created', ctx, { instanceId, state: 'created', reason: trigger });
    const artifactStore = new ArtifactStore({ root: rootDir(), instanceId, cwd: ctx.cwd });
    let current;
    try {
      await artifactStore.init();
      executor = createRequestExecutor(adapter, ctx, operations);
      current = new RequestController({
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        isIdle: () => ctx.isIdle(),
        hasPendingMessages: () => ctx.hasPendingMessages(),
        execute: executor.execute,
        artifactStore,
        instanceId,
        reservedToolNames: executor.reservedToolNames,
        supported: executor.supported,
        operations,
      });
      controller = current;
      server = await startServer({ controller: current, operations, onError: error => report(ctx, error) });
      timerContext = ctx;
      timer = ctx.setInterval(() => {
        if (!changing) current.tick();
        if (current.closed) indicator.set(ctx, 'error');
      }, 100);
      indicator.set(ctx, mode());
      log('host.listener.ready', ctx, {
        instanceId: current.instanceId,
        generation: current.generation,
        state: 'listening',
        reason: trigger,
      });
    } catch (error) {
      log('host.listener.start_failed', ctx, {
        instanceId: current?.instanceId ?? instanceId,
        generation: current?.generation,
        state: 'failed',
        reason: trigger,
        errorCode: error?.code,
        errorType: error?.name,
      });
      if (timer) timerContext.clearTimer(timer);
      timer = undefined;
      timerContext = undefined;
      const failed = server;
      server = undefined;
      if (controller === current) controller = undefined;
      await failed?.close().catch(() => {});
      if (current) await current.close('endpoint_closed', 'Endpoint startup failed').catch(() => {});
      else await artifactStore.close().catch(() => {});
      await executor?.drainTools().catch(() => {});
      executor = undefined;
      indicator.set(ctx, 'error');
      throw error;
    }
  }

  // One ordered chain owns listener replacement. HTTPS authentication rotates
  // on restart; pending work must be completed or explicitly stopped first.
  function schedule(action) {
    serial = serial.then(action, action);
    return serial;
  }

  function requireNoWork() {
    if (controller?.hasWork()) {
      throw new Error('Requests are still pending. Wait for completion or explicitly stop access with /lanrpc stop.');
    }
  }

  async function activate(ctx, trigger) {
    if (!ctx?.hasUI) return;
    executor?.reconcileContext(ctx);
    await schedule(async () => {
      if (controller && !controller.closed &&
          controller.sessionId === ctx.sessionManager.getSessionId() && controller.cwd === ctx.cwd) {
        await indicator.activate(ctx);
        indicator.set(ctx, mode());
        log('host.listener.preserved', ctx, { state: 'listening', reason: trigger });
        return;
      }
      await start(ctx, trigger);
    }).catch(error => report(ctx, error));
  }

  function activateFrom(event, ctx) {
    ctx = adaptContext(ctx);
    log('host.event.triggered', ctx, { operation: event, state: 'received', reason: event });
    return activate(ctx, event);
  }

  pi.on('session_start', (_event, ctx) => activateFrom('session_start', ctx));
  for (const event of ['session_switch', 'session_branch', 'session_tree', 'session_compact']) {
    pi.on(event, (_payload, ctx) => activateFrom(event, ctx));
  }
  for (const event of [
    'session_before_switch', 'session_before_branch', 'session_before_fork',
    'session_before_tree', 'session_before_compact',
  ]) {
    pi.on(event, (_payload, ctx) => {
      ctx = adaptContext(ctx);
      log('host.event.triggered', ctx, { operation: event, state: 'received', reason: event });
    });
  }
  pi.on('session_shutdown', (_event, ctx) => {
    ctx = adaptContext(ctx);
    log('host.event.triggered', ctx, {
      operation: 'session_shutdown',
      state: 'received',
      reason: 'session_shutdown',
    });
    return schedule(async () => {
      try { await stop(ctx, 'endpoint_closed', undefined, 'session_shutdown'); }
      finally { await indicator.dispose(ctx); }
    });
  });
  pi.on('input', (event, ctx) => {
    ctx = adaptContext(ctx);
    if (event.source !== 'interactive') return;
    log('host.event.triggered', ctx, {
      operation: 'interactive_input',
      state: 'received',
      reason: 'interactive_input',
    });
  });
  pi.on('context', (event, ctx) => executor?.context(event, adaptContext(ctx)));
  pi.on('before_agent_start', async (_event, ctx) => {
    adaptContext(ctx);
    // Only registry removal is awaited here, never the prior RPC prompt. The
    // native scheduler can then deliver user steering with its ordinary tools.
    await executor?.drainTools();
  });


  async function configureLan(ctx, config, configure) {
    let next = { ...config, lanEnabled: true };
    if (configure || isLoopbackHost(config.host)) {
      const address = Object.values(networkInterfaces()).flat()
        .find(item => item && !item.internal && item.family === 'IPv4')?.address;
      const suggested = isLoopbackHost(config.host) ? (address || '') : config.host;
      const hostInput = await ctx.ui.input(`LAN bind IP${suggested ? ` (leave blank for ${suggested})` : ''}`, suggested);
      if (hostInput === undefined) return;
      const host = hostInput.trim() || suggested;
      if (!isIP(host) || isLoopbackHost(host) || host === '0.0.0.0' || host === '::') {
        throw new Error('Enter a specific non-loopback IP address on this machine, not a wildcard address.');
      }
      const portInput = await ctx.ui.input(`Port (leave blank for ${config.port}; 0 selects a free port)`, String(config.port));
      if (portInput === undefined) return;
      const portText = portInput.trim() || String(config.port);
      if (!/^\d+$/.test(portText) || Number(portText) > 65535) throw new Error('Port must be an integer from 0 to 65535.');
      next = { ...next, host, port: Number(portText) };
    }
    const protocol = await ctx.ui.select('LAN protocol', ['HTTPS (recommended)', 'HTTP (unencrypted, NO authentication)']);
    if (!protocol) return;
    next.protocol = protocol === 'HTTP (unencrypted, NO authentication)' ? 'http' : 'https';
    return next;
  }


  async function changeLan(ctx, enabled, configure = false, trigger = 'configuration_change') {
    requireNoWork();
    const previous = await readConfig();
    let next = { ...previous, lanEnabled: enabled };
    if (enabled) {
      next = await configureLan(ctx, next, configure);
      if (!next) return;
      const encrypted = next.protocol === 'https';
      const warning = encrypted
        ? 'HTTPS requires a session token and verified TLS. A self-signed certificate is generated automatically unless custom TLS paths are saved. Token holders can use this agent\'s tools.'
        : 'HTTP is unencrypted with NO authentication. Anyone who can reach this port can control this agent and its tools. Messages and responses can be read or altered on the network.';
      if (!(await ctx.ui.confirm(encrypted ? 'Enable LAN access?' : 'Enable HTTP with NO authentication?',
        `Listen on ${next.host}:${next.port || 'automatic port'}. ${warning} These settings also apply to future sessions.`))) return;
      // Validate or generate TLS only after consent, before changing saved settings.
      if (encrypted) await prepareTls(next);
    }
    // Prompts can remain open while requests arrive: re-check before freezing
    // admission and changing the configuration. No work is silently discarded.
    requireNoWork();
    changing = true;
    let written = false;
    const wasRunning = Boolean(server);
    try {
      await writeConfig(next);
      written = true;
      await start(ctx, trigger);
      ctx.ui.notify(enabled ? 'LAN access enabled. Use /lanrpc info for connection details.' : 'LAN access disabled. Local access remains available; the LAN IP and TLS paths are saved.', 'info');
    } catch (error) {
      if (written) {
        try {
          await writeConfig(previous);
          if (wasRunning) await start(ctx, 'configuration_recovery');
          else await stop(ctx, 'endpoint_closed', undefined, 'configuration_recovery');
        } catch (restoreError) {
          throw new Error(`Configuration failed: ${error.message}; recovery failed: ${restoreError.message}. Check the current state with /lanrpc info.`);
        }
      }
      throw error;
    } finally {
      changing = false;
    }
  }

  async function showInfo(ctx) {
    if (!server) {
      ctx.ui.notify('LAN RPC is stopped. Use /lanrpc start to start access, or /lanrpc on to enable LAN access.', 'info');
      return;
    }
    if (!ctx.hasUI) throw new Error('Connection details require an interactive OMP terminal.');
    const current = server;
    const encrypted = new URL(current.endpoint).protocol === 'https:';
    const session = controller.session();
    await ctx.ui.custom((tui, _theme, _keys, done) => {
      let active = true;
      let copied = false;
      let text;
      const content = () => [
        'LAN RPC — Connection details', '', current.endpoint,
        `Session: ${session.sessionId}`,
        `Busy: ${session.busy} | Queue: ${session.queueDepth}`,
        `Working directory: ${JSON.stringify(session.cwd)}`, '',
        ...(encrypted ? [
          'HTTPS — encrypted; Bearer token authentication required',
          `Certificate: ${current.certFile}`,
          'Trust this certificate via --ca (transfer it securely), or use your trust store.',
          `Token file: ${current.tokenFile}`, '', 'Token:', current.token, '',
          'c — Copy token',
          ...(copied ? ['Token sent to terminal clipboard (OSC 52). Terminal permission/support is required.'] : []),
        ] : [
          'HTTP — unencrypted; NO authentication',
          'Anyone who can reach this port can control this agent and its tools.',
          'Authentication: none. No token or credential file.',
          'Non-loopback clients must explicitly pass --allow-http.',
        ]), '', 'Esc / Enter — Close',
      ].join('\n');
      return {
        render(width) {
          text ??= new adapter.Text(content(), 1, 1);
          return text.render(width);
        },
        invalidate() { text = undefined; },
        handleInput(data) {
          if (!active) return;
          if (adapter.matchesKey(data, 'escape') || adapter.matchesKey(data, 'enter')) {
            active = false;
            done();
          } else if (encrypted && adapter.matchesKey(data, 'c')) {
            // Use the public TUI terminal writer, not stdout or a remote host's
            // desktop clipboard. OSC 52 reaches the SSH client's terminal.
            tui.terminal.write(`\x1b]52;c;${Buffer.from(current.token).toString('base64')}\x07`);
            copied = true;
            text = undefined;
            tui.requestRender();
          }
        },
        dispose() { active = false; text = undefined; },
      };
    }, { overlay: true });
  }

  pi.registerCommand('lanrpc', {
    description: 'LAN RPC controls: menu | info | on | off | configure | start | stop | restart',
    handler: async (args, ctx) => {
      ctx = adaptContext(ctx);
      let command = args.trim();
      if (!command) {
        const choices = [
          mode() === 'lan' ? 'Disable LAN access (keep local access)' : 'Enable LAN access',
          'Configure and enable LAN', 'Connection details',
          server ? 'Stop all access' : 'Start access (use saved settings)',
          'Back',
        ];
        const choice = await ctx.ui.select('LAN RPC', choices);
        if (!choice || choice === 'Back') return;
        command = ({
          'Disable LAN access (keep local access)': 'off', 'Enable LAN access': 'on',
          'Configure and enable LAN': 'configure', 'Connection details': 'info',
          'Stop all access': 'stop', 'Start access (use saved settings)': 'start',
        })[choice];
      }
      try {
        if (command === 'info') await showInfo(ctx);
        else if (['on', 'off', 'configure'].includes(command)) {
          await schedule(() => changeLan(ctx, command !== 'off', command === 'configure', `command_${command}`));
        } else if (command === 'stop') {
          await schedule(() => stop(ctx, 'endpoint_closed', undefined, 'command_stop'));
          ctx.ui.notify('All access stopped. Agent work already started is not rolled back.', 'info');
        } else if (command === 'start' || command === 'restart') {
          await schedule(async () => {
            requireNoWork();
            await start(ctx, `command_${command}`);
          });
        } else {
          ctx.ui.notify('Usage: /lanrpc [info|on|off|configure|start|stop|restart]', 'error');
        }
      } catch (error) {
        report(ctx, error);
      }
    },
  });
  await indicator.prepareAtLoad();
}

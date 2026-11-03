import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { homedir, networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { createSecureContext } from 'node:tls';
import { RequestController } from './controller.mjs';
import { isLoopbackHost, readConfig, writeConfig } from './config.mjs';
import { startServer } from './server.mjs';
import { StatusIndicator } from './status.mjs';

// Token holders can drive the existing agent and its tools. This is not a sandbox.
export default function lanRpc(pi) {
  const indicator = new StatusIndicator(pi);
  let controller;
  let server;
  let timer;
  let timerContext;
  let changing = false;
  let serial = Promise.resolve();

  function report(ctx, error) {
    ctx.ui.notify(`LAN RPC: ${error.message || error}`, 'error');
  }

  function mode() {
    if (!server) return 'off';
    if (controller?.closed) return 'error';
    const host = new URL(server.endpoint).hostname.replace(/^\[|\]$/g, '');
    return isLoopbackHost(host) ? 'local' : 'lan';
  }

  async function stop(ctx) {
    if (timer) timerContext.clearTimer(timer);
    timer = undefined;
    controller?.close();
    controller = undefined;
    const previous = server;
    server = undefined;
    await previous?.close();
    indicator.set(ctx, 'off');
  }

  async function start(ctx) {
    await indicator.activate(ctx);
    await stop(ctx);
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
          if (changing) {
            throw Object.assign(new Error('Listener configuration is changing'), { status: 503, code: 'reconfiguring' });
          }
          if (ctx.sessionManager.getSessionId() !== current.sessionId) {
            throw Object.assign(new Error('Session changed'), { status: 409, code: 'generation_mismatch' });
          }
          return current.submit(request);
        },
        getRequest: request => current.get(request),
        onError: error => report(ctx, error),
      });
      timerContext = ctx;
      timer = ctx.setInterval(() => {
        if (!changing) current.tick();
        if (current.closed) indicator.set(ctx, 'error');
      }, 100);
      indicator.set(ctx, mode());
    } catch (error) {
      if (timer) timerContext.clearTimer(timer);
      timer = undefined;
      current.close('Endpoint startup failed');
      controller = undefined;
      const failed = server;
      server = undefined;
      await failed?.close();
      indicator.set(ctx, 'error');
      throw error;
    }
  }

  // One ordered chain owns listener replacement. Authentication rotates on every
  // restart; pending work must be completed or explicitly stopped first.
  function schedule(action) {
    serial = serial.then(action, action);
    return serial;
  }

  function requireNoWork() {
    if (controller?.hasWork()) {
      throw new Error('Requests are still pending. Wait for completion or explicitly stop access with /lanrpc stop.');
    }
  }

  async function activate(ctx) {
    if (!ctx.hasUI) return;
    await schedule(async () => {
      await start(ctx);
    }).catch(error => report(ctx, error));
  }

  pi.on('session_start', (_event, ctx) => activate(ctx));
  for (const event of ['session_switch', 'session_branch', 'session_tree']) {
    pi.on(event, (_event, ctx) => activate(ctx));
  }
  for (const event of ['session_before_switch', 'session_before_branch', 'session_before_tree']) {
    pi.on(event, async (_event, ctx) => {
      if (controller?.hasWork()) {
        ctx.ui.notify('LAN RPC has pending requests. Wait for completion or use /lanrpc stop before switching sessions.', 'warning');
        return { cancel: true };
      }
      // The native bar belongs to the TUI process, not to an individual chat.
      // Keep its prepared layout while rotating the session-owned listener.
      await schedule(() => stop(ctx));
    });
  }
  pi.on('session_shutdown', (_event, ctx) => schedule(async () => {
    try { await stop(ctx); }
    finally { await indicator.dispose(ctx); }
  }));
  pi.on('message_start', event => controller?.observe(event.message));
  pi.on('message_end', event => {
    controller?.observe(event.message);
    controller?.assistant(event.message);
  });
  pi.on('agent_end', event => controller?.end(event));

  function expandPath(value) {
    return resolve(value.startsWith('~/') ? `${homedir()}/${value.slice(2)}` : value);
  }

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
    const protocol = await ctx.ui.select('LAN protocol', ['HTTPS (recommended)', 'HTTP (unencrypted)']);
    if (!protocol) return;
    next.protocol = protocol === 'HTTP (unencrypted)' ? 'http' : 'https';
    if (next.protocol === 'https' && (configure || !next.tlsCert || !next.tlsKey)) {
      const certInput = await ctx.ui.input('TLS certificate path (leave blank to keep the saved path)', config.tlsCert || '');
      if (certInput === undefined) return;
      const keyInput = await ctx.ui.input('TLS private key FILE path, not key contents (leave blank to keep the saved path)', config.tlsKey || '');
      if (keyInput === undefined) return;
      const cert = certInput.trim() || config.tlsCert;
      const key = keyInput.trim() || config.tlsKey;
      if (!cert || !key) throw new Error('A TLS certificate and private key file are required for HTTPS.');
      next.tlsCert = expandPath(cert);
      next.tlsKey = expandPath(key);
    }
    return next;
  }

  async function validateTls(config) {
    const [cert, key] = await Promise.all([readFile(config.tlsCert), readFile(config.tlsKey)]);
    createSecureContext({ cert, key });
    if (!new X509Certificate(cert).checkIP(config.host)) {
      throw new Error('The TLS certificate IP SAN does not match the bind IP. Use a certificate valid for that IP.');
    }
  }

  async function changeLan(ctx, enabled, configure = false) {
    requireNoWork();
    const previous = await readConfig();
    let next = { ...previous, lanEnabled: enabled };
    if (enabled) {
      next = await configureLan(ctx, next, configure);
      if (!next) return;
      // HTTP deliberately ignores saved TLS files; HTTPS validates before mutation.
      if (next.protocol === 'https') await validateTls(next);
      const encrypted = next.protocol === 'https';
      const warning = encrypted
        ? 'Use HTTPS and a session token. Token holders can use this agent\'s tools.'
        : 'Bearer tokens, messages, and responses will travel in plaintext. Anyone who can observe or alter this network traffic may steal the token and control this agent\'s tools.';
      if (!(await ctx.ui.confirm(encrypted ? 'Enable LAN access?' : 'Enable unencrypted HTTP LAN access?',
        `Listen on ${next.host}:${next.port || 'automatic port'}. ${warning} These settings also apply to future sessions.`))) return;
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
      await start(ctx);
      ctx.ui.notify(enabled ? 'LAN access enabled. Use /lanrpc info for connection details.' : 'LAN access disabled. Local access remains available; the LAN IP and TLS paths are saved.', 'info');
    } catch (error) {
      if (written) {
        try {
          await writeConfig(previous);
          if (wasRunning) await start(ctx);
          else await stop(ctx);
        } catch (restoreError) {
          throw new Error(`Configuration failed: ${error.message}; recovery failed: ${restoreError.message}. Check the current state with /lanrpc info.`);
        }
      }
      throw error;
    } finally {
      changing = false;
    }
  }

  function showInfo(ctx) {
    const labels = { off: 'Stopped', local: 'Local only', lan: 'LAN enabled', error: 'Error / paused' };
    ctx.ui.notify(server
      ? `${labels[mode()]}\n${server.endpoint}\ninstance=${server.instanceId}\n${JSON.stringify(controller.session())}\nToken contents are hidden; use the private instance file to retrieve the token.`
      : 'LAN RPC is stopped. Use /lanrpc start to start access, or /lanrpc on to enable LAN access.', 'info');
  }

  pi.registerCommand('lanrpc', {
    description: 'LAN RPC controls: menu | info | on | off | configure | start | stop | restart',
    handler: async (args, ctx) => {
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
        if (command === 'info') showInfo(ctx);
        else if (['on', 'off', 'configure'].includes(command)) {
          await schedule(() => changeLan(ctx, command !== 'off', command === 'configure'));
        } else if (command === 'stop') {
          await schedule(() => stop(ctx));
          ctx.ui.notify('All access stopped. Agent work already started is not rolled back.', 'info');
        } else if (command === 'start' || command === 'restart') {
          await schedule(async () => {
            requireNoWork();
            await start(ctx);
          });
        } else {
          ctx.ui.notify('Usage: /lanrpc [info|on|off|configure|start|stop|restart]', 'error');
        }
      } catch (error) {
        report(ctx, error);
      }
    },
  });
  indicator.prepareAtLoad();
}

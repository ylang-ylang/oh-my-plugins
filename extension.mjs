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
      throw new Error('仍有待处理请求；请等待完成，或先用 /lan stop 明确停止接入。');
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
        ctx.ui.notify('LAN RPC 有待处理请求。请等待完成，或 /lan stop 后再切换会话。', 'warning');
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

  async function configureLan(ctx, config) {
    const address = Object.values(networkInterfaces()).flat()
      .find(item => item && !item.internal && item.family === 'IPv4')?.address;
    const suggested = isLoopbackHost(config.host) ? (address || '') : config.host;
    const hostInput = await ctx.ui.input(`局域网监听 IP${suggested ? `（留空使用 ${suggested}）` : ''}`, suggested);
    if (hostInput === undefined) return;
    const host = hostInput.trim() || suggested;
    if (!isIP(host) || isLoopbackHost(host) || host === '0.0.0.0' || host === '::') {
      throw new Error('请填写本机具体的非回环 IP；不要填写通配监听地址。');
    }
    const portInput = await ctx.ui.input(`端口（留空使用 ${config.port}；0 为自动分配）`, String(config.port));
    if (portInput === undefined) return;
    const portText = portInput.trim() || String(config.port);
    if (!/^\d+$/.test(portText) || Number(portText) > 65535) throw new Error('端口必须是 0..65535 的整数。');
    const certInput = await ctx.ui.input('TLS 证书路径（已有路径可留空保留）', config.tlsCert || '');
    if (certInput === undefined) return;
    const keyInput = await ctx.ui.input('TLS 私钥路径（不是私钥内容；已有路径可留空保留）', config.tlsKey || '');
    if (keyInput === undefined) return;
    const cert = certInput.trim() || config.tlsCert;
    const key = keyInput.trim() || config.tlsKey;
    if (!cert || !key) throw new Error('开启局域网必须提供 TLS 证书和私钥文件。');
    return { ...config, host, port: Number(portText), tlsCert: expandPath(cert), tlsKey: expandPath(key), lanEnabled: true };
  }

  async function validateTls(config) {
    const [cert, key] = await Promise.all([readFile(config.tlsCert), readFile(config.tlsKey)]);
    createSecureContext({ cert, key });
    if (!new X509Certificate(cert).checkIP(config.host)) {
      throw new Error('TLS 证书的 IP SAN 与监听 IP 不匹配；请使用匹配该 IP 的证书。');
    }
  }

  async function changeLan(ctx, enabled, configure = false) {
    requireNoWork();
    const previous = await readConfig();
    let next = { ...previous, lanEnabled: enabled };
    if (enabled) {
      if (configure || isLoopbackHost(next.host) || !next.tlsCert || !next.tlsKey) {
        next = await configureLan(ctx, next);
        if (!next) return;
      }
      // Validate all files before touching a working listener or saved defaults.
      await validateTls(next);
      if (!(await ctx.ui.confirm('开启局域网访问？',
        `监听 ${next.host}:${next.port || '自动端口'}，使用 HTTPS 和会话令牌。令牌持有者可以驱动当前 agent 的工具。此设置也将用于后续新会话。`))) return;
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
      ctx.ui.notify(enabled ? '局域网访问已开启。用 /lan info 查看连接信息。' : '局域网访问已关闭；本机接口保留，原 IP 和证书设置已保存。', 'info');
    } catch (error) {
      if (written) {
        try {
          await writeConfig(previous);
          if (wasRunning) await start(ctx);
          else await stop(ctx);
        } catch (restoreError) {
          throw new Error(`设置失败：${error.message}；恢复失败：${restoreError.message}。请用 /lan info 检查当前状态。`);
        }
      }
      throw error;
    } finally {
      changing = false;
    }
  }

  function showInfo(ctx) {
    const labels = { off: '已停止', local: '仅本机', lan: '局域网已开启', error: '错误／已暂停' };
    ctx.ui.notify(server
      ? `${labels[mode()]}\n${server.endpoint}\ninstance=${server.instanceId}\n${JSON.stringify(controller.session())}\n令牌内容不会显示；请通过私有实例文件获取。`
      : 'LAN RPC 已停止。使用 /lan start 启动，或 /lan on 开启局域网。', 'info');
  }

  pi.registerCommand('lan', {
    description: 'LAN RPC 控制：菜单 | info | on | off | configure | start | stop | restart',
    handler: async (args, ctx) => {
      let command = args.trim();
      if (!command) {
        const choices = [
          mode() === 'lan' ? '关闭局域网访问（保留本机）' : '开启局域网访问',
          '配置并开启局域网', '查看连接信息',
          server ? '停止所有接入' : '启动接入（使用已保存设置）',
          '返回',
        ];
        const choice = await ctx.ui.select('LAN RPC', choices);
        if (!choice || choice === '返回') return;
        command = ({
          '关闭局域网访问（保留本机）': 'off', '开启局域网访问': 'on',
          '配置并开启局域网': 'configure', '查看连接信息': 'info',
          '停止所有接入': 'stop', '启动接入（使用已保存设置）': 'start',
        })[choice];
      }
      try {
        if (command === 'info') showInfo(ctx);
        else if (['on', 'off', 'configure'].includes(command)) {
          await schedule(() => changeLan(ctx, command !== 'off', command === 'configure'));
        } else if (command === 'stop') {
          await schedule(() => stop(ctx));
          ctx.ui.notify('所有接入已停止；已经开始的 agent 工作不会被撤销。', 'info');
        } else if (command === 'start' || command === 'restart') {
          await schedule(async () => {
            requireNoWork();
            await start(ctx);
          });
        } else {
          ctx.ui.notify('用法：/lan [info|on|off|configure|start|stop|restart]', 'error');
        }
      } catch (error) {
        report(ctx, error);
      }
    },
  });
  indicator.prepareAtLoad();
}

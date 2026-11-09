import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createBtwExtension } from "./extension.ts";
import { createPiHost, createUnsupportedHost } from "./host/index.ts";

class Component {
	constructor(text = "") {
		this.text = text;
	}
	render() {
		return this.text ? [this.text] : [];
	}
}

class Container extends Component {
	children = [];
	addChild(child) {
		this.children.push(child);
	}
	render(width) {
		return this.children.flatMap((child) => child.render(width));
	}
}

class Input extends Component {
	constructor(options) {
		super();
		this.options = options;
		this.focused = true;
		this.value = "";
	}
	getValue() {
		return this.value;
	}
	setValue(value) {
		this.value = value;
	}
	handleInput() {}
}

function completeStream(chunks) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const delta of chunks) yield { type: "text_delta", delta };
		},
		async result() {
			return { stopReason: "stop" };
		},
	};
}

function cancelledStream(signal) {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "text_delta", delta: "partial" };
			await new Promise((resolve, reject) => {
				if (signal.aborted) {
					reject(new Error("aborted"));
					return;
				}
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		},
		async result() {
			return { stopReason: "aborted" };
		},
	};
}

function createHarness(sessionFile) {
	const eventHandlers = new Map();
	const commands = new Map();
	const sentMessages = [];
	const prompts = [];
	const notifications = [];
	const widgets = new Map();
	const plans = [
		{ chunks: ["Answer one. ", "<inject>steer now</inject>"] },
		{ chunks: ["Answer two."] },
		{ cancelled: true },
		{ cancelled: true },
	];
	let terminalHandler;
	let terminalSubscriptions = 0;
	let terminalUnsubscriptions = 0;

	const coding = {
		VERSION: "1.5.0",
		DynamicBorder: Component,
		getMarkdownTheme: () => ({}),
	};
	const tui = {
		Container,
		Input,
		Markdown: Component,
		Text: Component,
		matchesKey: (data, key) => data === key,
		truncateToWidth: (text) => text,
	};
	const host = createPiHost({
		packageName: "@earendil-works/pi-coding-agent",
		coding,
		tui,
	});
	const transcriptEntries = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "main transcript" }] } },
	];
	const originalTranscript = structuredClone(transcriptEntries);
	const ui = {
		notify(message, type) {
			notifications.push({ message, type });
		},
		onTerminalInput(handler) {
			terminalSubscriptions++;
			terminalHandler = handler;
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				terminalUnsubscriptions++;
				if (terminalHandler === handler) terminalHandler = undefined;
			};
		},
		getEditorText: () => "",
		setWidget(key, content) {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		},
		async select(_title, options) {
			return options[0];
		},
		async custom(factory) {
			return new Promise((resolve) => {
				factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, {}, resolve);
			});
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: { provider: "compat", id: "local" },
		isIdle: () => true,
		ui,
		sessionManager: {
			getSessionFile: () => sessionFile,
			buildContextEntries: () => transcriptEntries,
		},
		modelRegistry: {
			streamSimple(_model, context, options) {
				prompts.push(context.messages[0].content[0].text);
				const plan = plans.shift();
				if (!plan) throw new Error("unexpected model call");
				return plan.cancelled ? cancelledStream(options.signal) : completeStream(plan.chunks);
			},
		},
	};
	const pi = {
		on(event, handler) {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
			return () => {};
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		async exec() {
			return { code: 0 };
		},
		sendUserMessage(content, options) {
			sentMessages.push({ content, options });
		},
	};
	async function emit(event, payload = {}) {
		for (const handler of eventHandlers.get(event) ?? []) await handler(payload, ctx);
	}

	return {
		commands,
		ctx,
		emit,
		host,
		notifications,
		originalTranscript,
		pi,
		prompts,
		sentMessages,
		transcriptEntries,
		widgets,
		terminalState: () => ({ terminalHandler, terminalSubscriptions, terminalUnsubscriptions }),
	};
}

test("ask, follow-up, history, inject, cancel, and shutdown preserve the main transcript", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-btw-test-"));
	try {
		const sessionFile = path.join(dir, "session.jsonl");
		const harness = createHarness(sessionFile);
		createBtwExtension(harness.host)(harness.pi);
		await harness.emit("session_start");
		const command = harness.commands.get("btw");
		assert.ok(command);

		await command.handler("first question", harness.ctx);
		assert.equal(harness.sentMessages.length, 0, "ordinary side questions must not write to the main session");
		assert.match(harness.prompts[0], /User: main transcript/);
		assert.match(harness.prompts[0], /Question:\nfirst question/);

		await command.handler("inject", harness.ctx);
		assert.deepEqual(harness.sentMessages, [{ content: "steer now", options: undefined }]);

		await command.handler("+ second question", harness.ctx);
		assert.match(harness.prompts[1], /<btw_history>/);
		assert.match(harness.prompts[1], /Q: first question/);
		assert.match(harness.prompts[1], /Question:\nsecond question/);
		await command.handler("history", harness.ctx);
		assert.equal(harness.prompts.length, 2, "opening history must not call the model");

		const cancelled = command.handler("cancel this", harness.ctx);
		await new Promise((resolve) => setImmediate(resolve));
		await command.handler("close", harness.ctx);
		await cancelled;

		const shutdown = command.handler("shutdown this", harness.ctx);
		await new Promise((resolve) => setImmediate(resolve));
		await harness.emit("session_shutdown");
		await shutdown;

		const sidecar = `${sessionFile}.btw.json`;
		const history = JSON.parse(fs.readFileSync(sidecar, "utf8"));
		assert.equal(history.topics.length, 3);
		assert.deepEqual(
			history.topics[0].turns.map((turn) => turn.status),
			["complete", "complete"],
		);
		assert.equal(history.topics[1].turns[0].status, "cancelled");
		assert.equal(history.topics[2].turns[0].status, "cancelled");
		assert.equal(fs.statSync(sidecar).mode & 0o777, 0o600);
		assert.deepEqual(harness.transcriptEntries, harness.originalTranscript);
		assert.equal(harness.sentMessages.length, 1, "only explicit inject may write to the main session");

		const terminals = harness.terminalState();
		assert.equal(terminals.terminalSubscriptions - terminals.terminalUnsubscriptions, 0);
		assert.equal(harness.widgets.size, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("OMP host never registers an external btw command", () => {
	const commands = [];
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (message) => warnings.push(message);
	try {
		const host = createUnsupportedHost(
			"omp",
			"pi-btw skipped on Oh My Pi: OMP already provides the native /btw command.",
			"18.17.0",
		);
		createBtwExtension(host)({ registerCommand: (name) => commands.push(name) });
		assert.deepEqual(commands, []);
		assert.deepEqual(warnings, ["pi-btw skipped on Oh My Pi: OMP already provides the native /btw command."]);
	} finally {
		console.warn = originalWarn;
	}
});

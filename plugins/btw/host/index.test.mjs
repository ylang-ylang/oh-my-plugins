import assert from "node:assert/strict";
import test from "node:test";
import { createPiHost, loadRuntimeHost } from "./index.ts";

class Component {
	render() {
		return [];
	}
}

class Container extends Component {
	addChild() {}
}

class Input extends Component {
	constructor(options) {
		super();
		this.options = options;
		this.focused = true;
	}
	getValue() {
		return "";
	}
	setValue() {}
	handleInput() {}
}

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

function finishedStream(text = "ok") {
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "text_delta", delta: text };
		},
		async result() {
			return { stopReason: "stop" };
		},
	};
}

test("Pi 1.5 uses current context and registry APIs", async () => {
	const calls = [];
	const host = createPiHost({
		packageName: "@earendil-works/pi-coding-agent",
		coding,
		tui,
	});
	const currentEntries = [{ type: "message", message: { role: "user", content: "current" } }];
	const ctx = {
		mode: "tui",
		hasUI: false,
		isIdle: () => true,
		ui: { onTerminalInput: () => () => {} },
		sessionManager: {
			buildContextEntries: () => currentEntries,
			getBranch: () => [{ type: "message", message: { role: "user", content: "legacy" } }],
		},
		modelRegistry: {
			streamSimple(model, context, options) {
				calls.push({ model, context, options });
				return finishedStream();
			},
		},
	};

	assert.equal(host.supported, true);
	assert.equal(host.isInteractive(ctx), true);
	assert.equal(host.getContextEntries(ctx), currentEntries);
	assert.equal(host.isStreamingInput({ text: "x" }, ctx), false);
	assert.equal(host.isStreamingInput({ text: "x", streamingBehavior: "steer" }, ctx), true);
	assert.deepEqual(host.createInput({ prompt: "P" }).options, { prompt: "P" });

	const controller = new AbortController();
	await host.streamTurn(ctx, { model: "model", prompt: "question", signal: controller.signal, sessionId: "side" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model, "model");
	assert.equal(calls[0].context.messages[0].content[0].text, "question");
	assert.equal(calls[0].options.toolChoice, "none");
	assert.equal(calls[0].options.sessionId, "side");
});

test("Pi 0.73 and 0.74 use public legacy stream and branch APIs", async () => {
	for (const [packageName, version] of [
		["@mariozechner/pi-coding-agent", "0.73.1"],
		["@earendil-works/pi-coding-agent", "0.74.0"],
	]) {
		const streamCalls = [];
		const authCalls = [];
		const host = createPiHost({
			packageName,
			coding: { ...coding, VERSION: version },
			tui,
			ai: {
				streamSimple(model, context, options) {
					streamCalls.push({ model, context, options });
					return finishedStream();
				},
			},
		});
		const branch = [{ type: "message", message: { role: "user", content: version } }];
		const ctx = {
			hasUI: true,
			isIdle: () => false,
			ui: { onTerminalInput: () => () => {} },
			sessionManager: { getBranch: () => branch },
			modelRegistry: {
				async getApiKeyAndHeaders(model) {
					authCalls.push(model);
					return { ok: true, apiKey: "key", headers: { "x-test": version } };
				},
			},
		};

		assert.equal(host.isInteractive(ctx), true, version);
		assert.equal(host.isStreamingInput({ text: "/btw" }, ctx), true, version);
		assert.equal(host.getContextEntries(ctx), branch, version);
		assert.equal(host.createInput({ prompt: "ignored" }).options, undefined, version);
		await host.streamTurn(ctx, {
			model: version,
			prompt: "legacy question",
			signal: new AbortController().signal,
			sessionId: `side-${version}`,
		});
		assert.deepEqual(authCalls, [version]);
		assert.equal(streamCalls[0].options.apiKey, "key");
		assert.deepEqual(streamCalls[0].options.headers, { "x-test": version });
	}
});

test("missing legacy streaming capability fails exactly instead of faking output", async () => {
	const host = createPiHost({
		packageName: "@earendil-works/pi-coding-agent",
		coding: { ...coding, VERSION: "0.74.0" },
		tui,
	});
	await assert.rejects(
		host.streamTurn(
			{ isIdle: () => true, ui: {}, sessionManager: {}, modelRegistry: {} },
			{ model: {}, prompt: "q", signal: new AbortController().signal, sessionId: "side" },
		),
		/neither modelRegistry\.streamSimple\(\) nor @earendil-works\/pi-ai\.streamSimple\(\) is available/,
	);
});

function missingModule(specifier, target = specifier) {
	const error = new Error(`Cannot find package '${target}' imported from ${specifier}`);
	error.code = "ERR_MODULE_NOT_FOUND";
	return error;
}

test("Oh My Pi is an explicit fallback when no Pi package is present", async () => {
	const loaded = [];
	const host = await loadRuntimeHost(async (specifier) => {
		loaded.push(specifier);
		if (specifier === "@oh-my-pi/pi-coding-agent") return { VERSION: "18.17.0" };
		throw missingModule(specifier);
	});
	assert.equal(host.kind, "omp");
	assert.equal(host.supported, false);
	assert.match(host.diagnostic, /already provides the native \/btw command/);
	assert.deepEqual(loaded, [
		"@earendil-works/pi-coding-agent",
		"@mariozechner/pi-coding-agent",
		"@oh-my-pi/pi-coding-agent",
	]);
});

test("unexpected and nested module failures propagate", async () => {
	await assert.rejects(
		loadRuntimeHost(async (specifier) => {
			const error = missingModule(specifier, "broken-transitive-package");
			error.request = specifier;
			throw error;
		}),
		/broken-transitive-package/,
	);
	await assert.rejects(
		loadRuntimeHost(async () => {
			throw new SyntaxError("host module initialization failed");
		}),
		/host module initialization failed/,
	);
});

test("active injected API, not OMP importability, controls command collision", async () => {
	const loaded = [];
	const host = await loadRuntimeHost(async (specifier) => {
		loaded.push(specifier);
		if (specifier === "@earendil-works/pi-coding-agent") return coding;
		if (specifier === "@earendil-works/pi-tui") return tui;
		if (specifier === "@earendil-works/pi-ai") return {};
		if (specifier === "@oh-my-pi/pi-coding-agent") return { VERSION: "18.17.0" };
		throw missingModule(specifier);
	});
	assert.equal(host.kind, "pi");
	assert.equal(host.shouldRegister({}), true);
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (message) => warnings.push(message);
	try {
		assert.equal(host.shouldRegister({ pi: { VERSION: "18.17.0" } }), false);
	} finally {
		console.warn = originalWarn;
	}
	assert.deepEqual(warnings, [
		"pi-btw skipped on Oh My Pi 18.17.0: OMP already provides the native /btw command; the external Pi plugin was not registered.",
	]);
	assert.equal(loaded.includes("@oh-my-pi/pi-coding-agent"), false);
});

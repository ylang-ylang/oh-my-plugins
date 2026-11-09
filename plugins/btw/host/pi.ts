import type {
	BtwHost,
	BtwUiKit,
	ExtensionAPI,
	HostContext,
	HostInputEvent,
	HostStream,
	InputLike,
	PiModuleSet,
	SessionEntry,
	StreamTurnRequest,
} from "./types.ts";

type Constructor<T> = new (...args: never[]) => T;
type InputConstructor = new (options?: { prompt?: string; placeholder?: string }) => InputLike;

function requiredFunction(module: Record<string, unknown>, name: string): (...args: never[]) => unknown {
	const value = module[name];
	if (typeof value !== "function") throw new Error(`missing export ${name}`);
	return value as (...args: never[]) => unknown;
}

function requiredConstructor<T>(module: Record<string, unknown>, name: string): Constructor<T> {
	return requiredFunction(module, name) as unknown as Constructor<T>;
}

function unsupportedMethod(diagnostic: string): never {
	throw new Error(diagnostic);
}

export function createUnsupportedHost(
	kind: "omp" | "unsupported",
	diagnostic: string,
	version?: string,
): BtwHost {
	let reported = false;
	return {
		kind,
		version,
		supported: false,
		diagnostic,
		shouldRegister() {
			if (!reported) {
				reported = true;
				console.warn(diagnostic);
			}
			return false;
		},
		isInteractive: () => false,
		isStreamingInput: () => false,
		getSessionFile: () => undefined,
		getContextEntries: () => unsupportedMethod(diagnostic),
		onTerminalInput: () => unsupportedMethod(diagnostic),
		createInput: () => unsupportedMethod(diagnostic),
		streamTurn: () => Promise.reject(new Error(diagnostic)),
	};
}

export function createPiHost(modules: PiModuleSet): BtwHost {
	const version = typeof modules.coding.VERSION === "string" ? modules.coding.VERSION : "unknown";
	let ui: BtwUiKit;
	let Input: InputConstructor;
	try {
		Input = requiredConstructor<InputLike>(modules.tui, "Input") as InputConstructor;
		ui = {
			Container: requiredConstructor(modules.tui, "Container"),
			DynamicBorder: requiredConstructor(modules.coding, "DynamicBorder"),
			Markdown: requiredConstructor(modules.tui, "Markdown"),
			Text: requiredConstructor(modules.tui, "Text"),
			getMarkdownTheme: requiredFunction(modules.coding, "getMarkdownTheme") as BtwUiKit["getMarkdownTheme"],
			matchesKey: requiredFunction(modules.tui, "matchesKey") as BtwUiKit["matchesKey"],
			truncateToWidth: requiredFunction(modules.tui, "truncateToWidth") as BtwUiKit["truncateToWidth"],
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return createUnsupportedHost(
			"unsupported",
			`pi-btw skipped: Pi ${version} (${modules.packageName}) lacks a required public UI capability: ${reason}.`,
			version,
		);
	}

	const supportsInputOptions = Number.parseInt(version.split(".")[0] ?? "0", 10) >= 1;
	const legacyStreamSimple = modules.ai?.streamSimple;
	let ompReported = false;

	return {
		kind: "pi",
		version,
		supported: true,
		ui,
		shouldRegister(api: ExtensionAPI): boolean {
			if (!api.pi) return true;
			if (!ompReported) {
				ompReported = true;
				const ompVersion = typeof api.pi.VERSION === "string" ? api.pi.VERSION : version;
				console.warn(
					`pi-btw skipped on Oh My Pi ${ompVersion}: OMP already provides the native /btw command; the external Pi plugin was not registered.`,
				);
			}
			return false;
		},
		isInteractive(ctx: HostContext): boolean {
			return typeof ctx.mode === "string" ? ctx.mode === "tui" : ctx.hasUI === true;
		},
		isStreamingInput(event: HostInputEvent, ctx: HostContext): boolean {
			return event.streamingBehavior !== undefined || !ctx.isIdle();
		},
		getSessionFile(ctx: HostContext): string | undefined {
			return ctx.sessionManager.getSessionFile?.();
		},
		getContextEntries(ctx: HostContext): SessionEntry[] {
			const manager = ctx.sessionManager;
			if (typeof manager.buildContextEntries === "function") return manager.buildContextEntries();
			if (typeof manager.getBranch === "function") return manager.getBranch();
			if (typeof manager.getEntries === "function") return manager.getEntries();
			return unsupportedMethod(
				`/btw is unavailable on Pi ${version}: the session manager exposes none of buildContextEntries(), getBranch(), or getEntries().`,
			);
		},
		onTerminalInput(ctx, handler): () => void {
			const subscribe = ctx.ui.onTerminalInput;
			if (typeof subscribe !== "function") {
				return unsupportedMethod(`/btw is unavailable on Pi ${version}: ui.onTerminalInput() is missing.`);
			}
			return subscribe.call(ctx.ui, handler);
		},
		createInput(options): InputLike {
			return supportsInputOptions ? new Input(options) : new Input();
		},
		async streamTurn(ctx: HostContext, request: StreamTurnRequest): Promise<HostStream> {
			const context = {
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: request.prompt }],
						timestamp: Date.now(),
					},
				],
			};
			const options = {
				signal: request.signal,
				toolChoice: "none",
				sessionId: request.sessionId,
			};
			const registryStream = ctx.modelRegistry.streamSimple;
			if (typeof registryStream === "function") {
				return registryStream.call(ctx.modelRegistry, request.model, context, options);
			}
			if (typeof legacyStreamSimple !== "function") {
				return unsupportedMethod(
					`/btw is unavailable on Pi ${version}: neither modelRegistry.streamSimple() nor ${modules.packageName.replace("coding-agent", "ai")}.streamSimple() is available.`,
				);
			}
			const resolveAuth = ctx.modelRegistry.getApiKeyAndHeaders;
			if (typeof resolveAuth !== "function") {
				return unsupportedMethod(
					`/btw is unavailable on Pi ${version}: modelRegistry.getApiKeyAndHeaders() is required by the legacy stream path.`,
				);
			}
			const auth = await resolveAuth.call(ctx.modelRegistry, request.model);
			if (!auth.ok) throw new Error(auth.error);
			return legacyStreamSimple(request.model, context, {
				...options,
				apiKey: auth.apiKey,
				headers: auth.headers,
			}) as HostStream;
		},
	};
}

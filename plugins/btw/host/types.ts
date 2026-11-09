export interface ThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ComponentLike {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	dispose?(): void;
	focused?: boolean;
}

export interface ContainerLike extends ComponentLike {
	addChild(component: ComponentLike): void;
}

export interface InputLike extends ComponentLike {
	focused: boolean;
	onSubmit?: (value: string) => void;
	onEscape?: () => void;
	getValue(): string;
	setValue(value: string): void;
	handleInput(data: string): void;
}

export interface TuiLike {
	requestRender(): void;
}

export interface BtwUiKit {
	Container: new () => ContainerLike;
	DynamicBorder: new (style: (text: string) => string) => ComponentLike;
	Markdown: new (text: string, paddingX: number, paddingY: number, theme: unknown) => ComponentLike;
	Text: new (text: string, paddingX?: number, paddingY?: number) => ComponentLike;
	getMarkdownTheme(): unknown;
	matchesKey(data: string, key: string): boolean;
	truncateToWidth(text: string, width: number): string;
}

export interface SessionMessage {
	role?: string;
	content?: unknown;
}

export interface SessionEntry {
	type: string;
	message?: SessionMessage;
}

export interface HostStreamEvent {
	type: string;
	delta?: string;
}

export interface HostStreamResult {
	stopReason?: string;
	errorMessage?: string;
}

export interface HostStream extends AsyncIterable<HostStreamEvent> {
	result(): Promise<HostStreamResult>;
}

export interface HostSessionManager {
	getSessionFile?(): string | undefined;
	buildContextEntries?(): SessionEntry[];
	getBranch?(): SessionEntry[];
	getEntries?(): SessionEntry[];
}

export interface HostModelRegistry {
	streamSimple?: (model: unknown, context: unknown, options?: Record<string, unknown>) => HostStream;
	getApiKeyAndHeaders?: (model: unknown) => Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string> }
		| { ok: false; error: string }
	>;
}

export interface HostUiContext {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText?(): string;
	setWidget(key: string, content: unknown): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	custom<T>(
		factory: (
			tui: TuiLike,
			theme: ThemeLike,
			keybindings: unknown,
			done: (result: T) => void,
		) => ComponentLike | Promise<ComponentLike>,
	): Promise<T>;
}

export interface HostContext {
	ui: HostUiContext;
	mode?: string;
	hasUI?: boolean;
	model?: unknown;
	modelRegistry: HostModelRegistry;
	sessionManager: HostSessionManager;
	isIdle(): boolean;
}

export interface HostInputEvent {
	text: string;
	streamingBehavior?: "steer" | "followUp";
}

export interface HostExecResult {
	code: number;
}

export interface ExtensionAPI {
	/** OMP injects its own coding-agent facade here; upstream Pi does not. */
	pi?: Record<string, unknown>;
	on(event: string, handler: (event: unknown, ctx: HostContext) => unknown): unknown;
	registerCommand(
		name: string,
		options: {
			description: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description: string }> | null;
			handler: (args: string, ctx: HostContext) => unknown;
		},
	): void;
	exec(command: string, args: string[], options?: { timeout?: number }): Promise<HostExecResult>;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface StreamTurnRequest {
	model: unknown;
	prompt: string;
	signal: AbortSignal;
	sessionId: string;
}

export interface BtwHost {
	readonly kind: "pi" | "omp" | "unsupported";
	readonly version?: string;
	readonly supported: boolean;
	readonly diagnostic?: string;
	readonly ui?: BtwUiKit;
	shouldRegister(api: ExtensionAPI): boolean;
	isInteractive(ctx: HostContext): boolean;
	isStreamingInput(event: HostInputEvent, ctx: HostContext): boolean;
	getSessionFile(ctx: HostContext): string | undefined;
	getContextEntries(ctx: HostContext): SessionEntry[];
	onTerminalInput(
		ctx: HostContext,
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void;
	createInput(options: { prompt?: string; placeholder?: string }): InputLike;
	streamTurn(ctx: HostContext, request: StreamTurnRequest): Promise<HostStream>;
}

export interface PiModuleSet {
	packageName: "@earendil-works/pi-coding-agent" | "@mariozechner/pi-coding-agent";
	coding: Record<string, unknown>;
	tui: Record<string, unknown>;
	ai?: Record<string, unknown>;
}

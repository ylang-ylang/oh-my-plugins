/**
 * /btw — ephemeral side questions, ported from oh-my-pi's /btw feature.
 *
 * Ask a quick question against the current conversation (including the
 * in-flight assistant response) WITHOUT touching session history and WITHOUT
 * interrupting the main turn. The answer streams into a widget docked above
 * the editor — the conversation scrolls up, nothing is covered.
 *
 *   /btw <question>   Ask a side question (works while the agent runs)
 *   /btw +            Open the follow-up window for the current topic
 *   /btw + <question> Quick follow-up without leaving the editor
 *   /btw              Pick from this session's /btw history
 *   /btw copy         Copy the current answer to the clipboard
 *   /btw inject       Send the answer's <inject> steering prompt to the session
 *   /btw close        Hide the panel
 *
 * Panel keys (while the editor is empty): c copy · f follow-up window ·
 * i inject · esc close. The follow-up window is a self-contained sheet with
 * its own composer: enter sends, answers stream into the thread, esc cancels
 * the in-flight answer, esc again closes.
 *
 * When a question asks for a steering/correction prompt for the main agent,
 * the model drafts it inside one <inject>…</inject> block; the panel shows it
 * separately and `/btw inject` delivers it as a steering message.
 *
 * History persists to `<session-file>.btw.json` next to the session file.
 */

import * as fs from "node:fs";
import { runtimeHost } from "./host/index.ts";
import type {
	BtwHost,
	BtwUiKit,
	ExtensionAPI,
	HostContext,
	HostInputEvent,
	SessionEntry,
	ThemeLike,
} from "./host/index.ts";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface BtwTurn {
	question: string;
	answer: string;
	status: "running" | "complete" | "cancelled" | "error";
	error?: string;
	createdAt: number;
	updatedAt: number;
}

interface BtwTopic {
	id: string;
	createdAt: number;
	turns: BtwTurn[];
}

interface ActivePanel {
	topic: BtwTopic;
	turn: BtwTurn;
	answer: string;
	error?: string;
	running: boolean;
	abort: AbortController;
}

const WIDGET_KEY = "btw";
const MAX_BODY_LINES = 14;

/** Render one stored turn as display lines (used for the topic's history). */
function turnLines(ui: BtwUiKit, theme: ThemeLike, turn: BtwTurn, width: number, current: boolean): string[] {
	const lines: string[] = [];
	const title = `/btw ${turn.question}`;
	lines.push(current ? theme.fg("accent", theme.bold(title)) : theme.fg("dim", title));
	const { prose, inject } = splitInject(turn.answer);
	const body = prose || (turn.status === "running" ? "" : inject ? "" : "(no answer)");
	const md = new ui.Markdown(turn.status === "running" && !body ? "*thinking…*" : body, 1, 1, ui.getMarkdownTheme());
	lines.push(...md.render(width));
	if (inject) {
		lines.push(theme.fg("success", "→ steering prompt for the main session:"));
		lines.push(theme.fg("success", inject));
	}
	if (turn.error) lines.push(theme.fg("error", `Error: ${turn.error}`));
	return lines;
}

// ---------------------------------------------------------------------------
// Prompt (adapted from oh-my-pi's prompts/system/btw-user.md)
// ---------------------------------------------------------------------------

const BTW_INSTRUCTIONS = `<btw>
Ephemeral side question for the current interactive session.
Answer briefly and directly; use the conversation context provided above.
NEVER use tools.
NEVER ask follow-up questions.
Steering: only when the question asks for a steering, correction, or instruction prompt for the main session, draft the exact message for the main agent inside ONE <inject>…</inject> block, written as the user speaking to it. The user can send that block to the main session verbatim, so it MUST stand alone. Write it exactly in this form, plain text between the tags:
<inject>Pause the refactor and fix the failing build first, then rerun the tests before continuing.</inject>
NEVER put quote markers, bullets, or code fences around or inside the block, and NEVER write the tag anywhere else.
</btw>`;

// ---------------------------------------------------------------------------
// Transcript snapshot (same extraction approach as the summarize example)
// ---------------------------------------------------------------------------

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };

const MAX_CONTEXT_CHARS = 120_000;

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const part of content) {
		const block = part as ContentBlock | null;
		if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts;
}

function toolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const part of content) {
		const block = part as ContentBlock | null;
		if (block && block.type === "toolCall" && typeof block.name === "string") {
			const args = JSON.stringify(block.arguments ?? {});
			lines.push(`[tool call] ${block.name}(${args.length > 300 ? `${args.slice(0, 300)}…` : args})`);
		}
	}
	return lines;
}

function buildTranscript(entries: SessionEntry[], inFlightText: string): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const lines: string[] = [];
		const text = textParts(entry.message.content).join("\n").trim();
		if (text) lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
		if (role === "assistant") lines.push(...toolCallLines(entry.message.content));
		if (lines.length) sections.push(lines.join("\n"));
	}
	if (inFlightText.trim()) {
		sections.push(`Assistant (response still in progress): ${inFlightText.trim()}`);
	}
	let transcript = sections.join("\n\n");
	if (transcript.length > MAX_CONTEXT_CHARS) {
		transcript = `…[earlier conversation truncated]…\n\n${transcript.slice(-MAX_CONTEXT_CHARS)}`;
	}
	return transcript;
}

// ---------------------------------------------------------------------------
// Inject block parsing
// ---------------------------------------------------------------------------

function splitInject(answer: string): { prose: string; inject?: string } {
	const match = answer.match(/<inject>([\s\S]*?)<\/inject>/);
	if (!match) return { prose: answer.trim() };
	const prose = answer.replace(match[0], "").trim();
	return { prose, inject: match[1]!.trim() };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function registerBtw(pi: ExtensionAPI, host: BtwHost) {
	const { Container, DynamicBorder, Text, matchesKey, truncateToWidth } = host.ui!;
	let topics: BtwTopic[] = [];
	let inFlightText = "";
	let historyFile: string | undefined;
	let seq = 0;
	let active: ActivePanel | undefined;
	let dialogOpen = false;
	let unsubscribeInput: (() => void) | undefined;
	let followUpTimer: NodeJS.Timeout | undefined;
	let closeFollowUp: (() => void) | undefined;

	const save = () => {
		if (!historyFile) return;
		try {
			fs.writeFileSync(historyFile, `${JSON.stringify({ topics }, null, 2)}\n`, { mode: 0o600 });
		} catch {
			/* history is a convenience, never break the session for it */
		}
	};

	const load = () => {
		topics = [];
		if (!historyFile || !fs.existsSync(historyFile)) return;
		try {
			const parsed = JSON.parse(fs.readFileSync(historyFile, "utf8")) as { topics?: BtwTopic[] };
			if (Array.isArray(parsed.topics)) topics = parsed.topics;
			for (const topic of topics) {
				for (const turn of topic.turns) {
					if (turn.status === "running") turn.status = "cancelled";
				}
			}
		} catch {
			topics = [];
		}
	};

	// Single-key interaction, omp-style: while a panel is visible and the
	// editor is empty, bare keys act on the panel directly. Anything that
	// would steal a real editing keystroke (editor non-empty, a dialog open,
	// Esc while the main turn runs) is passed through untouched.
	function keyHandler(ctx: AnyContext, data: string): { consume: true } | undefined {
		if (!active || dialogOpen) return undefined;
		let editorText = "";
		try {
			if (typeof ctx.ui.getEditorText !== "function") return undefined;
			editorText = ctx.ui.getEditorText();
		} catch {
			return undefined;
		}
		if (editorText) return undefined;

		const panel = active;
		if (data === "c" && !panel.running) {
			void copyToClipboard(splitInject(panel.answer).prose || panel.answer).then((ok) =>
				ctx.ui.notify(ok ? "Answer copied" : "No clipboard tool found (wl-copy/xclip/pbcopy)", ok ? "info" : "warning"),
			);
			return { consume: true };
		}
		if (data === "f" && !panel.running) {
			openFollowUpWindow(ctx, panel.topic);
			return { consume: true };
		}
		if (data === "i" && !panel.running) {
			const { inject } = splitInject(panel.answer);
			if (!inject) return undefined;
			void deliverInject(ctx, inject);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			// Esc belongs to the running main turn (interrupt). Only claim it idle.
			if (!ctx.isIdle()) return undefined;
			suppressNextEditorEscape();
			closePanel(ctx);
			return { consume: true };
		}
		return undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		const sessionFile = host.getSessionFile(ctx);
		historyFile = sessionFile ? `${sessionFile}.btw.json` : undefined;
		active = undefined;
		load();
		ensureInputHook(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		clearTimeout(followUpTimer);
		followUpTimer = undefined;
		closeFollowUp?.();
		closeFollowUp = undefined;
		if (active?.running) {
			active.abort.abort();
			active.running = false;
			active.turn.status = "cancelled";
			active.turn.answer = active.answer;
			active.turn.error = active.error;
			active.turn.updatedAt = Date.now();
			save();
		}
		active = undefined;
		dialogOpen = false;
		repaint = undefined;
		historyFile = undefined;
		if (host.isInteractive(ctx)) ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	// Editor-level Esc suppression: when the single-key handler closes the
	// panel, some pi versions still deliver that Esc to the editor (clearing
	// the draft). Swallow the immediately following editor Escape.
	pi.on("input", (rawEvent) => {
		const event = rawEvent as HostInputEvent;
		if (suppressEditorEscapes > 0 && event.text === "") {
			suppressEditorEscapes = 0;
			return { action: "handled" as const };
		}
		return undefined;
	});

	// session_start does not fire on /reload, so the hook must also be armed
	// lazily from any command entry point.
	function ensureInputHook(ctx: AnyContext) {
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (host.isInteractive(ctx)) {
			unsubscribeInput = host.onTerminalInput(ctx, (data) => keyHandler(ctx, data));
		}
	}

	// Track the in-flight assistant text so /btw sees the half-finished answer.
	pi.on("turn_start", () => {
		inFlightText = "";
	});
	pi.on("message_update", (event) => {
		const message = (event as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role === "assistant") inFlightText = textParts(message.content).join("\n");
	});
	pi.on("turn_end", () => {
		inFlightText = "";
	});
	pi.on("agent_end", () => {
		inFlightText = "";
	});

	// -----------------------------------------------------------------------
	// Core: run one side turn
	// -----------------------------------------------------------------------

	type AnyContext = HostContext;

	async function runTurn(
		ctx: AnyContext,
		topic: BtwTopic,
		question: string,
		onDelta: (delta: string) => void,
		signal: AbortSignal,
	): Promise<void> {
		const model = ctx.model;
		if (!model) throw new Error("No active model available for /btw.");

		const transcript = buildTranscript(host.getContextEntries(ctx), inFlightText);

		const priorTurns = topic.turns.filter((t) => t.status === "complete" && t.answer.trim());
		const historySection = priorTurns.length
			? `\n\n<btw_history>\n${priorTurns
					.map((t) => `Q: ${t.question}\nA: ${t.answer.trim()}`)
					.join("\n\n")}\n</btw_history>`
			: "";

		const promptText = [
			"<conversation_context>",
			transcript || "(empty conversation)",
			"</conversation_context>",
			historySection,
			"",
			BTW_INSTRUCTIONS,
			"",
			`Question:\n${question}`,
		].join("\n");

		const stream = await host.streamTurn(ctx, {
			model,
			prompt: promptText,
			signal,
			sessionId: `btw-${Date.now()}-${++seq}`,
		});
		for await (const event of stream) {
			if (event.type === "text_delta" && typeof event.delta === "string") onDelta(event.delta);
		}
		const finalMessage = await stream.result();
		if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
			throw new Error(finalMessage.errorMessage ?? `Side question ${finalMessage.stopReason}.`);
		}
	}

	// -----------------------------------------------------------------------
	// Docked widget panel (layout flow — the conversation scrolls up)
	// -----------------------------------------------------------------------

	function renderPanel(theme: ThemeLike, width: number): string[] {
		if (!active) return [];
		const panel = active;
		const inner = Math.max(20, width - 4);

		// Sync the live turn into the topic so the history view stays current.
		panel.turn.answer = panel.answer;
		panel.turn.error = panel.error;

		const container = new Container();
		const border = new DynamicBorder((s: string) => theme.fg("accent", s));
		container.addChild(border);

		// Render the whole topic as a Q&A thread, current turn last; when it
		// runs long, show the tail — the newest exchange is what matters.
		const allLines: string[] = [];
		for (const turn of panel.topic.turns) {
			if (allLines.length) allLines.push("");
			allLines.push(...turnLines(host.ui!, theme, turn, inner - 2, turn === panel.turn));
		}
		for (const line of allLines.slice(-MAX_BODY_LINES)) container.addChild(new Text(line, 1, 0));

		const { inject } = splitInject(panel.answer);
		const hints = panel.running
			? "esc cancel"
			: `c copy · f follow-up${inject ? " · i inject" : ""} · esc close — keys while editor empty, or /btw +|copy|inject|close`;
		container.addChild(new Text(theme.fg("dim", hints), 1, 0));
		container.addChild(border);

		return container.render(inner).map((line) => truncateToWidth(line, width));
	}

	let repaint: (() => void) | undefined;
	// Esc swallowed by the panel's single-key mode still reaches the editor on
	// some pi builds; swallow the next editor-level Escape(s) after a panel esc.
	let suppressEditorEscapes = 0;

	function suppressNextEditorEscape() {
		suppressEditorEscapes++;
		setTimeout(() => {
			suppressEditorEscapes = Math.max(0, suppressEditorEscapes - 1);
		}, 500);
	}

	function refreshWidget(ctx: AnyContext) {
		if (!host.isInteractive(ctx)) return;
		if (!active) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		// While the follow-up sheet owns the screen it is the single view of
		// the thread; re-docking the widget would duplicate it.
		if (dialogOpen) return;
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;
			repaint = () => {
				cachedWidth = undefined;
				cachedLines = undefined;
				tui.requestRender();
			};
			return {
				render(width: number): string[] {
					if (cachedLines && cachedWidth === width) return cachedLines;
					cachedWidth = width;
					cachedLines = renderPanel(theme, width);
					return cachedLines;
				},
				invalidate() {
					cachedWidth = undefined;
					cachedLines = undefined;
				},
			};
		});
	}

	function closePanel(ctx: AnyContext) {
		if (active?.running) active.abort.abort();
		active = undefined;
		if (host.isInteractive(ctx)) ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/** Start (or replace) the docked panel and stream the answer into it. */
	async function ask(ctx: AnyContext, topic: BtwTopic, question: string) {
		if (active?.running) {
			active.abort.abort();
			ctx.ui.notify("Previous /btw cancelled", "info");
		}
		const turn: BtwTurn = {
			question,
			answer: "",
			status: "running",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		topic.turns.push(turn);
		active = { topic, turn, answer: "", running: true, abort: new AbortController() };
		refreshWidget(ctx);

		const panel = active;
		const signal = panel.abort.signal;
		try {
			await runTurn(ctx, topic, question, makeDeltaSink(panel), signal);
			turn.status = "complete";
		} catch (error) {
			if (signal.aborted) {
				turn.status = "cancelled";
			} else {
				turn.status = "error";
				panel.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			panel.running = false;
			turn.answer = panel.answer;
			turn.error = panel.error;
			turn.updatedAt = Date.now();
			save();
			// One more widget refresh so the terminal state is painted.
			refreshWidget(ctx);
		}
	}

	// Text deltas accumulate into panel state and schedule a repaint; the
	// widget render reads panel state. Throttled so a fast stream doesn't
	// rebuild markdown per token.
	function makeDeltaSink(panel: ActivePanel): (delta: string) => void {
		let pending = false;
		return (delta: string) => {
			panel.answer += delta;
			if (pending) return;
			pending = true;
			setTimeout(() => {
				pending = false;
				repaint?.();
			}, 100);
		};
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	async function copyToClipboard(text: string): Promise<boolean> {
		const tmp = `/tmp/pi-btw-${process.pid}-${Date.now()}.txt`;
		try {
			fs.writeFileSync(tmp, text, { mode: 0o600 });
			// Wayland, X11, macOS, then OSC52 straight to the controlling
			// terminal — covers headless X and nested tmux as a last resort.
			const result = await pi.exec(
				"sh",
				[
					"-c",
					`cat "$1" | wl-copy 2>/dev/null || cat "$1" | xclip -selection clipboard 2>/dev/null || cat "$1" | xsel --clipboard 2>/dev/null || cat "$1" | pbcopy 2>/dev/null || { b64=$(base64 -w0 "$1" 2>/dev/null || base64 "$1") && printf '\\033]52;c;%s\\a' "$b64" > /dev/tty; }`,
					"sh",
					tmp,
				],
				{ timeout: 5000 },
			);
			return result.code === 0;
		} catch {
			return false;
		} finally {
			try {
				fs.unlinkSync(tmp);
			} catch {
				/* ignore */
			}
		}
	}

	async function deliverInject(ctx: AnyContext, injectText: string) {
		if (ctx.isIdle()) {
			pi.sendUserMessage(injectText);
		} else {
			pi.sendUserMessage(injectText, { deliverAs: "steer" });
		}
		ctx.ui.notify("Steering prompt sent to the main session", "info");
	}

	async function pickTopic(ctx: AnyContext): Promise<BtwTopic | undefined> {
		if (!topics.length) {
			ctx.ui.notify("No /btw history in this session yet", "info");
			return undefined;
		}
		const sorted = topics.slice().sort((a, b) => b.createdAt - a.createdAt);
		const options = sorted.map((topic) => {
			const first = topic.turns[0];
			const label = first ? first.question : "(empty)";
			return `${new Date(topic.createdAt).toLocaleTimeString()}  ${label.length > 70 ? `${label.slice(0, 70)}…` : label}`;
		});
		const choice = await ctx.ui.select("/btw history", options);
		if (!choice) return undefined;
		return sorted[options.indexOf(choice)];
	}

	function latestTopic(): BtwTopic | undefined {
		return topics.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
	}

	/** Reopen a stored topic in the panel without running a new turn. */
	function reopen(ctx: AnyContext, topic: BtwTopic) {
		const turn = topic.turns[topic.turns.length - 1];
		if (!turn) return;
		if (active?.running) active.abort.abort();
		active = { topic, turn, answer: turn.answer, error: turn.error, running: false, abort: new AbortController() };
		refreshWidget(ctx);
	}

	// -----------------------------------------------------------------------
	// Follow-up window (omp-style: a self-contained side-conversation sheet
	// with its own composer — chaining follow-ups never touches the editor)
	// -----------------------------------------------------------------------

	function openFollowUpWindow(ctx: AnyContext, topic: BtwTopic) {
		if (dialogOpen || followUpTimer) return;
		// Defer out of the terminal-input handler: ui.custom cannot take focus
		// synchronously while the TUI is still dispatching the key that opened it.
		followUpTimer = setTimeout(() => {
			followUpTimer = undefined;
			dialogOpen = true;
			// The sheet and the docked widget would show the same thread — hide
			// the widget while composing; it comes back on close.
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			void ctx.ui
				.custom<void>(
				(tui, theme, _kb, done) => {
					closeFollowUp = () => done(undefined);
					const input = host.createInput({
						prompt: theme.fg("accent", "Follow up: "),
						placeholder: "Ask about this answer…",
					});
					let running = false;
					let notice = "";
					let cachedWidth: number | undefined;
					let cachedLines: string[] | undefined;
					const repaint = () => {
						cachedWidth = undefined;
						cachedLines = undefined;
						tui.requestRender();
					};

					input.onSubmit = (value: string) => {
						const question = value.trim();
						if (!question) return;
						if (running) {
							notice = "Still answering the previous follow-up…";
							repaint();
							return;
						}
						input.setValue("");
						notice = "";
						running = true;
						const turn: BtwTurn = {
							question,
							answer: "",
							status: "running",
							createdAt: Date.now(),
							updatedAt: Date.now(),
						};
						topic.turns.push(turn);
						// Stream into the shared active panel so the docked widget
						// mirrors the window's newest turn.
						if (active?.running) active.abort.abort();
						active = { topic, turn, answer: "", running: true, abort: new AbortController() };
						refreshWidget(ctx);
						const panel = active;
						void (async () => {
							try {
								await runTurn(ctx, topic, question, makeDeltaSink(panel), panel.abort.signal);
								turn.status = "complete";
							} catch (error) {
								if (panel.abort.signal.aborted) {
									turn.status = "cancelled";
								} else {
									turn.status = "error";
									panel.error = error instanceof Error ? error.message : String(error);
								}
							} finally {
								running = false;
								panel.running = false;
								turn.answer = panel.answer;
								turn.error = panel.error;
								turn.updatedAt = Date.now();
								save();
								refreshWidget(ctx);
								repaint();
							}
						})();
						repaint();
					};
					input.onEscape = () => {
						if (running) {
							// First Esc cancels the in-flight answer, second closes.
							active?.abort.abort();
							return;
						}
						done(undefined);
					};

					return {
						get focused() {
							return input.focused;
						},
						set focused(value: boolean) {
							input.focused = value;
						},
						render(width: number): string[] {
							if (cachedLines && cachedWidth === width) return cachedLines;
							cachedWidth = width;
							const inner = Math.max(20, width - 4);
							const latest = topic.turns[topic.turns.length - 1];
							if (latest && active?.turn === latest) {
								latest.answer = active.answer;
								latest.error = active.error;
							}
							const container = new Container();
							const border = new DynamicBorder((s: string) => theme.fg("accent", s));
							container.addChild(border);
							const allLines: string[] = [];
							for (const turn of topic.turns) {
								if (allLines.length) allLines.push("");
								allLines.push(...turnLines(host.ui!, theme, turn, inner - 2, turn === latest));
							}
							for (const line of allLines.slice(-MAX_BODY_LINES)) container.addChild(new Text(line, 1, 0));
							container.addChild(input);
							const hints = running
								? "esc cancel answer"
								: notice || "enter send · esc close";
							container.addChild(new Text(theme.fg("dim", hints), 1, 0));
							container.addChild(border);
							cachedLines = container.render(inner).map((line) => truncateToWidth(line, width));
							return cachedLines;
						},
						handleInput(data: string): void {
							input.handleInput(data);
							repaint();
						},
						invalidate(): void {
							cachedWidth = undefined;
							cachedLines = undefined;
						},
					};
				},
				// Inline dialog, not an overlay: overlay compositing is broken in
				// pi 1.5.0 (even examples/extensions/overlay-test.ts renders
				// invisibly while capturing keys). Inline dialogs take over the
				// interactive area and restore the chat on close — same shape as
				// omp's follow-up sheet.
				)
				.catch((error: unknown) => {
					ctx.ui.notify(
						`Follow-up window failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				})
				.finally(() => {
					closeFollowUp = undefined;
					dialogOpen = false;
					refreshWidget(ctx);
				});
		}, 0);
	}

	// -----------------------------------------------------------------------
	// Command handling
	// -----------------------------------------------------------------------

	async function handleBtw(args: string, ctx: AnyContext) {
		if (!host.isInteractive(ctx)) {
			ctx.ui.notify("/btw requires interactive mode", "warning");
			return;
		}
		ensureInputHook(ctx);
		const trimmed = args.trim();

		// Subcommands
		if (trimmed === "close") {
			closePanel(ctx);
			return;
		}
		if (trimmed === "copy") {
			if (!active) {
				ctx.ui.notify("No active /btw answer", "warning");
				return;
			}
			const ok = await copyToClipboard(splitInject(active.answer).prose || active.answer);
			ctx.ui.notify(ok ? "Answer copied" : "No clipboard tool found (wl-copy/xclip/pbcopy)", ok ? "info" : "warning");
			return;
		}
		if (trimmed === "inject") {
			if (!active) {
				ctx.ui.notify("No active /btw answer", "warning");
				return;
			}
			const { inject } = splitInject(active.answer);
			if (!inject) {
				ctx.ui.notify("The current answer has no <inject> block", "warning");
				return;
			}
			await deliverInject(ctx, inject);
			return;
		}

		// History picker
		if (!trimmed || trimmed === "history") {
			const topic = await pickTopic(ctx);
			if (topic) reopen(ctx, topic);
			return;
		}

		// Follow-up on the current (or most recent) topic
		if (trimmed.startsWith("+")) {
			const question = trimmed.slice(1).trim();
			const topic = active?.topic ?? latestTopic();
			if (!topic) {
				ctx.ui.notify("No /btw topic to follow up on", "warning");
				return;
			}
			if (!question) {
				// Bare "/btw +" opens the follow-up window, like pressing f.
				openFollowUpWindow(ctx, topic);
				return;
			}
			await ask(ctx, topic, question);
			return;
		}

		// New topic
		const topic: BtwTopic = { id: `${Date.now().toString(36)}-${++seq}`, createdAt: Date.now(), turns: [] };
		topics.push(topic);
		await ask(ctx, topic, trimmed);
	}

	pi.registerCommand("btw", {
		description: "Ask an ephemeral side question about the current conversation (no history, no tools)",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				{ value: "+ ", label: "+ <question>", description: "Follow up on the current topic" },
				{ value: "copy", label: "copy", description: "Copy the current answer" },
				{ value: "inject", label: "inject", description: "Send the <inject> steering prompt to the session" },
				{ value: "close", label: "close", description: "Hide the panel" },
				{ value: "history", label: "history", description: "Browse side-question history" },
			];
			const filtered = subs.filter((s) => s.value.startsWith(prefix));
			return filtered.length ? filtered : null;
		},
		handler: handleBtw,
	});

	pi.registerCommand("btw-history", {
		description: "Browse this session's /btw side-question history",
		handler: async (_args, ctx) => handleBtw("history", ctx),
	});

	// While the agent is streaming, typed slash commands are queued as
	// steering/follow-up messages instead of being dispatched. Intercept
	// "/btw ..." submissions in that state so the side question runs NOW,
	// concurrent with the main turn — the whole point of /btw.
	pi.on("input", (rawEvent, ctx) => {
		const event = rawEvent as HostInputEvent;
		if (!host.isStreamingInput(event, ctx)) return undefined; // idle: command dispatch handles /btw
		const text = event.text.trim();
		if (text === "/btw-history") {
			void handleBtw("history", ctx);
			return { action: "handled" as const };
		}
		if (text === "/btw" || text.startsWith("/btw ")) {
			void handleBtw(text.slice(4).trim(), ctx);
			return { action: "handled" as const };
		}
		return undefined;
	});
}

export function createBtwExtension(host: BtwHost): (pi: ExtensionAPI) => void {
	return (pi) => {
		if (!host.shouldRegister(pi) || !host.supported || !host.ui) return;
		registerBtw(pi, host);
	};
}

export default createBtwExtension(runtimeHost);

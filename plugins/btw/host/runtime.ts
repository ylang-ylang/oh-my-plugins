import { createPiHost, createUnsupportedHost } from "./pi.ts";
import type { BtwHost } from "./types.ts";

export type PiModuleLoader = (specifier: string) => Promise<Record<string, unknown>>;

export async function loadPiModule(specifier: string): Promise<Record<string, unknown>> {
	switch (specifier) {
		case "@oh-my-pi/pi-coding-agent":
			return import("@oh-my-pi/pi-coding-agent");
		case "@earendil-works/pi-coding-agent":
			return import("@earendil-works/pi-coding-agent");
		case "@earendil-works/pi-tui":
			return import("@earendil-works/pi-tui");
		case "@earendil-works/pi-ai":
			return import("@earendil-works/pi-ai");
		case "@mariozechner/pi-coding-agent":
			return import("@mariozechner/pi-coding-agent");
		case "@mariozechner/pi-tui":
			return import("@mariozechner/pi-tui");
		case "@mariozechner/pi-ai":
			return import("@mariozechner/pi-ai");
		default:
			throw new Error(`Unsupported Pi module request: ${specifier}`);
	}
}

const MISSING_MODULE_CODES: Record<string, true> = {
	ERR_MODULE_NOT_FOUND: true,
	MODULE_NOT_FOUND: true,
};
const MISSING_TARGET_PATTERNS = [
	/Cannot find package ['"]([^'"]+)['"]/,
	/Cannot find module ['"]([^'"]+)['"]/,
	/Cannot resolve module ['"]([^'"]+)['"]/,
	/Failed to resolve import ['"]([^'"]+)['"]/,
];

function isDirectModuleAbsence(error: unknown, specifier: string): boolean {
	if (typeof error !== "object" || error === null) return false;
	const record = error as { code?: unknown; message?: unknown; request?: unknown; specifier?: unknown };
	if (typeof record.code !== "string" || MISSING_MODULE_CODES[record.code] !== true) return false;
	if (typeof record.message === "string") {
		for (const pattern of MISSING_TARGET_PATTERNS) {
			const target = record.message.match(pattern)?.[1];
			if (target !== undefined) return target === specifier;
		}
	}
	if (typeof record.request === "string") return record.request === specifier;
	if (typeof record.specifier === "string") return record.specifier === specifier;
	return false;
}

async function optionalModule(load: PiModuleLoader, specifier: string): Promise<Record<string, unknown> | undefined> {
	try {
		return await load(specifier);
	} catch (error) {
		if (isDirectModuleAbsence(error, specifier)) return undefined;
		throw error;
	}
}

export async function loadRuntimeHost(load: PiModuleLoader = loadPiModule): Promise<BtwHost> {

	const current = await optionalModule(load, "@earendil-works/pi-coding-agent");
	if (current) {
		const [tui, ai] = await Promise.all([
			optionalModule(load, "@earendil-works/pi-tui"),
			optionalModule(load, "@earendil-works/pi-ai"),
		]);
		if (!tui) {
			const version = typeof current.VERSION === "string" ? current.VERSION : "unknown";
			return createUnsupportedHost(
				"unsupported",
				`pi-btw skipped: Pi ${version} was found but @earendil-works/pi-tui could not be loaded.`,
				version,
			);
		}
		return createPiHost({ packageName: "@earendil-works/pi-coding-agent", coding: current, tui, ai });
	}

	const legacy = await optionalModule(load, "@mariozechner/pi-coding-agent");
	if (legacy) {
		const [tui, ai] = await Promise.all([
			optionalModule(load, "@mariozechner/pi-tui"),
			optionalModule(load, "@mariozechner/pi-ai"),
		]);
		if (!tui) {
			const version = typeof legacy.VERSION === "string" ? legacy.VERSION : "unknown";
			return createUnsupportedHost(
				"unsupported",
				`pi-btw skipped: Pi ${version} was found but @mariozechner/pi-tui could not be loaded.`,
				version,
			);
		}
		return createPiHost({ packageName: "@mariozechner/pi-coding-agent", coding: legacy, tui, ai });
	}

	const omp = await optionalModule(load, "@oh-my-pi/pi-coding-agent");
	if (omp) {
		const version = typeof omp.VERSION === "string" ? omp.VERSION : "unknown";
		return createUnsupportedHost(
			"omp",
			`pi-btw skipped on Oh My Pi ${version}: OMP already provides the native /btw command; the external Pi plugin was not registered.`,
			version,
		);
	}

	return createUnsupportedHost(
		"unsupported",
		"pi-btw skipped: no supported Pi host package was available (source-checked: 0.73.1, 0.74.0, 1.5.0).",
	);
}

export const runtimeHost = await loadRuntimeHost();

/**
 * Server-Sent Events (SSE) connection management for model loading progress.
 * Each backend maintains its own SSE connection.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { MODEL_LOAD_STAGE_LABELS, getSseUrl, parseSseDataLines, splitSseEvents } from "./discovery";
import type { ApiModelsSseData, ApiModelsSseEvent } from "./discovery";
import type { DiscoveredModel } from "./types";

// ---------------------------------------------------------------------------
// Stale context detection
// ---------------------------------------------------------------------------

function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("stale after session replacement");
}

// ---------------------------------------------------------------------------
// SSE connection management
// ---------------------------------------------------------------------------

export class SseManager {
	private connections = new Map<string, { abortController: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> | null }>();
	private providerId: string;
	private baseUrl: string;
	private currentModels: DiscoveredModel[];
	// Change 4: callback to clear the failedProps cache entry when a model loads
	private onModelLoadedCallback: ((providerId: string, modelId: string) => void) | null = null;

	constructor(providerId: string, baseUrl: string, currentModels: DiscoveredModel[]) {
		this.providerId = providerId;
		this.baseUrl = baseUrl;
		this.currentModels = currentModels;
	}

	/** Register a callback invoked when SSE reports a model as loaded. */
	setOnLoadedCallback(callback: (providerId: string, modelId: string) => void): void {
		this.onModelLoadedCallback = callback;
	}

	/** Close all SSE connections for this manager (called on shutdown). */
	closeAll(): void {
		for (const [, conn] of this.connections) {
			conn.abortController.abort();
			conn.reader?.cancel();
		}
		this.connections.clear();
	}

	/**
	 * Start an SSE connection for monitoring model loading progress.
	 * Only one active connection per backend at a time.
	 */
	async connectToLoadingProgress(
		modelId: string,
		ctx: ExtensionContext,
		loader: Loader | null,
		onStatusUpdate: (modelId: string, status: string) => void,
		onLoadFailed: (modelId: string, exitCode: number) => void,
		onLoaded: (modelId: string) => void,
	): Promise<void> {
		// Close any existing SSE connection for this model
		this.disconnect(modelId);

		const abortController = new AbortController();
		const signal = abortController.signal;

		this.connections.set(modelId, { abortController, reader: null });

		try {
			const response = await fetch(getSseUrl(this.baseUrl), { signal });

			if (!response.ok) {
				if (response.status !== 404) {
					ctx.ui.notify(`[llama-cpp] loading progress ${response.status})`, "warning");
				}
				return;
			}

			const reader = response.body?.getReader();
			if (!reader) return;

			this.connections.get(modelId)!.reader = reader;

			const decoder = new TextDecoder();
			let buffer = "";

			while (!signal.aborted) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const { events, leftover } = splitSseEvents(buffer);
				buffer = leftover;

				for (const event of events) {
					if (!event) continue;

					const dataLines = parseSseDataLines(event);
					if (!dataLines) continue;

					try {
						const sseEvent: ApiModelsSseEvent = JSON.parse(dataLines);
						this.processSseEvent(sseEvent, modelId, ctx, loader, onStatusUpdate, onLoadFailed, onLoaded);
					} catch {
						// Ignore parse errors
					}
				}
			}
		} catch (error) {
			const msg = (error as Error).message;
			if (
				isStaleContextError(error) ||
				(signal.aborted && (error instanceof DOMException || msg === "terminated"))
			) {
				return;
			}
			ctx.ui.notify(`[llama-cpp] SSE error: ${msg}`, "warning");
		} finally {
			this.disconnect(modelId);
		}
	}

	/** Disconnect the SSE stream for a specific model. */
	disconnect(modelId: string): void {
		const existing = this.connections.get(modelId);
		if (existing) {
			existing.abortController.abort();
			existing.reader?.cancel();
			this.connections.delete(modelId);
		}
	}

	/** Process a single SSE event. */
	private processSseEvent(
		sseEvent: ApiModelsSseEvent,
		requestedModelId: string,
		ctx: ExtensionContext,
		loader: Loader | null,
		onStatusUpdate: (modelId: string, status: string) => void,
		onLoadFailed: (modelId: string, exitCode: number) => void,
		onLoaded: (modelId: string) => void,
	): void {
		const { model: eventModel, event: eventType, data } = sseEvent;
		const currentModel = this.currentModels.find((m) => m.id === eventModel);
		const displayName = currentModel?.name.split(" ")[0] || eventModel;

		// Track loaded/unloaded status (for all models, not just the requested one)
		if (eventType === "model_status" || eventType === "status_change" || eventType === "status_update") {
			if (data.status === "loaded") {
				onLoaded(eventModel);
				// Change 4: signal index.ts to clear the stale failedProps entry
				this.onModelLoadedCallback?.(this.providerId, eventModel);
			}
		}

		// Progress UI is only for the model we're actively loading
		if (eventModel !== requestedModelId) return;

		// Handle load failure
		if (data.exit_code && data.exit_code !== 0) {
			onLoadFailed(requestedModelId, data.exit_code);
			return;
		}

		// Handle loading progress
		if (data.status === "loading" && data.progress) {
			const stageLabel = data.progress.current
				? MODEL_LOAD_STAGE_LABELS[data.progress.current] || data.progress.current
				: "Loading";
			const progressPercent = Math.round(data.progress.value * 100);
			const loaderMessage = `${displayName}: ${stageLabel} (${progressPercent}%)`;
			loader?.setMessage(loaderMessage);
		}

		onStatusUpdate(requestedModelId, data.status);
	}

	/** Update the model list (called when models are refreshed). */
	updateModels(models: DiscoveredModel[]): void {
		this.currentModels = models;
	}
}

// ---------------------------------------------------------------------------
// Model loading state tracker
// ---------------------------------------------------------------------------

export class ModelLoadTracker {
	/** Track which model is currently loaded on each backend. */
	private loadedModels = new Map<string, string | null>();

	getLoadedModel(providerId: string): string | null {
		return this.loadedModels.get(providerId) ?? null;
	}

	setLoadedModel(providerId: string, modelId: string | null): void {
		this.loadedModels.set(providerId, modelId);
	}

	isModelLoaded(providerId: string, modelId: string): boolean {
		return this.loadedModels.get(providerId) === modelId;
	}
}

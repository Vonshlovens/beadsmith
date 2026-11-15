/**
 * Sandboxed apps as the `/api/apps` routes return them (ADR-0025 rule 3).
 * The spec's shape is the one the server's strict schema produces
 * (`src/lib/server/grown/app-spec.ts`); it is imported as a type only, so
 * no server code reaches the browser. The document itself is never run by
 * the page: it runs in the sandboxed frame `/api/apps/:slug/frame` serves.
 */
import type { GrownRevisionView, GrownSummary } from '#lib/grown.js';
import type { AppSpec } from '#lib/server/grown/app-spec.js';
import type { SurfaceBindingResult } from '#lib/surfaces.js';

export type AppSpecShape = AppSpec;

/** An app as this viewer sees it (see `GrownSummary`). */
export type AppSummary = GrownSummary<AppSpecShape>;

export type AppRevisionView = GrownRevisionView<AppSpecShape>;

export interface AppsResponse {
	apps: AppSummary[];
}

export interface AppResponse {
	app: AppSummary;
}

export interface AppHistoryResponse {
	revisions: AppRevisionView[];
}

/**
 * Most bytes in one bridge frame, in either direction (ADR-0025 limits):
 * the host drops a bigger message from the app, and the server refuses a
 * bigger call body.
 */
export const BRIDGE_FRAME_MAX_BYTES = 64 * 1024;

/**
 * `POST /api/apps/:slug/call`: one allowlisted read run as the viewer.
 * `result` is a refusal value (not an HTTP error) when the tool refused, so
 * the host can hand the app an MCP tool error it can show.
 */
export interface AppToolCallResponse {
	slug: string;
	/** The revision the viewer sees, so the host can tell the app was revised. */
	revision: number;
	name: string;
	result: SurfaceBindingResult;
}

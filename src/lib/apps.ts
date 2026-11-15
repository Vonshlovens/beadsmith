/**
 * Sandboxed apps as the `/api/apps` routes return them (ADR-0025 rule 3).
 * The spec's shape is the one the server's strict schema produces
 * (`src/lib/server/grown/app-spec.ts`); it is imported as a type only, so
 * no server code reaches the browser. The document itself is never run by
 * the page: it runs in the sandboxed frame `/api/apps/:slug/frame` serves.
 */
import type { GrownRevisionView, GrownSummary } from '#lib/grown.js';
import type { AppSpec } from '#lib/server/grown/app-spec.js';

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

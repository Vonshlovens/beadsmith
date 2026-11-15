/**
 * Catalog surfaces as the `/api/surfaces` routes return them (ADR-0025
 * rule 2). The spec's shape is the one the server's strict schema produces
 * (`src/lib/server/grown/surface-spec.ts`); it is imported as a type only,
 * so no server code reaches the browser.
 */
import type { GrownRevisionView, GrownSummary } from '#lib/grown.js';
import type { ApiErrorCode } from '#lib/types.js';
import type { SurfaceSpec } from '#lib/server/grown/surface-spec.js';
import type { BridgeYield } from '#lib/server/grown/bridge.js';

export type SurfaceSpecShape = SurfaceSpec;

/** A surface as this viewer sees it (see `GrownSummary`). */
export type SurfaceSummary = GrownSummary<SurfaceSpecShape>;

export type SurfaceRevisionView = GrownRevisionView<SurfaceSpecShape>;

export interface SurfacesResponse {
	surfaces: SurfaceSummary[];
}

export interface SurfaceResponse {
	surface: SurfaceSummary;
}

export interface SurfaceHistoryResponse {
	revisions: SurfaceRevisionView[];
}

/**
 * One data binding resolved as the viewer (`GET /api/surfaces/:slug/data`).
 * `data` is the crew read tool's result, or for a view binding the same
 * `issues` shape `ready_work` returns. `truncated` means whole items were
 * dropped to fit the bridge's result limit; `data.total` is then the full
 * count. A failed binding is a value beside the others, not a failed request.
 */
export type SurfaceBindingResult =
	| {
			ok: true;
			yields: BridgeYield;
			data: unknown;
			truncated?: true;
	  }
	| { ok: false; code: ApiErrorCode; message: string };

export interface SurfaceDataResponse {
	slug: string;
	/** The revision whose bindings were resolved: the one this viewer sees. */
	revision: number;
	bindings: Record<string, SurfaceBindingResult>;
}

/**
 * Catalog surfaces as the `/api/surfaces` routes return them (ADR-0025
 * rule 2). The spec's shape is the one the server's strict schema produces
 * (`src/lib/server/grown/surface-spec.ts`); it is imported as a type only,
 * so no server code reaches the browser.
 */
import type { GrownRevisionView, GrownSummary } from '#lib/grown.js';
import type { SurfaceSpec } from '#lib/server/grown/surface-spec.js';

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

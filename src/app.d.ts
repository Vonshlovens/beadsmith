// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Session id established by `hooks.server.ts`; empty when unauthenticated. */
			session_id: string;
			/** Signed-in Beadsmith account; set only when accounts are enabled (ADR-0011). */
			user?: {
				id: string;
				email: string;
				name: string;
				role: 'admin' | 'member';
			};
			/**
			 * Effective role: the account's role, or `member` for an Access service
			 * token. Unset while signed out.
			 */
			role?: 'admin' | 'member';
			/** Signed Cloudflare Access identity, never derived from an unsigned header. */
			cloudflare_access?: {
				kind: 'human' | 'service_token';
				subject: string;
				email?: string;
			};
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

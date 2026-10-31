import { describe, expect, it, vi } from 'vitest';
import {
	DOLT_PASSWORD_FILE_ENV,
	DoltCredentialError,
	resolveDoltPassword
} from './dolt-password.js';

describe('resolveDoltPassword', () => {
	it('uses the protected environment value', async () => {
		const password = await resolveDoltPassword({
			env: { BEADS_DOLT_PASSWORD: 'from-environment' }
		});

		expect(password).toBe('from-environment');
	});

	it('uses a protected file in preference to the development environment value', async () => {
		const readFile = vi.fn(async () => {
			return 'from-file';
		});

		const password = await resolveDoltPassword({
			env: {
				[DOLT_PASSWORD_FILE_ENV]: '/run/credentials/beads-web.service/dolt-password',
				BEADS_DOLT_PASSWORD: 'from-environment'
			},
			readFile
		});

		expect(password).toBe('from-file');
		expect(readFile).toHaveBeenCalledWith('/run/credentials/beads-web.service/dolt-password');
	});

	it('removes one terminal line ending from a credential file', async () => {
		await expect(
			resolveDoltPassword({
				env: { [DOLT_PASSWORD_FILE_ENV]: '/credential' },
				readFile: async () => {
					return 'from-file\r\n';
				}
			})
		).resolves.toBe('from-file');

		await expect(
			resolveDoltPassword({
				env: { [DOLT_PASSWORD_FILE_ENV]: '/credential' },
				readFile: async () => {
					return 'from-file\n\n';
				}
			})
		).resolves.toBe('from-file\n');
	});

	it('preserves intentional credential whitespace', async () => {
		await expect(
			resolveDoltPassword({
				env: { [DOLT_PASSWORD_FILE_ENV]: '/credential' },
				readFile: async () => {
					return ' leading and trailing \n';
				}
			})
		).resolves.toBe(' leading and trailing ');
	});

	it('fails safely when no protected credential is configured', async () => {
		await expect(resolveDoltPassword({ env: {} })).rejects.toEqual(
			expect.objectContaining({
				name: 'DoltCredentialError',
				message:
					'Protected Dolt authentication is unavailable. Check the service credential configuration.'
			})
		);
	});

	it('fails closed and safely when a credential file is unreadable or empty', async () => {
		for (const readFile of [
			async () => {
				throw new Error('permission denied for /private/credential');
			},
			async () => {
				return '\n';
			}
		]) {
			const error = await resolveDoltPassword({
				env: {
					[DOLT_PASSWORD_FILE_ENV]: '/private/credential',
					BEADS_DOLT_PASSWORD: 'development-fallback-must-not-win'
				},
				readFile
			}).catch((caught: unknown) => {
				return caught;
			});

			expect(error).toBeInstanceOf(DoltCredentialError);
			expect((error as Error).message).not.toContain('/private/credential');
			expect((error as Error).message).not.toContain('permission denied');
			expect((error as Error).message).not.toContain('development-fallback-must-not-win');
		}
	});
});

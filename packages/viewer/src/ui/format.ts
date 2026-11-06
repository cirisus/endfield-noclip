import type { SceneControl } from '@endfield-noclip/package-format/states';

/**
 * @param bytes byte count
 * @returns e.g. `12.3 MiB`
 */
export const formatBytes = (bytes: number): string => {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 ** 2) {
		return `${(bytes / 1024).toFixed(1)} KiB`;
	}
	if (bytes < 1024 ** 3) {
		return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	}
	return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
};

/**
 * @param n a count
 * @returns e.g. `1.2M`, `34.5k`, `950`
 */
export const formatCount = (n: number): string => {
	if (n >= 1e6) {
		return `${(n / 1e6).toFixed(2)}M`;
	}
	if (n >= 1e4) {
		return `${(n / 1e3).toFixed(1)}k`;
	}
	return String(n);
};

/**
 * @param err something thrown
 * @returns its message
 */
export const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * @param control a scene control
 * @returns the label of the option that leaves the control to the camera or the game, or `null` if only the
 *   user sets it
 */
export const followLabel = (control: SceneControl): string | null => {
	if (control.followsCamera) {
		return 'Follow camera';
	}
	if (control.derived !== null) {
		return 'Follow game';
	}
	return null;
};

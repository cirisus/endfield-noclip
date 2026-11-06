import { isPointView, type PointView } from '@endfield-noclip/package-format/oem';
import type { Vec3 } from '@endfield-noclip/package-format/values';

import type { CameraPose } from './noclip-controls.ts';

const PREFIX = 'noclip-point-view-v7:';
const LIMIT = 512;

/**
 * @param generation immutable scene generation
 * @param level shown level
 * @param target authored coordinates
 * @param shown effective progression and area visibility
 * @returns compact key invalidated by geometry, conditions or framing algorithm changes
 */
export const pointViewKey = async (
	generation: string,
	level: string | null,
	target: Vec3,
	shown: readonly boolean[],
): Promise<string> => {
	const bytes = new TextEncoder().encode(JSON.stringify([generation, level, target, shown]));
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return PREFIX + Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
};

/**
 * @param key versioned point-view key
 * @returns validated local pose, or null when unavailable; blocked storage never prevents preview
 */
export const readPointView = (
	key: string,
): (CameraPose & Partial<Pick<PointView, 'clear' | 'interactions'>>) | null => {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
		if (
			!value ||
			typeof value !== 'object' ||
			!('position' in value) ||
			!Array.isArray(value.position) ||
			value.position.length !== 3 ||
			!value.position.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
			!('yaw' in value) ||
			typeof value.yaw !== 'number' ||
			!Number.isFinite(value.yaw) ||
			!('pitch' in value) ||
			typeof value.pitch !== 'number' ||
			!Number.isFinite(value.pitch)
		) {
			return null;
		}
		if ('interactions' in value && !isPointView({ ...value, key })) {
			return null;
		}
		const candidate = { ...value, key };
		const metadata = isPointView(candidate) ? candidate : null;
		return {
			...(metadata ? { clear: metadata.clear, interactions: metadata.interactions } : {}),
			position: [value.position[0], value.position[1], value.position[2]],
			yaw: value.yaw,
			pitch: value.pitch,
		};
	} catch {
		return null;
	}
};

/**
 * @param key versioned point-view key
 * @param pose checked view to retain across reloads and preview windows
 */
export const writePointView = (key: string, pose: CameraPose): void => {
	try {
		const keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX));
		for (const old of keys.slice(0, Math.max(0, keys.length - LIMIT + 1))) {
			localStorage.removeItem(old);
		}
		localStorage.setItem(key, JSON.stringify(pose));
	} catch {
		/* storage is optional, including in private or quota-limited sessions */
	}
};

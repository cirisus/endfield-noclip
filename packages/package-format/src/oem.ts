import type { PackageManifest } from './manifest.ts';
import type { ConditionalSetInfo, ControlDriver, MissionInfo, SceneControl } from './states.ts';
import type { Vec3 } from './values.ts';

/** version of the static companion data and cross-window message contract */
export const OEM_VERSION = 1;

/** one immutable OEM preview release; all paths are relative to this catalog */
export interface Catalog {
	format: 'oem-noclip';
	version: typeof OEM_VERSION;
	release: string;
	source: PackageManifest['source'];
	packages: Record<string, { path: string; generation: string; version: number }>;
	files: Record<string, string>;
	pointIndex: Record<string, string>;
	framing?: { version: 3; profile: 'completed'; points: number };
}

/** an authored, validated selection of scene values */
export interface Preset {
	id: string;
	label: string;
	picks: Record<string, number>;
	satisfies: boolean;
}

/** A completed-profile camera pose bound to scene generation and effective visibility. */
export interface PointView {
	key: string;
	position: Vec3;
	yaw: number;
	pitch: number;
	clear: boolean;
}

/** point metadata, separate from map marker tuples and renderer archives */
export interface Point {
	id: string;
	scene: string;
	level: string;
	region: string;
	subregion: string;
	tier: number;
	position: Vec3;
	condition: ConditionalSetInfo | null;
	locks: { kind: string; quests: string[]; games: string[] }[];
	drivers: ControlDriver[];
	unknown: string[];
	presets: Preset[];
	view?: PointView;
	source: { path: string; kind: string; createState: number | null };
}

/** one subregion's lightweight metadata; controls include point-only quest states */
export interface Companion {
	version: typeof OEM_VERSION;
	release: string;
	controls: SceneControl[];
	missions: MissionInfo[];
	labels: Record<string, Record<string, string>>;
	points: Point[];
}

const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const dictionary = (value: unknown): value is Record<string, string> =>
	object(value) && Object.values(value).every((v) => typeof v === 'string');
const numbers = (value: unknown): value is Record<string, number> =>
	object(value) && Object.values(value).every((v) => Number.isInteger(v) && Number(v) >= 0 && Number(v) < 32);
const strings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((v) => typeof v === 'string');
const relative = (value: string): boolean =>
	!value.startsWith('/') && !value.includes('..') && /^[A-Za-z0-9_./-]+$/.test(value);
/** @param value decoded pose @returns whether its framing key and camera values are valid */
export const isPointView = (value: unknown): value is PointView =>
	object(value) &&
	typeof value.key === 'string' &&
	/^noclip-point-view-v3:[a-f0-9]{64}$/.test(value.key) &&
	Array.isArray(value.position) &&
	value.position.length === 3 &&
	value.position.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
	typeof value.yaw === 'number' &&
	Number.isFinite(value.yaw) &&
	typeof value.pitch === 'number' &&
	Number.isFinite(value.pitch) &&
	Math.abs(value.pitch) <= Math.PI / 2 &&
	typeof value.clear === 'boolean';

const validPoint = (value: unknown): value is Point => {
	if (
		!object(value) ||
		!['id', 'scene', 'level', 'region', 'subregion'].every((key) => typeof value[key] === 'string') ||
		!Number.isInteger(value.tier) ||
		!Array.isArray(value.position) ||
		value.position.length !== 3 ||
		!value.position.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
		!strings(value.unknown) ||
		(value.view !== undefined && !isPointView(value.view))
	) {
		return false;
	}
	if (
		value.condition !== null &&
		(!object(value.condition) ||
			!Array.isArray(value.condition.alternatives) ||
			!value.condition.alternatives.every(
				(alt) =>
					Array.isArray(alt) &&
					alt.every((r) => object(r) && typeof r.control === 'string' && Number.isInteger(r.mask)),
			))
	) {
		return false;
	}
	return (
		Array.isArray(value.presets) &&
		value.presets.length > 0 &&
		value.presets.every(
			(p) =>
				object(p) &&
				typeof p.id === 'string' &&
				typeof p.label === 'string' &&
				typeof p.satisfies === 'boolean' &&
				numbers(p.picks),
		) &&
		Array.isArray(value.locks) &&
		value.locks.every(
			(lock) => object(lock) && typeof lock.kind === 'string' && strings(lock.quests) && strings(lock.games),
		)
	);
};

/** only OEM origins can own a preview or supply its embedded minimap */
export const isOEMOrigin = (value: string): boolean => {
	try {
		const url = new URL(value);
		return (
			url.origin === value &&
			((url.protocol === 'https:' && /^(beta\.)?opendfieldmap\.(cn|org)$/.test(url.hostname)) ||
				(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
		);
	} catch {
		return false;
	}
};

/** @param value decoded JSON @returns whether its top-level release contract is recognized */
export const isCatalog = (value: unknown): value is Catalog => {
	return (
		object(value) &&
		value.format === 'oem-noclip' &&
		value.version === OEM_VERSION &&
		typeof value.release === 'string' &&
		object(value.source) &&
		typeof value.source.buildGuid === 'string' &&
		typeof value.source.contentHash === 'string' &&
		object(value.packages) &&
		Object.values(value.packages).every(
			(p) =>
				object(p) &&
				typeof p.path === 'string' &&
				relative(p.path) &&
				typeof p.generation === 'string' &&
				Number.isInteger(p.version),
		) &&
		dictionary(value.files) &&
		Object.values(value.files).every(relative) &&
		dictionary(value.pointIndex) &&
		(value.framing === undefined ||
			(object(value.framing) &&
				value.framing.version === 3 &&
				value.framing.profile === 'completed' &&
				Number.isInteger(value.framing.points)))
	);
};

/** @param value decoded JSON @returns whether its companion envelope is recognized */
export const isCompanion = (value: unknown): value is Companion =>
	object(value) &&
	value.version === OEM_VERSION &&
	typeof value.release === 'string' &&
	Array.isArray(value.controls) &&
	value.controls.every(
		(c) =>
			object(c) &&
			['quest', 'mission'].includes(String(c.kind)) &&
			typeof c.id === 'string' &&
			typeof c.name === 'string' &&
			c.derived === null &&
			Array.isArray(c.values) &&
			c.values.every((v) => object(v) && Number.isInteger(v.value) && typeof v.label === 'string'),
	) &&
	Array.isArray(value.missions) &&
	value.missions.every((m) => object(m) && typeof m.id === 'string') &&
	object(value.labels) &&
	Object.values(value.labels).every(dictionary) &&
	Array.isArray(value.points) &&
	value.points.every(validPoint);

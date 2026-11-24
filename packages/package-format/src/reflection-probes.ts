import { checkedEnum, enumGuard, viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	type ContainerSectionInput,
} from './container.ts';
import type { Vec3 } from './values.ts';

/**
 * `tables/reflection-probes.bin.zst` (`EFRP` v1 TLV container): the scene's local reflection probes, loaded
 * optionally with the core. a viewer shades with the resident probes whose visibility group shows, sorted by
 * importance (higher wins) over the sky reflection cubemap.
 */
export interface ReflectionProbesTable {
	probes: ReflectionProbeEntry[];
}

/** {@link ReflectionProbeEntry.shape} values */
export const ReflectionProbeShape = {
	Box: 0,
	Sphere: 1,
} as const;

export type ReflectionProbeShape = (typeof ReflectionProbeShape)[keyof typeof ReflectionProbeShape];

/** one local reflection probe, with the fields the game's deferred indirect lighting reads */
export interface ReflectionProbeEntry {
	/** the game's entity id, for tracing the probe back */
	entityId: number;
	/** index into `StatesInfo.groups`: the owning level and the scene states that load the probe */
	group: number;
	/** index into `TextureTable`: the probe's prefiltered BC6H cubemap */
	texture: number;
	shape: ReflectionProbeShape;
	boxProjection: boolean;
	/** higher importance blends over lower importance */
	importance: number;
	/** scales the probe's radiance (`m_IntensityMultiplier`) */
	intensity: number;
	/** world-space centre of the probe volume */
	center: Vec3;
	/** world-space AABB half extents, for frustum culling */
	boundsExtents: Vec3;
	/** probe-local box half extents (`m_BoxSize * 0.5`; x holds radius for sphere probes) */
	halfExtents: Vec3;
	/** reciprocal blend width per local axis: `1 / max((1 − influenceScale) · halfExtents, 1e−4)` */
	invBlendDistance: Vec3;
	/** world → probe-local unscaled transform (`rows3x4`, 12 floats) */
	worldToLocal: number[];
	/**
	 * Rec. 709 luminance L1 SH of the probe's baked SH (`_m0` in `_ReflectionProbeGlobalDatas`), for
	 * normalising reflections against local diffuse irradiance
	 */
	lumaSh: [number, number, number, number];
}

const MAGIC = fourcc('EFRP');
const MAJOR_VERSION = 1;
const TAG_PRBS = fourcc('PRBS');
const KNOWN_TAGS = new Set([TAG_PRBS]);

const PROBE_FLAG_BOX_PROJECTION = 1 << 0;
const PROBE_SIZE = 140;

const isProbeShape = enumGuard(ReflectionProbeShape);

/**
 * encodes `tables/reflection-probes.bin.zst` (before its zstd frame) as an `EFRP` v1 TLV container
 *
 * @param table local reflection probes table
 * @returns encoded binary bytes
 */
export const encodeReflectionProbesTable = (table: ReflectionProbesTable): Uint8Array => {
	const { probes } = table;
	const buf = new Uint8Array(probes.length * PROBE_SIZE);
	const view = viewOf(buf);

	for (const [i, probe] of probes.entries()) {
		if (probe.worldToLocal.length !== 12) {
			throw new RangeError(`reflection probe ${i} worldToLocal must have 12 floats`);
		}
		const at = i * PROBE_SIZE;
		view.setUint8(at, probe.shape);
		view.setUint8(at + 1, probe.boxProjection ? PROBE_FLAG_BOX_PROJECTION : 0);
		view.setInt16(at + 2, probe.importance, true);
		view.setUint32(at + 4, probe.group, true);
		view.setFloat64(at + 8, probe.entityId, true);
		view.setUint32(at + 16, probe.texture, true);
		view.setFloat32(at + 20, probe.intensity, true);
		view.setFloat32(at + 24, probe.center[0], true);
		view.setFloat32(at + 28, probe.center[1], true);
		view.setFloat32(at + 32, probe.center[2], true);
		view.setFloat32(at + 36, probe.boundsExtents[0], true);
		view.setFloat32(at + 40, probe.boundsExtents[1], true);
		view.setFloat32(at + 44, probe.boundsExtents[2], true);
		view.setFloat32(at + 48, probe.halfExtents[0], true);
		view.setFloat32(at + 52, probe.halfExtents[1], true);
		view.setFloat32(at + 56, probe.halfExtents[2], true);
		view.setFloat32(at + 60, probe.invBlendDistance[0], true);
		view.setFloat32(at + 64, probe.invBlendDistance[1], true);
		view.setFloat32(at + 68, probe.invBlendDistance[2], true);
		for (let m = 0; m < 12; m++) {
			view.setFloat32(at + 72 + m * 4, probe.worldToLocal[m], true);
		}
		view.setFloat32(at + 120, probe.lumaSh[0], true);
		view.setFloat32(at + 124, probe.lumaSh[1], true);
		view.setFloat32(at + 128, probe.lumaSh[2], true);
		view.setFloat32(at + 132, probe.lumaSh[3], true);
	}

	const sections: ContainerSectionInput[] = [
		{ tag: TAG_PRBS, required: true, data: buf, count: probes.length, stride: PROBE_SIZE },
	];
	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes `tables/reflection-probes.bin.zst` (`EFRP` v1 TLV container, inflated)
 *
 * @param data inflated reflection probes table bytes
 * @returns decoded local reflection probes table
 * @throws {PackageFormatError} on invalid container or shape
 */
export const decodeReflectionProbesTable = (data: Uint8Array): ReflectionProbesTable => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'reflection probes table',
	});
	const sec = requireSection(container, TAG_PRBS, 'reflection probes table');
	checkStride(sec, PROBE_SIZE, 'PRBS');

	const view = viewOf(sec.data);
	const probes: ReflectionProbeEntry[] = [];
	for (let i = 0; i < sec.count; i++) {
		const at = i * sec.stride;
		const shape = checkedEnum(isProbeShape, view.getUint8(at), `reflection probe ${i} shape`);
		const flags = view.getUint8(at + 1);
		const worldToLocal: number[] = [];
		for (let m = 0; m < 12; m++) {
			worldToLocal.push(view.getFloat32(at + 72 + m * 4, true));
		}
		probes.push({
			entityId: view.getFloat64(at + 8, true),
			group: view.getUint32(at + 4, true),
			texture: view.getUint32(at + 16, true),
			shape,
			boxProjection: (flags & PROBE_FLAG_BOX_PROJECTION) !== 0,
			importance: view.getInt16(at + 2, true),
			intensity: view.getFloat32(at + 20, true),
			center: [
				view.getFloat32(at + 24, true),
				view.getFloat32(at + 28, true),
				view.getFloat32(at + 32, true),
			],
			boundsExtents: [
				view.getFloat32(at + 36, true),
				view.getFloat32(at + 40, true),
				view.getFloat32(at + 44, true),
			],
			halfExtents: [
				view.getFloat32(at + 48, true),
				view.getFloat32(at + 52, true),
				view.getFloat32(at + 56, true),
			],
			invBlendDistance: [
				view.getFloat32(at + 60, true),
				view.getFloat32(at + 64, true),
				view.getFloat32(at + 68, true),
			],
			worldToLocal,
			lumaSh: [
				view.getFloat32(at + 120, true),
				view.getFloat32(at + 124, true),
				view.getFloat32(at + 128, true),
				view.getFloat32(at + 132, true),
			],
		});
	}
	return { probes };
};

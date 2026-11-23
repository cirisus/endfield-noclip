import { checkedEnum, enumGuard, viewOf } from './binary.ts';
import {
	checkStride,
	decodeContainer,
	encodeContainer,
	fourcc,
	requireSection,
	type ContainerSectionInput,
} from './container.ts';
import { PackageFormatError } from './errors.ts';
import type { Vec3 } from './values.ts';

/**
 * `tables/lights.bin.zst` (`EFLT` v2 TLV container): the scene's local point and spot lights, loaded with the
 * core. a viewer lights with the ones whose group shows, like instances. the game's directional lights,
 * lights that only cast shadows and lights that only light characters are left out, as are the shadows of
 * lights that move or shadow only moving objects
 */
export interface LightsTable {
	lights: LightEntry[];
}

/** {@link LightEntry.kind} values */
export const LightKind = {
	Spot: 0,
	/** a point, or a tube along {@link LightEntry.direction} when {@link LightEntry.tubeLength} is positive */
	Point: 1,
} as const;

export type LightKind = (typeof LightKind)[keyof typeof LightKind];

/** one local light, with the fields the game's shading reads */
export interface LightEntry {
	kind: LightKind;
	/**
	 * the game's entity id, for tracing the light back; a light inside a placed prefab has a synthetic one,
	 * like the prefab's renderers. ownership and loading come from {@link group}
	 */
	entityId: number;
	/** index into `StatesInfo.groups`: the owning level and the scene states that load the light */
	group: number;
	position: Vec3;
	/** unit direction the light points along (a spot's axis, a tube's segment) */
	direction: Vec3;
	/**
	 * linear colour times intensity and colour-temperature tint, in the units the shading adds to the scene as
	 * they are (the game doesn't pre-expose local lights)
	 */
	color: Vec3;
	/** metres; the light reaches nothing farther */
	range: number;
	/** full cone angles, degrees; 0 for points */
	spotAngle: number;
	innerSpotAngle: number;
	/** metres; 0 unless a tube */
	tubeLength: number;
	/** metres; widens highlights */
	softSourceRadius: number;
	/** distance falloff `(1 − d²/range²)^exponent`; negative for inverse square with a smooth window */
	falloffExponent: number;
	specularIntensity: number;
	/** scales the light in the volumetric fog; 0 leaves the fog unlit */
	volumetricScatteringIntensity: number;
	/** orders lights at equal camera distance when there are more than a viewer draws */
	priority: number;
	/**
	 * camera distances (m) over which the light fades out: full up to `falloff`, linearly in squared distance
	 * to nothing at `culling`. `null` when it never fades
	 */
	distanceFade: { falloff: number; culling: number } | null;
	/**
	 * a box confining the light: world point `p` maps to box units by `q = M · (p − position)` with `M` this
	 * rows3x4 matrix (the inverse of the box's transform, scaled to half extents), and the light fades over
	 * `max |q|` from `(1 + falloffThreshold) / 2` to 1. `null` when unconfined
	 */
	cullingBox: { matrix: number[]; falloffThreshold: number } | null;
	/** the shadow the light casts from static scenery, `null` for a light that casts none */
	shadow: LightShadow | null;
}

/**
 * a local light's shadow settings (`docs/game-data/lighting.md#local-light-shadows`): a spot casts through
 * one perspective map along its direction, a point light through one per cube face
 */
export interface LightShadow {
	/** how far the shadow darkens, 0–1 */
	strength: number;
	/** scales the receiver's offset along its normal, in shadow-map texels */
	normalBias: number;
	/** the projection's near and far planes from the light, m; nothing farther than `farPlane` is shadowed */
	nearPlane: number;
	farPlane: number;
	/** degrees added to a spot's full cone angle for the projection; 0 for points */
	guardAngle: number;
	/** a bit per cube face a point light casts through, in the order +X −X +Y −Y +Z −Z; 0 for spots */
	faces: number;
	/**
	 * the light casts no shadow from farther than `cullDistance` from the camera (m), and its strength fades in
	 * linearly from there to `fadeRatio · cullDistance`
	 */
	cullDistance: number;
	fadeRatio: number;
}

const MAGIC = fourcc('EFLT');
const MAJOR_VERSION = 2;
const TAG_LGHT = fourcc('LGHT');
const TAG_SHDW = fourcc('SHDW');
const TAG_CBOX = fourcc('CBOX');
const KNOWN_TAGS = new Set([TAG_LGHT, TAG_SHDW, TAG_CBOX]);

const LIGHT_FLAGS_FADE = 1 << 0;
const LIGHT_SIZE = 100;
const SHADOW_SIZE = 32;
const CBOX_SIZE = 52;

const isLightKind = enumGuard(LightKind);

/**
 * encodes `tables/lights.bin.zst` (before its zstd frame) as an `EFLT` v2 TLV container
 *
 * @param table local lights table
 * @returns encoded binary bytes
 */
export const encodeLightsTable = (table: LightsTable): Uint8Array => {
	const { lights } = table;
	const lightBuf = new Uint8Array(lights.length * LIGHT_SIZE);
	const lv = viewOf(lightBuf);
	const shadows: LightShadow[] = [];
	const cboxes: { matrix: number[]; falloffThreshold: number }[] = [];

	for (const [i, light] of lights.entries()) {
		const at = i * LIGHT_SIZE;
		let shadowIndex = -1;
		if (light.shadow !== null) {
			shadowIndex = shadows.length;
			shadows.push(light.shadow);
		}
		let cboxIndex = -1;
		if (light.cullingBox !== null) {
			if (light.cullingBox.matrix.length !== 12) {
				throw new RangeError(`light ${i} cullingBox matrix must have 12 floats`);
			}
			cboxIndex = cboxes.length;
			cboxes.push(light.cullingBox);
		}
		lv.setUint8(at, light.kind);
		lv.setUint8(at + 1, light.distanceFade !== null ? LIGHT_FLAGS_FADE : 0);
		lv.setUint32(at + 4, light.group, true);
		lv.setFloat64(at + 8, light.entityId, true);
		lv.setFloat32(at + 16, light.position[0], true);
		lv.setFloat32(at + 20, light.position[1], true);
		lv.setFloat32(at + 24, light.position[2], true);
		lv.setFloat32(at + 28, light.range, true);
		lv.setFloat32(at + 32, light.direction[0], true);
		lv.setFloat32(at + 36, light.direction[1], true);
		lv.setFloat32(at + 40, light.direction[2], true);
		lv.setFloat32(at + 44, light.tubeLength, true);
		lv.setFloat32(at + 48, light.color[0], true);
		lv.setFloat32(at + 52, light.color[1], true);
		lv.setFloat32(at + 56, light.color[2], true);
		lv.setFloat32(at + 60, light.softSourceRadius, true);
		lv.setFloat32(at + 64, light.spotAngle, true);
		lv.setFloat32(at + 68, light.innerSpotAngle, true);
		lv.setFloat32(at + 72, light.falloffExponent, true);
		lv.setFloat32(at + 76, light.specularIntensity, true);
		lv.setFloat32(at + 80, light.volumetricScatteringIntensity, true);
		lv.setInt16(at + 84, light.priority, true);
		lv.setInt16(at + 86, shadowIndex, true);
		lv.setInt16(at + 88, cboxIndex, true);
		lv.setFloat32(at + 92, light.distanceFade?.falloff ?? 0, true);
		lv.setFloat32(at + 96, light.distanceFade?.culling ?? 0, true);
	}

	const sections: ContainerSectionInput[] = [
		{ tag: TAG_LGHT, required: true, data: lightBuf, count: lights.length, stride: LIGHT_SIZE },
	];

	if (shadows.length > 0) {
		const shdwBuf = new Uint8Array(shadows.length * SHADOW_SIZE);
		const sv = viewOf(shdwBuf);
		for (const [i, s] of shadows.entries()) {
			const at = i * SHADOW_SIZE;
			sv.setFloat32(at, s.strength, true);
			sv.setFloat32(at + 4, s.normalBias, true);
			sv.setFloat32(at + 8, s.nearPlane, true);
			sv.setFloat32(at + 12, s.farPlane, true);
			sv.setFloat32(at + 16, s.guardAngle, true);
			sv.setFloat32(at + 20, s.cullDistance, true);
			sv.setFloat32(at + 24, s.fadeRatio, true);
			sv.setUint8(at + 28, s.faces);
		}
		sections.push({
			tag: TAG_SHDW,
			required: true,
			data: shdwBuf,
			count: shadows.length,
			stride: SHADOW_SIZE,
		});
	}

	if (cboxes.length > 0) {
		const cboxBuf = new Uint8Array(cboxes.length * CBOX_SIZE);
		const cv = viewOf(cboxBuf);
		for (const [i, box] of cboxes.entries()) {
			const at = i * CBOX_SIZE;
			for (let m = 0; m < 12; m++) {
				cv.setFloat32(at + m * 4, box.matrix[m], true);
			}
			cv.setFloat32(at + 48, box.falloffThreshold, true);
		}
		sections.push({
			tag: TAG_CBOX,
			required: true,
			data: cboxBuf,
			count: cboxes.length,
			stride: CBOX_SIZE,
		});
	}

	return encodeContainer({ magic: MAGIC, majorVersion: MAJOR_VERSION, sections });
};

/**
 * decodes `tables/lights.bin.zst` (`EFLT` v2 TLV container, inflated)
 *
 * @param data inflated lights table bytes
 * @returns decoded local lights table
 * @throws {PackageFormatError} on invalid container, kind, or out-of-range shadow/culling-box indices
 */
export const decodeLightsTable = (data: Uint8Array): LightsTable => {
	const container = decodeContainer(data, {
		magic: MAGIC,
		majorVersion: MAJOR_VERSION,
		knownTags: KNOWN_TAGS,
		label: 'lights table',
	});
	const lghtSec = requireSection(container, TAG_LGHT, 'lights table');
	checkStride(lghtSec, 100, 'LGHT');
	const shdwSec = container.sections.get(TAG_SHDW);
	const cboxSec = container.sections.get(TAG_CBOX);
	if (shdwSec !== undefined) {
		checkStride(shdwSec, SHADOW_SIZE, 'SHDW');
	}
	if (cboxSec !== undefined) {
		checkStride(cboxSec, CBOX_SIZE, 'CBOX');
	}

	const shadows: LightShadow[] = [];
	if (shdwSec !== undefined) {
		const sv = viewOf(shdwSec.data);
		for (let i = 0; i < shdwSec.count; i++) {
			const at = i * shdwSec.stride;
			shadows.push({
				strength: sv.getFloat32(at, true),
				normalBias: sv.getFloat32(at + 4, true),
				nearPlane: sv.getFloat32(at + 8, true),
				farPlane: sv.getFloat32(at + 12, true),
				guardAngle: sv.getFloat32(at + 16, true),
				cullDistance: sv.getFloat32(at + 20, true),
				fadeRatio: sv.getFloat32(at + 24, true),
				faces: sv.getUint8(at + 28),
			});
		}
	}

	const cboxes: { matrix: number[]; falloffThreshold: number }[] = [];
	if (cboxSec !== undefined) {
		const cv = viewOf(cboxSec.data);
		for (let i = 0; i < cboxSec.count; i++) {
			const at = i * cboxSec.stride;
			const matrix: number[] = [];
			for (let m = 0; m < 12; m++) {
				matrix.push(cv.getFloat32(at + m * 4, true));
			}
			cboxes.push({ matrix, falloffThreshold: cv.getFloat32(at + 48, true) });
		}
	}

	const lv = viewOf(lghtSec.data);
	const lights: LightEntry[] = [];
	for (let i = 0; i < lghtSec.count; i++) {
		const at = i * lghtSec.stride;
		const f = (o: number): number => lv.getFloat32(at + o, true);
		const flags = lv.getUint8(at + 1);
		const shadowIndex = lv.getInt16(at + 86, true);
		const cboxIndex = lv.getInt16(at + 88, true);
		if (shadowIndex >= shadows.length) {
			throw new PackageFormatError(`light ${i} shadow index ${shadowIndex} out of range`);
		}
		if (cboxIndex >= cboxes.length) {
			throw new PackageFormatError(`light ${i} cullingBox index ${cboxIndex} out of range`);
		}
		lights.push({
			kind: checkedEnum(isLightKind, lv.getUint8(at), 'light kind'),
			entityId: lv.getFloat64(at + 8, true),
			group: lv.getUint32(at + 4, true),
			position: [f(16), f(20), f(24)],
			range: f(28),
			direction: [f(32), f(36), f(40)],
			tubeLength: f(44),
			color: [f(48), f(52), f(56)],
			softSourceRadius: f(60),
			spotAngle: f(64),
			innerSpotAngle: f(68),
			falloffExponent: f(72),
			specularIntensity: f(76),
			volumetricScatteringIntensity: f(80),
			priority: lv.getInt16(at + 84, true),
			distanceFade: (flags & LIGHT_FLAGS_FADE) !== 0 ? { falloff: f(92), culling: f(96) } : null,
			cullingBox: cboxIndex >= 0 ? cboxes[cboxIndex] : null,
			shadow: shadowIndex >= 0 ? shadows[shadowIndex] : null,
		});
	}
	return { lights };
};

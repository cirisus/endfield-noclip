import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	aabbField,
	arrayField,
	asPPtr,
	booleanField,
	isObject,
	numberField,
	objectField,
	type PPtr,
	pptrField,
	vector3Field,
} from '@endfield-noclip/formats/unity/values';
import {
	CurveMode,
	GradientMode,
	type MinMaxCurveInfo,
	ParticleAlignment,
	ParticleRenderMode,
	ParticleShapeKind,
	type ParticleSystemInfo,
	type SplineSegmentInfo,
} from '@endfield-noclip/package-format/particles';

import type { AssetResolver, ObjectRef } from './assets.ts';
import { emissionBound, readAnimationCurve } from './particle-system.ts';

/** the most LOD groups a mover picks from that the viewer's mesh weights hold */
const MAX_GROUPS = 4;

/** `SplineEmissionType` that starts objects anywhere in the desc's box */
const EMISSION_BOX = 0;

/** what {@link readSplineMover} found */
export type SplineMoverRead =
	| {
			/** the movers' particles, drawing the first group */
			info: ParticleSystemInfo;
			/** the LOD groups each object picks one of, in the order of {@link ParticleSystemInfo.meshWeights} */
			groups: PPtr[];
	  }
	| { reason: string };

/** a renderer a spline mover's objects draw */
export interface SplineMoverRenderer {
	/** the `MeshRenderer` in the LOD group's first LOD */
	ref: ObjectRef;
	data: TypeTreeObject;
	mesh: ObjectRef;
	/** the particles drawing it, or `null` for a stand-in */
	particles: ParticleSystemInfo | null;
	/** why it stands in, or `null` */
	unsupported: string | null;
}

/**
 * resolves what a spline mover draws: per LOD group its first LOD's enabled mesh renderers, each the mesh of
 * a particle entry picking that group. a mover the viewer can't play, or one switched off, draws its first
 * group once at its origin instead
 *
 * @param resolver bundle reader
 * @param ref the `HGSplineMovingObjects` component
 * @param data its fields
 * @param standIn why its GameObject is switched off, or `null` when it's drawn
 * @returns the renderers, placed at the component's GameObject
 */
export const splineMoverRenderers = async (
	resolver: AssetResolver,
	ref: ObjectRef,
	data: TypeTreeObject,
	standIn: string | null,
): Promise<SplineMoverRenderer[]> => {
	const read = readSplineMover(data);
	let groups: PPtr[];
	if ('info' in read) {
		groups = read.groups;
	} else {
		const first = arrayField(objectField(data, 'desc'), 'lodGroups')[0];
		groups = first === undefined ? [] : [asPPtr(first)];
	}
	const unsupported = standIn ?? ('reason' in read ? read.reason : null);
	const out: SplineMoverRenderer[] = [];
	for (const [i, pointer] of groups.entries()) {
		// oxlint-disable-next-line no-await-in-loop -- groups are few
		const group = await resolver.resolve(ref, pointer);
		if (group === null) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop
		const lods = arrayField(await resolver.read(group), 'm_LODs');
		const lod = lods[0];
		if (!isObject(lod)) {
			continue;
		}
		for (const entry of arrayField(lod, 'renderers')) {
			if (!isObject(entry)) {
				throw new FormatError('invalid LOD renderer');
			}
			// oxlint-disable-next-line no-await-in-loop -- renderer order is draw order
			const renderer = await resolver.resolve(group, pptrField(entry, 'renderer'));
			if (renderer === null || renderer.info.classId !== UnityClass.MeshRenderer) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop
			const rendererData = await resolver.read(renderer);
			if (!booleanField(rendererData, 'm_Enabled')) {
				continue;
			}
			// oxlint-disable-next-line no-await-in-loop
			const mesh = await meshOf(resolver, renderer, rendererData);
			if (mesh === null) {
				continue;
			}
			out.push({
				ref: renderer,
				data: rendererData,
				mesh,
				particles: unsupported === null && 'info' in read ? { ...read.info, mesh: i } : null,
				unsupported,
			});
		}
	}
	return out;
};

/** @returns the mesh of a `MeshRenderer`'s GameObject's `MeshFilter`, or `null` without one */
const meshOf = async (
	resolver: AssetResolver,
	renderer: ObjectRef,
	data: TypeTreeObject,
): Promise<ObjectRef | null> => {
	const go = await resolver.resolve(renderer, pptrField(data, 'm_GameObject'));
	if (go === null) {
		return null;
	}
	for (const item of arrayField(await resolver.read(go), 'm_Component')) {
		if (!isObject(item)) {
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop -- a GameObject has few components
		const component = await resolver.resolve(go, pptrField(item, 'component'));
		if (component?.info.classId === UnityClass.MeshFilter) {
			// oxlint-disable-next-line no-await-in-loop
			return resolver.resolve(component, pptrField(await resolver.read(component), 'm_Mesh'));
		}
	}
	return null;
};

/**
 * @param ref a MonoBehaviour
 * @returns whether it is Beyond's `HGSplineMovingObjects`, by its serialized fields
 */
export const isSplineMoverType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return names.has('desc') && names.has('knotData') && names.has('fixedPostion');
};

/**
 * @param value a `ParticleSystem.MinMaxCurve` as a MonoBehaviour serializes it
 * @returns it, with only the curves its mode reads
 * @throws {FormatError} on an unknown mode
 */
export const readSerializedMinMaxCurve = (value: TypeTreeObject): MinMaxCurveInfo => {
	const mode = numberField(value, 'm_Mode');
	switch (mode) {
		case CurveMode.Constant:
		case CurveMode.TwoConstants: {
			return {
				mode,
				scalar: numberField(value, 'm_ConstantMax'),
				min: numberField(value, 'm_ConstantMin'),
				curve: null,
				minCurve: null,
			};
		}
		case CurveMode.Curve:
		case CurveMode.TwoCurves: {
			return {
				mode,
				scalar: numberField(value, 'm_CurveMultiplier'),
				min: 0,
				curve: readAnimationCurve(objectField(value, 'm_CurveMax')),
				minCurve: mode === CurveMode.TwoCurves ? readAnimationCurve(objectField(value, 'm_CurveMin')) : null,
			};
		}
		default: {
			throw new FormatError(`unknown MinMaxCurve mode ${mode}`);
		}
	}
};

const isConstant = (curve: MinMaxCurveInfo): boolean =>
	curve.mode === CurveMode.Constant || curve.mode === CurveMode.TwoConstants;

/** @returns a constant curve, or two constants', with both scaled */
const scaled = (curve: MinMaxCurveInfo, by: number): MinMaxCurveInfo => ({
	...curve,
	scalar: curve.scalar * by,
	min: curve.min * by,
});

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

/**
 * reads an `HGSplineMovingObjects`: meshes the game emits at a steady rate and moves along a spline, each
 * picking one of the desc's LOD groups. it becomes a particle system whose particles follow
 * {@link ParticleSystemInfo.spline}.
 *
 * the game moves each object by the speed curve (`velocityOverLifeTime`) in the mover's own time, the frame's
 * time times `simulateSpeed`, starts it in the desc's box, sizes it by its start size times the size curve
 * and turns it by its start Euler angles (degrees, Unity's order). its lifetime is the start lifetime clamped
 * to 0–1, a fraction of the time the spline takes at the mean speed
 *
 * @param data the component's fields (see {@link isSplineMoverType})
 * @returns the system and its LOD groups, or why the viewer can't play it: noise, rotation over lifetime, an
 *   alpha fade, an emission type other than the box, a start lifetime or speed curve, more than four LOD
 *   groups, no spline or no LOD group
 */
export const readSplineMover = (data: TypeTreeObject): SplineMoverRead => {
	const desc = objectField(data, 'desc');
	const curve = (name: string) => readSerializedMinMaxCurve(objectField(desc, name));
	if (booleanField(desc, 'hasNoise')) {
		return { reason: 'spline noise' };
	}
	if (booleanField(desc, 'hasRotation') || booleanField(desc, 'has3dRotation')) {
		return { reason: 'spline rotation over lifetime' };
	}
	// the game draws objects whose alpha falls below `transparentAlpha` as transparent
	if (booleanField(desc, 'hasAlphaControl') && numberField(desc, 'transparentAlpha') > 0) {
		return { reason: 'spline alpha fade' };
	}
	if (numberField(desc, 'emissionType') !== EMISSION_BOX) {
		return { reason: `spline emission type ${numberField(desc, 'emissionType')}` };
	}

	const segments: SplineSegmentInfo[] = arrayField(data, 'knotData').map((knot) => {
		if (!isObject(knot)) {
			throw new FormatError('spline knot is not an object');
		}
		return {
			points: [
				vector3Field(knot, 'p0'),
				vector3Field(knot, 'p1'),
				vector3Field(knot, 'p2'),
				vector3Field(knot, 'p3'),
			],
			length: numberField(knot, 'length'),
		};
	});
	const total = segments.reduce((sum, segment) => sum + segment.length, 0);
	if (total <= 0) {
		return { reason: 'no spline' };
	}
	const groups = arrayField(desc, 'lodGroups')
		.map((pointer) => asPPtr(pointer))
		.filter((pointer) => pointer.pathId !== 0n);
	if (groups.length === 0) {
		return { reason: 'no LOD group' };
	}
	if (groups.length > MAX_GROUPS) {
		return { reason: `${groups.length} LOD groups` };
	}

	const speed = curve('velocityOverLifeTime');
	const startLifetime = curve('startLifeTime');
	if (speed.mode !== CurveMode.Constant || speed.scalar <= 0) {
		return { reason: 'spline speed curve' };
	}
	if (!isConstant(startLifetime)) {
		return { reason: 'spline lifetime curve' };
	}
	// the time the whole spline takes at the speed; the start lifetime is a fraction of it
	const traverse = total / speed.scalar;
	const lifetime: MinMaxCurveInfo = {
		...startLifetime,
		scalar: clamp01(startLifetime.scalar) * traverse,
		min: clamp01(startLifetime.min) * traverse,
	};
	const rate = numberField(desc, 'emissionRateOverTime');
	const rateCurve: MinMaxCurveInfo = {
		mode: CurveMode.Constant,
		scalar: rate,
		min: rate,
		curve: null,
		minCurve: null,
	};
	// a mover has no cap of its own; it holds what one lifetime of its stream emits
	const bound = emissionBound(rateCurve, [], lifetime, 1);
	const box = aabbField(desc, 'aabb');
	const size = curve('startSize');
	const growth = curve('sizeOverLifeTime');
	const radians = Math.PI / 180;
	const zero: MinMaxCurveInfo = { mode: CurveMode.Constant, scalar: 0, min: 0, curve: null, minCurve: null };
	// without 3D start rotations the game turns objects about z alone
	const turned = booleanField(desc, 'has3dStartRotation');
	return {
		info: {
			renderMode: ParticleRenderMode.Mesh,
			stretch: null,
			screenSize: null,
			sizedByScale: true,
			duration: 1,
			looping: true,
			startDelay: zero,
			maxParticles: bound,
			emissionBound: bound,
			simulationSpeed: numberField(desc, 'simulateSpeed'),
			startLifetime: lifetime,
			startColor: {
				mode: GradientMode.Color,
				max: [1, 1, 1, 1],
				min: [1, 1, 1, 1],
				maxGradient: null,
				minGradient: null,
			},
			colorOverLifetime: null,
			startSize: [size, size, size],
			startRotation: [
				turned ? scaled(curve('startRotationX'), radians) : zero,
				turned ? scaled(curve('startRotationY'), radians) : zero,
				scaled(curve('startRotationZ'), radians),
			],
			rate: rateCurve,
			bursts: [],
			// objects start anywhere in the box, offset from the spline
			shape: {
				kind: ParticleShapeKind.Box,
				radius: 0,
				radiusThickness: 1,
				donutRadius: 0,
				angle: 0,
				length: 0,
				arc: 360,
				position: box.center,
				rotation: [0, 0, 0],
				scale: [box.extents[0] * 2, box.extents[1] * 2, box.extents[2] * 2],
				randomDirection: 0,
				sphericalDirection: 0,
				randomPosition: 0,
				mesh: null,
			},
			motion: { kind: 'spline', segments, speed },
			sizeOverLifetime: [growth, growth, growth],
			rotationOverLifetime: null,
			alignment: ParticleAlignment.Local,
			pivot: [0, 0, 0],
			meshWeights: groups.map(() => 1),
			mesh: 0,
			ringBuffer: null,
			textureSheet: null,
			customData: null,
		},
		groups,
	};
};

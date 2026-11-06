import { BinaryReader, FormatError } from '../binary/binary-reader.ts';

type Vec3 = [number, number, number];
type Quaternion = [number, number, number, number];
type Pose = { position: Vec3; rotation: Quaternion };
type Filter = {
	options: number;
	tag: number;
	flags: number;
	enabled: boolean;
	trigger: boolean;
	surface: number;
	extra: number;
};
type Geometry =
	| { kind: 'box'; halfExtents: Vec3 }
	| { kind: 'capsule'; radius: number; cylinderLength: number }
	| { kind: 'sphere'; radius: number }
	| { kind: 'mesh'; mesh: number; convex: boolean; cookingOptions: number; scale: Vec3 };

/** shape poses are relative to the actor; mesh indices address the separately bound asset list */
export type ColliderShape = Pose & Filter & Geometry;

/** decoded actor input; layer/option policy and active world state remain the importer's responsibility */
export interface EcsCollider extends Pose {
	kind: number;
	headerFlags: number;
	layer: number;
	tag: number;
	shapes: ColliderShape[];
	complex: { mesh: number; options: number; tag: number; flags: number; scale: Vec3; extra: number } | null;
	terrain: {
		options: number;
		tag: number;
		flags: number;
		enabled: boolean;
		surface: number;
		scale: Vec3;
	} | null;
	meshCount: number;
}

const identity = (): Pose => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1] });

/**
 * @param bytes streamed ECS collider blob, excluding the separate asset bindings
 * @returns actor pose and all primitive/mesh inputs, retaining disabled and trigger shapes
 * @throws {FormatError} for unsupported kinds, invalid dimensions, counts or incomplete records
 */
export const readEcsCollider = (bytes: Uint8Array): EcsCollider => {
	const r = new BinaryReader(bytes, { littleEndian: true });
	const scalar = () => {
		const value = r.f32();
		if (!Number.isFinite(value)) {
			throw new FormatError('nonfinite collider coordinate');
		}
		return value;
	};
	const vector = (): Vec3 => [scalar(), scalar(), scalar()];
	const dimensions = (): Vec3 => {
		const values = vector();
		if (values.some((v) => v < 0)) {
			throw new FormatError('negative collider dimensions');
		}
		return values;
	};
	const positive = () => {
		const value = scalar();
		if (value < 0) {
			throw new FormatError('negative collider dimension');
		}
		return value;
	};
	const pose = (): Pose => {
		const position = vector(),
			rotation: Quaternion = [scalar(), scalar(), scalar(), scalar()];
		if (Math.abs(Math.hypot(...rotation) - 1) > 1e-3) {
			throw new FormatError('invalid collider rotation');
		}
		return { position, rotation };
	};
	const filter = () => {
		const options = r.u32(),
			tag = r.u32(),
			flags = r.u32();
		return {
			options,
			tag,
			flags,
			enabled: (flags & 1) !== 0,
			trigger: (flags & 2) !== 0,
			surface: (flags >>> 2) & 255,
		};
	};
	const actor = pose(),
		kind = r.u16(),
		headerFlags = r.u16(),
		layer = r.u32(),
		actorTag = r.u32();
	if (layer > 31) {
		throw new FormatError('invalid collider layer');
	}
	const result: EcsCollider = {
		...actor,
		kind,
		headerFlags,
		layer,
		tag: actorTag,
		shapes: [],
		complex: null,
		terrain: null,
		meshCount: 0,
	};
	const push = (shape: Pose & Omit<Filter, 'extra'> & Geometry) => {
		result.shapes.push({ ...shape, extra: r.u32() });
	};
	switch (kind) {
		case 1: {
			const halfExtents = dimensions();
			push({ ...identity(), ...filter(), kind: 'box', halfExtents });
			break;
		}
		case 2: {
			const radius = positive(),
				cylinderLength = positive();
			push({ ...identity(), ...filter(), kind: 'capsule', radius, cylinderLength });
			break;
		}
		case 3: {
			const radius = positive();
			push({ ...identity(), ...filter(), kind: 'sphere', radius });
			break;
		}
		case 4: {
			const scale = vector(),
				packed = r.u32();
			push({
				...identity(),
				...filter(),
				kind: 'mesh',
				mesh: 0,
				scale,
				convex: (packed & 1) !== 0,
				cookingOptions: packed >>> 1,
			});
			result.meshCount = 1;
			break;
		}
		case 5: {
			const counts = Array.from({ length: 6 }, () => r.u32());
			const [complex, boxes, capsules, spheres, triangles, convexes] = counts;
			const size = complex * 28 + boxes * 56 + capsules * 52 + spheres * 32 + (triangles + convexes) * 60;
			if (complex > 1 || size !== r.remaining) {
				throw new FormatError('invalid compound collider counts');
			}
			let mesh = 0;
			if (complex === 1) {
				const options = r.u32(),
					tag = r.u32(),
					flags = r.u32(),
					scale = vector(),
					extra = r.u32();
				result.complex = { mesh: mesh++, options, tag, flags, scale, extra };
			}
			for (let i = 0; i < boxes; i++) {
				const transform = pose(),
					flags = filter(),
					halfExtents = dimensions();
				push({ ...transform, ...flags, kind: 'box', halfExtents });
			}
			for (let i = 0; i < capsules; i++) {
				const transform = pose(),
					flags = filter(),
					radius = positive(),
					cylinderLength = positive();
				push({ ...transform, ...flags, kind: 'capsule', radius, cylinderLength });
			}
			for (let i = 0; i < spheres; i++) {
				const position = vector(),
					flags = filter(),
					radius = positive();
				push({ ...identity(), position, ...flags, kind: 'sphere', radius });
			}
			for (let i = 0; i < triangles + convexes; i++) {
				const transform = pose(),
					flags = filter(),
					cookingOptions = r.u32(),
					scale = vector();
				push({
					...transform,
					...flags,
					kind: 'mesh',
					mesh: mesh++,
					convex: i >= triangles,
					cookingOptions,
					scale,
				});
			}
			result.meshCount = mesh;
			break;
		}
		case 6: {
			const { options, tag, flags, enabled, surface } = filter();
			result.terrain = { options, tag, flags, enabled, surface, scale: dimensions() };
			break;
		}
		default: {
			throw new FormatError(`unsupported ECS collider kind ${kind}`);
		}
	}
	if (r.remaining !== 0) {
		throw new FormatError('unexpected collider trailing bytes');
	}
	return result;
};

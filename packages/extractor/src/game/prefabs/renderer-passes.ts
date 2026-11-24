/* oxlint-disable no-await-in-loop -- references are cached by the resolver */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	inverseAffine,
	multiplyMatrices,
	transformPoint,
	trsMatrix,
} from '@endfield-noclip/formats/unity/transform';
import type {
	ParticleForceFieldInfo,
	ParticleSubEmitterType,
} from '@endfield-noclip/package-format/particles';

import { objectKey } from '../assets/assets.ts';
import { InfluenceFilter, isSupportedSubEmitterType, readForceField } from '../effects/particle-system.ts';

import type { RendererWalk, WalkedParticleSystem } from './renderer-walk.ts';

// what the renderer walk settles once the whole hierarchy is placed, since what it depends on can come later
// in the walk

const IDENTITY = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

/**
 * translates a Transform and its subtree so the Transform's prefab-space origin lands at `to`, keeping its
 * rotation and scale, and updates its candidates, particle emitters, and saved clip base
 */
const translateTransformSubtree = (
	walk: RendererWalk,
	target: string,
	to: readonly [number, number, number],
): void => {
	const { transforms } = walk;
	const from = transforms.get(target);
	if (from === undefined) {
		return;
	}
	const delta = [to[0] - from[12], to[1] - from[13], to[2] - from[14]];
	const moved = (matrix: Float32Array): Float32Array => {
		const copy = matrix.slice();
		for (let axis = 0; axis < 3; axis++) {
			copy[12 + axis] += delta[axis];
		}
		return copy;
	};
	const subtree = new Set([target]);
	for (const node of walk.nodes) {
		if (node.parent !== null && subtree.has(node.parent)) {
			subtree.add(node.key);
		}
		if (subtree.has(node.key)) {
			transforms.set(node.key, moved(transforms.get(node.key) ?? IDENTITY));
		}
		if (node.key === target && node.parent !== null) {
			// looping clips pose it from here
			const parentMatrix = transforms.get(node.parent) ?? IDENTITY;
			node.saved.position = transformPoint(inverseAffine(parentMatrix), to);
		}
	}
	const movedCandidates = new Set<RendererWalk['candidates'][number]>();
	for (const [candidate, transform] of walk.candidateTransforms) {
		if (subtree.has(transform)) {
			candidate.matrix = moved(candidate.matrix);
			movedCandidates.add(candidate);
			const pending = walk.pendingForces.get(candidate);
			if (pending !== undefined) {
				pending.emitter = moved(pending.emitter);
				pending.standIn = moved(pending.standIn);
			}
		}
	}
	for (const walked of walk.particleSystems.values()) {
		if (walked.candidates.some((candidate) => movedCandidates.has(candidate))) {
			walked.emitter = moved(walked.emitter);
		}
	}
};

/**
 * moves each `VFXAdjustLength` `targetMoveTransforms` target to `origin.TransformPoint(point)` in prefab
 * space
 *
 * @param walk the finished walk, updated in place
 */
export const moveLengthTargets = (walk: RendererWalk): void => {
	for (const [target, { origin, point }] of walk.lengthMoves) {
		const originMatrix = walk.transforms.get(origin);
		if (originMatrix === undefined) {
			continue;
		}
		translateTransformSubtree(walk, target, transformPoint(originMatrix, point));
	}
};

/**
 * moves each `PositionFollower` to its source's position, keeping its own rotation and scale, and its subtree
 * with it: their Transforms, their candidates, and the saved position looping clips pose it from
 *
 * @param walk the finished walk, updated in place
 * @throws {FormatError} if a follower's source is outside the prefab
 */
export const moveFollowers = (walk: RendererWalk): void => {
	const { transforms } = walk;
	for (const [follower, source] of walk.followers) {
		const from = transforms.get(follower);
		const to = transforms.get(source);
		if (from === undefined || to === undefined) {
			throw new FormatError(`PositionFollower follows a Transform outside its prefab`);
		}
		translateTransformSubtree(walk, follower, [to[12], to[13], to[14]]);
	}
};

/**
 * gives each played particle system the force fields it feels: those it lists, or those on its layers, within
 * this prefab (wind zones and fields elsewhere in the scene aren't followed). a field the viewer can't step
 * makes the system a stand-in
 *
 * @param walk the finished walk, whose candidates are updated in place
 */
export const resolveForces = async (walk: RendererWalk): Promise<void> => {
	for (const [candidate, { system, forces, emitter, standIn }] of walk.pendingForces) {
		const felt = new Set<string>();
		if (forces.filter !== InfluenceFilter.LayerMask) {
			for (const pointer of forces.list) {
				const ref = await walk.resolver.resolve(system, pointer);
				if (ref !== null && walk.forceFields.has(objectKey(ref))) {
					felt.add(objectKey(ref));
				}
			}
		}
		if (forces.filter !== InfluenceFilter.List) {
			for (const [key, field] of walk.forceFields) {
				if (((forces.mask >>> field.layer) & 1) !== 0) {
					felt.add(key);
				}
			}
		}
		const infos: ParticleForceFieldInfo[] = [];
		let reason: string | null = null;
		for (const key of felt) {
			const field = walk.forceFields.get(key);
			if (field === undefined) {
				continue;
			}
			const read = readForceField(field.data, multiplyMatrices(inverseAffine(field.matrix), emitter));
			if (typeof read === 'string') {
				reason = read;
				break;
			}
			infos.push(read);
		}
		const particles = candidate.particles;
		if (reason !== null) {
			candidate.particles = null;
			candidate.unsupported = reason;
			candidate.matrix = standIn;
		} else if (infos.length > 0 && particles?.motion.kind === 'free') {
			const updated = {
				...particles,
				motion: { ...particles.motion, forces: { multiplier: forces.multiplier, fields: infos } },
			};
			candidate.particles = updated;
			const walked = walk.particleSystems.get(objectKey(system));
			if (walked !== undefined) {
				walked.info = updated;
			}
		}
	}
};

/**
 * computes `inverse(child) * parent`, falling back to a safe per-axis inverse when `child` is singular (e.g.
 * a flat sub-emitter with zero scale on one axis) so the non-zero axes still map positions cleanly
 */
const fromParentMatrix = (child: Float32Array, parent: Float32Array): number[] => {
	try {
		return [...multiplyMatrices(inverseAffine(child), parent)];
	} catch {
		// invert translation and non-zero column lengths independently; zero-scale rows stay 0
		const inv = new Float32Array(16);
		inv[15] = 1;
		for (let axis = 0; axis < 3; axis++) {
			const x = child[axis * 4];
			const y = child[axis * 4 + 1];
			const z = child[axis * 4 + 2];
			const len2 = x * x + y * y + z * z;
			if (len2 > 1e-12) {
				const s = 1 / len2;
				inv[axis] = x * s;
				inv[4 + axis] = y * s;
				inv[8 + axis] = z * s;
			}
		}
		const tx = child[12];
		const ty = child[13];
		const tz = child[14];
		inv[12] = -(inv[0] * tx + inv[4] * ty + inv[8] * tz);
		inv[13] = -(inv[1] * tx + inv[5] * ty + inv[9] * tz);
		inv[14] = -(inv[2] * tx + inv[6] * ty + inv[10] * tz);
		return [...multiplyMatrices(inv, parent)];
	}
};

/**
 * links each sub-emitter `ParticleSystem` to its driving parent system (`SubModule`), in topological order so
 * multi-level chains (`parent → child → grandchild`) carry the full chain. runs after {@link resolveForces} so
 * parent force fields are already populated
 *
 * @param walk the finished walk, whose candidates are updated in place
 */
export const resolveSubEmitters = async (walk: RendererWalk): Promise<void> => {
	interface Link {
		parent: WalkedParticleSystem;
		child: WalkedParticleSystem;
		type: ParticleSubEmitterType;
		properties: number;
		probability: number;
	}
	const incoming = new Map<string, Link>();
	for (const parent of walk.particleSystems.values()) {
		for (const entry of parent.subEmitters) {
			if (!isSupportedSubEmitterType(entry.type)) {
				continue;
			}
			const target = await walk.resolver.resolve(parent.ref, entry.emitter);
			if (target === null) {
				continue;
			}
			const childKey = objectKey(target);
			const child = walk.particleSystems.get(childKey);
			if (child === undefined || child === parent || incoming.has(childKey)) {
				continue;
			}
			incoming.set(childKey, {
				parent,
				child,
				type: entry.type,
				properties: entry.properties,
				probability: entry.probability,
			});
		}
	}
	if (incoming.size === 0) {
		return;
	}
	// attach parents before their children so multi-level chains embed the already-linked parent info
	const resolved = new Set<string>();
	const visiting = new Set<string>();
	const attach = (childKey: string): void => {
		if (resolved.has(childKey) || visiting.has(childKey)) {
			return;
		}
		const link = incoming.get(childKey);
		if (link === undefined) {
			return;
		}
		visiting.add(childKey);
		const parentKey = objectKey(link.parent.ref);
		if (incoming.has(parentKey)) {
			attach(parentKey);
		}
		visiting.delete(childKey);
		resolved.add(childKey);
		const subEmitter = {
			parent: link.parent.info,
			fromParent: fromParentMatrix(link.child.emitter, link.parent.emitter),
			type: link.type,
			properties: link.properties,
			probability: link.probability,
		};
		link.child.info = { ...link.child.info, subEmitter };
		for (const candidate of link.child.candidates) {
			if (candidate.particles !== null) {
				candidate.particles = { ...candidate.particles, subEmitter };
			}
		}
	};
	for (const childKey of incoming.keys()) {
		attach(childKey);
	}
};

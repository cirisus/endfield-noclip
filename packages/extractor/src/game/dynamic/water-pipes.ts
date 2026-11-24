import type {
	DynamicEntity,
	DynamicVariable,
	WaterPipe,
} from '@endfield-noclip/formats/endfield/dynamic-scene';
import { multiplyQuaternions, unityEulerQuaternion } from '@endfield-noclip/formats/unity/transform';

import type { PrefabPose } from '../prefabs/prefab.ts';
import { allOf, type Alternatives, type GameCondition, type GameState } from '../state/game-state.ts';

// water pipe chains (`DynamicSceneWaterPipeSystem`): each pipe's map variable (`state`, 0 or 1) selects
// `initialAngle` or `targetAngle` as the world Y rotation of `RotateRoot`, and water flows from a waterfall
// (`upstreamInteractiveId === 0n`) or an active outfall (`state === 1`) through every upstream pipe rotated
// to its `targetAngle`. a pipe with water pours to `heightToDownStream` when aligned or `heightToGround`
// otherwise; a dry pipe switches `Effect` off.

/** whether a pipe's upstream supplies water */
export type UpstreamWater =
	| { kind: 'always' }
	| { kind: 'never' }
	| { kind: 'whenAllOn'; variables: readonly DynamicVariable[] };

/** a non-outfall water pipe entity and the variables that drive its rotation and water flow */
export interface DrivenWaterPipe {
	pipe: WaterPipe;
	/** this pipe's `state` variable (1 = aligned to `targetAngle`, otherwise `initialAngle`) */
	variable: DynamicVariable;
	/** when upstream supplies water to this pipe */
	upstream: UpstreamWater;
}

/** one posed look of a water pipe and the condition under which it draws */
export interface WaterPipeLook {
	suffix: string;
	when: Alternatives;
	pose: PrefabPose;
}

/** @returns the condition that `variable` equals `value` */
const variableIs = (variable: DynamicVariable, value: number): GameCondition =>
	variable.kind === 'mapVar'
		? { kind: 'mapVar', mapId: String(variable.mapId), name: `#${variable.key}`, compare: 0, target: value }
		: { kind: 'globalVar', name: `#${variable.key}`, compare: 0, target: value };

/**
 * resolves each non-outfall water pipe entity's upstream chain across the scene's dynamic owners
 *
 * @param owners the scene's dynamic entities
 * @returns by water pipe entity, its pipe config, own state variable, and upstream water condition
 */
export const collectWaterPipes = (owners: readonly DynamicEntity[]): Map<DynamicEntity, DrivenWaterPipe> => {
	const byInteractive = new Map<bigint, DynamicEntity>();
	for (const entity of owners) {
		if (entity.waterPipe !== null) {
			byInteractive.set(entity.waterPipe.interactiveId, entity);
		}
	}
	const driven = new Map<DynamicEntity, DrivenWaterPipe>();
	for (const entity of owners) {
		const pipe = entity.waterPipe;
		const [variable] = entity.variables;
		if (pipe === null || pipe.isOutFall || variable === undefined) {
			continue;
		}
		const upstream = resolveUpstream(pipe, byInteractive);
		driven.set(entity, { pipe, variable, upstream });
	}
	return driven;
};

/** walks `upstreamInteractiveId` to collect every upstream pipe/outfall variable that must equal 1 */
const resolveUpstream = (
	pipe: WaterPipe,
	byInteractive: ReadonlyMap<bigint, DynamicEntity>,
): UpstreamWater => {
	if (pipe.upstreamInteractiveId === 0n) {
		return { kind: 'always' };
	}
	const variables: DynamicVariable[] = [];
	const seen = new Set<bigint>([pipe.interactiveId]);
	let nextId = pipe.upstreamInteractiveId;
	while (nextId !== 0n) {
		if (seen.has(nextId)) {
			return { kind: 'never' };
		}
		seen.add(nextId);
		const upstream = byInteractive.get(nextId);
		const upstreamPipe = upstream?.waterPipe ?? null;
		const upstreamVar = upstream?.variables[0];
		if (upstreamPipe === null || upstreamVar === undefined) {
			return { kind: 'never' };
		}
		variables.push(upstreamVar);
		if (upstreamPipe.isOutFall) {
			// an outfall's own `state === 1` supplies water directly
			break;
		}
		nextId = upstreamPipe.upstreamInteractiveId;
	}
	return variables.length === 0 ? { kind: 'always' } : { kind: 'whenAllOn', variables };
};

/**
 * notes every water pipe and upstream outfall variable (0 and 1) in `game` so their controls exist before
 * requirements are computed
 *
 * @param game the scene's game state
 * @param pipes driven water pipes from {@link collectWaterPipes}
 */
export const noteWaterPipeConditions = (
	game: GameState,
	pipes: ReadonlyMap<DynamicEntity, DrivenWaterPipe>,
): void => {
	const conditions: GameCondition[] = [];
	for (const { variable, upstream } of pipes.values()) {
		conditions.push(variableIs(variable, 0), variableIs(variable, 1));
		if (upstream.kind === 'whenAllOn') {
			for (const ancestor of upstream.variables) {
				conditions.push(variableIs(ancestor, 0), variableIs(ancestor, 1));
			}
		}
	}
	game.note(conditions);
};

/**
 * computes the local rotation quaternion for `RotateRoot` (a direct child of the prefab root) so its world
 * rotation equals `Euler(0, worldYaw, 0)` under the placement's Euler `placementRotation`
 */
const localRotateRootQuat = (
	placementRotation: readonly [number, number, number],
	worldYaw: number,
): [number, number, number, number] => {
	const [px, py, pz, pw] = unityEulerQuaternion(placementRotation);
	const invPlacement: [number, number, number, number] = [-px, -py, -pz, pw];
	return multiplyQuaternions(invPlacement, unityEulerQuaternion([0, worldYaw, 0]));
};

/** builds a {@link PrefabPose} for one water pipe angle and water state */
const waterPipePose = (
	placementRotation: readonly [number, number, number],
	worldYaw: number,
	effectLength: number | null,
): PrefabPose => {
	const localQuat = localRotateRootQuat(placementRotation, worldYaw);
	const qKey = localQuat.map((n) => n.toFixed(5)).join(',');
	if (effectLength === null) {
		return {
			key: `waterPipe:q=${qKey}:dry`,
			clips: [],
			active: new Map([['Effect', false]]),
			rotations: new Map([['RotateRoot', localQuat]]),
		};
	}
	return {
		key: `waterPipe:q=${qKey}:len=${effectLength.toFixed(3)}`,
		clips: [],
		active: new Map([['Effect', true]]),
		lengths: new Map([
			['WaterFall', effectLength],
			['Splash', effectLength],
		]),
		rotations: new Map([['RotateRoot', localQuat]]),
	};
};

/**
 * builds the mutually exclusive posed looks (rotation + water effect visibility and `VFXAdjustLength` drop)
 * for one placed water pipe model
 *
 * @param game the scene's game state
 * @param driven the pipe's config and upstream chain
 * @param placementRotation the placed model's Unity Euler rotation in degrees
 * @returns the looks to emit (2 for a top-of-chain or dry pipe, 4 for a downstream pipe)
 */
export const waterPipeLooks = (
	game: GameState,
	driven: DrivenWaterPipe,
	placementRotation: readonly [number, number, number],
): WaterPipeLook[] => {
	const { pipe, variable, upstream } = driven;
	const selfOn = game.requirements(variableIs(variable, 1));
	const selfOff = game.requirements({ kind: 'all', reverse: true, conditions: [variableIs(variable, 1)] });

	switch (upstream.kind) {
		case 'always': {
			return [
				{
					suffix: '@target',
					when: selfOn,
					pose: waterPipePose(placementRotation, pipe.targetAngle, pipe.heightToDownStream),
				},
				{
					suffix: '@initial',
					when: selfOff,
					pose: waterPipePose(placementRotation, pipe.initialAngle, pipe.heightToGround),
				},
			];
		}
		case 'never': {
			return [
				{
					suffix: '@target:dry',
					when: selfOn,
					pose: waterPipePose(placementRotation, pipe.targetAngle, null),
				},
				{
					suffix: '@initial:dry',
					when: selfOff,
					pose: waterPipePose(placementRotation, pipe.initialAngle, null),
				},
			];
		}
		case 'whenAllOn': {
			const upConds = upstream.variables.map((v) => variableIs(v, 1));
			const upReady = game.requirements({ kind: 'all', reverse: false, conditions: upConds });
			const upDry = game.requirements({ kind: 'all', reverse: true, conditions: upConds });
			return [
				{
					suffix: '@target:wet',
					when: allOf(upReady, selfOn),
					pose: waterPipePose(placementRotation, pipe.targetAngle, pipe.heightToDownStream),
				},
				{
					suffix: '@initial:wet',
					when: allOf(upReady, selfOff),
					pose: waterPipePose(placementRotation, pipe.initialAngle, pipe.heightToGround),
				},
				{
					suffix: '@target:dry',
					when: allOf(upDry, selfOn),
					pose: waterPipePose(placementRotation, pipe.targetAngle, null),
				},
				{
					suffix: '@initial:dry',
					when: allOf(upDry, selfOff),
					pose: waterPipePose(placementRotation, pipe.initialAngle, null),
				},
			];
		}
	}
};

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { readChunkLights, type ChunkLight } from '@endfield-noclip/formats/endfield/chunk-lights';
import {
	dynamicResourceSlice,
	readDynamicResources,
	type DynamicModel,
	type DynamicResourceEntity,
	type DynamicResourceGrid,
} from '@endfield-noclip/formats/endfield/dynamic-resources';
import type {
	DynamicEntity as DynamicSceneEntity,
	DynamicGate,
	ExtraSceneSlot,
} from '@endfield-noclip/formats/endfield/dynamic-scene';
import {
	parseDynamicChunk,
	readChunkEntities,
	type ChunkEntity,
} from '@endfield-noclip/formats/endfield/init-chunk-data';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import {
	assetProperty,
	parseStreamingChunk,
	RECT_DECAL_MATERIAL_KEY,
} from '@endfield-noclip/formats/endfield/streaming-chunk-data';
import { unpackHgPayload } from '@endfield-noclip/formats/hg/payload';
import type { ConditionalSetInfo, SceneControl } from '@endfield-noclip/package-format/states';
import { streamAreaControl } from '@endfield-noclip/package-format/stream-areas';

import { mapDefined } from '@mary-ext/array-fns';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { allOf, gateCondition, type Alternatives, type GameState } from './game-state.ts';
import type { PrefabPose } from './prefab.ts';
import { sceneStateControl, SWITCH_VALUES } from './scene-conditions.ts';
import { controllerKey, progressionId } from './scenery-variants.ts';

/** `EDynamicSceneEntityType.Tree`: harvestable trees, whose logic state is standing or felled */
const TREE_ENTITY = 19;

// #region blight

/** `ErosionCoreComponent.STATE_EROSION_DIE`: the core is destroyed and its blight cleansed */
const CORE_DESTROYED = 2;
/** `CompareOperator.NotEqual` */
const NOT_EQUAL = 1;
/**
 * blight control values: the core alive (its variable 0 or 1) or destroyed (2). while the variable is unset
 * neither loads, a state the control leaves out
 */
const BLIGHT_PRESENT = 0;
const BLIGHT_CLEANSED = 1;

/**
 * @returns an erosion root's load gate on its core's state, which loads it until the core is destroyed;
 *   `null` for other entities, and for an erosion root gated some other way (left to its variable's control)
 */
const blightGate = (entity: DynamicSceneEntity): DynamicGate | null => {
	if (entity.erosionCore === null) {
		return null;
	}
	return (
		entity.gates.find(
			(gate) => gate.kind === 'mapVar' && gate.compare === NOT_EQUAL && gate.value === CORE_DESTROYED,
		) ?? null
	);
};

/**
 * @param id the control id of the blight's variable
 * @param position its core's position
 * @returns the control of one blight and its core: its variable, told apart only as the core destroyed or not
 */
const blightControl = (id: string, position: readonly [number, number, number]): SceneControl => ({
	kind: 'mapVar',
	id,
	name: `Blight (${Math.round(position[0])}, ${Math.round(position[2])})`,
	rule: null,
	assumption: 'cleansed, as in a finished world: its core destroyed',
	followsCamera: false,
	levelTags: [],
	values: [
		{ value: BLIGHT_PRESENT, label: 'present' },
		{ value: BLIGHT_CLEANSED, label: 'cleansed' },
	],
	default: BLIGHT_CLEANSED,
	derived: null,
});

// #endregion

/** a prefab placement and its owning level */
export interface StructureModel {
	model: DynamicModel;
	levelTag: number;
	source: string;
	visibility: ConditionalSetInfo;
	/** the pose to draw the prefab in, `null` for the saved one */
	pose: PrefabPose | null;
	/** whether the placement starts locked, drawing its model's locked look; absent for placements without locks */
	locked?: boolean;
}

/** an ECS entity of a dynamic structure */
export interface DynamicEntity {
	entity: ChunkEntity;
	/** a rect decal's material key, from its chunk's `fb_streaming` payload; `null` for other entities */
	decalMaterial: bigint | null;
	visibility: ConditionalSetInfo;
}

/** structures and their visibility decoded from dynamic resources */
export interface DynamicStructures {
	entities: DynamicEntity[];
	/** local lights in the ECS groups, under their structure's visibility */
	lights: { light: ChunkLight; visibility: ConditionalSetInfo }[];
	/** script-group and logic-gate controls; load gates read controls of the game state instead */
	controls: SceneControl[];
	/** MapConfig scene state indices the visibility expressions require, as `sceneStateControl` controls */
	sceneStates: Set<number>;
	/** stream areas the visibility expressions require, as `streamAreaControl` controls */
	areas: Set<number>;
	/** slots for separately stored scenes (Dijiang cabins), one per distinct slot, with the first owner's id */
	slots: { id: string; slot: ExtraSceneSlot }[];
	models: StructureModel[];
	/** by blight core logic id, the control values its blight loads under, which the core itself follows */
	erosionCores: Map<string, Alternatives>;
	/** selections and exclusions, for the pack report */
	counts: Record<string, number>;
}

/**
 * resolves dynamic scenery and preserves progression masks, load gates and manual script/state gates
 *
 * @param context install readers
 * @param scene streaming scene id
 * @param partition level ownership, when available
 * @param game the scene's game state; the load gates' conditions are noted in it and read its controls
 * @returns ECS renderers and prefab placements, deduplicated by their stored resource references
 * @throws {FormatError} if a selected resource has no grid, chunk or group
 */
export const loadDynamicStructures = async (
	context: Pick<Context, 'vfs'>,
	scene: string,
	partition: LevelPartition | undefined,
	game: GameState,
): Promise<DynamicStructures> => {
	const { vfs } = context;
	const prefix = `Data/DynamicStreaming/PC/Scene/${scene}/`;
	const names = [...(await vfs.group(VfsGroup.DynamicStreaming)).files.keys()]
		.filter((name) => name.startsWith(`${prefix}fb_main_`))
		.toSorted();
	const read = async (name: string): Promise<Uint8Array> => {
		const file = await vfs.find(VfsGroup.DynamicStreaming, name);
		if (file === undefined) {
			throw new FormatError(`missing dynamic resource ${name}`);
		}
		return vfs.readVerified(file);
	};
	const grids = new Map<number, DynamicResourceGrid>();
	const owners: DynamicResourceEntity[] = [];
	for (const name of names) {
		// oxlint-disable-next-line no-await-in-loop -- main files are small and released after decoding
		const decoded = readDynamicResources(await read(name));
		for (const grid of decoded.grids) {
			if (grids.has(grid.id)) {
				throw new FormatError(`duplicate dynamic grid ${grid.id}`);
			}
			grids.set(grid.id, grid);
		}
		owners.push(...decoded.entities);
	}
	const result: DynamicStructures = {
		entities: [],
		lights: [],
		models: [],
		controls: [],
		sceneStates: new Set(),
		areas: new Set(),
		slots: [],
		erosionCores: new Map(),
		counts: { owners: owners.length, ecsGroups: 0, models: 0, effects: 0 },
	};
	const controls = new Map<string, SceneControl>();
	// each blight's variable gets a control describing it, claimed before the other gates are noted
	const blights = new Map<DynamicSceneEntity, { gate: DynamicGate; control: SceneControl }>();
	for (const { entity } of owners) {
		const gate = blightGate(entity);
		const condition = gate === null ? null : gateCondition(gate);
		if (gate === null || entity.erosionCore === null || condition?.kind !== 'mapVar') {
			continue;
		}
		const id = game.claimVariable(condition);
		if (id !== null) {
			blights.set(entity, { gate, control: blightControl(id, entity.erosionCore.position) });
		}
	}
	game.note(
		owners.flatMap(({ entity }) => {
			const blight = blights.get(entity)?.gate;
			return entity.gates.filter((gate) => gate !== blight).map(gateCondition);
		}),
	);
	const chunks = new Map<string, Map<number, ConditionalSetInfo>>();
	const models = new Map<string, StructureModel>();
	const ordinals = new Map<number, number>();
	const addSwitch = (kind: 'script' | 'logic', id: string, enabled: boolean): void => {
		if (controls.has(id)) {
			return;
		}
		const base = {
			id,
			name: id,
			rule: null,
			followsCamera: false,
			levelTags: [],
			values: SWITCH_VALUES,
			default: Number(enabled),
			derived: null,
		};
		controls.set(
			id,
			kind === 'logic'
				? { kind, ...base, assumption: 'no recovered controller, so off' }
				: {
						kind,
						...base,
						assumption: enabled
							? 'authored to load until a script hides it'
							: 'loads only when a level script shows it',
						drivers: [],
					},
		);
	};
	for (const owner of owners) {
		const { entity } = owner;
		const ordinal = ordinals.get(entity.grid) ?? 0;
		ordinals.set(entity.grid, ordinal + 1);
		// level scripts address script-controlled entities by their global id, which holds across builds
		const owned = entity.uid === null ? `${entity.grid}:${ordinal}` : String(entity.uid);
		// a slot is stored on two entities with identical components
		const { extraScene } = entity;
		if (
			extraScene !== null &&
			!result.slots.some(({ slot }) => slot.position.every((v, i) => v === extraScene.position[i]))
		) {
			result.slots.push({ id: owned, slot: extraScene });
		}
		const controller = entity.controllers[0];
		const blight = blights.get(entity);
		let gates = entity.gates.reduce<Alternatives>(
			(partial, gate) =>
				gate === blight?.gate ? partial : allOf(partial, game.requirements(gateCondition(gate))),
			[[]],
		);
		if (blight !== undefined && entity.erosionCore !== null) {
			controls.set(blight.control.id, blight.control);
			gates = allOf(gates, [[{ control: blight.control.id, mask: 1 << BLIGHT_PRESENT }]]);
			result.erosionCores.set(String(entity.erosionCore.id), gates);
		}
		for (const [i, group] of entity.resourceGroups.entries()) {
			const ref = group.resources;
			if (ref.count === 0) {
				continue;
			}
			const tag = partition?.levels.find((level) => level.idNum === group.levelNum)?.tag ?? 0;
			let alternatives = gates;
			if (owner.scriptDefaultLoad !== null) {
				addSwitch('script', `script:${owned}`, owner.scriptDefaultLoad);
				alternatives = allOf(alternatives, [[{ control: `script:${owned}`, mask: 2 }]]);
			}
			if (group.logicState !== 0) {
				if (controller) {
					alternatives = allOf(alternatives, [
						[{ control: progressionId(controller.kind, controllerKey(controller)), mask: group.logicState }],
					]);
				} else if (entity.entityType === TREE_ENTITY) {
					// bit 0 standing, bit 1 the stump: the player fells each tree at runtime, so one control per
					// level previews them all
					const id = `harvest:${tag}`;
					if (!controls.has(id)) {
						controls.set(id, {
							kind: 'harvest',
							id,
							name: 'Harvestable trees',
							rule: null,
							assumption: 'standing, as before the player fells them',
							followsCamera: false,
							levelTags: [],
							values: [
								{ value: 0, label: 'standing' },
								{ value: 1, label: 'felled' },
							],
							default: 0,
							derived: null,
						});
					}
					alternatives = allOf(alternatives, [[{ control: id, mask: group.logicState }]]);
				} else if ((group.logicState & 1) === 0) {
					const id = `logic:${owned}:${group.logicState}`;
					addSwitch('logic', id, false);
					alternatives = allOf(alternatives, [[{ control: id, mask: 2 }]]);
				}
			}
			// visible-state lists hold MapConfig scene state indices; the entity and the group each need one of
			// theirs active
			for (const states of [owner.states, owner.groupStates[i]]) {
				if (states.length === 0) {
					continue;
				}
				for (const index of states) {
					result.sceneStates.add(index);
				}
				alternatives = allOf(
					alternatives,
					states.map((index) => [{ control: sceneStateControl(index), mask: 2 }]),
				);
			}
			// visible-area lists hold stream areas, shown while the camera is in a trigger zone listing one; area 0
			// is shown everywhere
			for (const areas of [owner.areas, owner.groupAreas[i]]) {
				if (areas.length === 0 || areas.includes(0)) {
					continue;
				}
				for (const area of areas) {
					result.areas.add(area);
				}
				alternatives = allOf(
					alternatives,
					areas.map((area) => [{ control: streamAreaControl(area), mask: 2 }]),
				);
			}
			const grid = grids.get(ref.grid);
			if (!grid) {
				throw new FormatError(`missing dynamic grid ${ref.grid}`);
			}
			switch (ref.type) {
				// effect rows place prefabs like model rows, from their own vector
				case 5:
				case 6: {
					const effect = ref.type === 6;
					const rows = dynamicResourceSlice(effect ? grid.effects : grid.models, ref);
					if (effect) {
						result.counts.effects += rows.length;
					}
					for (const [index, model] of rows.entries()) {
						const key = `${effect ? 'effect:' : ''}${ref.grid}/${ref.index + index}`;
						models
							.getOrInsertComputed(key, () => ({
								model,
								levelTag: tag,
								source: key,
								visibility: { alternatives: [] },
								pose: null,
							}))
							.visibility.alternatives.push(...alternatives);
					}
					break;
				}
				case 7: {
					for (const ecs of dynamicResourceSlice(grid.ecs, ref)) {
						const key = `${ecs.sceneIndex.toString().padStart(2, '0')}_${ecs.chunk.toString().padStart(8, '0')}`;
						chunks
							.getOrInsertComputed(key, () => new Map())
							.getOrInsertComputed(ecs.index, () => ({ alternatives: [] }))
							.alternatives.push(...alternatives);
					}
					break;
				}
				default: {
					throw new FormatError(`unsupported dynamic resource type ${ref.type}`);
				}
			}
		}
	}
	const entities = new Map<number, DynamicEntity>();
	const lights = new Map<number, { light: ChunkLight; visibility: ConditionalSetInfo }>();
	for (const [key, indices] of chunks) {
		// oxlint-disable-next-line no-await-in-loop -- release each pair after its renderer groups are decoded
		const [init, streaming] = await Promise.all([
			read(`${prefix}fb_init_${key}.bytes`),
			read(`${prefix}fb_streaming_${key}.bytes`),
		]);
		const initPayload = unpackHgPayload(init);
		const streamingPayload = unpackHgPayload(streaming);
		const chunk = parseDynamicChunk(initPayload, streamingPayload);
		const chunkLights = new Map(readChunkLights(initPayload, chunk).map((light) => [light.id, light]));
		// the streaming payload binds rect decals' materials as StreamingChunkData does
		let decalMaterials: Map<number, bigint> | null = null;
		const decalMaterial = (id: number): bigint | null => {
			decalMaterials ??= new Map(
				mapDefined(parseStreamingChunk(streamingPayload).records, (record): [number, bigint] | undefined => {
					const material = assetProperty(record, RECT_DECAL_MATERIAL_KEY);
					return material === undefined ? undefined : [record.id, material];
				}),
			);
			return decalMaterials.get(id) ?? null;
		};
		for (const [index, visibility] of indices) {
			const group = chunk.groups[index];
			if (!group) {
				throw new FormatError(`missing ECS group ${key}/${index}`);
			}
			result.counts.ecsGroups++;
			for (const entity of readChunkEntities({ ...chunk, groups: [group] })) {
				entities
					.getOrInsertComputed(entity.id, () => ({
						entity,
						decalMaterial: entity.decal === null ? null : decalMaterial(entity.id),
						visibility: { alternatives: [] },
					}))
					.visibility.alternatives.push(...visibility.alternatives);
			}
			for (const id of group.ids) {
				const light = chunkLights.get(id);
				if (light !== undefined) {
					lights
						.getOrInsertComputed(id, () => ({ light, visibility: { alternatives: [] } }))
						.visibility.alternatives.push(...visibility.alternatives);
				}
			}
		}
	}
	// representative renderer names identify manual groups without assigning an invented event condition.
	const labels = new Map<string, Map<string, number>>();
	for (const { entity, visibility } of entities.values()) {
		const name = entity.name.replace(/#.*$/, '').replace(/ \(\d+\)(?:_ECSMerged)?$/, '');
		for (const control of new Set(
			visibility.alternatives.flatMap((requirements) =>
				requirements.map((requirement) => requirement.control),
			),
		)) {
			const frequencies = labels.getOrInsertComputed(control, () => new Map());
			frequencies.set(name, (frequencies.get(name) ?? 0) + 1);
		}
	}
	for (const control of controls.values()) {
		// script and logic switches are named after what they show; the others carry their own names
		if (control.kind !== 'script' && control.kind !== 'logic') {
			continue;
		}
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		const ranked = [...(labels.get(control.id) ?? [])].sort((a, b) => b[1] - a[1]);
		control.name =
			ranked
				.slice(0, 2)
				.map(([name]) => name)
				.join(' / ') || control.id;
	}
	result.entities = [...entities.values()];
	result.lights = [...lights.values()];
	result.models = [...models.values()];
	result.controls = [...controls.values()];
	result.counts.models = result.models.length;
	return result;
};

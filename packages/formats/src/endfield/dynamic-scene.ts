import { FormatError } from '../binary/binary-reader.ts';
import { FlatBuffer } from '../binary/flatbuffer.ts';

// DynamicStreaming main grids: `Data/DynamicStreaming/PC/Scene/<scene>/fb_main_<L>_<i>_<j>.bytes`.
// field indices and record layouts follow Variante/endfield_research_kit (MIT,
// `scripts/game_data/contracts/dynamic_{main_vector,root_comp,resource_comp,scalar_components}_native.json`);
// the ResourceComp stride (132, not the contract's 124) and the DataIndex type → vector pairing were measured
// on the client. layout in docs/game-data/assets.md#fb_main-grids; load gates in
// docs/game-data/scene-states.md#dynamic-load-gates.

// #region types

/** EDynamicSceneData values this reader uses (DataIndex/DataGroup `type`) */
export const DynamicData = {
	Model: 5,
	Effect: 6,
	Ecs: 7,
	ResourceGroupWithStateDesc: 10,
	MissionCondition: 14,
	IdComp: 15,
	MissionControlComp: 25,
	GlobalVarControlComp: 26,
	SettlementControlComp: 27,
	FactoryRegionControlComp: 28,
	ScriptControlComp: 29,
	ResourceComp: 30,
	ErosionRootComp: 34,
	ModelViewStateControllerNewComp: 35,
	SludgeComp: 42,
	ExtraSceneComp: 44,
	WaterPipeComp: 47,
	MapVarControlComp: 51,
	PoiControlComp: 55,
	LodGridResource: 59,
} as const;

/** a typed slice of a grid vector */
export interface DynamicDataRef {
	type: number;
	/** unique id of the grid holding the rows */
	grid: number;
	index: number;
	count: number;
}

/** a stored dynamic model placement; Euler angles are in Unity's degrees */
export interface DynamicModel {
	pathHash: bigint;
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
}

/** a stored dynamic effect placement */
export interface DynamicEffect extends DynamicModel {
	/** the grid ids its LOD proxy follows: a near grid, then a far grid */
	lodGrids: [near: number, far: number];
}

/** one component-group ordinal in a paired dynamic ECS chunk */
export interface DynamicEcs {
	chunk: number;
	index: number;
	sceneIndex: number;
}

/** a main-file grid's geometry payloads, decoded lazily per vector on first access */
export interface DynamicGrid {
	readonly id: number;
	readonly models: readonly DynamicModel[];
	/** effect prefab placements, stored apart from models */
	readonly effects: readonly DynamicEffect[];
	readonly ecs: readonly DynamicEcs[];
}

/** a set of resources an entity shows in some of its logic states */
export interface DynamicResourceGroup {
	resources: DynamicDataRef;
	sceneState: number;
	/**
	 * bit `n` set: the group is shown while the entity's logic state is `n`; 0 means the group ignores logic
	 * state. progression entities use the bit index as their level
	 */
	logicState: number;
	/** LevelConfig idNum of the level the group belongs to */
	levelNum: number;
	factoryIndex: number;
	/** MapConfig scene state indices, any of which shows the group; empty for any state */
	states: number[];
	/** stream area ids, any of which shows the group; area 0 is shown everywhere */
	areas: number[];
	/**
	 * 0-based rank in a `ResourceComp.LodInfo` (`LodGridResource`) swap chain (0 = finest present LOD, 1/2 =
	 * coarser far-distance stand-ins), or `null` when not part of an LOD chain
	 */
	lod: number | null;
}

/** what drives an entity's logic state */
export type DynamicController =
	| { kind: 'settlement'; settlementId: string; isMain: boolean }
	| { kind: 'factoryRegion'; regionId: string }
	| { kind: 'poi'; poiId: string; domainType: number };

/** one quest or mission state test of a mission gate */
export interface DynamicMissionCondition {
	/** quest or mission id */
	id: string;
	isQuest: boolean;
	/** `QuestState` / `MissionState` value */
	state: number;
	/** true: the state must equal `state`; false: it must differ */
	same: boolean;
}

/** a condition the game loads an entity by */
export type DynamicGate =
	| {
			kind: 'mission';
			/** true: every condition must hold; false: one is enough */
			all: boolean;
			/** the entity loads while the combined result equals this */
			loadWhen: boolean;
			conditions: DynamicMissionCondition[];
	  }
	| {
			kind: 'globalVar' | 'mapVar';
			/** variable id; ids aren't names and the client tables that name them aren't read */
			key: number;
			/** `CompareOperator` (Equal 0 … LessEqual 5) applied as `variable <op> value` */
			compare: number;
			value: number;
			/** MapVarControlComp mapId; `null` for global variables */
			mapId: number | null;
	  };

/** a variable an entity reads */
export interface DynamicVariable {
	kind: 'globalVar' | 'mapVar';
	/** variable id */
	key: number;
	/** MapVarControlComp mapId; `null` for global variables */
	mapId: number | null;
}

/** an entity's view-state controller (`ModelViewStateControllerNewComp`) */
export interface DynamicViewState {
	/** the `ModelViewStateControllerData` file it runs, by name; `null` for an old controller without one */
	model: string | null;
	/** whether it runs the old controller, keyed by its own state-to-name map, rather than {@link model} */
	oldVersion: boolean;
}

/** a DynamicStreaming entity */
export interface DynamicEntity {
	/** grid unique id */
	grid: number;
	/** global entity id from IdComp, or `null` without one */
	uid: bigint | null;
	entityType: number;
	/** DataIndex types of its components */
	components: number[];
	controllers: DynamicController[];
	/** load conditions; all must hold. variable components that don't control loading aren't listed */
	gates: DynamicGate[];
	/**
	 * every variable component, whether or not it controls loading: each applies its variable's value to the
	 * entity's level and view-state key `state`
	 */
	variables: DynamicVariable[];
	/** the entity's view-state controller, or `null` without one */
	viewState: DynamicViewState | null;
	resourceGroups: DynamicResourceGroup[];
	/** MapConfig scene state indices, any of which shows the entity; empty for any state */
	states: number[];
	/** stream area ids, any of which shows the entity; area 0 is shown everywhere */
	areas: number[];
	/** null without script control; false means scripts must explicitly enable the entity */
	scriptDefaultLoad: boolean | null;
	/** an `ExtraSceneSlot`'s slot, where a separately stored scene (a Dijiang cabin) is placed; `null` otherwise */
	extraScene: ExtraSceneSlot | null;
	/** the blight core whose blight this entity is, `null` for other entities */
	erosionCore: ErosionCoreLink | null;
	/** the erosion sludge core whose sludge this entity is, `null` for other entities */
	sludgeCore: SludgeCoreLink | null;
	/** water pipe or outfall configuration (`WaterPipeComp`), `null` for other entities */
	waterPipe: WaterPipe | null;
}

/** a dynamic water pipe or outfall (`FBDynamicSceneWaterPipeComp`) */
export interface WaterPipe {
	/** this pipe's interactive logic id in LevelData */
	interactiveId: bigint;
	/** upstream pipe or outfall's interactive logic id, `0n` when fed directly by a waterfall */
	upstreamInteractiveId: bigint;
	/** whether this entity is an outfall source rather than a rotatable chute */
	isOutFall: boolean;
	/** whether its downstream water hits a waterwheel (for audio) */
	connectedToWaterWheel: boolean;
	/** world Y rotation in degrees when not aligned to target (`state !== 1`) */
	initialAngle: number;
	/** world Y rotation in degrees when aligned to target (`state === 1`) */
	targetAngle: number;
	/** seconds before activating downstream after aligning */
	delayActivateDownStream: number;
	/** waterfall drop length in metres when aligned to downstream */
	heightToDownStream: number;
	/** waterfall drop length in metres when pouring to the ground */
	heightToGround: number;
}

/** decoded grids and entities of one `fb_main_*` file */
export interface DynamicScene {
	grids: DynamicGrid[];
	entities: DynamicEntity[];
}

/** the blight core an erosion root belongs to */
export interface ErosionCoreLink {
	/** the core's logic id in level data */
	id: bigint;
	position: [number, number, number];
}

/** the erosion sludge core and heightfield geometry of a sludge patch (`FBDynamicSceneSludgeComp`) */
export interface SludgeCoreLink {
	/** the core's logic id in level data */
	id: bigint;
	/** the patch's position */
	position: [number, number, number];
	/** grid side length in metres */
	sludgeSize: number;
	/** height scale in metres */
	sizeY: number;
	/** world-space origin of the patch's local `(0, 0, 0)` corner */
	origin: [number, number, number];
	up: [number, number, number];
	right: [number, number, number];
	forward: [number, number, number];
	/** StringPathHash of the sludge material (`M_sludgeV2` / `M_sludgeV2_high`) */
	materialHash: bigint;
	/** StringPathHash of the baked heightmap texture (`Slu__<level>__<id>.png`) */
	textureHash: bigint;
	/** packed clip planes (`EncodedClipPlane0/1`) */
	clipPlane0: number;
	clipPlane1: number;
}

/** a slot for a separately stored scene, in world space */
export interface ExtraSceneSlot {
	/** the slot's box */
	min: [number, number, number];
	max: [number, number, number];
	/** where the placed scene's origin goes */
	position: [number, number, number];
	/** the placed scene's turn about the vertical axis, in quarter turns */
	direction: number;
}

// #endregion

/** FlatBuffer field slots: the root's two, then a grid's id and record vectors */
const Slot = {
	RootGrids: 3,
	RootStrings: 4,
	GridUniqueId: 0,
	Integers: 3,
	DataIndex: 5,
	Models: 7,
	Effects: 8,
	Ecs: 9,
	ResourceGroupWithStateDesc: 12,
	MissionCondition: 16,
	IdComp: 17,
	MissionControlComp: 27,
	GlobalVarControlComp: 28,
	SettlementControlComp: 29,
	FactoryRegionControlComp: 30,
	ScriptControlComp: 31,
	ResourceComp: 32,
	RootComp: 33,
	ErosionRootComp: 36,
	ModelViewStateControllerNewComp: 37,
	SludgeComp: 44,
	ExtraSceneComp: 46,
	WaterPipeComp: 49,
	MapVarControlComp: 52,
	PoiControlComp: 55,
	LodGridResource: 57,
} as const;

/** record strides, in bytes */
const Width = {
	DataIndex: 16,
	Model: 104,
	Effect: 144,
	Ecs: 36,
	ResourceGroupWithStateDesc: 88,
	MissionCondition: 16,
	IdComp: 16,
	MissionControlComp: 32,
	GlobalVarControlComp: 40,
	SettlementControlComp: 20,
	FactoryRegionControlComp: 8,
	ScriptControlComp: 4,
	ResourceComp: 132,
	RootComp: 84,
	MapVarControlComp: 48,
	PoiControlComp: 8,
	ExtraSceneComp: 40,
	ErosionRootComp: 48,
	ModelViewStateControllerNewComp: 36,
	SludgeComp: 264,
	WaterPipeComp: 48,
	LodGridResource: 92,
} as const;

class LazyDynamicGrid implements DynamicGrid {
	readonly id: number;
	readonly #fb: FlatBuffer;
	readonly #table: number;
	#models: DynamicModel[] | undefined;
	#effects: DynamicEffect[] | undefined;
	#ecs: DynamicEcs[] | undefined;

	constructor(id: number, fb: FlatBuffer, table: number) {
		this.id = id;
		this.#fb = fb;
		this.#table = table;
	}

	get models(): DynamicModel[] {
		if (this.#models === undefined) {
			const fb = this.#fb;
			const vector = fb.vector(this.#table, Slot.Models);
			this.#models = Array.from({ length: vector.length }, (_, n) => {
				const at = vector.start + n * Width.Model;
				return {
					pathHash: fb.u64(at + 64),
					position: fb.vec3(at + 16),
					rotation: fb.vec3(at + 28),
					scale: fb.vec3(at + 40),
				};
			});
		}
		return this.#models;
	}

	get effects(): DynamicEffect[] {
		if (this.#effects === undefined) {
			const fb = this.#fb;
			const vector = fb.vector(this.#table, Slot.Effects);
			this.#effects = Array.from({ length: vector.length }, (_, n) => {
				const at = vector.start + n * Width.Effect;
				const position = fb.vec3(at + 12);
				// each row repeats its position at +116, which confirms the stride
				if (fb.vec3(at + 116).some((value, axis) => value !== position[axis])) {
					throw new FormatError(`unexpected dynamic effect row layout in grid ${this.id}`);
				}
				return {
					pathHash: fb.u64(at + 48),
					position,
					rotation: fb.vec3(at + 24),
					scale: fb.vec3(at + 36),
					lodGrids: [fb.u32(at + 56), fb.u32(at + 60)],
				};
			});
		}
		return this.#effects;
	}

	get ecs(): DynamicEcs[] {
		if (this.#ecs === undefined) {
			const fb = this.#fb;
			const vector = fb.vector(this.#table, Slot.Ecs);
			this.#ecs = Array.from({ length: vector.length }, (_, n) => {
				const at = vector.start + n * Width.Ecs;
				return { chunk: fb.i32(at), index: fb.i32(at + 4), sceneIndex: fb.i32(at + 32) };
			});
		}
		return this.#ecs;
	}
}

/**
 * reads entities and visibility gates from a DynamicStreaming main file; each grid's model, effect and ECS
 * vectors are decoded lazily on first access
 *
 * @param bytes verified, uncompressed `fb_main_*` bytes
 * @returns grids and entities in stored order
 * @throws {FormatError} if a component reference, visibility span, or row layout is invalid
 */
export const readDynamicScene = (bytes: Uint8Array): DynamicScene => {
	const fb = new FlatBuffer(bytes);
	const root = fb.root();
	const strings = fb.vector(root, Slot.RootStrings);
	const rootString = (index: number): string => {
		if (index < 0 || index >= strings.length) {
			throw new FormatError(`root string ${index} outside ${strings.length}`);
		}
		return fb.stringAt(fb.deref(strings.start + index * 4));
	};
	const dataRef = (at: number): DynamicDataRef => ({
		type: fb.i32(at + 4),
		grid: fb.u32(at + 8),
		index: fb.i32(at + 12),
		count: fb.i32(at + 16),
	});

	const grids: DynamicGrid[] = [];
	const entities: DynamicEntity[] = [];
	const gridVector = fb.vector(root, Slot.RootGrids);
	const gridTables = new Map<number, number>();
	for (let g = 0; g < gridVector.length; g++) {
		const grid = fb.tableAt(gridVector.start, g);
		const gridId = fb.u32Field(grid, Slot.GridUniqueId);
		if (gridTables.has(gridId)) {
			throw new FormatError(`duplicate grid ${gridId}`);
		}
		gridTables.set(gridId, grid);
	}
	// gate components and their condition rows may live in another grid of the file
	const rowIn = (gridId: number, slot: number, index: number, width: number, what: string): number => {
		const grid = gridTables.get(gridId);
		if (grid === undefined) {
			throw new FormatError(`${what} in missing grid ${gridId}`);
		}
		const vector = fb.vector(grid, slot);
		if (index < 0 || index >= vector.length) {
			throw new FormatError(`${what} ${index} outside ${vector.length} in grid ${gridId}`);
		}
		return vector.start + index * width;
	};
	/** reads a variable component: the variable it reads, and its load gate when it controls loading */
	const variableComp = (
		kind: 'globalVar' | 'mapVar',
		at: number,
	): { variable: DynamicVariable; gate: DynamicGate | null } => {
		const controlLoad = fb.u8(at + 4);
		const compare = fb.i32(at + 8);
		if (controlLoad > 1 || compare < 0 || compare > 5) {
			throw new FormatError(`invalid ${kind} control (load ${controlLoad}, compare ${compare})`);
		}
		const variable = { kind, key: fb.i32(at), mapId: kind === 'mapVar' ? fb.i32(at + 40) : null };
		return {
			variable,
			gate: controlLoad === 0 ? null : { ...variable, compare, value: fb.i64Number(at + 16) },
		};
	};

	for (const [gridId, grid] of gridTables) {
		const integers = fb.vector(grid, Slot.Integers);
		const visibility = (at: number): number[] => {
			const invalid = fb.u8(at);
			const index = fb.i32(at + 12);
			const count = fb.i32(at + 16);
			if (
				invalid > 1 ||
				Boolean(invalid) === Boolean(count) ||
				fb.i32(at + 20) !== integers.length ||
				fb.i32(at + 4) !== 49 ||
				fb.u32(at + 8) !== gridId ||
				index < 0 ||
				count < 0 ||
				index + count > integers.length
			) {
				throw new FormatError(`invalid dynamic visibility span in grid ${gridId}`);
			}
			return Array.from({ length: count }, (_, n) => fb.i32(integers.start + (index + n) * 4));
		};

		grids.push(new LazyDynamicGrid(gridId, fb, grid));

		const vectors = {
			dataIndex: fb.vector(grid, Slot.DataIndex),
			groups: fb.vector(grid, Slot.ResourceGroupWithStateDesc),
			ids: fb.vector(grid, Slot.IdComp),
			settlements: fb.vector(grid, Slot.SettlementControlComp),
			regions: fb.vector(grid, Slot.FactoryRegionControlComp),
			scripts: fb.vector(grid, Slot.ScriptControlComp),
			resources: fb.vector(grid, Slot.ResourceComp),
			roots: fb.vector(grid, Slot.RootComp),
			pois: fb.vector(grid, Slot.PoiControlComp),
		};
		const row = (vector: { start: number; length: number }, index: number, width: number, what: string) => {
			if (index < 0 || index >= vector.length) {
				throw new FormatError(`${what} ${index} outside ${vector.length} in grid ${gridId}`);
			}
			return vector.start + index * width;
		};

		for (let r = 0; r < vectors.roots.length; r++) {
			const at = vectors.roots.start + r * Width.RootComp;
			const comps = dataRef(at + 8);
			const entity: DynamicEntity = {
				grid: gridId,
				uid: null,
				entityType: fb.u32(at),
				components: [],
				controllers: [],
				gates: [],
				variables: [],
				viewState: null,
				resourceGroups: [],
				states: visibility(at + 36),
				areas: visibility(at + 60),
				scriptDefaultLoad: null,
				extraScene: null,
				erosionCore: null,
				sludgeCore: null,
				waterPipe: null,
			};
			for (let c = 0; c < comps.count; c++) {
				const di = row(vectors.dataIndex, comps.index + c, Width.DataIndex, 'DataIndex');
				const type = fb.i32(di + 4);
				const index = fb.i32(di + 12);
				entity.components.push(type);
				switch (type) {
					case DynamicData.MissionControlComp: {
						const m = rowIn(
							fb.u32(di + 8),
							Slot.MissionControlComp,
							index,
							Width.MissionControlComp,
							'MissionControlComp',
						);
						const list = dataRef(m);
						const toBeTrue = fb.i32(m + 28);
						if (list.count > 0 && list.type !== DynamicData.MissionCondition) {
							throw new FormatError(`MissionControlComp ${index} has Conditions type ${list.type}`);
						}
						if (toBeTrue !== 0 && toBeTrue !== 1) {
							throw new FormatError(`invalid MissionControlComp toBeTrue ${toBeTrue}`);
						}
						const conditions: DynamicMissionCondition[] = [];
						for (let k = 0; k < list.count; k++) {
							const q = rowIn(
								list.grid,
								Slot.MissionCondition,
								list.index + k,
								Width.MissionCondition,
								'MissionCondition',
							);
							conditions.push({
								id: rootString(fb.i32(q)),
								isQuest: fb.i32(q + 4) !== 0,
								state: fb.i32(q + 8),
								same: fb.i32(q + 12) === 1,
							});
						}
						entity.gates.push({
							kind: 'mission',
							all: fb.i32(m + 24) === 0,
							loadWhen: toBeTrue === 1,
							conditions,
						});
						break;
					}
					case DynamicData.GlobalVarControlComp: {
						const { variable, gate } = variableComp(
							'globalVar',
							rowIn(
								fb.u32(di + 8),
								Slot.GlobalVarControlComp,
								index,
								Width.GlobalVarControlComp,
								'GlobalVarControlComp',
							),
						);
						entity.variables.push(variable);
						if (gate) {
							entity.gates.push(gate);
						}
						break;
					}
					case DynamicData.MapVarControlComp: {
						const { variable, gate } = variableComp(
							'mapVar',
							rowIn(
								fb.u32(di + 8),
								Slot.MapVarControlComp,
								index,
								Width.MapVarControlComp,
								'MapVarControlComp',
							),
						);
						entity.variables.push(variable);
						if (gate) {
							entity.gates.push(gate);
						}
						break;
					}
					case DynamicData.ModelViewStateControllerNewComp: {
						const s = rowIn(
							fb.u32(di + 8),
							Slot.ModelViewStateControllerNewComp,
							index,
							Width.ModelViewStateControllerNewComp,
							'ModelViewStateControllerNewComp',
						);
						const model = fb.i32(s);
						entity.viewState = {
							model: model < 0 ? null : rootString(model),
							oldVersion: fb.u8(s + 4) !== 0,
						};
						break;
					}
					case DynamicData.IdComp: {
						const id = row(vectors.ids, index, Width.IdComp, 'IdComp');
						entity.uid = fb.u64(id);
						break;
					}
					case DynamicData.ExtraSceneComp: {
						const s = rowIn(
							fb.u32(di + 8),
							Slot.ExtraSceneComp,
							index,
							Width.ExtraSceneComp,
							'ExtraSceneComp',
						);
						entity.extraScene = {
							min: fb.vec3(s),
							max: fb.vec3(s + 12),
							position: fb.vec3(s + 24),
							direction: fb.u32(s + 36),
						};
						break;
					}
					case DynamicData.ErosionRootComp: {
						const s = rowIn(
							fb.u32(di + 8),
							Slot.ErosionRootComp,
							index,
							Width.ErosionRootComp,
							'ErosionRootComp',
						);
						entity.erosionCore = {
							id: fb.u64(s),
							position: fb.vec3(s + 32),
						};
						break;
					}
					case DynamicData.SludgeComp: {
						const s = rowIn(fb.u32(di + 8), Slot.SludgeComp, index, Width.SludgeComp, 'SludgeComp');
						entity.sludgeCore = {
							id: fb.u64(s + 248),
							position: fb.vec3(s + 96),
							sludgeSize: fb.u32(s),
							sizeY: fb.f32(s + 4),
							origin: fb.vec3(s + 48),
							up: fb.vec3(s + 60),
							right: fb.vec3(s + 72),
							forward: fb.vec3(s + 84),
							materialHash: fb.u64(s + 112),
							textureHash: fb.u64(s + 120),
							clipPlane0: fb.u32(s + 216),
							clipPlane1: fb.u32(s + 220),
						};
						break;
					}
					case DynamicData.WaterPipeComp: {
						const s = rowIn(fb.u32(di + 8), Slot.WaterPipeComp, index, Width.WaterPipeComp, 'WaterPipeComp');
						const connected = fb.u8(s + 8);
						const isOutFall = fb.u8(s + 44);
						if (connected > 1 || isOutFall > 1) {
							throw new FormatError(
								`invalid WaterPipeComp flags (connected ${connected}, isOutFall ${isOutFall})`,
							);
						}
						entity.waterPipe = {
							interactiveId: fb.u64(s + 16),
							upstreamInteractiveId: fb.u64(s + 24),
							isOutFall: isOutFall !== 0,
							connectedToWaterWheel: connected !== 0,
							initialAngle: fb.f32(s),
							targetAngle: fb.f32(s + 4),
							delayActivateDownStream: fb.f32(s + 32),
							heightToDownStream: fb.f32(s + 36),
							heightToGround: fb.f32(s + 40),
						};
						break;
					}
					case DynamicData.SettlementControlComp: {
						const s = row(vectors.settlements, index, Width.SettlementControlComp, 'SettlementControlComp');
						entity.controllers.push({
							kind: 'settlement',
							settlementId: rootString(fb.i32(s)),
							isMain: fb.u8(s + 16) !== 0,
						});
						break;
					}
					case DynamicData.FactoryRegionControlComp: {
						const s = row(vectors.regions, index, Width.FactoryRegionControlComp, 'FactoryRegionControlComp');
						entity.controllers.push({ kind: 'factoryRegion', regionId: rootString(fb.i32(s)) });
						break;
					}
					case DynamicData.PoiControlComp: {
						const s = row(vectors.pois, index, Width.PoiControlComp, 'PoiControlComp');
						entity.controllers.push({ kind: 'poi', poiId: rootString(fb.i32(s)), domainType: fb.i32(s + 4) });
						break;
					}
					case DynamicData.ScriptControlComp: {
						const value = fb.i32(row(vectors.scripts, index, Width.ScriptControlComp, 'ScriptControlComp'));
						if (value !== 0 && value !== 1) {
							throw new FormatError(`invalid script default load ${value}`);
						}
						entity.scriptDefaultLoad = value === 1;
						break;
					}
					case DynamicData.ResourceComp: {
						const rc = row(vectors.resources, index, Width.ResourceComp, 'ResourceComp');
						const res = dataRef(rc);
						if (res.count > 0 && res.type !== DynamicData.ResourceGroupWithStateDesc) {
							throw new FormatError(`ResourceComp ${index} in grid ${gridId} has Res type ${res.type}`);
						}
						const lodByGroup = new Map<number, number>();
						const lodInfo = dataRef(rc + 100);
						if (fb.i32(rc + 100) === 0 && lodInfo.count > 0) {
							if (lodInfo.type !== DynamicData.LodGridResource) {
								throw new FormatError(
									`ResourceComp ${index} in grid ${gridId} has LodInfo type ${lodInfo.type}`,
								);
							}
							for (let k = 0; k < lodInfo.count; k++) {
								const lgr = rowIn(
									lodInfo.grid,
									Slot.LodGridResource,
									lodInfo.index + k,
									Width.LodGridResource,
									'LodGridResource',
								);
								let rank = 0;
								for (const offset of [12, 28, 44]) {
									if (fb.i32(lgr + offset) !== 0) {
										continue;
									}
									if (fb.i32(lgr + offset + 4) !== DynamicData.ResourceGroupWithStateDesc) {
										throw new FormatError(
											`LodGridResource ${lodInfo.index + k} in grid ${lodInfo.grid} has group type ${fb.i32(lgr + offset + 4)}`,
										);
									}
									if (fb.u32(lgr + offset + 8) === gridId) {
										lodByGroup.set(fb.i32(lgr + offset + 12), rank);
									}
									rank++;
								}
							}
						}
						for (let k = 0; k < res.count; k++) {
							const groupIndex = res.index + k;
							const desc = row(
								vectors.groups,
								groupIndex,
								Width.ResourceGroupWithStateDesc,
								'ResourceGroupWithStateDesc',
							);
							entity.resourceGroups.push({
								resources: dataRef(desc),
								sceneState: fb.u32(desc + 24),
								logicState: fb.u32(desc + 28),
								levelNum: fb.i32(desc + 32),
								factoryIndex: fb.i32(desc + 36),
								states: visibility(desc + 40),
								areas: visibility(desc + 64),
								lod: lodByGroup.get(groupIndex) ?? null,
							});
						}
						break;
					}
				}
			}
			entities.push(entity);
		}
	}
	return { grids, entities };
};

/**
 * resolves a bounds-checked typed resource slice
 *
 * @param rows the selected grid's model, effect or ECS vector
 * @param ref resource-group reference to that vector
 * @returns the referenced rows
 * @throws {FormatError} if the slice lies outside the vector
 */
export const dynamicResourceSlice = <T>(rows: readonly T[], ref: DynamicDataRef): T[] => {
	if (ref.index < 0 || ref.count < 0 || ref.index + ref.count > rows.length) {
		throw new FormatError(`dynamic resource slice outside grid ${ref.grid}`);
	}
	return rows.slice(ref.index, ref.index + ref.count);
};

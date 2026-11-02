import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	readInteractiveBaseModel,
	readInteractiveTable,
	readInteractiveVariantModels,
} from '@endfield-noclip/formats/endfield/interactive-model';
import {
	type LevelInteractive,
	readLevelDataPrefix,
	UnsupportedLevelData,
} from '@endfield-noclip/formats/endfield/level-interactives';
import type { LevelPartition } from '@endfield-noclip/formats/endfield/level-partition';
import type { MemoryPackValue } from '@endfield-noclip/formats/endfield/memory-pack';
import { parseSparkTable } from '@endfield-noclip/formats/hg/spark-buffer';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { isObject, numberField, objectField, stringField } from '@endfield-noclip/formats/unity/values';
import type {
	ConditionalSetInfo,
	ProximityInfo,
	SceneControl,
	ScriptControl,
} from '@endfield-noclip/package-format/states';

import type { Context } from '../context.ts';
import { VfsGroup } from '../hg/vfs.ts';

import { readDoodadShell, type DoodadShell } from './doodad-shell.ts';
import { readDoorPoses, type DoorPoses } from './door-poses.ts';
import type { StructureModel } from './dynamic-structures.ts';
import { allOf, type Alternatives } from './game-state.ts';
import type { PrefabPose } from './prefab.ts';
import { SWITCH_VALUES } from './scene-conditions.ts';
import { progressionControl } from './scenery-variants.ts';
import { readTelescopicPoses, type TelescopicPoses } from './telescopic-bridge.ts';
import { type ModelViews, readViewStates, settledPose } from './view-state-poses.ts';

// templates with the model-upgrade component have their visual forms as a progression control; every other
// template draws its base model only. templates carry no display name, so these labels are ours; other
// upgrade-capable templates are labelled by their id
const FACILITY_NAMES = new Map([
	['int_system_domain_shop', 'Stock redistribution facility'],
	['int_system_domain_depot', 'Depot'],
	['int_doodad_core_recycle', 'Recycling station'],
	['int_system_kite_station', 'Environment monitoring terminal'],
]);

/** the component that lists a template's upgrade models */
const MODEL_UPGRADE_COMPONENTS = ['_InteractiveModelLevelUpComponentDataForMemoryPack'];

/** the MemoryPack wrapper of interactive templates */
const TEMPLATE_ROOT = 'Beyond_Gameplay_InteractiveTemplateDataForMemoryPack';

/**
 * @param template a decoded interactive template
 * @param path its file, for errors
 * @returns its base model (the model component's) and its model-upgrade list, one ModelTable id per visual
 *   form
 * @throws {FormatError} if either component is missing or the base model isn't one of the forms
 */
const facilityModels = (
	template: MemoryPackValue,
	path: string,
): { id: string; scale: number; levels: string[] } => {
	const components =
		template !== null && typeof template === 'object' && !Array.isArray(template)
			? template.componentList
			: null;
	const find = (suffix: string) =>
		(Array.isArray(components) ? components : []).find(
			(component): component is { [key: string]: MemoryPackValue } =>
				component !== null &&
				typeof component === 'object' &&
				!Array.isArray(component) &&
				typeof component.$type === 'string' &&
				component.$type.endsWith(suffix),
		);
	const model = find('_InteractiveModelComponentDataForMemoryPack');
	const upgrade = find('_InteractiveModelLevelUpComponentDataForMemoryPack');
	const levels = upgrade?.modelLevelList;
	if (
		typeof model?.modelId !== 'string' ||
		typeof model.modelScale !== 'number' ||
		!Array.isArray(levels) ||
		!levels.every((level) => typeof level === 'string') ||
		!levels.includes(model.modelId)
	) {
		throw new FormatError(`${path} lacks a model and a model-upgrade list holding it`);
	}
	return { id: model.modelId, scale: model.modelScale, levels };
};

/** components that make a template a door: common doors, and Dijiang's room doors */
const DOOR_COMPONENTS = [
	'_InteractiveDoorCommonComponentDataForMemoryPack',
	'_SpaceshipRoomDoorSystemDataForMemoryPack',
];

/** the component of Dijiang's construction-area walls */
const REGION_WALL_COMPONENTS = ['_SpaceshipRegionWallDataForMemoryPack'];

/** the component of campfires */
const CAMPFIRE_COMPONENTS = ['_InteractiveCampfireComponentDataForMemoryPack'];

/** a settled look of an interactive's model, and its settled states' names */
interface SettledLook {
	pose: PrefabPose;
	states: string[];
}

/**
 * an interactive model's looks at rest. `away` and `near` are indexed by the activation (campfires: 0 not
 * activated, 1 activated; every other interactive has only 0). `near` is `null` when nothing the player's
 * presence sets changes the look
 */
interface InteractiveLooks {
	away: SettledLook[];
	near: SettledLook[] | null;
}

/** a view-state key that follows the player, and how near the player must be for it to hold */
interface PlayerKey {
	key: string;
	radius: number;
}

/**
 * view-state keys the player's presence sets, by the template component that sets them: `Distance` within the
 * interest component's distance, and a campfire's `InZone` inside its trigger sphere
 */
const PLAYER_KEYS = [
	{
		key: 'Distance',
		component: '_MainCharacterInterestComponentDataForMemoryPack',
		property: 'main_character_interest_distance',
	},
	{ key: 'InZone', component: '_TriggerObserverComponentDataForMemoryPack', property: 'radius' },
];

/**
 * @param template a decoded interactive template
 * @param suffix the component's type name suffix
 * @param key the property's key
 * @returns the float property of the template's first such component, or `null` without one
 */
const componentFloat = (template: MemoryPackValue, suffix: string, key: string): number | null => {
	const components =
		template !== null && typeof template === 'object' && !Array.isArray(template)
			? template.componentList
			: null;
	for (const component of Array.isArray(components) ? components : []) {
		if (
			component === null ||
			typeof component !== 'object' ||
			Array.isArray(component) ||
			typeof component.$type !== 'string' ||
			!component.$type.endsWith(suffix)
		) {
			continue;
		}
		for (const property of Array.isArray(component.propertyList) ? component.propertyList : []) {
			if (
				property === null ||
				typeof property !== 'object' ||
				Array.isArray(property) ||
				property.key !== key
			) {
				continue;
			}
			const value = property.value;
			const [atom] =
				value !== null &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				Array.isArray(value.valueArray)
					? value.valueArray
					: [];
			const bits =
				atom !== null && typeof atom === 'object' && !Array.isArray(atom) ? atom.valueBit64 : undefined;
			if (typeof bits !== 'string' && typeof bits !== 'number') {
				return null;
			}
			// float properties keep their IEEE bits in the 64-bit atom
			const view = new DataView(new ArrayBuffer(4));
			view.setUint32(0, Number(BigInt.asUintN(32, BigInt(bits))));
			return view.getFloat32(0);
		}
	}
	return null;
};

/**
 * @param template a decoded interactive template
 * @returns the player-set keys its components drive
 */
const playerKeys = (template: MemoryPackValue): PlayerKey[] =>
	PLAYER_KEYS.flatMap(({ key, component, property }) => {
		const radius = componentFloat(template, component, property);
		return radius === null || !(radius > 0) ? [] : [{ key, radius }];
	});

/**
 * @param context install readers and the bundle resolver
 * @param model a ModelTable model and the model whose view states it uses
 * @param campfire whether the model's `Enabled` key is the player's activation
 * @param keys the player-set keys the template drives; one whose radius is largest counts
 * @returns the model's settled looks, or `null` when it has no view states
 * @throws {FormatError} if a state machine can't settle or a clip can't be read
 */
const readInteractiveLooks = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver' | 'memoryPack'>,
	model: ModelViews,
	campfire: boolean,
	keys: readonly PlayerKey[],
): Promise<InteractiveLooks | null> => {
	const states = await readViewStates(context, model);
	if (states === null) {
		return null;
	}
	const activations = campfire ? [false, true] : [null];
	const settle = (activated: boolean | null, near: boolean) => {
		const blackboard = new Map<string, boolean>();
		if (activated !== null) {
			blackboard.set('Enabled', activated);
		}
		for (const { key } of keys) {
			blackboard.set(key, near);
		}
		const key = `${activated === null ? '' : activated ? 'activated ' : 'locked '}${near ? 'near' : 'away'}`;
		return settledPose(context, states, key, blackboard);
	};
	const away: SettledLook[] = [];
	const near: SettledLook[] = [];
	for (const activated of activations) {
		// oxlint-disable-next-line no-await-in-loop -- a few one-frame clips per model
		away.push(await settle(activated, false));
		if (keys.length > 0) {
			// oxlint-disable-next-line no-await-in-loop -- as above
			near.push(await settle(activated, true));
		}
	}
	const changes = near.some((look, i) => look.states.join() !== away[i].states.join());
	return { away, near: changes ? near : null };
};

/**
 * @param template a decoded interactive template
 * @param suffixes component type name suffixes
 * @returns whether it has a component of one of those types
 */
const hasComponent = (template: MemoryPackValue, suffixes: readonly string[]): boolean => {
	const components =
		template !== null && typeof template === 'object' && !Array.isArray(template)
			? template.componentList
			: null;
	return (Array.isArray(components) ? components : []).some(
		(component) =>
			component !== null &&
			typeof component === 'object' &&
			!Array.isArray(component) &&
			typeof component.$type === 'string' &&
			suffixes.some((suffix) => typeof component.$type === 'string' && component.$type.endsWith(suffix)),
	);
};

/** the interactive logic type of telescopic bridges */
const TELESCOPIC_LOGIC = 8;

/** the template and placement property holding a telescopic bridge's piece count */
const PIECES_KEY = 'pieces';

/**
 * @param template a decoded interactive template
 * @param path its file, for errors
 * @returns its piece count when its logic is a telescopic bridge, otherwise `null`
 * @throws {FormatError} if a telescopic bridge lacks a valid piece count
 */
const telescopicPieces = (template: MemoryPackValue, path: string): number | null => {
	if (template === null || typeof template !== 'object' || Array.isArray(template)) {
		return null;
	}
	const components = Array.isArray(template.componentList) ? template.componentList : [];
	const telescopic = components.some(
		(component) =>
			component !== null &&
			typeof component === 'object' &&
			!Array.isArray(component) &&
			typeof component.$type === 'string' &&
			component.$type.endsWith('_InteractiveLogicControllerComponentDataForMemoryPack') &&
			component.logicType === TELESCOPIC_LOGIC,
	);
	if (!telescopic) {
		return null;
	}
	const properties = Array.isArray(template.configProperties) ? template.configProperties : [];
	for (const property of properties) {
		if (property === null || typeof property !== 'object' || Array.isArray(property)) {
			continue;
		}
		const value = property.value;
		if (property.key !== PIECES_KEY || value === null || typeof value !== 'object' || Array.isArray(value)) {
			continue;
		}
		const [atom] = Array.isArray(value.valueArray) ? value.valueArray : [];
		const bits =
			atom !== null && typeof atom === 'object' && !Array.isArray(atom) ? atom.valueBit64 : undefined;
		const pieces = typeof bits === 'string' || typeof bits === 'number' ? Number(bits) : Number.NaN;
		if (Number.isInteger(pieces) && pieces > 0 && pieces <= 64) {
			return pieces;
		}
	}
	throw new FormatError(`${path} is a telescopic bridge without a valid ${PIECES_KEY} count`);
};

/**
 * @param row a placed interactive
 * @returns its piece count override on any component, or null
 */
const piecesOf = (row: LevelInteractive): number | null => {
	for (const params of row.componentProperties.values()) {
		const bits = params.find((param) => param.key === PIECES_KEY)?.values[0]?.bits;
		if (bits !== undefined) {
			return Number(bits);
		}
	}
	return null;
};

const TABLE = 'Data/Json/Interactive/InteractiveTable.json';

/** construction area → the Control Nexus level that unlocks it */
const AREA_UNLOCK_TABLE = 'Data/TableCfg/SpaceshipAreaUnlockNeedCenterLvTable.bytes';

/** the placement parameter naming a region wall's construction area */
const AREA_KEY = 'system_inst_key';

/**
 * @param row a placed interactive
 * @returns the string of its {@link AREA_KEY} parameter on any component, or null
 */
const areaOf = (row: LevelInteractive): string | null => {
	for (const params of row.componentProperties.values()) {
		const text = params.find((param) => param.key === AREA_KEY)?.values[0]?.text;
		if (text) {
			return text;
		}
	}
	return null;
};

/** a placed door and its open/closed control */
export interface InteractiveDoor {
	control: SceneControl;
	position: [number, number, number];
}

/** a placed interactive with a model the reader couldn't find, to draw a stand-in for */
export interface InteractiveStandIn {
	/** `<LevelData path>#<row id>` */
	source: string;
	template: string;
	reason: string;
	levelTag: number;
	position: [number, number, number];
	/** Unity Euler angles, degrees */
	rotation: [number, number, number];
	scale: [number, number, number];
	/** when it shows: always, or with its level's `created` control for a row the game creates later */
	visibility: ConditionalSetInfo;
}

/**
 * resolves the models of interactives placed by referenced LevelData: the visual forms of the facility
 * templates in {@link TEMPLATES}, each under a `facility:<id>` control, and every other interactive's model
 * (its template variant's, else the template's; none for a variant that overrides it with an empty model),
 * always shown. a model that is a doodad-group shell also places its form models, one per group level, under
 * a per-level `doodadGroups:<level id>` control. a model with door poses is placed closed and open, under a
 * `door:<id>` control, closed by default. a telescopic bridge is placed retracted and extended, under a
 * `bridge:<id>` control, retracted by default. rows the game creates later (`createState` ≠ 0) are placed the
 * same way and also require their level's `created:<level id>` control, off by default
 *
 * @param context install readers and the bundle resolver
 * @param scene owning map
 * @param level restricts decoding to one level, or null for the map
 * @param partition numeric level tags
 * @returns placements, controls, explicit unsupported-file diagnostics and the placements of interactives
 *   whose model wasn't found (a template that's missing or can't be read, or a model id the model table
 *   lacks); no partial file is used
 * @throws {FormatError} for broken authored references or malformed supported records
 */
export const loadInteractiveFacilities = async (
	context: Pick<Context, 'vfs' | 'world' | 'resolver' | 'memoryPack'>,
	scene: string,
	level: string | null,
	partition: LevelPartition | undefined,
	scripted: ReadonlySet<string>,
	erosionCores: ReadonlyMap<string, Alternatives>,
): Promise<{
	models: StructureModel[];
	progressions: SceneControl[];
	/** by logic id, the controls of the rows level scripts show and hide, shown as placed */
	scriptControls: Map<string, ScriptControl>;
	/** per level with rows the game creates later (`createState` ≠ 0), the control that shows them, off */
	created: SceneControl[];
	/** controls of interactives whose look follows the player's presence, and where each counts as near */
	proximityControls: SceneControl[];
	proximities: ProximityInfo[];
	doors: InteractiveDoor[];
	bridges: SceneControl[];
	unsupported: { path: string; reason: string }[];
	standIns: InteractiveStandIn[];
}> => {
	const { vfs, world } = context;
	const reader = await context.memoryPack();
	const find = (name: string) => vfs.find(VfsGroup.JsonData, name);
	const read = async (name: string): Promise<Uint8Array> => {
		const file = await find(name);
		if (!file) {
			throw new FormatError(`missing interactive data ${name}`);
		}
		return vfs.readVerified(file);
	};
	const pool = await world.stringPool();
	const string = (id: number): string | null => pool.get(id);
	const table: unknown = JSON.parse(
		new TextDecoder().decode(await read('Data/Json/GameplayConfig/ModelTable.json')),
	);
	if (!isObject(table)) {
		throw new FormatError('invalid model table');
	}
	const modelData = objectField(table, 'data');
	const viewsOf = (model: string): ModelViews => {
		const source = objectField(modelData, model).dependModelViewDataId;
		return { model, source: typeof source === 'string' && source !== '' ? source : model };
	};
	const formOf = (modelId: string, scale: number): { model: string; prefab: string; scale: number } => {
		const data = objectField(modelData, modelId);
		return {
			model: modelId,
			prefab: stringField(data, 'path').toLowerCase(),
			scale: scale * numberField(data, 'scaleFactor'),
		};
	};
	const interactives = readInteractiveTable(await read(TABLE), string);
	const unsupported: { path: string; reason: string }[] = [];

	// placements first, so only the templates they use are read
	const pathOf = await world.pathLookup();
	const placed: {
		path: string;
		levelId: string;
		levelTag: number;
		row: LevelInteractive;
		/** the `created:<level id>` control of a row the game creates later, `null` for one created with the level */
		created: string | null;
	}[] = [];
	/** by level id, the control of its rows created later */
	const createdControls = new Map<string, SceneControl>();
	{
		const seen = new Set<bigint>();
		const later: typeof placed = [];
		for (const config of (await world.levelConfigs()).values()) {
			if (config.mapId !== scene || (level !== null && config.id !== level)) {
				continue;
			}
			const levelTag = partition?.levels.find((entry) => entry.id === config.id)?.tag ?? 0;
			for (const hash of config.levelDataPathHashes ?? []) {
				const path = pathOf(hash);
				if (!path) {
					throw new FormatError(`missing LevelData path ${hash}`);
				}
				let prefix;
				try {
					// oxlint-disable-next-line no-await-in-loop -- level files are released after their prefix is decoded
					prefix = readLevelDataPrefix(await read(path), string);
				} catch (error) {
					if (!(error instanceof UnsupportedLevelData)) {
						throw error;
					}
					unsupported.push({ path, reason: error.message });
					continue;
				}
				if (prefix.hideByTypeAreas > 0) {
					unsupported.push({
						path,
						reason: `${prefix.hideByTypeAreas} function areas that hide entities by type aren't applied`,
					});
				}
				for (const row of prefix.interactives) {
					if (row.createState !== 0) {
						later.push({ path, levelId: config.id, levelTag, row, created: `created:${config.id}` });
						continue;
					}
					if (seen.has(row.id)) {
						continue;
					}
					seen.add(row.id);
					placed.push({ path, levelId: config.id, levelTag, row, created: null });
				}
			}
		}
		// a row created with its level wins over the same id created later in another layer
		for (const entry of later) {
			if (seen.has(entry.row.id)) {
				continue;
			}
			seen.add(entry.row.id);
			placed.push(entry);
			createdControls.getOrInsertComputed(entry.levelId, () => ({
				kind: 'created',
				id: `created:${entry.levelId}`,
				name: `Created later (${entry.levelId})`,
				rule: null,
				assumption: 'hidden: the server or a level script creates these interactives during play',
				followsCamera: false,
				levelTags: [],
				values: [
					{ value: 0, label: 'not created' },
					{ value: 1, label: 'created' },
				],
				default: 0,
				derived: null,
			}));
		}
	}

	const authored = new Map<
		string,
		{
			name: string | null;
			forms: { model: string; prefab: string; scale: number }[];
			/** the ModelTable id of a single-model interactive, `null` for facilities */
			model: string | null;
			/** the template's data file */
			data: string;
		}
	>();
	/** by placed template id, why its model wasn't found */
	const modelless = new Map<string, string>();
	const templates = new Map<
		string,
		{
			base: { id: string; scale: number } | null;
			variants: Map<string, string | null>;
			/** why the template couldn't be read, `null` when it was */
			failure: string | null;
		}
	>();
	const variantsOf = new Map<string, Set<string>>();
	for (const [id, template] of interactives.templates) {
		if (id !== template) {
			variantsOf.getOrInsertComputed(template, () => new Set()).add(id);
		}
	}
	/** by template data file, its upgrade models, or `null` without the model-upgrade component */
	const upgrades = new Map<string, ReturnType<typeof facilityModels> | null>();
	for (const key of new Set(placed.map(({ row }) => row.template))) {
		const template = interactives.templates.get(key);
		const data = template === undefined ? undefined : interactives.templatePaths.get(template);
		if (template === undefined || data === undefined) {
			unsupported.push({ path: TABLE, reason: `no template for ${key}` });
			modelless.set(key, 'no template');
			continue;
		}
		let upgrade = upgrades.get(data);
		if (upgrade === undefined) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
				const decoded = reader.decode(await read(data), TEMPLATE_ROOT);
				upgrade = hasComponent(decoded, MODEL_UPGRADE_COMPONENTS) ? facilityModels(decoded, data) : null;
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				// drawn with its base model only, as read below
				unsupported.push({ path: data, reason: `model upgrades: ${error.message}` });
				upgrade = null;
			}
			upgrades.set(data, upgrade);
		}
		if (upgrade !== null) {
			authored.set(key, {
				name: FACILITY_NAMES.get(key) ?? key,
				forms: upgrade.levels.map((modelId) => formOf(modelId, upgrade.scale)),
				model: null,
				data,
			});
			continue;
		}
		let resolved = templates.get(template);
		if (resolved === undefined) {
			try {
				// oxlint-disable-next-line no-await-in-loop -- small templates, read once per map
				const bytes = await read(data);
				resolved = {
					base: readInteractiveBaseModel(bytes, string),
					variants: readInteractiveVariantModels(bytes, string, variantsOf.get(template) ?? new Set()),
					failure: null,
				};
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupported.push({ path: data, reason: error.message });
				resolved = { base: null, variants: new Map(), failure: error.message };
			}
			templates.set(template, resolved);
		}
		if (resolved.failure !== null) {
			// the template may have had a model, so it gets a stand-in rather than being taken for a trigger
			modelless.set(key, resolved.failure);
			continue;
		}
		const { base } = resolved;
		const modelId = resolved.variants.has(key) ? resolved.variants.get(key) : base?.id;
		if (modelId === undefined || modelId === null) {
			// triggers and logic-only interactives have no model, and variants that empty it (bridges whose
			// DynamicStreaming row is the model they drive) draw nothing of their own
			continue;
		}
		if (!(modelId in modelData)) {
			unsupported.push({ path: data, reason: `model ${modelId} of ${key} is not in the model table` });
			modelless.set(key, `model ${modelId} is not in the model table`);
			continue;
		}
		authored.set(key, {
			name: null,
			forms: [formOf(modelId, base?.scale ?? 1)],
			model: modelId,
			data,
		});
	}

	const hashes = new Map<string, bigint>();
	const manifest = await world.manifest();
	// the manifest maps hashes to paths only, and each path decompresses on read: stop once all are found
	const findHashes = (paths: Iterable<string>): void => {
		const missing = new Set([...paths].filter((path) => !hashes.has(path)));
		for (const asset of manifest.assets()) {
			if (missing.size === 0) {
				break;
			}
			const path = manifest.assetPath(asset);
			if (missing.delete(path)) {
				hashes.set(path, asset.pathHash);
			}
		}
	};
	findHashes(authored.values().flatMap((template) => template.forms.map((form) => form.prefab)));
	const hashOf = (prefab: string): bigint => {
		const hash = hashes.get(prefab);
		if (hash === undefined) {
			throw new FormatError(`missing interactive prefab ${prefab}`);
		}
		return hash;
	};

	// doodad-group centres draw an empty shell; their visible model is one form per group level
	const doodads = new Map<string, { groupLevel: number; form: { prefab: string; scale: number } }[]>();
	{
		const resolver = await context.resolver();
		const shells = new Map<string, DoodadShell | null>();
		for (const [key, template] of authored) {
			if (template.name !== null) {
				continue;
			}
			const [{ prefab, scale }] = template.forms;
			let shell = shells.get(prefab);
			if (shell === undefined) {
				try {
					// oxlint-disable-next-line no-await-in-loop -- one root per distinct prefab
					const root = await resolver.findUnique(
						{ hash: hashOf(prefab), path: prefab },
						UnityClass.GameObject,
					);
					// oxlint-disable-next-line no-await-in-loop -- as above
					shell = await readDoodadShell(resolver, root);
				} catch (error) {
					if (!(error instanceof FormatError)) {
						throw error;
					}
					unsupported.push({ path: prefab, reason: error.message });
					shell = null;
				}
				shells.set(prefab, shell);
			}
			if (shell === null) {
				continue;
			}
			const levels = [];
			for (const [groupLevel, modelId] of shell.forms.entries()) {
				if (modelId === null) {
					continue;
				}
				if (!(modelId in modelData)) {
					unsupported.push({ path: prefab, reason: `doodad form ${modelId} is not in the model table` });
					continue;
				}
				levels.push({ groupLevel, form: formOf(modelId, scale) });
			}
			doodads.set(key, levels);
		}
		findHashes(doodads.values().flatMap((levels) => levels.map(({ form }) => form.prefab)));
	}

	// doors drawn open or closed: interactives of door templates whose model has door poses, by key. region
	// walls, by key, are drawn while their construction area is locked
	const doorPoses = new Map<string, DoorPoses>();
	const destructible = new Set<string>();
	// other interactives with view states drawn as they rest, by key: campfires locked or activated, and those
	// the player's presence changes away or near, within `radius`
	const interactiveLooks = new Map<
		string,
		{ looks: InteractiveLooks; campfire: boolean; radius: number | null }
	>();
	// facility forms with view states drawn as they rest (an idle loop keeps playing), by ModelTable id
	const formPoses = new Map<string, PrefabPose>();
	const regionWalls = new Set<string>();
	/** telescopic bridges' piece counts and prefab roots, by key */
	const telescopic = new Map<string, { pieces: number; prefab: string }>();
	{
		const templateKinds = new Map<
			string,
			| { kind: 'door' | 'regionWall' | 'destruction' }
			| { kind: 'telescopic'; pieces: number }
			| { kind: 'other'; campfire: boolean; keys: PlayerKey[] }
		>();
		const byModel = new Map<string, DoorPoses | null>();
		const looksByModel = new Map<string, InteractiveLooks | null>();
		// a failed read reports and leaves the model drawn as saved
		const attempt = async <T>(path: string, run: () => Promise<T>, failed: T): Promise<T> => {
			try {
				return await run();
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupported.push({ path, reason: error.message });
				return failed;
			}
		};
		for (const [key, { model, data, forms }] of authored) {
			if (model === null) {
				// a facility: each visual form is its own model, settled with every key false
				for (const form of forms) {
					if (formPoses.has(form.model)) {
						continue;
					}
					// oxlint-disable-next-line no-await-in-loop -- one view state file and a clip per form
					const looks = await attempt(
						form.model,
						() => readInteractiveLooks(context, viewsOf(form.model), false, []),
						null,
					);
					if (looks !== null) {
						formPoses.set(form.model, looks.away[0].pose);
					}
				}
				continue;
			}
			let kind = templateKinds.get(data);
			if (kind === undefined) {
				// oxlint-disable-next-line no-await-in-loop -- one decode per template
				kind = await attempt(
					data,
					async () => {
						const decoded = reader.decode(await read(data), TEMPLATE_ROOT);
						if (hasComponent(decoded, ['_InteractiveDestructibleComponentDataForMemoryPack'])) {
							return { kind: 'destruction' as const };
						}
						if (hasComponent(decoded, DOOR_COMPONENTS)) {
							return { kind: 'door' as const };
						}
						if (hasComponent(decoded, REGION_WALL_COMPONENTS)) {
							return { kind: 'regionWall' as const };
						}
						const pieces = telescopicPieces(decoded, data);
						if (pieces !== null) {
							return { kind: 'telescopic' as const, pieces };
						}
						return {
							kind: 'other' as const,
							campfire: hasComponent(decoded, CAMPFIRE_COMPONENTS),
							keys: playerKeys(decoded),
						};
					},
					// an unreadable template is drawn as saved
					{ kind: 'other' as const, campfire: false, keys: [] },
				);
				templateKinds.set(data, kind);
			}
			if (kind.kind === 'destruction') {
				destructible.add(key);
			}
			if (kind.kind === 'regionWall') {
				regionWalls.add(key);
			}
			if (kind.kind === 'telescopic') {
				telescopic.set(key, { pieces: kind.pieces, prefab: forms[0].prefab });
			}
			// a doodad-group shell draws nothing itself; its forms attach to it instead
			if ((kind.kind === 'other' || kind.kind === 'destruction') && !doodads.has(key)) {
				const campfire = kind.kind === 'other' && kind.campfire;
				const keys = kind.kind === 'other' ? kind.keys : [];
				const lookKey = `${model} ${campfire} ${keys.map((entry) => entry.key).join()}`;
				let looks = looksByModel.get(lookKey);
				if (looks === undefined) {
					// oxlint-disable-next-line no-await-in-loop -- one view state file and a few clips per model
					looks = await attempt(
						model,
						() => readInteractiveLooks(context, viewsOf(model), campfire, keys),
						null,
					);
					looksByModel.set(lookKey, looks);
				}
				if (looks !== null) {
					const radius = looks.near === null ? null : Math.max(...keys.map((entry) => entry.radius));
					interactiveLooks.set(key, { looks, campfire, radius });
				}
				continue;
			}
			if (kind.kind !== 'door') {
				continue;
			}
			let poses = byModel.get(model);
			if (poses === undefined) {
				// oxlint-disable-next-line no-await-in-loop -- a few view state files and one-frame clips per map
				poses = await attempt(model, () => readDoorPoses(context, viewsOf(model)), null);
				byModel.set(model, poses);
			}
			if (poses !== null) {
				doorPoses.set(key, poses);
			}
		}
	}

	// Dijiang's region walls hide once the Control Nexus level unlocks their construction area. one control,
	// offered at the levels that unlock an area; levels between them change no wall
	let nexus: { control: SceneControl; unlockOf: Map<string, number> } | null = null;
	{
		const walls = placed.filter(({ row }) => regionWalls.has(row.template));
		const file = walls.length > 0 ? await vfs.find(VfsGroup.Table, AREA_UNLOCK_TABLE) : undefined;
		if (walls.length > 0 && file === undefined) {
			unsupported.push({ path: AREA_UNLOCK_TABLE, reason: 'missing; region walls stay shown' });
		}
		if (file !== undefined) {
			const unlockOf = new Map<string, number>();
			for (const [area, unlock] of parseSparkTable(await vfs.readVerified(file)).entries) {
				if (typeof area !== 'string' || typeof unlock !== 'number' || unlock < 1 || unlock > 31) {
					throw new FormatError(`${AREA_UNLOCK_TABLE} has an invalid entry for ${String(area)}`);
				}
				unlockOf.set(area, unlock);
			}
			// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
			const levels = [...new Set([1, ...unlockOf.values()])].sort((a, b) => a - b);
			nexus = {
				control: {
					kind: 'controlNexus',
					id: `controlNexus:${walls[0].levelId}`,
					name: 'Control Nexus level',
					rule: null,
					assumption: 'level 1, before the player upgrades it',
					followsCamera: false,
					levelTags: [],
					values: levels.map((value) => ({ value, label: `Level ${value}` })),
					default: 1,
					derived: null,
				},
				unlockOf,
			};
		}
	}

	const models: StructureModel[] = [];
	const progressions: SceneControl[] = nexus === null ? [] : [nexus.control];
	const proximityControls: SceneControl[] = [];
	const proximities: ProximityInfo[] = [];
	const doors: InteractiveDoor[] = [];
	const bridges: SceneControl[] = [];
	const doodadLevels = new Map<string, Set<number>>();
	const standIns: InteractiveStandIn[] = [];
	/** by prefab and piece count; `null` when the prefab isn't a readable telescopic bridge (drawn as saved) */
	const bridgeLooks = new Map<string, Promise<TelescopicPoses | null>>();
	const telescopicLooks = (prefab: string, pieces: number): Promise<TelescopicPoses | null> =>
		bridgeLooks.getOrInsertComputed(`${prefab}:${pieces}`, async () => {
			try {
				const resolver = await context.resolver();
				const root = await resolver.findUnique({ hash: hashOf(prefab), path: prefab }, UnityClass.GameObject);
				const looks = await readTelescopicPoses(resolver, root, prefab, pieces);
				if (looks === null) {
					unsupported.push({ path: prefab, reason: 'telescopic bridge prefab has no bridge MonoBehaviour' });
				}
				return looks;
			} catch (error) {
				if (!(error instanceof FormatError)) {
					throw error;
				}
				unsupported.push({ path: prefab, reason: error.message });
				return null;
			}
		});
	const rewards = new Map<string, string>();
	const ambiguousRewards = new Set<string>();
	for (const { row } of placed) {
		if (!destructible.has(row.template)) {
			continue;
		}
		const control = `destruction:${row.id}`;
		progressions.push({
			kind: 'destruction',
			id: control,
			name: `${row.template} (${Math.round(row.position[0])}, ${Math.round(row.position[2])})`,
			rule: null,
			assumption: 'intact until destroyed; debris and damage are not simulated',
			followsCamera: false,
			levelTags: [],
			values: [
				{ value: 0, label: 'intact' },
				{ value: 1, label: 'destroyed' },
			],
			default: 0,
			derived: null,
		});
		for (const parameter of [...row.componentProperties.values()].flat()) {
			if (parameter.key !== 'reward_entities') {
				continue;
			}
			for (const atom of parameter.values) {
				if (atom.bits <= 0n) {
					continue;
				}
				const reward = atom.bits.toString();
				if (rewards.has(reward) && rewards.get(reward) !== control) {
					ambiguousRewards.add(reward);
				}
				rewards.set(reward, control);
			}
		}
	}
	for (const reward of ambiguousRewards) {
		rewards.delete(reward);
	}
	const scriptControls = new Map<string, ScriptControl>();
	for (const { path, levelId, levelTag, row, created } of placed) {
		// a row created later also needs its level's `created` control on, and one a level script shows and hides
		// its script control
		const logicId = row.id.toString();
		const switches: string[] = [];
		if (created !== null && !rewards.has(logicId)) {
			switches.push(created);
		}
		if (scripted.has(logicId)) {
			const control = `script:${logicId}`;
			switches.push(control);
			scriptControls.getOrInsertComputed(logicId, (): ScriptControl => ({
				kind: 'script',
				id: control,
				name: `${row.template} (${Math.round(row.position[0])}, ${Math.round(row.position[2])})`,
				rule: null,
				assumption: 'shown as placed until a level script hides it',
				followsCamera: false,
				drivers: [],
				levelTags: [],
				values: SWITCH_VALUES,
				default: 1,
				derived: null,
			}));
		}
		const destruction = destructible.has(row.template) ? `destruction:${row.id}` : null;
		const reward = rewards.get(logicId);
		// a blight core shows while its erosion root loads, so both go when the core is destroyed
		const erosion = erosionCores.get(logicId);
		const gate = (visibility: ConditionalSetInfo): ConditionalSetInfo => {
			const alternatives =
				erosion === undefined ? visibility.alternatives : allOf(visibility.alternatives, erosion);
			return { alternatives: alternatives.map((requirements) => requirements.concat(gates)) };
		};
		const template = authored.get(row.template);
		if (template === undefined) {
			const reason = modelless.get(row.template);
			if (reason !== undefined) {
				standIns.push({
					source: `${path}#${row.id}`,
					template: row.template,
					reason,
					levelTag,
					position: row.position,
					rotation: row.rotation,
					scale: row.scale,
					visibility: gate({ alternatives: [[]] }),
				});
			}
			continue;
		}
		const place = (
			model: { prefab: string; scale: number },
			shown: ConditionalSetInfo,
			pose: PrefabPose | null,
		): void => {
			const visibility = gate(shown);
			// zero is the authored "no scale override" sentinel on LevelInteractiveData.
			const scale = row.modelScale > 0 ? row.modelScale : model.scale;
			models.push({
				model: {
					pathHash: hashOf(model.prefab),
					position: row.position,
					rotation: row.rotation,
					scale: [row.scale[0] * scale, row.scale[1] * scale, row.scale[2] * scale],
				},
				levelTag,
				source: `${path}#${row.id}`,
				visibility,
				pose,
			});
		};
		const bridge = telescopic.get(row.template);
		if (bridge !== undefined) {
			const pieces = piecesOf(row) ?? bridge.pieces;
			// oxlint-disable-next-line no-await-in-loop -- one read per prefab and piece count
			const looks = await telescopicLooks(bridge.prefab, pieces);
			if (looks !== null) {
				const control = `bridge:${row.id}`;
				bridges.push({
					kind: 'bridge',
					id: control,
					name: `${row.template} (${Math.round(row.position[0])}, ${Math.round(row.position[2])})`,
					rule: null,
					assumption: 'retracted: the player or the server extends it',
					followsCamera: false,
					levelTags: [],
					values: [
						{ value: 0, label: 'retracted' },
						{ value: 1, label: `extended (${pieces} pieces)` },
					],
					default: 0,
					derived: null,
				});
				place(template.forms[0], { alternatives: [[{ control, mask: 1 }]] }, looks.retracted);
				for (const pose of [looks.extended, ...looks.pieces]) {
					place(template.forms[0], { alternatives: [[{ control, mask: 2 }]] }, pose);
				}
				continue;
			}
		}
		const poses = doorPoses.get(row.template);
		if (poses !== undefined) {
			const control = `door:${row.id}`;
			doors.push({
				control: {
					kind: 'door',
					id: control,
					name: `${row.template} (${Math.round(row.position[0])}, ${Math.round(row.position[2])})`,
					rule: null,
					assumption: 'closed: the player or the server opens it',
					followsCamera: false,
					levelTags: [],
					values: [
						{ value: 0, label: `closed (${poses.closedState})` },
						{ value: 1, label: `open (${poses.openState})` },
					],
					default: 0,
					derived: null,
				},
				position: row.position,
			});
			place(template.forms[0], { alternatives: [[{ control, mask: 1 }]] }, poses.closed);
			place(template.forms[0], { alternatives: [[{ control, mask: 2 }]] }, poses.open);
			continue;
		}
		const rest = interactiveLooks.get(row.template);
		if (rest !== undefined) {
			const { looks, campfire, radius } = rest;
			const where = `(${Math.round(row.position[0])}, ${Math.round(row.position[2])})`;
			const activation = `activation:${row.id}`;
			if (campfire) {
				progressions.push({
					kind: 'activation',
					id: activation,
					name: `Campfire ${where}`,
					rule: null,
					assumption: 'activated, as in a finished save: the player activates it, and the server keeps it',
					followsCamera: false,
					levelTags: [],
					values: [
						{ value: 0, label: `not activated (${looks.away[0].states.join(', ')})` },
						{ value: 1, label: `activated (${looks.away[1].states.join(', ')})` },
					],
					default: 1,
					derived: null,
				});
			}
			const nearness = `proximity:${row.id}`;
			if (looks.near !== null && radius !== null) {
				const states = (side: SettledLook[]) => [...new Set(side.flatMap((look) => look.states))].join(', ');
				proximityControls.push({
					kind: 'proximity',
					id: nearness,
					name: `${campfire ? 'Campfire' : row.template} ${where}`,
					rule: null,
					assumption: 'follows the camera, as the game follows the player',
					followsCamera: true,
					levelTags: [],
					values: [
						{ value: 0, label: `away (${states(looks.away)})` },
						{ value: 1, label: `within ${radius} m (${states(looks.near)})` },
					],
					default: 0,
					derived: null,
				});
				proximities.push({ control: nearness, position: row.position, radius });
			}
			for (const [i, away] of looks.away.entries()) {
				const requirements = campfire ? [{ control: activation, mask: 1 << i }] : [];
				const near = looks.near?.[i];
				if (near === undefined || near.states.join() === away.states.join()) {
					place(template.forms[0], { alternatives: [requirements] }, away.pose);
					continue;
				}
				place(
					template.forms[0],
					{ alternatives: [[...requirements, { control: nearness, mask: 1 }]] },
					away.pose,
				);
				place(
					template.forms[0],
					{ alternatives: [[...requirements, { control: nearness, mask: 2 }]] },
					near.pose,
				);
			}
			continue;
		}
		if (nexus !== null && regionWalls.has(row.template)) {
			const unlock = nexus.unlockOf.get(areaOf(row) ?? '');
			if (unlock === undefined) {
				// no level unlocks the area in this client
				place(template.forms[0], { alternatives: [[]] }, null);
				continue;
			}
			let mask = 0;
			for (const { value } of nexus.control.values) {
				if (value < unlock) {
					mask |= 1 << value;
				}
			}
			if (mask !== 0) {
				place(template.forms[0], { alternatives: [[{ control: nexus.control.id, mask: mask >>> 0 }]] }, null);
			}
			continue;
		}
		if (template.name === null) {
			place(template.forms[0], { alternatives: [[]] }, null);
			const doodad = doodads.get(row.template);
			if (doodad === undefined || doodad.length === 0) {
				continue;
			}
			const id = `doodadGroups:${levelId}`;
			const levels = doodadLevels.getOrInsertComputed(id, () => new Set<number>());
			for (const { groupLevel, form } of doodad) {
				levels.add(groupLevel);
				place(form, { alternatives: [[{ control: id, mask: (1 << groupLevel) >>> 0 }]] }, null);
			}
			continue;
		}
		const id = `facility:${row.id}`;
		progressions.push(
			progressionControl(
				'facility',
				id,
				`${template.name} (${Math.round(row.position[0])}, ${Math.round(row.position[2])})`,
				template.forms.map((_, i) => i),
				template.forms.length - 1,
				'fully upgraded: its last visual form, as in a finished world',
			),
		);
		for (const [form, model] of template.forms.entries()) {
			place(
				model,
				{ alternatives: [[{ control: id, mask: (1 << form) >>> 0 }]] },
				formPoses.get(model.model) ?? null,
			);
		}
	}
	for (const [id, set] of doodadLevels) {
		// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
		const levels = [...set].sort((a, b) => a - b);
		// shell slot activity varies (one or all four), so default to the fully grown form
		progressions.push(
			progressionControl(
				'doodadGroups',
				id,
				'Resource nodes',
				levels,
				levels.at(-1)!,
				'the fully grown form',
			),
		);
	}
	return {
		models,
		progressions,
		scriptControls,
		created: [...createdControls.values()],
		proximityControls,
		proximities,
		doors,
		bridges,
		unsupported,
		standIns,
	};
};

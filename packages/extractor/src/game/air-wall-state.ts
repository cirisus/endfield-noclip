import { isObject } from '@endfield-noclip/formats/unity/values';

import type { Wall } from '@oem/ganglia';

import type { Script } from './script-drivers.ts';
import { literal, typeOf, reachableNodes } from './script-snapshot.ts';

const idOf = (value: unknown): string | undefined =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
		? String(value)
		: undefined;

const wallPointer = (value: unknown, brief: unknown): unknown => {
	if (!isObject(value) || value.paramSource !== 200) {
		return literal(value);
	}
	if (!isObject(brief) || !Array.isArray(brief.properties) || typeof value.path !== 'string') {
		return undefined;
	}
	const properties = brief.properties.filter((property) => isObject(property) && property.key === value.path);
	if (properties.length !== 1 || !isObject(properties[0]) || !isObject(properties[0].value)) {
		return undefined;
	}
	const parameter = properties[0].value,
		atoms = parameter.valueArray;
	if (
		parameter.type !== 44 ||
		!Array.isArray(atoms) ||
		atoms.length !== 2 ||
		!isObject(atoms[0]) ||
		!isObject(atoms[1])
	) {
		return undefined;
	}
	const id = idOf(atoms[0].valueBit64);
	// only the observed global-id form is decoded. slot forms retain their unresolved source.
	return id !== undefined && /^[1-9]\d*$/.test(id) && idOf(atoms[1].valueBit64) === '0'
		? { useSlotId: false, logicId: id }
		: undefined;
};

/**
 * Terminal stage of an explicit contiguous stage graph under the completed-world policy. Custom or incomplete
 * stage domains retain unresolved state.
 */
export const terminalScriptStage = (script: Script): number | null => {
	const values = new Set<number>();
	for (const header of script.headers) {
		if (typeOf(header).includes('OnScriptStageChanged') && header.filterMode === true) {
			const value = literal(header.newStageFilter);
			if (!Number.isInteger(value) || Number(value) < 0) {
				return null;
			}
			values.add(Number(value));
		}
	}
	for (const node of script.nodes.values()) {
		if (!typeOf(node).includes('SwitchInt') || !isObject(node.value)) {
			continue;
		}
		const getter = script.getters.get(Number(node.value.idRef));
		if (
			!getter ||
			!typeOf(getter).includes('GetLevelScriptStage') ||
			!isObject(getter.scriptPtr) ||
			getter.scriptPtr.paramSource !== 1002 ||
			!Array.isArray(node.caseValueList)
		) {
			continue;
		}
		for (const value of node.caseValueList) {
			if (!Number.isInteger(value) || Number(value) < 0) {
				return null;
			}
			values.add(Number(value));
		}
	}
	const stages = [...values].toSorted((a, b) => a - b);
	return stages.length >= 3 && stages.every((value, index) => value === index) ? stages.at(-1)! : null;
};

/**
 * @param script a decoded controlling script
 * @param wallTarget an owned slot or a globally addressed wall group
 * @param snapshot the selected stage and state before this script writes
 * @returns the state when all reachable writes agree and establish or preserve it, else unknown
 */
export const completedScriptWallState = (
	script: Script,
	wallTarget: { slotId: number } | { logicId: string },
	snapshot: { stage: number | null; initialState: Wall['state']; brief?: unknown },
): Wall['state'] => {
	const { stage, initialState } = snapshot;
	const effects = new Set<boolean>();
	let initialized = false;
	for (const header of script.headers) {
		const kind = typeOf(header);
		for (const { node, guaranteed } of reachableNodes(script, stage, header)) {
			const type = typeOf(node);
			if (type.includes('SetLevelScriptStage')) {
				return 'unknown';
			}
			if (type.includes('AirWallEnable')) {
				const target = wallPointer(node.airWallPtr, snapshot.brief);
				if (!isObject(target) || typeof target.useSlotId !== 'boolean') {
					return 'unknown';
				}
				const matches =
					'slotId' in wallTarget
						? target.useSlotId && target.slotId === wallTarget.slotId
						: !target.useSlotId && idOf(target.logicId) === wallTarget.logicId;
				if (matches) {
					const enabled = literal(node.enable);
					if (typeof enabled !== 'boolean') {
						return 'unknown';
					}
					effects.add(enabled);
					initialized ||=
						guaranteed &&
						(kind.includes('OnScriptActive') ||
							kind.includes('OnScriptStart') ||
							kind.includes('OnScriptPreActive') ||
							(stage !== null && kind.includes('OnScriptStageChanged')));
				}
			}
		}
	}
	if (effects.size === 0) {
		return initialState;
	}
	const state = effects.has(true) ? 'active' : 'inactive';
	return effects.size === 1 && (initialized || state === initialState) ? state : 'unknown';
};

const completedReasons = (reasons: unknown, any: unknown): boolean | undefined => {
	if (!Array.isArray(reasons) || typeof any !== 'boolean') {
		return undefined;
	}
	// AirWallMissionChecker.Init leaves an empty checker false without invoking
	// the any/all reduction. Empty rise/down lists mean no activation reason.
	if (reasons.length === 0) {
		return false;
	}
	const results = reasons.map((reason): boolean | undefined => {
		if (
			!isObject(reason) ||
			typeof reason.id !== 'string' ||
			reason.id.length === 0 ||
			typeof reason.isQuest !== 'boolean' ||
			!Number.isInteger(reason.detailState) ||
			typeof reason.isSame !== 'boolean'
		) {
			return undefined;
		}
		return (reason.detailState === 3) === reason.isSame;
	});
	if (results.some((result) => result === undefined)) {
		return undefined;
	}
	return any ? results.some(Boolean) : results.every(Boolean);
};

// state before client script writes in the selected completed-task snapshot.
const authoredWallState = (wall: unknown): Wall['state'] => {
	if (!isObject(wall) || typeof wall.defaultOn !== 'boolean') {
		return 'unknown';
	}
	if (wall.scriptId !== '0') {
		// ownership gates the group, but does not raise its initial switch. a
		// decoded owner still needs a writer or module to enable a default-off wall.
		return wall.defaultOn ? 'unknown' : 'inactive';
	}
	const condition = wall.condition;
	if (!isObject(condition)) {
		return 'unknown';
	}
	// level-script walls start at their authored switch before script writes.
	if (condition.checkType === 0) {
		return wall.defaultOn ? 'active' : 'inactive';
	}
	if (condition.checkType !== 1 || !isObject(condition.missionData)) {
		return 'unknown';
	}
	const mission = condition.missionData;
	const rise = completedReasons(mission.riseReason, mission.isRiseAny);
	const down = completedReasons(mission.downReason, mission.isDownAny);
	if (rise === undefined || down === undefined) {
		return 'unknown';
	}
	// the client checks the rise result before the down result, then the default switch.
	if (rise) {
		return 'active';
	}
	if (down) {
		return 'inactive';
	}
	return wall.defaultOn ? 'active' : 'inactive';
};

/**
 * @param input the scene's decoded scripts, including other-level references, and decode failures
 * @returns a completed-snapshot resolver that accounts for owned slots and group-id writes by other scripts
 * @throws when called with a wall without level, owner or group identity
 */
export const createWallResolver = (input: {
	scripts: readonly Script[];
	ownLevels: ReadonlySet<string>;
	undecoded: number;
	briefs?: ReadonlyMap<string, unknown>;
}) => {
	const owners = new Map(input.scripts.map((script) => [`${script.level}/${script.id}`, script]));
	const byGroup = new Map<string, Set<Script>>();
	const stages = new Map(
		input.scripts.map((script) => {
			const brief = input.briefs?.get(`${script.level}/${script.id}`);
			const declared = isObject(brief) ? brief.maxStage : undefined;
			return [
				script,
				typeof declared === 'number' && Number.isInteger(declared) && declared > 0
					? declared
					: terminalScriptStage(script),
			] as const;
		}),
	);
	const unresolvedTargets = new Set<string>();
	const modules = new Map<string, { script: Script; module: string; kind: string; state: Wall['state'] }[]>();
	for (const script of input.scripts) {
		for (const entry of Array.isArray(script.data.modules) ? script.data.modules : []) {
			if (!Array.isArray(entry) || !isObject(entry[1])) {
				continue;
			}
			const module = entry[1],
				kind = typeOf(module);
			const cleanup = [
				'EncounterData',
				'EncounterDataV2',
				'EncounterDataV3',
				'FogNestControllerData',
			].includes(kind);
			for (const field of ['airWallPtrList', 'airWallIdList', 'airWallList']) {
				const pointers = module[field];
				if (!Array.isArray(pointers)) {
					continue;
				}
				for (const pointer of pointers) {
					if (!isObject(pointer)) {
						continue;
					}
					const key =
						pointer.useSlotId === true && typeof pointer.slotId === 'number'
							? `${script.level}/${script.id}/${pointer.slotId}`
							: idOf(pointer.logicId);
					if (key === undefined || key === '0') {
						continue;
					}
					const controls = modules.get(key) ?? [];
					controls.push({
						script,
						module: idOf(entry[0]) ?? '',
						kind,
						state:
							cleanup && module.disableWhenCompleted === true && input.ownLevels.has(script.level)
								? 'inactive'
								: 'unknown',
					});
					modules.set(key, controls);
				}
			}
		}
		for (const node of script.nodes.values()) {
			if (!typeOf(node).includes('AirWallEnable')) {
				continue;
			}
			const target = wallPointer(node.airWallPtr, input.briefs?.get(`${script.level}/${script.id}`));
			if (!isObject(target)) {
				unresolvedTargets.add(`${script.level}/${script.id}`);
				continue;
			}
			const id = idOf(target.logicId);
			if (target.useSlotId === false && id !== undefined && id !== '0') {
				const writers = byGroup.get(id) ?? new Set<Script>();
				writers.add(script);
				byGroup.set(id, writers);
			}
		}
	}
	return (wall: unknown) => {
		if (!isObject(wall) || typeof wall.level !== 'string') {
			throw new Error('invalid wall control target');
		}
		const scriptId = idOf(wall.scriptId);
		const groupId = idOf(wall.groupId);
		if (scriptId === undefined || groupId === undefined) {
			throw new Error('invalid wall control identity');
		}
		const base = authoredWallState({ ...wall, scriptId });
		const slotKey = typeof wall.slotId === 'number' ? `${wall.level}/${scriptId}/${wall.slotId}` : '';
		const moduleControls = [...(modules.get(slotKey) ?? []), ...(modules.get(groupId) ?? [])];
		let initial = base;
		if (moduleControls.length) {
			initial = moduleControls.every((control) => control.state === 'inactive') ? 'inactive' : 'unknown';
		}
		const controllers: {
			script: string;
			level: string;
			stage: number | null;
			state: Wall['state'];
			binding: string;
			module?: string;
			kind?: string;
		}[] = [];
		for (const control of moduleControls) {
			controllers.push({
				script: control.script.id,
				level: control.script.level,
				stage: stages.get(control.script) ?? null,
				binding: 'module',
				module: control.module,
				kind: control.kind,
				state: control.state,
			});
		}
		const resolve = (script: Script, target: { slotId: number } | { logicId: string }, binding: string) => {
			const stage = stages.get(script) ?? null;
			const effect = completedScriptWallState(script, target, {
				stage,
				initialState: initial,
				brief: input.briefs?.get(`${script.level}/${script.id}`),
			});
			controllers.push({
				script: script.id,
				level: script.level,
				stage,
				binding,
				// other-level activation needs a dungeon/level snapshot of its own.
				state: input.ownLevels.has(script.level) || effect === base ? effect : 'unknown',
			});
		};
		if (scriptId !== '0') {
			const owner = owners.get(`${wall.level}/${scriptId}`);
			if (owner && typeof wall.slotId === 'number') {
				resolve(owner, { slotId: wall.slotId }, 'slot');
			} else {
				controllers.push({
					script: scriptId,
					level: wall.level,
					stage: null,
					binding: 'slot',
					state: 'unknown',
				});
			}
		}
		for (const script of byGroup.get(groupId) ?? []) {
			resolve(script, { logicId: groupId }, 'group');
		}
		const states = new Set(controllers.map((controller) => controller.state));
		let state = base;
		if (controllers.length) {
			state = states.size === 1 ? controllers[0].state : 'unknown';
		}
		// a computed target can name any group until its reference is resolved.
		if (input.undecoded || unresolvedTargets.size) {
			state = 'unknown';
		}
		return {
			model: 'wall-controls-v2',
			state,
			controllers,
			undecoded: input.undecoded,
			unresolvedTargets: [...unresolvedTargets],
		};
	};
};

/**
 * @param wall an exported authored wall
 * @returns its selected completed-snapshot state, preserving unknown control effects
 */
export const completedWallState = (wall: unknown): Wall['state'] => {
	if (!isObject(wall)) {
		return 'unknown';
	}
	const completed = wall.completed;
	if (
		isObject(completed) &&
		completed.model === 'wall-controls-v2' &&
		(completed.state === 'active' || completed.state === 'inactive' || completed.state === 'unknown')
	) {
		return completed.state;
	}
	if (
		wall.scriptId !== '0' &&
		isObject(completed) &&
		completed.model === 'script-terminal-stage-v1' &&
		Number.isInteger(completed.stage) &&
		Number(completed.stage) >= 2 &&
		(completed.state === 'active' || completed.state === 'inactive')
	) {
		return completed.state;
	}
	// legacy level-script exports lack the group-id control scan needed to use a default switch.
	if (isObject(wall.condition) && wall.condition.checkType === 0) {
		return 'unknown';
	}
	if (wall.scriptId !== '0') {
		return 'unknown';
	}
	return authoredWallState(wall);
};

/**
 * @param wall an authored air wall and its recovered controller catalogue
 * @returns open for controllable passage barriers; uncontrolled boundary defaults remain in force
 */
export const enabledWallState = (wall: unknown): Wall['state'] => {
	if (!isObject(wall)) {
		return 'unknown';
	}
	const controls = isObject(wall.completed) ? wall.completed.controllers : undefined;
	if (
		(typeof wall.scriptId === 'string' && wall.scriptId !== '0') ||
		(isObject(wall.condition) && wall.condition.checkType === 1) ||
		(Array.isArray(controls) && controls.length > 0)
	) {
		return 'inactive';
	}
	return typeof wall.defaultOn === 'boolean' ? (wall.defaultOn ? 'active' : 'inactive') : 'unknown';
};

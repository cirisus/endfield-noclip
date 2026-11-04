import { isObject } from '@endfield-noclip/formats/unity/values';

import type { Wall } from '@oem/ganglia';

import type { Script } from './script-drivers.ts';

const literal = (value: unknown): unknown =>
	isObject(value) && value.paramSource === 0 ? value.constValue : undefined;
const typeOf = (node: Script['data']): string => (typeof node.$type === 'string' ? node.$type : '');

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
 * Resolve an owning script under an explicit terminal-stage snapshot. Every possible event path must agree,
 * with an activation/completion assignment. Computed wall targets, state mutations and conflicting writes
 * stay unresolved.
 */
export const completedScriptWallState = (script: Script, slot: number, stage: number): Wall['state'] => {
	const effects = new Set<boolean>();
	let initialized = false;
	for (const header of script.headers) {
		if (literal(header.validate) === false) {
			continue;
		}
		const kind = typeOf(header);
		if (
			kind.includes('OnScriptStageChanged') &&
			header.filterMode === true &&
			literal(header.newStageFilter) !== stage
		) {
			continue;
		}
		const pending = [Number(header.ID)],
			visited = new Set<number>();
		while (pending.length) {
			const id = pending.pop()!;
			if (visited.has(id)) {
				continue;
			}
			visited.add(id);
			const node = script.nodes.get(id);
			if (!node) {
				continue;
			}
			const type = typeOf(node);
			if (type.includes('SetLevelScriptStage')) {
				return 'unknown';
			}
			if (type.includes('AirWallEnable')) {
				const target = literal(node.airWallPtr);
				if (!isObject(target) || target.useSlotId !== true) {
					return 'unknown';
				}
				if (target.slotId === slot) {
					const enabled = literal(node.enable);
					if (typeof enabled !== 'boolean') {
						return 'unknown';
					}
					effects.add(enabled);
					initialized ||= kind.includes('OnScriptActive') || kind.includes('OnScriptStageChanged');
				}
			}
			if (type.includes('SwitchInt') && isObject(node.value)) {
				const getter = script.getters.get(Number(node.value.idRef));
				if (
					getter &&
					typeOf(getter).includes('GetLevelScriptStage') &&
					isObject(getter.scriptPtr) &&
					getter.scriptPtr.paramSource === 1002 &&
					Array.isArray(node.caseValueList) &&
					Array.isArray(node.caseIDList)
				) {
					const index = node.caseValueList.indexOf(stage);
					const next = index < 0 ? node.defaultID : node.caseIDList[index];
					if (Number.isInteger(next) && Number(next) >= 0) {
						pending.push(Number(next));
					}
					if (Number.isInteger(node.nextID) && Number(node.nextID) >= 0) {
						pending.push(Number(node.nextID));
					}
					continue;
				}
			}
			for (const [key, value] of Object.entries(node)) {
				if (key !== 'ID' && key.endsWith('ID') && Number.isInteger(value) && Number(value) >= 0) {
					pending.push(Number(value));
				}
				if ((key === 'idList' || key === 'caseIDList') && Array.isArray(value)) {
					pending.push(...value.filter((next) => Number.isInteger(next) && Number(next) >= 0).map(Number));
				}
			}
		}
	}
	return initialized && effects.size === 1 ? (effects.has(true) ? 'active' : 'inactive') : 'unknown';
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

/**
 * @param wall an exported authored air wall
 * @returns the selected completed-world mission state or exported owning-script terminal-stage state;
 *   unsupported, undecoded and conflicting gates retain unresolved activation
 */
export const completedWallState = (wall: unknown): Wall['state'] => {
	if (!isObject(wall) || typeof wall.defaultOn !== 'boolean') {
		return 'unknown';
	}
	if (wall.scriptId !== '0') {
		const completed = wall.completed;
		if (
			isObject(completed) &&
			completed.model === 'script-terminal-stage-v1' &&
			Number.isInteger(completed.stage) &&
			Number(completed.stage) >= 2 &&
			(completed.state === 'active' || completed.state === 'inactive')
		) {
			return completed.state;
		}
		return 'unknown';
	}
	const condition = wall.condition;
	if (!isObject(condition)) {
		return 'unknown';
	}
	// Unowned walls without a condition use their authored default switch in this
	// planning snapshot. Runtime overrides require a separately selected snapshot.
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

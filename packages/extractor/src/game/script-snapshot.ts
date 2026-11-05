import { isObject } from '@endfield-noclip/formats/unity/values';

import type { Script } from './script-drivers.ts';

/** @param value an authored parameter @returns its literal constant, or undefined */
export const literal = (value: unknown): unknown =>
	isObject(value) && value.paramSource === 0 ? value.constValue : undefined;
/** @param node a decoded node @returns its unqualified schema type */
export const typeOf = (node: unknown): string =>
	(isObject(node) && typeof node.$type === 'string' ? node.$type : '')
		.replace(/^Beyond_Gameplay_(Actions_)?/, '')
		.replace(/ForMemoryPack$/, '');
// only values established by the selected completed snapshot are evaluated.
// dynamic properties and event outputs retain unknown values, including on cycles.
const snapshotValue = (script: Script, value: unknown, stage: number | null, depth = 0): unknown => {
	if (!isObject(value) || depth > 16) {
		return undefined;
	}
	if (value.paramSource === 0) {
		return value.constValue;
	}
	const path = typeof value.path === 'string' ? /^\$(\d+)@/.exec(value.path) : null;
	const getter = script.getters.get(path ? Number(path[1]) : Number(value.idRef));
	if (!getter) {
		return undefined;
	}
	const read = (input: unknown) => snapshotValue(script, input, stage, depth + 1);
	const type = typeOf(getter);
	switch (type) {
		case 'GetterBool':
		case 'GetterInt': {
			return read(getter.value);
		}
		case 'GetLevelScriptStage': {
			return isObject(getter.scriptPtr) && getter.scriptPtr.paramSource === 1002
				? (stage ?? undefined)
				: undefined;
		}
		case 'GetMissionState':
		case 'GetQuestState': {
			return typeof read(getter.missionId ?? getter.questId) === 'string' &&
				read(getter.missionId ?? getter.questId) !== ''
				? 3
				: undefined;
		}
		case 'CheckMissionOrQuestIsComplete':
		case 'CheckMissionOrQuestIsProcessing': {
			return typeof read(getter.missionId) === 'string' &&
				read(getter.missionId) !== '' &&
				typeof read(getter.isQuest) === 'boolean'
				? type === 'CheckMissionOrQuestIsComplete'
				: undefined;
		}
		case 'BoolGetterInvert': {
			const inverted = read(getter.value);
			return typeof inverted === 'boolean' ? !inverted : undefined;
		}
		case 'BoolGetterAnd':
		case 'BoolGetterOr': {
			const a = read(getter.valueA),
				b = read(getter.valueB);
			if (type === 'BoolGetterAnd' && (a === false || b === false)) {
				return false;
			}
			if (type === 'BoolGetterOr' && (a === true || b === true)) {
				return true;
			}
			return typeof a === 'boolean' && typeof b === 'boolean' ? a : undefined;
		}
		case 'IntEqual':
		case 'IntCompare':
		case 'BooleanCompare':
		case 'CompareQuestState':
		case 'CompareMissionState':
		case 'CheckLevelScriptStage': {
			const ownStage =
				isObject(getter.scriptPtr) && getter.scriptPtr.paramSource === 1002
					? (stage ?? undefined)
					: undefined;
			const a = type === 'CheckLevelScriptStage' ? ownStage : read(getter.valueA),
				b = type === 'CheckLevelScriptStage' ? read(getter.value) : read(getter.valueB),
				comparer = type === 'IntEqual' ? 0 : read(getter.comparer);
			if (
				a === undefined ||
				b === undefined ||
				typeof a !== typeof b ||
				(typeof a !== 'boolean' && typeof a !== 'number')
			) {
				return undefined;
			}
			switch (comparer) {
				case 0: {
					return a === b;
				}
				case 1: {
					return a !== b;
				}
				case 2: {
					return typeof a === 'number' && typeof b === 'number' ? a > b : undefined;
				}
				case 3: {
					return typeof a === 'number' && typeof b === 'number' ? a >= b : undefined;
				}
				case 4: {
					return typeof a === 'number' && typeof b === 'number' ? a < b : undefined;
				}
				case 5: {
					return typeof a === 'number' && typeof b === 'number' ? a <= b : undefined;
				}
			}
		}
	}
	return undefined;
};

/**
 * @param script a decoded script
 * @param stage the selected completed stage, when resolved
 * @param header the event being evaluated
 * @returns reachable nodes and whether their path has fully resolved guards
 */
export function* reachableNodes(script: Script, stage: number | null, header: Script['data']) {
	if (snapshotValue(script, header.validate, stage) === false) {
		return;
	}
	const kind = typeOf(header);
	const filteredStage = kind.includes('OnScriptStageChanged') && header.filterMode === true;
	const stageFilter = filteredStage ? snapshotValue(script, header.newStageFilter, stage) : undefined;
	if (filteredStage && stage !== null && typeof stageFilter === 'number' && stageFilter !== stage) {
		return;
	}
	const valid = snapshotValue(script, header.validate, stage);
	const pending = [
			{
				id: Number(header.ID),
				guaranteed:
					(header.validate === undefined || valid === true) &&
					(!filteredStage || (stage !== null && typeof stageFilter === 'number')),
			},
		],
		visited = new Set<string>();
	while (pending.length) {
		const entry = pending.pop()!;
		const id = entry.id,
			visitKey = `${id}/${entry.guaranteed}`;
		let guaranteed = entry.guaranteed;
		if (visited.has(visitKey)) {
			continue;
		}
		visited.add(visitKey);
		const node = script.nodes.get(id);
		if (!node) {
			continue;
		}
		const type = typeOf(node);
		if (
			(type === 'CheckBoolIfTrue' && snapshotValue(script, node.value, stage) === false) ||
			(type === 'CheckBoolIfFalse' && snapshotValue(script, node.value, stage) === true)
		) {
			continue;
		}
		if (
			(type === 'CheckBoolIfTrue' || type === 'CheckBoolIfFalse') &&
			typeof snapshotValue(script, node.value, stage) !== 'boolean'
		) {
			guaranteed = false;
		}
		if (type === 'IfElseAction') {
			const condition = snapshotValue(script, node.condition, stage);
			if (typeof condition === 'boolean') {
				const branch = condition ? node.onTrueID : node.onFalseID;
				if (Number.isInteger(branch) && Number(branch) >= 0) {
					pending.push({ id: Number(branch), guaranteed });
				}
				if (Number.isInteger(node.nextID) && Number(node.nextID) >= 0) {
					pending.push({ id: Number(node.nextID), guaranteed });
				}
				continue;
			}
			guaranteed = false;
		}
		yield { node, guaranteed };
		if (type === 'SwitchInt' && Array.isArray(node.caseValueList) && Array.isArray(node.caseIDList)) {
			const value = snapshotValue(script, node.value, stage);
			if (typeof value === 'number') {
				const index = node.caseValueList.indexOf(value);
				const next = index < 0 ? node.defaultID : node.caseIDList[index];
				if (Number.isInteger(next) && Number(next) >= 0) {
					pending.push({ id: Number(next), guaranteed });
				}
				if (Number.isInteger(node.nextID) && Number(node.nextID) >= 0) {
					pending.push({ id: Number(node.nextID), guaranteed });
				}
				continue;
			}
			guaranteed = false;
		}

		for (const [key, value] of Object.entries(node)) {
			if (key !== 'ID' && key.endsWith('ID') && Number.isInteger(value) && Number(value) >= 0) {
				pending.push({ id: Number(value), guaranteed });
			}
			if ((key === 'idList' || key === 'caseIDList') && Array.isArray(value)) {
				pending.push(
					...value
						.filter((next) => Number.isInteger(next) && Number(next) >= 0)
						.map((next) => ({ id: Number(next), guaranteed })),
				);
			}
		}
	}
}

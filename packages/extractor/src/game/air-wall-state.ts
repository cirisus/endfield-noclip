import { isObject } from '@endfield-noclip/formats/unity/values';

import type { Wall } from '@oem/ganglia';

const completedReasons = (reasons: unknown, any: unknown): boolean | undefined => {
	if (!Array.isArray(reasons) || reasons.length === 0 || typeof any !== 'boolean') {
		return undefined;
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
 * @returns mission-controlled state with quests/missions completed and script overrides absent; unsupported
 *   or script-owned gates retain unresolved activation
 */
export const completedWallState = (wall: unknown): Wall['state'] => {
	if (!isObject(wall) || wall.scriptId !== '0' || typeof wall.defaultOn !== 'boolean') {
		return 'unknown';
	}
	const condition = wall.condition;
	if (!isObject(condition) || condition.checkType !== 1 || !isObject(condition.missionData)) {
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

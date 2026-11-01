import type { SceneControl, StoryPlace } from './states.ts';

// story progress as one choice: a point in an ordered list of missions sets every quest and mission control of
// those missions consistently, instead of each quest being picked on its own.

/**
 * @param control a scene control
 * @returns where it sits in the story: a quest or mission control's place, `null` for other kinds
 */
export const storyPlace = (control: SceneControl): StoryPlace | null =>
	control.kind === 'quest' || control.kind === 'mission' ? control.story : null;

/** a point in a story line: in `missions[mission]`, at `step` (0: just started); `null` once all are done */
export type StoryPoint = { mission: number; step: number } | null;

/** `QuestState` / `MissionState` values */
const NONE = 0;
const PROCESSING = 2;
const COMPLETED = 3;

/**
 * @param controls the merged scene and companion controls
 * @returns overrides beyond scene defaults for completed quests and maximum facilities; derived gates keep
 *   their formulas
 */
export const completedProgressionPicks = (controls: readonly SceneControl[]): Record<string, number> => {
	const progression = new Set([
		'controlNexus',
		'cabin',
		'cabinLevel',
		'settlement',
		'poi',
		'factoryRegion',
		'facility',
		'doodadGroups',
	]);
	const picks: Record<string, number> = {};
	for (const control of controls) {
		if (control.derived !== null) {
			continue;
		}
		let value: number | undefined;
		if (control.kind === 'quest' || control.kind === 'mission') {
			value = COMPLETED;
		} else if (progression.has(control.kind)) {
			value = control.values.at(-1)?.value;
		}
		if (value !== undefined && value !== control.default && control.values.some((v) => v.value === value)) {
			picks[control.id] = value;
		}
	}
	return picks;
};

/**
 * @param controls a package's controls
 * @param missions mission ids in story order
 * @param point where the story stands
 * @returns picks for the missions' quest and mission controls: missions before the point completed, after it
 *   not started; in its mission, quests before its step completed, at it in progress and after it not
 *   started. `null` drops a pick, so the finished story (the default) clears them. quests without a step are
 *   left alone
 */
export const storyPointPicks = (
	controls: readonly SceneControl[],
	missions: readonly string[],
	point: StoryPoint,
): Record<string, number | null> => {
	const picks: Record<string, number | null> = {};
	for (const control of controls) {
		const story = storyPlace(control);
		const index = story === null ? -1 : missions.indexOf(story.mission);
		if (story === null || index === -1) {
			continue;
		}
		if (point === null) {
			picks[control.id] = null;
		} else if (index !== point.mission) {
			picks[control.id] = index < point.mission ? COMPLETED : NONE;
		} else if (control.kind === 'mission') {
			picks[control.id] = PROCESSING;
		} else if (story.step != null) {
			const { step } = story;
			picks[control.id] = step < point.step ? COMPLETED : step === point.step ? PROCESSING : NONE;
		}
	}
	return picks;
};

/**
 * @param controls a package's controls
 * @param missions mission ids in story order
 * @returns the points that tell the controls apart: each mission's start and each step quest controls sit at,
 *   in order, with the quests at that step (several off-flow quests can share one), then the finished story
 */
export const storyPoints = (
	controls: readonly SceneControl[],
	missions: readonly string[],
): { point: StoryPoint; mission: string; quests: SceneControl[] }[] => {
	const points: { point: StoryPoint; mission: string; quests: SceneControl[] }[] = [];
	for (const [index, mission] of missions.entries()) {
		points.push({ point: { mission: index, step: 0 }, mission, quests: [] });
		const steps = Map.groupBy(
			controls.filter(
				(control) =>
					control.kind === 'quest' && control.story?.mission === mission && control.story.step != null,
			),
			(control) => storyPlace(control)?.step ?? 0,
		);
		for (const [step, quests] of [...steps].toSorted((a, b) => a[0] - b[0])) {
			points.push({ point: { mission: index, step }, mission, quests });
		}
	}
	points.push({ point: null, mission: '', quests: [] });
	return points;
};

import { conditionVisible, resolveSceneValues } from '@endfield-noclip/package-format/conditions';
import type { Preset } from '@endfield-noclip/package-format/oem';
import type { ConditionalSetInfo, StatesInfo } from '@endfield-noclip/package-format/states';
import { storyPlace, storyPointPicks, storyPoints } from '@endfield-noclip/package-format/story';

/**
 * finds story-consistent candidates using the viewer's existing story-point semantics. unknown, unplaceable
 * quests are never assigned independently to manufacture a passing preset.
 *
 * @param states scene controls including point-only quests
 * @param condition known point prerequisites, or null without recorded prerequisites
 * @returns defaults and satisfying story points ordered by number of changed control values
 */
export const pointPresets = (states: StatesInfo, condition: ConditionalSetInfo | null): Preset[] => {
	const defaults = resolveSceneValues(states, {});
	const satisfied = (picks: Record<string, number>): boolean =>
		condition === null || conditionVisible(condition, resolveSceneValues(states, picks));
	const result: Preset[] = [{ id: 'default', label: 'Viewer defaults', picks: {}, satisfies: satisfied({}) }];
	if (condition === null) {
		return result;
	}
	const required = new Set(condition.alternatives.flatMap((alt) => alt.map((r) => r.control)));
	const missions = [
		...new Set(
			states.controls
				.filter((c) => required.has(c.id))
				.flatMap((c) => {
					const story = storyPlace(c);
					return story === null ? [] : [story.mission];
				}),
		),
	];
	const main = states.mainStory;
	const groups = missions
		.map((id) => (main.includes(id) ? main : [id]))
		.filter((ids, i, all) => all.findIndex((other) => other.join() === ids.join()) === i);
	let candidates: { picks: Record<string, number>; labels: string[] }[] = [{ picks: {}, labels: [] }];
	for (const ids of groups) {
		const choices = storyPoints(states.controls, ids).map(({ point, mission, quests }) => ({
			picks: Object.fromEntries(
				Object.entries(storyPointPicks(states.controls, ids, point)).map(([id, v]) => [
					id,
					v ?? defaults[id],
				]),
			),
			label:
				point === null
					? 'Story finished'
					: `${states.missions.find((m) => m.id === mission)?.name ?? mission}: ${quests.map((q) => q.name).join(', ') || 'mission start'} (${mission}:${point.step})`,
		}));
		const next = candidates.flatMap((base) =>
			choices.map((choice) => ({
				picks: Object.assign({}, base.picks, choice.picks),
				labels: [...base.labels, choice.label],
			})),
		);
		// A huge cross-product is evidence that no safe automatic preset was established.
		if (next.length > 4096) {
			return result;
		}
		candidates = next;
	}
	const seen = new Set<string>();
	const valid = candidates
		.filter(({ picks }) => satisfied(picks))
		.map(({ picks, labels }) => ({
			picks: Object.fromEntries(Object.entries(picks).filter(([id, v]) => v !== defaults[id])),
			labels,
		}))
		.filter(({ picks }) => {
			const key = JSON.stringify(picks);
			if (seen.has(key) || Object.keys(picks).length === 0) {
				return false;
			}
			seen.add(key);
			return true;
		})
		.toSorted((a, b) => Object.keys(a.picks).length - Object.keys(b.picks).length);
	for (const [index, { picks, labels }] of valid.slice(0, 8).entries()) {
		result.push({
			id: `story-${index + 1}`,
			label: labels.join('; '),
			picks,
			satisfies: true,
		});
	}
	return result;
};

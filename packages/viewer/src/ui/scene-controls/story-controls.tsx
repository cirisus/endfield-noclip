import type { MissionInfo, RuleText, SceneControl } from '@endfield-noclip/package-format/states';
import {
	storyPlace,
	storyPointPicks,
	storyPoints,
	type StoryPoint,
} from '@endfield-noclip/package-format/story';

import { definite } from '@mary-ext/array-fns';

import type { Viewer } from '../../viewer/viewer.ts';
import { ChoiceRow } from '../controls.tsx';
import { LazyDetails } from '../lazy-details.tsx';

import { ControlRow } from './control-row.tsx';

/** quest log tabs in the game's order */
const CATEGORIES: { category: MissionInfo['category']; title: string }[] = [
	{ category: 'main', title: 'Main story' },
	{ category: 'side', title: 'Side and character' },
	{ category: 'discovery', title: 'Discovery' },
	{ category: 'activity', title: 'Events' },
	{ category: 'other', title: 'Other' },
];

/** @returns a mission's controls: the mission first, then quests by step, steps before unnumbered ones */
const ordered = (entries: readonly SceneControl[]): SceneControl[] =>
	entries.toSorted(
		(a, b) =>
			Number(a.kind !== 'mission') - Number(b.kind !== 'mission') ||
			(storyPlace(a)?.step ?? Number.MAX_SAFE_INTEGER) - (storyPlace(b)?.step ?? Number.MAX_SAFE_INTEGER) ||
			a.id.localeCompare(b.id),
	);

/**
 * a select over story points: each sets every quest and mission control of the given missions consistently
 *
 * @param props.listed the controls listed for the shown level, which decide the points offered
 * @param props.all every control of the package, which the picks cover
 */
const StoryProgress = ({
	viewer,
	label,
	order,
	listed,
	all,
	missions,
	finished,
}: {
	viewer: Viewer;
	label: string;
	/** mission ids in story order */
	order: readonly string[];
	listed: readonly SceneControl[];
	all: readonly SceneControl[];
	missions: ReadonlyMap<string, MissionInfo>;
	/** the label of the finished point */
	finished: string;
}) => {
	const points: { key: string; point: StoryPoint; text: string }[] = [
		{ key: 'none', point: { mission: -1, step: 0 }, text: 'not started' },
		...storyPoints(listed, order).map(({ point, mission, quests }) => {
			if (point === null) {
				return { key: 'done', point, text: finished };
			}
			const name = (order.length > 1 && missions.get(mission)?.name) || null;
			const step = quests.length === 0 ? 'started' : quests.map((quest) => quest.name).join(' / ');
			return {
				key: `${point.mission}:${point.step}`,
				point,
				text: name === null ? step : `${name}: ${step}`,
			};
		}),
	];
	// the point whose picks the current values match, if any; a dropped pick stands for the control's default
	const defaults = new Map(all.map((entry) => [entry.id, entry.default]));
	const current = points.findIndex(({ point }) =>
		Object.entries(storyPointPicks(all, order, point)).every(
			([id, value]) => (viewer.sceneValues[id] ?? defaults.get(id)) === (value ?? defaults.get(id)),
		),
	);
	return (
		<ChoiceRow label={label}>
			<select
				value={current}
				onChange={(event) => {
					const point = points[Number(event.currentTarget.value)]?.point;
					if (point !== undefined) {
						viewer.setSceneValues(storyPointPicks(all, order, point));
					}
				}}
			>
				{current === -1 && <option value={-1}>(mixed)</option>}
				{points.map(({ key, text }, index) => (
					<option key={key} value={index}>
						{text}
					</option>
				))}
			</select>
		</ChoiceRow>
	);
};

/**
 * quest and mission controls grouped by quest log tab and mission, with progress selects over their steps
 *
 * @param props.controls the quest and mission controls listed for the shown level
 * @param props.all every control of the package
 * @param props.mainLine the main story's mission ids in story order
 * @param props.describe a rule in words, its references named
 * @param props.levelName a level id's display name
 */
export const StoryControls = ({
	viewer,
	controls,
	all,
	missions,
	mainLine,
	describe,
	levelName,
}: {
	viewer: Viewer;
	controls: readonly SceneControl[];
	all: readonly SceneControl[];
	missions: ReadonlyMap<string, MissionInfo>;
	mainLine: readonly string[];
	describe: (rule: RuleText) => string;
	levelName: (id: string) => string;
}) => {
	const grouped = Map.groupBy(controls, (control) => storyPlace(control)?.mission ?? null);
	const rows = (entries: readonly SceneControl[]) =>
		ordered(entries).map((entry) => (
			<ControlRow key={entry.id} viewer={viewer} control={entry} describe={describe} />
		));
	const unplaced = grouped.get(null) ?? [];
	return (
		<>
			{mainLine.some((id) => grouped.has(id)) && (
				<StoryProgress
					viewer={viewer}
					label="Main story progress"
					order={mainLine}
					listed={controls}
					all={all}
					missions={missions}
					finished="main story finished"
				/>
			)}
			{CATEGORIES.map(({ category, title }) => {
				const listed = [...missions.values()].filter(
					(mission) => mission.category === category && grouped.has(mission.id),
				);
				if (listed.length === 0) {
					return null;
				}
				return (
					<section key={category} className="story-category">
						<h3>{title}</h3>
						{listed.map((mission) => (
							<LazyDetails
								key={mission.id}
								className="story-mission"
								summary={
									<summary>
										{mission.name ?? mission.id}
										<small className="muted">
											{definite([
												mission.levelId && `takes place in ${levelName(mission.levelId)}`,
												mission.chapter,
												mission.episode,
												mission.name && mission.id,
											]).join(' · ')}
										</small>
									</summary>
								}
							>
								{() => (
									<>
										<StoryProgress
											viewer={viewer}
											label="Progress"
											order={[mission.id]}
											listed={controls}
											all={all}
											missions={missions}
											finished="completed"
										/>
										<LazyDetails summary={<summary>Quests ({grouped.get(mission.id)?.length ?? 0})</summary>}>
											{() => rows(grouped.get(mission.id) ?? [])}
										</LazyDetails>
									</>
								)}
							</LazyDetails>
						))}
					</section>
				);
			})}
			{unplaced.length > 0 && (
				<section className="story-category">
					<h3>Not in this client</h3>
					{rows(unplaced)}
				</section>
			)}
		</>
	);
};

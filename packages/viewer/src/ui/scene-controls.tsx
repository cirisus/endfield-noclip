import { ruleText } from '@endfield-noclip/package-format/conditions';
import { volumeReaches } from '@endfield-noclip/package-format/environment-volumes';
import type {
	MissionInfo,
	RuleText,
	SceneControl,
	SceneControlKind,
} from '@endfield-noclip/package-format/states';
import {
	storyPlace,
	storyPointPicks,
	storyPoints,
	type StoryPoint,
} from '@endfield-noclip/package-format/story';

import { definite, mapDefined, unique } from '@mary-ext/array-fns';
import { useId, useState } from 'react';

import { volumeCondition, volumeLevelTag } from '../render/environment-blend.ts';
import type { Viewer } from '../viewer.ts';

import { Drivers } from './drivers.tsx';
import { Panel } from './panel.tsx';
import { useViewerState } from './use-viewer.ts';
import { WaterLevels } from './water-levels.tsx';

/** panel sections in order, each listing the controls of its kinds */
const SECTIONS: { kinds: SceneControlKind[]; title: string; note: string | null; open: boolean }[] = [
	{
		kinds: ['sceneState'],
		title: 'Scene states',
		note: 'States without a condition are only set by dungeons and scripts.',
		open: true,
	},
	{
		kinds: ['quest', 'mission'],
		title: 'Quests and missions',
		note: 'Story finished by default.',
		open: false,
	},
	{
		kinds: ['mapVar', 'globalVar'],
		title: 'Variables',
		note: 'Held by the server; each defaults to the highest value the scene checks.',
		open: false,
	},
	{
		kinds: ['settlement', 'poi', 'factoryRegion', 'facility', 'doodadGroups', 'activation'],
		title: 'Progression',
		note: null,
		open: true,
	},
	{
		kinds: ['controlNexus', 'cabin', 'cabinLevel'],
		title: 'Dijiang',
		note: null,
		open: true,
	},
	{
		kinds: ['created'],
		title: 'Created during play',
		note: 'Interactives the server or a level script adds after the level loads, hidden by default.',
		open: false,
	},
	{
		kinds: ['door', 'bridge', 'destruction'],
		title: 'Doors, bridges and destructibles',
		note: null,
		open: false,
	},
	{
		kinds: ['area'],
		title: 'Stream areas',
		note: null,
		open: false,
	},
	{
		kinds: ['proximity'],
		title: 'Player nearby',
		note: 'Interactives that change as the player approaches; the camera stands in for the player.',
		open: false,
	},
	{
		kinds: ['harvest'],
		title: 'Harvest',
		note: 'One choice covers every tree.',
		open: false,
	},
	{
		kinds: ['script'],
		title: 'Script / event scenery',
		note: null,
		open: false,
	},
	{
		kinds: ['logic'],
		title: 'Logic-gate previews',
		note: 'Gates with no recovered controller.',
		open: false,
	},
];

/** kinds whose controls are plain on/off switches */
const SWITCH_KINDS: ReadonlySet<SceneControlKind> = new Set([
	'sceneState',
	'script',
	'logic',
	'cabin',
	'created',
	'door',
	'bridge',
]);

/**
 * a scene control: a checkbox for an on/off switch only the user sets, otherwise a select. derived controls
 * and stream areas offer to follow the game or the camera
 */
const ControlRow = ({
	viewer,
	control,
	describe,
}: {
	viewer: Viewer;
	control: SceneControl;
	/** a rule in words, its references named */
	describe: (rule: RuleText) => string;
}) => {
	const value = viewer.sceneValues[control.id] ?? control.default;
	const picked = control.id in viewer.scenePicks;
	const label = (entry: number): string =>
		control.values.find((candidate) => candidate.value === entry)?.label ?? String(entry);
	const detail = definite([control.rule && describe(control.rule), control.assumption]).join(' · ');
	let follows: string | null = null;
	if (control.followsCamera) {
		follows = 'Follow camera';
	} else if (control.derived !== null) {
		follows = 'Follow game';
	}
	if (follows === null && SWITCH_KINDS.has(control.kind)) {
		return (
			<div>
				<label className="toggle scene-toggle">
					<input
						type="checkbox"
						checked={value === 1}
						onChange={(event) => viewer.setSceneValue(control.id, Number(event.currentTarget.checked))}
					/>
					<span>
						{control.name}
						<small className="muted">{detail}</small>
					</span>
				</label>
				<Drivers viewer={viewer} control={control} />
			</div>
		);
	}
	return (
		<div>
			<label className="scene-choice">
				<span>
					{control.name}
					<small className="muted">{detail}</small>
				</span>
				<select
					value={follows !== null && !picked ? '' : String(value)}
					onChange={(event) => {
						const text = event.currentTarget.value;
						viewer.setSceneValue(control.id, text === '' ? null : Number(text));
					}}
				>
					{follows !== null && <option value="">{picked ? follows : `${follows} (${label(value)})`}</option>}
					{control.values.map((entry) => (
						<option key={entry.value} value={entry.value}>
							{entry.label}
							{follows === null && entry.value === control.default ? ' (initial)' : ''}
						</option>
					))}
				</select>
			</label>
			<Drivers viewer={viewer} control={control} />
		</div>
	);
};

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
			const name = (order.length > 1 && missions.get(mission)?.name) || null;
			const step = quests.length === 0 ? 'started' : quests.map((quest) => quest.name).join(' / ');
			return {
				key: point === null ? 'done' : `${point.mission}:${point.step}`,
				point,
				text: point === null ? finished : name === null ? step : `${name}: ${step}`,
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
		<label className="scene-choice">
			<span>{label}</span>
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
		</label>
	);
};

/** quest and mission controls grouped by quest log tab and mission, with progress selects over their steps */
const StoryControls = ({
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
	/** every control of the package */
	all: readonly SceneControl[];
	missions: ReadonlyMap<string, MissionInfo>;
	/** the main story's mission ids in story order */
	mainLine: readonly string[];
	describe: (rule: RuleText) => string;
	/** a level id's display name */
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
							<details key={mission.id} className="story-mission">
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
								<StoryProgress
									viewer={viewer}
									label="Progress"
									order={[mission.id]}
									listed={controls}
									all={all}
									missions={missions}
									finished="completed"
								/>
								<details>
									<summary>Quests ({grouped.get(mission.id)?.length ?? 0})</summary>
									{rows(grouped.get(mission.id) ?? [])}
								</details>
							</details>
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

/**
 * @param viewer the loaded scene and its preview selections
 * @returns controls for authored progression and manual visibility previews
 */
export const SceneControls = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const searchId = useId();
	const [query, setQuery] = useState('');
	const manifest = viewer.scene?.pkg.manifest;
	if (!manifest) {
		return null;
	}
	const level = manifest.levels.find((entry) => entry.id === viewer.level);
	const matches = (name: string): boolean => name.toLowerCase().includes(query.toLowerCase());
	const missions = new Map(manifest.states.missions.map((mission) => [mission.id, mission]));
	const byId = new Map(manifest.states.controls.map((entry) => [entry.id, entry]));
	/** @returns a quest or mission control's name with its mission's, else the control's name */
	const storyName = (control: SceneControl): string => {
		const story = storyPlace(control);
		const mission = story && missions.get(story.mission);
		if (!mission?.name || control.kind === 'mission') {
			return control.name;
		}
		return `${mission.name}: ${control.name}`;
	};
	// a reference to a quest or mission reads as its story name; others as their own text
	const describe = (rule: RuleText): string =>
		ruleText(rule, (reference) => {
			const control = byId.get(reference.control);
			return control && storyPlace(control) ? `“${storyName(control)}”` : reference.text;
		});
	// a control is listed for the levels whose content it gates
	const controls = manifest.states.controls.filter(
		(entry) =>
			(level === undefined || entry.levelTags.includes(0) || entry.levelTags.includes(level.tag)) &&
			matches(`${storyName(entry)} ${entry.id} ${entry.rule ? describe(entry.rule) : ''}`),
	);
	// volumes apply wherever they hold the camera, so a neighbour's volume reaching into this level is listed too
	const volumes = mapDefined(manifest.environmentVolumes, (volume, id) => {
		const owner = volumeLevelTag(manifest, volume);
		const listed =
			(owner === 0 ||
				owner === level?.tag ||
				(level !== undefined && volumeReaches(volume.shape, level.rect))) &&
			matches(volume.name);
		if (!listed) {
			return undefined;
		}
		return { volume, id, owner, condition: volumeCondition(manifest, volume) };
	});
	const levelNames = new Map(manifest.levels.map((entry) => [entry.tag, entry.name ?? entry.id]));
	const controlNames = new Map(manifest.states.controls.map((entry) => [entry.id, entry.name]));
	/** @returns the controls a volume loads with besides its own switch, by name */
	const loadingStates = (condition: number, own: string | null): string =>
		unique(
			manifest.states.conditionalSets[condition].alternatives.flatMap((requirements) =>
				mapDefined(requirements, ({ control }) =>
					control === own ? undefined : (controlNames.get(control) ?? control),
				),
			),
		).join(' or ');
	return (
		<Panel
			title="Scene conditions"
			label="scene conditions"
			className="scene-controls"
			actions={
				<button type="button" onClick={() => viewer.resetSceneValues()}>
					Reset
				</button>
			}
		>
			<label className="control-search" htmlFor={searchId}>
				Filter controls
				<input
					id={searchId}
					type="search"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
				/>
			</label>
			{SECTIONS.map(({ kinds, title, note, open }) => {
				const listed = controls.filter((entry) => kinds.includes(entry.kind));
				return (
					<details key={title} open={open}>
						<summary>
							{title} ({listed.length})
						</summary>
						{note !== null && <p className="muted small">{note}</p>}
						{kinds.includes('quest') ? (
							<StoryControls
								viewer={viewer}
								controls={listed}
								all={manifest.states.controls}
								missions={missions}
								mainLine={manifest.states.mainStory}
								describe={describe}
								levelName={(id) => manifest.levels.find((entry) => entry.id === id)?.name ?? id}
							/>
						) : (
							listed.map((entry) => (
								<ControlRow key={entry.id} viewer={viewer} control={entry} describe={describe} />
							))
						)}
					</details>
				);
			})}
			<WaterLevels viewer={viewer} matches={matches} />
			<details>
				<summary>Lighting / environment volumes ({volumes.length})</summary>
				<p className="muted small">A pinned phase overrides these.</p>
				{volumes.map(({ volume, id, owner, condition }) => {
					const { control } = volume;
					const states = condition === null ? '' : loadingStates(condition, control);
					return (
						<label className="toggle scene-toggle" key={id}>
							<input
								type="checkbox"
								disabled={control === null}
								checked={control !== null && viewer.sceneValues[control] === 1}
								onChange={(event) =>
									control !== null && viewer.setSceneValue(control, Number(event.currentTarget.checked))
								}
							/>
							<span>
								{volume.name}
								<small className="muted">
									{control === null
										? 'Phase unavailable'
										: volume.blendMode === 3
											? 'Scripted blend · preview at full strength'
											: `Priority ${volume.priority}`}
									{states !== '' && ` · with ${states}`}
									{condition !== null &&
										control !== null &&
										viewer.sceneValues[control] === 1 &&
										!viewer.conditionResults[condition] &&
										' (not loaded)'}
									{owner !== 0 &&
										owner !== level?.tag &&
										` · from ${levelNames.get(owner) ?? `level ${owner}`}`}
								</small>
							</span>
						</label>
					);
				})}
			</details>
		</Panel>
	);
};

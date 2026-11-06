import { ruleText } from '@endfield-noclip/package-format/conditions';
import type { RuleText, SceneControl, SceneControlKind } from '@endfield-noclip/package-format/states';
import { storyPlace } from '@endfield-noclip/package-format/story';

import { useId, useState } from 'react';

import { controlsForLevel, groupByLevel } from '../../scene-states/listing.ts';
import type { Viewer } from '../../viewer/viewer.ts';
import { LazyDetails } from '../lazy-details.tsx';
import { useViewerState } from '../use-viewer.ts';

import { ControlRow } from './control-row.tsx';
import { EnvironmentVolumes } from './environment-volumes.tsx';
import { OtherLevels } from './other-levels.tsx';
import { StoryControls } from './story-controls.tsx';
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
		kinds: ['activity'],
		title: 'Limited-time events',
		note: 'Placed only while the server runs an event, hidden by default.',
		open: false,
	},
	{
		kinds: ['door', 'bridge'],
		title: 'Doors and bridges',
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

/**
 * @param viewer the loaded scene and its preview selections
 * @returns controls for authored progression and manual visibility previews
 */
export const SceneControls = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const searchId = useId();
	const [query, setQuery] = useState('');
	const manifest = viewer.manifest;
	if (manifest === null) {
		return null;
	}
	const level = viewer.currentLevel;
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
	const controls = manifest.states.controls.filter((entry) =>
		matches(`${storyName(entry)} ${entry.id} ${entry.rule ? describe(entry.rule) : ''}`),
	);
	const levelNames = new Map(manifest.levels.map((entry) => [entry.id, entry.name ?? entry.id]));
	const sectionRows = (kinds: readonly SceneControlKind[], entries: readonly SceneControl[]) =>
		kinds.includes('quest') ? (
			<StoryControls
				viewer={viewer}
				controls={entries}
				all={manifest.states.controls}
				missions={missions}
				mainLine={manifest.states.mainStory}
				describe={describe}
				levelName={(id) => levelNames.get(id) ?? id}
			/>
		) : (
			entries.map((entry) => (
				<ControlRow key={entry.id} viewer={viewer} control={entry} describe={describe} />
			))
		);
	return (
		<section className="panel scene-controls" aria-label="scene conditions">
			<header>
				<h2>Scene conditions</h2>
				<button onClick={() => viewer.resetSceneValues()}>Reset</button>
			</header>
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
				const ofKinds = controls.filter((entry) => kinds.includes(entry.kind));
				const here = controlsForLevel(ofKinds, level);
				const listedHere = new Set(here);
				const others = groupByLevel(
					ofKinds.filter((entry) => !listedHere.has(entry)),
					manifest.levels,
					level,
					(entry) => entry.levelTags,
				);
				return (
					<LazyDetails
						key={title}
						initiallyOpen={open}
						summary={
							<summary>
								{title} ({here.length}
								{others.length > 0 && ` here · ${ofKinds.length} in all`})
							</summary>
						}
					>
						{() => (
							<>
								{note !== null && <p className="muted small">{note}</p>}
								{sectionRows(kinds, here)}
								<OtherLevels groups={others} render={(entries) => sectionRows(kinds, entries)} />
							</>
						)}
					</LazyDetails>
				);
			})}
			<WaterLevels viewer={viewer} matches={matches} />
			<EnvironmentVolumes viewer={viewer} manifest={manifest} level={level} matches={matches} />
		</section>
	);
};

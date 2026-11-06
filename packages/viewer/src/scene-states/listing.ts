/**
 * which scene controls and environment volumes the viewer lists for the current level, and how it groups the
 * rest by level (see docs/viewer/scene-states.md "the scene conditions panel").
 *
 * @module
 */

import type { EnvironmentVolumeInfo } from '@endfield-noclip/package-format/environment';
import { volumeReaches } from '@endfield-noclip/package-format/environment-volumes';
import type { LevelInfo, PackageManifest } from '@endfield-noclip/package-format/manifest';
import type { SceneControlBase } from '@endfield-noclip/package-format/states';

import { volumeLevelTag } from '../environment/blend.ts';

/** entries listed under one of the other levels */
export interface LevelGroup<T> {
	level: LevelInfo;
	entries: T[];
}

/**
 * @param entries what isn't listed for the current level
 * @param levels the package's levels
 * @param here the current level, which gets no group
 * @param tags the level tags an entry belongs to
 * @returns per other level in package order, the entries with its tag, skipping levels with none; an entry of
 *   several levels is in each of their groups
 */
export const groupByLevel = <T>(
	entries: readonly T[],
	levels: readonly LevelInfo[],
	here: LevelInfo | null,
	tags: (entry: T) => readonly number[],
): LevelGroup<T>[] =>
	levels.flatMap((level) => {
		if (level === here) {
			return [];
		}
		const listed = entries.filter((entry) => tags(entry).includes(level.tag));
		return listed.length === 0 ? [] : [{ level, entries: listed }];
	});

/**
 * @param control a scene control
 * @param level the current level, or `null` for none
 * @returns whether the control gates the level's content: its level tags include 0 or the level's tag. every
 *   control is listed without a level
 */
export const controlListedFor = (control: SceneControlBase, level: LevelInfo | null): boolean =>
	level === null || control.levelTags.includes(0) || control.levelTags.includes(level.tag);

/**
 * @param controls scene controls
 * @param level the current level, or `null` for none
 * @returns the controls {@link controlListedFor} the level, in order
 */
export const controlsForLevel = <T extends SceneControlBase>(
	controls: readonly T[],
	level: LevelInfo | null,
): T[] => controls.filter((control) => controlListedFor(control, level));

/** an environment volume listed for a level */
export interface ListedVolume {
	/** index into {@link PackageManifest.environmentVolumes} */
	id: number;
	volume: EnvironmentVolumeInfo;
	/** the level tag of the volume's group; 0 for scene-wide volumes */
	owner: number;
}

/**
 * volumes apply wherever they hold the camera, so a neighbour's volume reaching into the level is listed with
 * the level's own and the scene-wide ones
 *
 * @param manifest the package manifest
 * @param level the current level, or `null` for none (then only scene-wide volumes are listed)
 * @returns the package's environment volumes listed for the level, in order
 */
export const volumesForLevel = (manifest: PackageManifest, level: LevelInfo | null): ListedVolume[] =>
	manifest.environmentVolumes.flatMap((volume, id) => {
		const owner = volumeLevelTag(manifest, volume);
		const listed =
			owner === 0 || (level !== null && (owner === level.tag || volumeReaches(volume.shape, level.rect)));
		return listed ? [{ id, volume, owner }] : [];
	});

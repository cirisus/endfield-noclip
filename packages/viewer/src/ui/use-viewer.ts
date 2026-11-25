import { useCallback, useSyncExternalStore } from 'react';

import type { Viewer } from '../viewer/viewer.ts';

const NOOP = (): void => {};
const NOOP_SUBSCRIBE = (): (() => void) => NOOP;

/**
 * re-renders the caller when the package, the options or the shown level change.
 *
 * @param viewer the viewer
 * @returns the viewer's state revision (only useful as a dependency)
 */
export const useViewerState = (viewer: Viewer): number => {
	const subscribe = useCallback((listener: () => void) => viewer.subscribe('state', listener), [viewer]);
	return useSyncExternalStore(subscribe, () => viewer.stateRevision);
};

/**
 * re-renders the caller when the environment at the camera changes (its name or applied volumes).
 *
 * @param viewer the viewer
 * @returns the viewer's environment revision (only useful as a dependency)
 */
export const useViewerEnvironment = (viewer: Viewer): number => {
	const subscribe = useCallback(
		(listener: () => void) => viewer.subscribe('environment', listener),
		[viewer],
	);
	return useSyncExternalStore(subscribe, () => viewer.environmentRevision);
};

/**
 * re-renders the caller when the viewer's stats change.
 *
 * @param viewer the viewer
 * @returns the viewer's stats revision (only useful as a dependency)
 */
export const useViewerStats = (viewer: Viewer): number => {
	const subscribe = useCallback((listener: () => void) => viewer.subscribe('stats', listener), [viewer]);
	return useSyncExternalStore(subscribe, () => viewer.statsRevision);
};

/** the size of the cells {@link useCameraCell} tells apart, in metres */
const CAMERA_CELL = 25;

/**
 * re-renders the caller when the camera moves into another cell of a 25 m grid, while `enabled`; nothing
 * while it isn't
 *
 * @param viewer the viewer
 * @param enabled whether to follow the camera
 * @returns the camera's cell, as a key (only useful as a dependency); empty while not enabled
 */
export const useCameraCell = (viewer: Viewer, enabled: boolean): string => {
	const subscribe = useCallback(
		(listener: () => void) => (enabled ? viewer.subscribe('stats', listener) : NOOP_SUBSCRIBE()),
		[viewer, enabled],
	);
	return useSyncExternalStore(subscribe, () =>
		enabled ? viewer.camera.position.map((value) => Math.floor(value / CAMERA_CELL)).join() : '',
	);
};

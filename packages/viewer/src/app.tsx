import { useEffect, useCallback, type ReactNode, useRef, useState } from 'react';

import type { PackageSource } from './package/package-source.ts';
import { CameraReadout } from './ui/camera-readout.tsx';
import { LevelsPanel } from './ui/levels-panel.tsx';
import { type OpenPackage, PackagePanel } from './ui/package-panel.tsx';
import { sourceFromParam } from './ui/package-param.ts';
import { PhotoFiltersPanel } from './ui/photo-filters.tsx';
import { SceneControls } from './ui/scene-controls.tsx';
import { FiltersPanel, PhotographyPanel, SettingsPanel } from './ui/settings-panel.tsx';
import { StatsPanel } from './ui/stats-panel.tsx';
import { Viewer } from './viewer.ts';

const PACKAGE_PARAM = 'package';
const LEVEL_PARAM = 'level';

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** sets or clears a search parameter of the page URL without a navigation */
const setParam = (name: string, value: string | null): void => {
	const url = new URL(location.href);
	if (value === null) {
		url.searchParams.delete(name);
	} else {
		url.searchParams.set(name, value);
	}
	history.replaceState(null, '', url);
};

/**
 * @param props optional host overlay and photography library URL; the overlay delegates navigation to the
 *   host
 * @returns the shared viewer canvas and scene panels
 */
export const App = ({
	overlay,
	filtersUrl,
}: {
	overlay?: (viewer: Viewer, panel: HTMLElement | null) => ReactNode;
	filtersUrl?: string;
}) => {
	const hosted = overlay !== undefined;
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [viewer, setViewer] = useState<Viewer | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [current, setCurrent] = useState<OpenPackage | null>(null);
	const [status, setStatus] = useState('');
	const [pointPanelRoot, setPointPanelRoot] = useState<HTMLDivElement | null>(null);

	const open = useCallback((target: Viewer, source: PackageSource, param: string | null): void => {
		setParam(PACKAGE_PARAM, param);
		setStatus('opening…');
		setCurrent({ label: source.label, param });
		target
			.load(source, new URL(location.href).searchParams.get(LEVEL_PARAM), setStatus)
			.then(() => setStatus(''))
			.catch((err: unknown) => {
				setCurrent(null);
				setStatus(`couldn't open ${source.label}: ${describeError(err)}`);
			});
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (canvas === null) {
			return;
		}
		// StrictMode mounts this effect twice in development, so the first creation is aborted mid-flight
		const abort = new AbortController();
		let created: Viewer | null = null;
		Viewer.create(canvas, (reason) => setError(`the GPU device was lost: ${reason}`), abort.signal)
			.then((instance) => {
				// built before the abort, so before any replacement touched the canvas: safe to destroy
				if (abort.signal.aborted) {
					instance.destroy();
					return;
				}
				created = instance;
				if (import.meta.env.DEV) {
					// exposed for debugging and automated measurements
					Object.assign(window, { viewer: instance });
				}
				setViewer(instance);
				const param = new URL(location.href).searchParams.get(PACKAGE_PARAM);
				if (param !== null && !hosted) {
					open(instance, sourceFromParam(param), param);
				}
			})
			.catch((err: unknown) => {
				if (!abort.signal.aborted) {
					setError(describeError(err));
				}
			});
		return () => {
			abort.abort();
			created?.destroy();
		};
	}, [hosted, open]);

	// the shown level lives in the URL, so a reload or a shared link opens the same level
	useEffect(() => {
		if (viewer === null || hosted) {
			return;
		}
		return viewer.subscribe(() => {
			// nothing to record while no package is loaded (including mid-load)
			if (viewer.scene !== null && new URL(location.href).searchParams.get(LEVEL_PARAM) !== viewer.level) {
				setParam(LEVEL_PARAM, viewer.level);
			}
		});
	}, [viewer, hosted]);

	return (
		<main className={`viewer-app${hosted ? ' hosted-viewer' : ''}`}>
			<canvas ref={canvasRef} className="viewport" />
			{error !== null && (
				<div className="panel error" role="alert">
					<h2>can't start the viewer</h2>
					<p>{error}</p>
				</div>
			)}
			{viewer !== null && (
				<>
					{overlay?.(viewer, pointPanelRoot)}
					<div className="dock left">
						{!hosted && (
							<PackagePanel
								current={current}
								status={status}
								onOpen={(source, param) => open(viewer, source, param)}
							/>
						)}
						{!hosted && <StatsPanel viewer={viewer} />}
					</div>
					<div className="dock right">
						{hosted && <div ref={setPointPanelRoot} className="host-panel" />}
						{!hosted && <LevelsPanel viewer={viewer} />}
						<PhotoFiltersPanel viewer={viewer} source={filtersUrl} />
						<SceneControls viewer={viewer} />
						<PhotographyPanel viewer={viewer} />
						<FiltersPanel viewer={viewer} />
						<SettingsPanel viewer={viewer} />
						{hosted && <StatsPanel viewer={viewer} />}
					</div>
					<div className="dock bottom">
						<CameraReadout viewer={viewer} />
					</div>
				</>
			)}
		</main>
	);
};

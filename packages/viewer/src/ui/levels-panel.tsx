import type { Viewer } from '../viewer/viewer.ts';

import { useViewerState } from './use-viewer.ts';

/** the package's levels, all shown at once: the current one is marked, and picking one flies over it */
export const LevelsPanel = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const levels = viewer.levels();
	if (levels.length === 0) {
		return null;
	}
	const here = viewer.currentLevel?.id;
	const places = viewer.manifest?.places ?? [];
	const currentPlaces = here === undefined ? [] : places.filter((place) => place.level === here);
	return (
		<section className="panel levels" aria-label="levels">
			<header>
				<h2>levels</h2>
			</header>
			<ul>
				{levels.map((level) => {
					const current = level.id === here;
					return (
						<li key={level.id}>
							<button
								type="button"
								className="entry-name"
								title={current ? 'fly back over this level' : 'fly over this level'}
								aria-pressed={current}
								disabled={level.instances === 0}
								onClick={() => viewer.flyToLevel(level.id)}
							>
								{level.name}
								<span className="muted small">
									{level.id} · {level.instances.toLocaleString()} instances
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			{currentPlaces.length > 0 ? (
				<details className="places">
					<summary>places ({currentPlaces.length})</summary>
					<ul>
						{currentPlaces.map((place) => (
							<li key={place.name}>
								<button
									type="button"
									className="entry-name"
									title={`fly to ${place.name}`}
									onClick={() => viewer.flyToPoint(place.position, Math.max(25, Math.min(80, place.radius)))}
								>
									{place.name}
								</button>
							</li>
						))}
					</ul>
				</details>
			) : null}
		</section>
	);
};

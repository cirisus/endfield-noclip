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
		</section>
	);
};

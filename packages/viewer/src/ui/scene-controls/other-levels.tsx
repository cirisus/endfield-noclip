import type { LevelInfo } from '@endfield-noclip/package-format/manifest';

import type { ReactNode } from 'react';

import type { LevelGroup } from '../../scene-states/listing.ts';
import { LazyDetails } from '../lazy-details.tsx';

/**
 * a panel section's entries for levels other than the camera's, one collapsed group per level
 *
 * @param props.groups the entries by level, from `groupByLevel`
 * @param props.render draws one level's entries
 */
export const OtherLevels = <T,>({
	groups,
	render,
}: {
	groups: readonly LevelGroup<T>[];
	render: (entries: readonly T[], level: LevelInfo) => ReactNode;
}) => {
	if (groups.length === 0) {
		return null;
	}
	return (
		<section className="other-levels">
			<h3>Other levels</h3>
			{groups.map(({ level, entries }) => (
				<LazyDetails
					key={level.id}
					summary={
						<summary>
							{level.name ?? level.id} ({entries.length})
						</summary>
					}
				>
					{() => render(entries, level)}
				</LazyDetails>
			))}
		</section>
	);
};

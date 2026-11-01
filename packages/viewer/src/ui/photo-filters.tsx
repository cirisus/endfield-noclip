import { useEffect, useId, useState } from 'react';

import { parsePhotoFilters } from '../render/photo-filters.ts';
import type { Viewer } from '../viewer.ts';

import { useViewerState } from './use-viewer.ts';

/** an opt-in library from an extractor export; no game resources ship with the viewer */
export const PhotoFiltersPanel = ({ viewer }: { viewer: Viewer }) => {
	useViewerState(viewer);
	const id = useId();
	const [error, setError] = useState('');
	const [loading, setLoading] = useState(() => new URL(location.href).searchParams.has('filters'));
	useEffect(() => {
		const path = new URL(location.href).searchParams.get('filters');
		if (path === null) {
			return;
		}
		const abort = new AbortController();
		fetch(path, { signal: abort.signal })
			.then(async (response) => {
				if (!response.ok) {
					throw new Error(`photo filters: HTTP ${response.status}`);
				}
				const library = parsePhotoFilters(await response.json());
				if (!abort.signal.aborted) {
					viewer.setPhotoFilters(library.filters);
				}
			})
			.catch((reason: unknown) => {
				if (!abort.signal.aborted) {
					setError(String(reason));
				}
			})
			.finally(() => {
				if (!abort.signal.aborted) {
					setLoading(false);
				}
			});
		return () => abort.abort();
	}, [viewer]);
	const selected = viewer.photoFilters.find((filter) => filter.id === viewer.options.photoFilter);
	if (!loading && !error && viewer.photoFilters.length === 0) {
		return null;
	}
	return (
		<section className="panel" aria-label="photo filters">
			<h2>photo filters</h2>
			{loading && <p>loading…</p>}
			{error && <p role="alert">{error}</p>}
			{viewer.photoFilters.length > 0 && (
				<>
					<div className="slider">
						<label htmlFor={id}>filter</label>
						<select
							id={id}
							value={viewer.options.photoFilter ?? ''}
							onChange={(event) => {
								try {
									viewer.setOptions({ photoFilter: event.currentTarget.value || null });
									setError('');
								} catch (reason) {
									setError(String(reason));
								}
							}}
						>
							<option value="">none</option>
							{viewer.photoFilters.map((filter) => (
								<option key={filter.id} value={filter.id}>
									{filter.name}
									{filter.unsupported.length ? ' (partial)' : ''}
								</option>
							))}
						</select>
					</div>
					{selected?.lut && (
						<div className="slider">
							<label htmlFor={`${id}-strength`}>LUT contribution</label>
							<input
								id={`${id}-strength`}
								type="range"
								min="0"
								max="1"
								step="0.05"
								value={viewer.options.photoLutStrength}
								onChange={(event) =>
									viewer.setOptions({ photoLutStrength: Number(event.currentTarget.value) })
								}
							/>
							<output>{Math.round(viewer.options.photoLutStrength * 100)}%</output>
						</div>
					)}
					{selected?.unsupported.length ? <p>Not previewed: {selected.unsupported.join(', ')}.</p> : null}
				</>
			)}
		</section>
	);
};

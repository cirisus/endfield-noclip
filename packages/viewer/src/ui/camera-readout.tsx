import type { Viewer } from '../viewer/viewer.ts';

import { useViewerState, useViewerStats } from './use-viewer.ts';

const degrees = (radians: number): string => `${Math.round((radians * 180) / Math.PI)}°`;

/** the camera's Unity-space position, heading, speed and lens settings, plus the controls */
export const CameraReadout = ({ viewer }: { viewer: Viewer }) => {
	useViewerStats(viewer);
	useViewerState(viewer);
	const { position, yaw, pitch, speed } = viewer.stats.camera;
	const [x, y, z] = position.map((v) => v.toFixed(1));
	return (
		<section className="panel camera" aria-label="camera">
			<p>
				<span className="muted">unity</span> x {x} · y {y} · z {z} <span className="muted">yaw</span>{' '}
				{degrees(yaw)} <span className="muted">pitch</span> {degrees(pitch)}{' '}
				<span className="muted">speed</span> {speed.toFixed(0)} m/s · <span className="muted">lens</span>{' '}
				{viewer.camera.focalLength.toFixed(0)} mm · <span className="muted">aperture</span> f/
				{viewer.options.aperture.toFixed(1)}
				{!viewer.options.depthOfField && <span className="muted"> · DoF off</span>}
			</p>
			<p className="muted small">
				click to look · WASD move · E/R up · Q/F/shift down · right mouse boost · tab/alt slow · wheel zoom ·
				ctrl+wheel speed · esc release
			</p>
		</section>
	);
};

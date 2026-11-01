import {
	isCatalog,
	isCompanion,
	OEM_VERSION,
	type Catalog,
	type Companion,
	type Point,
} from '@endfield-noclip/package-format/oem';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { httpSource } from '../package/package-source.ts';
import type { Viewer } from '../viewer.ts';

import type { Launch } from './oem-launch.ts';
import { PointConditions } from './point-conditions.tsx';

/* oxlint-disable react/iframe-missing-sandbox -- trusted cross-origin OEM app needs scripts and a non-opaque messaging origin */

/* oxlint-disable no-await-in-loop -- serialize scene changes so older loads cannot overwrite the newest target */
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);

interface Request {
	point: string;
}
/** existing viewer with an OEM launch bridge and a passive, OEM-owned minimap */
export const OEMPreview = ({
	viewer,
	launch,
	panelRoot,
}: {
	viewer: Viewer;
	launch: Launch;
	panelRoot: HTMLElement | null;
}) => {
	const iframe = useRef<HTMLIFrameElement>(null);
	const [point, setPoint] = useState<Point | null>(null);
	const [metadata, setMetadata] = useState<Companion | null>(null);
	const [preset, setPreset] = useState('');
	const [loading, setLoading] = useState(true);
	const [status, setStatus] = useState('Opening OEM preview…');
	const [, setPose] = useState(0);
	const reply = useCallback(
		(type: string, payload: object = {}) => {
			window.opener?.postMessage(
				{ version: OEM_VERSION, session: launch.session, type, ...payload },
				launch.origin,
			);
		},
		[launch],
	);
	const apply = useCallback(
		(target: Point, presetId?: string) => {
			const chosen =
				target.presets.find((p) => p.id === presetId) ??
				target.presets.find((p) => p.satisfies) ??
				target.presets[0];
			if (!chosen) {
				throw new Error('point has no preview preset');
			}
			viewer.resetSceneValues();
			viewer.setSceneValues(chosen.picks);
			setPreset(chosen.id);
			reply('state', { point: target.id, preset: chosen.id, unknown: target.unknown });
		},
		[viewer, reply],
	);
	const applyLoaded = useEffectEvent((target: Point) => apply(target));
	useEffect(() => {
		const abort = new AbortController();
		let catalog: Catalog | null = null,
			selected: Point | null = null;
		let desired: Request | null = { point: launch.point },
			busy = false,
			loaded = '';
		const companions = new Map<string, Companion>();
		const envelope = (type: string, payload: object = {}) => ({
			version: OEM_VERSION,
			session: launch.session,
			type,
			...payload,
		});
		const minimap = () => {
			const camera = viewer.camera;
			iframe.current?.contentWindow?.postMessage(
				envelope('camera', { point: selected, position: camera.position, forward: camera.forward() }),
				launch.origin,
			);
		};
		const read = async (path: string): Promise<unknown> => {
			const response = await fetch(new URL(path, launch.catalog), { signal: abort.signal });
			if (!response.ok) {
				throw new Error(`OEM data: HTTP ${response.status}`);
			}
			return response.json();
		};
		const drain = async () => {
			if (busy) {
				return;
			}
			busy = true;
			setLoading(true);
			try {
				while (desired && !abort.signal.aborted) {
					const request = desired;
					desired = null;
					try {
						if (!catalog) {
							const value = await read(launch.catalog);
							if (!isCatalog(value) || (launch.release && value.release !== launch.release)) {
								throw new Error('OEM release mismatch');
							}
							catalog = value;
						}
						const partition = catalog.pointIndex[request.point],
							file = catalog.files[partition];
						if (!file) {
							throw new Error('point is not in this OEM release');
						}
						let companion = companions.get(partition);
						if (!companion) {
							const value = await read(file);
							if (!isCompanion(value) || value.release !== catalog.release) {
								throw new Error('OEM companion mismatch');
							}
							companion = value;
							companions.set(partition, companion);
						}
						if (desired || abort.signal.aborted) {
							continue;
						}
						const target = companion.points.find((p) => p.id === request.point),
							pack = target && catalog.packages[target.scene];
						if (!target || !pack) {
							throw new Error('point has no scene package');
						}
						setStatus('Opening scene…');
						const key = `${target.scene}/${pack.generation}`;
						if (loaded !== key || viewer.scene?.pkg.manifest.generation !== pack.generation) {
							await viewer.load(httpSource(new URL(pack.path, launch.catalog).href), target.level, setStatus);
							loaded = key;
						}
						if (desired || abort.signal.aborted) {
							continue;
						}
						const manifest = viewer.scene?.pkg.manifest;
						if (
							!manifest ||
							manifest.generation !== pack.generation ||
							manifest.version !== pack.version ||
							manifest.source.buildGuid !== catalog.source.buildGuid ||
							manifest.source.contentHash !== catalog.source.contentHash ||
							!manifest.levels.some((l) => l.id === target.level && l.instances > 0)
						) {
							loaded = '';
							throw new Error('scene package does not match OEM release');
						}
						if (viewer.level !== target.level) {
							viewer.showLevel(target.level);
						}
						viewer.setCompanion(companion.controls, companion.missions);
						applyLoaded(target);
						selected = target;
						setPoint(target);
						setMetadata(companion);
						viewer.flyToPoint(target.position, 10);
						const url = new URL(location.href);
						url.searchParams.set('point', target.id);
						url.searchParams.set('release', catalog.release);
						history.replaceState(null, '', url);
						setStatus('');
						minimap();
					} catch (error) {
						if (!abort.signal.aborted && !desired) {
							const message = error instanceof Error ? error.message : String(error);
							setStatus(message);
							selected = null;
							setPoint(null);
							reply('error', { message, point: request.point });
						}
					}
				}
			} finally {
				busy = false;
				setLoading(false);
			}
		};
		const receive = (event: MessageEvent<unknown>) => {
			if (event.origin !== launch.origin || !event.data || typeof event.data !== 'object') {
				return;
			}
			const data = event.data;
			if (
				!('version' in data) ||
				data.version !== OEM_VERSION ||
				!('session' in data) ||
				data.session !== launch.session ||
				!('type' in data)
			) {
				return;
			}
			if (event.source === iframe.current?.contentWindow && data.type === 'minimap-ready') {
				minimap();
				return;
			}
			if (event.source !== window.opener || !('point' in data) || typeof data.point !== 'string') {
				return;
			}
			if (data.type === 'open-point') {
				desired = { point: data.point };
				void drain();
			}
		};
		window.addEventListener('message', receive);
		const stop = viewer.subscribeCamera(() => {
			minimap();
			setPose((n) => n + 1);
		});
		reply('ready');
		void drain();
		return () => {
			abort.abort();
			stop();
			window.removeEventListener('message', receive);
		};
	}, [viewer, launch, reply]);
	const map = new URL('/minimap/', launch.origin);
	map.searchParams.set('previewOrigin', location.origin);
	map.searchParams.set('session', launch.session);
	const camera = viewer.camera,
		delta = point?.position.map((v, i) => v - camera.position[i]);
	const depth = delta ? dot(delta, camera.forward()) : 0;
	const aspect = window.innerWidth / window.innerHeight,
		f = 1 / Math.tan(camera.fovY / 2);
	const x = delta && depth > 0 ? 50 + ((dot(delta, camera.right()) * f) / aspect / depth) * 50 : 50;
	const y = delta && depth > 0 ? 50 - ((dot(delta, camera.up()) * f) / depth) * 50 : 95;
	return (
		<>
			{panelRoot &&
				point &&
				metadata &&
				createPortal(
					<PointConditions
						point={point}
						companion={metadata}
						preset={preset}
						disabled={loading}
						onPreset={(id) => apply(point, id)}
					/>,
					panelRoot,
				)}
			<iframe
				ref={iframe}
				className="oem-minimap"
				sandbox="allow-scripts allow-same-origin"
				src={map.href}
				title="OEM minimap"
				tabIndex={-1}
			/>
			{status && <output className="panel oem-status">{status}</output>}
			{point && (
				<div
					className="oem-target"
					style={{ left: `${Math.min(97, Math.max(3, x))}%`, top: `${Math.min(95, Math.max(5, y))}%` }}
					aria-label={`Target ${point.id}`}
				>
					<span>◇</span>
				</div>
			)}
		</>
	);
};

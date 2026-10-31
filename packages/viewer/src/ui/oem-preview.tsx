import {
	isCatalog,
	isCompanion,
	OEM_VERSION,
	type Catalog,
	type Companion,
	type Point,
} from '@endfield-noclip/package-format/oem';

import { useEffect, useRef, useState } from 'react';

import { httpSource } from '../package/package-source.ts';
import type { Viewer } from '../viewer.ts';

import type { Launch } from './oem-launch.ts';

/* oxlint-disable react/iframe-missing-sandbox -- trusted cross-origin OEM app needs scripts and a non-opaque messaging origin */

/* oxlint-disable no-await-in-loop -- serialize scene changes so older loads cannot overwrite the newest target */
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);

interface Request {
	point: string;
	preset?: string;
}
/** existing viewer with an OEM launch bridge and a passive, OEM-owned minimap */
export const OEMPreview = ({ viewer, launch }: { viewer: Viewer; launch: Launch }) => {
	const iframe = useRef<HTMLIFrameElement>(null);
	const [point, setPoint] = useState<Point | null>(null);
	const [status, setStatus] = useState('Opening OEM preview…');
	const [, setPose] = useState(0);
	useEffect(() => {
		const abort = new AbortController();
		let catalog: Catalog | null = null,
			selected: Point | null = null,
			active: Request | null = null;
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
		const reply = (type: string, payload: object = {}) => {
			if (window.opener) {
				window.opener.postMessage(envelope(type, payload), launch.origin);
			}
		};
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
		const apply = (target: Point, presetId?: string) => {
			const preset =
				target.presets.find((p) => p.id === presetId) ??
				target.presets.find((p) => p.satisfies) ??
				target.presets[0];
			if (!preset) {
				throw new Error('point has no preview preset');
			}
			viewer.resetSceneValues();
			viewer.setSceneValues(preset.picks);
			reply('state', { point: target.id, preset: preset.id, unknown: target.unknown });
		};
		const drain = async () => {
			if (busy) {
				return;
			}
			busy = true;
			try {
				while (desired && !abort.signal.aborted) {
					const request = desired;
					desired = null;
					active = request;
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
						apply(target, request.preset);
						selected = target;
						setPoint(target);
						viewer.flyToPoint(target.position, 10);
						const url = new URL(location.href);
						url.searchParams.set('point', target.id);
						url.searchParams.set('release', catalog.release);
						history.replaceState(null, '', url);
						setStatus(
							target.unknown.length
								? 'Known story prerequisites applied; some runtime conditions remain unknown.'
								: '',
						);
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
			if (data.type === 'apply-preset' && 'preset' in data && typeof data.preset === 'string') {
				if (busy) {
					if (active?.point === data.point || desired?.point === data.point) {
						desired = { point: data.point, preset: data.preset };
					}
				} else if (selected?.id === data.point) {
					apply(selected, data.preset);
				}
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
	}, [viewer, launch]);
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

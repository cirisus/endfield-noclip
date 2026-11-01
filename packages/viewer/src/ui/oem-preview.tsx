import {
	isCatalog,
	isCompanion,
	OEM_VERSION,
	type Catalog,
	type Companion,
	type Point,
} from '@endfield-noclip/package-format/oem';
import { completedProgressionPicks } from '@endfield-noclip/package-format/story';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { httpSource } from '../package/package-source.ts';
import type { Viewer } from '../viewer.ts';

import type { Launch } from './oem-launch.ts';
import { PointConditions } from './point-conditions.tsx';
import { TargetMarker } from './target-marker.tsx';

/* oxlint-disable react/iframe-missing-sandbox -- trusted cross-origin OEM app needs scripts and a non-opaque messaging origin */

/* oxlint-disable no-await-in-loop -- serialize scene changes so older loads cannot overwrite the newest target */
type Request = { point: string } | { region: string; subregion: string };
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
	const regions = useRef<HTMLIFrameElement>(null);
	const [point, setPoint] = useState<Point | null>(null);
	const [metadata, setMetadata] = useState<Companion | null>(null);
	const [preset, setPreset] = useState('');
	const [loading, setLoading] = useState(true);
	const [status, setStatus] = useState('Opening OEM preview…');
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
			let id: string, picks: Record<string, number>;
			if (presetId === undefined || presetId === 'completed') {
				id = 'completed';
				picks = completedProgressionPicks(viewer.scene?.pkg.manifest.states.controls ?? []);
			} else {
				const chosen = target.presets.find((p) => p.id === presetId);
				if (!chosen) {
					throw new Error('point has no preview preset');
				}
				id = chosen.id;
				picks = chosen.picks;
			}
			viewer.resetSceneValues();
			viewer.setSceneValues(picks);
			setPreset(id);
			reply('state', { point: target.id, preset: id, unknown: target.unknown });
		},
		[viewer, reply],
	);
	const applyLoaded = useEffectEvent((target: Point) => apply(target));
	useEffect(() => {
		const abort = new AbortController();
		let framing: AbortController | null = null;
		let catalog: Catalog | null = null,
			selected: Point | null = null,
			preparing: Point | null = null;
		let desired: Request | null = launch.point
				? { point: launch.point }
				: { region: launch.region, subregion: launch.subregion },
			busy = false,
			loaded = '';
		const companions = new Map<string, Companion>();
		let pointTarget = true;
		const envelope = (type: string, payload: object = {}) => ({
			version: OEM_VERSION,
			session: launch.session,
			type,
			...payload,
		});
		const minimap = () => {
			if (!selected) {
				if (preparing) {
					iframe.current?.contentWindow?.postMessage(
						envelope('minimap-target', { point: preparing, target: pointTarget }),
						launch.origin,
					);
				}
				return;
			}
			const camera = viewer.camera;
			const ground = viewer.groundHeight;
			iframe.current?.contentWindow?.postMessage(
				envelope('camera', {
					target: pointTarget,
					point: selected,
					position: camera.position,
					forward: camera.forward(),
					view: {
						groundY:
							ground !== null && ground < camera.position[1]
								? ground
								: (selected?.position[1] ?? camera.position[1]),
						fovY: camera.fovY,
						aspect: window.innerWidth / Math.max(1, window.innerHeight),
					},
				}),
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
						const partition = 'point' in request ? catalog.pointIndex[request.point] : request.subregion,
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
						const target = companion.points.find((p) =>
								'point' in request
									? p.id === request.point
									: p.region === request.region && p.subregion === request.subregion,
							),
							pack = target && catalog.packages[target.scene];
						if (!target || !pack) {
							throw new Error('point has no scene package');
						}
						const animate =
							selected !== null &&
							viewer.scene?.pkg.manifest.scene.id === target.scene &&
							viewer.scene.pkg.manifest.generation === pack.generation;
						selected = null;
						pointTarget = 'point' in request;
						preparing = target;
						minimap();
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
						pointTarget = 'point' in request;
						if (pointTarget) {
							setStatus('Finding a clear view…');
							framing = new AbortController();
							await viewer.framePoint(target.position, framing.signal, { baked: target.view, animate });
						} else {
							viewer.flyToLevel(target.level);
						}
						if (desired || abort.signal.aborted) {
							continue;
						}
						selected = target;
						preparing = null;
						setPoint(pointTarget ? target : null);
						setMetadata(companion);
						const url = new URL(location.href);
						url.searchParams.delete('package');
						url.searchParams.delete('level');
						if (pointTarget) {
							url.searchParams.set('point', target.id);
							url.searchParams.delete('region');
							url.searchParams.delete('subregion');
						} else {
							url.searchParams.delete('point');
							url.searchParams.set('region', target.region);
							url.searchParams.set('subregion', target.subregion);
						}
						url.searchParams.set('release', catalog.release);
						history.replaceState(null, '', url);
						setStatus('');
						regions.current?.contentWindow?.postMessage(
							envelope('region-state', { region: target.region, subregion: target.subregion }),
							launch.origin,
						);
						minimap();
					} catch (error) {
						if (!abort.signal.aborted && !desired) {
							const message = error instanceof Error ? error.message : String(error);
							setStatus(message);
							selected = null;
							preparing = null;
							setPoint(null);
							reply('error', { message, point: 'point' in request ? request.point : '' });
							regions.current?.contentWindow?.postMessage(envelope('region-error'), launch.origin);
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
			if (event.source === regions.current?.contentWindow) {
				if (
					data.type === 'overlay-layout' &&
					'rects' in data &&
					Array.isArray(data.rects) &&
					data.rects.length <= 32
				) {
					const rects = data.rects;
					if (
						rects.every(
							(r) =>
								Array.isArray(r) &&
								r.length === 4 &&
								r.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
								r[0] >= 0 &&
								r[1] >= 0 &&
								r[2] <= innerWidth &&
								r[3] <= innerHeight &&
								r[2] > r[0] &&
								r[3] > r[1],
						)
					) {
						const path = rects.map((r) => `M${r[0]} ${r[1]}H${r[2]}V${r[3]}H${r[0]}Z`).join(' ');
						if (regions.current) {
							regions.current.style.clipPath = path ? `path('${path}')` : 'inset(100%)';
						}
					}
					return;
				}

				if (data.type === 'regions-ready' && selected) {
					regions.current?.contentWindow?.postMessage(
						envelope('region-state', { region: selected.region, subregion: selected.subregion }),
						launch.origin,
					);
				} else if (
					data.type === 'open-region' &&
					'region' in data &&
					'subregion' in data &&
					typeof data.region === 'string' &&
					typeof data.subregion === 'string'
				) {
					framing?.abort();
					desired = { region: data.region, subregion: data.subregion };
					void drain();
				}
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
				framing?.abort();
				desired = { point: data.point };
				void drain();
			}
		};
		window.addEventListener('message', receive);
		window.addEventListener('resize', minimap, { signal: abort.signal });
		const stop = viewer.subscribeCamera(() => {
			if (selected) {
				minimap();
			}
		});
		reply('ready');
		void drain();
		return () => {
			abort.abort();
			framing?.abort();
			stop();
			window.removeEventListener('message', receive);
		};
	}, [viewer, launch, reply]);
	const map = new URL('/minimap/', launch.origin);
	map.searchParams.set('previewOrigin', location.origin);
	map.searchParams.set('session', launch.session);
	const regionURL = new URL(map);
	regionURL.pathname = '/minimap/regions.html';
	return (
		<>
			<iframe
				ref={regions}
				className="oem-regions"
				sandbox="allow-scripts allow-same-origin"
				src={regionURL.href}
				title="OEM regions"
			/>
			{panelRoot &&
				point &&
				metadata &&
				createPortal(
					<PointConditions
						viewer={viewer}
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
			{point && <TargetMarker viewer={viewer} point={point} />}
		</>
	);
};

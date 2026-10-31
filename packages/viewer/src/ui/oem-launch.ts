import { isOEMOrigin } from '@endfield-noclip/package-format/oem';

export interface Launch {
	catalog: string;
	release: string;
	point: string;
	origin: string;
	session: string;
}

/** @returns a validated OEM launch, or null for the ordinary standalone viewer */
export const oemLaunch = (): Launch | null => {
	const p = new URL(location.href).searchParams,
		catalog = p.get('oem');
	if (!catalog) {
		return null;
	}
	const url = new URL(catalog, location.href);
	if (
		!(
			url.origin === 'https://cdn.opendfieldmap.org' ||
			(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
		)
	) {
		throw new Error('unrecognized OEM data origin');
	}
	const origin = p.get('origin') ?? 'https://opendfieldmap.org';
	if (!isOEMOrigin(origin) || origin === location.origin) {
		throw new Error('unrecognized OEM map origin');
	}
	return {
		catalog: url.href,
		release: p.get('release') ?? '',
		point: p.get('point') ?? '',
		origin,
		session: p.get('session') ?? '',
	};
};

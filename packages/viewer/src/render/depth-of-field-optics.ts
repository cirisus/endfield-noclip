/** physical lens inputs; all distances are metres except the lens and sensor, which use millimetres */
export interface FocusLens {
	focalLength: number;
	aperture: number;
	focusDistance: number;
	sensorSpan: number;
	/** pixels along the sensor's fitted axis */
	pixels: number;
	near: number;
	far: number;
}

/** signed circle-of-confusion coefficients for a reversed depth buffer */
export interface FocusCoefficients {
	offset: number;
	scale: number;
}

/**
 * converts the physical lens into a signed blur radius in pixels. negative radii are foreground; positive
 * radii are background. keeping the finite-far expression also allows checking the viewer's infinite
 * projection against cameras with a finite far clip.
 *
 * @param lens physical lens and clipping planes; all finite inputs must be positive, far > near
 * @returns coefficients for `offset - scale * reversedDepth`
 * @throws RangeError if the lens or clipping planes cannot represent a physical camera
 */
export const focusCoefficients = (lens: FocusLens): FocusCoefficients => {
	const { focalLength, aperture, focusDistance, sensorSpan, pixels, near, far } = lens;
	for (const value of [focalLength, aperture, focusDistance, sensorSpan, pixels, near]) {
		if (!Number.isFinite(value) || value <= 0) {
			throw new RangeError('focus lens values must be finite and positive');
		}
	}
	if (!(far > near)) {
		throw new RangeError('far clip must be greater than near clip');
	}
	const focalMetres = focalLength / 1000;
	const radius =
		(focalMetres * focalLength * pixels) /
		(2 * aperture * sensorSpan * Math.max(focusDistance - focalMetres, 1e-6));
	const inverseFar = 1 / far;
	return {
		offset: radius * (1 - focusDistance * inverseFar),
		scale: radius * focusDistance * (1 / near - inverseFar),
	};
};

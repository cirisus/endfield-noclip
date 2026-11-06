/**
 * what the viewer shows instead of the lit image, in the order of their `Frame.flags.y` codes: material
 * channels, and `clouds`, the raw cloud panorama in place of the sky
 */
export const DEBUG_VIEWS = ['lit', 'albedo', 'normals', 'roughness', 'ambient', 'clouds'] as const;

export type DebugView = (typeof DEBUG_VIEWS)[number];

/**
 * Compatibility entry for the inspector. Basemap providers live in `src/map/`
 * so the in-drive junction map and the inspector use the same provider list.
 */
export * from '../../src/map/basemap';

/** The inspector exposes the two AMap raster styles; both are GCJ-02. */
export type InspectorBasemap = 'amap-street' | 'amap-satellite';

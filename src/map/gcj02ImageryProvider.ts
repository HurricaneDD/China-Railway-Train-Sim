import { UrlTemplateImageryProvider, WebMercatorTilingScheme } from 'cesium';
import { GCJ02_WARP_MIN_ZOOM, planGcj02Warp, WARP_TILE_SIZE } from './gcj02Warp';

export interface Gcj02ImageryProviderOptions {
  /** AMap tile URL template in GCJ-02, using {s}, {x}, {y}, {z}. */
  urlTemplate: string;
  subdomains: string[];
  minimumLevel: number;
  maximumLevel: number;
  hasAlphaChannel: boolean;
  credit?: string;
}

/**
 * Source images are shared by both the satellite and hybrid-label providers.
 * A bounded cache avoids re-downloading neighbours while moving the camera.
 */
const sourceImageCache = new Map<string, Promise<HTMLImageElement>>();
const MAX_CACHED_SOURCE_TILES = 192;

function loadSourceImage(url: string): Promise<HTMLImageElement> {
  const cached = sourceImageCache.get(url);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => {
      sourceImageCache.delete(url);
      reject(new Error(`高德瓦片加载失败：${url}`));
    };
    image.src = url;
  });
  sourceImageCache.set(url, pending);
  if (sourceImageCache.size > MAX_CACHED_SOURCE_TILES) {
    const oldest = sourceImageCache.keys().next().value;
    if (oldest !== undefined) sourceImageCache.delete(oldest);
  }
  return pending;
}

function buildSourceUrl(template: string, subdomains: string[], x: number, y: number, zoom: number): string {
  const subdomain = subdomains.length ? subdomains[(x + y) % subdomains.length] : '';
  return template
    .replace('{s}', subdomain)
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{z}', String(zoom));
}

async function warpTile(template: string, subdomains: string[], x: number, y: number, zoom: number): Promise<HTMLImageElement | HTMLCanvasElement> {
  // At country/province zoom the GCJ-02 offset is only one or two pixels and
  // cannot be seen. Fetching the matching source tile directly avoids loading
  // several neighbours for every low-zoom output tile.
  if (zoom < GCJ02_WARP_MIN_ZOOM) {
    return loadSourceImage(buildSourceUrl(template, subdomains, x, y, zoom));
  }
  const plan = planGcj02Warp(x, y, zoom);
  const images = await Promise.all(plan.sourceTiles.map((tile) =>
    loadSourceImage(buildSourceUrl(template, subdomains, tile.x, tile.y, zoom)),
  ));

  const source = document.createElement('canvas');
  source.width = plan.sourceWidth;
  source.height = plan.sourceHeight;
  const sourceContext = source.getContext('2d');
  if (!sourceContext) throw new Error('浏览器不支持 2D Canvas，无法配准高德瓦片');
  plan.sourceTiles.forEach((tile, index) => {
    sourceContext.drawImage(
      images[index],
      (tile.x - plan.originX) * WARP_TILE_SIZE,
      (tile.y - plan.originY) * WARP_TILE_SIZE,
      WARP_TILE_SIZE,
      WARP_TILE_SIZE,
    );
  });

  const output = document.createElement('canvas');
  output.width = WARP_TILE_SIZE;
  output.height = WARP_TILE_SIZE;
  const context = output.getContext('2d');
  if (!context) throw new Error('浏览器不支持 2D Canvas，无法配准高德瓦片');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, plan.offsetX, plan.offsetY);
  return output;
}

/**
 * Build a normal Web Mercator imagery provider whose images are AMap GCJ-02
 * tiles locally warped into the WGS84 tile grid. Cesium sees only a standard
 * WGS84 tiling scheme, so the globe/terrain path stays the tested default one.
 * All source images are read with CORS and never leave the browser.
 */
export function createGcj02ImageryProvider(options: Gcj02ImageryProviderOptions): UrlTemplateImageryProvider {
  const base = new UrlTemplateImageryProvider({
    url: options.urlTemplate,
    tilingScheme: new WebMercatorTilingScheme(),
    minimumLevel: options.minimumLevel,
    maximumLevel: options.maximumLevel,
    tileWidth: WARP_TILE_SIZE,
    tileHeight: WARP_TILE_SIZE,
    subdomains: options.subdomains,
    hasAlphaChannel: options.hasAlphaChannel,
    credit: options.credit,
    enablePickFeatures: false,
  });
  // Inherit every provider property from a real UrlTemplateImageryProvider, but
  // replace image request with the local GCJ-02 → WGS84 warp.
  const provider = Object.create(base) as UrlTemplateImageryProvider;
  provider.requestImage = (x: number, y: number, level: number) =>
    warpTile(options.urlTemplate, options.subdomains, x, y, level);
  return provider;
}

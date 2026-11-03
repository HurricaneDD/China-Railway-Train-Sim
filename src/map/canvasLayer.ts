import type { BasemapProvider } from './basemap';
import type { MapView } from './junctionMap';
import { metresPerWorldUnit, tileZoomForScale } from '../utils/mercator';

/**
 * Shared canvas layers for the 2D Web Mercator view in the junction prompt.
 * Railway geometry stays WGS84; the raster tiles
 * are standard EPSG:3857 and are only a visual reference.
 */

export type TileStatus = 'loading' | 'ready' | 'error';

interface TileEntry {
  image: HTMLImageElement;
  state: TileStatus;
}

export class BasemapTiles {
  private cache = new Map<string, TileEntry>();

  /** Draw available tiles and report whether the visible set is ready or failed. */
  draw(ctx: CanvasRenderingContext2D, view: MapView, width: number, height: number, provider: BasemapProvider, onTile: () => void): TileStatus {
    const zoom = tileZoomForScale(view.scale, provider.minZoom, provider.maxZoom);
    const tilesPerSide = 2 ** zoom;
    const tileWorld = 1 / tilesPerSide;
    const tileScreen = tileWorld * view.scale;
    const left = view.cx - (width / 2) / view.scale;
    const right = view.cx + (width / 2) / view.scale;
    const top = view.cy - (height / 2) / view.scale;
    const bottom = view.cy + (height / 2) / view.scale;
    const firstX = Math.max(0, Math.floor(left / tileWorld));
    const lastX = Math.min(tilesPerSide - 1, Math.ceil(right / tileWorld) - 1);
    const firstY = Math.max(0, Math.floor(top / tileWorld));
    const lastY = Math.min(tilesPerSide - 1, Math.ceil(bottom / tileWorld) - 1);
    let ready = 0;
    let failed = 0;

    for (let y = firstY; y <= lastY; y++) {
      for (let x = firstX; x <= lastX; x++) {
        const key = `${provider.id}/${zoom}/${x}/${y}`;
        let entry = this.cache.get(key);
        if (!entry) {
          const image = new Image();
          const created: TileEntry = { image, state: 'loading' };
          entry = created;
          this.cache.set(key, created);
          image.decoding = 'async';
          image.crossOrigin = 'anonymous';
          image.onload = () => {
            created.state = 'ready';
            onTile();
          };
          image.onerror = () => {
            created.state = 'error';
            onTile();
          };
          image.src = provider.tileUrl(zoom, x, y);
        }
        if (entry.state === 'ready') ready++;
        else if (entry.state === 'error') failed++;
        if (entry.state !== 'ready') continue;
        const sx = width / 2 + (x * tileWorld - view.cx) * view.scale;
        const sy = height / 2 + (y * tileWorld - view.cy) * view.scale;
        ctx.drawImage(entry.image, sx, sy, tileScreen + 0.8, tileScreen + 0.8);
      }
    }

    if (this.cache.size > 480) {
      for (const [key, entry] of this.cache) {
        if (entry.state !== 'loading') this.cache.delete(key);
        if (this.cache.size <= 360) break;
      }
    }
    return ready > 0 ? 'ready' : failed > 0 ? 'error' : 'loading';
  }
}

export function drawMapBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#101812');
  gradient.addColorStop(0.55, '#0b120d');
  gradient.addColorStop(1, '#111b13');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(216, 255, 98, .045)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 54) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 54) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
  }
}

export function drawNorthArrow(ctx: CanvasRenderingContext2D, x = 20, y = 22): void {
  ctx.save();
  ctx.fillStyle = 'rgba(8, 14, 9, .78)';
  ctx.fillRect(10, 10, 34, 42);
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1;
  ctx.strokeRect(10.5, 10.5, 33, 41);
  ctx.beginPath();
  ctx.moveTo(x, y - 7);
  ctx.lineTo(x + 5, y + 9);
  ctx.lineTo(x, y + 5);
  ctx.lineTo(x - 5, y + 9);
  ctx.closePath();
  ctx.fillStyle = '#eef6e7';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - 7);
  ctx.lineTo(x, y + 5);
  ctx.strokeStyle = '#d8ff62';
  ctx.stroke();
  ctx.fillStyle = '#d8ff62';
  ctx.font = '700 9px "Barlow Condensed", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', x, 40);
  ctx.restore();
}

export function drawScaleBar(ctx: CanvasRenderingContext2D, view: MapView, width: number, height: number, latitude: number): void {
  const metresPerPixel = metresPerWorldUnit(latitude) / view.scale;
  const choices = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const target = metresPerPixel * 120;
  const metres = choices.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best, choices[0]);
  const pixels = metres / metresPerPixel;
  const x = 18;
  const y = height - 20;
  ctx.save();
  ctx.fillStyle = 'rgba(8, 14, 9, .82)';
  ctx.fillRect(x - 6, y - 28, pixels + 22, 29);
  ctx.strokeStyle = '#d8ff62';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + pixels, y);
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 4);
  ctx.moveTo(x + pixels, y - 5);
  ctx.lineTo(x + pixels, y + 4);
  ctx.stroke();
  ctx.fillStyle = '#e5eddf';
  ctx.font = '9px "Barlow Condensed", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, x, y - 9);
  ctx.restore();
}

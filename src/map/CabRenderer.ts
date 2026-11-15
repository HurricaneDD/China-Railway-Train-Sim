import { Cartesian3, Material, MaterialAppearance, Matrix3, Matrix4, PerInstanceColorAppearance, Primitive, type Viewer } from 'cesium';
import type { TrainState } from '../types';
import { CAB_LAYOUT, cabDisplayGeometry, cabLeverGeometry, cabShellGeometry } from './cabGeometry';

/** A train-local cockpit in the same Cesium scene as the railway; no second WebGL engine. */
export class CabRenderer {
  private shell: Primitive;
  private lever: Primitive;
  private displays: Primitive;
  private material: Material;
  private canvases = [document.createElement('canvas'), document.createElement('canvas')];
  private canvasIndex = 0;
  private lastDisplay = -Infinity;
  private localLever = new Matrix4();
  private leverWorld = new Matrix4();

  constructor(private viewer: Viewer) {
    this.canvases.forEach(canvas => { canvas.width = 768; canvas.height = 192; });
    this.material = new Material({ fabric: {
      type: 'RailCabDisplay', uniforms: { image: this.canvases[0] },
      source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
        czm_material result = czm_getDefaultMaterial(materialInput);
        result.diffuse = vec3(0.0);
        result.emission = texture(image, materialInput.st).rgb;
        result.alpha = 1.0;
        return result;
      }`,
    }, translucent: false });
    const bodyAppearance = () => new PerInstanceColorAppearance({ flat: false, translucent: false, closed: true });
    this.shell = viewer.scene.primitives.add(new Primitive({ geometryInstances: cabShellGeometry(), appearance: bodyAppearance(), asynchronous: false, allowPicking: false, show: false }));
    this.lever = viewer.scene.primitives.add(new Primitive({ geometryInstances: cabLeverGeometry(), appearance: bodyAppearance(), asynchronous: false, allowPicking: false, show: false }));
    this.displays = viewer.scene.primitives.add(new Primitive({ geometryInstances: cabDisplayGeometry(),
      appearance: new MaterialAppearance({ material: this.material, materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
        flat: true, faceForward: true, translucent: false, closed: false }),
      asynchronous: false, allowPicking: false, show: false }));
  }

  update(frame: Matrix4, train: TrainState, elapsed: number, now: number): void {
    this.shell.modelMatrix = frame;
    this.displays.modelMatrix = frame;
    const notch = train.brakeCommand > 1 ? -train.brakeCommand / 100 : train.throttle / 100;
    Matrix4.fromRotationTranslation(Matrix3.fromRotationX(notch * .38), new Cartesian3(...CAB_LAYOUT.leverPivot), this.localLever);
    Matrix4.multiply(frame, this.localLever, this.leverWorld);
    this.lever.modelMatrix = this.leverWorld;
    this.shell.show = this.displays.show = this.lever.show = true;
    if (now - this.lastDisplay >= 100) {
      this.lastDisplay = now;
      this.drawInstruments(train, elapsed);
    }
  }

  hide(): void { this.shell.show = this.lever.show = this.displays.show = false; }

  destroy(): void {
    [this.shell, this.lever, this.displays].forEach(primitive => this.viewer.scene.primitives.remove(primitive));
    if (!this.material.isDestroyed()) this.material.destroy();
    this.canvases.forEach(canvas => { canvas.width = canvas.height = 1; });
  }

  private drawInstruments(train: TrainState, elapsed: number): void {
    const canvas = this.canvases[this.canvasIndex = 1 - this.canvasIndex];
    const ctx = canvas.getContext('2d')!;
    const speed = Math.abs(train.velocity * 3.6);
    ctx.fillStyle = '#071b24'; ctx.fillRect(0, 0, 768, 192);
    ctx.strokeStyle = '#365662'; ctx.lineWidth = 2;
    for (const x of [0, 256, 512]) ctx.strokeRect(x + 2, 2, 252, 188);
    ctx.textAlign = 'left'; ctx.fillStyle = '#81aaa9'; ctx.font = '14px sans-serif';
    ctx.fillText('运行速度  /  km/h', 17, 26); ctx.fillText('牵引 · 制动', 272, 26);
    ctx.fillStyle = '#dcf4df'; ctx.font = 'bold 76px monospace'; ctx.fillText(speed.toFixed(0).padStart(3, '0'), 17, 111);
    ctx.fillStyle = '#8eafba'; ctx.font = '16px sans-serif';
    ctx.fillText(`${train.reverser > 0 ? '前进' : train.reverser < 0 ? '后退' : '中立'}    ${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, '0')}`, 17, 157);
    const bar = (name: string, value: number, y: number, color: string) => {
      ctx.fillStyle = '#c4d4d8'; ctx.font = '16px sans-serif'; ctx.fillText(`${name}  ${Math.round(value)}%`, 272, y);
      ctx.fillStyle = '#1b3942'; ctx.fillRect(272, y + 10, 220, 13);
      ctx.fillStyle = color; ctx.fillRect(272, y + 10, 220 * value / 100, 13);
    };
    bar('牵引', train.throttle, 58, '#9fc9a2'); bar('制动', train.brakeActual, 112, '#d7a476');
    ctx.fillStyle = '#b2c8cd'; ctx.font = '14px sans-serif'; ctx.fillText(`列车管  ${Math.round(train.brakePipe)} kPa`, 272, 173);
    // Round dial with a real speed needle, no invented permitted-speed marker.
    const cx = 640, cy = 99, radius = 75;
    ctx.fillStyle = '#0b1219'; ctx.beginPath(); ctx.arc(cx, cy, radius + 5, 0, Math.PI * 2); ctx.fill();
    for (let tick = 0; tick <= 12; tick++) {
      const angle = Math.PI * (.75 + tick / 12 * 1.5);
      ctx.strokeStyle = '#9dabb2'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * (radius - 9), cy + Math.sin(angle) * (radius - 9));
      ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius); ctx.stroke();
    }
    const angle = Math.PI * (.75 + Math.min(240, speed) / 240 * 1.5);
    ctx.strokeStyle = '#d5f1bd'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * 60, cy + Math.sin(angle) * 60); ctx.stroke();
    ctx.fillStyle = '#c4d7d7'; ctx.textAlign = 'center'; ctx.font = '18px monospace'; ctx.fillText(speed.toFixed(0), cx, cy + 37);
    this.material.uniforms.image = canvas;
  }
}

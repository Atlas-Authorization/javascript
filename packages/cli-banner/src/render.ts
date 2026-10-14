/**
 * The software renderer: geometry → rotate → project → z-buffer → shade.
 *
 * ── WHY ASCII AND NOT BLOCKS ─────────────────────────────────────────
 * A luminance ramp (` ` through `@`) reads as a drawing: each character is a
 * brightness sample, so the shape emerges from shading the way a pencil sketch
 * does. Half-block characters would double the resolution but look like a
 * low-res image, and the point here is a *lit* mark, not a thumbnail.
 *
 * ── THE Z-BUFFER IS NOT OPTIONAL ─────────────────────────────────────
 * The diamond stands in front of the tile and a dark dot in front of the
 * diamond. Without per-pixel depth, draw order would decide what shows and it
 * would flip as the mark turns. Every face is drawn (no back-face culling — the
 * solid is small and closed, so nearest-wins is both correct and simpler than
 * getting winding right) and the nearest fragment per cell wins.
 */

import { MARK, VIOLET, CYAN, WHITE, DARK, type Vec3, type Material } from './geometry';

/** Character grid. Cells are ~2:1 tall, so X is stretched to compensate. */
export const COLS = 64;
export const ROWS = 20;
const CELL_ASPECT = 2;

/**
 * Dark → bright. Spaced so the steps look even by INK rather than by ASCII
 * value: a ramp that jumps from `-` to `#` bands visibly on the tile's large
 * flat faces, which is exactly where banding would be noticed.
 */
const RAMP = ' .,:;irsXA253hMHGS#9B&@';

const CAMERA_Z = 6.6;
/**
 * Focal length in cells. Sized so the 3.0-unit tile fills roughly 14 of the 20
 * rows with a margin: rows ≈ TILE × SCALE / CAMERA_Z.
 */
const SCALE = 31;

function rotateYX(v: Vec3, ay: number, ax: number): Vec3 {
  const [x0, y0, z0] = v;
  const x1 = x0 * Math.cos(ay) - z0 * Math.sin(ay);
  const z1 = x0 * Math.sin(ay) + z0 * Math.cos(ay);
  const y2 = y0 * Math.cos(ax) - z1 * Math.sin(ax);
  const z2 = y0 * Math.sin(ax) + z1 * Math.cos(ax);
  return [x1, y2, z2];
}

/**
 * Perspective projection into cell space. Third value is 1/z, for the buffer.
 *
 * The camera sits on +Z looking toward the origin, so distance is
 * `CAMERA_Z − z`: a vertex with a LARGER z is nearer. That is what puts the
 * proud diamond (and the dot proud of it) in front of the tile rather than
 * behind it — getting this sign wrong hides the whole mark behind its own
 * backing slab.
 */
function project(v: Vec3): [number, number, number] {
  const z = CAMERA_Z - v[2];
  const f = SCALE / z;
  return [COLS / 2 + v[0] * f * CELL_ASPECT, ROWS / 2 - v[1] * f, 1 / z];
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Key light: above, in front, a little to the left. */
const LIGHT = normalize([-0.4, 0.6, 0.7]);

export interface Cell {
  lum: number;
  mat: Material;
  /** Interpolated gradient coordinate (tile only). */
  g: number;
}

/**
 * Rasterize one frame to a cell grid.
 *
 * For each triangle: rotate it, take the face normal (rotated, so lighting
 * tracks the spin), project the vertices, then walk the bounding box using
 * barycentric coordinates to test containment and interpolate 1/z and the
 * gradient coordinate. Nearest fragment per cell is kept.
 */
export function render(ay: number, ax: number): Array<Cell | null> {
  const cells: Array<Cell | null> = new Array(COLS * ROWS).fill(null);
  const depth = new Float64Array(COLS * ROWS).fill(-Infinity);

  for (const tri of MARK) {
    const a = rotateYX(tri.a, ay, ax);
    const b = rotateYX(tri.b, ay, ax);
    const c = rotateYX(tri.c, ay, ax);

    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = normalize([
      u[1] * w[2] - u[2] * w[1],
      u[2] * w[0] - u[0] * w[2],
      u[0] * w[1] - u[1] * w[0],
    ]);

    const pa = project(a);
    const pb = project(b);
    const pc = project(c);

    const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
    if (area === 0) continue;

    // Lambert against the key light, lifted off zero so a face turned away from
    // the light is a dark SURFACE rather than a hole. A tight specular term
    // adds a highlight that moves as the mark turns — flat boxes have few
    // distinct normals, and the moving highlight is what makes them look hard
    // rather than painted. The light faces both ways (abs) so a face's lit side
    // shows whichever way it is turned toward the camera.
    const lambert = Math.abs(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    const half = normalize([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
    const spec = Math.pow(Math.abs(n[0] * half[0] + n[1] * half[1] + n[2] * half[2]), 20);
    // The white diamond is the hero glyph, so give it a little more light than
    // the tile behind it — this keeps it reading as the brighter element even
    // in NO_COLOR, where it cannot be told apart by hue.
    const matGain = tri.mat === 'diamond' ? 1.14 : 1;
    const faceLum = (0.18 + lambert * 0.7 + spec * 0.45) * matGain;

    const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
    const maxX = Math.min(COLS - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
    const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
    const maxY = Math.min(ROWS - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const cx = x + 0.5;
        const cy = y + 0.5;

        // Barycentric weights (w.r.t. the signed area).
        const l0 = ((pb[0] - cx) * (pc[1] - cy) - (pc[0] - cx) * (pb[1] - cy)) / area;
        const l1 = ((pc[0] - cx) * (pa[1] - cy) - (pa[0] - cx) * (pc[1] - cy)) / area;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;

        const invZ = l0 * pa[2] + l1 * pb[2] + l2 * pc[2];
        const idx = y * COLS + x;
        if (invZ <= depth[idx]!) continue;
        depth[idx] = invZ;

        // Depth falloff per pixel: nearer is brighter. This turns each flat
        // face's single normal into a continuous gradient for the ramp to
        // resolve, so the mark reads as a lit solid rather than papercraft.
        const z = 1 / invZ;
        const near = CAMERA_Z - 2.0;
        const far = CAMERA_Z + 2.0;
        const depthTerm = 1.3 - 0.62 * ((z - near) / (far - near));
        const lum = Math.max(0.06, Math.min(1, faceLum * depthTerm));

        const g = l0 * tri.ga + l1 * tri.gb + l2 * tri.gc;
        cells[idx] = { lum, mat: tri.mat, g };
      }
    }
  }

  return cells;
}

const ESC = '\u001b';
const RESET = `${ESC}[0m`;

function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The truecolor escape for a cell: material colour, lifted a little by brightness. */
function tint(cell: Cell): string {
  let base: Vec3;
  if (cell.mat === 'tile') base = mix(VIOLET, CYAN, cell.g);
  else if (cell.mat === 'diamond') base = WHITE;
  else base = DARK;

  // The character already carries most of the brightness; colour is lifted only
  // enough to stay legible, so the tint does not fight the ramp. The dot stays
  // dark whichever way it is lit — it is a hole in the logo, not a surface.
  const k = cell.mat === 'dot' ? 0.6 + cell.lum * 0.15 : 0.5 + cell.lum * 0.5;
  return `${ESC}[38;2;${Math.round(base[0] * k)};${Math.round(base[1] * k)};${Math.round(base[2] * k)}m`;
}

/** Render one frame to a string (no trailing cursor control). */
export function frame(ay: number, ax = 0.34, colour = true): string {
  const cells = render(ay, ax);
  const lines: string[] = [];

  for (let y = 0; y < ROWS; y += 1) {
    let line = '';
    let active = '';

    for (let x = 0; x < COLS; x += 1) {
      const cell = cells[y * COLS + x];
      if (!cell) {
        if (active) {
          line += RESET;
          active = '';
        }
        line += ' ';
        continue;
      }

      // The dot is dark but solid, so keep it off the lowest ramp steps or it
      // reads as empty space; everything else maps straight from luminance.
      const floor = cell.mat === 'dot' ? 3 : 1;
      const ch =
        RAMP[Math.max(floor, Math.min(RAMP.length - 1, Math.round(cell.lum * (RAMP.length - 1))))]!;

      if (colour) {
        const t = tint(cell);
        if (t !== active) {
          line += t;
          active = t;
        }
      }
      line += ch;
    }

    if (active) line += RESET;
    lines.push(line.replace(/\s+$/, ''));
  }

  return lines.join('\n');
}

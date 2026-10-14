/**
 * The Atlas mark as real 3D geometry.
 *
 * Straight from favicon.svg: a rounded tile carrying a violet→cyan gradient, a
 * white vertical diamond standing proud of it, and a dark dot at the diamond's
 * centre. We model those as actual solids — a slab, an extruded diamond, and a
 * small cube — so that lighting and occlusion are computed as the mark turns
 * rather than faked. A static picture of this would just be a logo; the way the
 * shading slides across the faces as it rotates is what sells the depth.
 *
 * The three colours are materials, not per-face constants: the tile's gradient
 * is interpolated per pixel from a coordinate baked onto each vertex here, so
 * the diagonal violet→cyan sweep survives rotation and projection.
 */

export type Vec3 = [number, number, number];
export type Material = 'tile' | 'diamond' | 'dot';

export interface Tri {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  /** Gradient coordinate (0 = violet, 1 = cyan) at each vertex. Tile only. */
  ga: number;
  gb: number;
  gc: number;
  mat: Material;
}

/** favicon.svg colours. */
export const VIOLET: Vec3 = [110, 92, 255]; // #6E5CFF
export const CYAN: Vec3 = [70, 199, 255]; // #46C7FF
export const WHITE: Vec3 = [238, 238, 245];
export const DARK: Vec3 = [12, 12, 22]; // #0a0a12

// ── Dimensions ────────────────────────────────────────────────────────────
// The SVG tile is 32×32 with the diamond spanning x 11..21 (width 10) and
// y 7..25 (height 18) — so the diamond is ~1.8× taller than wide. Those ratios
// are preserved here; the absolute scale is arbitrary (SCALE in render.ts sizes
// it to the character grid).
const TILE = 3.0;
const TILE_DEPTH = 0.42;
const DIAMOND_HALF_W = 0.7;
const DIAMOND_HALF_H = 1.26; // 1.8 × half-width, matching the SVG
// Proud enough that per-pixel depth shading lifts the diamond clearly off the
// tile — at a near-front rest pose the two front faces are nearly coplanar, so
// the standing height is what separates them.
const DIAMOND_DEPTH = 0.46;
const DOT = 0.46;

const FRONT = TILE_DEPTH / 2; // tile's front face plane

/**
 * Extrude a convex polygon (given as tile-plane points) between two Z planes
 * into a closed prism: a front cap, a back cap, and one quad per edge. Winding
 * is not relied upon — the renderer draws every face and lets the z-buffer pick
 * the nearest, so a closed solid comes out right without careful ordering.
 */
function extrude(
  poly: Array<[number, number]>,
  zBack: number,
  zFront: number,
  mat: Material,
  grad: (x: number, y: number) => number,
): Tri[] {
  const front: Vec3[] = poly.map(([x, y]) => [x, y, zFront]);
  const back: Vec3[] = poly.map(([x, y]) => [x, y, zBack]);
  const g: number[] = poly.map(([x, y]) => grad(x, y));
  const n = poly.length;
  const tris: Tri[] = [];

  const tri = (a: Vec3, b: Vec3, c: Vec3, ga: number, gb: number, gc: number) =>
    tris.push({ a, b, c, ga, gb, gc, mat });

  // Front and back caps (fan from vertex 0).
  for (let i = 1; i < n - 1; i += 1) {
    tri(front[0]!, front[i]!, front[i + 1]!, g[0]!, g[i]!, g[i + 1]!);
    tri(back[0]!, back[i + 1]!, back[i]!, g[0]!, g[i + 1]!, g[i]!);
  }
  // Side walls.
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    tri(front[i]!, back[i]!, back[j]!, g[i]!, g[i]!, g[j]!);
    tri(front[i]!, back[j]!, front[j]!, g[i]!, g[j]!, g[j]!);
  }
  return tris;
}

/**
 * The gradient coordinate for a tile-plane point.
 *
 * The SVG gradient runs top-left → bottom-right (violet → cyan). In world space
 * Y is up, so top-left is (−x, +y) and bottom-right is (+x, −y); the coordinate
 * is therefore along the (1, −1) direction, normalised to 0..1 across the tile.
 */
function tileGradient(x: number, y: number): number {
  const half = TILE / 2;
  const t = (x - y) / (4 * half) + 0.5;
  return Math.max(0, Math.min(1, t));
}

/** The whole mark, built once. */
export const MARK: Tri[] = (() => {
  const h = TILE / 2;

  const tile = extrude(
    [
      [-h, h],
      [h, h],
      [h, -h],
      [-h, -h],
    ],
    -FRONT,
    FRONT,
    'tile',
    tileGradient,
  );

  const diamond = extrude(
    [
      [0, DIAMOND_HALF_H],
      [DIAMOND_HALF_W, 0],
      [0, -DIAMOND_HALF_H],
      [-DIAMOND_HALF_W, 0],
    ],
    FRONT,
    FRONT + DIAMOND_DEPTH,
    'diamond',
    () => 0,
  );

  const d = DOT / 2;
  const dotFront = FRONT + DIAMOND_DEPTH + 0.1;
  const dot = extrude(
    [
      [-d, d],
      [d, d],
      [d, -d],
      [-d, -d],
    ],
    FRONT + DIAMOND_DEPTH - 0.02,
    dotFront,
    'dot',
    () => 0,
  );

  return [...tile, ...diamond, ...dot];
})();

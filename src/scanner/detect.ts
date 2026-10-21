/**
 * Card detection, the way document-scanner apps do it:
 *   1. find the card's four corners anywhere in the picture  (findCard)
 *   2. "flatten" it: stretch those corners into a straight, upright rectangle  (flattenCard)
 *
 * This uses OpenCV, a computer-vision library. It's big (~10 MB), so it's only
 * downloaded the first time it's needed, not when the page opens.
 */
import type * as OpenCv from '@techstark/opencv-js';
// `?url` makes Vite copy opencv.js into the build and give us its address,
// without bundling it (see loadOpenCv for why)
import openCvUrl from '@techstark/opencv-js/dist/opencv.js?url';
import { CARD_ASPECT } from './camera';

type CV = typeof OpenCv;
type Mat = OpenCv.Mat;

export interface Point {
  x: number;
  y: number;
}

// The card's corners in picture pixels, always in this order:
// top-left, top-right, bottom-right, bottom-left
export type Quad = [Point, Point, Point, Point];

// Size of the flattened card (same 63 × 88 shape as a real card)
export const FLAT_WIDTH = 1000;
export const FLAT_HEIGHT = Math.round(FLAT_WIDTH / CARD_ASPECT);

// Edge detection runs on a shrunken copy of the picture: much faster,
// and the card's outline is still easy to see at this size
const DETECT_SIZE = 640;

// ---------------------------------------------------------------------------
// Loading OpenCV
// ---------------------------------------------------------------------------

// The OpenCV object has a .then() method of its own, so JavaScript treats it like
// a promise. Handing it straight back from a promise (which `import()` would do)
// makes the browser try to "resolve" it forever and freezes the page.
// So we load it with a plain <script> tag, which puts it on window.cv, and always
// pass it around wrapped in { cv }, never on its own.
let cvPromise: Promise<{ cv: CV }> | null = null;

export function loadOpenCv(): Promise<{ cv: CV }> {
  cvPromise ??= (async () => {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = openCvUrl;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Couldn't load the card detector"));
      document.head.append(script);
    });
    const win = window as unknown as { cv?: CV };
    // window.cv exists straight away, but its functions only appear once its
    // WebAssembly code has started (a second or two). Check until cv.Mat is there.
    while (!win.cv || !('Mat' in win.cv)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { cv: win.cv };
  })();
  // If loading failed, let the next call try again instead of failing forever
  cvPromise.catch(() => {
    cvPromise = null;
  });
  return cvPromise;
}

// ---------------------------------------------------------------------------
// Finding the card
// ---------------------------------------------------------------------------

// Put four points in top-left, top-right, bottom-right, bottom-left order.
// Top-left has the smallest x + y, bottom-right the largest;
// top-right has the smallest y − x, bottom-left the largest.
function orderCorners(points: Point[]): Quad {
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Does this shape look like a card? Its short side should be roughly 63/88 of
// its long side. The range is wide because a card held at an angle looks squashed.
function hasCardShape([tl, tr, br, bl]: Quad): boolean {
  const width = (distance(tl, tr) + distance(bl, br)) / 2;
  const height = (distance(tl, bl) + distance(tr, br)) / 2;
  const ratio = Math.min(width, height) / Math.max(width, height);
  return ratio > 0.5 && ratio < 0.95;
}

// Read a contour's points out of OpenCV's flat [x0, y0, x1, y1, ...] array
function contourPoints(contour: Mat): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < contour.data32S.length; i += 2) {
    points.push({ x: contour.data32S[i], y: contour.data32S[i + 1] });
  }
  return points;
}

/**
 * Find the card's corners in a picture, or null if no card-shaped outline was found.
 * The corners are in the picture's own pixels.
 */
export async function findCard(picture: HTMLCanvasElement): Promise<Quad | null> {
  const { cv } = await loadOpenCv();
  const scale = Math.min(1, DETECT_SIZE / Math.max(picture.width, picture.height));

  // OpenCV images ("Mats") live in WebAssembly memory and must be freed by hand
  const src = cv.imread(picture);
  const small = new cv.Mat();
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const rawEdges = new cv.Mat();

  try {
    // Shrink, go greyscale and blur slightly so card artwork and table texture
    // don't produce lots of tiny edges
    cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    // Find edges (sharp changes in brightness). A copy is kept as-is for scoring;
    // the other is thickened a little so small gaps in the card's outline get closed
    cv.Canny(gray, edges, 40, 120);
    edges.copyTo(rawEdges);
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);

    // Outer outlines only: we want the card's border, not the shapes printed on it
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // Card-shaped candidates from two methods:
    //   - outlines: works when the card stands clear of its surroundings
    //   - straight edges: works when a finger or another object touches the card
    //     and merges into its outline
    const candidates: Quad[] = [];
    const minArea = small.cols * small.rows * 0.08;
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area >= minArea) {
        // Simplify the outline; a card should come out as 4 corners
        const approx = new cv.Mat();
        cv.approxPolyDP(contour, approx, 0.02 * cv.arcLength(contour, true), true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          candidates.push(orderCorners(contourPoints(approx)));
        } else {
          // Rounded or slightly broken outline: also try the tightest rotated rectangle
          // around it, as long as the outline mostly fills that rectangle
          const rect = cv.minAreaRect(contour);
          if (area / (rect.size.width * rect.size.height) > 0.85) candidates.push(orderCorners(cv.RotatedRect.points(rect)));
        }
        approx.delete();
      }
      contour.delete();
    }
    candidates.push(...cardsFromLines(cv, rawEdges));

    // Keep the candidate whose sides best follow real edges in the picture
    let best: { quad: Quad; score: number } | null = null;
    for (const quad of candidates) {
      const score = scoreQuad(rawEdges, quad);
      if (score !== null && (!best || score > best.score)) best = { quad, score };
    }

    // Scale the corners back up to the full-size picture
    return best ? (best.quad.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad) : null;
  } finally {
    [src, small, gray, edges, rawEdges, kernel, contours, hierarchy].forEach((mat) => mat.delete());
  }
}

// ---------------------------------------------------------------------------
// Scoring a candidate
// ---------------------------------------------------------------------------

/**
 * How likely a candidate is the card: higher is better, null = not a card.
 * The card's four sides should run along real edges in the picture. A finger
 * may cover part of a side, but every side must be at least partly visible.
 * Bigger shapes win ties, so the card beats the artwork box printed inside it.
 */
function quadArea([tl, tr, br, bl]: Quad): number {
  return ((distance(tl, tr) + distance(bl, br)) * (distance(tl, bl) + distance(tr, br))) / 4;
}

function scoreQuad(edges: Mat, quad: Quad): number | null {
  const width = edges.cols;
  const height = edges.rows;
  if (!hasCardShape(quad)) return null;
  const [tl, tr, br, bl] = quad;
  const area = quadArea(quad);
  if (area < width * height * 0.08) return null;

  // Fraction of the line from a to b that has an edge pixel within 2 pixels
  const edgeAt = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && edges.data[Math.round(y) * width + Math.round(x)] > 0;
  const support = (a: Point, b: Point): number => {
    const steps = Math.max(10, Math.round(distance(a, b) / 3));
    let hits = 0;
    for (let i = 0; i <= steps; i++) {
      const x = a.x + ((b.x - a.x) * i) / steps;
      const y = a.y + ((b.y - a.y) * i) / steps;
      let hit = false;
      for (let dy = -2; dy <= 2 && !hit; dy++) {
        for (let dx = -2; dx <= 2 && !hit; dx++) hit = edgeAt(x + dx, y + dy);
      }
      if (hit) hits++;
    }
    return hits / (steps + 1);
  };

  // A card's edges stop at its corners. A line that keeps going past both corners
  // is more likely a table edge or wood grain, so look a little beyond each corner.
  const beyond = (a: Point, b: Point): number => {
    const k = 0.12;
    const before = { x: a.x - (b.x - a.x) * k, y: a.y - (b.y - a.y) * k };
    const after = { x: b.x + (b.x - a.x) * k, y: b.y + (b.y - a.y) * k };
    return Math.min(support(before, a), support(b, after));
  };

  const sides: [Point, Point][] = [[tl, tr], [tr, br], [br, bl], [bl, tl]];
  const on: number[] = [];
  for (const [a, b] of sides) {
    const value = support(a, b);
    if (value < 0.3) return null; // stop early: most candidates fail here
    on.push(value);
  }
  const fit = sides.reduce((total, [a, b], i) => total + on[i] - 0.5 * beyond(a, b), 0) / 4;
  if (fit <= 0) return null;
  // Cubed, so a shape slightly off the edges loses to one sitting right on them;
  // area, so the card beats the boxes printed inside it
  return fit ** 3 * area;
}

// ---------------------------------------------------------------------------
// Finding the card by its straight edges
// ---------------------------------------------------------------------------

interface Line {
  // The line is every point p where nx * p.x + ny * p.y = rho
  nx: number;
  ny: number;
  rho: number;
  length: number; // total length of the edge pieces along it
}

// Smallest difference between two directions, in radians, ignoring which way they point
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

// The straight line closest to a set of points ([x0, y0, x1, y1, …]), found from
// the direction they spread out in the most (principal component)
function fitLine<T extends Line & { angle: number }>(coords: number[], fallback: T): T {
  const n = coords.length / 2;
  if (n < 2) return fallback;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < coords.length; i += 2) {
    mx += coords[i] / n;
    my += coords[i + 1] / n;
  }
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < coords.length; i += 2) {
    const dx = coords[i] - mx;
    const dy = coords[i + 1] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  return { ...fallback, angle, nx, ny, rho: nx * mx + ny * my };
}

function intersect(a: Line, b: Line): Point | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.rho * b.ny - a.ny * b.rho) / det, y: (a.nx * b.rho - a.rho * b.nx) / det };
}

/**
 * Card-shaped candidates built from straight edges, for when a finger or another
 * object touches the card and its outline can't be traced:
 *   1. find straight edge pieces (Hough transform)
 *   2. split them into the two main directions (the card's long and short sides)
 *   3. join pieces that lie on the same line
 *   4. every pair of lines from one direction with every pair from the other
 *      makes a four-sided candidate (scoreQuad picks the best)
 */
function cardsFromLines(cv: CV, edges: Mat): Quad[] {
  const segmentsMat = new cv.Mat();
  const width = edges.cols;
  const height = edges.rows;
  const shortSide = Math.min(width, height);

  try {
    cv.HoughLinesP(edges, segmentsMat, 1, Math.PI / 180, 40, shortSide * 0.12, 12);

    // 1. Edge pieces with their direction and length
    const segments: { angle: number; length: number; mx: number; my: number; ends: number[] }[] = [];
    for (let i = 0; i < segmentsMat.rows; i++) {
      const [x1, y1, x2, y2] = segmentsMat.data32S.slice(i * 4, i * 4 + 4);
      const length = Math.hypot(x2 - x1, y2 - y1);
      const angle = (Math.atan2(y2 - y1, x2 - x1) + Math.PI) % Math.PI;
      segments.push({ angle, length, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, ends: [x1, y1, x2, y2] });
    }
    if (segments.length < 4) return [];

    // 2. The main direction: the angle with the most edge length (1° steps, smoothed)
    const histogram = new Array(180).fill(0);
    for (const s of segments) {
      const degree = Math.round((s.angle * 180) / Math.PI) % 180;
      for (let d = -3; d <= 3; d++) histogram[(degree + d + 180) % 180] += s.length;
    }
    const main = (histogram.indexOf(Math.max(...histogram)) * Math.PI) / 180;
    // Perspective makes opposite sides a bit less than parallel, so allow some slack
    const slack = (25 * Math.PI) / 180;

    // 3. For each direction, the lines that edge pieces lie on. Each piece suggests a
    // line; it's ranked by how much edge (from all pieces) lies along it, and lines
    // almost on top of a better one are dropped. Pieces aren't averaged together:
    // the card's outer edge and the inner edge of its border are only a few pixels
    // apart, and averaging them would put the line between the two.
    const linesAlong = (direction: number): Line[] => {
      const group = segments
        .filter((s) => angleDiff(s.angle, direction) < slack)
        .map((s) => {
          const nx = -Math.sin(s.angle);
          const ny = Math.cos(s.angle);
          return { ...s, nx, ny, rho: nx * s.mx + ny * s.my };
        });
      const near = shortSide * 0.008;
      const sameLine = (a: Line & { angle: number }, b: { mx: number; my: number; angle: number }) =>
        angleDiff(a.angle, b.angle) < (3 * Math.PI) / 180 && Math.abs(a.nx * b.mx + a.ny * b.my - a.rho) < near;
      const ranked = group
        .map((line) => ({
          ...line,
          length: group.filter((other) => sameLine(line, other)).reduce((sum, other) => sum + other.length, 0),
        }))
        .sort((a, b) => b.length - a.length);
      const lines: (Line & { angle: number })[] = [];
      for (const line of ranked) {
        if (lines.length === 14) break;
        if (!lines.some((kept) => sameLine(kept, line))) lines.push(line);
      }
      // Fit each line through the ends of all the pieces on it: one short piece's
      // direction can be a degree off, which moves the far corners several pixels
      return lines.map((line) => fitLine(group.filter((other) => sameLine(line, other)).flatMap((other) => other.ends), line));
    };
    const groupA = linesAlong(main);
    const groupB = linesAlong(main + Math.PI / 2);

    // 4. Every pair of lines from each direction, as the card's four sides
    const quads: Quad[] = [];
    const margin = shortSide * 0.03;
    for (let i = 0; i < groupA.length; i++) {
      for (let j = i + 1; j < groupA.length; j++) {
        for (let k = 0; k < groupB.length; k++) {
          for (let l = k + 1; l < groupB.length; l++) {
            const corners = [
              intersect(groupA[i], groupB[k]),
              intersect(groupA[i], groupB[l]),
              intersect(groupA[j], groupB[l]),
              intersect(groupA[j], groupB[k]),
            ];
            const inside = corners.every(
              (p) => p && p.x > -margin && p.y > -margin && p.x < width + margin && p.y < height + margin,
            );
            if (!inside) continue;
            // Cheap checks first; scoring every candidate's edges is the slow part
            const quad = orderCorners(corners as Point[]);
            if (hasCardShape(quad) && quadArea(quad) >= width * height * 0.08) quads.push(quad);
          }
        }
      }
    }
    return quads;
  } finally {
    segmentsMat.delete();
  }
}

// ---------------------------------------------------------------------------
// Flattening the card
// ---------------------------------------------------------------------------

/**
 * Cut the card out of the picture and stretch it into a straight, upright
 * FLAT_WIDTH × FLAT_HEIGHT image, as if it had been scanned on a flatbed.
 */
export async function flattenCard(picture: HTMLCanvasElement, quad: Quad): Promise<HTMLCanvasElement> {
  const { cv } = await loadOpenCv();
  let [tl, tr, br, bl] = quad;

  // Card lying sideways in the picture: turn the corners a quarter so the card
  // comes out portrait. (It can come out upside down; TODO: have OCR retry flipped.)
  if (distance(tl, tr) > distance(tl, bl)) [tl, tr, br, bl] = [bl, tl, tr, br];

  const src = cv.imread(picture);
  const flat = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, FLAT_WIDTH, 0, FLAT_WIDTH, FLAT_HEIGHT, 0, FLAT_HEIGHT]);
  const transform = cv.getPerspectiveTransform(from, to);

  try {
    cv.warpPerspective(src, flat, transform, new cv.Size(FLAT_WIDTH, FLAT_HEIGHT), cv.INTER_LINEAR);
    const canvas = document.createElement('canvas');
    cv.imshow(canvas, flat);
    return canvas;
  } finally {
    [src, flat, from, to, transform].forEach((mat) => mat.delete());
  }
}

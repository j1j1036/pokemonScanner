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

  try {
    // Shrink, go greyscale and blur slightly so card artwork and table texture
    // don't produce lots of tiny edges
    cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    // Find edges (sharp changes in brightness), then thicken them a little
    // so small gaps in the card's outline get closed
    cv.Canny(gray, edges, 40, 120);
    cv.dilate(edges, edges, kernel, new cv.Point(-1, -1), 2);

    // Outer outlines only: we want the card's border, not the shapes printed on it
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    // The card should cover a decent part of the picture
    const minArea = small.cols * small.rows * 0.12;
    let best: { quad: Quad; area: number } | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const area = cv.contourArea(contour);
      if (area < minArea || (best && area <= best.area)) {
        contour.delete();
        continue;
      }

      // Simplify the outline; a card should come out as 4 corners
      const approx = new cv.Mat();
      cv.approxPolyDP(contour, approx, 0.02 * cv.arcLength(contour, true), true);
      let quad: Quad | null = null;
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        quad = orderCorners(contourPoints(approx));
      } else {
        // Rounded or slightly broken outline: fall back to the tightest rotated
        // rectangle around it, as long as the outline mostly fills that rectangle
        const rect = cv.minAreaRect(contour);
        if (area / (rect.size.width * rect.size.height) > 0.85) {
          quad = orderCorners(cv.RotatedRect.points(rect));
        }
      }
      approx.delete();
      contour.delete();

      if (quad && hasCardShape(quad)) best = { quad, area };
    }

    // Scale the corners back up to the full-size picture
    return best ? (best.quad.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad) : null;
  } finally {
    [src, small, gray, edges, kernel, contours, hierarchy].forEach((mat) => mat.delete());
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

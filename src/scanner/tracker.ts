/**
 * Live card tracking: while the camera is on, look for the card a few times
 * a second, report where it is (so the page can draw its outline), and say
 * when it has been held still long enough to scan automatically.
 */
import { grabFrame, pictureSize } from './camera';
import { findCard } from './detect';
import type { Quad } from './detect';

// How often to look for the card
const INTERVAL_MS = 150;
// How many checks in a row the card must stay still before auto-scanning (~1 second)
const STEADY_CHECKS = 6;
// "Still" = no corner moved more than this fraction of the picture between checks
const MAX_WOBBLE = 0.02;
// After an auto-scan, the card must be gone for this many checks before the
// next auto-scan, so the same card isn't scanned over and over
const GONE_CHECKS = 4;

// The biggest distance any corner moved between two checks
function wobble(a: Quad, b: Quad): number {
  return Math.max(...a.map((point, i) => Math.hypot(point.x - b[i].x, point.y - b[i].y)));
}

/**
 * Start tracking. `onUpdate` gets the card's corners (in video pixels) or null
 * after every check; `onSteady` is called once the card has been held still.
 * Returns a function that stops tracking.
 */
export function trackCard(
  video: HTMLVideoElement,
  onUpdate: (quad: Quad | null) => void,
  onSteady: () => void,
): () => void {
  let running = true;
  let previous: Quad | null = null;
  let steadyCount = 0;
  let goneCount = 0;
  let armed = true;

  async function check(): Promise<void> {
    if (!running) return;
    // readyState 2+ means the video has a frame to look at
    if (video.readyState >= 2) {
      // A small frame is enough to find the outline, and keeps this fast
      const frame = grabFrame(video, 480);
      const found = await findCard(frame).catch(() => null);
      if (!running) return;

      // Convert the corners from the small frame back to video pixels
      const { width, height } = pictureSize(video);
      const k = width / frame.width;
      const quad = found ? (found.map((p) => ({ x: p.x * k, y: p.y * k })) as Quad) : null;
      onUpdate(quad);

      if (quad) {
        goneCount = 0;
        const still = previous !== null && wobble(previous, quad) < MAX_WOBBLE * Math.max(width, height);
        steadyCount = still ? steadyCount + 1 : 0;
        if (armed && steadyCount >= STEADY_CHECKS) {
          armed = false;
          onSteady();
        }
      } else {
        steadyCount = 0;
        if (++goneCount >= GONE_CHECKS) armed = true;
      }
      previous = quad;
    }
    setTimeout(check, INTERVAL_MS);
  }

  void check();
  return () => {
    running = false;
  };
}

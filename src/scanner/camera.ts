/**
 * Camera helpers: turn the camera on and off, and grab a picture of the
 * area inside the on-screen card frame.
 */

// Pokémon cards are 63 × 88 mm; the on-screen frame uses the same shape
export const CARD_ASPECT = 63 / 88;

// Ask the browser for camera access and show the live feed in the <video> element.
// The browser shows a permission prompt the first time. This throws if the user
// says no, or if the page isn't on HTTPS/localhost.
export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      // Prefer the back camera on phones ("ideal" = use it if there is one, otherwise any camera)
      facingMode: { ideal: 'environment' },
      // Ask for a high resolution: sharper picture = better text reading
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

// Stop every track in the stream, which turns the camera (and its indicator light) off
export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

// A picture the scanner can read: the live <video>, or an <img> holding a photo the user took
export type Picture = HTMLVideoElement | HTMLImageElement;

// The picture's real size in pixels (videos and images name this differently)
export function pictureSize(source: Picture): { width: number; height: number } {
  return source instanceof HTMLVideoElement
    ? { width: source.videoWidth, height: source.videoHeight }
    : { width: source.naturalWidth, height: source.naturalHeight };
}

// Both the video and the photo use CSS `object-fit: cover`, so the real image is
// scaled up to fill its element and its edges are cropped off-screen.
// This works out that scale and how much hangs off each side (it's centered).
function coverFit(source: Picture) {
  const { width, height } = pictureSize(source);
  const box = source.getBoundingClientRect();
  const scale = Math.max(box.width / width, box.height / height);
  return { box, scale, offsetX: (width * scale - box.width) / 2, offsetY: (height * scale - box.height) / 2 };
}

// Where a point in the picture's own pixels appears on screen,
// measured from the top-left corner of the video/photo element
export function toScreen(source: Picture, point: { x: number; y: number }): { x: number; y: number } {
  const { scale, offsetX, offsetY } = coverFit(source);
  return { x: point.x * scale - offsetX, y: point.y * scale - offsetY };
}

// Copy the whole picture into a canvas. Huge camera-app photos are shrunk to
// at most `maxSize` pixels on their long side, which is plenty for reading a card.
export function grabFrame(source: Picture, maxSize = 2000): HTMLCanvasElement {
  const { width, height } = pictureSize(source);
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Copy the part of the picture under the on-screen guide into a canvas.
 * Used when the card's edges can't be found automatically.
 *
 * The guide's position is in screen pixels, so we convert it back into image pixels.
 */
export function captureGuide(source: Picture, guide: HTMLElement): HTMLCanvasElement {
  const { box, scale, offsetX, offsetY } = coverFit(source);
  const guideBox = guide.getBoundingClientRect();

  // The guide rectangle in the image's own pixels (s = "source")
  const sx = (guideBox.left - box.left + offsetX) / scale;
  const sy = (guideBox.top - box.top + offsetY) / scale;
  const sw = guideBox.width / scale;
  const sh = guideBox.height / scale;

  // Draw just that rectangle of the picture into a new canvas
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  canvas.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Load a photo file (from the phone's camera app or a file picker) into an <img>,
// and wait until it's ready to be drawn
export async function showPhoto(img: HTMLImageElement, file: File): Promise<void> {
  // Free the previous photo's memory before loading the new one
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(file);
  await img.decode();
}

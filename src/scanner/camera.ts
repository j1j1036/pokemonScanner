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

/**
 * Copy the part of the picture under the on-screen guide into a canvas.
 * The picture is either the live <video> or an <img> holding a photo the user took.
 *
 * The tricky part: both use CSS `object-fit: cover`, so the real image is
 * scaled up and its edges are cropped off-screen. The guide's position
 * is in screen pixels, so we convert it back into image pixels.
 */
export function captureGuide(source: HTMLVideoElement | HTMLImageElement, guide: HTMLElement): HTMLCanvasElement {
  // The picture's real size in pixels (videos and images name this differently)
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;

  // Where the picture and the guide frame are on screen
  const sourceBox = source.getBoundingClientRect();
  const guideBox = guide.getBoundingClientRect();

  // How much the image was scaled to cover its element...
  const scale = Math.max(sourceBox.width / width, sourceBox.height / height);
  // ...and how much of it hangs off each side (it's centered)
  const offsetX = (width * scale - sourceBox.width) / 2;
  const offsetY = (height * scale - sourceBox.height) / 2;

  // The guide rectangle in the image's own pixels (s = "source")
  const sx = (guideBox.left - sourceBox.left + offsetX) / scale;
  const sy = (guideBox.top - sourceBox.top + offsetY) / scale;
  const sw = guideBox.width / scale;
  const sh = guideBox.height / scale;

  // Draw just that rectangle of the picture into a new canvas.
  // The result is a straight-on picture of the card.
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

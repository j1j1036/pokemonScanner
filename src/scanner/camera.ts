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
 * Copy the part of the video frame under the on-screen guide into a canvas.
 *
 * The tricky part: the <video> uses CSS `object-fit: cover`, so the real camera
 * image is scaled up and its edges are cropped off-screen. The guide's position
 * is in screen pixels, so we convert it back into camera-image pixels.
 */
export function captureGuide(video: HTMLVideoElement, guide: HTMLElement): HTMLCanvasElement {
  // Where the video and the guide frame are on screen
  const videoBox = video.getBoundingClientRect();
  const guideBox = guide.getBoundingClientRect();

  // How much the camera image was scaled to cover the video element...
  const scale = Math.max(videoBox.width / video.videoWidth, videoBox.height / video.videoHeight);
  // ...and how much of it hangs off each side (it's centered)
  const offsetX = (video.videoWidth * scale - videoBox.width) / 2;
  const offsetY = (video.videoHeight * scale - videoBox.height) / 2;

  // The guide rectangle in the camera image's own pixels (s = "source")
  const sx = (guideBox.left - videoBox.left + offsetX) / scale;
  const sy = (guideBox.top - videoBox.top + offsetY) / scale;
  const sw = guideBox.width / scale;
  const sh = guideBox.height / scale;

  // Draw just that rectangle of the current frame into a new canvas.
  // The result is a straight-on picture of the card.
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  canvas.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

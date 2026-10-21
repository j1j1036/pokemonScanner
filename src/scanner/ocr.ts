/**
 * OCR (Optical Character Recognition): reading the text off a picture of a card.
 *
 * We don't read the whole card. We read only:
 *   - the top strip, where the Pokémon's name is printed
 *   - the bottom strip, where the collector number is printed (e.g. "136/189")
 *
 * Reading uses tesseract.js, which runs in the browser, so no image ever
 * leaves the device.
 */
import { createWorker, PSM } from 'tesseract.js';
import type { Block, Worker, Word } from 'tesseract.js';
import type { CardNumber } from '../pokemon/scannerInicializer';

// What a scan produces. `name` and `number` are the cleaned-up results;
// `rawName` and `rawNumber` are the unprocessed OCR text, kept for debugging.
export interface ScanResult {
  name: string;
  number?: CardNumber;
  rawName: string;
  rawNumber: string;
}

// Words printed in the card header that are never part of the name
const HEADER_NOISE = new Set(['BASIC', 'STAGE', 'STAGE1', 'STAGE2', 'HP', 'EVOLVES', 'FROM', 'PUT', 'ON', 'THE', 'TRAINER', 'ITEM', 'SUPPORTER', 'STADIUM', 'ENERGY']);

// Every card is resized to this width before reading. Live-camera frames are small
// and camera-app photos can be 4000px+ wide; a fixed size keeps text a predictable
// size for tesseract and stops huge photos from making the scan slow.
const CARD_WIDTH = 1000;

// Tesseract runs in background "workers". Creating one downloads the English
// language data (~10 MB, cached by the browser after the first time), so they're
// created once and reused. There are two, so the header and footer can be read
// at the same time; each keeps its own settings.
const workers: Partial<Record<'header' | 'footer', Promise<Worker>>> = {};

function getWorker(part: 'header' | 'footer'): Promise<Worker> {
  // ??= means "only assign if it's still unset", so each is created once
  workers[part] ??= createWorker('eng');
  return workers[part];
}

/** Start downloading the OCR model early so the first scan is faster. */
export function warmUpOcr(): void {
  void getWorker('header');
  void getWorker('footer');
}

// Resize the captured card to CARD_WIDTH, keeping its shape
function normalizeSize(card: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = CARD_WIDTH;
  out.height = Math.round((card.height * CARD_WIDTH) / card.width);
  out.getContext('2d')!.drawImage(card, 0, 0, out.width, out.height);
  return out;
}

// Crop a fraction of the card, upscale and convert to high-contrast greyscale.
// x, y, w, h are fractions of the card (0 to 1), e.g. (0, 0, 1, 0.13) = the top 13%.
// Tesseract reads big, black-and-white text much more reliably, hence the upscale and filter.
function cropRegion(
  card: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  upscale = 2,
  filter = 'grayscale(1) contrast(1.6)',
): HTMLCanvasElement {
  // Convert fractions to pixels
  const sx = card.width * x;
  const sy = card.height * y;
  const sw = card.width * w;
  const sh = card.height * h;

  const out = document.createElement('canvas');
  out.width = Math.round(sw * upscale);
  out.height = Math.round(sh * upscale);
  const ctx = out.getContext('2d')!;
  ctx.filter = filter;
  ctx.drawImage(card, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

// Tesseract returns nested layout data: blocks > paragraphs > lines > words.
// Flatten it into a plain list of lines, each line being a list of words.
function allWords(blocks: Block[] | null): Word[][] {
  return (blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) => paragraph.lines.map((line) => line.words)),
  );
}

// Height in pixels of the box around a word, a stand-in for font size
function wordHeight(word: Word): number {
  return word.bbox.y1 - word.bbox.y0;
}

// Strip everything that can't appear in a Pokémon name (digits, stray symbols).
// Keeps letters (including accents), apostrophes, dots, hyphens and ♀/♂,
// for names like "Farfetch'd", "Mr. Mime", "Ho-Oh" and "Nidoran♀".
function cleanWord(text: string): string {
  return text.replace(/[^\p{L}'.\-♀♂]/gu, '');
}

// The name is the biggest text in the header; take the line holding the tallest word.
// This skips the small "Evolves from Charmeleon" text, which often sits in the same strip.
function pickName(lines: Word[][]): string {
  // Find the tallest word that looks like real text
  let best: { line: Word[]; height: number } | null = null;
  for (const line of lines) {
    for (const word of line) {
      const text = cleanWord(word.text);
      // Skip short fragments, header words like "BASIC", and words OCR is unsure about
      if (text.length < 3 || HEADER_NOISE.has(text.toUpperCase()) || word.confidence < 40) continue;
      if (!best || wordHeight(word) > best.height) best = { line, height: wordHeight(word) };
    }
  }
  if (!best) return '';

  // Build the name from the words on that line that are similarly large,
  // so multi-word names survive: "Charizard ex", "Mr. Mime", "Radiant Greninja"
  return best.line
    .filter((word) => wordHeight(word) >= best.height * 0.6 && word.confidence >= 40)
    .map((word) => cleanWord(word.text))
    .filter((text) => text.length > 0 && !HEADER_NOISE.has(text.toUpperCase()))
    .join(' ');
}

// Find a collector number such as "136/189", "006/165" or "TG05/TG30" in the footer text
function parseNumber(text: string): CardNumber | undefined {
  // OCR commonly reads "0" as "O" and "1" as "l" or "I"
  const fixed = text.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1');
  // Pattern: optional letter prefix + 1–3 digits, a slash, then the same again
  const match = fixed.match(/([A-Z]{0,3}\d{1,3})\s*\/\s*([A-Z]{0,3}\d{1,3})/i);
  if (!match) return undefined;
  // A letter prefix is only real when the total has one too ("TG05/TG30", "GG12/GG70").
  // Otherwise it's nearby text OCR glued onto the number ("EN136/189" -> "136").
  const local = /^[A-Z]/i.test(match[2]) ? match[1] : match[1].replace(/^[A-Z]+/i, '');
  // The total is the set size; keep only its digits ("TG30" -> 30)
  const total = Number(match[2].replace(/\D/g, ''));
  return { local, total: Number.isNaN(total) ? undefined : total };
}

// Read the header (top 13% of the card), where the name is printed
export async function readHeader(card: HTMLCanvasElement): Promise<{ lines: string[]; allText: string; guess: string; raw: string }> {
  const worker = await getWorker('header');
  // SPARSE_TEXT tells tesseract the text is scattered rather than in paragraphs.
  // An empty whitelist allows any character.
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '' });
  // `blocks: true` also returns each word's position and size, which pickName needs
  const header = await worker.recognize(cropRegion(normalizeSize(card), 0, 0, 1, 0.13), {}, { blocks: true, text: true });
  const lines = allWords(header.data.blocks);
  return {
    // Each line's words, biggest text first (the name is the biggest text in the header).
    // Lines tesseract is unsure about are left out: they're usually shapes or
    // upside-down text that happen to look like letters.
    lines: lines
      .filter((line) => line.length && line.reduce((sum, word) => sum + word.confidence, 0) / line.length >= 55)
      .sort((a, b) => Math.max(0, ...b.map(wordHeight)) - Math.max(0, ...a.map(wordHeight)))
      .map((line) => line.map((word) => word.text).join(' ')),
    // Everything read, sure or not, for comparing against a few known names
    allText: header.data.text,
    guess: pickName(lines),
    raw: header.data.text.trim(),
  };
}

// Read the collector number from the footer (bottom 12% of the card)
export async function readFooter(card: HTMLCanvasElement): Promise<{ number?: CardNumber; raw: string }> {
  const worker = await getWorker('footer');
  const normal = normalizeSize(card);
  // Restrict to digits, letters and "/" so symbols printed nearby (rarity icons,
  // the set logo) aren't misread as punctuation
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  });
  // Collector number is bottom-left on modern cards, bottom-right on older ones,
  // so read the full width of the bottom 12%. The text is tiny, so upscale 3×.
  const footer = await worker.recognize(cropRegion(normal, 0, 0.88, 1, 0.12, 3), {}, { text: true });
  const number = parseNumber(footer.data.text);
  if (number) return { number, raw: footer.data.text.trim() };

  // Not found: try a taller strip (in case the card was cut a little off) with
  // much stronger contrast, which helps with glare and grey-on-grey printing
  const retry = await worker.recognize(cropRegion(normal, 0, 0.84, 1, 0.16, 3, 'grayscale(1) contrast(2.6) brightness(1.1)'), {}, { text: true });
  const second = parseNumber(retry.data.text);
  if (second) return { number: second, raw: retry.data.text.trim() };

  // Still nothing: some cards (V, VMAX, ex) print the number light on a dark
  // band, and tesseract reads dark text on light much better, so flip the colors
  const inverted = await worker.recognize(cropRegion(normal, 0, 0.84, 1, 0.16, 3, 'grayscale(1) invert(1) contrast(2)'), {}, { text: true });
  return { number: parseNumber(inverted.data.text), raw: `${footer.data.text.trim()}\n---\n${inverted.data.text.trim()}` };
}

// Read the name and number from a captured card image
export async function scanCard(captured: HTMLCanvasElement): Promise<ScanResult> {
  const [header, footer] = await Promise.all([readHeader(captured), readFooter(captured)]);
  return { name: header.guess, number: footer.number, rawName: header.raw, rawNumber: footer.raw };
}

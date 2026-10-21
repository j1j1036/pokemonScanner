/**
 * The whole scan, from a picture to a card name and number:
 *   1. find the card in the picture and straighten it  (detect.ts)
 *   2. read its header (name) and footer (number)        (ocr.ts)
 *   3. look it up:
 *      - by the full collector number ("136/189"), which narrows the whole
 *        database to a card or two; the name, even half-read, picks between them
 *      - otherwise by snapping the name to a real card name (names.ts)
 *
 * If that finds nothing, it tries again with the card turned upside down, and
 * then with whatever is inside the on-screen frame instead.
 */
import { findCard, flattenCard } from './detect';
import { cardsByNumber } from '../pokemon/scannerInicializer';
import { distanceInside, matchName, simplify, warmUpNames } from './names';
import { readFooter, readHeader, warmUpOcr } from './ocr';
import type { ScanResult } from './ocr';

/** Start the downloads a scan needs (OCR model, card names) ahead of time. */
export function warmUpScanner(): void {
  warmUpOcr();
  warmUpNames();
}

// The same picture turned 180°
function upsideDown(card: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = card.width;
  out.height = card.height;
  const ctx = out.getContext('2d')!;
  ctx.rotate(Math.PI);
  ctx.drawImage(card, -card.width, -card.height);
  return out;
}

/**
 * Scan a picture. `frame` is the whole picture; `guideCrop` is the part inside
 * the on-screen card frame, used when the card's edges can't be found.
 */
export async function scanPicture(frame: HTMLCanvasElement, guideCrop: HTMLCanvasElement): Promise<ScanResult> {
  warmUpNames();

  // Pictures of the card to try, best first. A straightened card can come out
  // upside down (we can't tell which way up it is from its outline alone).
  const quad = await findCard(frame).catch(() => null);
  const flat = quad ? await flattenCard(frame, quad) : null;
  const attempts = [
    ...(flat ? [{ card: flat, flipped: false }, { card: upsideDown(flat), flipped: true }] : []),
    { card: guideCrop, flipped: false },
    { card: upsideDown(guideCrop), flipped: true },
  ];

  // A full number shared by a few cards, with no readable name to pick between
  // them. Kept in case nothing better turns up; the page then lets the user choose.
  let numberOnly: ScanResult | null = null;

  for (const attempt of attempts) {
    // Header and footer are read at the same time, by two OCR workers
    const [header, footer] = await Promise.all([readHeader(attempt.card), readFooter(attempt.card)]);
    const raw = { rawName: header.raw, rawNumber: footer.raw };

    // 1. By number: the few cards with this exact number, ranked by how well their
    //    names match what the header says (errors per letter, 0 = exact).
    //    Tiny "sets" are left out: "1/1" is usually a misread scratch or symbol.
    const number = footer.number;
    if (number?.total !== undefined && number.total >= 20) {
      const cards = await cardsByNumber(number).catch(() => []);
      const text = simplify(header.allText);
      const ranked = cards
        .map((card) => ({ card, score: distanceInside(simplify(card.name), text) / Math.max(1, simplify(card.name).length) }))
        .sort((a, b) => a.score - b.score);
      const [best, second] = ranked;
      const found = (card: (typeof cards)[number]) => ({ name: card.name, number: { local: card.localId, total: number.total }, ...raw });
      // The only card with this number
      if (ranked.length === 1) return found(best.card);
      // Several: the name has to be readable, and clearly closer than the next one
      if (best && best.score <= 0.5 && (!second || second.score - best.score >= 0.15)) return found(best.card);
      if (ranked.length > 1 && ranked.length <= 5) numberOnly ??= { name: '', number, ...raw };
    }

    // 2. By name: a real card name in the header
    const match = await matchName(header.lines).catch(() => null);
    if (match) {
      // A number from a tiny "set" ("0/1") is a misread; without a number the
      // search lists every card with this name, so try the other pictures turned
      // the same way (a straightened card can be cut off a little at the bottom)
      let found = number?.total !== undefined && number.total >= 20 ? number : undefined;
      for (const other of attempts) {
        if (found) break;
        if (other === attempt || other.flipped !== attempt.flipped) continue;
        const retry = (await readFooter(other.card)).number;
        if (retry?.total !== undefined && retry.total >= 20) found = retry;
      }
      return { name: match.name, number: found, ...raw };
    }
  }

  if (numberOnly) return numberOnly;

  // Nothing found: hand back the best guess so the user can fix it by hand
  const [header, footer] = await Promise.all([readHeader(attempts[0].card), readFooter(attempts[0].card)]);
  return { name: header.guess, number: footer.number, rawName: header.raw, rawNumber: footer.raw };
}

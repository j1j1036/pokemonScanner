/**
 * Snapping what OCR read to a real card name.
 *
 * OCR rarely reads a name perfectly ("Pikachy", "Aegislas h", "LugiaVe"), and a
 * search for a misspelled name finds nothing. So we compare what was read with
 * every card name in the database and pick the closest one.
 */
import { getAllNames } from '../pokemon/scannerInicializer';

// A name in comparable form: lowercase letters and digits only, accents removed.
// "Mr. Mime" -> "mrmime", "Pokémon" -> "pokemon", "Lugia V" -> "lugiav"
export function simplify(text: string): string {
  return text
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

interface KnownName {
  name: string;
  simple: string;
}

// The unique names, in simplified form, prepared once
let known: Promise<KnownName[]> | null = null;

function knownNames(): Promise<KnownName[]> {
  known ??= getAllNames().then((names) =>
    // 3-letter names ("Mew", "Muk") turn up by chance in misread text far too often;
    // those cards are still found by their number
    [...new Set(names)].map((name) => ({ name, simple: simplify(name) })).filter((n) => n.simple.length >= 4),
  );
  known.catch(() => {
    known = null;
  });
  return known;
}

/** Start downloading the names early, so the first scan doesn't wait for them. */
export function warmUpNames(): void {
  void knownNames().catch(() => {});
}

/**
 * The fewest letter changes (add, remove or swap one letter) that make `pattern`
 * appear somewhere inside `text`. 0 = it's in there exactly.
 * This lets "pikachu" be found in "basicpokemonpikachy40hp" with 1 change.
 */
export function distanceInside(pattern: string, text: string): number {
  const m = pattern.length;
  // previous[j] = changes needed to match the first i-1 letters of the pattern, ending at text[j]
  let previous = new Array(text.length + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const current = [i];
    for (let j = 1; j <= text.length; j++) {
      const swap = previous[j - 1] + (pattern[i - 1] === text[j - 1] ? 0 : 1);
      current.push(Math.min(swap, previous[j] + 1, current[j - 1] + 1));
    }
    previous = current;
  }
  return Math.min(...previous);
}

// Lines in the card header that mention another Pokémon, not this card's own name:
// "Evolves from Charmeleon", "Put Charizard on the Stage 1 card"
const OTHER_POKEMON = /evolv|volves|\bfrom\b|\bput\b/i;

/**
 * The real card name that best matches the OCR'd header lines, or null if
 * nothing is close enough.
 */
export async function matchName(lines: string[]): Promise<{ name: string; errors: number } | null> {
  const names = await knownNames();
  const texts = lines.filter((line) => !OTHER_POKEMON.test(line)).map(simplify).filter((text) => text.length >= 3);
  if (!texts.length) return null;

  let best: { name: string; errors: number; length: number } | null = null;
  for (const { name, simple } of names) {
    // Short names must match exactly: "Mew", "Onix" or "Arbok" are easily found in
    // random letters. Longer names may have a wrong letter or two.
    const allowed = simple.length <= 5 ? 0 : simple.length <= 9 ? 1 : 2;
    for (const text of texts) {
      if (text.length < simple.length - allowed) continue;
      const errors = distanceInside(simple, text);
      if (errors > allowed) continue;
      // Fewer errors per letter wins; on a tie, the longer name ("Lugia V" over "Lugia")
      const better =
        !best ||
        errors / simple.length < best.errors / best.length ||
        (errors / simple.length === best.errors / best.length && simple.length > best.length);
      if (better) best = { name, errors, length: simple.length };
    }
  }
  return best && { name: best.name, errors: best.errors };
}

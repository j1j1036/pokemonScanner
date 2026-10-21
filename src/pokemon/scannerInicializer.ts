/**
 * Card lookup layer: everything that talks to the TCGdex database lives here.
 *
 * The rest of the app only calls two functions:
 *   - findCards(name, number) -> list of matching cards (light "resume" objects)
 *   - getCard(id)             -> one full card with all its details and prices
 */
import TCGdex, { Query } from '@tcgdex/sdk'
import type { CardModel, CardResumeModel } from '@tcgdex/sdk'

// One shared SDK client. 'en' = search the English card database.
// The SDK caches responses, so asking for the same card twice won't hit the network twice.
const tcgdex = new TCGdex('en');

// The API returns pricing, but the SDK's types don't declare it yet.
// These interfaces describe the parts of that pricing data we actually show.
export interface CardPricing {
  // Prices from Cardmarket (Europe), usually in EUR
  cardmarket?: {
    unit: string;
    avg?: number;
    low?: number;
    trend?: number;
    'avg-holo'?: number;
    'trend-holo'?: number;
  } | null;
  // Prices from TCGplayer (US), keyed by variant, e.g. { normal: {...}, holofoil: {...} }
  tcgplayer?: {
    unit: string;
    [variant: string]: unknown;
  } | null;
}

// A full card from the SDK, plus the (untyped) pricing field
export type PricedCard = CardModel & { pricing?: CardPricing };

// The collector number printed at the bottom of a card, e.g. "136/189":
//   local = "136" (the card's number within its set)
//   total = 189   (how many cards the set has; optional because it's not always readable)
export interface CardNumber {
  local: string;
  total?: number;
}

// The database isn't consistent about leading zeros ("007" vs "7"), so compare
// numbers in a normalized form: uppercase, leading zeros removed ("tg05" -> "TG5").
function normalizeLocalId(id: string): string {
  return id.toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, '$1');
}

// Ask the API for every card whose name contains `name` (case-insensitive).
// Example: "charizard" also matches "Charizard ex" and "Dark Charizard".
async function searchByName(name: string): Promise<CardResumeModel[]> {
  return tcgdex.card.list(Query.create().like('name', name));
}

/**
 * Find cards matching a (possibly OCR-garbled) name and optional collector number.
 * Returns the best candidates first.
 *
 * Narrowing happens in three steps:
 *   1. search by name           -> e.g. every "Pikachu" ever printed (hundreds)
 *   2. keep the matching number -> only the Pikachus numbered 25 (a handful)
 *   3. check the set size       -> only the one from a set with 189 cards
 */
export async function findCards(name: string, number?: CardNumber): Promise<CardResumeModel[]> {
  // Step 1: search by the full name we were given
  let results = name ? await searchByName(name) : [];

  // OCR often adds junk words ("Charizard xq"); if nothing matched,
  // retry with just the longest word, which is most likely the Pokémon's name
  if (results.length === 0) {
    const longest = name.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    if (longest && longest !== name && longest.length >= 3) {
      results = await searchByName(longest);
    }
  }

  // Without a number there's nothing more to filter on
  if (!number) return results;

  // Step 2: keep only cards whose number matches
  const wanted = normalizeLocalId(number.local);
  const byNumber = results.filter((card) => normalizeLocalId(card.localId) === wanted);

  // If the number filter removed everything, the number was probably misread,
  // so return the name matches instead and let the user choose.
  // If we're already down to one card (or have no set total to check), stop here.
  if (byNumber.length <= 1 || number.total === undefined) {
    return byNumber.length > 0 ? byNumber : results;
  }

  // Step 3: several sets share this number; the printed total ("/189") picks the set.
  // The light list results don't include set info, so fetch the full cards
  // (in parallel, capped at 20 to avoid flooding the API).
  const full = await Promise.all(byNumber.slice(0, 20).map((card) => card.getCard()));
  const bySet = full.filter((card) => card.set.cardCount?.official === number.total);
  return bySet.length > 0 ? bySet : byNumber;
}

// Fetch one card with all its details, by its global ID (e.g. "swsh3-136").
// Returns null if the ID doesn't exist.
export async function getCard(id: string): Promise<PricedCard | null> {
  return tcgdex.card.get(id);
}

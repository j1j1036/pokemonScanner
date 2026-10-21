/**
 * The user's saved cards, kept in a Zustand store.
 *
 * We use Zustand's "vanilla" store (no React needed): the UI reads it with
 * collection.getState() and re-draws itself by subscribing with collection.subscribe().
 * The persist middleware saves it to localStorage, so the collection survives
 * reloads. It lives only in this browser on this device.
 */
import { createStore } from 'zustand/vanilla';
import { persist } from 'zustand/middleware';

// What we remember about a saved card. This is a snapshot taken when it was saved,
// so the collection shows without calling the API; clicking a card loads fresh data.
export interface SavedCard {
  id: string; // TCGdex ID, e.g. "swsh3-136"
  name: string;
  setName: string;
  number: string; // e.g. "136/189"
  image?: string; // small image URL
  price?: { value: number; unit: string }; // headline price at the time of saving
  count: number; // how many copies the user owns
  savedAt: number; // when it was first saved (ms since 1970)
}

interface CollectionState {
  cards: SavedCard[];
  // Save a card, or add one more copy if it's already in the collection
  add: (card: Omit<SavedCard, 'count' | 'savedAt'>) => void;
  // Remove one copy; the card disappears when its count reaches 0
  removeOne: (id: string) => void;
}

export const collection = createStore<CollectionState>()(
  persist(
    (set) => ({
      cards: [],

      add: (card) =>
        set((state) => {
          const existing = state.cards.find((saved) => saved.id === card.id);
          if (existing) {
            // Already saved: bump the count and refresh the price snapshot
            return {
              cards: state.cards.map((saved) =>
                saved.id === card.id ? { ...saved, ...card, count: saved.count + 1 } : saved,
              ),
            };
          }
          // New card goes to the front, so the latest save shows first
          return { cards: [{ ...card, count: 1, savedAt: Date.now() }, ...state.cards] };
        }),

      removeOne: (id) =>
        set((state) => ({
          cards: state.cards
            .map((saved) => (saved.id === id ? { ...saved, count: saved.count - 1 } : saved))
            .filter((saved) => saved.count > 0),
        })),
    }),
    // The localStorage key the collection is saved under
    { name: 'pokemon-scanner-collection' },
  ),
);

// How many copies of a card the user owns (0 if none)
export function ownedCount(id: string): number {
  return collection.getState().cards.find((saved) => saved.id === id)?.count ?? 0;
}

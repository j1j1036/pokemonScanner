/**
 * Fetches a player's personal store (daily shop and Night Market) for the
 * Valorant tracker (valorant/index.html).
 *
 * The page sends POST /api/valorant-shop with { accessToken, idToken }, which
 * the player got by logging in on Riot's own login page. Riot's servers don't
 * accept requests straight from a web page, so this makes the calls instead:
 *   1. entitlements token   (proves the account owns Valorant)
 *   2. userinfo             (the player's PUUID)
 *   3. riot-geo             (which game server shard the account lives on)
 *   4. storefront           (the shop itself)
 * and, next to the shop, the player's wallet, owned items, equipped loadout,
 * account level and contracts (battle pass, missions). Those extras are
 * optional: if one fails, the shop still comes back without it.
 *
 * This is Riot's internal game API, not a public one: it isn't documented and
 * can change at any time. The tokens are used for this one request and never
 * stored or logged.
 *
 * Only the site owner can use it: the request must carry the secret from the
 * SHOP_OWNER_KEY environment variable in an X-Owner-Key header. Without that
 * variable set, the endpoint is switched off.
 *
 * On Netlify this file runs as a Netlify Function. During `npm run dev`,
 * vite.config.ts calls fetchShop() directly, so both behave the same.
 */

// Netlify provides `process.env`; declared here so this file needs no Node type package
declare const process: { env: Record<string, string | undefined> };

// Currency IDs, the keys for prices in Cost objects and for the wallet's balances
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const RADIANITE = 'e59aa87c-4cbf-517a-5983-6e81511be9b7';
const KINGDOM_CREDITS = '85ca954a-41f2-ce94-9b45-8ca3dd39a00d';

// The game client sends this to say what it's running on (base64 of a JSON object)
const CLIENT_PLATFORM = btoa(
  JSON.stringify({
    platformType: 'PC',
    platformOS: 'Windows',
    platformOSVersion: '10.0.19042.1.256.64bit',
    platformChipset: 'Unknown',
  }),
);

// A region (from riot-geo) -> the shard its game servers run on
const SHARDS: Record<string, string> = { na: 'na', latam: 'na', br: 'na', eu: 'eu', ap: 'ap', kr: 'kr' };

// Same shape as the HenrikDev API's errors, so the page handles both the same way
function errorResponse(status: number, message: string): Response {
  return Response.json({ errors: [{ message, status }] }, { status, headers: { 'Cache-Control': 'no-store' } });
}

// A Riot answer that wasn't OK. 400/401/403 almost always mean the token expired.
class RiotError extends Error {
  readonly status: number;

  constructor(step: string, status: number) {
    super(
      status === 400 || status === 401 || status === 403
        ? 'Your Riot login has expired (it lasts about an hour). Log in again and paste the new link.'
        : `Riot's servers didn't answer the ${step} request (${status}). Try again in a minute.`,
    );
    this.status = status === 400 || status === 403 ? 401 : status;
  }
}

async function riot<T>(step: string, url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new RiotError(step, response.status);
  return (await response.json()) as T;
}

// The parts of the storefront answer we use
interface Offer {
  OfferID: string;
  Cost: Record<string, number>;
  Rewards: { ItemTypeID: string; ItemID: string; Quantity: number }[];
}

interface Storefront {
  // The Kingdom Credits shop (buddies, sprays, cards, titles)
  AccessoryStore?: {
    AccessoryStoreOffers: { Offer: Offer }[];
    AccessoryStoreRemainingDurationInSeconds: number;
  };
  SkinsPanelLayout: {
    SingleItemStoreOffers: Offer[];
    SingleItemOffersRemainingDurationInSeconds: number;
  };
  // Only there while the Night Market is open
  BonusStore?: {
    BonusStoreOffers: { Offer: Offer; DiscountPercent: number; DiscountCosts: Record<string, number> }[];
    BonusStoreRemainingDurationInSeconds: number;
  };
}

interface Loadout {
  Guns: { ID: string; SkinID: string; SkinLevelID: string; ChromaID: string; CharmLevelID?: string }[];
  Sprays: { SprayID: string }[];
  Identity: { PlayerCardID: string; PlayerTitleID: string; AccountLevel: number };
}

interface Contracts {
  Contracts: { ContractDefinitionID: string; ProgressionLevelReached: number; ProgressionTowardsNextLevel: number }[];
  Missions: { ID: string; Objectives: Record<string, number>; Complete: boolean; ExpirationTime: string }[];
}

// What the page gets back: just enough to draw the shop and the player's account
export interface ShopItem {
  itemTypeId: string;
  itemId: string;
  price: number; // in the offer's currency, after any Night Market discount
  basePrice: number;
  discountPercent: number;
}

export interface Shop {
  daily: { items: ShopItem[]; secondsLeft: number };
  nightMarket: { items: ShopItem[]; secondsLeft: number } | null;
  // Prices in Kingdom Credits
  accessories: { items: ShopItem[]; secondsLeft: number } | null;
  // The extras below are null when Riot didn't answer that part
  wallet: { vp: number; radianite: number; kingdomCredits: number } | null;
  owned: string[] | null; // IDs of everything the player owns (skin levels, buddies, cards, …)
  loadout: {
    guns: { weaponId: string; skinId: string; levelId: string; chromaId: string; buddyLevelId: string | null }[];
    sprayIds: string[];
    cardId: string;
    titleId: string;
  } | null;
  account: { level: number; xp: number } | null; // xp: towards the next level
  contracts: { id: string; level: number; xpTowardsNext: number }[] | null;
  missions: { id: string; progress: number; complete: boolean; expires: string }[] | null;
}

export async function fetchShop(request: Request, ownerKey: string | undefined): Promise<Response> {
  // Answer a wrong key the same as a missing endpoint, so nobody learns it's here
  if (!ownerKey || request.headers.get('X-Owner-Key') !== ownerKey) return errorResponse(404, 'Unknown endpoint');
  if (request.method !== 'POST') return errorResponse(405, 'Only POST requests are allowed');

  const body = (await request.json().catch(() => null)) as { accessToken?: unknown; idToken?: unknown } | null;
  const { accessToken, idToken } = body ?? {};
  if (typeof accessToken !== 'string' || typeof idToken !== 'string' || !accessToken || !idToken) {
    return errorResponse(400, 'The link is missing the login details. Copy the whole address after logging in.');
  }

  const auth = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  try {
    const [entitlements, user, geo, version] = await Promise.all([
      riot<{ entitlements_token: string }>('entitlements', 'https://entitlements.auth.riotgames.com/api/token/v1', {
        method: 'POST',
        headers: auth,
        body: '{}',
      }),
      riot<{ sub: string }>('account', 'https://auth.riotgames.com/userinfo', { headers: auth }),
      riot<{ affinities: { live: string } }>('region', 'https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant', {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ id_token: idToken }),
      }),
      // The store only answers clients that say which game version they are
      riot<{ data: { riotClientVersion: string } }>('version', 'https://valorant-api.com/v1/version', {}),
    ]);

    const shard = SHARDS[geo.affinities.live];
    if (!shard) return errorResponse(502, `Unknown account region "${geo.affinities.live}"`);

    const game = {
      ...auth,
      'X-Riot-Entitlements-JWT': entitlements.entitlements_token,
      'X-Riot-ClientPlatform': CLIENT_PLATFORM,
      'X-Riot-ClientVersion': version.data.riotClientVersion,
    };
    const pd = `https://pd.${shard}.a.pvp.net`;
    const puuid = user.sub;

    // The shop is required; everything else is a nice extra, so failures become null
    const optional = <T>(promise: Promise<T>) => promise.catch(() => null);
    const [store, wallet, owned, loadout, xp, contracts] = await Promise.all([
      riot<Storefront>('store', `${pd}/store/v3/storefront/${puuid}`, { method: 'POST', headers: game, body: '{}' }),
      optional(riot<{ Balances: Record<string, number> }>('wallet', `${pd}/store/v1/wallet/${puuid}`, { headers: game })),
      optional(
        riot<{ EntitlementsByTypes: { Entitlements: { ItemID: string }[] }[] }>('owned items', `${pd}/store/v1/entitlements/${puuid}`, {
          headers: game,
        }),
      ),
      optional(riot<Loadout>('loadout', `${pd}/personalization/v2/players/${puuid}/playerloadout`, { headers: game })),
      optional(riot<{ Progress: { Level: number; XP: number } }>('account XP', `${pd}/account-xp/v1/players/${puuid}`, { headers: game })),
      optional(riot<Contracts>('contracts', `${pd}/contracts/v1/contracts/${puuid}`, { headers: game })),
    ]);

    const toItem = (offer: Offer, currency = VP, discountPercent = 0, discounted?: number): ShopItem => ({
      itemTypeId: offer.Rewards[0]?.ItemTypeID ?? '',
      itemId: offer.Rewards[0]?.ItemID ?? '',
      basePrice: offer.Cost[currency] ?? 0,
      price: discounted ?? offer.Cost[currency] ?? 0,
      discountPercent,
    });

    const shop: Shop = {
      daily: {
        items: store.SkinsPanelLayout.SingleItemStoreOffers.map((offer) => toItem(offer)),
        secondsLeft: store.SkinsPanelLayout.SingleItemOffersRemainingDurationInSeconds,
      },
      nightMarket: store.BonusStore
        ? {
            items: store.BonusStore.BonusStoreOffers.map((entry) =>
              toItem(entry.Offer, VP, entry.DiscountPercent, entry.DiscountCosts[VP]),
            ),
            secondsLeft: store.BonusStore.BonusStoreRemainingDurationInSeconds,
          }
        : null,
      accessories: store.AccessoryStore
        ? {
            items: store.AccessoryStore.AccessoryStoreOffers.map((entry) => toItem(entry.Offer, KINGDOM_CREDITS)),
            secondsLeft: store.AccessoryStore.AccessoryStoreRemainingDurationInSeconds,
          }
        : null,
      wallet: wallet && {
        vp: wallet.Balances[VP] ?? 0,
        radianite: wallet.Balances[RADIANITE] ?? 0,
        kingdomCredits: wallet.Balances[KINGDOM_CREDITS] ?? 0,
      },
      owned: owned && owned.EntitlementsByTypes.flatMap((type) => type.Entitlements.map((item) => item.ItemID.toLowerCase())),
      loadout: loadout && {
        guns: loadout.Guns.map((gun) => ({
          weaponId: gun.ID,
          skinId: gun.SkinID,
          levelId: gun.SkinLevelID,
          chromaId: gun.ChromaID,
          buddyLevelId: gun.CharmLevelID ?? null,
        })),
        sprayIds: loadout.Sprays.map((spray) => spray.SprayID),
        cardId: loadout.Identity.PlayerCardID,
        titleId: loadout.Identity.PlayerTitleID,
      },
      account: xp && { level: xp.Progress.Level, xp: xp.Progress.XP },
      contracts:
        contracts &&
        contracts.Contracts.map((contract) => ({
          id: contract.ContractDefinitionID,
          level: contract.ProgressionLevelReached,
          xpTowardsNext: contract.ProgressionTowardsNextLevel,
        })),
      missions:
        contracts &&
        contracts.Missions.map((mission) => ({
          id: mission.ID,
          // Missions have one objective in practice; add them up to be safe
          progress: Object.values(mission.Objectives).reduce((total, value) => total + value, 0),
          complete: mission.Complete,
          expires: mission.ExpirationTime,
        })),
    };

    // Personal data: never let a CDN or browser cache it
    return Response.json(shop, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof RiotError) return errorResponse(error.status, error.message);
    return errorResponse(502, "Couldn't reach Riot's servers");
  }
}

export default (request: Request) => fetchShop(request, process.env.SHOP_OWNER_KEY);

// Tell Netlify to run this function for /api/valorant-shop
export const config = { path: '/api/valorant-shop' };

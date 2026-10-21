/**
 * Data layer for the Valorant tracker: everything that fetches data lives here.
 *
 * Player data (account, rank, RR history, matches) and the featured store come
 * from the HenrikDev API, through our own /api/valorant proxy that adds the API
 * key (see netlify/functions/valorant.ts). Pictures and display names (rank icons,
 * agents, skins, titles) come straight from valorant-api.com, which needs no key.
 */

export type Platform = 'pc' | 'console';

// ---------------------------------------------------------------------------
// Shapes of the API responses (only the fields this page uses)
// ---------------------------------------------------------------------------

// A rank. id: 0 = Unranked, 3 = Iron 1, 4 = Iron 2, … 24 = Immortal 1, 27 = Radiant
export interface Tier {
  id: number;
  name: string;
}

export interface Account {
  puuid: string;
  region: string; // na, eu, ap, kr, latam or br
  account_level: number;
  name: string;
  tag: string;
  card: string; // player card ID, for the banner picture
  title: string; // player title ID
}

export interface Mmr {
  current: {
    tier: Tier;
    rr: number; // 0–100 within the current rank (keeps counting up from Immortal)
    last_change: number; // RR won or lost in the last ranked game
    elo: number;
    games_needed_for_rating: number;
    leaderboard_placement: { rank: number } | null;
  };
  peak: { season: { short: string }; tier: Tier; rr: number } | null;
  seasonal: { season: { short: string }; wins: number; games: number; end_tier: Tier; end_rr: number }[];
}

// One ranked game's effect on the player's rating
export interface MmrChange {
  match_id: string;
  date: string;
  map: { name: string };
  tier: Tier;
  rr: number;
  last_change: number;
  // Total rating: 100 per rank step from Iron 1 (= 0), plus RR. Gold 2 with 45 RR = 1045.
  elo: number;
}

export interface MatchPlayer {
  puuid: string;
  team_id: string;
  agent: { id: string; name: string };
  stats: {
    score: number;
    kills: number;
    deaths: number;
    assists: number;
    headshots: number;
    bodyshots: number;
    legshots: number;
    damage: { dealt: number };
  };
}

export interface Match {
  metadata: {
    match_id: string;
    map: { id: string; name: string };
    queue: { id: string; name: string | null };
    started_at: string;
  };
  players: MatchPlayer[];
  // Empty in free-for-all modes like Deathmatch
  teams: { team_id: string; won: boolean; rounds: { won: number; lost: number } }[];
  rounds: unknown[];
}

// A bundle in the featured store. Prices are in Valorant Points (VP).
export interface Bundle {
  DataAssetID: string; // bundle ID on valorant-api.com
  DurationRemainingInSeconds: number;
  Items: {
    Item: { ItemTypeID: string; ItemID: string; Amount: number };
    BasePrice: number;
    DiscountedPrice: number;
  }[];
}

// ---------------------------------------------------------------------------
// HenrikDev API (through our proxy)
// ---------------------------------------------------------------------------

// An error from the API, keeping the HTTP status so the page can explain it
// (404 = player not found, 429 = too many requests right now)
export class ApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function henrik<T>(path: string): Promise<T> {
  const response = await fetch(`/api/valorant/${path}`);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.errors?.[0]?.message ?? `Request failed (${response.status})`;
    throw new ApiError(message, response.status, Number(response.headers.get('Retry-After')) || undefined);
  }
  // Answers come wrapped as { status, data }
  return (body.data ?? body) as T;
}

// Names can contain spaces and other characters that aren't allowed in a URL as-is
const riotIdPath = (account: Pick<Account, 'name' | 'tag'>) =>
  `${encodeURIComponent(account.name)}/${encodeURIComponent(account.tag)}`;

export function getAccount(name: string, tag: string): Promise<Account> {
  return henrik(`v2/account/${riotIdPath({ name, tag })}`);
}

export function getMmr(account: Account, platform: Platform): Promise<Mmr> {
  return henrik(`v3/mmr/${account.region}/${platform}/${riotIdPath(account)}`);
}

// Newest game first
export async function getMmrHistory(account: Account, platform: Platform): Promise<MmrChange[]> {
  const data = await henrik<{ history: MmrChange[] }>(`v2/mmr-history/${account.region}/${platform}/${riotIdPath(account)}`);
  return data.history;
}

// Newest match first, every game mode
export function getMatches(account: Account, platform: Platform, size = 10): Promise<Match[]> {
  return henrik(`v4/matches/${account.region}/${platform}/${riotIdPath(account)}?size=${size}`);
}

// The featured bundles: the same for every player
export async function getFeaturedBundles(): Promise<Bundle[]> {
  const data = await henrik<{ FeaturedBundle: { Bundles: Bundle[] } }>('v1/store-featured');
  return data.FeaturedBundle.Bundles;
}

// ---------------------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------------------

const RANKS = ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal'];

// 3 -> "Iron 1", 4 -> "Iron 2", 5 -> "Iron 3", 6 -> "Bronze 1", … 27 -> "Radiant"
export function tierName(tier: number): string {
  if (tier < 3) return 'Unranked';
  if (tier >= 27) return 'Radiant';
  return `${RANKS[Math.floor((tier - 3) / 3)]} ${((tier - 3) % 3) + 1}`;
}

// Name for a total-rating value on the RR chart's axis. Below Immortal, every 100
// is a new rank; from Immortal 1 (2100) on, RR keeps counting up instead
// (that's the RR shown on the leaderboard).
export function eloLabel(elo: number): string {
  const immortal = 2100;
  return elo <= immortal ? tierName(elo / 100 + 3) : `${elo - immortal} RR`;
}

// ---------------------------------------------------------------------------
// Pictures and names from valorant-api.com
// ---------------------------------------------------------------------------

const MEDIA = 'https://media.valorant-api.com';
// The current set of rank icons (Riot redraws them every few episodes)
const TIER_SET = '03621f52-342b-cf4e-4f86-9350a49c6d04';

export const rankIcon = (tier: number) => `${MEDIA}/competitivetiers/${TIER_SET}/${tier}/largeicon.png`;
export const agentIcon = (agentId: string) => `${MEDIA}/agents/${agentId}/displayicon.png`;
export const cardBanner = (cardId: string) => `${MEDIA}/playercards/${cardId}/wideart.png`;
export const VP_ICON = `${MEDIA}/currencies/85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741/displayicon.png`;

async function valorantApi<T>(path: string): Promise<T> {
  const response = await fetch(`https://valorant-api.com/v1/${path}`);
  if (!response.ok) throw new Error(`valorant-api.com: ${response.status}`);
  return (await response.json()).data as T;
}

export async function getTitleText(titleId: string): Promise<string | null> {
  if (!titleId) return null;
  const title = await valorantApi<{ titleText: string | null }>(`playertitles/${titleId}`);
  return title.titleText;
}

export function getBundleInfo(bundleId: string): Promise<{ displayName: string; displayIcon: string | null }> {
  return valorantApi(`bundles/${bundleId}`);
}

// Store items say what kind of thing they are with an ItemTypeID.
// This maps each kind to its valorant-api.com lookup path and a readable label.
const ITEM_TYPES: Record<string, { path: string; label: string }> = {
  'e7c63390-eda7-46e0-bb7a-a6abdacd2433': { path: 'weapons/skinlevels', label: 'Skin' },
  'dd3bf334-87f3-40bd-b043-682a57a8dc3a': { path: 'buddies/levels', label: 'Gun buddy' },
  'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475': { path: 'sprays', label: 'Spray' },
  '3f296c07-64c3-494c-923b-fe692a4fa1bd': { path: 'playercards', label: 'Player card' },
  'de7caa6b-adf7-4588-bbd1-143831e786c6': { path: 'playertitles', label: 'Title' },
  '03a572de-4234-31ed-d344-ababa488f981': { path: 'flex', label: 'Flex' },
};

export interface ItemInfo {
  name: string;
  icon: string | null;
  kind: string;
}

export async function getItemInfo(itemTypeId: string, itemId: string): Promise<ItemInfo | null> {
  const type = ITEM_TYPES[itemTypeId];
  if (!type) return null;
  const item = await valorantApi<{ displayName: string; displayIcon?: string | null }>(`${type.path}/${itemId}`);
  return { name: item.displayName, icon: item.displayIcon ?? null, kind: type.label };
}

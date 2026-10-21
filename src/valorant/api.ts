/**
 * Data layer for the Valorant tracker: everything that fetches data lives here.
 *
 * Player data (account, rank, RR history, matches) and the featured store come
 * from the HenrikDev API, through our own /api/valorant proxy that adds the API
 * key (see netlify/functions/valorant.ts). Pictures and display names (rank icons,
 * agents, skins, titles) come straight from valorant-api.com, which needs no key.
 * A player's own daily shop comes from Riot, through /api/valorant-shop.
 */
import type { Shop } from '../../netlify/functions/valorant-shop';

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
  name: string;
  tag: string;
  tier: Tier;
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
  rounds: Round[];
}

// Deathmatch is every player for themselves, even though the API gives each player a "team"
export const isFreeForAll = (match: Match) => match.metadata.queue.id === 'deathmatch';

// One round of a match
export interface Round {
  id: number;
  result: string; // Elimination, Bomb detonated, Bomb defused, Round timer expired, Surrendered
  winning_team: string;
  first_blood?: { puuid: string } | null;
  stats: {
    player: { puuid: string; team: string };
    economy: { loadout_value: number; weapon: { name: string } | null; armor: { name: string } | null } | null;
  }[];
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
// The player's own shop (through /api/valorant-shop, see netlify/functions/valorant-shop.ts)
// ---------------------------------------------------------------------------

export type { Shop, ShopItem } from '../../netlify/functions/valorant-shop';

// Riot's own login page. After logging in it sends the player to playvalorant.com
// with the login tokens in the address (after the #), which they copy back to us.
// This is the same login the Valorant website uses, so we never see the password.
export const RIOT_LOGIN_URL =
  'https://auth.riotgames.com/authorize?' +
  new URLSearchParams({
    redirect_uri: 'https://playvalorant.com/opt_in',
    client_id: 'play-valorant-web-prod',
    response_type: 'token id_token',
    nonce: '1',
    scope: 'account openid',
  });

// The pasted address -> its two tokens, or null if they aren't in it
export function parseLoginLink(text: string): { accessToken: string; idToken: string } | null {
  const hash = text.trim().split('#')[1];
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const accessToken = params.get('access_token');
  const idToken = params.get('id_token');
  return accessToken && idToken ? { accessToken, idToken } : null;
}

// ownerKey: the site owner's secret (SHOP_OWNER_KEY); the server refuses anyone else
export async function getMyShop(tokens: { accessToken: string; idToken: string }, ownerKey: string): Promise<Shop> {
  const response = await fetch('/api/valorant-shop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Owner-Key': ownerKey },
    body: JSON.stringify(tokens),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(body?.errors?.[0]?.message ?? `Request failed (${response.status})`, response.status);
  return body as Shop;
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

// Everything below is the same for every visitor, so each list is fetched once
// per page visit and shared (the promise is kept, not the result)
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => {
    promise ??= load().catch((error) => {
      promise = undefined; // let the next caller try again
      throw error;
    });
    return promise;
  };
}

// IDs come in different upper/lower case from different APIs
const key = (id: string) => id.toLowerCase();

export interface Rarity {
  name: string; // Select, Deluxe, Premium, Exclusive, Ultra
  color: string; // CSS color
  icon: string;
}

export interface Chroma {
  uuid: string;
  displayName: string;
  displayIcon: string | null;
  fullRender: string | null;
  swatch: string | null;
  streamedVideo: string | null;
}

export interface Skin {
  uuid: string;
  displayName: string;
  displayIcon: string | null;
  weaponId: string;
  rarity: Rarity | null;
  levels: { uuid: string; displayName: string; levelItem: string | null; streamedVideo: string | null }[];
  chromas: Chroma[];
}

export interface Weapon {
  uuid: string;
  displayName: string;
  category: string; // Rifle, Sidearm, SMG, …
  displayIcon: string;
}

export interface Catalog {
  weapons: Map<string, Weapon>;
  skins: Map<string, Skin>;
  skinByLevel: Map<string, Skin>;
  skinByChroma: Map<string, Skin>;
}

// All weapons with all their skins: one big download (about 0.5 MB compressed),
// so it's only loaded when something needs it
export const getCatalog = once(async (): Promise<Catalog> => {
  interface RawWeapon {
    uuid: string;
    displayName: string;
    category: string;
    displayIcon: string;
    skins: (Omit<Skin, 'weaponId' | 'rarity'> & { contentTierUuid: string | null })[];
  }
  const [weapons, tiers] = await Promise.all([
    valorantApi<RawWeapon[]>('weapons'),
    valorantApi<{ uuid: string; devName: string; highlightColor: string; displayIcon: string }[]>('contenttiers'),
  ]);
  // highlightColor is RRGGBBAA with a faint alpha; use the solid color
  const rarities = new Map(tiers.map((tier) => [key(tier.uuid), { name: tier.devName, color: `#${tier.highlightColor.slice(0, 6)}`, icon: tier.displayIcon }]));

  const catalog: Catalog = { weapons: new Map(), skins: new Map(), skinByLevel: new Map(), skinByChroma: new Map() };
  for (const weapon of weapons) {
    catalog.weapons.set(key(weapon.uuid), {
      uuid: weapon.uuid,
      displayName: weapon.displayName,
      category: weapon.category.replace('EEquippableCategory::', ''),
      displayIcon: weapon.displayIcon,
    });
    for (const raw of weapon.skins) {
      const skin: Skin = {
        uuid: raw.uuid,
        displayName: raw.displayName,
        displayIcon: raw.displayIcon,
        weaponId: weapon.uuid,
        rarity: raw.contentTierUuid ? (rarities.get(key(raw.contentTierUuid)) ?? null) : null,
        levels: raw.levels,
        chromas: raw.chromas,
      };
      catalog.skins.set(key(skin.uuid), skin);
      for (const level of skin.levels) catalog.skinByLevel.set(key(level.uuid), skin);
      for (const chroma of skin.chromas) catalog.skinByChroma.set(key(chroma.uuid), skin);
    }
  }
  return catalog;
});

export interface Agent {
  name: string;
  icon: string;
  role: { name: string; icon: string } | null;
}

export const getAgents = once(async (): Promise<Map<string, Agent>> => {
  const agents = await valorantApi<{ uuid: string; displayName: string; displayIcon: string; role: { displayName: string; displayIcon: string } | null }[]>(
    'agents?isPlayableCharacter=true',
  );
  return new Map(
    agents.map((agent) => [
      key(agent.uuid),
      { name: agent.displayName, icon: agent.displayIcon, role: agent.role && { name: agent.role.displayName, icon: agent.role.displayIcon } },
    ]),
  );
});

export interface GameMap {
  name: string;
  listViewIcon: string | null; // a wide strip of the map, good as a background
  splash: string | null;
}

export const getMaps = once(async (): Promise<Map<string, GameMap>> => {
  const maps = await valorantApi<({ uuid: string; displayName: string } & Omit<GameMap, 'name'>)[]>('maps');
  return new Map(maps.map((map) => [key(map.uuid), { name: map.displayName, listViewIcon: map.listViewIcon, splash: map.splash }]));
});

export interface ContractDefinition {
  name: string;
  relationType: string | null; // "Season" for a battle pass, "Agent" for an agent's contract
  relationUuid: string | null; // the act (for a battle pass) or agent
  levelXp: number[]; // XP needed for each level, in order
}

export const getContractDefinitions = once(async (): Promise<Map<string, ContractDefinition>> => {
  const contracts = await valorantApi<
    { uuid: string; displayName: string; content: { relationType: string | null; relationUuid: string | null; chapters: { levels: { xp: number }[] }[] } }[]
  >('contracts');
  return new Map(
    contracts.map((contract) => [
      key(contract.uuid),
      {
        name: contract.displayName,
        relationType: contract.content.relationType,
        relationUuid: contract.content.relationUuid,
        levelXp: contract.content.chapters.flatMap((chapter) => chapter.levels.map((level) => level.xp)),
      },
    ]),
  );
});

export interface MissionDefinition {
  title: string;
  type: string; // Daily, Weekly, …
  progressToComplete: number;
  xpGrant: number;
}

export const getMissionDefinitions = once(async (): Promise<Map<string, MissionDefinition>> => {
  const missions = await valorantApi<{ uuid: string; title: string | null; type: string | null; progressToComplete: number; xpGrant: number }[]>('missions');
  return new Map(
    missions.map((mission) => [
      key(mission.uuid),
      {
        title: mission.title ?? 'Mission',
        type: (mission.type ?? '').replace('EAresMissionType::', ''),
        progressToComplete: mission.progressToComplete,
        xpGrant: mission.xpGrant,
      },
    ]),
  );
});

// The act that's on right now (its battle pass is the one to show)
export const getCurrentAct = once(async (): Promise<{ uuid: string; parentUuid: string | null; name: string } | null> => {
  const seasons = await valorantApi<{ uuid: string; displayName: string; type: string | null; startTime: string; endTime: string; parentUuid: string | null }[]>(
    'seasons',
  );
  const now = Date.now();
  const act = seasons.find(
    (season) => season.type === 'EAresSeasonType::Act' && Date.parse(season.startTime) <= now && now < Date.parse(season.endTime),
  );
  return act ? { uuid: act.uuid, parentUuid: act.parentUuid, name: act.displayName } : null;
});

export const lookUpKey = key;

export const KC_ICON = `${MEDIA}/currencies/85ca954a-41f2-ce94-9b45-8ca3dd39a00d/displayicon.png`;
export const RADIANITE_ICON = `${MEDIA}/currencies/e59aa87c-4cbf-517a-5983-6e81511be9b7/displayicon.png`;
export const cardSmall = (cardId: string) => `${MEDIA}/playercards/${cardId}/smallart.png`;
export const cardTall = (cardId: string) => `${MEDIA}/playercards/${cardId}/largeart.png`;

// ---------------------------------------------------------------------------
// Around the game: server status, news, esports, leaderboard, crosshairs (HenrikDev)
// ---------------------------------------------------------------------------

export type Region = 'eu' | 'na' | 'ap' | 'kr' | 'latam' | 'br';

interface Translation {
  locale: string;
  content: string;
}

export interface StatusEntry {
  id: number;
  incident_severity: string | null; // info, warning, critical
  maintenance_status: string | null;
  titles: Translation[];
  updates: { translations: Translation[]; created_at: string }[];
  created_at: string;
}

// Pick the English text, or whatever there is
export const english = (translations: Translation[]) =>
  (translations.find((t) => t.locale === 'en_US') ?? translations[0])?.content ?? '';

export function getStatus(region: Region): Promise<{ maintenances: StatusEntry[]; incidents: StatusEntry[] }> {
  return henrik(`v1/status/${region}`);
}

export interface NewsPost {
  title: string;
  banner_url: string | null;
  category: string;
  date: string;
  url: string;
  external_link: string | null;
}

export function getNews(): Promise<NewsPost[]> {
  return henrik('v1/website/en-us');
}

export interface EsportsMatch {
  date: string;
  state: string; // unstarted, inProgress, completed
  vod: string | null;
  league: { name: string; icon: string | null; region: string | null };
  tournament: { name: string };
  match: {
    game_type: { type: string | null; count: number | null };
    teams: { name: string; code: string; icon: string | null; has_won: boolean; game_wins: number }[];
  };
}

export function getEsportsSchedule(): Promise<EsportsMatch[]> {
  return henrik('v1/esports/schedule');
}

export interface LeaderboardPlayer {
  card: string;
  is_anonymized: boolean;
  name: string;
  tag: string;
  leaderboard_rank: number;
  tier: number;
  rr: number;
  wins: number;
}

export interface Leaderboard {
  thresholds: { tier: Tier; start_index: number; threshold: number }[];
  players: LeaderboardPlayer[];
}

// start: how many players to skip. With a Riot ID, finds that player instead.
export function getLeaderboard(region: Region, platform: Platform, start = 0, riotId?: { name: string; tag: string }): Promise<Leaderboard> {
  const query = new URLSearchParams({ size: '25' });
  if (riotId) {
    query.set('name', riotId.name);
    query.set('tag', riotId.tag);
  } else {
    query.set('start_index', String(start));
  }
  return henrik(`v3/leaderboard/${region}/${platform}?${query}`);
}

// A picture of a crosshair from its share code (Settings → Crosshair → Import Profile Code)
export const crosshairImage = (code: string) => `/api/valorant/v1/crosshair/generate?id=${encodeURIComponent(code)}`;

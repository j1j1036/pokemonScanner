/**
 * Valorant tracker entry point: builds the page and wires up the search.
 *
 * The flow of a lookup:
 *   api.ts       -> find the account by Riot ID (that tells us its region),
 *                   then load its rank, RR history and recent matches together
 *   chart.ts     -> draw the RR history
 *   matches.ts   -> the scoreboard and rounds under each match
 *   this file    -> show everything else
 *
 * The page has tabs: Player (the lookup and the featured store) plus the
 * Leaderboard, News, Esports and Crosshair tabs from explore.ts.
 * The featured store is the same for everyone, so it loads once, on page open.
 * The site owner also gets "My shop" in a sidebar (shop.ts).
 */
import './style.css';
import {
  agentIcon,
  cardBanner,
  getAccount,
  getAgents,
  getBundleInfo,
  getFeaturedBundles,
  getItemInfo,
  getMaps,
  getMatches,
  getMmr,
  getMmrHistory,
  getTitleText,
  isFreeForAll,
  lookUpKey,
  rankIcon,
} from './api';
import type { Account, Agent, Bundle, GameMap, ItemInfo, Match, Mmr, MmrChange, Platform, Region, Shop } from './api';
import { renderRrChart, signed } from './chart';
import { loadTab, showServerStatus } from './explore';
import type { ExploreTab } from './explore';
import { renderMatchDetails } from './matches';
import { initShop, loadedShop, ownerKey } from './shop';
import { findSkin, rarityIcon, rarityStyle } from './skins';
import { CHECK_ICON, errorMessage, escapeHtml, timeAgo, timeLeft, vp } from './util';

// ---------------------------------------------------------------------------
// Page layout
// ---------------------------------------------------------------------------

// valorant/index.html only contains an empty <div id="app">; we fill it in here
const app = document.querySelector<HTMLDivElement>('#app')!;

const TABS: { id: 'player' | ExploreTab; name: string }[] = [
  { id: 'player', name: 'Player' },
  { id: 'leaderboard', name: 'Leaderboard' },
  { id: 'news', name: 'News' },
  { id: 'esports', name: 'Esports' },
  { id: 'crosshair', name: 'Crosshair' },
];

app.innerHTML = `
  <a class="back" href="/">← My projects</a>
  <div class="layout">
  <main class="main">
  <header class="top">
    <h1>Valorant Tracker</h1>
    <p class="tagline">Ranks, matches, the store, leaderboards and more.</p>
  </header>

  <!-- Server problems or maintenance, if there are any -->
  <div id="server-status"></div>

  <nav class="tabs" role="tablist" aria-label="Sections">
    ${TABS.map((tab, index) => `<button type="button" role="tab" id="tab-${tab.id}" aria-controls="pane-${tab.id}"
      aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${tab.name}</button>`).join('')}
  </nav>

  <div id="pane-player" role="tabpanel" aria-labelledby="tab-player">
  <form id="search" class="search">
    <label class="riot-id">Riot ID
      <input id="riot-id" name="riotId" placeholder="Name#TAG" autocomplete="off" spellcheck="false" required />
    </label>
    <label>Platform
      <select id="platform" name="platform">
        <option value="pc">PC</option>
        <option value="console">Console</option>
      </select>
    </label>
    <button type="submit">Look up</button>
  </form>
  <div id="recent" class="recent"></div>

  <p id="status" class="status" role="status"></p>

  <!-- Filled in by a lookup -->
  <div id="player" class="player" hidden>
    <section id="profile" class="profile"></section>

    <section class="panel">
      <h2>Rank</h2>
      <div id="rank"></div>
    </section>

    <section class="panel">
      <h2>RR tracking</h2>
      <p class="sub">Rating after each recent ranked game. Hover or tab in to see each game.</p>
      <div id="rr-chart" class="chart"></div>
      <details id="rr-table" class="table-view" hidden>
        <summary>Show as a table</summary>
        <table>
          <thead><tr><th>Date</th><th>Map</th><th>Rank</th><th class="num">RR</th><th class="num">Change</th></tr></thead>
          <tbody></tbody>
        </table>
      </details>
    </section>

    <section class="panel">
      <h2>Recent matches</h2>
      <p class="sub">Click a match for the full scoreboard and every round.</p>
      <div id="match-summary" class="stats"></div>
      <ul id="matches" class="matches"></ul>
    </section>
  </div>

  <section class="panel">
    <h2>Store</h2>
    <p class="sub">
      The featured bundle, which is the same for every player. Click a skin to preview it.
    </p>
    <div id="store" class="store"><p class="muted">Loading the store…</p></div>
  </section>
  </div>

  ${TABS.slice(1)
    .map((tab) => `<div id="pane-${tab.id}" role="tabpanel" aria-labelledby="tab-${tab.id}" hidden></div>`)
    .join('')}
  </main>

  <!-- Only for the site owner (see shop.ts). Beside the page on wide screens. -->
  <aside id="my-shop-panel" class="sidebar" hidden></aside>
  </div>

  <footer class="credits">
    Unofficial fan project. Valorant Tracker isn’t endorsed by Riot Games and doesn’t reflect the views
    or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties.
    Data from the <a href="https://docs.henrikdev.xyz" target="_blank" rel="noopener">HenrikDev API</a>
    and <a href="https://valorant-api.com" target="_blank" rel="noopener">valorant-api.com</a>.
  </footer>
`;

// Grab references to the elements we just created
const searchForm = document.querySelector<HTMLFormElement>('#search')!;
const riotIdInput = document.querySelector<HTMLInputElement>('#riot-id')!;
const platformSelect = document.querySelector<HTMLSelectElement>('#platform')!;
const recentEl = document.querySelector<HTMLDivElement>('#recent')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const playerEl = document.querySelector<HTMLDivElement>('#player')!;
const profileEl = document.querySelector<HTMLElement>('#profile')!;
const rankEl = document.querySelector<HTMLDivElement>('#rank')!;
const chartEl = document.querySelector<HTMLDivElement>('#rr-chart')!;
const rrTable = document.querySelector<HTMLDetailsElement>('#rr-table')!;
const summaryEl = document.querySelector<HTMLDivElement>('#match-summary')!;
const matchesEl = document.querySelector<HTMLUListElement>('#matches')!;
const storeEl = document.querySelector<HTMLDivElement>('#store')!;
const serverStatusEl = document.querySelector<HTMLDivElement>('#server-status')!;
const myShopPanel = document.querySelector<HTMLElement>('#my-shop-panel')!;

// Counts lookups, so a slow answer for an older lookup can't overwrite a newer one
let currentLookup = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function setStatus(message: string): void {
  statusEl.textContent = message;
}

// A missing picture (e.g. a new agent valorant-api.com doesn't have yet)
// just disappears instead of showing a broken-image icon
document.addEventListener(
  'error',
  (event) => {
    if (event.target instanceof HTMLImageElement) event.target.hidden = true;
  },
  true,
);

// "Name#TAG" -> { name: "Name", tag: "TAG" }. Names can contain "#"-free spaces,
// so split at the last "#".
function parseRiotId(text: string): { name: string; tag: string } | null {
  const hash = text.lastIndexOf('#');
  const name = text.slice(0, hash).trim();
  const tag = text.slice(hash + 1).trim();
  return hash > 0 && name && tag ? { name, tag } : null;
}

// "e9a3" -> "E9 A3"
function actName(short: string): string {
  return short.toUpperCase().replace(/(\d)A/, '$1 A');
}

// CSS class for a gain (green) or loss (red)
const changeClass = (value: number) => (value > 0 ? 'up' : value < 0 ? 'down' : '');

// ---------------------------------------------------------------------------
// Recent lookups (kept in this browser only)
// ---------------------------------------------------------------------------

interface RecentLookup {
  riotId: string;
  platform: Platform;
}

const RECENT_KEY = 'valorant-recent';

// Storage can be unavailable (private browsing, blocked cookies), so every
// read and write is wrapped in try/catch; the page works fine without it
function loadRecent(): RecentLookup[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveRecent(lookup: RecentLookup): void {
  const others = loadRecent().filter((r) => r.riotId.toLowerCase() !== lookup.riotId.toLowerCase() || r.platform !== lookup.platform);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([lookup, ...others].slice(0, 5)));
  } catch {
    // Not saved; nothing else to do
  }
  renderRecent();
}

function renderRecent(): void {
  const recent = loadRecent();
  recentEl.replaceChildren(
    ...recent.map((lookup) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.textContent = lookup.platform === 'console' ? `${lookup.riotId} (console)` : lookup.riotId;
      button.addEventListener('click', () => {
        riotIdInput.value = lookup.riotId;
        platformSelect.value = lookup.platform;
        void lookUp(lookup.riotId, lookup.platform);
      });
      return button;
    }),
  );
}

// ---------------------------------------------------------------------------
// Looking up a player
// ---------------------------------------------------------------------------

async function lookUp(riotId: string, platform: Platform): Promise<void> {
  const parsed = parseRiotId(riotId);
  if (!parsed) {
    setStatus('Type the full Riot ID with the tag, like Name#TAG.');
    return;
  }

  const lookup = ++currentLookup;
  setStatus(`Looking up ${riotId}…`);
  playerEl.hidden = true;

  let account: Account;
  try {
    account = await getAccount(parsed.name, parsed.tag);
  } catch (error) {
    if (lookup === currentLookup) setStatus(errorMessage(error, "Couldn't find that player. Check the name and the tag after the #."));
    return;
  }
  if (lookup !== currentLookup) return;

  // Use the spelling the API returns, and put it in the address bar so the page can be shared
  const canonical = `${account.name}#${account.tag}`;
  saveRecent({ riotId: canonical, platform });
  history.replaceState(null, '', `?player=${encodeURIComponent(canonical)}&platform=${platform}`);
  document.title = `${canonical} · Valorant Tracker`;

  setStatus('');
  void showServerStatus(serverStatusEl, account.region as Region);
  renderProfile(account, platform);
  rankEl.innerHTML = '<p class="muted">Loading rank…</p>';
  chartEl.replaceChildren();
  chartEl.innerHTML = '<p class="muted">Loading RR history…</p>';
  rrTable.hidden = true;
  summaryEl.replaceChildren();
  matchesEl.innerHTML = '<li class="muted">Loading matches…</li>';
  playerEl.hidden = false;

  // Load the three in parallel; each section shows its own result or error
  const [mmr, rrHistory, matches] = await Promise.allSettled([
    getMmr(account, platform),
    getMmrHistory(account, platform),
    getMatches(account, platform),
  ]);
  if (lookup !== currentLookup) return;

  if (mmr.status === 'fulfilled') renderRank(mmr.value);
  else rankEl.innerHTML = `<p class="muted">${escapeHtml(errorMessage(mmr.reason, 'No rank data for this player yet.'))}</p>`;

  const changes = rrHistory.status === 'fulfilled' ? rrHistory.value : [];
  if (rrHistory.status === 'rejected') {
    chartEl.innerHTML = `<p class="muted">${escapeHtml(errorMessage(rrHistory.reason, 'No ranked games found yet.'))}</p>`;
  } else {
    renderRrHistory(changes);
  }

  if (matches.status === 'fulfilled') {
    // Agent roles and map pictures are extras; matches still show without them
    const [agents, maps] = await Promise.all([getAgents().catch(() => null), getMaps().catch(() => null)]);
    if (lookup !== currentLookup) return;
    renderMatches(matches.value, account, changes, agents, maps);
  }
  else matchesEl.innerHTML = `<li class="muted">${escapeHtml(errorMessage(matches.reason, 'No recent matches found.'))}</li>`;
}

// ---------------------------------------------------------------------------
// Drawing the player's sections
// ---------------------------------------------------------------------------

function renderProfile(account: Account, platform: Platform): void {
  profileEl.innerHTML = `
    <img class="banner" src="${escapeHtml(cardBanner(account.card))}" alt="" />
    <div class="profile-body">
      <h2>${escapeHtml(account.name)}<span class="tag">#${escapeHtml(account.tag)}</span></h2>
      <p class="muted"><span id="player-title"></span>Level ${account.account_level}
        · ${escapeHtml(account.region.toUpperCase())} · ${platform === 'pc' ? 'PC' : 'Console'}</p>
    </div>
  `;
  // The title ("Tiger", "Ace Up My Sleeve", …) is a nice extra, so it loads on its own
  const titleEl = profileEl.querySelector<HTMLSpanElement>('#player-title')!;
  getTitleText(account.title)
    .then((text) => {
      if (text) titleEl.textContent = `${text} · `;
    })
    .catch(() => {});
}

function renderRank(mmr: Mmr): void {
  const { current, peak } = mmr;
  const unranked = current.tier.id === 0;

  const progress = unranked
    ? `<p class="muted">${
        current.games_needed_for_rating > 0
          ? `${current.games_needed_for_rating} more ranked games to get a rank`
          : 'No rank this act'
      }</p>`
    : `<div class="rr-bar" role="progressbar" aria-label="RR in this rank" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow="${Math.min(current.rr, 100)}"><span style="width: ${Math.min(current.rr, 100)}%"></span></div>
       <p><strong>${current.rr} RR</strong>
         <span class="${changeClass(current.last_change)}">${signed(current.last_change)} last game</span></p>`;

  // Acts with games played, newest first
  const seasons = mmr.seasonal
    .filter((season) => season.games > 0)
    .reverse()
    .slice(0, 6);

  rankEl.innerHTML = `
    <div class="rank-row">
      <div class="rank-now">
        <img src="${rankIcon(current.tier.id)}" alt="" />
        <div>
          <p class="rank-name">${escapeHtml(current.tier.name)}</p>
          ${progress}
          ${current.leaderboard_placement ? `<p class="muted">#${current.leaderboard_placement.rank} on the leaderboard</p>` : ''}
        </div>
      </div>
      ${
        peak
          ? `<div class="rank-peak">
              <img src="${rankIcon(peak.tier.id)}" alt="" />
              <div>
                <p class="label">Peak rank</p>
                <p>${escapeHtml(peak.tier.name)} <span class="muted">${escapeHtml(actName(peak.season.short))}</span></p>
              </div>
            </div>`
          : ''
      }
    </div>
    ${
      seasons.length
        ? `<table class="seasons">
            <thead><tr><th>Act</th><th>Final rank</th><th class="num">Wins</th></tr></thead>
            <tbody>${seasons
              .map(
                (season) => `<tr>
                  <td>${escapeHtml(actName(season.season.short))}</td>
                  <td><span class="tier"><img src="${rankIcon(season.end_tier.id)}" alt="" />${escapeHtml(season.end_tier.name)}</span></td>
                  <td class="num">${season.wins} / ${season.games}
                    <span class="muted">(${Math.round((season.wins / season.games) * 100)}%)</span></td>
                </tr>`,
              )
              .join('')}</tbody>
          </table>`
        : ''
    }
  `;
}

const tableDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function renderRrHistory(changes: MmrChange[]): void {
  if (!changes.length) {
    chartEl.innerHTML = '<p class="muted">No ranked games found yet.</p>';
    return;
  }
  renderRrChart(chartEl, changes);

  // The same numbers as a table, for anyone who can't or doesn't want to use the chart
  rrTable.querySelector('tbody')!.innerHTML = changes
    .map(
      (change) => `<tr>
        <td>${tableDate.format(new Date(change.date))}</td>
        <td>${escapeHtml(change.map.name)}</td>
        <td>${escapeHtml(change.tier.name)}</td>
        <td class="num">${change.rr}</td>
        <td class="num ${changeClass(change.last_change)}">${signed(change.last_change)}</td>
      </tr>`,
    )
    .join('');
  rrTable.hidden = false;
}

function renderMatches(
  matches: Match[],
  account: Account,
  changes: MmrChange[],
  agents: Map<string, Agent> | null,
  maps: Map<string, GameMap> | null,
): void {
  // RR won or lost per match, for the ranked games in the history
  const rrByMatch = new Map(changes.map((change) => [change.match_id, change.last_change]));

  // Pull out what we show for each match, from this player's point of view
  const games = matches.flatMap((match) => {
    const player = match.players.find((p) => p.puuid === account.puuid);
    if (!player) return [];
    const team = isFreeForAll(match) ? undefined : match.teams.find((t) => t.team_id === player.team_id);
    const rounds = Math.max(match.rounds.length, 1);
    const { stats } = player;
    const shots = stats.headshots + stats.bodyshots + stats.legshots;
    // No team in free-for-all modes; a draw is a lost "won" flag with equal rounds
    const result: 'win' | 'loss' | 'draw' | null = !team
      ? null
      : team.won
        ? 'win'
        : team.rounds.won === team.rounds.lost
          ? 'draw'
          : 'loss';
    return [
      {
        match,
        player,
        team,
        result,
        acs: Math.round(stats.score / rounds),
        adr: Math.round(stats.damage.dealt / rounds),
        headshotPercent: shots ? Math.round((stats.headshots / shots) * 100) : 0,
        rrChange: rrByMatch.get(match.metadata.match_id),
      },
    ];
  });

  if (!games.length) {
    summaryEl.replaceChildren();
    matchesEl.innerHTML = '<li class="muted">No recent matches found.</li>';
    return;
  }

  // Totals over the loaded matches
  const decided = games.filter((game) => game.result === 'win' || game.result === 'loss');
  const wins = decided.filter((game) => game.result === 'win').length;
  const sum = (pick: (game: (typeof games)[number]) => number) => games.reduce((total, game) => total + pick(game), 0);
  const deaths = sum((game) => game.player.stats.deaths);
  const kd = sum((game) => game.player.stats.kills) / Math.max(deaths, 1);
  const shots = sum((game) => game.player.stats.headshots + game.player.stats.bodyshots + game.player.stats.legshots);
  const headshots = sum((game) => game.player.stats.headshots);
  const rounds = sum((game) => Math.max(game.match.rounds.length, 1));
  const damage = sum((game) => game.player.stats.damage.dealt);

  // Most played agents, e.g. "Jett ×4, Sova ×2"
  const agentCounts = new Map<string, number>();
  for (const game of games) agentCounts.set(game.player.agent.name, (agentCounts.get(game.player.agent.name) ?? 0) + 1);
  // Most played role (Duelist, Initiator, …), when the agent list loaded
  const roleCounts = new Map<string, number>();
  for (const game of games) {
    const role = agents?.get(lookUpKey(game.player.agent.id))?.role?.name;
    if (role) roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
  }
  const topRole = [...roleCounts].sort((a, b) => b[1] - a[1])[0]?.[0];

  const topAgents = [...agentCounts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `${escapeHtml(name)} ×${count}`)
    .join(', ');

  const tile = (label: string, value: string, note = '') =>
    `<div class="stat"><p class="label">${label}</p><p class="value">${value}</p>${note ? `<p class="muted">${note}</p>` : ''}</div>`;
  summaryEl.innerHTML = `
    ${tile('Win rate', decided.length ? `${Math.round((wins / decided.length) * 100)}%` : '–', `${wins}W ${decided.length - wins}L`)}
    ${tile('K/D', kd.toFixed(2))}
    ${tile('Headshot %', shots ? `${Math.round((headshots / shots) * 100)}%` : '–')}
    ${tile('Damage / round', String(Math.round(damage / rounds)))}
    <p class="agents muted">Last ${games.length} matches · Most played: ${topAgents}${topRole ? ` · Mostly ${escapeHtml(topRole)}` : ''}</p>
  `;

  const resultLabel = { win: 'Win', loss: 'Loss', draw: 'Draw' };
  matchesEl.innerHTML = games
    .map(({ match, player, team, result, acs, adr, headshotPercent, rrChange }, index) => {
      const { kills, deaths, assists } = player.stats;
      const mode = match.metadata.queue.name ?? match.metadata.queue.id;
      const map = maps?.get(lookUpKey(match.metadata.map.id));
      const role = agents?.get(lookUpKey(player.agent.id))?.role;
      // The whole row is a button that opens the details under it
      return `<li class="match-item">
        <button type="button" class="match ${result ?? ''}" aria-expanded="false" aria-controls="match-${index}"
          ${map?.listViewIcon ? `style="--map: url('${escapeHtml(map.listViewIcon)}')"` : ''}>
          <span class="agent-wrap">
            <img class="agent" src="${escapeHtml(agentIcon(player.agent.id))}" alt="${escapeHtml(player.agent.name)}" />
            ${role ? `<img class="role" src="${escapeHtml(role.icon)}" alt="${escapeHtml(role.name)}" title="${escapeHtml(role.name)}" />` : ''}
          </span>
          <span class="match-main">
            <span class="match-title">${escapeHtml(match.metadata.map.name)} <span class="muted">· ${escapeHtml(mode)}</span></span>
            <span class="muted">${escapeHtml(player.agent.name)} · ${timeAgo(match.metadata.started_at)}</span>
          </span>
          <span class="match-result">
            ${result ? `<span class="result">${resultLabel[result]}${team ? ` ${team.rounds.won}–${team.rounds.lost}` : ''}</span>` : ''}
            ${rrChange !== undefined ? `<span class="${changeClass(rrChange)}">${signed(rrChange)} RR</span>` : ''}
          </span>
          <span class="match-stats">
            <span class="kda">${kills} / ${deaths} / ${assists}</span>
            <span class="muted">${
              // Deathmatch counts as one long round, so per-round numbers mean nothing there
              isFreeForAll(match) ? `Score ${player.stats.score.toLocaleString('en')}` : `ACS ${acs} · ADR ${adr} · HS ${headshotPercent}%`
            }</span>
          </span>
        </button>
        <div class="match-details" id="match-${index}" hidden></div>
      </li>`;
    })
    .join('');

  // Open a match: draw its details the first time
  matchesEl.querySelectorAll<HTMLButtonElement>('button.match').forEach((button, index) => {
    button.addEventListener('click', () => {
      const details = button.nextElementSibling as HTMLDivElement;
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(open));
      details.hidden = !open;
      if (open && !details.hasChildNodes()) details.innerHTML = renderMatchDetails(games[index].match, account.puuid, agents);
    });
  });
}

// Clicking a name on a scoreboard looks that player up
matchesEl.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-player]');
  if (button) showPlayer(button.dataset.player!, platformSelect.value as Platform);
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface BundleDetails {
  bundle: Bundle;
  info: { displayName: string; displayIcon: string | null } | null;
  items: { entry: Bundle['Items'][number]; info: ItemInfo | null }[];
}

let storeDetails: BundleDetails[] | null = null;

async function loadStore(): Promise<void> {
  let bundles: Bundle[];
  try {
    bundles = await getFeaturedBundles();
  } catch (error) {
    storeEl.innerHTML = `<p class="muted">${escapeHtml(errorMessage(error, 'The store is empty right now.'))}</p>`;
    return;
  }
  if (!bundles.length) {
    storeEl.innerHTML = '<p class="muted">The store is empty right now.</p>';
    return;
  }

  // Names and pictures come from valorant-api.com; anything it can't find is left out
  storeDetails = await Promise.all(
    bundles.map(async (bundle) => ({
      bundle,
      info: await getBundleInfo(bundle.DataAssetID).catch(() => null),
      items: await Promise.all(
        bundle.Items.map(async (entry) => ({
          entry,
          info: await getItemInfo(entry.Item.ItemTypeID, entry.Item.ItemID).catch(() => null),
        })),
      ),
    })),
  );
  await renderStore();
}

const SKIN_TYPE = 'e7c63390-eda7-46e0-bb7a-a6abdacd2433';

// Drawn again when the owner's shop loads, to mark what they already own
async function renderStore(): Promise<void> {
  if (!storeDetails) return;
  const shop: Shop | null = loadedShop;
  const owned = (itemId: string) => shop?.owned?.includes(lookUpKey(itemId)) ?? false;

  // Rarity colors for the skins; drawn without them if the skin list doesn't load
  const skins = new Map(
    await Promise.all(
      storeDetails.flatMap(({ items }) =>
        items
          .filter(({ entry }) => entry.Item.ItemTypeID === SKIN_TYPE)
          .map(async ({ entry }) => [entry.Item.ItemID, await findSkin(entry.Item.ItemID).catch(() => null)] as const),
      ),
    ),
  );

  storeEl.innerHTML = storeDetails
    .map(({ bundle, info, items }) => {
      const price = bundle.Items.reduce((total, entry) => total + entry.DiscountedPrice, 0);
      // What buying the items you don't have yet would cost, item by item
      const missingPrice = bundle.Items.reduce((total, entry) => total + (owned(entry.Item.ItemID) ? 0 : entry.DiscountedPrice), 0);
      const known = items.filter((item) => item.info);
      return `<article class="bundle">
        ${info?.displayIcon ? `<img class="bundle-art" src="${escapeHtml(info.displayIcon)}" alt="" />` : ''}
        <div class="bundle-head">
          <div>
            <h3>${escapeHtml(info?.displayName ?? 'Featured bundle')}</h3>
            <p class="muted">Leaves the store in ${timeLeft(bundle.DurationRemainingInSeconds)}</p>
          </div>
          <div class="bundle-price">
            <p>${vp(price)}</p>
            ${
              shop?.owned && missingPrice !== price
                ? `<p class="muted small">Without what you own: ${vp(missingPrice)}</p>`
                : ''
            }
            ${
              shop?.wallet
                ? `<p class="small ${shop.wallet.vp >= price ? 'up' : 'muted'}">You have ${vp(shop.wallet.vp)}</p>`
                : ''
            }
          </div>
        </div>
        <ul class="items">${known
          .map(({ entry, info: item }) => {
            const skin = skins.get(entry.Item.ItemID);
            const clickable = skin ? `data-skin="${escapeHtml(entry.Item.ItemID)}" tabindex="0" role="button" aria-label="${escapeHtml(item!.name)}. Show preview"` : '';
            return `<li class="${skin ? 'has-rarity' : ''} ${owned(entry.Item.ItemID) ? 'is-owned' : ''}" ${rarityStyle(skin)} ${clickable}>
              ${rarityIcon(skin)}
              ${owned(entry.Item.ItemID) ? `<span class="owned-mark" title="You own this">${CHECK_ICON}</span>` : ''}
              ${item!.icon ? `<img class="item-icon" src="${escapeHtml(item!.icon)}" alt="" />` : '<span class="item-icon"></span>'}
              <p>${escapeHtml(item!.name)}</p>
              <p class="muted">${item!.kind}${entry.DiscountedPrice ? ` · ${vp(entry.DiscountedPrice)}` : ' · included'}</p>
            </li>`;
          })
          .join('')}</ul>
      </article>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"][id^="tab-"]')];

function openTab(id: string): void {
  for (const button of tabButtons) {
    const selected = button.id === `tab-${id}`;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    document.querySelector<HTMLElement>(`#pane-${button.id.slice(4)}`)!.hidden = !selected;
  }
  if (id !== 'player') loadTab(id as ExploreTab, document.querySelector(`#pane-${id}`)!, showPlayer);
}

// Look a player up from another tab (leaderboard, scoreboards)
function showPlayer(riotId: string, platform: Platform): void {
  openTab('player');
  riotIdInput.value = riotId;
  platformSelect.value = platform;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  void lookUp(riotId, platform);
}

for (const button of tabButtons) {
  button.addEventListener('click', () => openTab(button.id.slice(4)));
  // Arrow keys move between tabs, like in any tab list
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabButtons.indexOf(button);
    const next = tabButtons[(index + (event.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
    next.focus();
    openTab(next.id.slice(4));
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

searchForm.addEventListener('submit', (event) => {
  // Stop the browser from reloading the page on submit
  event.preventDefault();
  void lookUp(riotIdInput.value.trim(), platformSelect.value as Platform);
});

// The owner gets the wider page with "My shop" beside it (see .with-sidebar in style.css)
if (ownerKey) {
  myShopPanel.hidden = false;
  app.classList.add('with-sidebar');
  initShop(myShopPanel);
  document.addEventListener('myshop', () => void renderStore());
}

renderRecent();
void loadStore();
void showServerStatus(serverStatusEl, 'eu');

// A shared link like ?player=Name%23TAG&platform=pc looks that player up straight away
const params = new URLSearchParams(location.search);
const sharedPlayer = params.get('player');
if (sharedPlayer) {
  const platform: Platform = params.get('platform') === 'console' ? 'console' : 'pc';
  riotIdInput.value = sharedPlayer;
  platformSelect.value = platform;
  void lookUp(sharedPlayer, platform);
}

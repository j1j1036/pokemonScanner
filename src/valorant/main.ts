/**
 * Valorant tracker entry point: builds the page and wires up the search.
 *
 * The flow of a lookup:
 *   api.ts       -> find the account by Riot ID (that tells us its region),
 *                   then load its rank, RR history and recent matches together
 *   chart.ts     -> draw the RR history
 *   this file    -> show everything else
 *
 * The featured store is the same for everyone, so it loads once, on page open.
 * The player's own daily shop needs their Riot login, so it loads only when
 * they paste in the link from Riot's login page. That panel is only for the
 * site owner: it appears after opening the page once with #key=<SHOP_OWNER_KEY>.
 */
import './style.css';
import {
  ApiError,
  VP_ICON,
  agentIcon,
  cardBanner,
  getAccount,
  getBundleInfo,
  getFeaturedBundles,
  getItemInfo,
  getMatches,
  getMmr,
  getMmrHistory,
  getMyShop,
  getTitleText,
  parseLoginLink,
  rankIcon,
  RIOT_LOGIN_URL,
} from './api';
import type { Account, Bundle, Match, Mmr, MmrChange, Platform, ShopItem } from './api';
import { renderRrChart, signed } from './chart';

// ---------------------------------------------------------------------------
// Page layout
// ---------------------------------------------------------------------------

// Small inline icons; they take the text color
const LOCK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/></svg>';
const CLOCK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 2a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm.75 1.5V7.7l2.1 1.2-.75 1.3L7.25 8.6V4.5h1.5Z"/></svg>';
const EXTERNAL_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9 2h5v5h-1.5V4.56L7.53 9.53 6.47 8.47l4.97-4.97H9V2ZM3.5 4H7v1.5H3.5v7h7V9H12v3.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4Z"/></svg>';

// valorant/index.html only contains an empty <div id="app">; we fill it in here
const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <a class="back" href="/">← My projects</a>
  <div class="layout">
  <main class="main">
  <header class="top">
    <h1>Valorant Tracker</h1>
    <p class="tagline">Look up any player’s rank, RR and recent matches.</p>
  </header>

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
      <div id="match-summary" class="stats"></div>
      <ul id="matches" class="matches"></ul>
    </section>
  </div>

  <section class="panel">
    <h2>Store</h2>
    <p class="sub">
      The featured bundle, which is the same for every player.
    </p>
    <div id="store" class="store"><p class="muted">Loading the store…</p></div>
  </section>

  </main>

  <!-- Only for the site owner (see setUpOwnerKey). Beside the page on wide screens. -->
  <aside id="my-shop-panel" class="sidebar" hidden>
    <section class="panel shop-panel">
      <div class="shop-title">
        <h2>My shop</h2>
        <span class="private">${LOCK_ICON}Only you</span>
      </div>

      <div id="shop-login">
        <p class="sub">Your daily offers and Night Market. Log in on Riot’s site, then paste the link you land on.</p>
        <ol class="steps">
          <li>
            <span class="step-num">1</span>
            <a class="riot-login" href="${RIOT_LOGIN_URL}" target="_blank" rel="noopener">Log in with Riot ${EXTERNAL_ICON}</a>
          </li>
          <li>
            <span class="step-num">2</span>
            <p>Copy the whole address from <strong>playvalorant.com</strong></p>
          </li>
          <li>
            <span class="step-num">3</span>
            <form id="shop-form" class="shop-form">
              <label class="visually-hidden" for="shop-link">Link from the address bar</label>
              <input id="shop-link" name="link" type="password" placeholder="Paste the link here"
                autocomplete="off" spellcheck="false" required />
              <button type="submit">Show my shop</button>
            </form>
          </li>
        </ol>
        <p class="fine-print">The login lasts about an hour and is never saved.</p>
      </div>

      <p id="shop-status" class="status" role="status"></p>
      <div id="my-shop" class="my-shop"></div>
    </section>
  </aside>
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
const myShopPanel = document.querySelector<HTMLElement>('#my-shop-panel')!;
const shopLoginEl = document.querySelector<HTMLDivElement>('#shop-login')!;
const shopForm = document.querySelector<HTMLFormElement>('#shop-form')!;
const shopLinkInput = document.querySelector<HTMLInputElement>('#shop-link')!;
const shopStatusEl = document.querySelector<HTMLParagraphElement>('#shop-status')!;
const myShopEl = document.querySelector<HTMLDivElement>('#my-shop')!;

// Counts lookups, so a slow answer for an older lookup can't overwrite a newer one
let currentLookup = 0;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function setStatus(message: string): void {
  statusEl.textContent = message;
}

// Make text safe to put inside innerHTML: turns "<" into "&lt;" and so on,
// so a player name can never be interpreted as HTML.
// Quotes are escaped too, so it's also safe inside attributes like src="..." and alt="..."
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// Explain an error in plain words. `notFound` is what a 404 means in that place.
function errorMessage(error: unknown, notFound: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return notFound;
    if (error.status === 429) return `Too many lookups right now. Try again in ${error.retryAfter ?? 60} seconds.`;
    return error.message;
  }
  return "Couldn't reach the server. Check your connection and try again.";
}

// "e9a3" -> "E9 A3"
function actName(short: string): string {
  return short.toUpperCase().replace(/(\d)A/, '$1 A');
}

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// An ISO date -> "3 hours ago", "yesterday", …
function timeAgo(date: string): string {
  const seconds = (new Date(date).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

// 200000 -> "2d 7h", 7000 -> "1h 56m"
function timeLeft(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

// A price in Valorant Points, with the VP icon
const vp = (amount: number) => `<span class="vp"><img src="${VP_ICON}" alt="" />${amount.toLocaleString('en')}</span>`;

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

  if (matches.status === 'fulfilled') renderMatches(matches.value, account, changes);
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

function renderMatches(matches: Match[], account: Account, changes: MmrChange[]): void {
  // RR won or lost per match, for the ranked games in the history
  const rrByMatch = new Map(changes.map((change) => [change.match_id, change.last_change]));

  // Pull out what we show for each match, from this player's point of view
  const games = matches.flatMap((match) => {
    const player = match.players.find((p) => p.puuid === account.puuid);
    if (!player) return [];
    const team = match.teams.find((t) => t.team_id === player.team_id);
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
    <p class="agents muted">Last ${games.length} matches · Most played: ${topAgents}</p>
  `;

  const resultLabel = { win: 'Win', loss: 'Loss', draw: 'Draw' };
  matchesEl.innerHTML = games
    .map(({ match, player, team, result, acs, adr, headshotPercent, rrChange }) => {
      const { kills, deaths, assists } = player.stats;
      const mode = match.metadata.queue.name ?? match.metadata.queue.id;
      return `<li class="match ${result ?? ''}">
        <img class="agent" src="${escapeHtml(agentIcon(player.agent.id))}" alt="${escapeHtml(player.agent.name)}" />
        <div class="match-main">
          <p class="match-title">${escapeHtml(match.metadata.map.name)} <span class="muted">· ${escapeHtml(mode)}</span></p>
          <p class="muted">${escapeHtml(player.agent.name)} · ${timeAgo(match.metadata.started_at)}</p>
        </div>
        <div class="match-result">
          ${result ? `<p class="result">${resultLabel[result]}${team ? ` ${team.rounds.won}–${team.rounds.lost}` : ''}</p>` : ''}
          ${rrChange !== undefined ? `<p class="${changeClass(rrChange)}">${signed(rrChange)} RR</p>` : ''}
        </div>
        <div class="match-stats">
          <p class="kda">${kills} / ${deaths} / ${assists}</p>
          <p class="muted">ACS ${acs} · ADR ${adr} · HS ${headshotPercent}%</p>
        </div>
      </li>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

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
  const details = await Promise.all(
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

  storeEl.innerHTML = details
    .map(({ bundle, info, items }) => {
      const price = bundle.Items.reduce((total, entry) => total + entry.DiscountedPrice, 0);
      const known = items.filter((item) => item.info);
      return `<article class="bundle">
        ${info?.displayIcon ? `<img class="bundle-art" src="${escapeHtml(info.displayIcon)}" alt="" />` : ''}
        <div class="bundle-head">
          <div>
            <h3>${escapeHtml(info?.displayName ?? 'Featured bundle')}</h3>
            <p class="muted">Leaves the store in ${timeLeft(bundle.DurationRemainingInSeconds)}</p>
          </div>
          <p class="bundle-price">${vp(price)}</p>
        </div>
        <ul class="items">${known
          .map(
            ({ entry, info: item }) => `<li>
              ${item!.icon ? `<img class="item-icon" src="${escapeHtml(item!.icon)}" alt="" />` : '<span class="item-icon"></span>'}
              <p>${escapeHtml(item!.name)}</p>
              <p class="muted">${item!.kind}${entry.DiscountedPrice ? ` · ${vp(entry.DiscountedPrice)}` : ' · included'}</p>
            </li>`,
          )
          .join('')}</ul>
      </article>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// The player's own shop
// ---------------------------------------------------------------------------

const OWNER_KEY = 'valorant-owner-key';

// Opening the page with #key=… remembers the owner key in this browser
// (#key= with nothing after it forgets it). The part after # is never sent to
// any server, so the key doesn't end up in logs. Returns the key, if any.
function setUpOwnerKey(): string | null {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('key');
  if (fromLink !== null) {
    try {
      if (fromLink) localStorage.setItem(OWNER_KEY, fromLink);
      else localStorage.removeItem(OWNER_KEY);
    } catch {
      // Not saved; it still works for this visit
    }
    // Take the key out of the address bar so it isn't shared by accident
    history.replaceState(null, '', location.pathname + location.search);
    return fromLink || null;
  }
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}

const ownerKey = setUpOwnerKey();
myShopPanel.hidden = !ownerKey;
// Makes the page wider, with the shop beside it (see .with-sidebar in style.css)
app.classList.toggle('with-sidebar', !!ownerKey);

// While the shop loads: grey placeholder cards in its shape
const SKELETON = `<ul class="offers">${'<li class="offer skeleton"><div class="offer-art"></div><div class="offer-info"><span></span><span></span></div></li>'.repeat(4)}</ul>`;

function showShopLogin(): void {
  myShopEl.replaceChildren();
  shopLoginEl.hidden = false;
}

async function loadMyShop(link: string): Promise<void> {
  const tokens = parseLoginLink(link);
  if (!tokens) {
    shopStatusEl.textContent = 'That link has no login in it. Copy the whole address after logging in, including everything after the #.';
    return;
  }

  shopStatusEl.textContent = '';
  shopLoginEl.hidden = true;
  myShopEl.innerHTML = SKELETON;
  let shop;
  try {
    shop = await getMyShop(tokens, ownerKey!);
  } catch (error) {
    shopStatusEl.textContent = errorMessage(error, "The server didn't accept your owner key. Open the page with #key= and the right key.");
    showShopLogin();
    return;
  }

  // Names and pictures come from valorant-api.com, like in the featured store
  const withInfo = (items: ShopItem[]) =>
    Promise.all(items.map(async (item) => ({ item, info: await getItemInfo(item.itemTypeId, item.itemId).catch(() => null) })));
  const [daily, nightMarket] = await Promise.all([withInfo(shop.daily.items), withInfo(shop.nightMarket?.items ?? [])]);

  const list = (entries: Awaited<ReturnType<typeof withInfo>>) =>
    `<ul class="offers">${entries
      .map(
        ({ item, info }) => `<li class="offer">
          <div class="offer-art">
            ${info?.icon ? `<img src="${escapeHtml(info.icon)}" alt="" />` : ''}
            ${item.discountPercent ? `<span class="discount">−${item.discountPercent}%</span>` : ''}
          </div>
          <div class="offer-info">
            <p class="offer-name">${escapeHtml(info?.name ?? 'Unknown item')}</p>
            <p class="offer-price">${vp(item.price)}${
              item.discountPercent ? `<s class="muted">${item.basePrice.toLocaleString('en')}</s>` : ''
            }</p>
          </div>
        </li>`,
      )
      .join('')}</ul>`;

  // data-ends: when the countdown runs out, so updateShopTimers can keep it current
  const group = (title: string, secondsLeft: number, entries: Awaited<ReturnType<typeof withInfo>>, className = '') => `
    <div class="shop-group ${className}">
      <div class="shop-group-head">
        <h3>${title}</h3>
        <span class="timer" data-ends="${Date.now() + secondsLeft * 1000}">${CLOCK_ICON}<span>${timeLeft(secondsLeft)}</span></span>
      </div>
      ${list(entries)}
    </div>`;

  const dailyTotal = shop.daily.items.reduce((total, item) => total + item.price, 0);
  myShopEl.innerHTML = `
    ${group('Daily offers', shop.daily.secondsLeft, daily)}
    ${shop.nightMarket ? group('Night Market', shop.nightMarket.secondsLeft, nightMarket, 'night-market') : ''}
    <div class="shop-footer">
      <p class="muted">All 4 daily offers: ${vp(dailyTotal)}</p>
      <button type="button" class="link-button" id="shop-reset">Log in again</button>
    </div>
  `;
  myShopEl.querySelector('#shop-reset')!.addEventListener('click', showShopLogin);
}

// Count the shop's timers down while the page is open
function updateShopTimers(): void {
  for (const timer of myShopEl.querySelectorAll<HTMLElement>('[data-ends]')) {
    const secondsLeft = (Number(timer.dataset.ends) - Date.now()) / 1000;
    timer.querySelector('span')!.textContent = secondsLeft > 0 ? timeLeft(secondsLeft) : 'Refreshed, log in again';
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

searchForm.addEventListener('submit', (event) => {
  // Stop the browser from reloading the page on submit
  event.preventDefault();
  void lookUp(riotIdInput.value.trim(), platformSelect.value as Platform);
});

shopForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const link = shopLinkInput.value;
  // Don't leave the login sitting in the page once it's been used
  shopLinkInput.value = '';
  void loadMyShop(link);
});

renderRecent();
void loadStore();
setInterval(updateShopTimers, 30_000);

// A shared link like ?player=Name%23TAG&platform=pc looks that player up straight away
const params = new URLSearchParams(location.search);
const sharedPlayer = params.get('player');
if (sharedPlayer) {
  const platform: Platform = params.get('platform') === 'console' ? 'console' : 'pc';
  riotIdInput.value = sharedPlayer;
  platformSelect.value = platform;
  void lookUp(sharedPlayer, platform);
}

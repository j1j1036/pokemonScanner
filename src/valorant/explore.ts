/**
 * Everything around the game that isn't about one player: the server status
 * banner, and the Leaderboard, News, Esports and Crosshair tabs.
 *
 * Each tab loads its data the first time it's opened, to stay inside the
 * HenrikDev API's limit of 30 requests a minute.
 */
import {
  cardSmall,
  crosshairImage,
  english,
  getEsportsSchedule,
  getLeaderboard,
  getMaps,
  getNews,
  getStatus,
  rankIcon,
} from './api';
import type { EsportsMatch, Leaderboard, Platform, Region, StatusEntry } from './api';
import { CLOSE_ICON, EXTERNAL_ICON, errorMessage, escapeHtml, timeAgo } from './util';

export const REGIONS: { id: Region; name: string }[] = [
  { id: 'eu', name: 'Europe' },
  { id: 'na', name: 'North America' },
  { id: 'ap', name: 'Asia Pacific' },
  { id: 'kr', name: 'Korea' },
  { id: 'latam', name: 'Latin America' },
  { id: 'br', name: 'Brazil' },
];

const regionOptions = (selected: Region) =>
  REGIONS.map((r) => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${r.name}</option>`).join('');

const dateFormat = new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------------------
// Server status banner
// ---------------------------------------------------------------------------

// Banners the visitor closed, so they don't come back on every lookup
const dismissed = new Set<number>();
let statusRegion: Region | null = null;

export async function showServerStatus(container: HTMLElement, region: Region): Promise<void> {
  if (region === statusRegion) return;
  statusRegion = region;
  let status: { maintenances: StatusEntry[]; incidents: StatusEntry[] };
  try {
    status = await getStatus(region);
  } catch {
    return; // Not important enough to show an error for
  }
  if (region !== statusRegion) return;

  const regionName = REGIONS.find((r) => r.id === region)?.name ?? region.toUpperCase();
  // Only fresh news: some old notices (like one server city being down) stay listed for months
  const recent = (entry: StatusEntry) => Date.now() - Date.parse(entry.updates[0]?.created_at ?? entry.created_at) < 7 * 86_400_000;
  const entries = [...status.maintenances, ...status.incidents].filter((entry) => !dismissed.has(entry.id) && recent(entry));
  container.replaceChildren(
    ...entries.map((entry) => {
      const banner = document.createElement('div');
      const severity = entry.maintenance_status ? 'maintenance' : (entry.incident_severity ?? 'info');
      banner.className = `server-status ${severity}`;
      banner.setAttribute('role', 'status');
      const latest = entry.updates[0];
      banner.innerHTML = `
        <div>
          <p><strong>${escapeHtml(english(entry.titles))}</strong> <span class="muted">· ${escapeHtml(regionName)}${
            latest ? ` · ${timeAgo(latest.created_at)}` : ''
          }</span></p>
          ${latest ? `<p class="muted">${escapeHtml(english(latest.translations))}</p>` : ''}
        </div>
        <button type="button" class="icon-button" aria-label="Hide this message">${CLOSE_ICON}</button>
      `;
      banner.querySelector('button')!.addEventListener('click', () => {
        dismissed.add(entry.id);
        banner.remove();
      });
      return banner;
    }),
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type ExploreTab = 'leaderboard' | 'news' | 'esports' | 'crosshair';

const loaded = new Set<ExploreTab>();

// onPlayer: called with "Name#TAG" when a player is clicked, to look them up
export function loadTab(tab: ExploreTab, pane: HTMLElement, onPlayer: (riotId: string, platform: Platform) => void): void {
  if (loaded.has(tab)) return;
  loaded.add(tab);
  if (tab === 'leaderboard') initLeaderboard(pane, onPlayer);
  if (tab === 'news') void initNews(pane);
  if (tab === 'esports') void initEsports(pane);
  if (tab === 'crosshair') initCrosshair(pane);
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function initLeaderboard(pane: HTMLElement, onPlayer: (riotId: string, platform: Platform) => void): void {
  pane.innerHTML = `
    <section class="panel">
      <h2>Leaderboard</h2>
      <p class="sub">The top ranked players this act. Click a player to look them up.</p>
      <form class="search lb-form">
        <label>Region <select name="region">${regionOptions('eu')}</select></label>
        <label>Platform
          <select name="platform"><option value="pc">PC</option><option value="console">Console</option></select>
        </label>
        <label class="riot-id">Find a player
          <input name="find" placeholder="Name#TAG (optional)" autocomplete="off" spellcheck="false" />
        </label>
        <button type="submit">Show</button>
      </form>
      <div class="thresholds"></div>
      <p class="status" role="status"></p>
      <div class="table-scroll">
        <table class="leaderboard">
          <thead><tr><th class="num">#</th><th>Player</th><th>Rank</th><th class="num">RR</th><th class="num">Wins</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="pager">
        <button type="button" class="chip" data-page="-1">← Previous</button>
        <span class="muted page-label"></span>
        <button type="button" class="chip" data-page="1">Next →</button>
      </div>
    </section>
  `;
  const form = pane.querySelector<HTMLFormElement>('form')!;
  const statusEl = pane.querySelector<HTMLParagraphElement>('.status')!;
  const thresholdsEl = pane.querySelector<HTMLDivElement>('.thresholds')!;
  const body = pane.querySelector<HTMLTableSectionElement>('tbody')!;
  const pageLabel = pane.querySelector<HTMLSpanElement>('.page-label')!;
  const [prev, next] = pane.querySelectorAll<HTMLButtonElement>('[data-page]');
  let start = 0;
  let request = 0;

  async function show(): Promise<void> {
    const region = form.region.value as Region;
    const platform = form.platform.value as Platform;
    const find = (form.find.value as string).trim();
    const hash = find.lastIndexOf('#');
    const riotId = hash > 0 ? { name: find.slice(0, hash), tag: find.slice(hash + 1) } : undefined;
    if (find && !riotId) {
      statusEl.textContent = 'Type the full Riot ID with the tag, like Name#TAG.';
      return;
    }

    const current = ++request;
    statusEl.textContent = 'Loading…';
    let board: Leaderboard;
    try {
      board = await getLeaderboard(region, platform, start, riotId);
    } catch (error) {
      if (current !== request) return;
      statusEl.textContent = errorMessage(error, riotId ? 'That player isn’t on the leaderboard.' : 'No leaderboard for this region.');
      body.replaceChildren();
      return;
    }
    if (current !== request) return;
    statusEl.textContent = board.players.length ? '' : 'Nobody here yet.';

    // "Radiant: top 500 · Immortal 3: 200+ RR" and so on
    thresholdsEl.innerHTML = board.thresholds
      .slice()
      .sort((a, b) => b.tier.id - a.tier.id)
      .map(
        (t) => `<span class="chip static"><img src="${rankIcon(t.tier.id)}" alt="" />${escapeHtml(t.tier.name)}
          <span class="muted">from #${t.start_index.toLocaleString('en')}${t.threshold ? ` · ${t.threshold}+ RR` : ''}</span></span>`,
      )
      .join('');

    body.innerHTML = board.players
      .map((player) => {
        const name = player.is_anonymized ? 'Secret Agent' : `${player.name}#${player.tag}`;
        return `<tr>
          <td class="num"><strong>${player.leaderboard_rank.toLocaleString('en')}</strong></td>
          <td>
            <span class="lb-player">
              <img src="${escapeHtml(cardSmall(player.card))}" alt="" />
              ${
                player.is_anonymized
                  ? `<span class="muted">${name}</span>`
                  : `<button type="button" class="link-button" data-player="${escapeHtml(name)}">${escapeHtml(player.name)}<span class="tag">#${escapeHtml(player.tag)}</span></button>`
              }
            </span>
          </td>
          <td><span class="tier"><img src="${rankIcon(player.tier)}" alt="" /></span></td>
          <td class="num">${player.rr}</td>
          <td class="num">${player.wins}</td>
        </tr>`;
      })
      .join('');

    // Searching shows one player, so there are no pages
    prev.hidden = next.hidden = !!riotId;
    prev.disabled = start === 0;
    next.disabled = board.players.length < 25;
    pageLabel.textContent = riotId ? '' : `#${start + 1}–${start + board.players.length}`;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    start = 0;
    void show();
  });
  for (const button of [prev, next]) {
    button.addEventListener('click', () => {
      start = Math.max(0, start + Number(button.dataset.page) * 25);
      void show();
    });
  }
  body.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-player]');
    if (button) onPlayer(button.dataset.player!, form.platform.value as Platform);
  });

  void show();
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

const CATEGORY_NAMES: Record<string, string> = {
  game_updates: 'Game updates',
  dev: 'Dev',
  esports: 'Esports',
  announcements: 'Announcements',
  patch_notes: 'Patch notes',
  community: 'Community',
};

async function initNews(pane: HTMLElement): Promise<void> {
  pane.innerHTML = `<section class="panel"><h2>News</h2><p class="sub">Latest from playvalorant.com.</p>
    <div class="news"><p class="muted">Loading news…</p></div></section>`;
  const list = pane.querySelector<HTMLDivElement>('.news')!;
  try {
    const posts = (await getNews()).slice(0, 12);
    list.innerHTML = posts
      .map(
        (post) => `<a class="news-card" href="${escapeHtml(post.external_link ?? post.url)}" target="_blank" rel="noopener">
          ${post.banner_url ? `<img src="${escapeHtml(post.banner_url)}" alt="" loading="lazy" />` : '<span class="news-art"></span>'}
          <div class="news-body">
            <p class="label">${escapeHtml(CATEGORY_NAMES[post.category] ?? post.category.replace(/_/g, ' '))} · ${dateFormat.format(new Date(post.date))}</p>
            <h3>${escapeHtml(post.title)}</h3>
          </div>
        </a>`,
      )
      .join('');
  } catch (error) {
    list.innerHTML = `<p class="muted">${escapeHtml(errorMessage(error, 'No news right now.'))}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Esports
// ---------------------------------------------------------------------------

async function initEsports(pane: HTMLElement): Promise<void> {
  pane.innerHTML = `<section class="panel"><h2>Esports</h2><p class="sub">VCT and other official matches.</p>
    <div class="filters" role="group" aria-label="Show">
      <button type="button" class="chip selected" data-filter="upcoming" aria-pressed="true">Live &amp; upcoming</button>
      <button type="button" class="chip" data-filter="results" aria-pressed="false">Results</button>
    </div>
    <div class="esports"><p class="muted">Loading the schedule…</p></div></section>`;
  const list = pane.querySelector<HTMLDivElement>('.esports')!;
  let schedule: EsportsMatch[];
  try {
    schedule = await getEsportsSchedule();
  } catch {
    list.innerHTML = '<p class="muted">The esports schedule isn’t available right now. Try again later.</p>';
    return;
  }

  const draw = (filter: string) => {
    const matches = schedule
      .filter((m) => (filter === 'results' ? m.state === 'completed' : m.state !== 'completed'))
      .sort((a, b) => (filter === 'results' ? Date.parse(b.date) - Date.parse(a.date) : Date.parse(a.date) - Date.parse(b.date)))
      .slice(0, 30);
    if (!matches.length) {
      list.innerHTML = '<p class="muted">No matches to show.</p>';
      return;
    }
    // Group by day
    let lastDay = '';
    list.innerHTML = matches
      .map((m) => {
        const day = dateFormat.format(new Date(m.date));
        const heading = day !== lastDay ? `<h3 class="day">${day}</h3>` : '';
        lastDay = day;
        const live = m.state === 'inProgress';
        const done = m.state === 'completed';
        const [a, b] = m.match.teams;
        const team = (t: EsportsMatch['match']['teams'][number] | undefined) =>
          t
            ? `<span class="es-team ${done && t.has_won ? 'winner' : ''}">
                ${t.icon ? `<img src="${escapeHtml(t.icon)}" alt="" loading="lazy" />` : ''}
                <span>${escapeHtml(t.name)}</span>
              </span>`
            : '<span class="es-team muted">TBD</span>';
        return `${heading}<div class="es-match">
          <div class="es-league">
            ${m.league.icon ? `<img src="${escapeHtml(m.league.icon)}" alt="" loading="lazy" />` : ''}
            <div><p>${escapeHtml(m.league.name)}</p><p class="muted small">${escapeHtml(m.tournament.name)}${
              m.match.game_type.count ? ` · Bo${m.match.game_type.count}` : ''
            }</p></div>
          </div>
          <div class="es-teams">
            ${team(a)}
            <span class="es-score">${
              live ? '<span class="live">Live</span>' : done ? `${a?.game_wins ?? 0} – ${b?.game_wins ?? 0}` : timeFormat.format(new Date(m.date))
            }</span>
            ${team(b)}
          </div>
          ${m.vod ? `<a class="chip" href="${escapeHtml(m.vod)}" target="_blank" rel="noopener">VOD ${EXTERNAL_ICON}</a>` : '<span></span>'}
        </div>`;
      })
      .join('');
  };

  for (const button of pane.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
    button.addEventListener('click', () => {
      for (const other of pane.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
        other.classList.toggle('selected', other === button);
        other.setAttribute('aria-pressed', String(other === button));
      }
      draw(button.dataset.filter!);
    });
  }
  draw('upcoming');
}

// ---------------------------------------------------------------------------
// Crosshair
// ---------------------------------------------------------------------------

// A plain green cross, to show something before a code is pasted
const SAMPLE_CODE = '0;P;c;5;h;0;m;1;0l;4;0o;2;0a;1;0f;0;1b;0';

function initCrosshair(pane: HTMLElement): void {
  pane.innerHTML = `
    <section class="panel">
      <h2>Crosshair preview</h2>
      <p class="sub">Paste a crosshair code (Settings → Crosshair → Import profile code) to see it on a few maps.</p>
      <form class="search ch-form">
        <label class="riot-id">Crosshair code
          <input name="code" value="${SAMPLE_CODE}" autocomplete="off" spellcheck="false" required />
        </label>
        <button type="submit">Preview</button>
        <button type="button" class="secondary" data-copy>Copy code</button>
      </form>
      <p class="status" role="status"></p>
      <div class="crosshair-previews"></div>
    </section>
  `;
  const form = pane.querySelector<HTMLFormElement>('form')!;
  const statusEl = pane.querySelector<HTMLParagraphElement>('.status')!;
  const previews = pane.querySelector<HTMLDivElement>('.crosshair-previews')!;

  // Map pictures to put the crosshair on, picked once
  const backgrounds = getMaps()
    .then((maps) =>
      [...maps.values()]
        .filter((map) => map.splash && ['Ascent', 'Bind', 'Haven', 'Lotus'].includes(map.name))
        .map((map) => ({ name: map.name, picture: map.splash! })),
    )
    .catch(() => []);

  async function show(): Promise<void> {
    const code = (form.code.value as string).trim();
    statusEl.textContent = '';
    const image = crosshairImage(code);
    const maps = await backgrounds;
    const spots = maps.length ? maps : [{ name: 'Plain', picture: '' }];
    previews.innerHTML = spots
      .map(
        (map) => `<figure class="crosshair-preview" ${map.picture ? `style="background-image: url('${escapeHtml(map.picture)}')"` : ''}>
          <img src="${escapeHtml(image)}" alt="Crosshair" />
          <figcaption>${escapeHtml(map.name)}</figcaption>
        </figure>`,
      )
      .join('');
    // A bad code comes back as an error instead of a picture
    previews.querySelector('img')!.addEventListener('error', () => {
      statusEl.textContent = 'That code didn’t work. Check it was copied completely.';
      previews.replaceChildren();
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void show();
  });
  pane.querySelector<HTMLButtonElement>('[data-copy]')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText((form.code.value as string).trim());
      statusEl.textContent = 'Copied!';
    } catch {
      statusEl.textContent = 'Couldn’t copy. Select the code and copy it yourself.';
    }
  });

  void show();
}

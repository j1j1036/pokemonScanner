/**
 * The details under a match in "Recent matches": the scoreboard for every
 * player, a round-by-round timeline, and how much each team spent per round.
 * It all comes from the match data that's already loaded, so opening a match
 * costs no extra API requests.
 */
import { isFreeForAll, rankIcon } from './api';
import type { Agent, Match, MatchPlayer, Round } from './api';
import { escapeHtml } from './util';

// How each round ended, as a small icon
const RESULT_ICONS: Record<string, string> = {
  Elimination: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  'Bomb detonated': '<circle cx="8" cy="8" r="3.5" fill="currentColor"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15M3 3l1.8 1.8M11.2 11.2 13 13M13 3l-1.8 1.8M4.8 11.2 3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  'Bomb defused': '<path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  'Round timer expired': '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
};
const resultIcon = (result: string) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true">${RESULT_ICONS[result] ?? '<circle cx="8" cy="8" r="2.5" fill="currentColor"/>'}</svg>`;

// Rough buy type from a team's average loadout value (credits)
function buyType(average: number): string {
  if (average < 1500) return 'Eco';
  if (average < 3000) return 'Half buy';
  if (average < 3900) return 'Light buy';
  return 'Full buy';
}

interface Line {
  player: MatchPlayer;
  acs: number;
  adr: number;
  headshotPercent: number;
  firstKills: number;
}

function scoreboard(lines: Line[], focus: string, agents: Map<string, Agent> | null, title: string, won: boolean | null): string {
  return `<div class="scoreboard-team">
    <p class="scoreboard-title ${won === null ? '' : won ? 'up' : 'down'}">${escapeHtml(title)}</p>
    <div class="table-scroll">
      <table class="scoreboard">
        <thead><tr>
          <th>Player</th><th class="num" title="Average combat score">ACS</th><th class="num">K / D / A</th>
          <th class="num" title="Kills minus deaths">+/−</th><th class="num" title="Average damage per round">ADR</th>
          <th class="num" title="Headshot percentage">HS%</th><th class="num" title="First kills">FK</th>
        </tr></thead>
        <tbody>${lines
          .map(({ player, acs, adr, headshotPercent, firstKills }) => {
            const { kills, deaths, assists } = player.stats;
            const diff = kills - deaths;
            const agent = agents?.get(player.agent.id.toLowerCase());
            return `<tr class="${player.puuid === focus ? 'me' : ''}">
              <td>
                <span class="sb-player">
                  ${agent ? `<img class="sb-agent" src="${escapeHtml(agent.icon)}" alt="${escapeHtml(agent.name)}" title="${escapeHtml(agent.name)}" />` : ''}
                  ${player.tier.id ? `<img class="sb-rank" src="${rankIcon(player.tier.id)}" alt="${escapeHtml(player.tier.name)}" title="${escapeHtml(player.tier.name)}" />` : ''}
                  <button type="button" class="link-button sb-name" data-player="${escapeHtml(`${player.name}#${player.tag}`)}"
                    title="Look up ${escapeHtml(`${player.name}#${player.tag}`)}">${escapeHtml(player.name)}</button>
                </span>
              </td>
              <td class="num"><strong>${acs}</strong></td>
              <td class="num">${kills} / ${deaths} / ${assists}</td>
              <td class="num ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}">${diff > 0 ? '+' : ''}${diff}</td>
              <td class="num">${adr}</td>
              <td class="num">${headshotPercent}%</td>
              <td class="num">${firstKills}</td>
            </tr>`;
          })
          .join('')}</tbody>
      </table>
    </div>
  </div>`;
}

function timeline(rounds: Round[], myTeam: string): string {
  // Each team's total loadout value per round, for the economy bars
  const spend = rounds.map((round) => {
    let mine = 0;
    let theirs = 0;
    let mineCount = 0;
    let theirsCount = 0;
    for (const stat of round.stats) {
      const value = stat.economy?.loadout_value ?? 0;
      if (stat.player.team === myTeam) {
        mine += value;
        mineCount++;
      } else {
        theirs += value;
        theirsCount++;
      }
    }
    return { mine, theirs, mineAverage: mine / Math.max(mineCount, 1), theirsAverage: theirs / Math.max(theirsCount, 1) };
  });
  const most = Math.max(1, ...spend.flatMap((s) => [s.mine, s.theirs]));

  return `<div class="timeline-wrap">
    <div class="timeline" style="--rounds: ${rounds.length}">
      ${rounds
        .map((round, index) => {
          const won = round.winning_team === myTeam;
          const s = spend[index];
          const label = `Round ${index + 1}: ${won ? 'won' : 'lost'}, ${round.result.toLowerCase()}. Your team: ${buyType(s.mineAverage)} (${s.mine.toLocaleString('en')}), enemy: ${buyType(s.theirsAverage)} (${s.theirs.toLocaleString('en')})`;
          return `<div class="round ${won ? 'won' : 'lost'} ${index === 12 ? 'half' : ''}" title="${escapeHtml(label)}">
            <span class="bar mine" style="height: ${(s.mine / most) * 100}%"></span>
            <span class="round-result">${resultIcon(round.result)}<span class="visually-hidden">${escapeHtml(label)}</span></span>
            <span class="bar theirs" style="height: ${(s.theirs / most) * 100}%"></span>
            <span class="round-num">${index + 1}</span>
          </div>`;
        })
        .join('')}
    </div>
    <p class="muted small timeline-legend">
      <span class="key won"></span>Won <span class="key lost"></span>Lost · Bars: your team’s loadout value (top) and the enemy’s (bottom). Hover a round for details.
    </p>
  </div>`;
}

export function renderMatchDetails(match: Match, focus: string, agents: Map<string, Agent> | null): string {
  const rounds = Math.max(match.rounds.length, 1);
  const firstKills = new Map<string, number>();
  for (const round of match.rounds) {
    const puuid = round.first_blood?.puuid;
    if (puuid) firstKills.set(puuid, (firstKills.get(puuid) ?? 0) + 1);
  }

  const line = (player: MatchPlayer): Line => {
    const { stats } = player;
    const shots = stats.headshots + stats.bodyshots + stats.legshots;
    return {
      player,
      acs: Math.round(stats.score / rounds),
      adr: Math.round(stats.damage.dealt / rounds),
      headshotPercent: shots ? Math.round((stats.headshots / shots) * 100) : 0,
      firstKills: firstKills.get(player.puuid) ?? 0,
    };
  };
  const byAcs = (a: Line, b: Line) => b.acs - a.acs;

  const me = match.players.find((p) => p.puuid === focus);

  // Free-for-all (Deathmatch): one list, no rounds to show
  if (!match.teams.length || !me || isFreeForAll(match)) {
    return scoreboard(match.players.map(line).sort(byAcs), focus, agents, 'Everyone', null);
  }

  const myTeam = match.teams.find((t) => t.team_id === me.team_id);
  const enemy = match.teams.find((t) => t.team_id !== me.team_id);
  const teamLines = (teamId: string) => match.players.filter((p) => p.team_id === teamId).map(line).sort(byAcs);

  return `
    ${match.rounds.length > 1 ? timeline(match.rounds, me.team_id) : ''}
    ${scoreboard(teamLines(me.team_id), focus, agents, `Your team${myTeam ? ` · ${myTeam.rounds.won}` : ''}`, myTeam?.won ?? null)}
    ${enemy ? scoreboard(teamLines(enemy.team_id), focus, agents, `Enemy team · ${enemy.rounds.won}`, enemy.won) : ''}
  `;
}

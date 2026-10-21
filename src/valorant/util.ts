/**
 * Small helpers shared by the Valorant tracker's modules.
 */
import { ApiError, KC_ICON, RADIANITE_ICON, VP_ICON } from './api';

// Make text safe to put inside innerHTML: turns "<" into "&lt;" and so on,
// so a player name can never be interpreted as HTML.
// Quotes are escaped too, so it's also safe inside attributes like src="..." and alt="..."
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Explain an error in plain words. `notFound` is what a 404 means in that place.
export function errorMessage(error: unknown, notFound: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return notFound;
    if (error.status === 429) return `Too many lookups right now. Try again in ${error.retryAfter ?? 60} seconds.`;
    return error.message;
  }
  return "Couldn't reach the server. Check your connection and try again.";
}

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// An ISO date -> "3 hours ago", "yesterday", …
export function timeAgo(date: string): string {
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
export function timeLeft(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

// A price in Valorant Points, with the VP icon
export const vp = (amount: number) => `<span class="vp"><img src="${VP_ICON}" alt="" />${amount.toLocaleString('en')}</span>`;

// The same for the other two currencies
export const kc = (amount: number) => `<span class="vp"><img src="${KC_ICON}" alt="" />${amount.toLocaleString('en')}</span>`;
export const radianite = (amount: number) =>
  `<span class="vp radianite"><img src="${RADIANITE_ICON}" alt="" />${amount.toLocaleString('en')}</span>`;

// Small inline icons; they take the text color
export const LOCK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/></svg>';
export const CLOCK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 2a5 5 0 1 0 0 10A5 5 0 0 0 8 3Zm.75 1.5V7.7l2.1 1.2-.75 1.3L7.25 8.6V4.5h1.5Z"/></svg>';
export const EXTERNAL_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9 2h5v5h-1.5V4.56L7.53 9.53 6.47 8.47l4.97-4.97H9V2ZM3.5 4H7v1.5H3.5v7h7V9H12v3.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4Z"/></svg>';

export const CHECK_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.2 11.6 2.6 8l1.1-1.1 2.5 2.5 6.1-6.1L13.4 4.4z"/></svg>';
export const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>';
export const CLOSE_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m4.1 3 3.9 3.9L11.9 3 13 4.1 9.1 8l3.9 3.9-1.1 1.1L8 9.1 4.1 13 3 11.9 6.9 8 3 4.1z"/></svg>';

/**
 * RR tracking chart: a line of the player's total rating over their recent
 * ranked games, with a readout for each game on hover or with the arrow keys.
 *
 * It's drawn as SVG at the container's real size in pixels (not a stretched
 * viewBox), so the text stays readable on a phone, and redraws when resized.
 */
import { eloLabel } from './api';
import type { MmrChange } from './api';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEIGHT = 240;
const MARGIN = { top: 18, right: 58, bottom: 30, left: 88 };

// 18 -> "+18", -7 -> "−7", 0 -> "0"
export function signed(value: number): string {
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${Math.abs(value)}`;
  return '0';
}

const shortDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' });
const longDate = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

// One ResizeObserver per container, so looking up a new player replaces the old one
const observers = new WeakMap<HTMLElement, ResizeObserver>();

export function renderRrChart(container: HTMLElement, history: MmrChange[]): void {
  observers.get(container)?.disconnect();
  container.replaceChildren();

  // The API lists the newest game first; the chart reads old (left) to new (right)
  const points = [...history].reverse();
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  // Index of the game the readout is showing, or null when hidden
  let active: number | null = null;

  function draw(): void {
    const width = container.clientWidth;
    if (!width) return;
    const plotWidth = width - MARGIN.left - MARGIN.right;
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;

    // Gridlines every 100 (one rank), or every 200 if the range is very large.
    // The y range is rounded out to whole gridlines.
    const elos = points.map((point) => point.elo);
    const step = Math.max(...elos) - Math.min(...elos) > 800 ? 200 : 100;
    const yMin = Math.floor(Math.min(...elos) / step) * step;
    const yMax = Math.max(Math.ceil(Math.max(...elos) / step) * step, yMin + step);

    const x = (i: number) => MARGIN.left + (points.length === 1 ? plotWidth / 2 : (i * plotWidth) / (points.length - 1));
    const y = (elo: number) => MARGIN.top + plotHeight - ((elo - yMin) / (yMax - yMin)) * plotHeight;

    const svg = svgElement('svg', {
      width,
      height: HEIGHT,
      role: 'img',
      tabindex: 0,
      'aria-label': `Rating over the last ${points.length} ranked games. Use the arrow keys to step through them.`,
    });

    // Gridlines, labelled with the rank that starts there
    for (let elo = yMin; elo <= yMax; elo += step) {
      svg.append(svgElement('line', { class: 'grid', x1: MARGIN.left, x2: width - MARGIN.right, y1: y(elo), y2: y(elo) }));
      const label = svgElement('text', { class: 'tick', x: MARGIN.left - 10, y: y(elo) + 4, 'text-anchor': 'end' });
      label.textContent = eloLabel(elo);
      svg.append(label);
    }

    // Dates of the oldest and newest game under the axis
    const first = points[0];
    const last = points[points.length - 1];
    for (const [point, i, anchor] of [[first, 0, 'start'], [last, points.length - 1, 'end']] as const) {
      const label = svgElement('text', { class: 'tick', x: x(i), y: HEIGHT - 8, 'text-anchor': points.length === 1 ? 'middle' : anchor });
      label.textContent = shortDate.format(new Date(point.date));
      svg.append(label);
      if (points.length === 1) break;
    }

    const path = points.map((point, i) => `${i ? 'L' : 'M'}${x(i)},${y(point.elo)}`).join(' ');
    svg.append(svgElement('path', { class: 'line', d: path }));
    points.forEach((point, i) => svg.append(svgElement('circle', { class: 'dot', cx: x(i), cy: y(point.elo), r: 4 })));

    // Label only the newest point: where the player is now
    const endLabel = svgElement('text', { class: 'end-label', x: x(points.length - 1) + 10, y: y(last.elo) + 4 });
    endLabel.textContent = `${last.rr} RR`;
    svg.append(endLabel);

    // Hover layer: a vertical line and a bigger dot on the game being shown
    const crosshair = svgElement('line', { class: 'crosshair', y1: MARGIN.top, y2: MARGIN.top + plotHeight, visibility: 'hidden' });
    const activeDot = svgElement('circle', { class: 'dot active', r: 6, visibility: 'hidden' });
    svg.append(crosshair, activeDot);

    function show(i: number): void {
      active = i;
      const point = points[i];
      crosshair.setAttribute('x1', String(x(i)));
      crosshair.setAttribute('x2', String(x(i)));
      activeDot.setAttribute('cx', String(x(i)));
      activeDot.setAttribute('cy', String(y(point.elo)));
      crosshair.setAttribute('visibility', 'visible');
      activeDot.setAttribute('visibility', 'visible');

      // API text goes in with textContent, never innerHTML
      const change = document.createElement('strong');
      change.textContent = `${signed(point.last_change)} RR`;
      const rank = document.createElement('span');
      rank.textContent = `${point.tier.name} · ${point.rr} RR`;
      const where = document.createElement('span');
      where.className = 'muted';
      where.textContent = `${point.map.name} · ${longDate.format(new Date(point.date))}`;
      tooltip.replaceChildren(change, rank, where);
      tooltip.hidden = false;

      // Above the point, kept inside the chart's edges
      const half = tooltip.offsetWidth / 2;
      tooltip.style.left = `${Math.min(Math.max(x(i), half), width - half)}px`;
      tooltip.style.top = `${y(point.elo) - 12}px`;
    }

    function hide(): void {
      active = null;
      crosshair.setAttribute('visibility', 'hidden');
      activeDot.setAttribute('visibility', 'hidden');
      tooltip.hidden = true;
    }

    // The pointer only has to be near a game's column, not on the line itself
    svg.addEventListener('pointermove', (event) => {
      const left = event.clientX - svg.getBoundingClientRect().left;
      const i = points.length === 1 ? 0 : Math.round(((left - MARGIN.left) / plotWidth) * (points.length - 1));
      show(Math.min(Math.max(i, 0), points.length - 1));
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(active ?? points.length - 1));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const next = (active ?? points.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1);
      show(Math.min(Math.max(next, 0), points.length - 1));
    });

    const wasActive = active;
    container.replaceChildren(svg, tooltip);
    if (wasActive !== null) show(wasActive);
  }

  const observer = new ResizeObserver(draw);
  observer.observe(container);
  observers.set(container, observer);
}

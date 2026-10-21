/**
 * App entry point: builds the page and wires up the buttons.
 *
 * The flow of a scan:
 *   camera.ts                -> grab a picture of the card inside the frame
 *   ocr.ts                   -> read the name and number off that picture
 *   scannerInicializer.ts    -> look those up in the TCGdex database
 *   this file                -> show the matches / the card's details
 */
import './style.css';
import { findCards, getCard } from './pokemon/scannerInicializer';
import type { CardNumber, PricedCard } from './pokemon/scannerInicializer';
import type { CardResumeModel } from '@tcgdex/sdk';
import { captureGuide, showPhoto, startCamera, stopCamera } from './scanner/camera';
import { scanCard, warmUpOcr } from './scanner/ocr';

// ---------------------------------------------------------------------------
// Page layout
// ---------------------------------------------------------------------------

// index.html only contains an empty <div id="app">; we fill it in here
const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header class="top">
    <img class="logo" src="/mimikyu.svg" alt="" />
    <div>
      <h1>Pokémon Scanner</h1>
      <p class="tagline">Show me a card and I’ll tell you what it’s worth ✨</p>
    </div>
  </header>

  <!-- Live camera feed, with a card-shaped frame drawn over it -->
  <section class="viewfinder">
    <video id="video" playsinline muted></video>
    <!-- A photo from the phone's camera app is shown here instead of the live feed -->
    <img id="photo" class="photo" alt="" hidden />
    <div id="guide" class="guide">
      <span class="corner tl"></span><span class="corner tr"></span>
      <span class="corner bl"></span><span class="corner br"></span>
      <span class="scanline"></span>
    </div>
    <p id="camera-hint" class="camera-hint">Take a photo of your card, or start the live camera and line it up inside the frame</p>
  </section>

  <div class="controls">
    <button id="camera-btn" type="button">Start camera</button>
    <button id="scan-btn" type="button" class="primary" disabled>Scan card</button>
    <!-- capture="environment" makes phones open the back camera straight away;
         on a computer this is a normal "choose a file" dialog -->
    <label class="photo-btn">
      📸 Take a photo
      <input id="photo-input" type="file" accept="image/*" capture="environment" class="visually-hidden" />
    </label>
  </div>

  <!-- Filled in automatically by a scan, but can also be typed in by hand -->
  <form id="search" class="search">
    <label>Name <input id="name-input" name="name" placeholder="e.g. Charizard ex" autocomplete="off" /></label>
    <label>Number <input id="number-input" name="number" placeholder="e.g. 136/189" autocomplete="off" /></label>
    <button type="submit">Search</button>
  </form>

  <!-- Status messages, the grid of possible matches, and the chosen card's details -->
  <p id="status" class="status" role="status"></p>
  <ul id="results" class="results"></ul>
  <article id="detail" class="detail" hidden></article>

  <footer class="credits">
    Unofficial fan project. Not affiliated with Nintendo, Game Freak or The Pokémon Company.
    Card data from <a href="https://tcgdex.dev" target="_blank" rel="noopener">TCGdex</a>.
  </footer>
`;

// Grab references to the elements we just created.
// The "!" tells TypeScript "this definitely exists" (we just created it above).
const viewfinder = document.querySelector<HTMLElement>('.viewfinder')!;
const video = document.querySelector<HTMLVideoElement>('#video')!;
const photo = document.querySelector<HTMLImageElement>('#photo')!;
const photoInput = document.querySelector<HTMLInputElement>('#photo-input')!;
const guide = document.querySelector<HTMLDivElement>('#guide')!;
const cameraHint = document.querySelector<HTMLParagraphElement>('#camera-hint')!;
const cameraBtn = document.querySelector<HTMLButtonElement>('#camera-btn')!;
const scanBtn = document.querySelector<HTMLButtonElement>('#scan-btn')!;
const searchForm = document.querySelector<HTMLFormElement>('#search')!;
const nameInput = document.querySelector<HTMLInputElement>('#name-input')!;
const numberInput = document.querySelector<HTMLInputElement>('#number-input')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const resultsEl = document.querySelector<HTMLUListElement>('#results')!;
const detailEl = document.querySelector<HTMLElement>('#detail')!;

// The active camera stream, or null while the camera is off
let stream: MediaStream | null = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function setStatus(message: string): void {
  statusEl.textContent = message;
}

// Make text safe to put inside innerHTML: turns "<" into "&lt;" and so on,
// so a card name can never be interpreted as HTML.
// Quotes are escaped too, so it's also safe inside attributes like src="..." and alt="..."
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Turn what the user typed in the Number box into a CardNumber:
// "136/189" -> { local: "136", total: 189 },  "25" -> { local: "25" },  "" -> undefined
function parseNumberInput(value: string): CardNumber | undefined {
  const [local, total] = value.split('/').map((part) => part.trim());
  if (!local) return undefined;
  const totalNumber = Number(total);
  return { local, total: total && !Number.isNaN(totalNumber) ? totalNumber : undefined };
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

// "Start camera" / "Stop camera" toggle
cameraBtn.addEventListener('click', async () => {
  // Camera is on -> turn it off and reset the UI
  if (stream) {
    stopCamera(stream);
    stream = null;
    video.srcObject = null;
    cameraBtn.textContent = 'Start camera';
    scanBtn.disabled = true;
    cameraHint.hidden = false;
    viewfinder.classList.remove('live');
    return;
  }
  // Camera is off -> turn it on
  try {
    stream = await startCamera(video);
    cameraBtn.textContent = 'Stop camera';
    scanBtn.disabled = false;
    cameraHint.hidden = true;
    photo.hidden = true;
    viewfinder.classList.add('live');
    // Start downloading the OCR model now, while the user lines up the card
    warmUpOcr();
  } catch (error) {
    // Usually: permission denied, no camera, or the page isn't on HTTPS
    setStatus(`Couldn't open the camera: ${(error as Error).message}`);
  }
});

// "Scan card": grab the live frame and scan it
scanBtn.addEventListener('click', () => runScan(video));

// "Take a photo": the phone opens its camera app; once a photo comes back,
// show it in the viewfinder and scan it straight away
photoInput.addEventListener('change', async () => {
  const file = photoInput.files?.[0];
  // Clear the input so picking the same file again still fires "change"
  photoInput.value = '';
  if (!file) return;

  // The live camera isn't needed while looking at a photo
  if (stream) cameraBtn.click();
  try {
    await showPhoto(photo, file);
  } catch {
    setStatus("Couldn't open that picture. Try another photo.");
    return;
  }
  photo.hidden = false;
  cameraHint.hidden = true;
  await runScan(photo);
});

// The shared scan flow for both the live camera and photos:
// capture the frame -> read text -> search
async function runScan(source: HTMLVideoElement | HTMLImageElement): Promise<void> {
  // Disable the button so a double-tap can't start two scans at once
  scanBtn.disabled = true;
  // Shows the moving scan line over the frame while OCR runs
  viewfinder.classList.add('scanning');
  try {
    setStatus('Reading card…');
    const result = await scanCard(captureGuide(source, guide));
    // Open the browser dev tools console to see what OCR actually read
    console.debug('OCR header:', result.rawName, '| footer:', result.rawNumber);

    // Put what we read into the search boxes so the user can see and fix it
    nameInput.value = result.name;
    numberInput.value = result.number
      ? `${result.number.local}${result.number.total !== undefined ? `/${result.number.total}` : ''}`
      : '';

    if (!result.name) {
      setStatus("Couldn't read the card name. Make sure the card fills the frame, or type it below.");
      return;
    }
    await search(result.name, result.number);
  } catch (error) {
    setStatus(`Scan failed: ${(error as Error).message}`);
  } finally {
    viewfinder.classList.remove('scanning');
    // Re-enable the button, unless the camera was turned off mid-scan
    scanBtn.disabled = !stream;
  }
}

// Manual "Search" button (also used after correcting a bad scan)
searchForm.addEventListener('submit', async (event) => {
  // Stop the browser from reloading the page, which is what forms do by default
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) {
    setStatus('Enter a card name to search.');
    return;
  }
  await search(name, parseNumberInput(numberInput.value));
});

// ---------------------------------------------------------------------------
// Searching and showing results
// ---------------------------------------------------------------------------

// Look up a card and decide what to show:
//   no matches -> a message, one match -> its details, several -> a grid to pick from
async function search(name: string, number?: CardNumber): Promise<void> {
  setStatus(`Searching for “${name}”${number ? ` #${number.local}` : ''}…`);
  // Clear out the previous search's results
  resultsEl.innerHTML = '';
  detailEl.hidden = true;

  try {
    const cards = await findCards(name, number);
    if (cards.length === 0) {
      setStatus(`No cards found for “${name}”.`);
      return;
    }
    if (cards.length === 1) {
      setStatus('Found it.');
      await showCard(cards[0].id);
      return;
    }
    setStatus(`${cards.length} possible matches. Pick yours:`);
    renderResults(cards);
  } catch (error) {
    // Usually a network problem reaching the TCGdex API
    setStatus(`Search failed: ${(error as Error).message}`);
  }
}

// Draw the grid of candidate cards; clicking one opens its details
function renderResults(cards: CardResumeModel[]): void {
  resultsEl.innerHTML = '';
  // Show at most 60 so a broad search like "Pikachu" doesn't load hundreds of images
  for (const card of cards.slice(0, 60)) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result';
    // Some cards in the database have no image; show a placeholder for those.
    // 'low' quality keeps the grid fast; loading="lazy" loads images only when scrolled into view.
    button.innerHTML = card.image
      ? `<img src="${escapeHtml(card.getImageURL('low', 'webp'))}" alt="" loading="lazy" />`
      : `<div class="no-image">No image</div>`;
    button.insertAdjacentHTML('beforeend', `<span>${escapeHtml(card.name)}<small>${escapeHtml(card.id)}</small></span>`);
    button.addEventListener('click', () => showCard(card.id));
    item.append(button);
    resultsEl.append(item);
  }
}

// Format a price like "0.04 EUR", or "—" when the value is missing
function formatPrice(value: unknown, unit: string): string {
  return typeof value === 'number' ? `${value.toFixed(2)} ${escapeHtml(unit)}` : '—';
}

// Build the prices table from whichever markets have data for this card
function renderPricing(card: PricedCard): string {
  const rows: string[] = [];

  const cardmarket = card.pricing?.cardmarket;
  if (cardmarket) {
    rows.push(`<tr><th>Cardmarket trend</th><td>${formatPrice(cardmarket.trend, cardmarket.unit)}</td></tr>`);
    rows.push(`<tr><th>Cardmarket low</th><td>${formatPrice(cardmarket.low, cardmarket.unit)}</td></tr>`);
    // Only some cards have a separate holo price
    if (cardmarket['trend-holo'] !== undefined) {
      rows.push(`<tr><th>Cardmarket trend (holo)</th><td>${formatPrice(cardmarket['trend-holo'], cardmarket.unit)}</td></tr>`);
    }
  }

  // TCGplayer groups prices by variant (normal, holofoil, reverseHolofoil, ...);
  // show the market price for each one
  const tcgplayer = card.pricing?.tcgplayer;
  if (tcgplayer) {
    for (const [variant, prices] of Object.entries(tcgplayer)) {
      // Skip non-variant fields such as "unit" and "updated"
      if (typeof prices !== 'object' || prices === null) continue;
      const market = (prices as { marketPrice?: number }).marketPrice;
      rows.push(`<tr><th>TCGplayer ${escapeHtml(variant)}</th><td>${formatPrice(market, tcgplayer.unit)}</td></tr>`);
    }
  }

  return rows.length > 0 ? `<table class="prices">${rows.join('')}</table>` : '<p class="muted">No price data.</p>';
}

// Fetch the full card and show its image, details and prices
async function showCard(id: string): Promise<void> {
  const card = await getCard(id);
  if (!card) {
    setStatus(`Card ${id} not found.`);
    return;
  }

  // [label, value] pairs for the details list. Not every card has every field
  // (a Trainer card has no HP), so empty ones are filtered out.
  const details = [
    ['Set', `${card.set.name} · ${card.localId}${card.set.cardCount?.official ? `/${card.set.cardCount.official}` : ''}`],
    ['Rarity', card.rarity],
    ['Category', card.category],
    ['HP', card.hp],
    ['Types', card.types?.join(', ')],
    ['Illustrator', card.illustrator],
  ].filter(([, value]) => value !== undefined && value !== '');

  detailEl.innerHTML = `
    ${card.image ? `<img src="${escapeHtml(card.getImageURL('high', 'webp'))}" alt="${escapeHtml(card.name)}" />` : ''}
    <div>
      <h2>${escapeHtml(card.name)}</h2>
      <dl>${details.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(String(value))}</dd>`).join('')}</dl>
      <h3>Prices</h3>
      ${renderPricing(card)}
    </div>
  `;
  detailEl.hidden = false;
  // Scroll down to the card so it's visible on phones
  detailEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

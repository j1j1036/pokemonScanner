/**
 * Skin rarity colors, and the preview window that opens when you click a skin:
 * its picture, color variants and upgrade levels, with their videos.
 *
 * Anything with a data-skin="<id>" attribute opens the preview when clicked.
 * The ID can be a skin, one of its levels or one of its color variants (chromas).
 */
import { getCatalog, lookUpKey } from './api';
import type { Chroma, Skin } from './api';
import { CLOSE_ICON, PLAY_ICON, escapeHtml } from './util';

export async function findSkin(id: string): Promise<Skin | null> {
  const catalog = await getCatalog();
  const k = lookUpKey(id);
  return catalog.skinByLevel.get(k) ?? catalog.skins.get(k) ?? catalog.skinByChroma.get(k) ?? null;
}

// Attributes that give a card its rarity color (used by the CSS as --rarity)
export const rarityStyle = (skin: Skin | null | undefined) => (skin?.rarity ? `style="--rarity: ${skin.rarity.color}"` : '');

export const rarityIcon = (skin: Skin | null | undefined) =>
  skin?.rarity
    ? `<img class="rarity-icon" src="${escapeHtml(skin.rarity.icon)}" alt="${skin.rarity.name} edition" title="${skin.rarity.name} edition" />`
    : '';

// "EEquippableSkinLevelItem::SoundEffects" -> "Sound effects"
function levelLabel(levelItem: string | null, index: number): string {
  if (!levelItem) return index === 0 ? 'Base' : `Level ${index + 1}`;
  const name = levelItem.replace(/^.*::/, '');
  if (name === 'VFX') return 'Visual effects';
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "Doombringer Odin Level 4\n(Variant 1 Red)" -> "Red"
function chromaLabel(chroma: Chroma, index: number): string {
  if (index === 0) return 'Base';
  const variant = chroma.displayName.match(/\(Variant \d+ (.+)\)/);
  return variant ? variant[1] : `Variant ${index}`;
}

let dialog: HTMLDialogElement | null = null;

function createDialog(): HTMLDialogElement {
  const element = document.createElement('dialog');
  element.className = 'skin-preview';
  // Clicking the dimmed backdrop (outside the box) closes it
  element.addEventListener('click', (event) => {
    if (event.target === element) element.close();
  });
  // Stop any video when it closes
  element.addEventListener('close', () => element.replaceChildren());
  document.body.append(element);
  return element;
}

function render(skin: Skin, chromaIndex: number, video: string | null): void {
  const chroma = skin.chromas[chromaIndex];
  const picture = chroma?.fullRender ?? chroma?.displayIcon ?? skin.displayIcon;

  dialog!.innerHTML = `
    <div class="preview-box" ${rarityStyle(skin)}>
      <header class="preview-head">
        ${rarityIcon(skin)}
        <div>
          <h2>${escapeHtml(skin.displayName)}</h2>
          ${skin.rarity ? `<p class="muted">${skin.rarity.name} edition</p>` : ''}
        </div>
        <button type="button" class="icon-button" data-close aria-label="Close">${CLOSE_ICON}</button>
      </header>

      <div class="preview-stage">
        ${
          video
            ? `<video src="${escapeHtml(video)}" autoplay controls playsinline></video>`
            : picture
              ? `<img src="${escapeHtml(picture)}" alt="${escapeHtml(skin.displayName)}" />`
              : ''
        }
      </div>

      ${
        skin.chromas.length > 1
          ? `<h3 class="preview-label">Variants</h3>
            <div class="variants">${skin.chromas
              .map(
                (variant, index) => `<button type="button" class="variant ${index === chromaIndex ? 'selected' : ''}"
                  data-chroma="${index}" aria-pressed="${index === chromaIndex}" title="${escapeHtml(chromaLabel(variant, index))}">
                  ${variant.swatch ? `<img src="${escapeHtml(variant.swatch)}" alt="" />` : '<span></span>'}
                  <span class="visually-hidden">${escapeHtml(chromaLabel(variant, index))}</span>
                </button>`,
              )
              .join('')}
            ${chroma?.streamedVideo ? `<button type="button" class="chip" data-video="${escapeHtml(chroma.streamedVideo)}">${PLAY_ICON} Watch</button>` : ''}
            </div>`
          : ''
      }

      ${
        skin.levels.length > 1
          ? `<h3 class="preview-label">Upgrade levels</h3>
            <ol class="levels">${skin.levels
              .map(
                (level, index) => `<li>
                  <span class="level-num">${index + 1}</span>
                  <span>${escapeHtml(levelLabel(level.levelItem, index))}</span>
                  ${
                    level.streamedVideo
                      ? `<button type="button" class="chip ${video === level.streamedVideo ? 'selected' : ''}"
                          data-video="${escapeHtml(level.streamedVideo)}">${PLAY_ICON} Watch</button>`
                      : ''
                  }
                </li>`,
              )
              .join('')}</ol>`
          : ''
      }
    </div>
  `;

  dialog!.querySelector('[data-close]')!.addEventListener('click', () => dialog!.close());
  for (const button of dialog!.querySelectorAll<HTMLButtonElement>('[data-chroma]')) {
    button.addEventListener('click', () => render(skin, Number(button.dataset.chroma), null));
  }
  for (const button of dialog!.querySelectorAll<HTMLButtonElement>('[data-video]')) {
    button.addEventListener('click', () => render(skin, chromaIndex, button.dataset.video!));
  }
}

export async function openSkinPreview(id: string): Promise<void> {
  const skin = await findSkin(id).catch(() => null);
  if (!skin) return;
  dialog ??= createDialog();
  // Start on the variant that was clicked, if the ID was a variant
  const chromaIndex = Math.max(
    0,
    skin.chromas.findIndex((chroma) => lookUpKey(chroma.uuid) === lookUpKey(id)),
  );
  render(skin, chromaIndex, null);
  if (!dialog.open) dialog.showModal();
}

// One listener for the whole page: click (or Enter/Space on) anything with data-skin
function handle(event: Event): void {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-skin]');
  if (!target) return;
  if (event instanceof KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
  }
  void openSkinPreview(target.dataset.skin!);
}
document.addEventListener('click', handle);
document.addEventListener('keydown', handle);

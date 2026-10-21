/**
 * "My shop": the site owner's own Valorant account, in the sidebar.
 *
 * Only for the owner: the panel appears after opening the page once with
 * #key=<SHOP_OWNER_KEY>, and the server refuses anyone without that key.
 * After logging in on Riot's page and pasting the link, it shows three tabs:
 *   Shop        wallet, daily offers, Night Market, Kingdom Credits store
 *   Collection  equipped skins, card, title and sprays, and how much is owned
 *   Progress    account level, battle pass and missions
 */
import {
  RIOT_LOGIN_URL,
  cardBanner,
  getCatalog,
  getContractDefinitions,
  getCurrentAct,
  getItemInfo,
  getMissionDefinitions,
  getMyShop,
  getTitleText,
  lookUpKey,
  parseLoginLink,
} from './api';
import type { Catalog, Shop, ShopItem } from './api';
import { rarityIcon, rarityStyle } from './skins';
import {
  CHECK_ICON,
  CLOCK_ICON,
  EXTERNAL_ICON,
  LOCK_ICON,
  errorMessage,
  escapeHtml,
  kc,
  radianite,
  timeLeft,
  vp,
} from './util';

// ---------------------------------------------------------------------------
// Owner key
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

export const ownerKey = setUpOwnerKey();

// The latest loaded shop, so other parts of the page (the featured store) can
// mark what's already owned. They listen for the "myshop" event on document.
export let loadedShop: Shop | null = null;

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

let panel: HTMLElement;
let loginEl: HTMLDivElement;
let statusEl: HTMLParagraphElement;
let contentEl: HTMLDivElement;

export function initShop(container: HTMLElement): void {
  panel = container;
  panel.innerHTML = `
    <section class="panel shop-panel">
      <div class="shop-title">
        <h2>My shop</h2>
        <span class="private">${LOCK_ICON}Only you</span>
      </div>

      <div id="shop-login">
        <p class="sub">Your shop, collection and progress. Log in on Riot’s site, then paste the link you land on.</p>
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
  `;
  loginEl = panel.querySelector('#shop-login')!;
  statusEl = panel.querySelector('#shop-status')!;
  contentEl = panel.querySelector('#my-shop')!;

  const form = panel.querySelector<HTMLFormElement>('#shop-form')!;
  const input = panel.querySelector<HTMLInputElement>('#shop-link')!;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const link = input.value;
    // Don't leave the login sitting in the page once it's been used
    input.value = '';
    void loadMyShop(link);
  });

  setInterval(updateTimers, 30_000);
}

// While the shop loads: grey placeholder cards in its shape
const SKELETON = `<ul class="offers">${'<li class="offer skeleton"><div class="offer-art"></div><div class="offer-info"><span></span><span></span></div></li>'.repeat(4)}</ul>`;

function showLogin(): void {
  contentEl.replaceChildren();
  loginEl.hidden = false;
}

async function loadMyShop(link: string): Promise<void> {
  const tokens = parseLoginLink(link);
  if (!tokens) {
    statusEl.textContent = 'That link has no login in it. Copy the whole address after logging in, including everything after the #.';
    return;
  }

  statusEl.textContent = '';
  loginEl.hidden = true;
  contentEl.innerHTML = SKELETON;
  let shop: Shop;
  try {
    shop = await getMyShop(tokens, ownerKey!);
  } catch (error) {
    statusEl.textContent = errorMessage(error, "The server didn't accept your owner key. Open the page with #key= and the right key.");
    showLogin();
    return;
  }

  loadedShop = shop;
  document.dispatchEvent(new CustomEvent('myshop', { detail: shop }));

  // Rarity colors need the skin catalog; the shop still works without it
  const catalog = await getCatalog().catch(() => null);

  const wallet = shop.wallet
    ? `<div class="wallet" aria-label="Wallet">
        <span>${vp(shop.wallet.vp)}</span>
        <span>${radianite(shop.wallet.radianite)}</span>
        <span>${kc(shop.wallet.kingdomCredits)}</span>
      </div>`
    : '';

  contentEl.innerHTML = `
    ${wallet}
    <div class="shop-tabs" role="tablist" aria-label="My account">
      <button type="button" role="tab" aria-selected="true" data-tab="shop">Shop</button>
      <button type="button" role="tab" aria-selected="false" data-tab="collection">Collection</button>
      <button type="button" role="tab" aria-selected="false" data-tab="progress">Progress</button>
    </div>
    <div class="shop-tab" data-pane="shop">${await renderShopTab(shop, catalog)}</div>
    <div class="shop-tab" data-pane="collection" hidden></div>
    <div class="shop-tab" data-pane="progress" hidden></div>
    <div class="shop-footer">
      <p class="muted">Logged in for about an hour</p>
      <button type="button" class="link-button" id="shop-reset">Log in again</button>
    </div>
  `;

  contentEl.querySelector('#shop-reset')!.addEventListener('click', showLogin);

  // Tabs: Collection and Progress are drawn the first time they're opened
  const drawn = new Set(['shop']);
  for (const tab of contentEl.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    tab.addEventListener('click', async () => {
      const name = tab.dataset.tab!;
      for (const other of contentEl.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
        other.setAttribute('aria-selected', String(other === tab));
      }
      for (const pane of contentEl.querySelectorAll<HTMLElement>('[data-pane]')) pane.hidden = pane.dataset.pane !== name;
      if (drawn.has(name)) return;
      drawn.add(name);
      const pane = contentEl.querySelector<HTMLElement>(`[data-pane="${name}"]`)!;
      pane.innerHTML = '<p class="muted">Loading…</p>';
      pane.innerHTML = name === 'collection' ? await renderCollection(shop, catalog) : await renderProgress(shop);
    });
  }
}

// Count the shop's timers down while the page is open
function updateTimers(): void {
  for (const timer of contentEl?.querySelectorAll<HTMLElement>('[data-ends]') ?? []) {
    const secondsLeft = (Number(timer.dataset.ends) - Date.now()) / 1000;
    timer.querySelector('span')!.textContent = secondsLeft > 0 ? timeLeft(secondsLeft) : 'Refreshed, log in again';
  }
}

// data-ends: when the countdown runs out, so updateTimers can keep it current
const timer = (secondsLeft: number) =>
  `<span class="timer" data-ends="${Date.now() + secondsLeft * 1000}">${CLOCK_ICON}<span>${timeLeft(secondsLeft)}</span></span>`;

const isOwned = (shop: Shop, itemId: string) => shop.owned?.includes(lookUpKey(itemId)) ?? false;

// ---------------------------------------------------------------------------
// Shop tab
// ---------------------------------------------------------------------------

async function renderShopTab(shop: Shop, catalog: Catalog | null): Promise<string> {
  const skinOffers = (items: ShopItem[]) =>
    `<ul class="offers">${items
      .map((item) => {
        const skin = catalog?.skinByLevel.get(lookUpKey(item.itemId));
        const name = skin?.displayName ?? 'Unknown skin';
        const icon = skin?.chromas[0]?.displayIcon ?? skin?.displayIcon;
        // Can you buy it with what's in the wallet?
        const afford = isOwned(shop, item.itemId)
          ? `<p class="badge owned">${CHECK_ICON}Owned</p>`
          : shop.wallet
            ? shop.wallet.vp >= item.price
              ? `<p class="badge afford">${CHECK_ICON}Can afford</p>`
              : `<p class="badge short">Need ${(item.price - shop.wallet.vp).toLocaleString('en')} more VP</p>`
            : '';
        return `<li class="offer" ${rarityStyle(skin)} data-skin="${escapeHtml(item.itemId)}" tabindex="0" role="button"
            aria-label="${escapeHtml(name)}, ${item.price} VP. Show preview">
          <div class="offer-art">
            ${icon ? `<img src="${escapeHtml(icon)}" alt="" />` : ''}
            ${item.discountPercent ? `<span class="discount">−${item.discountPercent}%</span>` : ''}
            ${rarityIcon(skin)}
          </div>
          <div class="offer-info">
            <div class="offer-text">
              <p class="offer-name">${escapeHtml(name)}</p>
              ${afford}
            </div>
            <p class="offer-price">${vp(item.price)}${
              item.discountPercent ? `<s class="muted">${item.basePrice.toLocaleString('en')}</s>` : ''
            }</p>
          </div>
        </li>`;
      })
      .join('')}</ul>`;

  // Accessories are buddies, sprays, cards and titles: names and pictures from valorant-api.com
  const accessories = shop.accessories
    ? await Promise.all(
        shop.accessories.items.map(async (item) => ({ item, info: await getItemInfo(item.itemTypeId, item.itemId).catch(() => null) })),
      )
    : [];

  const dailyTotal = shop.daily.items.reduce((total, item) => total + item.price, 0);
  return `
    <div class="shop-group">
      <div class="shop-group-head"><h3>Daily offers</h3>${timer(shop.daily.secondsLeft)}</div>
      ${skinOffers(shop.daily.items)}
      <p class="group-note muted">All 4: ${vp(dailyTotal)}</p>
    </div>
    ${
      shop.nightMarket
        ? `<div class="shop-group night-market">
            <div class="shop-group-head"><h3>Night Market</h3>${timer(shop.nightMarket.secondsLeft)}</div>
            ${skinOffers(shop.nightMarket.items)}
          </div>`
        : ''
    }
    ${
      shop.accessories && accessories.length
        ? `<div class="shop-group">
            <div class="shop-group-head"><h3>Accessories</h3>${timer(shop.accessories.secondsLeft)}</div>
            <ul class="accessories">${accessories
              .map(
                ({ item, info }) => `<li>
                  <div class="accessory-art">${info?.icon ? `<img src="${escapeHtml(info.icon)}" alt="" />` : ''}</div>
                  <p class="offer-name">${escapeHtml(info?.name ?? 'Unknown item')}</p>
                  <p class="muted">${info?.kind ?? ''}${isOwned(shop, item.itemId) ? ' · Owned' : ''}</p>
                  <p class="offer-price">${kc(item.price)}</p>
                </li>`,
              )
              .join('')}</ul>
          </div>`
        : ''
    }
  `;
}

// ---------------------------------------------------------------------------
// Collection tab
// ---------------------------------------------------------------------------

// The order weapons appear in the game's Collection screen
const CATEGORY_ORDER = ['Sidearm', 'SMG', 'Shotgun', 'Rifle', 'Sniper', 'Heavy', 'Melee'];

async function renderCollection(shop: Shop, catalog: Catalog | null): Promise<string> {
  if (!shop.loadout) return '<p class="muted">Riot didn’t send your loadout this time. Try logging in again.</p>';
  if (!catalog) return '<p class="muted">Couldn’t load the skin list from valorant-api.com.</p>';
  const { loadout } = shop;

  const [title, buddies, sprays] = await Promise.all([
    getTitleText(loadout.titleId).catch(() => null),
    Promise.all(
      loadout.guns.map((gun) =>
        gun.buddyLevelId ? getItemInfo('dd3bf334-87f3-40bd-b043-682a57a8dc3a', gun.buddyLevelId).catch(() => null) : null,
      ),
    ),
    Promise.all(loadout.sprayIds.map((id) => getItemInfo('d5f120f8-ff8c-4aac-92ea-f2b5acbe9475', id).catch(() => null))),
  ]);

  const guns = loadout.guns
    .map((gun, index) => ({ gun, buddy: buddies[index], weapon: catalog.weapons.get(lookUpKey(gun.weaponId)) }))
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.weapon?.category ?? '') - CATEGORY_ORDER.indexOf(b.weapon?.category ?? ''));

  // How many different skins are owned (each owned level counts once per skin)
  const ownedSkins = new Set<string>();
  for (const id of shop.owned ?? []) {
    const skin = catalog.skinByLevel.get(id);
    if (skin) ownedSkins.add(skin.uuid);
  }

  return `
    <div class="identity">
      <img src="${escapeHtml(cardBanner(loadout.cardId))}" alt="" />
      <div>
        <p class="identity-title">${escapeHtml(title ?? '')}</p>
        ${shop.account ? `<p class="muted">Level ${shop.account.level}</p>` : ''}
      </div>
    </div>

    ${shop.owned ? `<p class="group-note muted">${ownedSkins.size} skins owned</p>` : ''}

    <div class="shop-group">
      <div class="shop-group-head"><h3>Equipped</h3></div>
      <ul class="loadout">${guns
        .map(({ gun, buddy, weapon }) => {
          const skin = catalog.skinByChroma.get(lookUpKey(gun.chromaId)) ?? catalog.skins.get(lookUpKey(gun.skinId));
          const chroma = skin?.chromas.find((c) => lookUpKey(c.uuid) === lookUpKey(gun.chromaId));
          // Default skins are called "Standard Vandal" and so on; show just the weapon then
          const name = skin && !skin.displayName.startsWith('Standard') ? skin.displayName : (weapon?.displayName ?? 'Weapon');
          const picture = chroma?.displayIcon ?? skin?.displayIcon ?? weapon?.displayIcon;
          return `<li class="loadout-gun" ${rarityStyle(skin)} data-skin="${escapeHtml(gun.chromaId)}" tabindex="0" role="button"
              aria-label="${escapeHtml(name)}. Show preview">
            ${picture ? `<img src="${escapeHtml(picture)}" alt="" />` : ''}
            ${buddy?.icon ? `<img class="buddy" src="${escapeHtml(buddy.icon)}" alt="${escapeHtml(buddy.name)}" title="${escapeHtml(buddy.name)}" />` : ''}
            <p>${escapeHtml(name)}</p>
          </li>`;
        })
        .join('')}</ul>
    </div>

    ${
      sprays.some(Boolean)
        ? `<div class="shop-group">
            <div class="shop-group-head"><h3>Sprays</h3></div>
            <ul class="sprays">${sprays
              .filter((spray) => spray?.icon)
              .map((spray) => `<li><img src="${escapeHtml(spray!.icon!)}" alt="${escapeHtml(spray!.name)}" title="${escapeHtml(spray!.name)}" /></li>`)
              .join('')}</ul>
          </div>`
        : ''
    }
  `;
}

// ---------------------------------------------------------------------------
// Progress tab
// ---------------------------------------------------------------------------

const progressBar = (value: number, max: number, label: string) =>
  `<div class="progress" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${value}">
    <span style="width: ${max ? Math.min(100, (value / max) * 100) : 100}%"></span>
  </div>`;

// Each account level takes 5,000 XP
const XP_PER_LEVEL = 5000;

async function renderProgress(shop: Shop): Promise<string> {
  const [contracts, missions, act] = await Promise.all([
    getContractDefinitions().catch(() => null),
    getMissionDefinitions().catch(() => null),
    getCurrentAct().catch(() => null),
  ]);

  const parts: string[] = [];

  if (shop.account) {
    parts.push(`
      <div class="progress-block">
        <div class="progress-head"><h3>Account level ${shop.account.level}</h3>
          <span class="muted">${shop.account.xp.toLocaleString('en')} / ${XP_PER_LEVEL.toLocaleString('en')} XP</span></div>
        ${progressBar(shop.account.xp, XP_PER_LEVEL, 'XP towards the next account level')}
      </div>`);
  }

  // This act's battle pass: the contract whose definition belongs to the current act
  const battlePass =
    act && contracts
      ? shop.contracts?.find((contract) => {
          const definition = contracts.get(lookUpKey(contract.id));
          return (
            definition?.relationType === 'Season' &&
            (lookUpKey(definition.relationUuid ?? '') === lookUpKey(act.uuid) ||
              lookUpKey(definition.relationUuid ?? '') === lookUpKey(act.parentUuid ?? ''))
          );
        })
      : undefined;
  if (battlePass) {
    const definition = contracts!.get(lookUpKey(battlePass.id))!;
    const tiers = definition.levelXp.length;
    const done = battlePass.level >= tiers;
    const nextXp = definition.levelXp[battlePass.level] ?? 0;
    parts.push(`
      <div class="progress-block">
        <div class="progress-head"><h3>Battle pass</h3>
          <span class="muted">Tier ${battlePass.level} / ${tiers}</span></div>
        ${progressBar(battlePass.level, tiers, 'Battle pass tiers')}
        <p class="muted small">${
          done ? 'Complete!' : `${battlePass.xpTowardsNext.toLocaleString('en')} / ${nextXp.toLocaleString('en')} XP to tier ${battlePass.level + 1}`
        }</p>
      </div>`);
  } else if (shop.contracts) {
    parts.push('<p class="muted small">This act’s battle pass isn’t listed on valorant-api.com yet.</p>');
  }

  if (shop.missions && missions) {
    const list = shop.missions
      .map((mission) => ({ mission, definition: missions.get(lookUpKey(mission.id)) }))
      .filter(({ definition }) => definition && definition.type !== 'Tutorial' && definition.type !== 'NPE')
      .sort((a, b) => Number(a.mission.complete) - Number(b.mission.complete));
    if (list.length) {
      parts.push(`
        <div class="shop-group">
          <div class="shop-group-head"><h3>Missions</h3></div>
          <ul class="missions">${list
            .map(({ mission, definition }) => {
              const goal = definition!.progressToComplete || 1;
              const secondsLeft = (Date.parse(mission.expires) - Date.now()) / 1000;
              return `<li class="${mission.complete ? 'complete' : ''}">
                <div class="progress-head">
                  <p>${escapeHtml(definition!.title)}</p>
                  <span class="muted">${mission.complete ? CHECK_ICON : `${Math.min(mission.progress, goal)} / ${goal}`}</span>
                </div>
                ${progressBar(mission.complete ? goal : mission.progress, goal, definition!.title)}
                <p class="muted small">${escapeHtml(definition!.type)}${definition!.xpGrant > 0 ? ` · ${definition!.xpGrant.toLocaleString('en')} XP` : ''}${
                  secondsLeft > 0 && secondsLeft < 60 * 86_400 ? ` · ${timeLeft(secondsLeft)} left` : ''
                }</p>
              </li>`;
            })
            .join('')}</ul>
        </div>`);
    }
  }

  return parts.join('') || '<p class="muted">Riot didn’t send your progress this time. Try logging in again.</p>';
}

// Bumpline — relist your Vinted items in one click.
// Copyright (C) 2026 g1ampy
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
// more details.
//
// You should have received a copy of the GNU General Public License along
// with this program. If not, see <https://www.gnu.org/licenses/>.

// The background — a service worker on Chrome, an event page on Firefox —
// exists for three jobs the page cannot do on its own:
//
//   1. Watch the requests Vinted's own site makes and note the security tokens
//      it attaches, so the extension can send requests Vinted will accept.
//   2. Fetch image bytes from the CDN when a cross-origin read from the page is
//      refused.
//   3. Check the website for notices, and badge the toolbar icon when one of
//      them asks for the seller's attention.

// The words for the one thing this file puts on screen, the toolbar button's
// tooltip; which browser this is, which store.js knows; and the notices'
// rules. Chrome's background is a classic service worker, which brings its own
// dependencies in with importScripts. Firefox's is an event page, where the
// manifest lists the three ahead of this file — build.mjs writes that array —
// and importScripts does not exist at all. Asking which of the two this is
// covers both without either needing to know about the other.
if (typeof importScripts === 'function') importScripts('strings.js', 'store.js', 'broadcast.js', 'diagnostics.js');

// Firefox answers to `browser` and only that namespace returns promises there;
// Chrome answers to `chrome`. One alias, and the rest of the file is written
// once for both.
const ext = globalThis.browser ?? globalThis.chrome;

// Every line also goes to the log a bug report can carry (diagnostics.js),
// cleaned before it is stored.
const note = (...parts) => {
  console.debug('[Bumpline]', ...parts);
  BumplineLog.record(ext.storage.local, parts);
};

const TOKEN_KEYS = { csrf: 'bumpline.csrf', anon: 'bumpline.anon' };

// Vinted runs one domain per country; the request filter has to name them all.
const COUNTRY_DOMAINS = [
  'vinted.at', 'vinted.be', 'vinted.bg', 'vinted.ch', 'vinted.co.uk',
  'vinted.com', 'vinted.cz', 'vinted.de', 'vinted.dk', 'vinted.ee',
  'vinted.es', 'vinted.fi', 'vinted.fr', 'vinted.gr', 'vinted.hr',
  'vinted.hu', 'vinted.ie', 'vinted.it', 'vinted.lt', 'vinted.lv',
  'vinted.nl', 'vinted.no', 'vinted.pl', 'vinted.pt', 'vinted.ro',
  'vinted.se', 'vinted.si', 'vinted.sk', 'vinted.com.au',
];

// Both shapes appear in the wild: /api/... at the root, and /<locale>/api/...
const API_URL_FILTERS = COUNTRY_DOMAINS.flatMap(domain => [
  `https://www.${domain}/api/*`,
  `https://www.${domain}/*/api/*`,
]);

let seen = { csrf: null, anon: null };

// Remember the tokens in memory for speed and on disk for content scripts that
// start up in a tab which has not issued an API call yet.
function noteTokens(headers) {
  if (!Array.isArray(headers)) return;

  let changed = false;
  for (const header of headers) {
    if (!header || !header.name || !header.value) continue;
    const name = header.name.toLowerCase();
    if (name === 'x-csrf-token' && header.value !== seen.csrf) {
      seen.csrf = header.value;
      changed = true;
    } else if (name === 'x-anon-id' && header.value !== seen.anon) {
      seen.anon = header.value;
      changed = true;
    }
  }
  if (!changed) return;

  ext.storage.local
    .set({ [TOKEN_KEYS.csrf]: seen.csrf, [TOKEN_KEYS.anon]: seen.anon })
    .catch(() => {
      // Losing the cached copy is survivable: the page can still parse the
      // token out of the markup.
    });
}

ext.webRequest.onBeforeSendHeaders.addListener(
  details => {
    try {
      noteTokens(details.requestHeaders);
    } catch (err) {
      note('could not read request headers', err);
    }
  },
  { urls: API_URL_FILTERS },
  ['requestHeaders']
);

async function tokensForPage() {
  if (seen.csrf || seen.anon) return { csrf: seen.csrf, anonId: seen.anon };
  try {
    const stored = await ext.storage.local.get([TOKEN_KEYS.csrf, TOKEN_KEYS.anon]);
    return { csrf: stored[TOKEN_KEYS.csrf] || null, anonId: stored[TOKEN_KEYS.anon] || null };
  } catch (_) {
    return { csrf: null, anonId: null };
  }
}

// The bytes go back over runtime messaging, which Chrome serialises as JSON
// unless the manifest opts into structured cloning. An ArrayBuffer arrives as
// {}, and the photo the page then uploads is the fifteen characters of
// "[object Object]". A string crosses either browser's channel as it is.
function base64Of(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // fromCharCode takes the bytes as arguments, and a full-size photo has more
  // of them than one call can carry.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

// Only Vinted (its country sites and its image CDN on vinted.net) and the
// extension's own package. Photo URLs arrive from API replies that pass through
// the page's main world, so they are checked here rather than trusted.
function mayFetch(url) {
  if (typeof url !== 'string') return false;
  if (url.startsWith(ext.runtime.getURL(''))) return true;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (VINTED_HOST.test(hostname) || /(^|\.)vinted\.net$/i.test(hostname));
  } catch (_) {
    return false;
  }
}

async function fetchBinary(url) {
  if (!mayFetch(url)) return { ok: false, error: 'refused: not a Vinted address' };
  try {
    const reply = await fetch(url, { credentials: 'omit' });
    if (!reply.ok) return { ok: false, status: reply.status };
    return {
      ok: true,
      data: base64Of(await reply.arrayBuffer()),
      contentType: reply.headers.get('content-type') || '',
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

ext.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || !message.type) return false;

  if (message.type === 'bumpline:tokens') {
    tokensForPage().then(respond);
    return true; // the reply is asynchronous
  }

  if (message.type === 'bumpline:fetchBinary' && message.url) {
    fetchBinary(message.url).then(respond);
    return true;
  }

  return false;
});

// --- the toolbar icon -----------------------------------------------------

// The icon is the only part of the extension visible when no panel is open, so
// it carries the one thing worth knowing from outside: whether pressing it
// would get you anything. Colour means yes — the switch is on and this tab is a
// Vinted page. Grey means no, for either reason, and the tooltip says which.
// Same drawing, luma only.
const ENABLED_KEY = 'bumpline:enabled';
const LANG_KEY = 'bumpline:lang';

const ACTION_ICONS = {
  on: { 16: 'icons/icon16.png', 24: 'icons/icon24.png', 32: 'icons/icon32.png' },
  off: { 16: 'icons/off16.png', 24: 'icons/off24.png', 32: 'icons/off32.png' },
};

// vinted.it, vinted.com, vinted.co.uk … one domain per country. The same test
// the popup makes, written the same way.
const VINTED_HOST = /(^|\.)vinted\.[a-z]{2,3}(\.[a-z]{2})?$/i;

// A tab's url only reaches an extension that holds a host permission for it,
// which here is exactly the Vinted domains. Everywhere else it arrives
// undefined — and that is not a gap to work around, it is the answer.
function onVinted(url) {
  if (!url) return false;
  try {
    return VINTED_HOST.test(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

// The switch, cached. The worker is torn down between events and reads it back
// on the way up; every repaint in between needs it, and none of them should
// have to wait on storage for it.
let switchedOn = true;

// Colour needs no explaining, so it says the product name and nothing else —
// the same word in every language, and therefore not a catalogue key. The two
// grey states do need explaining, and the welcome page on the website tells the
// seller to read them, which makes them functional text and not decoration.
function titleFor(colour) {
  if (!switchedOn) return BumplineText.t('popup.tooltip.off');
  return colour ? 'Bumpline' : BumplineText.t('popup.tooltip.notVinted');
}

// Without a tabId this is the default every tab starts from; with one it is an
// override for that tab alone, which is what makes the icon able to answer a
// question about the page rather than only about the switch.
function paintIcon(colour, tabId) {
  // Chrome returns promises here and Firefox returns them from a different
  // object; neither failure is worth taking the worker down for, and an icon
  // that did not repaint is not a reason to stop watching request headers. It
  // is worth saying out loud, though: a swallowed rejection here is an icon
  // that never changes and no way to find out why.
  const action = ext.action || ext.browserAction;
  if (!action) return;
  const where = tabId == null ? {} : { tabId };
  try {
    Promise.resolve(action.setIcon({ ...where, path: colour ? ACTION_ICONS.on : ACTION_ICONS.off }))
      .catch(err => note('could not set the icon', err));
    Promise.resolve(action.setTitle({ ...where, title: titleFor(colour) }))
      .catch(err => note('could not set the title', err));
  } catch (err) {
    // An older browser without these methods keeps the manifest's icon.
    note('this browser has no action icon to set', err);
  }
}

// Grey is the default because most tabs are not Vinted, and colour is painted
// over it per tab. A tab that has never been activated or loaded since the
// worker came up is therefore grey, which is the right guess for a tab the
// extension has heard nothing about.
function paintDefault() {
  paintIcon(false);
}

function paintTab(tabId, url) {
  if (tabId == null) return;
  paintIcon(switchedOn && onVinted(url), tabId);
}

// Only the active tab's icon is ever on screen, so that is the one repaint that
// has to happen now; every other tab gets its own when it is activated.
async function paintActiveTab() {
  try {
    const [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) paintTab(tab.id, tab.url);
  } catch (err) {
    note('could not read the active tab', err);
  }
}

// --- the website's notices ------------------------------------------------

// This fork runs fully locally: the notices file on the developer's website is
// never fetched. Whatever an earlier version stored is cleared, so no old
// notice or badge lingers.
Promise.resolve(ext.storage.local.remove([
  BumplineBroadcast.NOTICES_KEY,
  BumplineBroadcast.DISMISSED_KEY,
  BumplineBroadcast.CHECKED_KEY,
])).catch(() => {});

// The seller does not have to open the panel to learn that relisting is
// broken: a notice that asks for attention puts a "!" on the icon until it is
// closed. Set without a tabId, so it shows on every tab, Vinted or not; the
// icon underneath keeps its own per-tab colour. Switched off there is no
// relisting to warn about, and no badge.
async function paintBadge() {
  const action = ext.action || ext.browserAction;
  if (!action || !action.setBadgeText) return;

  let level = null;
  if (switchedOn) {
    try {
      const { NOTICES_KEY, DISMISSED_KEY } = BumplineBroadcast;
      const bag = await ext.storage.local.get([NOTICES_KEY, DISMISSED_KEY]);
      const shown = BumplineBroadcast.eligible(bag[NOTICES_KEY], BumplineBroadcast.here(bag[DISMISSED_KEY]));
      level = BumplineBroadcast.badgeFor(shown);
    } catch (err) {
      note('could not read the notices', err);
    }
  }

  const said = err => note('could not set the badge', err);
  try {
    Promise.resolve(action.setBadgeText({ text: level ? '!' : '' })).catch(said);
    if (level) {
      Promise.resolve(action.setBadgeBackgroundColor({ color: BumplineBroadcast.BADGE[level] })).catch(said);
      // Chrome 110 and Firefox 63 onwards; before that the browser picks a
      // text colour of its own, which reads on both backgrounds anyway.
      if (action.setBadgeTextColor) {
        Promise.resolve(action.setBadgeTextColor({ color: '#ffffff' })).catch(said);
      }
    }
  } catch (err) {
    said(err);
  }
}

// The worker is torn down between events and the browser forgets a set icon at
// the end of a session, so the switch is read on the way up rather than
// remembered. Absent means on, the same rule the popup and the page use.
//
// The language is read in the same breath and for the same reason: the words
// live in memory, so the catalogue is already in the browser's language by the
// time this runs, and only a seller who overruled the browser costs anything.
// Absent means 'auto', which BumplineText.use reads as "ask the browser".
async function paintIconFromStore() {
  try {
    const bag = await ext.storage.local.get([ENABLED_KEY, LANG_KEY]);
    switchedOn = bag[ENABLED_KEY] !== false;
    BumplineText.use(bag[LANG_KEY] || 'auto');
  } catch (_) {
    switchedOn = true;
  }
  paintDefault();
  await paintActiveTab();
  // The badge depends on the switch and the language just read, so it comes
  // after them; a fresh file, if there is one, repaints it through storage.
  paintBadge();
}

paintIconFromStore();
ext.runtime.onStartup.addListener(paintIconFromStore);

// The switch is thrown in the popup, which writes it here. Storage is what the
// content scripts already listen to, so the icon follows the same signal rather
// than needing a message of its own. The language is chosen in the same panel
// and written the same way, so it arrives here the same way: either one changes
// what the tooltip should say, and both are answered by repainting it. Both
// also change which notices apply, and so does a new file or a notice closed
// in the panel: those four repaint the badge.
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;
  const touched = ENABLED_KEY in changes || LANG_KEY in changes;
  const notices = BumplineBroadcast.NOTICES_KEY in changes || BumplineBroadcast.DISMISSED_KEY in changes;
  if (!touched && !notices) return;
  if (ENABLED_KEY in changes) switchedOn = changes[ENABLED_KEY].newValue !== false;
  if (LANG_KEY in changes) BumplineText.use(changes[LANG_KEY].newValue || 'auto');
  if (touched) {
    paintDefault();
    paintActiveTab();
  }
  paintBadge();
});

// Neither of these needs the "tabs" permission. The events fire either way; the
// url is what is withheld without one, and a withheld url is a tab the
// extension cannot work on — which is the same grey icon as a tab it will not
// work on. The two cases do not have to be told apart.
//
// They are also the steady pulse the notices are checked on, and the badge is
// repainted with them so a notice whose end has passed takes its "!" with it.
ext.tabs.onActivated.addListener(({ tabId }) => {
  Promise.resolve(ext.tabs.get(tabId))
    .then(tab => paintTab(tabId, tab && tab.url))
    .catch(() => paintTab(tabId, null));
  paintBadge();
});

ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // A navigation, or the load finishing. Everything else a tab reports — a
  // title, a favicon, a mute — cannot have changed the answer.
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  paintTab(tabId, tab && tab.url);
  paintBadge();
});

// This fork runs fully locally: no welcome page is opened on install and no
// page on the developer's website is opened on uninstall. An uninstall address
// set by an earlier version is cleared.
try {
  Promise.resolve(ext.runtime.setUninstallURL(''))
    .catch(err => note('could not clear the uninstall page', err));
} catch (err) {
  note('could not clear the uninstall page', err);
}

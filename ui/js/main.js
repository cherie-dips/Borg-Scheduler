// Entry point: settings → start polling → boot screen → shell.

import * as settings from './core/settings.js';
import { Store } from './core/store.js';
import { Shell } from './ui/shell.js';
import { runBoot } from './ui/boot.js';

settings.load();
const store = new Store();
const shell = new Shell(store, settings);
store.start(1000); // the boot screen reports real numbers, so start talking to the master now

const params = new URLSearchParams(location.search);
await runBoot(store, params.has('boot') ? params.get('boot') || 'full' : settings.get().boot);
shell.show();

// Deep links for demos and screenshots: /?view=jobs#help
const view = params.get('view');
if (view) shell.setView(view);
if (location.hash === '#help') shell.openHelp();
if (location.hash === '#settings') shell.openSettings();

window.miniBorg = { store, shell }; // handy in the browser console

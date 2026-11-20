// The console: a scrollback of commands and their output, like a real terminal session.
// It opens when a command prints something; ` (backtick) or Esc hides it again.

import { esc } from '../lib/format.js';
import { $, h } from '../lib/dom.js';

export class Console {
  constructor(parent) {
    this.root = h('section', { class: 'console', id: 'console', 'aria-label': 'console', hidden: true });
    this.root.innerHTML = `<div class="chead"><span>console · scrollback of your commands</span>
      <span><button type="button" class="kbtn" data-act="clear-console"><kbd>Ctrl+L</kbd> clear</button><button type="button" class="kbtn" data-act="console"><kbd>\`</kbd> hide</button></span></div>
      <div class="cbody" role="log" aria-live="off"></div>`;
    this.body = $('.cbody', this.root);
    parent.append(this.root);
  }

  get visible() {
    return !this.root.hidden;
  }

  show(on = true) {
    this.root.hidden = !on;
    if (on) this.body.scrollTop = this.body.scrollHeight;
  }

  toggle() {
    this.show(this.root.hidden);
  }

  echo(cmd) {
    this.body.append(h('div', { class: 'cl cmd' }, esc(cmd)));
    this.trim();
  }

  // lines: [{text, cls}]
  print(lines, open = true) {
    for (const l of lines) this.body.append(h('div', { class: `cl ${l.cls || ''}` }, esc(l.text)));
    this.trim();
    if (open) this.show(true);
    this.body.scrollTop = this.body.scrollHeight;
  }

  clear() {
    this.body.innerHTML = '';
  }

  trim() {
    while (this.body.children.length > 400) this.body.firstChild.remove();
  }
}

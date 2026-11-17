// Terminal prompts for scripts/setup.mjs, with no dependencies so `npm run setup` works right after cloning.
//
// Every prompt draws a frame on a left rail, redraws it in place on each key, and leaves a one-line summary
// once answered:
//
//   ◇  Domain name
//   │  wgo.example.com
//   │
//   ◆  Who should be able to use the dashboard?
//   │  ● Only people with my email domain(s)  recommended for teams
//   │  ○ Anyone with a verified email address
//   └  ↑/↓ to choose · enter to confirm

import { emitKeypressEvents } from 'node:readline';

const { stdin, stdout } = process;
const useColor = stdout.isTTY && !('NO_COLOR' in process.env);
const sgr = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  inverse: sgr(7, 27),
  strike: sgr(9, 29),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
};

const BAR = c.gray('│');
const ACTIVE_BAR = c.cyan('│');
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const width = (s) => [...s.replace(ANSI, '')].length;
const columns = () => stdout.columns || 80;

/** Word-wraps text to the terminal width, minus the rail. */
export function wrap(text, max = columns() - 4) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (line && width(line) + 1 + width(word) > max) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

// ── drawing: one live frame at a time, erased and redrawn in place ─────────────────────────────────────

let rows = 0;
const rowsOf = (text) => text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(width(l) / columns())), 0);
function erase() {
  if (rows > 1) stdout.write(`\x1b[${rows - 1}A`);
  if (rows) stdout.write('\r\x1b[J');
  rows = 0;
}
function paint(text) {
  erase();
  stdout.write(text);
  rows = rowsOf(text);
}
function commit(text) {
  paint(text);
  stdout.write('\n');
  rows = 0;
}

const showCursor = () => stdout.write('\x1b[?25h');
process.on('exit', showCursor);

// ── keys ──────────────────────────────────────────────────────────────────────────────────────────────

let active = null; // { render(state) } of the prompt on screen, so Ctrl+C can leave it in its cancelled form
let cancelMessage = 'Cancelled.';
export const setCancelMessage = (msg) => (cancelMessage = msg);

function cancel() {
  if (active) commit(active.render('cancel'));
  active = null;
  showCursor();
  stdout.write(`${c.gray('└')}  ${c.red(cancelMessage)}\n\n`);
  process.exit(130);
}

function listen(handler) {
  emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdout.write('\x1b[?25l');
  const onKey = (str, key = {}) => {
    if (key.ctrl && key.name === 'c') return cancel();
    handler(str, key);
  };
  stdin.on('keypress', onKey);
  return () => {
    stdin.off('keypress', onKey);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    showCursor();
  };
}

function run({ render, key }) {
  return new Promise((resolve) => {
    const draw = () => paint(render('active'));
    const done = (value) => {
      stop();
      active = null;
      commit(render('done'));
      resolve(value);
    };
    active = { render };
    const stop = listen((str, k) => key(str, k, { done, redraw: draw }));
    draw();
  });
}

// ── frame pieces ──────────────────────────────────────────────────────────────────────────────────────

function head(state, message) {
  const sym = state === 'active' ? c.cyan('◆') : state === 'cancel' ? c.red('■') : c.green('◇');
  return [BAR, `${sym}  ${message}`];
}
const helpLines = (help) => (help ? [].concat(help).flatMap((h) => wrap(h)).map((l) => `${ACTIVE_BAR}  ${c.dim(l)}`) : []);
const answer = (state, text) => `${BAR}  ${state === 'cancel' ? c.strike(c.dim(text)) : c.dim(text)}`;
const footer = (error, hint) =>
  error ? `${c.yellow('└')}  ${c.yellow(error)}` : `${c.cyan('└')}${hint ? `  ${c.dim(hint)}` : ''}`;

// ── prompts ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A line of text. `initial` is prefilled and editable; `placeholder` is only shown while empty.
 * `validate(value)` returns an error message or nothing; `preview(value)` returns line(s) shown live under
 * the input; `display(value)` is the summary once answered.
 */
export function text({ message, help, initial = '', placeholder = '', validate, preview, display, mask = false }) {
  let value = String(initial ?? '');
  let pos = value.length;
  let error = '';
  const shown = (v) => (mask ? '•'.repeat(v.length) : v);
  return run({
    render(state) {
      const lines = head(state, message);
      if (state !== 'active') {
        const v = value.trim();
        lines.push(answer(state, (display ? display(v) : shown(v)) || '(none)'));
        return lines.join('\n');
      }
      lines.push(...helpLines(help));
      let field;
      if (!value) field = placeholder ? c.inverse(placeholder[0]) + c.dim(placeholder.slice(1)) : c.inverse(' ');
      else {
        const s = shown(value);
        field = s.slice(0, pos) + c.inverse(s[pos] ?? ' ') + s.slice(pos + 1);
      }
      lines.push(`${ACTIVE_BAR}  ${field}`);
      for (const p of [].concat(preview?.(value.trim()) ?? [])) lines.push(`${ACTIVE_BAR}  ${p}`);
      lines.push(footer(error, 'enter to confirm'));
      return lines.join('\n');
    },
    key(str, k, { done, redraw }) {
      error = '';
      if (k.name === 'return' || k.name === 'enter') {
        const v = value.trim();
        const err = validate?.(v);
        if (err) {
          error = err;
          return redraw();
        }
        return done(v);
      }
      if (k.name === 'backspace') {
        if (pos > 0) (value = value.slice(0, pos - 1) + value.slice(pos)), pos--;
      } else if (k.name === 'delete') value = value.slice(0, pos) + value.slice(pos + 1);
      else if (k.name === 'left') pos = Math.max(0, pos - 1);
      else if (k.name === 'right') pos = Math.min(value.length, pos + 1);
      else if (k.name === 'home' || (k.ctrl && k.name === 'a')) pos = 0;
      else if (k.name === 'end' || (k.ctrl && k.name === 'e')) pos = value.length;
      else if (k.ctrl && k.name === 'u') (value = value.slice(pos)), (pos = 0);
      else if (k.ctrl && k.name === 'w') {
        const start = value.slice(0, pos).replace(/\S+\s*$/, '').length;
        value = value.slice(0, start) + value.slice(pos);
        pos = start;
      } else if (str && !k.ctrl && !k.meta && str.length === 1 && str >= ' ' && str !== '\x7f') {
        value = value.slice(0, pos) + str + value.slice(pos);
        pos++;
      }
      redraw();
    },
  });
}

/** One of `options` ({ value, label, hint?, disabled?: reason }). Resolves to the chosen value. */
export function select({ message, help, options, initial }) {
  const enabled = (i) => options[i] && !options[i].disabled;
  let i = options.findIndex((o) => o.value === initial);
  if (!enabled(i)) i = options.findIndex((o) => !o.disabled);
  const move = (d) => {
    for (let n = 1; n <= options.length; n++) {
      const j = (i + d * n + options.length * n) % options.length;
      if (enabled(j)) return (i = j);
    }
  };
  return run({
    render(state) {
      const lines = head(state, message);
      if (state !== 'active') {
        lines.push(answer(state, options[i].label));
        return lines.join('\n');
      }
      lines.push(...helpLines(help));
      options.forEach((o, j) => {
        if (o.disabled) lines.push(`${ACTIVE_BAR}  ${c.dim(`○ ${o.label}  (${o.disabled})`)}`);
        else if (j === i) lines.push(`${ACTIVE_BAR}  ${c.cyan('●')} ${o.label}${o.hint ? `  ${c.dim(o.hint)}` : ''}`);
        else lines.push(`${ACTIVE_BAR}  ${c.dim(`○ ${o.label}`)}`);
      });
      lines.push(footer('', '↑/↓ to choose · enter to confirm'));
      return lines.join('\n');
    },
    key(str, k, { done, redraw }) {
      if (k.name === 'return' || k.name === 'enter') return done(options[i].value);
      if (k.name === 'up' || k.name === 'k' || (k.shift && k.name === 'tab')) move(-1);
      else if (k.name === 'down' || k.name === 'j' || k.name === 'tab') move(1);
      else if (/^[1-9]$/.test(str ?? '') && enabled(Number(str) - 1)) i = Number(str) - 1;
      redraw();
    },
  });
}

/** Yes or no. */
export function confirm({ message, help, initial = true }) {
  let value = initial;
  return run({
    render(state) {
      const lines = head(state, message);
      if (state !== 'active') {
        lines.push(answer(state, value ? 'Yes' : 'No'));
        return lines.join('\n');
      }
      lines.push(...helpLines(help));
      const opt = (label, on) => (on ? `${c.cyan('●')} ${label}` : c.dim(`○ ${label}`));
      lines.push(`${ACTIVE_BAR}  ${opt('Yes', value)} ${c.dim('/')} ${opt('No', !value)}`);
      lines.push(footer('', 'y/n · ←/→ · enter to confirm'));
      return lines.join('\n');
    },
    key(str, k, { done, redraw }) {
      if (k.name === 'return' || k.name === 'enter') return done(value);
      if (k.name === 'y') return (value = true), done(true);
      if (k.name === 'n') return (value = false), done(false);
      if (['left', 'right', 'up', 'down', 'tab', 'h', 'l'].includes(k.name)) value = !value;
      redraw();
    },
  });
}

// ── status output ─────────────────────────────────────────────────────────────────────────────────────

const detailLines = (details) =>
  [].concat(details ?? []).flatMap((d) => wrap(d)).map((l) => `${BAR}  ${c.dim(l)}`);

function line(sym, text, details) {
  const [first, ...rest] = wrap(text);
  stdout.write([BAR, `${sym}  ${first}`, ...rest.map((l) => `${BAR}  ${l}`), ...detailLines(details)].join('\n') + '\n');
}

export const log = {
  info: (text, details) => line(c.blue('●'), text, details),
  ok: (text, details) => line(c.green('✔'), text, details),
  warn: (text, details) => line(c.yellow('▲'), text, details),
  error: (text, details) => line(c.red('✖'), text, details),
  /** Plain lines on the rail, e.g. a table. */
  lines: (lines) => stdout.write([BAR, ...lines.map((l) => `${BAR}  ${l}`)].join('\n') + '\n'),
};

/** Runs `task` with a spinner. `task` resolves to { ok|warn|fail: text, details? }; resolves to its result. */
export async function spin(message, task) {
  const frames = ['◒', '◐', '◓', '◑'];
  let f = 0;
  const stop = listen(() => {});
  active = { render: () => [BAR, `${c.red('■')}  ${message}`].join('\n') };
  const draw = () => paint([BAR, `${c.magenta(frames[f++ % frames.length])}  ${message}${c.dim('…')}`].join('\n'));
  draw();
  const timer = setInterval(draw, 90);
  let result;
  try {
    result = await task();
  } finally {
    clearInterval(timer);
    stop();
    active = null;
  }
  const [sym, text] = result?.fail
    ? [c.red('✖'), result.fail]
    : result?.warn
      ? [c.yellow('▲'), result.warn]
      : [c.green('✔'), result?.ok ?? message];
  const [first, ...rest] = wrap(text);
  commit([BAR, `${sym}  ${first}`, ...rest.map((l) => `${BAR}  ${l}`), ...detailLines(result?.details)].join('\n'));
  return result;
}

export function intro(title, subtitle) {
  stdout.write(`\n${c.gray('┌')}  ${c.inverse(` ${title} `)}${subtitle ? `  ${c.dim(subtitle)}` : ''}\n`);
}

export function section(n, total, title, blurb) {
  stdout.write(
    [BAR, BAR, `${c.magenta('▣')}  ${c.bold(title)}  ${c.dim(`step ${n} of ${total}`)}`, ...detailLines(blurb)].join('\n') + '\n',
  );
}

export function outro(text) {
  stdout.write(`${BAR}\n${c.gray('└')}  ${text}\n\n`);
}

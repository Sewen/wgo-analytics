import { useMemo } from 'react';
import { CopyButton } from './kit';

type Lang = 'html' | 'js' | 'sh' | 'py' | 'yaml';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function highlight(code: string, lang: Lang): string {
  const rules: Array<[string, RegExp]> = [];
  if (lang === 'html') {
    rules.push(['c', /&lt;!--[\s\S]*?--&gt;/], ['s', /"[^"]*"/], ['t', /&lt;\/?[a-zA-Z][\w-]*/], ['a', /\b[\w:-]+(?==)/], ['t', /\/?&gt;/]);
  } else if (lang === 'sh') {
    rules.push(['c', /#.*/], ['s', /"[^"]*"|'[^']*'/], ['k', /(?<![\w@/.-])(?:export|npm|pip|install|node|python|npx)(?![\w/.-])/], ['a', /\b[A-Z][A-Z0-9_]{3,}(?==)/]);
  } else if (lang === 'yaml') {
    rules.push(['c', /#.*/], ['s', /"[^"]*"|'[^']*'/], ['a', /[\w.-]+(?=:(?:\s|$))/]);
  } else if (lang === 'py') {
    rules.push(['c', /#.*/], ['s', /"[^"]*"|'[^']*'/], ['k', /\b(?:from|import|as|def|return|with|if|else|None|True|False)\b/], ['n', /\b\d+(?:\.\d+)?\b/]);
  } else {
    rules.push(['c', /\/\/.*/], ['s', /`[^`]*`|"[^"]*"|'[^']*'/], ['k', /\b(?:import|from|const|let|new|await|async|function|return|export|true|false|null)\b/], ['n', /\b\d+(?:\.\d+)?\b/], ['a', /\b\w+(?=:)/]);
  }
  const src = esc(code);
  const re = new RegExp(rules.map(([, r]) => `(${r.source})`).join('|'), 'g');
  return src.replace(re, (m, ...groups) => {
    const i = groups.findIndex((g, idx) => idx < rules.length && g !== undefined);
    return `<span class="tok-${rules[i][0]}">${m}</span>`;
  });
}

/** `wrap={false}` scrolls long lines sideways instead of breaking them, which reads better for indented code. */
export function CodeBlock({ code, lang, title, wrap = true }: { code: string; lang: Lang; title?: string; wrap?: boolean }) {
  const html = useMemo(() => highlight(code, lang), [code, lang]);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-[color-mix(in_srgb,var(--bg)_60%,black)]">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-[11px] text-faint">{title ?? lang}</span>
        <CopyButton text={code} />
      </div>
      <pre className={`${wrap ? 'whitespace-pre-wrap break-all' : 'overflow-x-auto whitespace-pre'} p-3.5 font-mono text-[12px] leading-[1.6] text-fg`}><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    </div>
  );
}

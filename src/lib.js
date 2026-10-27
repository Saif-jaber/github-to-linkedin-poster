// Pure helpers: parsing LLM output and building the code-image HTML.

export const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dashes = s => String(s).replace(/[\u2010-\u2015]/g, '-');
const ascii = s => String(s)
  .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
  .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
  .replace(/\u2026/g, '...')
  .replace(/[\u00A0\u2007\u2009\u200A\u202F]/g, ' ');
export const clean = s => ascii(dashes(s));

// "N | repo name | idea title | angle" lines -> idea objects
export function parseIdeas(raw, repos) {
  const out = [];
  for (const line of String(raw || '').replace(/\r/g, '').split('\n')) {
    if (!line.includes('|')) continue;
    const p = line.split('|').map(s => s.trim());
    const n = parseInt(p[0].replace(/\D/g, ''), 10);
    const repo = repos.find(r => r.n === n);
    if (!repo || !p[2] || out.some(o => o.option === n)) continue;
    out.push({ option: n, repo, title: clean(p[2]), angle: clean(p[3] || '') });
  }
  if (!out.length) {
    for (const r of repos) {
      out.push({ option: r.n, repo: r, title: `What I built in ${r.name} and why`, angle: 'Overview of the project and the problem it solves' });
    }
  }
  return out;
}

// LLM output ("FILE: / LINES: / POST:") -> post text + code image html/css
export function parsePost(raw, files, repoUrl) {
  raw = String(raw || '').replace(/\r/g, '');

  const pi = raw.search(/^\s*POST\s*:/mi);
  let post = (pi >= 0 ? raw.slice(pi).replace(/^\s*POST\s*:\s*/i, '') : raw).trim();
  post = post.replace(/\*\*/g, '').replace(/^["\u201C]|["\u201D]$/g, '').trim();
  post = clean(post)
    .replace(/^[ \t]*(?:->|[\u2192\u2794\u27A1])[ \t]*/gm, '')
    .replace(/^[ \t]*here(?:'s| is) (?:the )?core of it[ \t]*:?[ \t]*$/gim, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (post.length > 2900) post = post.slice(0, 2900);

  const header = pi >= 0 ? raw.slice(0, pi) : '';
  const fileM = header.match(/FILE\s*:\s*(.+)/i);
  const linesM = header.match(/LINES\s*:\s*(\d+)\s*(?:-|\u2013|to)\s*(\d+)/i);
  const file = fileM ? fileM[1].trim().replace(/^[`'"]|[`'"]$/g, '') : '';

  let snippet = [], start = 0, end = 0;
  if (file && linesM && files && files[file]) {
    start = Math.max(1, parseInt(linesM[1], 10));
    end = parseInt(linesM[2], 10);
    if (end - start > 19) end = start + 19;
    snippet = files[file].slice(start - 1, end).map(l => l.replace(/\t/g, '  '));
  }
  while (snippet.length && !snippet[0].trim()) { snippet.shift(); start++; }
  while (snippet.length && !snippet[snippet.length - 1].trim()) snippet.pop();
  const hasImage = snippet.length >= 4;

  let html = '', css = '';
  if (hasImage) {
    const indents = snippet.filter(l => l.trim()).map(l => l.match(/^ */)[0].length);
    const minIndent = indents.length ? Math.min(...indents) : 0;
    snippet = snippet.map(l => l.slice(minIndent).replace(/\s+$/, ''));

    const KW = /^(?:const|let|var|function|return|if|else|for|while|import|from|export|default|class|new|async|await|try|catch|throw|def|self|None|True|False|true|false|null|undefined|in|of|as|with|yield|lambda|public|private|protected|static|void|int|string|bool|func|fn|pub|struct|impl|use|type|interface|extends|switch|case|break|continue|raise|except|finally|and|or|not|is|match|enum|mut|package|go|defer|chan|range|map)$/;
    const tokenRe = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
    const hl = line => {
      let out = '', last = 0;
      line.replace(tokenRe, (m, c, s, n, id, off) => {
        out += esc(line.slice(last, off));
        if (c) out += `<span class="c">${esc(m)}</span>`;
        else if (s) out += `<span class="s">${esc(m)}</span>`;
        else if (n) out += `<span class="m">${esc(m)}</span>`;
        else if (id && KW.test(m)) out += `<span class="k">${esc(m)}</span>`;
        else if (id && line[off + m.length] === '(') out += `<span class="f">${esc(m)}</span>`;
        else out += esc(m);
        last = off + m.length;
        return m;
      });
      return out + esc(line.slice(last));
    };

    const maxLen = Math.max(...snippet.map(l => l.length));
    const fs = maxLen <= 55 ? 26 : maxLen <= 65 ? 22 : maxLen <= 75 ? 19 : 16;
    const nw = Math.round(String(start + snippet.length).length * fs * 0.62);
    const rows = snippet.map((l, i) => `<div class="ln"><span class="n">${start + i}</span><span class="t">${hl(l) || ' '}</span></div>`).join('');

    css = `
body{margin:0}
#bg{width:1080px;box-sizing:border-box;padding:56px;background:linear-gradient(135deg,#6d28d9,#2563eb);font-family:'JetBrains Mono',monospace}
.win{background:#0d1117;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.45);overflow:hidden}
.bar{display:flex;align-items:center;padding:18px 22px;background:#161b22}
.dot{width:16px;height:16px;border-radius:50%;margin-right:10px}
.r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
.file{margin-left:14px;color:#8b949e;font-size:20px}
.code{padding:28px 30px}
.ln{display:flex;white-space:pre;line-height:1.55;font-size:${fs}px}
.n{color:#6e7681;width:${nw}px;flex:none;text-align:right;margin-right:22px}
.t{color:#e6edf3}
.k{color:#ff7b72}.s{color:#a5d6ff}.c{color:#8b949e;font-style:italic}.m{color:#79c0ff}.f{color:#d2a8ff}
`;
    html = `<div id="bg"><div class="win"><div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="file">${esc(file)}</span></div><div class="code">${rows}</div></div></div>`;
  }

  const telegramText = esc(post)
    + '\n\n----------\nSuggested first comment:\n' + esc(`Full project on GitHub: ${repoUrl}`)
    + (hasImage ? `\n\nImage: ${esc(file)} lines ${start}-${start + snippet.length - 1}` : '\n\n(No code image this time.)');

  return { post, html, css, hasImage, telegramText, file: hasImage ? file : '' };
}

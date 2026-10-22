// Daily LinkedIn post generator: GitHub repos -> Groq ideas -> Groq post -> code image -> Telegram.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, parseIdeas, parsePost } from './lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_FILE = path.join(ROOT, 'history.json');
const VOICE_FILE = path.join(ROOT, 'voice_examples.txt');

const CFG = {
  githubUser: process.env.GITHUB_USERNAME || 'Saif-jaber',
  githubToken: process.env.GH_PAT || '',
  maxRepos: Number(process.env.MAX_REPOS || 8),
  daysBack: Number(process.env.DAYS_BACK || 60),
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  dryRun: process.env.DRY_RUN === '1',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const need = k => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing secret/env var: ${k}`);
  return v;
};

// ---------- GitHub ----------
const ghHeaders = (accept = 'application/vnd.github+json') => {
  const h = { 'User-Agent': 'github-linkedin-poster', Accept: accept };
  if (CFG.githubToken) h.Authorization = 'Bearer ' + CFG.githubToken;
  return h;
};
async function ghJson(url) {
  const r = await fetch(url, { headers: ghHeaders() });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${url}`);
  return r.json();
}
async function ghRaw(url) {
  const r = await fetch(url, { headers: ghHeaders('application/vnd.github.raw+json') });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${url}`);
  return r.text();
}

// ---------- Groq ----------
async function groq(system, user) {
  const key = need('GROQ_API_KEY');
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: CFG.groqModel,
          temperature: 0.7,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!r.ok) throw new Error(`Groq ${r.status}: ${await r.text()}`);
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content;
      if (text) return text;
      throw new Error('Groq returned empty content');
    } catch (e) {
      lastErr = e;
      console.warn(`Groq attempt ${i} failed: ${e.message}`);
      await sleep(2000 * i);
    }
  }
  throw lastErr;
}

// ---------- hcti.io (HTML -> image) ----------
async function createCodeImage(html, css) {
  const auth = Buffer.from(`${need('HCTI_USER_ID')}:${need('HCTI_API_KEY')}`).toString('base64');
  const r = await fetch('https://hcti.io/v1/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
    body: JSON.stringify({ html, css, google_fonts: 'JetBrains Mono', selector: '#bg', device_scale: 2 }),
  });
  if (!r.ok) throw new Error(`hcti.io ${r.status}: ${await r.text()}`);
  const { url } = await r.json();
  if (!url) throw new Error('hcti.io returned no image url');
  const img = await fetch(url);
  if (!img.ok) throw new Error(`Image download failed: ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

// ---------- Telegram ----------
const tgUrl = m => `https://api.telegram.org/bot${need('TELEGRAM_BOT_TOKEN')}/${m}`;
async function tgPhoto(buf, caption) {
  const fd = new FormData();
  fd.append('chat_id', need('TELEGRAM_CHAT_ID'));
  fd.append('caption', caption);
  fd.append('photo', new Blob([buf], { type: 'image/png' }), 'code.png');
  const j = await (await fetch(tgUrl('sendPhoto'), { method: 'POST', body: fd })).json();
  if (!j.ok) throw new Error('Telegram sendPhoto failed: ' + JSON.stringify(j));
}
async function tgText(text) {
  const r = await fetch(tgUrl('sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: need('TELEGRAM_CHAT_ID'), text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram sendMessage failed: ' + JSON.stringify(j));
}

// ---------- history ----------
const loadHistory = () => {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
};
const saveHistory = rows => fs.writeFileSync(HISTORY_FILE, JSON.stringify(rows, null, 2) + '\n');

// ---------- step 1: pick an idea ----------
async function pickIdea(history) {
  const repos = await ghJson(`https://api.github.com/users/${CFG.githubUser}/repos?per_page=100&sort=pushed`);
  const cutoff = Date.now() - CFG.daysBack * 86400000;
  let candidates = repos.filter(r => !r.fork && !r.archived && new Date(r.pushed_at).getTime() > cutoff).slice(0, CFG.maxRepos);
  if (!candidates.length) candidates = repos.filter(r => !r.fork && !r.archived).slice(0, CFG.maxRepos);
  if (!candidates.length) throw new Error(`No usable repos found for ${CFG.githubUser}`);

  const lastDrafted = {}, titles = {};
  for (const r of history) {
    (titles[r.repo] = titles[r.repo] || []).push(String(r.title || ''));
    lastDrafted[r.repo] = Math.max(lastDrafted[r.repo] || 0, new Date(r.date).getTime() || 1);
  }
  // least recently posted first (never posted = first)
  candidates.sort((a, b) => (lastDrafted[a.name] || 0) - (lastDrafted[b.name] || 0));
  const picked = candidates.slice(0, 4);

  let prompt = '';
  const list = [];
  let n = 0;
  for (const r of picked) {
    n++;
    let readme = '';
    try { readme = await ghRaw(`https://api.github.com/repos/${r.full_name}/readme`); } catch {}
    let commits = [];
    try {
      const c = await ghJson(`https://api.github.com/repos/${r.full_name}/commits?per_page=5`);
      commits = c.map(x => '- ' + x.commit.message.split('\n')[0]);
    } catch {}
    const used = (titles[r.name] || []).slice(-8).join(' | ') || 'none';
    prompt += `REPO ${n}: ${r.name}\nDescription: ${r.description || 'none'}\nLanguage: ${r.language || 'unknown'}\nREADME: ${readme.slice(0, 700)}\nRecent commits:\n${commits.join('\n')}\nIdeas already used for this repo (do not repeat): ${used}\n\n`;
    list.push({ n, name: r.name, full_name: r.full_name, url: r.html_url });
  }

  const raw = await groq(
    'You plan LinkedIn post ideas for a software developer who wants to impress recruiters. For EACH repo below, propose exactly ONE post idea based on that repo\'s real content. Never invent features. Make the ideas different from each other (for example: a build story, a technical challenge, a design trade-off, how it works, a lesson learned). Never repeat an idea already used for that repo. Output exactly one line per repo, in this format, and nothing else:\nN | repo name | idea title (max 12 words) | angle in one sentence',
    prompt,
  );
  const ideas = parseIdeas(raw, list);
  if (!ideas.length) throw new Error('No post ideas were generated.');
  return ideas[0];
}

// ---------- step 2: gather material from the chosen repo ----------
async function gatherMaterial(idea) {
  const full = idea.repo.full_name;
  let readme = '';
  try { readme = await ghRaw(`https://api.github.com/repos/${full}/readme`); } catch {}
  let commits = [];
  try {
    const cc = await ghJson(`https://api.github.com/repos/${full}/commits?per_page=10`);
    commits = cc.map(x => '- ' + x.commit.message.split('\n')[0]);
  } catch {}

  const EXT = /\.(js|jsx|ts|tsx|py|go|rs|java|kt|swift|cs|php|rb|dart|vue|svelte|cpp|c)$/i;
  const SKIP = /(node_modules|dist\/|build\/|vendor|\.min\.|\.d\.ts|__tests__|\btests?\b|\.test\.|\.spec\.|migrations?|\.config\.|fixtures?|mock|generated|\.github)/i;
  let tree = [];
  try { tree = (await ghJson(`https://api.github.com/repos/${full}/git/trees/HEAD?recursive=1`)).tree || []; } catch {}
  const cands = tree.filter(t => t.type === 'blob' && EXT.test(t.path) && !SKIP.test(t.path) && t.size > 500 && t.size < 25000);
  const score = f => {
    let s = 0;
    if (/(^|\/)(src|lib|app|core|server|api|services?|utils?|components?)\//i.test(f.path)) s += 3;
    if (/(main|index|app|server|core|service|handler|controller|parser|util|train|model)/i.test(f.path)) s += 2;
    s -= (f.path.split('/').length - 1) * 0.5;
    if (f.size > 1500 && f.size < 9000) s += 2;
    return s;
  };
  cands.sort((a, b) => score(b) - score(a));
  const pool = cands.slice(0, 8);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const files = {};
  let fileContext = '';
  for (const f of pool.slice(0, 3)) {
    try {
      const text = await ghRaw(`https://api.github.com/repos/${full}/contents/${f.path}`);
      const lines = String(text).replace(/\r/g, '').split('\n').slice(0, 200);
      files[f.path] = lines;
      fileContext += `\n=== FILE: ${f.path} ===\n` + lines.slice(0, 90).map((l, i) => `${i + 1}: ${l.slice(0, 100)}`).join('\n') + '\n';
    } catch {}
  }
  const context = [
    `Repo: ${idea.repo.name}`, 'README (truncated):', readme.slice(0, 2000), '',
    'Recent commits:', commits.join('\n'), '', 'SOURCE FILES (line-numbered):', fileContext || '(none found)',
  ].join('\n');
  return { files, context };
}

// ---------- step 3: write the post ----------
async function writePost(idea, material, recentOpenings) {
  let voice = '';
  try { voice = fs.readFileSync(VOICE_FILE, 'utf8').trim(); } catch {}
  if (/^Paste 3-5 of your own/i.test(voice)) voice = '';

  const system = `You write LinkedIn posts for a software developer who wants to impress recruiters and hiring managers. Write in first person. Be professional, specific and credible.

STRUCTURE:
1. Hook (first 1-2 lines, under 180 characters): a concrete problem, result or insight. Never use openers like 'Excited to announce', 'Thrilled', 'Happy to share'.
2. Context: 1-2 short sentences on what the project is and the problem it solves.
3. How it works: 3-4 short lines starting with an arrow (->), about real decisions and technologies from the repo. Prefer the decision and the trade-off over listing parameters. Refer naturally to the code image, e.g. 'Here is the core of it:'.
4. The takeaway: 1-2 sentences showing engineering judgment.
5. One genuine question to other developers.
6. Last line: 3-4 relevant hashtags.

RULES: No emojis. No buzzwords (passionate, rockstar, ninja, synergy, game-changer). Never invent features, numbers, users or results; use only what is in the repo info. Under 1100 characters. Short paragraphs separated by blank lines. Use plain hyphens only.

CODE SNIPPET: from the numbered SOURCE FILES, choose the most interesting self-contained block of 8 to 16 lines (a core function, a clever pattern, a clean algorithm) that fits the idea. Prefer lines under 60 characters wide. Never choose imports, config, or boilerplate. Use the exact file path and line numbers shown. If no source files are provided, use FILE: none and LINES: 0-0.

OUTPUT FORMAT, exactly, with nothing before FILE:
FILE: <path>
LINES: <start>-<end>
POST:
<the post text>
${voice ? `\nVOICE EXAMPLES (match this tone):\n${voice}` : ''}`;

  const user = `Write the post for this chosen idea.\n\nIDEA: ${idea.title}\nANGLE: ${idea.angle}\n\nDo NOT reuse the opening line or the code snippet of these recent posts: ${recentOpenings || 'none'}\n\n${material.context}`;
  return groq(system, user);
}

// ---------- main ----------
async function main() {
  const history = loadHistory();
  console.log(`History rows: ${history.length}`);

  const idea = await pickIdea(history);
  console.log(`Idea: [${idea.repo.name}] ${idea.title}`);

  const material = await gatherMaterial(idea);
  const recent = history.slice(-5).map(r => String(r.post || '').split('\n')[0]).filter(Boolean).join(' || ');
  const raw = await writePost(idea, material, recent);
  const result = parsePost(raw, material.files, idea.repo.url);
  console.log(`Post length: ${result.post.length} chars | code image: ${result.hasImage}`);

  if (CFG.dryRun) {
    console.log('\n--- DRY RUN (nothing sent) ---\n');
    console.log(result.telegramText);
    return;
  }

  // Send the code image first (if any). If the image fails, still send the post text.
  if (result.hasImage) {
    try {
      const png = await createCodeImage(result.html, result.css);
      await tgPhoto(png, "Today's LinkedIn post image. The post text arrives in the next message.");
      console.log('Image sent.');
    } catch (e) {
      console.error('Image step failed (sending text only):', e.message);
    }
  }
  await tgText(result.telegramText);
  console.log('Post text sent.');

  history.push({
    id: String(Date.now()),
    date: new Date().toISOString().slice(0, 10),
    repo: idea.repo.name,
    repo_full_name: idea.repo.full_name,
    title: idea.title,
    angle: idea.angle,
    status: 'drafted',
    file: result.file,
    post: result.post,
  });
  saveHistory(history);
  console.log('History saved.');
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});

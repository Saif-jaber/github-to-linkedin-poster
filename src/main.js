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
  newsRatio: Number(process.env.NEWS_RATIO || 0.45), // chance to post news vs repo
  newsTopics: (process.env.NEWS_TOPICS || 'web development, frontend, backend, AI, machine learning, LLMs, agentic AI, TypeScript, React, Next.js, Rust, AI tooling').split(',').map(s => s.trim()),
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

// ---------- news sources ----------
async function fetchNews() {
  const topics = CFG.newsTopics.slice(0, 6).join(' OR ');
  const query = `(${topics}) (release OR launch OR announcement OR "open source" OR research OR breakthrough) since:2025-01-01`;
  try {
    // Try Hacker News search
    const hn = await fetch(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent('web dev ai machine learning')}&tags=story&hitsPerPage=30`);
    if (hn.ok) {
      const j = await hn.json();
      const items = (j.hits || []).filter(h => h.title && h.url).slice(0, 15);
      if (items.length) return items.map(h => ({ source: 'HN', title: h.title, url: h.url, points: h.points }));
    }
  } catch {}
  try {
    // Fallback: use Groq to suggest recent news
    const raw = await groq(
      'You are a tech news curator. Suggest 5-8 recent (last 7-14 days) noteworthy news items in web development, AI, and machine learning. For each, give: title, source/name, short summary (1-2 sentences), URL if known or "unknown". Prioritize open source releases, model/tool launches, framework updates, or research with practical impact. Output one per line as: TITLE | SOURCE | SUMMARY | URL',
      `Topics: ${CFG.newsTopics.join(', ')}. Focus on items developers would find interesting to post about on LinkedIn.`
    );
    const items = [];
    for (const line of raw.split('\n')) {
      if (!line.includes('|')) continue;
      const p = line.split('|').map(s => s.trim());
      if (p[0] && p[1]) items.push({ source: p[1], title: p[0], summary: p[2] || '', url: p[3] && p[3] !== 'unknown' ? p[3] : '' });
    }
    if (items.length) return items;
  } catch {}
  return [];
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function pickNewsIdea(history) {
  const news = await fetchNews();
  if (!news.length) throw new Error('No news found');
  const usedTitles = new Set(history.filter(h => h.type === 'news').map(h => norm(h.title)));
  const usedUrls = new Set(history.filter(h => h.type === 'news' && h.url).map(h => h.url));
  const seen = new Set();
  const unique = [];
  for (const n of news) {
    const t = norm(n.title);
    const u = n.url;
    if (!t) continue;
    if (usedTitles.has(t)) continue;
    if (u && usedUrls.has(u)) continue;
    if (seen.has(t) || (u && seen.has(u))) continue;
    seen.add(t);
    if (u) seen.add(u);
    unique.push(n);
  }
  const candidates = unique.slice(0, 12);
  if (!candidates.length) {
    // if everything seen, still avoid exact repeats but allow if none left? just pick from fresh batch by different title
    const fresh = news.filter(n => {
      const t = norm(n.title);
      const u = n.url;
      if (usedTitles.has(t)) return false;
      if (u && usedUrls.has(u)) return false;
      return true;
    });
    if (!fresh.length) throw new Error('No new news items (all seen in history)');
    candidates.push(...fresh.slice(0, 12));
  }
  const pool = candidates.slice(0, 12);
  const picked = pool.slice(0, 4);
  
  let prompt = '';
  for (let i = 0; i < picked.length; i++) {
    const n = picked[i];
    prompt += `NEWS ${i + 1}:\nTitle: ${n.title}\nSource: ${n.source}\nSummary: ${n.summary || ''}\nURL: ${n.url || 'none'}\n\n`;
  }
  
  const raw = await groq(
    'You plan LinkedIn post ideas about tech news for a software engineer interested in web dev, AI, and ML. For each news item, propose exactly ONE post idea: explain why it matters, give a technical take/opinion, and make it engaging for developers. Never just regurgitate headlines. Pick different angles. Output exactly one line per item as: N | news | idea title (max 12 words) | angle in one sentence',
    prompt
  );
  const ideas = [];
  for (const line of String(raw || '').replace(/\r/g, '').split('\n')) {
    if (!line.includes('|')) continue;
    const p = line.split('|').map(s => s.trim());
    const n = parseInt(p[0].replace(/\D/g, ''), 10) - 1;
    const item = picked[n];
    if (!item || !p[2]) continue;
    ideas.push({ type: 'news', item, title: clean(p[2]), angle: clean(p[3] || '') });
  }
  if (!ideas.length) throw new Error('No news ideas generated');
  return ideas[0];
}

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

// ---------- step 2: gather material ----------
async function gatherNewsMaterial(idea) {
  const item = idea.item;
  let context = `News Item: ${item.title}\nSource: ${item.source}\nURL: ${item.url || 'none'}\nSummary: ${item.summary || ''}\n\n`;
  // Try to fetch the page if URL exists
  if (item.url && item.url.startsWith('http')) {
    try {
      const r = await fetch(item.url, { headers: { 'User-Agent': 'github-linkedin-poster' } });
      if (r.ok) {
        const html = await r.text();
        // crude extract
        const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500);
        context += `Page excerpt (truncated): ${text}\n`;
      }
    } catch {}
  }
  return { context, files: {} };
}

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

  if (idea.type === 'news') {
    const system = `You write LinkedIn posts for a software developer sharing tech news/opinions. Write in first person as the developer. Sound like a real engineer commenting on something interesting, not a marketer.
 
GOAL: share something worth reading in web dev/AI/ML and start a discussion.
 
STRUCTURE:
1. Hook (first 1-2 lines): mention the news/tool/release and why it caught your attention.
2. Context: what is it and why it matters for developers.
3. Take: your technical opinion/take - what excites you or concerns you, tradeoffs.
4. Relevance: how it relates to what you care about or might affect builders.
5. Question to others + hashtags at the end.

WRITING RULES:
- No emojis. No bullets, arrows, labels. Full sentences/paragraphs.
- Plain ASCII punctuation only. No em/en dashes, curly quotes, ellipsis.
- Avoid AI-sounding phrases, buzzwords (passionate, revolutionary), consultant jargon.
- Show opinion, don't just summarize.
- Under 1100 chars. Short paragraphs.
- Include source if URL provided.

OUTPUT FORMAT exactly:
FILE: none
LINES: 0-0
POST:
<the post text>
${voice ? `\nVOICE EXAMPLES (match this tone):\n${voice}` : ''}`;

    const user = `Write the post for this tech news.\n\nIDEA: ${idea.title}\nANGLE: ${idea.angle}\n\nDo NOT reuse openings of these recent posts: ${recentOpenings || 'none'}\n\n${material.context}`;
    return groq(system, user);
  }

  const system = `You write LinkedIn posts for a software developer who wants to be noticed by recruiters and hiring managers. Write in first person as the developer. Sound like a real engineer explaining real work to peers, not a marketer and not an AI assistant.
 
GOAL: make a recruiter stop scrolling, understand the developer's skills within 10 seconds, and want to open the GitHub link.
 
STRUCTURE:
1. Hook (first 1-2 lines, under 180 characters): a specific problem, a surprising result or a sharp technical insight taken from the repo. It must stand alone, because LinkedIn cuts the post after about two lines. Never open with 'Excited to announce', 'Thrilled to share', 'Happy to share', 'As a developer', or a vague rhetorical question.
2. Context: 1-2 short sentences on what the project is, who it helps and the problem it solves.
3. How it works: 2-3 plain sentences, written as normal prose, about the real decisions, stack and trade-offs from the repo. Pick one concrete mechanism and explain it the way you would to a teammate. Name the stack naturally so recruiters can see relevant skills.
4. Proof and takeaway: 1-2 sentences with a specific, verifiable detail (a constraint, a design choice, a behaviour that exists in the code) and what it taught you.
5. One genuine question to other developers, tied to the specific technical choice, not a generic thought-leadership question.
6. Last line: 3-4 relevant hashtags.
 
WRITING RULES:
- No emojis.
- No bullets, no numbered lists, no arrow markers (->), no label-style lines like 'The problem:' or 'The result:'. Write full sentences and paragraphs only.
- Never use em dashes or en dashes. Use commas, full stops or plain hyphens instead.
- Use plain ASCII punctuation only. Plain apostrophes and quotes, no curly quotes, no ellipsis characters, no fancy arrows.
- Never write 'Here is the core of it', 'Here's the core', 'Here's how it works', 'The trade-off is', 'The payoff is', 'no longer needs', 'on the fly', 'dramatically', 'seamlessly', 'resolution-independent' or 'media footprint'.
- Never use AI-sounding phrases: 'delve', 'leverage', 'seamless', 'robust', 'cutting-edge', 'game-changer', 'in today's fast-paced world', 'it is not just X, it is Y', 'here is the thing', 'let that sink in', 'the result?', 'and that is exactly why'.
- Do not use the balanced two-part formula: a polished setup, a semicolon, then a neat payoff. Avoid semicolons in the post. Prefer two short sentences.
- No rule-of-three padding, no over-polished parallel sentences, no motivational filler, no rhetorical questions used as transitions.
- Vary sentence and paragraph length. Some paragraphs can be a single blunt sentence. Do not start consecutive sentences or lines with the same word.
- No buzzwords (passionate, rockstar, ninja, synergy, innovative, revolutionary) and no consultant jargon (combinatorial, holistic, best-in-class, paradigm).
- Never invent features, numbers, users, metrics or results. Use only what is in the repo info. If no metric is given, describe the behaviour instead of inventing a number.
- Show, do not tell. Replace adjectives with concrete actions and choices.
- Under 1100 characters. Short paragraphs separated by blank lines.
 
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

  // Decide: news or repo
  const doNews = Math.random() < CFG.newsRatio;
  let idea, material, result;
  const recent = history.slice(-5).map(r => String(r.post || '').split('\n')[0]).filter(Boolean).join(' || ');

  if (doNews) {
    try {
      idea = await pickNewsIdea(history);
      console.log(`Idea (NEWS): ${idea.item.title} -> ${idea.title}`);
      material = await gatherNewsMaterial(idea);
      const raw = await writePost(idea, material, recent);
      result = parsePost(raw, material.files, idea.item.url || '');
      // For news, skip image
      result.hasImage = false;
      result.html = '';
      result.css = '';
      // For news, maybe add source link in text
      if (idea.item.url && result.post && !result.post.includes(idea.item.url)) {
        result.post = result.post.replace(/\n\n([^\n]+#)/, `\n\nSource: ${idea.item.url}\n\n$1`).replace(/#([A-Za-z0-9_]+)/g, '#$1');
        // rebuild telegram text
        result.telegramText = esc(result.post) + '\n\n----------\nSuggested first comment:\n' + esc(idea.item.url ? `Source: ${idea.item.url}` : 'Thoughts from the field.');
      } else if (!result.telegramText.includes('Source') && idea.item.url) {
        result.telegramText = esc(result.post) + '\n\n----------\nSuggested first comment:\n' + esc(`Source: ${idea.item.url}`);
      }
    } catch (e) {
      console.warn('News path failed, falling back to repo:', e.message);
      idea = await pickIdea(history);
      console.log(`Idea: [${idea.repo.name}] ${idea.title}`);
      material = await gatherMaterial(idea);
      const raw = await writePost(idea, material, recent);
      result = parsePost(raw, material.files, idea.repo.url);
    }
  } else {
    idea = await pickIdea(history);
    console.log(`Idea: [${idea.repo.name}] ${idea.title}`);
    material = await gatherMaterial(idea);
    const raw = await writePost(idea, material, recent);
    result = parsePost(raw, material.files, idea.repo.url);
  }

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

  if (idea.type === 'news') {
    history.push({
      id: String(Date.now()),
      date: new Date().toISOString().slice(0, 10),
      type: 'news',
      source: idea.item.source,
      title: idea.item.title,
      url: idea.item.url,
      postTitle: idea.title,
      angle: idea.angle,
      status: 'drafted',
      post: result.post,
    });
  } else {
    history.push({
      id: String(Date.now()),
      date: new Date().toISOString().slice(0, 10),
      type: 'repo',
      repo: idea.repo.name,
      repo_full_name: idea.repo.full_name,
      title: idea.title,
      angle: idea.angle,
      status: 'drafted',
      file: result.file,
      post: result.post,
    });
  }
  saveHistory(history);
  console.log('History saved.');
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});

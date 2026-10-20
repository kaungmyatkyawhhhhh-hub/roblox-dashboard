#!/usr/bin/env node
// Sends your local Claude Code conversation to the dashboard's Claude tab.
//
// Claude Code runs this as a hook: when you send a prompt (UserPromptSubmit)
// and when Claude finishes replying (Stop). It posts the text to your
// Cloudflare worker, which keeps it behind a private key only you have.
//
//   node claude-feed.js install <worker url>   set up the hooks, print your key
//   node claude-feed.js test                   send a test message
//   node claude-feed.js uninstall              remove the hooks
//
// Needs Node 18 or newer (Claude Code already does).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.claude');
const SELF = path.join(DIR, 'claude-feed.js');
const CONFIG = path.join(DIR, 'claude-feed.json');
const SETTINGS = path.join(DIR, 'settings.json');
const EVENTS = ['UserPromptSubmit', 'Stop'];

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

async function post(body) {
  const cfg = readJson(CONFIG, null);
  if (!cfg || !cfg.url || !cfg.key) return { ok: false, error: 'not installed' };
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-feed-key': cfg.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const out = await res.json().catch(() => ({}));
  return res.ok ? { ok: true } : { ok: false, error: out.error || `HTTP ${res.status}` };
}

// Claude's reply for the turn that just ended: the text of the assistant
// messages after your last prompt in the session transcript.
function lastReply(transcriptPath) {
  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n'); } catch { return ''; }
  const parts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.isSidechain || e.isMeta) continue;
    const content = e.message && e.message.content;
    if (e.type === 'user') {
      const isPrompt = typeof content === 'string' || (Array.isArray(content) && content.some((c) => c.type === 'text'));
      if (isPrompt) break;
      continue;
    }
    if (e.type === 'assistant' && Array.isArray(content)) {
      const text = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n');
      if (text.trim()) parts.unshift(text.trim());
    }
  }
  return parts.join('\n\n');
}

async function hook() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const h = JSON.parse(input || '{}');
  const base = { session: h.session_id, project: h.cwd ? h.cwd.split(/[\\/]/).filter(Boolean).pop() : '' };
  if (h.hook_event_name === 'UserPromptSubmit') {
    await post({ ...base, role: 'user', text: h.prompt || '', status: 'working' });
  } else if (h.hook_event_name === 'Stop') {
    let text = lastReply(h.transcript_path);
    // The transcript can lag a moment behind the end of the turn.
    if (!text) { await new Promise((r) => setTimeout(r, 400)); text = lastReply(h.transcript_path); }
    await post({ ...base, role: 'assistant', text, status: 'idle' });
  }
}

function setHooks(add) {
  const settings = readJson(SETTINGS, {});
  settings.hooks ||= {};
  const command = `node "${SELF.replace(/\\/g, '/')}"`;
  for (const ev of EVENTS) {
    const kept = (settings.hooks[ev] || []).map((m) => ({ ...m, hooks: (m.hooks || []).filter((x) => !String(x.command || '').includes('claude-feed.js')) })).filter((m) => m.hooks.length);
    if (add) kept.push({ hooks: [{ type: 'command', command, timeout: 10 }] });
    if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd) return hook();
  if (cmd === 'install') {
    if (!/^https?:\/\//.test(arg || '')) throw new Error('Usage: node claude-feed.js install https://your-worker.workers.dev');
    fs.mkdirSync(DIR, { recursive: true });
    if (path.resolve(__filename) !== path.resolve(SELF)) fs.copyFileSync(__filename, SELF);
    const old = readJson(CONFIG, {});
    const key = old.key || crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(CONFIG, JSON.stringify({ url: arg, key }, null, 2) + '\n', { mode: 0o600 });
    setHooks(true);
    console.log(`Installed. Hooks added to ${SETTINGS}`);
    console.log(`\nYour feed key (keep it private):\n\n  ${key}\n`);
    console.log('1. In Cloudflare, add it to your worker as a secret named CLAUDE_FEED_KEY.');
    console.log('2. Paste the same key into the Claude tab on your dashboard.');
    console.log('3. Restart Claude Code so it picks up the new hooks.');
    return;
  }
  if (cmd === 'uninstall') { setHooks(false); console.log('Hooks removed. Your messages are no longer sent.'); return; }
  if (cmd === 'test') {
    const r = await post({ session: 'test', project: 'claude-feed test', role: 'assistant', text: 'Test message from claude-feed.js. If you can read this on the dashboard, it works.', status: 'idle' });
    console.log(r.ok ? 'Sent. Check the Claude tab on your dashboard.' : `Not sent: ${r.error}`);
    return;
  }
  throw new Error(`Unknown command "${cmd}". Use install, test or uninstall.`);
}

// A hook must never get in Claude Code's way: report problems, always exit 0.
main().catch((e) => {
  if (process.argv[2]) { console.error(e.message); process.exitCode = 1; }
  else process.stderr.write(`claude-feed: ${e.message}\n`);
});

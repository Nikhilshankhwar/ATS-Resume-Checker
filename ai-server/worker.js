// Resume SAT – AI and reviews server (Cloudflare Worker)
//
// What it does:
//   POST /          → AI: adds the secret Groq key and asks Groq (the website's AI buttons)
//   POST /review    → saves a review from the website
//   GET  /reviews?key=YOUR_ADMIN_KEY → shows all reviews to you (the owner)
//
// Settings in Cloudflare (Worker → Settings → Variables and Secrets / Bindings):
//   GROQ_API_KEY  (Secret)       your Groq key
//   ADMIN_KEY     (Secret)       any long password you choose, used to read reviews
//   REVIEWS       (KV binding)   a KV namespace where reviews are saved
// None of these are ever in the website code.

// Only these websites may use this server.
const ALLOWED_ORIGINS = ['https://nikhilshankhwar.github.io'];

// Tried in order. Each model has its own free daily limit on Groq,
// so when one is used up the next one answers.
const MODELS = [
  { id: 'openai/gpt-oss-120b', extra: { reasoning_effort: 'low' } },
  { id: 'openai/gpt-oss-20b', extra: { reasoning_effort: 'low' } },
  { id: 'llama-3.3-70b-versatile', extra: {} },
];

const MAX_INPUT_CHARS = 24000;   // about a 4-page resume plus a job description
const MAX_OUTPUT_TOKENS = 2500;
const AI_PER_VISITOR = 15;       // AI requests per visitor in 10 minutes
const REVIEWS_PER_VISITOR = 3;   // reviews per visitor in 1 hour

const SYSTEM_PROMPT =
  'You are the resume-writing assistant inside a resume checker website. ' +
  'Only help with resumes, cover letters and job applications. ' +
  'Follow the instructions in the user message exactly, and never invent facts about the candidate.';

// Best-effort limits per visitor (kept in this Worker's memory, so they reset now and then).
const recent = new Map();
function tooMany(kind, ip, limit, windowMs) {
  const key = kind + ':' + ip, now = Date.now();
  const times = (recent.get(key) || []).filter((t) => now - t < windowMs);
  if (times.length >= limit) return true;
  times.push(now);
  recent.set(key, times);
  if (recent.size > 10000) recent.clear();
  return false;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (status, data) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // ----- owner: read reviews -----
    if (request.method === 'GET' && path === '/reviews') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
        return new Response('Wrong or missing key.', { status: 403, headers: { 'Content-Type': 'text/plain' } });
      }
      if (!env.REVIEWS) return new Response('The REVIEWS KV binding is not set up yet.', { status: 500, headers: { 'Content-Type': 'text/plain' } });
      const keys = [];
      let cursor;
      do {
        const page = await env.REVIEWS.list({ prefix: 'review:', cursor, limit: 1000 });
        keys.push(...page.keys.map((k) => k.name));
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor && keys.length < 3000);
      const newest = keys.sort().reverse().slice(0, 300);
      const items = (await Promise.all(newest.map((k) => env.REVIEWS.get(k, 'json')))).filter(Boolean);
      if (url.searchParams.get('format') === 'json') return new Response(JSON.stringify(items, null, 2), { headers: { 'Content-Type': 'application/json' } });
      const rated = items.filter((r) => r.rating > 0);
      const avg = rated.length ? (rated.reduce((a, r) => a + r.rating, 0) / rated.length).toFixed(1) : '–';
      const rows = items.map((r) => `<tr>
        <td>${esc(new Date(r.time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))}</td>
        <td>${r.rating ? '★'.repeat(r.rating) + '<span style="color:#ccc">' + '★'.repeat(5 - r.rating) + '</span>' : '–'}</td>
        <td><b>${esc(r.type)}</b></td>
        <td style="white-space:pre-wrap">${esc(r.message)}</td>
        <td>${esc(r.name)}${r.email ? '<br><a href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a>' : ''}</td>
        <td style="font-size:12px;color:#555">${r.tech ? esc(Object.entries(r.tech).filter(([, v]) => v !== null && v !== '').map(([k, v]) => k + ': ' + v).join(' · ')) : ''}</td></tr>`).join('');
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Resume SAT reviews</title>
        <style>body{font-family:system-ui,Arial,sans-serif;margin:24px;color:#14202b}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}th{background:#f3f5f7}</style></head>
        <body><h1>Resume SAT reviews</h1><p>${items.length} review${items.length === 1 ? '' : 's'} · average rating ${avg} from ${rated.length} rating${rated.length === 1 ? '' : 's'}. Newest first.</p>
        <table><thead><tr><th>When (IST)</th><th>Rating</th><th>Type</th><th>Review</th><th>From</th><th>Technical details</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No reviews yet.</td></tr>'}</tbody></table></body></html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }

    // ----- status check -----
    if (request.method === 'GET') {
      return reply(200, { ok: true, service: 'Resume SAT server', groq_key_set: !!env.GROQ_API_KEY, reviews_ready: !!env.REVIEWS, admin_key_set: !!env.ADMIN_KEY });
    }

    if (request.method !== 'POST') return reply(405, { error: 'Use POST.' });
    if (!allowed) return reply(403, { error: 'This server only works from the Resume SAT website.' });

    let body;
    try { body = await request.json(); } catch (e) { return reply(400, { error: 'The request was not valid JSON.' }); }

    // ----- visitor: send a review -----
    if (path === '/review') {
      if (!env.REVIEWS) return reply(500, { error: 'Reviews are not set up on the server yet.' });
      if (body.website) return reply(200, { ok: true }); // filled hidden field: a spam bot
      const rating = Math.max(0, Math.min(5, Math.round(Number(body.rating) || 0)));
      const type = ['problem', 'suggestion', 'praise', 'other'].includes(body.type) ? body.type : 'other';
      const message = clip(body.message, 1500).trim();
      if (!rating && message.length < 5) return reply(400, { error: 'Choose a star rating or write a few words.' });
      if (tooMany('review', ip, REVIEWS_PER_VISITOR, 60 * 60 * 1000)) return reply(429, { error: 'You have sent several reviews already. Try again in an hour.' });
      const tech = body.tech && typeof body.tech === 'object'
        ? Object.fromEntries(Object.entries(body.tech).slice(0, 10).map(([k, v]) => [clip(k, 30), v === null ? null : clip(v, 200)]))
        : null;
      const review = {
        time: new Date().toISOString(), rating, type, message,
        name: clip(body.name, 60).trim(), email: clip(body.email, 120).trim(), tech,
        country: (request.cf && request.cf.country) || '',
      };
      const key = 'review:' + review.time + ':' + Math.random().toString(36).slice(2, 8);
      await env.REVIEWS.put(key, JSON.stringify(review));
      return reply(200, { ok: true });
    }

    // ----- visitor: AI -----
    if (path !== '/' && path !== '/ai') return reply(404, { error: 'Not found.' });
    if (!env.GROQ_API_KEY) return reply(500, { error: 'The server has no GROQ_API_KEY secret yet.' });
    if (tooMany('ai', ip, AI_PER_VISITOR, 10 * 60 * 1000)) return reply(429, { error: 'Too many AI requests from you. Try again in a few minutes.' });

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6);
    const size = messages.reduce((n, m) => n + m.content.length, 0);
    if (!messages.length) return reply(400, { error: 'No message was sent.' });
    if (size > MAX_INPUT_CHARS) return reply(413, { error: 'The resume is too long for the AI. Shorten it and try again.' });

    let lastStatus = 0;
    for (const model of MODELS) {
      let res;
      try {
        res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + env.GROQ_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
            temperature: 0.3,
            max_tokens: MAX_OUTPUT_TOKENS,
            ...model.extra,
          }),
        });
      } catch (e) { lastStatus = 502; continue; }
      if (res.ok) {
        const data = await res.json();
        const choice = data.choices && data.choices[0];
        const text = (choice && choice.message && choice.message.content) || '';
        if (text.trim()) return reply(200, { text, truncated: choice.finish_reason === 'length', model: model.id });
        lastStatus = 502;
        continue;
      }
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) break; // wrong key: other models will fail too
    }

    if (lastStatus === 429) return reply(429, { error: 'The free AI limit is used up for now. Try again later.' });
    if (lastStatus === 401 || lastStatus === 403) return reply(500, { error: 'The Groq key on the server is not valid.' });
    return reply(502, { error: 'The AI service did not answer. Try again.' });
  },
};

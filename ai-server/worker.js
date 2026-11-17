// Resume SAT – AI server (Cloudflare Worker)
// The website sends resume text here; this Worker adds the secret Groq key and asks Groq.
// The key lives only in Cloudflare (a secret named GROQ_API_KEY), never in the website code.

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
const PER_VISITOR_LIMIT = 15;    // AI requests per visitor in 10 minutes
const WINDOW_MS = 10 * 60 * 1000;

const SYSTEM_PROMPT =
  'You are the resume-writing assistant inside a resume checker website. ' +
  'Only help with resumes, cover letters and job applications. ' +
  'Follow the instructions in the user message exactly, and never invent facts about the candidate.';

// Best-effort limit per visitor (kept in this Worker's memory, so it resets now and then).
const recent = new Map();

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const reply = (status, data) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return reply(200, { ok: true, service: 'Resume SAT AI server', key_set: !!env.GROQ_API_KEY });
    if (request.method !== 'POST') return reply(405, { error: 'Use POST.' });
    if (!allowed) return reply(403, { error: 'This AI server only works from the Resume SAT website.' });
    if (!env.GROQ_API_KEY) return reply(500, { error: 'The server has no GROQ_API_KEY secret yet.' });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const times = (recent.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (times.length >= PER_VISITOR_LIMIT) {
      return reply(429, { error: 'Too many AI requests from you. Try again in a few minutes.' });
    }
    times.push(now);
    recent.set(ip, times);
    if (recent.size > 5000) recent.clear();

    let body;
    try { body = await request.json(); } catch (e) { return reply(400, { error: 'The request was not valid JSON.' }); }
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

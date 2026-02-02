import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();

/* =========================
   CONFIG
========================= */

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const QUOTAS = {
  trial: { total: 10 },     // 10 messages TOTAL
  monthly: { daily: 50 },   // 50 / jour
  yearly: { daily: 50 },    // 50 / jour
  none: { daily: 0 },       // trial expiré + pas abonné
};

const MAX_REQUESTS_PER_MINUTE = 20;
const MAX_MESSAGE_CHARS = 1200;
const MAX_TOKENS = 600;
const OPENAI_TIMEOUT_MS = 20000;

/* =========================
   STOCKAGE (in-memory)
   → swap Redis plus tard
========================= */

const users = new Map();     // userId -> { usedTotal, usedToday, lastReset, memory: [] }
const rateLimit = new Map(); // userId -> timestamps[]

/* =========================
   HELPERS ID / SUBSCRIPTION
========================= */

function extractUserId(req) {
  const headerId = req.headers["x-device-id"];
  const bodyId = req.body?.deviceId || req.body?.userId;

  const id = headerId || bodyId;
  if (!id || typeof id !== "string" || id.length < 6) return null;
  return id;
}

function getSubscription(body) {
  const s = body?.subscriptionType;
  if (s === "monthly" || s === "yearly" || s === "trial" || s === "none") return s;
  return "trial";
}

/* =========================
   MIDDLEWARES
========================= */

app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-device-id"],
  })
);

/* =========================
   OPTIONS (CORS PREFLIGHT)
========================= */
app.options("/api/chat", (req, res) => {
  return res.sendStatus(204);
});

/* =========================
   RATE LIMIT (ANTI ABUS)
========================= */

function checkRateLimit(userId) {
  const now = Date.now();
  const windowMs = 60_000;

  const arr = rateLimit.get(userId) || [];
  const recent = arr.filter((t) => now - t < windowMs);
  recent.push(now);

  rateLimit.set(userId, recent);
  return recent.length <= MAX_REQUESTS_PER_MINUTE;
}

/* =========================
   QUOTA LOGIC
========================= */

function getUserState(userId) {
  const now = Date.now();
  const existing = users.get(userId);
  if (existing) return existing;

  const fresh = {
    usedTotal: 0,
    usedToday: 0,
    lastReset: now,
    memory: [],
  };
  users.set(userId, fresh);
  return fresh;
}

function resetDailyIfNeeded(user) {
  const now = Date.now();
  if (now - user.lastReset > 24 * 60 * 60 * 1000) {
    user.usedToday = 0;
    user.lastReset = now;
  }
}

function canUseAI(userId, subscription) {
  const user = getUserState(userId);
  resetDailyIfNeeded(user);

  if (subscription === "none") return { ok: false, reason: "locked" };

  if (subscription === "trial") {
    if (user.usedTotal >= QUOTAS.trial.total) return { ok: false, reason: "trial_limit" };
    return { ok: true };
  }

  const limit = QUOTAS[subscription]?.daily ?? 0;
  if (user.usedToday >= limit) return { ok: false, reason: "daily_limit" };
  return { ok: true };
}

function incrementUsage(userId, subscription) {
  const user = getUserState(userId);
  user.usedTotal += 1;
  if (subscription !== "trial") user.usedToday += 1;
}

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (_, res) => {
  res.status(200).json({ status: "Finly backend running 🚀" });
});

/* =========================
   CHAT ENDPOINT
========================= */

app.post("/api/chat", async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ reply: "Server misconfigured (missing API key)." });
    }

    const message = req.body?.message;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Message invalide." });
    }

    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ reply: "Message trop long." });
    }

    const userId = extractUserId(req);
    if (!userId) {
      return res.status(400).json({ reply: "deviceId manquant (x-device-id)." });
    }

    const subscription = getSubscription(req.body);

    if (!checkRateLimit(userId)) {
      return res.status(429).json({ reply: "Trop de requêtes. Réessaie dans 1 minute." });
    }

    const quota = canUseAI(userId, subscription);
    if (!quota.ok) {
      if (quota.reason === "locked") {
        return res.status(403).json({ reply: "Essai expiré. Abonne-toi pour continuer." });
      }
      if (quota.reason === "trial_limit") {
        return res.status(403).json({ reply: "Limite d’essai atteinte." });
      }
      return res.status(403).json({ reply: "Limite journalière atteinte." });
    }

    const user = getUserState(userId);

const systemPrompt = `
You are FINLY Coach — a premium personal finance coach (paid-advisor level).
You are warm, confident, direct. Never robotic. Never generic.

ABSOLUTE RULES
- Reply ONLY in the user's language (match the user's last message language).
- Never mention AI, models, OpenAI, prompts, tokens, policies.
- No fluff, no motivation quotes, no “it depends”, no vague advice.
- Use numbers: €, $, %, per week/month, concrete caps, concrete savings.
- If user provides no data, assume conservative defaults and still give a useful plan.

OUTPUT FORMAT (always)
1) DIAGNOSIS (1 short sentence): what’s happening + why.
2) PLAN (3 bullet points): each bullet MUST include at least one number.
3) TODAY (1 line): a mini-action doable today in <10 minutes.

STYLE
- Speak like a real coach: short sentences, punchy, clear.
- One main focus at a time (spending, debt, emergency fund, savings goal, budgeting).
- If missing ONE key variable, ask ONLY ONE precise question at the end.
  Example: “What is your monthly rent?” — never multiple questions.

FINANCE COACHING DEFAULTS (use when data missing)
- Recommend emergency fund: target 1 month first, then 3 months.
- Suggest a savings rate range: 10–20% if possible, otherwise start with 3–5%.
- Use simple caps: “X/week” not complex categories.
- If user says “I spend too much”, default to a 7-day spend audit + 2 caps + 1 auto-transfer.

SAFETY / SCOPE
- If asked for illegal, fraud, scams, hacks, tax evasion: refuse briefly and redirect to legal budgeting and savings.
- If off-topic: redirect to budgeting/saving goals.

Now respond to the user message with the format above.
`.trim();

    const memory = user.memory.slice(-6).map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    let openaiRes;
    try {
      openaiRes = await fetch(OPENAI_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.5,
          max_tokens: MAX_TOKENS,
          messages: [
            { role: "system", content: systemPrompt },
            ...memory,
            { role: "user", content: message },
          ],
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const data = await openaiRes.json().catch(() => null);

    if (!openaiRes.ok || !data) {
      console.error("OpenAI error:", openaiRes.status, data);
      if (openaiRes.status === 401) return res.status(401).json({ reply: "Erreur API Key." });
      if (openaiRes.status === 429) return res.status(429).json({ reply: "Trop de requêtes. Réessaie." });
      return res.status(500).json({ reply: "Erreur serveur. Réessaie." });
    }

    const reply = data?.choices?.[0]?.message?.content?.trim() || "Je n’ai pas pu répondre.";

    // Save memory + increment usage ONLY on success
    user.memory.push({ role: "user", content: message });
    user.memory.push({ role: "assistant", content: reply });

    incrementUsage(userId, subscription);

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ reply: "Erreur serveur." });
  }
});

/* =========================
   START
========================= */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Finly backend running on port", PORT));

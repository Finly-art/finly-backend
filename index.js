import express from "express";
import cors from "cors";

import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(cors());

/* =========================
   SUPABASE CONFIG
========================= */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* =========================
   CONFIG
========================= */

const TRIAL_LIMIT = 10;
const TRIAL_DAYS = 7;

/* =========================
   HELPERS
========================= */

function extractUserId(req) {
  const headerId = req.headers["x-device-id"];
  const bodyId = req.body?.deviceId || req.body?.userId;

  const id = headerId || bodyId;
  if (!id || typeof id !== "string" || id.length < 6) return null;
  return id;
}

/* =========================
   HEALTH CHECK
========================= */

app.get("/", (req, res) => {
  res.json({ status: "Finly backend running 🚀" });
});

/* =========================
   CHAT ENDPOINT
========================= */

app.post("/api/chat", async (req, res) => {
  try {
    const userId = extractUserId(req);
         console.log("USER ID RECEIVED:", userId);    
     if (!userId) {
      return res.status(400).json({ reply: "deviceId manquant." });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ reply: "Missing API key." });
    }

    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Message invalide." });
    }

   /* =========================
   GET USER USAGE
========================= */

let { data: usage } = supabase
  .from("ai_usage")
  .select("*")
  .eq("user_id", userId)
  .maybeSingle();

if (!usage) {
  const { data: newUser } = await supabase
    .from("ai_usage")
    .insert({
      user_id: userId,
      used_total: 0,
      used_today: 0,
      subscription: "trial",
      last_reset: new Date()
    })
    .select()
    .single();

  usage = newUser;
}  /* =========================
   TRIAL & PREMIUM LOGIC
========================= */

const createdAt = new Date(usage.created_at);
const now = new Date();
const diffTime = now - createdAt;
const diffDays = diffTime / (1000 * 60 * 60 * 24);

// RESET DAILY COUNTER IF NEW DAY
if (!usage.last_reset || new Date(usage.last_reset).toDateString() !== now.toDateString()) {
  await supabase
    .from("ai_usage")
    .update({
      used_today: 0,
      last_reset: now
    })
    .eq("user_id", userId);

  usage.used_today = 0;
}

// ===== TRIAL =====
if (usage.subscription === "trial") {

  if (diffDays > TRIAL_DAYS) {
    return res.status(403).json({
      reply: "Essai gratuit expiré. Passe en premium 🚀",
    });
  }

  if (usage.used_total >= TRIAL_LIMIT) {
    return res.status(403).json({
      reply: "Tu as utilisé tes 10 messages gratuits 🚀",
    });
  }
}

// ===== PREMIUM =====
if (usage.subscription === "premium") {

  if (usage.used_today >= 50) {
    return res.status(403).json({
      reply: "Limite de 50 messages atteinte aujourd'hui 💎",
    });
  }
}
    /* =========================
       OPENAI CALL
    ========================= */

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You are FINLY Coach, a professional finance coach.",
            },
            {
              role: "user",
              content: message,
            },
          ],
          max_tokens: 400,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ reply: "Erreur OpenAI." });
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() || "Pas de réponse.";

    /* =========================
       INCREMENT USAGE
    ========================= */

    await supabase
  .from("ai_usage")
  .update({
    used_total: usage.used_total + 1,
    used_today: usage.used_today + 1,
  })
  .eq("user_id", userId);
    return res.json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ reply: "Erreur serveur." });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Finly backend running on port", PORT);
});

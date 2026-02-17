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
const PREMIUM_DAILY_LIMIT = 50;

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

    let { data: usage } = await supabase
      .from("ai_usage")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (!usage) {
      const { data: newUser, error } = await supabase
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

      if (error) {
        console.error(error);
        return res.status(500).json({ reply: "DB insert error" });
      }

      usage = newUser;
    }

    if (!usage) {
      return res.status(500).json({ reply: "Usage not found." });
    }

    const now = new Date();
    const createdAt = new Date(usage.created_at || now);

    /* =========================
       RESET DAILY COUNTER
    ========================= */

    if (
      !usage.last_reset ||
      new Date(usage.last_reset).toDateString() !== now.toDateString()
    ) {
      await supabase
        .from("ai_usage")
        .update({
          used_today: 0,
          last_reset: now
        })
        .eq("user_id", userId);

      usage.used_today = 0;
    }

    /* =========================
       TRIAL LOGIC
    ========================= */

    const diffDays =
      (now - createdAt) / (1000 * 60 * 60 * 24);

    if (usage.subscription === "trial") {
      if (diffDays > TRIAL_DAYS) {
        return res.status(403).json({
          reply: "Essai gratuit expiré. Passe en premium 🚀"
        });
      }

      if (usage.used_total >= TRIAL_LIMIT) {
        return res.status(403).json({
          reply: "Tu as utilisé tes 10 messages gratuits 🚀"
        });
      }
    }

    /* =========================
       PREMIUM LOGIC
    ========================= */

    if (usage.subscription === "premium") {
      if (usage.used_today >= PREMIUM_DAILY_LIMIT) {
        return res.status(403).json({
          reply: "Limite de 50 messages atteinte aujourd'hui 💎"
        });
      }
    }

    /* =========================
       STREAMING OPENAI
    ========================= */

    const openaiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          stream: true,
          messages: [
            {
              role: "system",
              content:
                "You are FINLY Coach, a professional finance coach."
            },
            {
              role: "user",
              content: message
            }
          ],
          max_tokens: 400
        })
      }
    );

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error(errorText);
      return res.status(500).json({ reply: "Erreur OpenAI." });
    }

    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");

    const reader = openaiResponse.body.getReader();
    const decoder = new TextDecoder();

    let fullReply = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          const json = line.replace("data: ", "");

          try {
            const parsed = JSON.parse(json);
            const content =
              parsed.choices?.[0]?.delta?.content;

            if (content) {
              fullReply += content;
              res.write(content);
            }
          } catch {}
        }
      }
    }

    res.end();

    /* =========================
       INCREMENT USAGE
    ========================= */

    await supabase
      .from("ai_usage")
      .update({
        used_total: usage.used_total + 1,
        used_today: usage.used_today + 1
      })
      .eq("user_id", userId);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ reply: "Erreur serveur." });
  }
});

/* =========================
   START SERVER
========================= */

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Finly backend running on port", PORT);
});

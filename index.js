import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";

const app = express();

/* =========================
   MIDDLEWARE
========================= */

app.use(express.json({ limit: "1mb" }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

app.use(cors());

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

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
   JWT VERIFICATION
========================= */

async function verifyUser(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.split(" ")[1];

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) return null;

  return data.user;
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
    /* =========================
       AUTHENTICATION
    ========================= */

    const user = await verifyUser(req);
    if (!user) {
      return res.status(401).json({ reply: "Non authentifié." });
    }

    const userId = user.id;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ reply: "Missing API key." });
    }

    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Message invalide." });
    }

    /* =========================
       GET OR CREATE USAGE
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
          last_reset: new Date(),
          created_at: new Date()
        })
        .select()
        .single();

      if (error) {
        console.error(error);
        return res.status(500).json({ reply: "DB insert error" });
      }

      usage = newUser;
    }

    const now = new Date();

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
          last_reset: now,
        })
        .eq("user_id", userId);

      usage.used_today = 0;
    }

    /* =========================
       TRIAL LOGIC (SERVER SIDE)
    ========================= */

    const createdAt = new Date(usage.created_at);
    const diffDays =
      (now - createdAt) / (1000 * 60 * 60 * 24);

    const isTrialExpired = diffDays > TRIAL_DAYS;
    const isTrialLimitReached = usage.used_total >= TRIAL_LIMIT;

    if (isTrialExpired || isTrialLimitReached) {
      return res.status(403).json({
        reply: "Essai gratuit terminé. Passe en premium 🚀",
      });
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
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          stream: true,
          messages: [
            {
              role: "system",
              content:
                "You are FINLY Coach, a professional finance coach.",
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

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error(errorText);
      return res.status(500).json({ reply: "Erreur OpenAI." });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const reader = openaiResponse.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          try {
            const json = JSON.parse(line.replace("data: ", ""));
            const content =
              json.choices?.[0]?.delta?.content;

            if (content) {
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
        used_today: usage.used_today + 1,
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

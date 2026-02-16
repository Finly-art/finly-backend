import express from "express";
import cors from "cors";

const app = express();
function extractUserId(req) {
  const headerId = req.headers["x-device-id"];
  const bodyId = req.body?.deviceId || req.body?.userId;

  const id = headerId || bodyId;
  if (!id || typeof id !== "string" || id.length < 6) return null;
  return id;
}
app.use(express.json({ limit: "1mb" }));
app.use(cors());

app.get("/", (req, res) => {
  res.json({ status: "Finly backend running 🚀" });
});

app.post("/api/chat", async (req, res) => {
  try {
    const userId = extractUserId(req);
if (!userId) {
  return res.status(400).json({ reply: "deviceId manquant (x-device-id)." });
}    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ reply: "Missing API key." });
    }

    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ reply: "Invalid message." });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
            content: "You are a finance coach.",
          },
          {
            role: "user",
            content: message,
          },
        ],
        max_tokens: 300,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ reply: "OpenAI error." });
    }

    const reply =
      data?.choices?.[0]?.message?.content?.trim() || "No response.";

    return res.json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ reply: "Server error." });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log("Finly backend running on port", PORT);
});

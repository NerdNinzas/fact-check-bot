import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { OpenAI } from "openai";
import { config as configDotenv } from "dotenv";

const { MessagingResponse } = twilio.twiml;
configDotenv();

console.log("Starting server...");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Sonar API (Perplexity)
const openai = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: "https://api.perplexity.ai"
});

console.log("OpenAI client initialized");

app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();
  let userMessage = req.body.Body?.trim();

  console.log("Received message:", userMessage);

  if (!userMessage) {
    twiml.message("Please send me a message to process!");
  } else {
    try {
      const sonarResponse = await openai.chat.completions.create({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "You are a helpful assistant. Keep answers concise." },
          { role: "user", content: userMessage }
        ]
      });

      const reply = sonarResponse.choices?.[0]?.message?.content || "I couldn't find an answer.";
      twiml.message(reply);
    } catch (err) {
      console.error("Error:", err.message);
      twiml.message("Sorry, I'm having trouble processing your request right now.");
    }
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

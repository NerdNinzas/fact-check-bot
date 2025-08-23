import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { OpenAI } from "openai";
import { configDotenv } from "dotenv";

const { MessagingResponse } = twilio.twiml;

configDotenv();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initialize Perplexity API (OpenAI-compatible)
const openai = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY, // Set in .env or your environment
  baseURL: "https://api.perplexity.ai"
});

app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body?.trim(); // Take any input from user
  const twiml = new MessagingResponse();

  if (!userMessage) {
    twiml.message("Please send me a message to process!");
  } else {
    try {
      // Send user message to Sonar API
      const sonarResponse = await openai.chat.completions.create({
        model: "sonar-pro", // or "sonar" for lighter responses
        messages: [
          { role: "system", content: "You are a helpful assistant. Keep answers concise." },
          { role: "user", content: userMessage }
        ]
      });

      const reply = sonarResponse.choices?.[0]?.message?.content || "I couldn't find an answer.";
      twiml.message(reply);
    } catch (err) {
      console.error("Sonar API Error:", err);
      twiml.message("Sorry, I'm having trouble processing your request right now.");
    }
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

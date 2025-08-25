import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { OpenAI } from "openai";
import { config as configDotenv } from "dotenv";
import { scamMinderTool } from "./scamMinderTool.js";

const { MessagingResponse } = twilio.twiml;
configDotenv();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Sonar API
const openai = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: "https://api.perplexity.ai"
});

// Simple URL detector
function extractURL(message) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const match = message.match(urlRegex);
  return match ? match[0] : null;
}

app.post("/whatsapp", async (req, res) => {
  const userMessage = req.body.Body?.trim();
  const twiml = new MessagingResponse();

  if (!userMessage) {
    twiml.message("Please send me a message to process!");
  } else {
    try {
      let toolData = "";
      const url = extractURL(userMessage);

      // Step 1: If URL detected, check scam status
      if (url) {
        toolData = await scamMinderTool(url);
      }

      // Step 2: Send combined info to Sonar
      const sonarResponse = await openai.chat.completions.create({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "You are an assistant combining real-time scam checks with your knowledge." },
          { role: "user", content: `User Query: ${userMessage}\n\nExternal Scam Data: ${toolData || "No additional data"}` }
        ]
      });

      const reply = sonarResponse.choices?.[0]?.message?.content || "I couldn't find an answer.";
      twiml.message(reply);

    } catch (err) {
      console.error("Error:", err);
      twiml.message("Sorry, I'm having trouble processing your request right now.");
    }
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

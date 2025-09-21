import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { OpenAI } from "openai";
import { config as configDotenv } from "dotenv";
import axios from "axios";
import fs from "fs";
import { createClient } from "@deepgram/sdk";
import { scamMinderTool } from "./scamMinderTool.js";

const { MessagingResponse } = twilio.twiml;
configDotenv();

console.log("Starting fact-check bot...");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Serve static files for audio responses
app.use('/audio', express.static('./', {
  setHeaders: (res, path) => {
    console.log(`📁 Serving audio file: ${path}`);
    console.log(`📁 File exists: ${fs.existsSync(path)}`);
    if (path.endsWith('.mp3')) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Add middleware to log all requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Test endpoint
app.get("/test", (req, res) => {
  res.json({ status: "Server is working!", timestamp: new Date().toISOString() });
});

// Test audio files endpoint
app.get("/test-audio", (req, res) => {
  const files = fs.readdirSync('.').filter(file => file.startsWith('output_') && file.endsWith('.mp3'));
  res.json({ 
    status: "Audio files available", 
    count: files.length,
    files: files.slice(-5) // Show last 5 files
  });
});

app.post("/test-webhook", async (req, res) => {
  console.log("Test webhook called with body:", req.body);
  const twiml = new MessagingResponse();
  twiml.message("Test response from bot!");
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// Sonar API (Perplexity)
const openai = new OpenAI({
  apiKey: process.env.PERPLEXITY_API_KEY,
  baseURL: "https://api.perplexity.ai"
});

console.log("OpenAI client initialized");

// Deepgram client
let deepgram;
try {
  deepgram = createClient(process.env.DEEPGRAM_API_KEY);
  console.log("Deepgram client initialized");
} catch (error) {
  console.error("Failed to initialize Deepgram:", error);
}

// Extract URLs from text
function extractURL(message) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const match = message.match(urlRegex);
  return match ? match[0] : null;
}

// Download media file from Twilio
async function downloadMedia(mediaUrl) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials not configured. Please add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to your .env file");
  }
  
  try {
    const response = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      }
    });
    return Buffer.from(response.data);
  } catch (error) {
    console.error("Failed to download media:", error.response?.status, error.response?.statusText);
    throw new Error("Failed to download media file from Twilio");
  }
}

// Transcribe audio with Deepgram
async function transcribeAudio(buffer, contentType = "audio/ogg") {
  if (!deepgram) {
    console.error("Deepgram client not initialized");
    return "";
  }
  
  try {
    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      buffer,
      {
        model: "nova-2",
        language: "en",
        smart_format: true,
      }
    );

    if (error) {
      console.error("Deepgram transcription error:", error);
      return "";
    }

    return result.results.channels[0].alternatives[0].transcript || "";
  } catch (err) {
    console.error("Transcription error:", err);
    return "";
  }
}

// Clean text for TTS by removing markdown and references
function cleanTextForTTS(text) {
  return text
    // Remove markdown bold/italic formatting
    .replace(/\*\*(.*?)\*\*/g, '$1')  // Remove **bold**
    .replace(/\*(.*?)\*/g, '$1')      // Remove *italic*
    .replace(/__(.*?)__/g, '$1')      // Remove __bold__
    .replace(/_(.*?)_/g, '$1')        // Remove _italic_
    // Remove reference brackets like [1], [2], [1][3], etc.
    .replace(/\[\d+\](\[\d+\])*/g, '')
    // Remove extra whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// Generate TTS from summary
async function generateTTS(text) {
  if (!deepgram) {
    console.error("Deepgram client not initialized");
    return null;
  }
  
  try {
    const { result, error } = await deepgram.speak.request(
      { text },
      {
        model: "aura-asteria-en",
        encoding: "mp3",
      }
    );

    if (error) {
      console.error("Deepgram TTS error:", error);
      return null;
    }

    console.log("TTS result type:", typeof result);
    console.log("TTS result constructor:", result?.constructor?.name);
    console.log("TTS result keys:", Object.keys(result || {}));

    // Save audio to temp file
    const filename = `output_${Date.now()}.mp3`;
    
    try {
      // Handle different response types from Deepgram SDK
      let buffer;
      
      if (result && result.arrayBuffer) {
        // If result has arrayBuffer method (Response object)
        const arrayBuffer = await result.arrayBuffer();
        buffer = Buffer.from(arrayBuffer);
      } else if (result && result.stream) {
        // If result has a stream
        const chunks = [];
        for await (const chunk of result.stream) {
          chunks.push(chunk);
        }
        buffer = Buffer.concat(chunks);
      } else if (Buffer.isBuffer(result)) {
        // If result is already a buffer
        buffer = result;
      } else {
        console.log("Unknown TTS response format:", typeof result);
        return null;
      }
      
      fs.writeFileSync(filename, buffer);
      console.log(`TTS audio saved as: ${filename}`);
      return filename;
    } catch (saveError) {
      console.error("Error saving TTS file:", saveError);
      return null;
    }
  } catch (err) {
    console.error("TTS generation error:", err);
    return null;
  }
}

app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();
  let userMessage = req.body.Body?.trim();
  const mediaType = req.body.MediaContentType0;
  const mediaUrl = req.body.MediaUrl0;

  console.log("=== WEBHOOK CALLED ===");
  console.log("Request body:", req.body);
  console.log("Received message:", userMessage, "Media type:", mediaType);

  try {
    // 🎤 Step 1: Handle audio input
    if (mediaType && mediaType.startsWith("audio")) {
      console.log("Processing audio message...");
      
      // Check if Twilio credentials are configured
      if (!process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN === 'your_twilio_auth_token_here') {
        twiml.message("Audio processing is not configured yet. Please send a text message instead. To enable audio, configure your Twilio Auth Token in the .env file.");
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(twiml.toString());
        return;
      }
      
      try {
        const audioBuffer = await downloadMedia(mediaUrl);
        userMessage = await transcribeAudio(audioBuffer, mediaType);
        
        if (!userMessage) {
          twiml.message("Sorry, I couldn't transcribe the audio. Please try again or send a text message.");
          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end(twiml.toString());
          return;
        }
        console.log("Transcribed text:", userMessage);
      } catch (error) {
        console.error("Audio processing error:", error.message);
        twiml.message("Sorry, I had trouble processing the audio. Please try sending a text message instead.");
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(twiml.toString());
        return;
      }
    }

    if (!userMessage) {
      twiml.message("Please send me a message or audio to process!");
    } else {
      // Step 2: Check scam info
      let toolData = "";
      const url = extractURL(userMessage);
      if (url) {
        console.log("Found URL, checking with ScamMinder:", url);
        toolData = await scamMinderTool(url);
      }

      // Step 3: Query Sonar
      console.log("Querying Perplexity AI...");
      const sonarResponse = await openai.chat.completions.create({
        model: "sonar-pro",
        messages: [
          { role: "system", content: "You are an assistant detecting misinformation and scams. Provide a short answere of 3 or 4 lines and at last give that its verified or unverified" },
          { role: "user", content: `User Query: ${userMessage}\n\nExternal Scam Data: ${toolData || "No additional data"}` }
        ]
      });

      const reply = sonarResponse.choices?.[0]?.message?.content || "I couldn't find an answer.";

      // Step 4: Determine if this was audio input to format response accordingly
      const isAudioInput = mediaType && mediaType.startsWith("audio");
      let finalResponse;
      
      if (isAudioInput) {
        // For audio input, include both transcribed text and AI response
        finalResponse = `📝 *Your message:* "${userMessage}"\n\n🤖 *Fact-check result:*\n${reply}`;
      } else {
        // For text input, just send the AI response
        finalResponse = reply;
      }

      // Step 5: Create short audio summary (first 2 sentences of AI response)
      const shortSummary = reply.split(". ").slice(0, 2).join(". ") + (reply.split(". ").length > 2 ? "." : "");
      // Clean the text for TTS (remove markdown and references)
      const cleanSummary = cleanTextForTTS(shortSummary);
      console.log("Original text:", shortSummary);
      console.log("Cleaned for TTS:", cleanSummary);
      
      // Generate TTS audio
      console.log("🔊 Generating TTS audio...");
      const audioFile = await generateTTS(cleanSummary);

      // Step 6: Send text response with audio if available
      if (audioFile) {
        console.log(`Audio file generated: ${audioFile}`);
        
        // Add a small delay to ensure file is fully written
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Create a public URL for the audio file
        const baseUrl = process.env.PUBLIC_URL || 'https://1d07889b18ed.ngrok-free.app';
        const audioUrl = `${baseUrl}/audio/${audioFile}`;
        
        // Verify file exists before sending
        if (fs.existsSync(audioFile)) {
          // Send text message with audio attachment
          const textMsg = twiml.message(finalResponse);
          textMsg.media(audioUrl); // Attach audio to the text message
          console.log(`✅ Audio sent to WhatsApp: ${audioUrl}`);
          console.log(`📝 Text sent: ${isAudioInput ? 'Transcribed text + AI response' : 'AI response only'}`);
        } else {
          console.log(`❌ Audio file not found: ${audioFile}`);
          twiml.message(finalResponse);
        }
      } else {
        console.log("🔇 No audio generated, sending text only");
        // Send text only if no audio
        twiml.message(finalResponse);
      }
    }
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
    twiml.message("Sorry, I'm having trouble processing your request right now.");
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

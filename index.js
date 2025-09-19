import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { OpenAI } from "openai";
import { config as configDotenv } from "dotenv";
import axios from "axios";
import fs from "fs";
import { createClient } from "@deepgram/sdk";
import { scamMinderTool } from "./scamMinderTool.js";
import vision from "@google-cloud/vision";
import MarkdownIt from "markdown-it";

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

// Google Cloud Vision client
let visionClient;
try {
  visionClient = new vision.ImageAnnotatorClient({
    keyFilename: './credentials.json'
  });
  console.log("Google Cloud Vision client initialized with credentials.json");
} catch (error) {
  console.error("Failed to initialize Google Cloud Vision:", error.message);
  console.warn("Image analysis will be disabled. Ensure credentials.json exists in the project root.");
}

// Markdown renderer for better formatting
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true
});

// ElevenLabs TTS config (supports legacy ELEVEN_API_KEY)
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "mfMM3ijQgz8QtMeKifko";
const TTS_PROVIDER = process.env.TTS_PROVIDER || (ELEVENLABS_API_KEY ? "elevenlabs" : "deepgram");

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

// Generate TTS using ElevenLabs
async function generateTTSWithElevenLabs(text) {
  if (!ELEVENLABS_API_KEY) {
    console.error("ElevenLabs API key not configured");
    return null;
  }

  try {
    const resp = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8
        }
      },
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          Accept: "audio/mpeg",
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer"
      }
    );

    const filename = `output_${Date.now()}.mp3`;
    fs.writeFileSync(filename, Buffer.from(resp.data));
    console.log(`TTS (ElevenLabs) audio saved as: ${filename}`);
    return filename;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data?.toString?.() || err.message;
    console.error(`ElevenLabs TTS error (${status || 'no-status'}):`, data);
    return null;
  }
}

// Analyze image with Google Cloud Vision
async function analyzeImage(buffer) {
  if (!visionClient) {
    console.error("Google Cloud Vision client not initialized");
    return "Image analysis not available. Please configure Google Cloud Vision.";
  }

  try {
    // Perform text detection, object detection, and general analysis
    const [textResult] = await visionClient.textDetection({ image: { content: buffer } });
    const [labelResult] = await visionClient.labelDetection({ image: { content: buffer } });
    const [objectResult] = await visionClient.objectLocalization({ image: { content: buffer } });
    
    let analysis = "**Image Analysis:**\n\n";
    
    // Extract text if found
    const textAnnotations = textResult.textAnnotations;
    if (textAnnotations && textAnnotations.length > 0) {
      const detectedText = textAnnotations[0].description;
      analysis += `**Text detected:** ${detectedText}\n\n`;
    }
    
    // Extract labels/objects
    const labels = labelResult.labelAnnotations;
    if (labels && labels.length > 0) {
      analysis += `**Objects/Content detected:**\n`;
      labels.slice(0, 5).forEach(label => {
        analysis += `• ${label.description} (${Math.round(label.score * 100)}% confidence)\n`;
      });
      analysis += "\n";
    }
    
    // Extract specific objects
    const objects = objectResult.localizedObjectAnnotations;
    if (objects && objects.length > 0) {
      analysis += `**Specific objects found:**\n`;
      objects.slice(0, 3).forEach(object => {
        analysis += `• ${object.name} (${Math.round(object.score * 100)}% confidence)\n`;
      });
    }
    
    return analysis || "No significant content detected in the image.";
  } catch (error) {
    console.error("Google Cloud Vision error:", error);
    return "Error analyzing image. Please try again.";
  }
}

// Format response text with better markdown
function formatResponse(text) {
  // Convert markdown to WhatsApp-friendly formatting
  return text
    .replace(/\*\*(.*?)\*\*/g, '*$1*')  // Bold: ** to *
    .replace(/\*(.*?)\*/g, '_$1_')      // Italic: * to _
    .replace(/^#{1,3}\s+(.*)/gm, '*$1*')  // Headers to bold
    .replace(/^•\s+/gm, '• ')          // Keep bullet points
    .replace(/\n{3,}/g, '\n\n');        // Limit excessive line breaks
}

app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();
  let userMessage = req.body.Body?.trim();
  const mediaType = req.body.MediaContentType0;
  const mediaUrl = req.body.MediaUrl0;
  let inputType = "text"; // Track input type for conditional voice response

  console.log("=== WEBHOOK CALLED ===");
  console.log("Request body:", req.body);
  console.log("Received message:", userMessage, "Media type:", mediaType);

  try {
    // 🎤 Step 1: Handle audio input
    if (mediaType && mediaType.startsWith("audio")) {
      console.log("Processing audio message...");
      inputType = "audio";

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

    // 🖼️ Step 1b: Handle image input
    if (mediaType && mediaType.startsWith("image")) {
      console.log("Processing image message...");
      inputType = "image";

      try {
        const imageBuffer = await downloadMedia(mediaUrl);
        const imageAnalysis = await analyzeImage(imageBuffer);
        
        // Combine user text with image analysis
        userMessage = userMessage 
          ? `${userMessage}\n\n${imageAnalysis}`
          : imageAnalysis;
        
        console.log("Image analysis completed");
      } catch (error) {
        console.error("Image processing error:", error.message);
        twiml.message("Sorry, I had trouble analyzing the image. Please try again or send a text message.");
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(twiml.toString());
        return;
      }
    }

    if (!userMessage) {
      twiml.message("Please send me a message, audio, or image to process!");
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
          { role: "system", content: "You are an assistant detecting misinformation and scams. Provide detailed analysis with clear formatting using markdown. Include reasoning and evidence." },
          { role: "user", content: `User Query: ${userMessage}\n\nExternal Scam Data: ${toolData || "No additional data"}` }
        ]
      });

      const reply = sonarResponse.choices?.[0]?.message?.content || "I couldn't find an answer.";
      
      // Format the response for better readability
      const formattedReply = formatResponse(reply);

      // Step 4: Generate voice response only for audio input
      let audioFile = null;
      if (inputType === "audio") {
        // Create short audio summary for voice input (first 2 sentences)
        const shortSummary = reply.split(". ").slice(0, 2).join(". ");
        console.log(`Generating TTS via ${TTS_PROVIDER} for voice input:`, shortSummary);

        try {
          if (TTS_PROVIDER === "elevenlabs" && ELEVENLABS_API_KEY) {
            audioFile = await generateTTSWithElevenLabs(shortSummary);
            if (!audioFile && deepgram) {
              console.warn("ElevenLabs TTS failed, falling back to Deepgram...");
              audioFile = await generateTTS(shortSummary);
            }
          } else if (deepgram) {
            audioFile = await generateTTS(shortSummary);
          } else {
            console.warn("No TTS provider available (missing keys/clients)");
          }
        } catch (ttsErr) {
          console.error("TTS generation failed:", ttsErr);
          if (TTS_PROVIDER === "elevenlabs" && deepgram) {
            try {
              console.warn("Attempting Deepgram fallback after ElevenLabs error...");
              audioFile = await generateTTS(shortSummary);
            } catch (fallbackErr) {
              console.error("Deepgram fallback also failed:", fallbackErr);
              audioFile = null;
            }
          } else {
            audioFile = null;
          }
        }
      } else {
        console.log(`Text/Image input detected - sending text-only response (no audio)`);
      }

      // Step 5: Send response based on input type
      if (audioFile && inputType === "audio") {
        console.log(`Audio file generated for voice input: ${audioFile}`);

        // Add a small delay to ensure file is fully written
        await new Promise(resolve => setTimeout(resolve, 500));

        // Create a public URL for the audio file
        const baseUrl = process.env.NGROK_URL || "";
        const audioUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/audio/${audioFile}` : `http://localhost:${process.env.PORT || 3000}/audio/${audioFile}`;

        // Verify file exists before sending
        if (fs.existsSync(audioFile)) {
          // Send text message with audio attachment for voice input
          const textMsg = twiml.message(formattedReply);
          textMsg.media(audioUrl);
          console.log(`✅ Voice + Text response sent to WhatsApp (${TTS_PROVIDER}): ${audioUrl}`);
          if (!process.env.NGROK_URL) {
            console.warn("NGROK_URL not set; WhatsApp will not be able to fetch local URL. Set NGROK_URL in .env.");
          }
        } else {
          console.log(`❌ Audio file not found: ${audioFile}, sending text only`);
          twiml.message(formattedReply);
        }
      } else {
        // Send text-only response for text/image input
        twiml.message(formattedReply);
        console.log(`✅ Text-only response sent (input type: ${inputType})`);
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

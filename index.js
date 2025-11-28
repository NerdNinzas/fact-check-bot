import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { OpenAI } from "openai";
import { config as configDotenv } from "dotenv";
import axios from "axios";
import fs from "fs";
import { createClient } from "@deepgram/sdk";
import { createWorker } from "tesseract.js";
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

// Health check endpoint for Render free tier
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "healthy", 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    version: "2.0.0"
  });
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
  twiml.message("Test response from bot! ✅");
  
  const twimlString = twiml.toString();
  console.log("Test TwiML:", twimlString);
  
  res.writeHead(200, { 
    "Content-Type": "text/xml",
    "Cache-Control": "no-cache"
  });
  res.end(twimlString);
});

// Add a simple test endpoint to check if messages work
app.post("/test-simple", async (req, res) => {
  const twiml = new MessagingResponse();
  twiml.message("Simple test message works!");
  
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

// Call your fact-check API to get transcript
async function getTranscriptFromAPI(url) {
  try {
    console.log("🔄 Calling fact-check API for URL:", url);
    
    const response = await axios.post('https://fact-check-service-api.onrender.com/api/fact-check', {
      url: url
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });

    console.log("📡 API Response Status:", response.status);
    console.log("📡 API Response Data:", JSON.stringify(response.data, null, 2));

    if (response.data && response.data.success && response.data.data && response.data.data.transcript) {
      console.log("✅ API Response - Transcript:", response.data.data.transcript);
      return response.data.data.transcript;
    } else {
      console.log("❌ API returned no transcript or unsuccessful response:", response.data);
      return null;
    }
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error("⏰ API call timeout");
    } else {
      console.error("❌ Error calling fact-check API:", error.response?.status, error.response?.data || error.message);
    }
    return null;
  }
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

// Extract text from image using Tesseract OCR
async function extractTextFromImage(buffer, contentType = "image/jpeg") {
  console.log("Starting OCR text extraction...");
  
  let worker;
  try {
    worker = await createWorker("eng");
    
    const { data: { text } } = await worker.recognize(buffer);
    
    console.log("OCR extracted text:", text);
    
    await worker.terminate();
    
    return text.trim();
  } catch (err) {
    console.error("OCR extraction error:", err);
    if (worker) {
      await worker.terminate();
    }
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

// Sanitize text for WhatsApp/XML to avoid breaking TwiML
function sanitizeForXML(text) {
  return text
    // Clean up markdown formatting first
    .replace(/\*\*(.*?)\*\*/g, '$1')  // Remove **bold**
    .replace(/\*(.*?)\*/g, '$1')      // Remove *italic*
    .replace(/- \*\*(.*?)\*\*/g, '• $1') // Convert bullet points
    .replace(/\[([\d,\[\]]+)\]/g, '')  // Remove reference numbers like [1][2][4][7]
    .replace(/\n\s*\n\s*\n/g, '\n\n') // Clean up excessive newlines
    // Only escape the absolutely necessary XML characters for TwiML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Remove control characters but keep normal quotes and apostrophes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trim();
}

// Determine verification status from AI response
function getVerificationStatus(aiResponse) {
  const lowerResponse = aiResponse.toLowerCase();
  
  // Check for positive verification indicators
  if (lowerResponse.includes('verified') || 
      lowerResponse.includes('true') || 
      lowerResponse.includes('accurate') || 
      lowerResponse.includes('correct') ||
      lowerResponse.includes('factual') ||
      lowerResponse.includes('legitimate')) {
    return '✅ VERIFIED TRUE';
  }
  
  // Check for negative verification indicators
  if (lowerResponse.includes('unverified') || 
      lowerResponse.includes('false') || 
      lowerResponse.includes('fake') || 
      lowerResponse.includes('misinformation') ||
      lowerResponse.includes('scam') ||
      lowerResponse.includes('misleading') ||
      lowerResponse.includes('inaccurate')) {
    return '❌ VERIFIED FAKE';
  }
  
  // Default to unclear if we can't determine
  return '⚠️ VERIFICATION UNCLEAR';
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
  let finalResponse = "Error generating response"; // Initialize with default value

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

    // 📷 Step 1.5: Handle image input (OCR)
    if (mediaType && mediaType.startsWith("image")) {
      console.log("Processing image message...");
      
      // Check if Twilio credentials are configured
      if (!process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN === 'your_twilio_auth_token_here') {
        twiml.message("Image processing is not configured yet. Please send a text message instead. To enable image processing, configure your Twilio Auth Token in the .env file.");
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(twiml.toString());
        return;
      }
      
      try {
        const imageBuffer = await downloadMedia(mediaUrl);
        userMessage = await extractTextFromImage(imageBuffer, mediaType);
        
        if (!userMessage) {
          twiml.message("Sorry, I couldn't extract any text from the image. Please try again with a clearer image or send a text message.");
          res.writeHead(200, { "Content-Type": "text/xml" });
          res.end(twiml.toString());
          return;
        }
        console.log("Extracted text from image:", userMessage);
      } catch (error) {
        console.error("Image processing error:", error.message);
        twiml.message("Sorry, I had trouble processing the image. Please try sending a text message instead.");
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(twiml.toString());
        return;
      }
    }

    if (!userMessage) {
      twiml.message("Please send me a message or audio to process!");
    } else {
      // Step 2: Handle URL input - get transcript from your API
      let transcriptFromAPI = "";
      const url = extractURL(userMessage);
      if (url) {
        console.log("Found URL, fetching transcript from fact-check API:", url);
        try {
          transcriptFromAPI = await getTranscriptFromAPI(url);
          
          if (transcriptFromAPI) {
            // Replace the user message with the transcript from API
            userMessage = transcriptFromAPI;
            console.log("✅ Using transcript as user message:", userMessage);
          } else {
            console.log("❌ No transcript received from API");
            // Send an error message to user about API issue
            twiml.message("Sorry, I couldn't process the content from that URL. Please try sending the text directly or try again later.");
            res.writeHead(200, { "Content-Type": "text/xml" });
            res.end(twiml.toString());
            return;
          }
        } catch (apiError) {
          console.error("❌ Error calling fact-check API:", apiError.message);
          // Continue with original URL message if API fails
        }
      } else {
        console.log("📝 No URL found in message, processing as regular text");
      }

      // Step 3: Query Sonar
      console.log("🔄 Querying Perplexity AI...");
      console.log("📝 Message being sent to Perplexity:", userMessage.substring(0, 200) + "...");
      
      const sonarResponse = await openai.chat.completions.create({
        model: "sonar-pro",
        messages: [
          { 
            role: "system", 
            content: `You are an expert fact-checker detecting misinformation and scams. Your responses must:

1. ALWAYS respond in ENGLISH only, regardless of input language (Hindi, Spanish, etc.)
2. Start with a clear status indicator using these exact formats:
   - ✅ VERIFIED: For true, factual, completely accurate information
   - ❌ UNVERIFIED/FAKE: For false, misleading, fabricated, or completely inaccurate information  
   - ⚠️ PARTIALLY TRUE: For mixed accuracy, partially correct, or information that needs context

3. For content from URLs (Instagram, YouTube, websites):
   - Provide a detailed summary of what the content claims
   - Fact-check those specific claims with evidence and context
   - Include key details, background information, and supporting/contradicting evidence
   - Explain why claims are true, false, or partially accurate

4. Language handling:
   - If input is in Hindi, Urdu, Spanish, or any non-English language, translate and respond in English
   - Example: If input says "यह सच है?" respond with "VERIFIED" or "UNVERIFIED/FAKE" in English

5. Character limit: Keep your ENTIRE response under 1400 characters maximum but provide comprehensive analysis
6. Use simple language without technical jargon or reference numbers like [1][2]
7. Be definitive in your assessment when evidence is clear

Format examples:
✅ VERIFIED
This information is factually accurate and supported by reliable sources. [Include specific evidence, dates, sources that confirm the claims]

❌ UNVERIFIED/FAKE  
This claim is false and has been debunked by fact-checking organizations. [Explain what evidence contradicts it, cite specific sources]

⚠️ PARTIALLY TRUE
This statement contains some accurate elements but also includes misleading information. [Detail what parts are accurate vs inaccurate with evidence]

CRITICAL: Always respond in English, provide detailed analysis with evidence, and stay under 1400 characters total.` 
          },
          { role: "user", content: `Please fact-check this content. If it's from Instagram, YouTube, or website, provide a summary and fact-check. If the content is in Hindi or another language, respond in English. Content to analyze: ${userMessage}` }
        ]
      });

      const reply = sonarResponse.choices?.[0]?.message?.content || "I couldn't find an answer.";
      console.log("✅ Perplexity AI Response:", reply.substring(0, 300) + "...");
      console.log("📊 Response length:", reply.length);

      // Step 4: Determine input type to format response accordingly
      const isAudioInput = mediaType && mediaType.startsWith("audio");
      const isImageInput = mediaType && mediaType.startsWith("image");
      
      if (isAudioInput) {
        // For audio input, include both transcribed text and AI response
        finalResponse = `📝 *Your message:* "${sanitizeForXML(userMessage)}"\n\n${reply}`;
      } else if (isImageInput) {
        // For image input, only show verification status and fact-check result (no extracted text)
        const verificationStatus = getVerificationStatus(reply);
        finalResponse = `${verificationStatus}\n\n\n${reply}`;
      } else {
        // For text input (including URLs), send the full AI response
        finalResponse = reply;
      }

      // Step 5: Generate TTS audio only for audio inputs
      if (isAudioInput) {
        // Create short audio summary (first 2 sentences of AI response)
        const shortSummary = reply.split(". ").slice(0, 2).join(". ") + (reply.split(". ").length > 2 ? "." : "");
        // Clean the text for TTS (remove markdown and references)
        const cleanSummary = cleanTextForTTS(shortSummary);
        console.log("Original text:", shortSummary);
        console.log("Cleaned for TTS:", cleanSummary);
        
        // Generate TTS audio
        console.log("🔊 Generating TTS audio for audio input...");
        const audioFile = await generateTTS(cleanSummary);

        // Step 6: Send audio input response with TTS
        if (audioFile) {
          console.log(`Audio file generated: ${audioFile}`);
          
          // Add a small delay to ensure file is fully written
          await new Promise(resolve => setTimeout(resolve, 500));
          
          // Create a public URL for the audio file
          const baseUrl = process.env.PUBLIC_URL || 'https://fact-check-bot-1.onrender.com';
          const audioUrl = `${baseUrl}/audio/${audioFile}`;
          
          // Verify file exists before sending
          if (fs.existsSync(audioFile)) {
            // Send text message with audio attachment (sanitize for XML)
            const sanitizedResponse = sanitizeForXML(finalResponse);
            const textMsg = twiml.message(sanitizedResponse);
            textMsg.media(audioUrl); // Attach audio to the text message
            console.log(`✅ Audio sent to WhatsApp: ${audioUrl}`);
            console.log(`📝 Text sent: Transcribed text + AI response with audio`);
          } else {
            console.log(`❌ Audio file not found: ${audioFile}`);
            twiml.message(sanitizeForXML(finalResponse));
          }
        } else {
          console.log("🔇 No audio generated, sending text only");
          twiml.message(sanitizeForXML(finalResponse));
        }
      } else {
        // Step 6: For text and image inputs, send only text response
        console.log(`📝 Sending text-only response for ${isImageInput ? 'image' : 'text'} input`);
        console.log("📤 Final response being sent:", finalResponse.substring(0, 200) + "...");
        console.log("📤 Response length:", finalResponse.length);
        
        // Sanitize the response for XML/WhatsApp
        finalResponse = sanitizeForXML(finalResponse);
        
        // Check if message is too long for WhatsApp (1500 character limit for safety)
        if (finalResponse.length > 1500) {
          console.log("⚠️  Message too long, creating optimized version...");
          
          // Extract verification status and preserve more content
          const lines = finalResponse.split('\n').filter(line => line.trim()); // Remove empty lines
          const verificationLine = lines[0]; // Should be ✅ VERIFIED, ❌ UNVERIFIED/FAKE, etc.
          
          // Get more detailed content from the response, keeping it under 1200 chars
          let content = "";
          for (let i = 1; i < lines.length && content.length < 1200; i++) {
            if (lines[i]) {
              // Include all content except very long bullet points
              if (lines[i].length < 150) {
                content += lines[i] + "\n";
              } else {
                // For long lines, take first part
                content += lines[i].substring(0, 120) + "...\n";
              }
            }
          }
          
          finalResponse = `${verificationLine}\n\n${content.trim()}\n\n📋 Full analysis available on request`;
          
          // Final safety check - ensure we're under 1500 characters
          if (finalResponse.length > 1500) {
            finalResponse = finalResponse.substring(0, 1450) + "...\n\n📋 Truncated";
          }
          
          console.log("📤 Optimized response length:", finalResponse.length);
        }
        
        const message = twiml.message(finalResponse);
        console.log("📤 TwiML message created successfully");
      }
    }
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    console.error("❌ Error stack:", err.stack);
    twiml.message("Sorry, I'm having trouble processing your request right now.");
  }

  const twimlString = twiml.toString();
  console.log("📤 Final TwiML response:", twimlString);
  console.log("📤 TwiML response length:", twimlString.length);

  // Fallback: if the incoming message contained a URL and TwiML replies are not delivered,
  // attempt to send the message directly using the Twilio REST API. This often succeeds when
  // there are delivery issues with the webhook response path.
  try {
    const incomingUrl = extractURL(req.body.Body || "");
    if (incomingUrl && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      console.log("🔁 Detected URL input - attempting REST fallback send via Twilio API...");
      try {
        const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        // Use the same from/to values provided by Twilio in the webhook
        const fromNumber = req.body.To;
        const toNumber = req.body.From;
        // Send the finalResponse (which should contain the full Perplexity response)
        let restBody = finalResponse;
        
        console.log("📤 REST API body length:", restBody.length, "characters");
        if (restBody.length > 1500) {
          console.log("⚠️  REST body still too long, truncating...");
          restBody = restBody.substring(0, 1450) + "...\n\n📋 Message truncated";
        }

        const sendResult = await twilioClient.messages.create({
          from: fromNumber,
          to: toNumber,
          body: restBody,
        });

        console.log("✅ REST fallback send result:", sendResult.sid);
        // If REST fallback succeeded, avoid returning the large TwiML back to Twilio to prevent duplicate
        // (Twilio already delivered the message via REST). We'll return an empty TwiML response.
        if (sendResult && sendResult.sid) {
          console.log("ℹ️ REST fallback appears successful, returning empty TwiML to avoid duplicate delivery");
          res.writeHead(200, {
            "Content-Type": "text/xml; charset=utf-8",
            "Cache-Control": "no-cache"
          });
          res.end('<Response></Response>');
          return;
        }
      } catch (restErr) {
        console.error("❌ REST fallback send failed:", restErr.message || restErr);
      }
    } else {
      console.log("ℹ️ No URL detected or Twilio credentials missing - skipping REST fallback send");
    }
  } catch (errFallback) {
    console.error("❌ Error during REST fallback attempt:", errFallback.message || errFallback);
  }

  // Send the TwiML response back to Twilio as usual
  res.writeHead(200, {
    "Content-Type": "text/xml; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  res.end(twimlString);
});

const PORT = process.env.PORT || 3000;

// Keep-alive mechanism for Render free tier
function keepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  
  setInterval(async () => {
    try {
      const response = await axios.get(`${url}/health`);
      console.log(`⚡ Keep-alive ping successful: ${response.status} at ${new Date().toISOString()}`);
    } catch (error) {
      console.log(`❌ Keep-alive ping failed: ${error.message}`);
    }
  }, 7 * 60 * 1000); // Ping every 7 minutes
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  
  // Start keep-alive only in production (not localhost)
  if (process.env.NODE_ENV === 'production' || process.env.RENDER_EXTERNAL_URL) {
    console.log("🔄 Starting keep-alive mechanism for Render free tier...");
    setTimeout(keepAlive, 60000); // Start after 1 minute
  }
});

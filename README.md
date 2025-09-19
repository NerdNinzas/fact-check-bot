# Enhanced WhatsApp Fact-Check Bot with Multimodal Support

## Features

- **Text Analysis**: Fact-checking and scam detection using Perplexity AI
- **Voice Processing**: Audio transcription and voice responses using Deepgram/ElevenLabs
- **Image Analysis**: Google Cloud Vision for text detection, object recognition, and content analysis
- **Smart Response Logic**:
  - Text input → Text-only response
  - Voice input → Voice + Text response
  - Image input → Text analysis of image content

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Google Cloud Vision Setup

#### Option A: Service Account (Recommended)
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable the Vision API:
   - Navigate to "APIs & Services" > "Library"
   - Search for "Cloud Vision API" and enable it
4. Create a service account:
   - Go to "IAM & Admin" > "Service Accounts"
   - Click "Create Service Account"
   - Name it "vision-bot" and add description
   - Grant "Cloud Vision API User" role
5. Generate a key:
   - Click on the service account
   - Go to "Keys" tab > "Add Key" > "Create new key"
   - Choose JSON format and download
6. Set environment variable:
   ```bash
   # Windows PowerShell
   $env:GOOGLE_APPLICATION_CREDENTIALS="path\\to\\your\\service-account-key.json"
   
   # Or add to .env file
   GOOGLE_APPLICATION_CREDENTIALS=path/to/your/service-account-key.json
   ```

#### Option B: Application Default Credentials
```bash
# Install Google Cloud CLI
# Then authenticate:
gcloud auth application-default login
```

### 3. Environment Configuration

Update your `.env` file:

```env
# Existing keys...
PERPLEXITY_API_KEY=your_perplexity_key
DEEPGRAM_API_KEY=your_deepgram_key
ELEVENLABS_API_KEY=your_elevenlabs_key
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token

# New Google Cloud Vision (if using service account)
GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account-key.json

# Public URL for audio responses
NGROK_URL=https://your-subdomain.ngrok-free.app

# Optional: Force TTS provider and voice
TTS_PROVIDER=elevenlabs
ELEVENLABS_VOICE_ID=mfMM3ijQgz8QtMeKifko
```

### 4. Start the Server
```bash
node index.js
```

### 5. Test Endpoints
```bash
# Basic health check
curl http://localhost:3000/test

# Check audio files
curl http://localhost:3000/test-audio
```

## Usage Examples

### WhatsApp Interactions

1. **Text Query**: "Is this true: Drinking lemon water cures cancer?"
   - Response: Text-only fact-check analysis

2. **Voice Message**: Record audio saying "Tell me about this website: example.com"
   - Response: Text analysis + Voice summary

3. **Image with Text**: Send photo of news article
   - Response: Text extraction + Content analysis + Fact-checking

4. **Image with Caption**: Send photo with text "Is this real?"
   - Response: Combined image analysis and text query processing

## Response Logic

| Input Type | Response Type | Audio TTS |
|------------|---------------|-----------|
| Text message | Text only | No |
| Voice message | Text + Audio | Yes |
| Image + text | Text only | No |
| Image only | Text only | No |

## Troubleshooting

### Google Cloud Vision Issues
```bash
# Check credentials
echo $GOOGLE_APPLICATION_CREDENTIALS

# Test API access
gcloud auth application-default print-access-token
```

### Audio Issues
- Ensure `NGROK_URL` is set and accessible
- Check Twilio webhook configuration
- Verify audio files in `/audio` endpoint

### Image Processing
- Supported formats: JPEG, PNG, GIF, BMP, WebP
- Max file size: 20MB (Twilio limit)
- Requires active Google Cloud billing account

## API Costs

- **Google Cloud Vision**: ~$1.50 per 1,000 images
- **Deepgram**: ~$0.0043 per minute of audio
- **ElevenLabs**: Varies by plan (free tier has limitations)
- **Perplexity**: Check current pricing

## Security Notes

- Keep service account keys secure
- Use IAM roles with minimal required permissions
- Consider rotating API keys regularly
- Monitor usage to avoid unexpected charges
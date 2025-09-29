require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(cors());
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- OpenRouter client (uses your OPENAI_API_KEY) ----------
let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,          // keep your key name
    baseURL: "https://openrouter.ai/api/v1",     // <-- route all calls to OpenRouter
    defaultHeaders: {
      "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
      "X-Title": "YouTube Copyright Risk Analyzer"
    }
  });
} else {
  console.warn('OPENAI_API_KEY not found. Using mock mode.');
}

// ---------- Helpers ----------
function extractJSON(text) {
  // Strip code fences if present
  const fenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '');
  // Try direct parse
  try { return JSON.parse(fenced); } catch (_) {}
  // Fallback: grab the largest {...} block
  const first = fenced.indexOf('{');
  const last = fenced.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = fenced.slice(first, last + 1);
    try { return JSON.parse(candidate); } catch (_) {}
  }
  throw new Error('Model did not return valid JSON');
}

// ---------- Routes ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/analyze', async (req, res) => {
  try {
    const { userName, channelName } = req.body;

    if (!userName || !channelName) {
      return res.status(400).json({ error: 'User name and channel name are required' });
    }

    // If no API keys, use mock results
    if (!process.env.YOUTUBE_API_KEY || !process.env.OPENAI_API_KEY) {
      console.log('Using mock data mode');
      const mockResults = generateMockResults(userName, channelName);
      return res.json(mockResults);
    }

    // Step 1: YouTube search
    let searchResponse;
    try {
      searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet',
          q: `${userName}`,
          type: 'video',
          maxResults: 10,
          key: process.env.YOUTUBE_API_KEY
        }
      });
    } catch (youtubeError) {
      console.error('YouTube API Error:', youtubeError?.response?.data || youtubeError.message);
      return res.status(500).json({ error: 'YouTube API error: ' + youtubeError.message });
    }

    if (!searchResponse.data.items?.length) {
      return res.status(404).json({ error: 'No videos found for this channel' });
    }

    const searchResults = searchResponse.data.items.map(item => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      channelId: item.snippet.channelId,
      publishedAt: item.snippet.publishedAt,
      thumbnails: item.snippet.thumbnails,
      publishTime: item.snippet.publishTime
    }));

    // Step 2: Analyze with OpenRouter (DeepSeek R1)
    const prompt = `
SYSTEM:
You are an expert copyright-risk analyst AI for online video platforms. You do NOT make legal determinations — you score and prioritize videos for likely copyright infringement using explicit heuristics and provide practical verification steps.

USER / TASK:
- Metadata:
  - original_title: "${userName} Content"
  - original_channel_title: "${channelName}"
  - original_channel_id: not provided
  - original_release_date: not provided
- Analyze the YouTube search results (JSON below).
- Output JSON only (no prose, no markdown), matching the schema with keys: summary, ranked_list (array), top_priority (array), checklist (array), next_actions (array), disclaimer (string).
- Keep it concise and practical. Never claim definite infringement.

Here are the search results to analyze:
${JSON.stringify(searchResults, null, 2)}
`;

    try {
      const completion = await openai.chat.completions.create({
        model: "deepseek/deepseek-r1:free",
        messages: [
          { role: "system", content: "Return ONLY valid JSON. Do not include code fences, explanations, or additional text." },
          { role: "user", content: prompt }
        ],
        // R1 sometimes adds extra “thinking” — keep temp low and we'll still sanitize.
        temperature: 0.2,
        max_tokens: 2000
        // NOTE: response_format: { type: "json_object" } is not reliably supported by all OpenRouter models.
      });

      const raw = completion.choices?.[0]?.message?.content || '';
      let analysis;
      try {
        analysis = extractJSON(raw);
      } catch (e) {
        console.error('JSON parse failed. Model output was:\n', raw);
        return res.status(502).json({ error: 'Model returned non-JSON output. Please retry.' });
      }

      // Step 3: Return results
      return res.json({
        userName,
        query: channelName,
        searchResults,
        analysis
      });

    } catch (llmError) {
      console.error('OpenRouter API Error:', llmError?.response?.data || llmError.message);
      return res.status(500).json({ error: 'OpenRouter API error: ' + (llmError.message || 'unknown') });
    }

  } catch (error) {
    console.error('Unexpected Error:', error);
    res.status(500).json({ error: 'An unexpected error occurred during analysis' });
  }
});

// ---------- Mock data ----------
function generateMockResults(userName, channelName) {
  const searchResults = [];
  for (let i = 1; i <= 5; i++) {
    searchResults.push({
      videoId: `mock_video_${i}`,
      title: `${channelName} - Video ${i}`,
      description: `This is a description for ${channelName} video ${i}`,
      channelTitle: i === 1 ? channelName : `Other Channel ${i}`,
      channelId: `channel_${i}`,
      publishedAt: new Date(Date.now() - i * 86400000).toISOString(),
      thumbnails: {
        default: {
          url: `https://via.placeholder.com/120x90.png?text=Thumbnail+${i}`,
          width: 120,
          height: 90
        }
      },
      publishTime: new Date(Date.now() - i * 86400000).toISOString()
    });
  }

  const analysis = {
    summary: `Based on the search results for "${channelName}", we found 5 videos with varying levels of copyright risk.`,
    ranked_list: [
      {
        videoId: "mock_video_2",
        title: `${channelName} - Video 2`,
        channel: "Other Channel 2",
        publishedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
        risk: "High",
        rationale: [
          "Exact title match with original content",
          "Uploaded by a channel not associated with the original creator"
        ]
      },
      {
        videoId: "mock_video_3",
        title: `${channelName} - Video 3`,
        channel: "Other Channel 3",
        publishedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
        risk: "Medium",
        rationale: [
          "Title suggests possible infringement",
          "Channel has uploaded similar content from multiple creators"
        ]
      },
      {
        videoId: "mock_video_4",
        title: `${channelName} - Video 4`,
        channel: "Other Channel 4",
        publishedAt: new Date(Date.now() - 4 * 86400000).toISOString(),
        risk: "Low",
        rationale: [
          "May be transformative content",
          "Description suggests educational use"
        ]
      },
      {
        videoId: "mock_video_5",
        title: `${channelName} - Video 5`,
        channel: "Other Channel 5",
        publishedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        risk: "Low",
        rationale: [
          "Short clip likely falling under fair use",
          "Clear attribution in description"
        ]
      },
      {
        videoId: "mock_video_1",
        title: `${channelName} - Video 1`,
        channel: channelName,
        publishedAt: new Date(Date.now() - 86400000).toISOString(),
        risk: "Low",
        rationale: [
          "Official channel content",
          "No signs of infringement"
        ]
      }
    ],
    top_priority: ["mock_video_2", "mock_video_3"],
    checklist: [
      "Open video and compare audio/duration",
      "Check description for rights statement",
      "Check channel About page",
      "Screenshot evidence",
      "Check YouTube Content ID/claims if visible"
    ],
    next_actions: [
      "Contact rights owner",
      "Use YouTube Studio -> Copyright -> Submit takedown (if owner)",
      "Send polite removal request to uploader (template)"
    ],
    disclaimer: "This is an automated risk-assessment, not legal advice; consult counsel before taking legal action."
  };

  return { userName, query: channelName, searchResults, analysis };
}

// ---------- Start ----------
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  if (!process.env.YOUTUBE_API_KEY || !process.env.OPENAI_API_KEY) {
    console.log('Running in mock mode - add API keys to .env for full functionality');
  }
});

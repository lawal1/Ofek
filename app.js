require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize OpenAI
let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
} else {
  console.warn('OPENAI_API_KEY not found. Using mock mode.');
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/analyze', async (req, res) => {
  try {
    const { userName, channelName } = req.body;

    // Validate input
    if (!userName || !channelName) {
      return res.status(400).json({ error: 'User name and channel name are required' });
    }

    // If no API keys, use mock data
    if (!process.env.YOUTUBE_API_KEY || !process.env.OPENAI_API_KEY) {
      console.log('Using mock data mode');
      const mockResults = generateMockResults(userName, channelName);
      return res.json(mockResults);
    }

    // Step 1: Search for videos using YouTube Data API with only the channel name
    let searchResponse;
    try {
      searchResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
        params: {
          part: 'snippet',
          q: `${userName} `,
          type: 'video',
          maxResults: 10,
          key: process.env.YOUTUBE_API_KEY
        }
      });
    } catch (youtubeError) {
      console.error('YouTube API Error:', youtubeError.message);
      return res.status(500).json({ 
        error: 'YouTube API error: ' + youtubeError.message 
      });
    }

    if (searchResponse.data.items.length === 0) {
      return res.status(404).json({ error: 'No videos found for this channel' });
    }

    // Prepare the search results for analysis
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

    // Step 2: Analyze with OpenAI using the specified prompt
    const prompt = `
      SYSTEM:
      You are an expert copyright-risk analyst AI for online video platforms. You do NOT make legal determinations — instead you score and prioritize videos for likely copyright infringement using explicit heuristics and provide practical verification steps and next actions for a rights holder or reviewer.

      USER / TASK:
      Input:
      1) A JSON search response from the YouTube Data API containing up to N search results (each item includes videoId, snippet.title, snippet.description, snippet.channelTitle, snippet.channelId, snippet.publishedAt, snippet.thumbnails, snippet.publishTime).
      2) Metadata describing the original work:
        - original_title: "${userName} Content"
        - original_channel_title: "${channelName}"
        - original_channel_id: not provided
        - original_release_date: not provided

      Goal:
      For each video in the API results, assign a copyright infringement RISK LEVEL: "High", "Medium", or "Low". Provide a succinct rationale for each assignment, rank the videos by descending risk, and produce an actionable short checklist the user can follow to verify and, if needed, act (e.g., submit takedown, contact uploader).

      HEURISTICS / SCORING RULES (apply these in order; combine into final risk):
      - Channel match:
        - If snippet.channelId or snippet.channelTitle matches original_channel_id or original_channel_title → LOW risk (treat as official).
        - If not match → continue evaluating.
      - Exact-title match:
        - If title contains exact original_title (case-insensitive) or near-exact with artists' names → + high-risk weight.
      - Keywords strongly indicating reproduction: "lyrics", "official lyrics", "full song", "full track", "official video", "audio" → + high-risk weight.
      - Derivative/transformative hints: "cover", "piano", "tutorial", "play-along", "remix", "inspired by", "shorts", "behind the scenes", "shots that didn't make" → lower risk (Medium/Low depending on whether original audio is likely included).
      - Content type / length inference:
        - If title contains "lyrics" or "full" or description suggests the full song → +high.
        - If title contains "shorts", "clip", "behind the scenes", "funny" → -risk (but if it likely includes full audio still flag Medium).
      - Publish date context:
        - If publish date is very close to known official release and channel is non-owner → higher suspicion.
        - Very old uploads that predate official release may indicate original live versions or unrelated content — treat cautiously.
      - Channel type:
        - Lyric channels, "officials" that are not the artist, and channels with many similar uploads → higher risk.
        - Event channels or news channels uploading live sermon / performance of the artist → likely permitted if recorded with permission (Medium or Low).
      - Repetition / multiple uploads:
        - If multiple non-owner channels have exact-title uploads shortly after official release → raise priority (higher risk).
      - Ambiguity fallback:
        - If insufficient metadata (no duration, no description), use title + channel heuristics and mark as Medium when unsure.

      OUTPUT FORMAT:
      1) Short summary paragraph (1–2 sentences) of overall assessment.
      2) A ranked list (highest risk first) with entries for each video:
        - videoId — title — channelTitle — publishedAt — RISK (High/Medium/Low)
        - rationale (1–2 short bullets explaining why)
      3) Top 5 highest-risk videos listed separately for prioritized manual review.
      4) A verification checklist the reviewer should follow for each flagged video (exact actions to confirm infringement).
      5) Suggested next actions depending on outcome (e.g., gather evidence, contact uploader, submit DMCA takedown via YouTube Studio), and a short, neutral DMCA template placeholder if the user says they own the rights.
      6) A one-line legal disclaimer: "This is an automated risk-assessment, not legal advice; consult counsel before taking legal action."

      OUTPUT STYLE / CONSTRAINTS:
      - Be concise and practical. Use plain language.
      - Do NOT assert that a video is definitely infringing; use "likely", "possible", "probable".
      - Prioritize clarity for a human reviewer who will manually check the top items.
      - Provide the result as JSON with keys: summary, ranked_list (array), top_priority (array), checklist (array), next_actions (array), disclaimer (string).

      EXAMPLE (concise) JSON SCHEMA:
      {
        "summary": "...",
        "ranked_list": [
          {"videoId":"...","title":"...","channel":"...","publishedAt":"...","risk":"High","rationale":["...","..."]},
          ...
        ],
        "top_priority": ["videoId1","videoId2",...],
        "checklist": ["Open video and compare audio/duration","Check description for rights statement","Check channel About page","Screenshot evidence","Check YouTube Content ID/claims if visible"],
        "next_actions": ["Contact rights owner","Use YouTube Studio -> Copyright -> Submit takedown (if owner)","Send polite removal request to uploader (template)"],
        "disclaimer": "..."
      }

      ADDITIONAL NOTES:
      - If original_channel_id is provided, rely on it (more authoritative than channelTitle).
      - If you detect the same channel across multiple "official"-looking videos, tag them Low risk even if titles are identical.
      - When in doubt, mark Medium and include a short note on what to check to escalate to High.
      - Keep responses short; include no more than 6 top-priority items.

      Here are the search results to analyze:
      ${JSON.stringify(searchResults, null, 2)}

      Please provide your analysis in the specified JSON format.
    `;

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a copyright expert analyzing YouTube videos for potential infringement issues." },
          { role: "user", content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 2000
      });

      // Parse the analysis from OpenAI
      const analysis = JSON.parse(completion.choices[0].message.content);
      
      // Step 3: Return results
      res.json({
        userName,
        query: channelName,
        searchResults,
        analysis
      });

    } catch (openaiError) {
      console.error('OpenAI API Error:', openaiError.message);
      return res.status(500).json({ 
        error: 'OpenAI API error: ' + openaiError.message 
      });
    }

  } catch (error) {
    console.error('Unexpected Error:', error);
    res.status(500).json({ error: 'An unexpected error occurred during analysis' });
  }
});

// Mock data generator for when API keys are not available
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
    summary: `Based on the search results for "${channelName}", we found 5 videos with varying levels of copyright risk. The official channel content appears to be properly represented, but there are several potentially infringing uploads from third-party channels.`,
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

  return {
    userName,
    query: channelName,
    searchResults,
    analysis
  };
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  if (!process.env.YOUTUBE_API_KEY || !process.env.OPENAI_API_KEY) {
    console.log('Running in mock mode - add API keys to .env for full functionality');
  }
});

const express = require('express');
const router = express.Router();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

router.post('/generate', async (req, res) => {
  const { prompt, maxTokens } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  try {
    const systemPrompt = 'You are a creative content assistant for a creator accountability app. Write in a natural, authentic, and engaging voice. Avoid generic phrases and clichés. Be concise but insightful. Always respond with valid JSON only, matching the structure requested in the prompt.';

    const response = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',   // active model — replaces decommissioned mixtral-8x7b-32768
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: maxTokens || 1500,
      response_format: { type: 'json_object' },
    });

    res.json({ result: response.choices[0]?.message?.content || '' });
  } catch (error) {
    console.error('Groq error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

router.post('/generate', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    const systemPrompt = 'You are a creative content assistant for a creator accountability app. Write in a natural, authentic, and engaging voice. Avoid generic phrases and clichés. Be concise but insightful.';

    const response = await groq.chat.completions.create({
      model: 'llama-3.1-70b-versatile',   // 👈 updated model
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 500,
    });

    const result = response.choices[0]?.message?.content || '';
    res.json({ result });
  } catch (error) {
    console.error('Groq API error:', error);
    res.status(500).json({ error: error.message || 'AI generation failed' });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini with your API key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

router.post('/generate', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  try {
    // Get the model
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }); // or 'gemini-1.5-pro'

    // Build the prompt
    const fullPrompt = `You are a creative content assistant for a creator accountability app. Write in a natural, authentic, and engaging voice. Avoid generic phrases and clichés. Be concise but insightful.

User request: ${prompt}`;

    // Generate content
    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const text = response.text();

    res.json({ result: text });
  } catch (error) {
    console.error('Gemini API error:', error);
    res.status(500).json({ error: error.message || 'AI generation failed' });
  }
});

module.exports = router;

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./supabase');
const { Resend } = require('resend');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// CORS for your frontend
app.use(cors({
  origin: [
    'https://creator-accountability.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Send email helper
async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({
      from: 'onboarding@resend.dev', // or your verified domain later
      to,
      subject,
      html
    });
    return true;
  } catch (err) {
    console.error('Email error:', err);
    return false;
  }
}

// Nudge endpoint
app.post('/api/notifications/nudge', async (req, res) => {
  const { from_user_id, to_user_id } = req.body;
  console.log('Nudge from', from_user_id, 'to', to_user_id);

  try {
    // Fetch both profiles
    const { data: fromProfile, error: fromErr } = await supabase
      .from('profiles').select('name, email').eq('id', from_user_id).single();
    const { data: toProfile, error: toErr } = await supabase
      .from('profiles').select('name, email').eq('id', to_user_id).single();

    if (fromErr || toErr || !fromProfile || !toProfile) {
      console.error('Profile fetch error:', fromErr || toErr);
      return res.status(404).json({ error: 'User not found' });
    }

    // Send email to partner
    if (toProfile.email) {
      await sendEmail(
        toProfile.email,
        '💪 Your accountability partner nudged you!',
        `
        <div style="font-family: sans-serif; max-width: 600px;">
          <h2 style="color: #F5A623;">🔥 Streak</h2>
          <p><strong>${fromProfile.name}</strong> just nudged you to post today.</p>
          <p>Don't break your streak!</p>
          <a href="https://creator-accountability.netlify.app/dashboard"
             style="background: #F5A623; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none;">
            Open Dashboard
          </a>
        </div>
        `
      );
    }

    // Send confirmation email to the person who nudged
    if (fromProfile.email) {
      await sendEmail(
        fromProfile.email,
        '📬 Nudge sent!',
        `
        <div style="font-family: sans-serif; max-width: 600px;">
          <h2 style="color: #F5A623;">🔥 Streak</h2>
          <p>You just nudged <strong>${toProfile.name}</strong>.</p>
          <p>Keep up the accountability!</p>
          <a href="https://creator-accountability.netlify.app/dashboard"
             style="background: #F5A623; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none;">
            Go to Dashboard
          </a>
        </div>
        `
      );
    }

    res.json({ success: true, message: 'Nudge emails sent' });
  } catch (err) {
    console.error('Nudge error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});

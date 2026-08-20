const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./supabase');
const { notifyUser, sendEmail } = require('./notificationService');

const app = express();

// ---- CORS ----
app.use(cors({
  origin: [
    'https://creator-accountability.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// ---- Health ----
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Nudge endpoint ----
app.post('/api/notifications/nudge', async (req, res) => {
  const { from_user_id, to_user_id } = req.body;
  console.log('📨 Nudge from', from_user_id, 'to', to_user_id);

  try {
    // Fetch both profiles
    const { data: fromProfile, error: fromErr } = await supabase
      .from('profiles').select('name, email').eq('id', from_user_id).single();
    const { data: toProfile, error: toErr } = await supabase
      .from('profiles').select('name, email').eq('id', to_user_id).single();

    if (fromErr || toErr || !fromProfile || !toProfile) {
      console.error('❌ Profile fetch error:', fromErr || toErr);
      return res.status(404).json({ error: 'User(s) not found' });
    }

    // 1. Send push (and email fallback) to the partner
    await notifyUser(
      to_user_id,
      '👋 You got nudged!',
      `${fromProfile.name} is checking on you. Have you posted today?`,
      { action: 'checkin' }
    );

    // 2. Send a confirmation email to the person who nudged
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

    res.json({ success: true, message: 'Nudge sent (push + email fallback)' });
  } catch (err) {
    console.error('💥 Nudge error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Get VAPID public key (for frontend subscription) ----
app.get('/api/notifications/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// ---- Save push subscription ----
app.post('/api/notifications/subscribe', async (req, res) => {
  const { user_id, endpoint, p256dh, auth } = req.body;
  if (!user_id || !endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  await supabase.from('push_subscriptions').upsert({
    user_id, endpoint, p256dh, auth
  }, { onConflict: 'endpoint' });
  res.json({ success: true });
});

// ---- Unsubscribe ----
app.delete('/api/notifications/subscribe', async (req, res) => {
  const { endpoint } = req.body;
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  res.json({ success: true });
});

// ---- Start server ----
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});

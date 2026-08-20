const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./supabase');
const { notifyUser, sendEmail } = require('./notificationService');

const app = express();

app.use(cors({
  origin: [
    'https://creator-accountability.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/notifications/nudge', async (req, res) => {
  const { from_user_id, to_user_id } = req.body;
  console.log('📨 Nudge from', from_user_id, 'to', to_user_id);

  try {
    const { data: fromProfile, error: fromErr } = await supabase
      .from('profiles').select('name, email').eq('id', from_user_id).single();
    const { data: toProfile, error: toErr } = await supabase
      .from('profiles').select('name, email').eq('id', to_user_id).single();

    if (fromErr || toErr || !fromProfile || !toProfile) {
      console.error('❌ Profile fetch error:', fromErr || toErr);
      return res.status(404).json({ error: 'User(s) not found' });
    }

    const { data: streak } = await supabase
      .from('streaks')
      .select('current_streak')
      .eq('user_id', to_user_id)
      .single();

    const streakCount = streak?.current_streak || 0;

    // 1. Push (and email fallback) to partner
    await notifyUser(
      to_user_id,
      '👋 You got nudged!',
      `${fromProfile.name} is checking on you. Have you posted today?`,
      { action: 'checkin' }
    );

    // 2. Rich confirmation email to the nudger
    if (fromProfile.email) {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Nudge sent</title>
        </head>
        <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0;">
          <div style="max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <!-- Header -->
            <div style="background: #F5A623; padding: 24px; text-align: center;">
              <h1 style="color: #fff; margin: 0; font-size: 28px;">🔥 Streak</h1>
              <p style="color: #fff; margin: 4px 0 0; font-size: 14px;">Accountability made simple</p>
            </div>

            <!-- Body -->
            <div style="padding: 28px 24px;">
              <h2 style="color: #333; font-size: 22px; margin-top: 0;">📬 Nudge sent!</h2>
              <p style="font-size: 16px; line-height: 1.6; color: #444;">
                You just nudged <strong>${toProfile.name}</strong> to post today.
              </p>
              <p style="font-size: 16px; line-height: 1.6; color: #444;">
                Their current streak is <strong style="color: #F5A623;">${streakCount} days</strong> – every day matters!
              </p>
              <p style="font-size: 16px; line-height: 1.6; color: #444;">
                Thank you for being an accountability partner. Your support helps them stay consistent and reach their goals.
              </p>

              <div style="text-align: center; margin: 30px 0;">
                <a href="https://creator-accountability.netlify.app/dashboard"
                   style="background: #F5A623; color: #000; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
                  Go to Dashboard
                </a>
              </div>

              <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">

              <!-- Contact / Support -->
              <div style="background: #f9f9f9; padding: 16px; border-radius: 6px;">
                <p style="font-size: 14px; color: #555; margin: 0;">
                  <strong>💬 Questions or feedback?</strong><br>
                  We'd love to hear from you. Reply directly to this email or reach out at:
                </p>
                <p style="font-size: 14px; color: #333; margin: 8px 0 0;">
                  <a href="mailto:${process.env.SENDER_EMAIL}" style="color: #F5A623; text-decoration: none;">
                    ${process.env.SENDER_EMAIL}
                  </a>
                </p>
                <p style="font-size: 13px; color: #777; margin: 6px 0 0;">
                  (This is the developer contact for support and suggestions.)
                </p>
              </div>

              <!-- Footer -->
              <div style="margin-top: 24px; text-align: center; font-size: 12px; color: #999;">
                <p style="margin: 4px 0;">
                  You're receiving this because you're part of <strong>Creator Accountability</strong>.
                </p>
                <p style="margin: 4px 0;">
                  <a href="https://creator-accountability.netlify.app/unsubscribe?email=${fromProfile.email}" style="color: #999; text-decoration: underline;">
                    Unsubscribe
                  </a>
                  &nbsp;·&nbsp; 
                  <a href="https://creator-accountability.netlify.app" style="color: #999; text-decoration: underline;">
                    Visit our site
                  </a>
                </p>
                <p style="margin: 8px 0 0; color: #bbb;">© ${new Date().getFullYear()} Streak</p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;
      await sendEmail(fromProfile.email, '📬 Nudge sent!', html);
    }

    res.json({ success: true, message: 'Nudge sent (push + email fallback)' });
  } catch (err) {
    console.error('💥 Nudge error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

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

app.delete('/api/notifications/subscribe', async (req, res) => {
  const { endpoint } = req.body;
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  res.json({ success: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});

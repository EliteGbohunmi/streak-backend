const express = require('express');
const cors = require('cors');
require('dotenv').config();
const supabase = require('./supabase');
const { notifyUser, sendEmail, getRandomNudgeMessage } = require('./notificationService');
const { startScheduler } = require('./scheduler');

process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
});

const app = express();

app.use(cors({
  origin: [
    'https://creator-accountability.netlify.app',
    'https://creator-accountability-obv8-eight.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));
app.use(express.json());

// ---- Health ----
app.get('/', (req, res) => res.send('OK'));
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- API Routes ----
app.use('/api/community', require('./routes/community'));
app.use('/api/ai', require('./routes/ai'));

// ---- Nudge endpoint ----
app.post('/api/notifications/nudge', async (req, res) => {
  const { from_user_id, to_user_id } = req.body;
  console.log('📨 Nudge from', from_user_id, 'to', to_user_id);

  try {
    const { data: fromProfile, error: fromErr } = await supabase
      .from('profiles').select('name, email').eq('id', from_user_id).single();
    const { data: toProfile, error: toErr } = await supabase
      .from('profiles').select('name, email').eq('id', to_user_id).single();

    if (fromErr || toErr || !fromProfile || !toProfile) {
      return res.status(404).json({ error: 'User(s) not found' });
    }

    const { data: streak } = await supabase
      .from('streaks')
      .select('current_streak')
      .eq('user_id', to_user_id)
      .single();
    const streakCount = streak?.current_streak || 0;

    const nudgeMessage = getRandomNudgeMessage(fromProfile.name, toProfile.name);
    const pushTitle = '👋 You got nudged!';

    await notifyUser(to_user_id, pushTitle, nudgeMessage, { action: 'checkin' });
    await supabase.from('user_notifications').insert({
      user_id: to_user_id,
      message: nudgeMessage,
      from_user_id: from_user_id
    });

    if (fromProfile.email) {
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #F5A623;">🔥 Streak</h2>
          <p>You nudged <strong>${toProfile.name}</strong>.</p>
          <p><em>${nudgeMessage}</em></p>
          <p>Their current streak: <strong>${streakCount} days</strong>.</p>
          <p>Keep up the accountability!</p>
          <a href="https://creator-accountability.netlify.app/dashboard" style="background: #F5A623; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Go to Dashboard</a>
        </div>
      `;
      await sendEmail(fromProfile.email, '📬 Nudge sent!', html);
    }

    res.json({ success: true, message: 'Nudge sent' });
  } catch (err) {
    console.error('💥 Nudge error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Unread notifications ----
app.get('/api/notifications/unread', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' });
  const { data, error } = await supabase
    .from('user_notifications')
    .select('*')
    .eq('user_id', user_id)
    .eq('read', false)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/notifications/mark-read', async (req, res) => {
  const { notification_id } = req.body;
  if (!notification_id) return res.status(400).json({ error: 'Missing notification_id' });
  const { error } = await supabase
    .from('user_notifications')
    .update({ read: true })
    .eq('id', notification_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ---- VAPID & Push Subscription ----
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

// ---- TEST EMAIL endpoint (manual trigger) ----
app.post('/api/test-email', async (req, res) => {
  const { email } = req.body;
  const testEmail = email || process.env.SENDER_EMAIL || 'your-email@example.com';
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: process.env.SENDER_EMAIL || 'onboarding@resend.dev',
      to: testEmail,
      subject: '🧪 Test email from Streak',
      html: '<p>Your SMTP / Resend configuration is working correctly!</p>'
    });
    res.json({ success: true, message: `Test email sent to ${testEmail}`, result });
  } catch (err) {
    console.error('❌ Test email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Start server ----
const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT} (0.0.0.0)`);
  startScheduler();
});

// ---- Keep-alive ----
setInterval(() => {
  console.log('🔄 Keep-alive ping');
}, 60000);

// ---- Graceful shutdown ----
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received – shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received – shutting down');
  server.close(() => process.exit(0));
});

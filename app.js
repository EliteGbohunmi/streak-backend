console.log('🚀 App starting...');
app.use('/api/notifications', require('./routes/notifications'))
app.use('/api/streaks', require('./routes/streaks'))
app.use('/api/ai', require('./routes/ai'))
app.use('/api/test', require('./routes/test'))

// ---- TEST EMAIL (manual trigger) ----
app.post('/api/test-email', async (req, res) => {
  const { email } = req.body;
  const testEmail = email || process.env.SENDER_EMAIL || 'your-email@example.com';
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.SENDER_EMAIL || 'onboarding@resend.dev',
      to: testEmail,
      subject: '🧪 Test email from Streak',
      html: '<p>Your SMTP / Resend configuration is working correctly!</p>'
    });
    res.json({ success: true, message: `Test email sent to ${testEmail}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

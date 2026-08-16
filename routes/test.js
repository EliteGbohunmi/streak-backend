const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { notifyUser } = require('../services/notificationService');

router.post('/test-notify', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();

  if (!profile) return res.status(404).json({ error: 'User not found' });

  await notifyUser(
    profile.id,
    '🧪 Manual Test',
    'This is a test notification – email fallback will work if push fails.',
    { action: 'test' }
  );

  res.json({ success: true, message: `Notification sent to ${email}` });
});

module.exports = router;

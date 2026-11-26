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
    'https://creator-accountability.vercel.app',
    'https://creator-accountability-obv8-eight.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));

app.use(express.json());

app.get('/', (req, res) => res.send('OK'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

app.use('/api/community', require('./routes/community'));
app.use('/api/ai', require('./routes/ai'));

// ---- Nudge ----
// CHANGED: removed the duplicate `user_notifications.insert`. notifyUser
// is now the single write path. It writes to notification_log (which
// /api/notifications/list and the bell read). No more double rows.
app.post('/api/notifications/nudge', async (req, res) => {
  const { from_user_id, to_user_id } = req.body;

  console.log('📨 Nudge from', from_user_id, 'to', to_user_id);

  try {
    const { data: fromProfile, error: fromErr } = await supabase
      .from('profiles')
      .select('name, email')
      .eq('id', from_user_id)
      .single();

    const { data: toProfile, error: toErr } = await supabase
      .from('profiles')
      .select('name, email')
      .eq('id', to_user_id)
      .single();

    if (fromErr || toErr || !fromProfile || !toProfile) {
      return res.status(404).json({ error: 'User(s) not found' });
    }

    const { data: streak } = await supabase
      .from('streaks')
      .select('current_streak')
      .eq('user_id', to_user_id)
      .single();

    const streakCount = streak?.current_streak || 0;

    const nudgeMessage = getRandomNudgeMessage(
      fromProfile.name,
      toProfile.name
    );

    const pushTitle = '👋 You got nudged!';

    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    const { data: recent } = await supabase
      .from('notification_log')
      .select('id')
      .eq('user_id', to_user_id)
      .eq('title', pushTitle)
      .gte('sent_at', thirtySecondsAgo)
      .limit(1);

    if (recent && recent.length > 0) {
      return res.json({ success: true, message: 'Nudge already sent recently' });
    }

    // Dedupe: if the same user was nudged in the last 30 seconds, skip.
    // Stops frontend burst (multi-tap / motion re-render) from spamming rows.
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    const { data: recent } = await supabase
      .from('notification_log')
      .select('id')
      .eq('user_id', to_user_id)
      .eq('title', pushTitle)
      .gte('sent_at', thirtySecondsAgo)
      .limit(1);

    if (recent && recent.length > 0) {
      return res.json({ success: true, message: 'Nudge already sent recently' });
    }

    // CHANGED: removed the manual user_notifications.insert below this call.
    // notifyUser handles logging to notification_log, which is what the
    // bell + /notifications page read from.
    await notifyUser(
      to_user_id,
      pushTitle,
      nudgeMessage,
      { action: 'checkin' }
    );

    if (fromProfile.email) {
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e0e0e0;border-radius:12px;">
          <h2 style="color:#F5A623;">Streak</h2>
          <p>You nudged <strong>${toProfile.name}</strong>.</p>
          <p><em>${nudgeMessage}</em></p>
          <p>Their current streak: <strong>${streakCount} days</strong>.</p>
          <p>Keep up the accountability!</p>
          <a href="https://creator-accountability.netlify.app/dashboard"
             style="background:#F5A623;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold;">
            Go to Dashboard
          </a>
        </div>
      `;

      await sendEmail(fromProfile.email, 'Nudge sent!', html);
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

  if (!user_id) {
    return res.status(400).json({ error: 'Missing user_id' });
  }

  try {
    const { data, error } = await supabase
      .from('user_notifications')
      .select('*')
      .eq('user_id', user_id)
      .eq('read', false)
      .order('sent_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error('Unread notifications error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/mark-read', async (req, res) => {
  const { notification_id } = req.body;

  if (!notification_id) {
    return res.status(400).json({ error: 'Missing notification_id' });
  }

  try {
    const { error } = await supabase
      .from('user_notifications')
      .update({ read: true })
      .eq('id', notification_id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Mark-read error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- VAPID ----
app.get('/api/notifications/vapid-key', (req, res) => {
  res.json({
    publicKey: process.env.VAPID_PUBLIC_KEY || ''
  });
});

app.post('/api/notifications/subscribe', async (req, res) => {
  const { user_id, endpoint, p256dh, auth } = req.body;

  if (!user_id || !endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        { user_id, endpoint, p256dh, auth },
        { onConflict: 'endpoint' }
      );

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notifications/subscribe', async (req, res) => {
  const { endpoint } = req.body;

  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint' });
  }

  try {
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Unsubscribe error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Test notification ----
app.post('/api/test-notify', async (req, res) => {
  const { userId, title, body } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  try {
    await notifyUser(
      userId,
      title || 'Test',
      body || 'Manual test',
      {}
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Test notification error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Direct email test ----
app.post('/test-send-email', async (req, res) => {
  const { to, subject, html } = req.body;

  if (!to) {
    return res.status(400).json({ error: 'Missing "to" email' });
  }

  try {
    const result = await sendEmail(
      to,
      subject || 'Test from Streak',
      html || '<p>This is a direct test from your backend.</p>'
    );

    if (result) {
      return res.json({
        success: true,
        message: `Email accepted for sending to ${to}`
      });
    }

    return res.status(500).json({
      error: 'Email sending failed. Check the backend logs.'
    });
  } catch (err) {
    console.error('Direct email test error:', err);

    res.status(500).json({ error: err.message });
  }
});

// ---- Broadcast helpers ----
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPlainTextMessage(value) {
  return escapeHtml(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '<br>');
}

function buildBroadcastEmail(subject, message, allowHtml = false) {
  const safeSubject = escapeHtml(subject);
  const messageContent = allowHtml
    ? message
    : formatPlainTextMessage(message);
  const year = new Date().getFullYear();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <title>${safeSubject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#202124;">
  <div style="display:none;font-size:1px;color:#f4f5f7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
    An update from Creator Accountability.
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f5f7;width:100%;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 24px;border-bottom:1px solid #eeeeee;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left" style="font-size:21px;font-weight:bold;letter-spacing:-0.5px;color:#202124;">
                    <span style="color:#F5A623;">●</span>
                    Creator Accountability
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 32px 12px;">
              <p style="margin:0 0 14px;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#a66b00;">
                A MESSAGE FROM OUR TEAM
              </p>
              <h1 style="margin:0;font-size:29px;line-height:1.3;letter-spacing:-0.7px;font-weight:700;color:#202124;overflow-wrap:break-word;">
                ${safeSubject}
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px 30px;">
              <div style="font-size:16px;line-height:1.85;color:#454950;overflow-wrap:break-word;word-wrap:break-word;">
                ${messageContent}
              </div>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:30px;">
                <tr>
                  <td align="center" bgcolor="#F5A623" style="border-radius:8px;">
                    <a href="https://creator-accountability.vercel.app/dashboard"
                       style="display:inline-block;padding:15px 25px;font-size:15px;line-height:1.2;font-weight:bold;color:#171717;text-decoration:none;border-radius:8px;">
                      Open Your Dashboard &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:28px 0 0;font-size:14px;line-height:1.7;color:#737780;">
                Keep showing up for the things you said matter. Small, consistent steps count.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;background-color:#fafafa;border-top:1px solid #eeeeee;">
              <p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:#454950;">
                Creator Accountability
              </p>
              <p style="margin:0;font-size:12px;line-height:1.7;color:#858992;">
                You're receiving this message because you have an account with Creator Accountability.
                If you no longer wish to receive these updates, please contact the team.
              </p>
              <p style="margin:16px 0 0;font-size:11px;color:#a0a3aa;">
                &copy; ${year} Creator Accountability
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

// ---- Broadcast ----
app.post('/api/admin/broadcast', async (req, res) => {
  const { secret, subject, message, allowHtml = false } = req.body;

  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (
    typeof subject !== 'string' ||
    !subject.trim() ||
    typeof message !== 'string' ||
    !message.trim()
  ) {
    return res.status(400).json({ error: 'Subject and message are required.' });
  }

  if (subject.length > 200) {
    return res.status(400).json({ error: 'Subject must be 200 characters or fewer.' });
  }

  if (message.length > 30000) {
    return res.status(400).json({ error: 'Message is too long. Maximum length is 30000 characters.' });
  }

  if (typeof allowHtml !== 'boolean') {
    return res.status(400).json({ error: 'allowHtml must be true or false.' });
  }

  try {
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('email')
      .not('email', 'is', null);

    if (error) throw error;

    const recipients = [
      ...new Set(
        (profiles || [])
          .map(profile => profile.email?.trim().toLowerCase())
          .filter(Boolean)
      )
    ];

    if (recipients.length === 0) {
      return res.json({
        success: true,
        message: 'No email recipients were found.',
        total: 0,
        sent: 0,
        failed: 0
      });
    }

    const emailHtml = buildBroadcastEmail(subject.trim(), message, allowHtml);
    let sent = 0;
    let failed = 0;
    const batchSize = 10;

    for (let i = 0; i < recipients.length; i += batchSize) {
      const batch = recipients.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (email) => {
          try {
            const result = await sendEmail(email, subject.trim(), emailHtml);
            if (result) return { email, success: true };
            console.error(`Email service reported failure for ${email}`);
            return { email, success: false };
          } catch (err) {
            console.error(`Failed to send broadcast to ${email}:`, err.message);
            return { email, success: false };
          }
        })
      );

      for (const result of results) {
        if (result.success) sent++; else failed++;
      }

      console.log(`📧 Broadcast progress: ${sent + failed}/${recipients.length} processed`);

      if (i + batchSize < recipients.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`📬 Broadcast completed. Total: ${recipients.length}, Sent: ${sent}, Failed: ${failed}`);

    return res.json({
      success: failed === 0,
      message: `Broadcast processing completed. ${sent} emails accepted for sending; ${failed} failed.`,
      total: recipients.length,
      sent,
      failed
    });
  } catch (err) {
    console.error('Broadcast error:', err);
    res.status(500).json({
      error: 'The broadcast could not be completed.',
      details: err.message
    });
  }
});

// ============================================================
// Suggest accountability partners
// ============================================================
app.get('/api/partners/suggest', async (req, res) => {
  const { userId } = req.query;

  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const { data: partners, error: pErr } = await supabase
      .from('accountability_partners')
      .select('user1_id, user2_id')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    if (pErr) throw pErr;

    const excludedIds = new Set();
    partners?.forEach(partner => {
      excludedIds.add(partner.user1_id);
      excludedIds.add(partner.user2_id);
    });
    excludedIds.delete(userId);

    const { data: requests, error: rErr } = await supabase
      .from('partner_requests')
      .select('sender_id, receiver_id')
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
      .eq('status', 'pending');

    if (rErr) throw rErr;
    requests?.forEach(request => {
      excludedIds.add(request.sender_id);
      excludedIds.add(request.receiver_id);
    });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoff = sevenDaysAgo.toISOString().split('T')[0];

    let query = supabase
      .from('profiles')
      .select('id, name, email, streaks!inner(last_checked_in)')
      .neq('id', userId)
      .gte('streaks.last_checked_in', cutoff)
      .limit(10);

    const excludedList = [...excludedIds];
    if (excludedList.length > 0) {
      query = query.not('id', 'in', `(${excludedList.join(',')})`);
    }

    const { data: activeUsers, error: aErr } = await query;
    if (aErr) throw aErr;

    res.json(activeUsers || []);
  } catch (err) {
    console.error('Suggest partners error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ---- Partner request with notification ----
app.post('/api/partners/request', async (req, res) => {
  const { sender_id, receiver_id } = req.body;
  if (!sender_id || !receiver_id) {
    return res.status(400).json({ error: 'sender_id and receiver_id required' });
  }
  try {
    const { data: sender } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', sender_id)
      .single();

    const { error } = await supabase.from('partner_requests').insert({
      sender_id,
      receiver_id,
      status: 'pending'
    });
    if (error) return res.status(500).json({ error: error.message });

    const { notifyInApp } = require('./notificationService');
    await notifyInApp(
      receiver_id,
      '🤝 New partner request',
      `${sender?.name || 'Someone'} wants to be your accountability partner.`,
      'partner',
      'partner_request',
      { sender_id }
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Partner request error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ---- Check-in: update streak + award achievements + notify ----
app.post('/api/streaks/checkin', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    const today = new Date().toISOString().split('T')[0];

    const { data: existing } = await supabase
      .from('streaks')
      .select('current_streak, best_streak, last_checked_in, user_id')
      .eq('user_id', user_id)
      .maybeSingle();

    if (existing?.last_checked_in === today) {
      return res.json({ success: true, alreadyCheckedIn: true, streak: existing });
    }

    const newStreak = (existing?.current_streak || 0) + 1;
    const newBest = Math.max(newStreak, existing?.best_streak || 0);

    const { data: updated, error } = await supabase
      .from('streaks')
      .upsert({
        user_id,
        current_streak: newStreak,
        best_streak: newBest,
        last_checked_in: today
      }, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Award achievements
    const { awardAchievement } = require('./notificationService');

    const { count: totalCheckins } = await supabase
      .from('streaks')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user_id);

    if (totalCheckins === 1) await awardAchievement(user_id, 'first_post');
    if (newStreak >= 7) await awardAchievement(user_id, 'streak_7');
    if (newStreak >= 30) await awardAchievement(user_id, 'streak_30');
    if (newStreak >= 100) await awardAchievement(user_id, 'streak_100');

    res.json({ success: true, streak: updated, newStreak });
  } catch (err) {
    console.error('Check-in error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ---- Award achievements for a check-in (idempotent, safe to call repeatedly) ----
app.post('/api/streaks/award', async (req, res) => {
  const { user_id, streak } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    const { awardAchievement } = require('./notificationService');
    const s = Number(streak) || 0;

    const { count: totalCheckins } = await supabase
      .from('notification_log')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .eq('action', 'checkin');

    const awarded = [];

    if (totalCheckins !== null && totalCheckins <= 1) {
      const a = await awardAchievement(user_id, 'first_post'); if (a) awarded.push(a.key);
    }
    if (s >= 7)   { const a = await awardAchievement(user_id, 'streak_7');   if (a) awarded.push(a.key); }
    if (s >= 30)  { const a = await awardAchievement(user_id, 'streak_30');  if (a) awarded.push(a.key); }
    if (s >= 100) { const a = await awardAchievement(user_id, 'streak_100'); if (a) awarded.push(a.key); }

    res.json({ success: true, awarded });
  } catch (err) {
    console.error('Award error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Start server ----
// CHANGED: fixed the broken `const server = app.post(...)` assignment.
// `app.post` returns the Express app, not an HTTP server, so calling
// `server.close()` later was wrong. Declare `server` properly.
const PORT = process.env.PORT || 4000;

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { userId, subscription } = req.body;
    if (!userId || !subscription?.endpoint || !subscription?.keys) {
      return res.status(400).json({ error: 'Missing userId or subscription' });
    }
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_id: userId,
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth
        },
        { onConflict: 'endpoint' }
      );
    if (error) {
      console.error('Push subscribe DB error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/test-push', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const { notifyUser } = require('./notificationService');
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, name')
      .eq('email', email)
      .single();
    if (error || !profile) return res.status(404).json({ error: 'profile not found' });
    const result = await notifyUser(
      profile.id,
      'Test Notification',
      'If you see this, push is working.',
      { action: 'checkin' }
    );
    res.json({ sentTo: profile.name, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/proof/accept', async (req, res) => {
  try {
    const { proofId, partnerEmail } = req.body;
    if (!proofId || !partnerEmail) return res.status(400).json({ error: 'proofId and partnerEmail required' });
    const { data: partner } = await supabase.from('profiles').select('id').eq('email', partnerEmail).single();
    if (!partner) return res.status(404).json({ error: 'partner not found' });
    const { data: updated, error } = await supabase
      .from('checkin_proofs')
      .update({ status: 'confirmed', confirmed_by: partner.id, confirmed_at: new Date().toISOString() })
      .eq('id', proofId)
      .eq('status', 'pending')
      .select();
    if (error) return res.status(500).json({ error: error.message });
    if (!updated || updated.length === 0) return res.status(409).json({ error: 'already confirmed or not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications/list', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email required' });
    const { data: profile, error: pErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email)
      .single();
    if (pErr || !profile) {
      console.error('Profile lookup failed:', pErr?.message);
      return res.status(404).json({ error: 'profile not found' });
    }
    const { data, error } = await supabase
      .from('notification_log')
      .select('id, title, body, type, action, read_at, sent_at, delivered')
      .eq('user_id', profile.id)
      .order('sent_at', { ascending: false })
      .limit(50);
    if (error) {
      console.error('Notification list query failed:', error.message);
      return res.status(500).json({ error: error.message });
    }
    const unread = (data || []).filter(n => !n.read_at).length;
    res.json({ notifications: data || [], unread });
  } catch (err) {
    console.error('Notification list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/read', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    await supabase.from('notification_log').update({ read_at: new Date().toISOString() }).eq('id', id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/read-all', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const { data: profile } = await supabase.from('profiles').select('id').eq('email', email).single();
    if (!profile) return res.status(404).json({ error: 'profile not found' });
    await supabase.from('notification_log').update({ read_at: new Date().toISOString() }).eq('user_id', profile.id).is('read_at', null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/broadcast', async (req, res) => {
  try {
    const { adminSecret, title, body, metadata } = req.body;
    if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!title || !body) {
      return res.status(400).json({ error: 'title and body required' });
    }
    const { notifyUser } = require('./notificationService');

    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('id');

    if (error) return res.status(500).json({ error: error.message });

    let sent = 0;
    for (const profile of profiles || []) {
      try {
        await notifyUser(profile.id, title, body, { action: 'system', ...(metadata || {}) });
        sent++;
      } catch (e) {
        console.error('Broadcast failed for', profile.id, e.message);
      }
    }

    res.json({ success: true, sent, total: (profiles || []).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on port ${PORT} (0.0.0.0)`);

  try {
    // CHANGED: hardcoded — scheduler always starts. No env var needed.
    startScheduler();
  } catch (err) {
    console.error('Scheduler startup error:', err);
  }
});

const keepAliveInterval = setInterval(() => {
  console.log('🔄 Keep-alive ping');
}, 60000);

process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received – shutting down gracefully');
  clearInterval(keepAliveInterval);
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received – shutting down');
  clearInterval(keepAliveInterval);
  server.close(() => {
    process.exit(0);
  });
});

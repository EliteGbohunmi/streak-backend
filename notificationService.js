const webpush = require('web-push');
const supabase = require('./supabase');

// ==========================================
// VAPID CONFIGURATION
// ==========================================

let vapidReady = false;

try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      `mailto:${process.env.VAPID_EMAIL || 'admin@example.com'}`,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    vapidReady = true;
    console.log('[PUSH] VAPID configured.');
  }
} catch (err) {
  console.error('[PUSH] VAPID setup failed:', err.message);
}

// ==========================================
// NUDGE MESSAGES
// ==========================================

const NUDGE_MESSAGES = [
  "Hey {to}, {from} is checking on you. Have you posted today? Don't break your streak.",
  "Your partner {from} nudged you, {to}. Time to post and keep that streak alive.",
  "{to}, {from} just sent a nudge - you're falling behind. Post something now.",
  "Accountability check. {from} reminded you to post, {to}. Don't let them down.",
  "{to}, your streak is at risk. {from} is counting on you to post today.",
  "Hey {to}, {from} noticed you haven't posted yet. Let's go.",
  "{from} says: {to}, get that post up. Your streak depends on it.",
  "{to}, this is your nudge from {from}. One post today keeps the flame alive.",
  "Don't break the chain, {to}. {from} believes in you. Post now.",
  "{to}, {from} is waiting for your post. You've got this.",
  "Time to create, {to}. {from} just nudged you to share your work.",
  "{to}, your partner {from} is holding you accountable. Post something.",
  "Nudge from {from}: {to}, what are you waiting for? Post today.",
  "{to}, {from} checked in and saw you missed today. Let's fix that.",
  "Hey {to}, {from} is on fire. Don't let the streak die. Post now.",
  "{to}, this is your reminder from {from} to post. You'll thank yourself later.",
  "Accountability partner {from} says: {to}, don't procrastinate. Post today.",
  "{to}, {from} is watching your streak. Keep it going with one post.",
  "Nudge. {from} wants to see your post, {to}. The community is waiting.",
  "{to}, {from} just sent a nudge. It's your turn to create something amazing."
];

function getRandomNudgeMessage(fromName, toName) {
  const raw = NUDGE_MESSAGES[
    Math.floor(Math.random() * NUDGE_MESSAGES.length)
  ];

  return raw
    .replace(/{from}/g, fromName)
    .replace(/{to}/g, toName);
}

// ==========================================
// NOTIFICATION LOGGING
// ==========================================

async function logNotification(
  userId,
  type,
  delivered,
  title,
  error = null,
  body = null,
  action = null
) {
  const { error: dbError } = await supabase
    .from('notification_log')
    .insert({
      user_id: userId,
      type,
      delivered,
      error,
      title: title || null,
      body: body || null,
      action: action || null,
      metadata: { title }
    });

  if (dbError) {
    console.error('[LOG] Insert failed:', dbError.message);
  }
}

// ==========================================
// PUSH NOTIFICATIONS
// ==========================================

async function sendPushDetailed(userId, title, body, data = {}) {
  if (!vapidReady) {
    return {
      status: 'skipped',
      error: 'VAPID is not configured'
    };
  }

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    return {
      status: 'failed',
      error: error.message
    };
  }

  if (!subs || subs.length === 0) {
    console.log(`[PUSH] No subscriptions for ${userId}`);

    return {
      status: 'skipped',
      error: null
    };
  }

  const payload = JSON.stringify({
    title,
    body,
    icon: '/app-icon.png',
    image: data.image || ({
      nudge: 'https://creator-accountability.vercel.app/banners/nudge.svg',
      achievement: 'https://creator-accountability.vercel.app/banners/achievement.svg',
      challenge: 'https://creator-accountability.vercel.app/banners/challenge.svg',
      partner: 'https://creator-accountability.vercel.app/banners/partner.svg',
      community: 'https://creator-accountability.vercel.app/banners/community.svg',
      reminder: 'https://creator-accountability.vercel.app/banners/reminder.svg'
    }[(data.type || '').toLowerCase()] || '/notification-banner.svg'),
    badge: '/badge-icon.svg',
    vibrate: [200, 100, 200],
    actions: data.actions || (
      data.action === 'partner_proof' && data.proofId
        ? [
            { action: 'view', title: 'View' },
            { action: 'accept', title: 'Accept' }
          ]
        : [
            { action: 'checkin', title: 'I Posted' },
            { action: 'dismiss', title: 'Dismiss' }
          ]
    ),
    data
  });

  let successCount = 0;
  const errors = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth
          }
        },
        payload
      );

      successCount++;

      await supabase
        .from('push_subscriptions')
        .update({ last_success_at: new Date().toISOString() })
        .eq('id', sub.id);

    } catch (err) {
      console.error('[PUSH] Failed:', err.message);
      errors.push(err.message);

      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('endpoint', sub.endpoint);
      }

    }
  }

  if (successCount > 0) {
    return {
      status: 'sent',
      error: null
    };
  }

  return {
    status: 'failed',
    error: errors.join('; ') || 'All push deliveries failed'
  };
}

// Keep the original boolean-style function for other parts of the app.
async function sendPush(userId, title, body, data = {}) {
  const result = await sendPushDetailed(userId, title, body, data);
  return result.status === 'sent';
}

// ==========================================
// EMAIL NOTIFICATIONS
// ==========================================

async function sendEmail(to, subject, html) {
  const functionUrl = process.env.EMAIL_FUNCTION_URL;
  const functionSecret = process.env.EMAIL_FUNCTION_SECRET;

  if (!functionUrl || !functionSecret) {
    console.error('[EMAIL] Function URL or secret is missing.');
    return false;
  }

  try {
    const response = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-email-secret': functionSecret
      },
      body: JSON.stringify({ to, subject, html }),
      signal: AbortSignal.timeout(25000)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.success) {
      console.error(
        '[EMAIL] Failed:',
        response.status,
        result.error || 'Unknown error'
      );
      return false;
    }

    console.log(`[EMAIL] Sent to ${to}`);
    return true;
  } catch (err) {
    console.error('[EMAIL] Request failed:', err.message);
    return false;
  }
}

// ==========================================
// INDEPENDENT EMAIL + PUSH DELIVERY
// ==========================================

async function notifyUser(userId, title, body, data = {}, options = {}) {
  const requestedChannels = Array.isArray(options.channels)
    ? options.channels
    : ['email', 'push'];

  const channels = [...new Set(requestedChannels)].filter(channel =>
    channel === 'email' || channel === 'push'
  );

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('name, email')
    .eq('id', userId)
    .maybeSingle();

  if (error || !profile) {
    return {
      success: false,
      reason: error?.message || 'profile_not_found',
      emailStatus: 'not_attempted',
      pushStatus: 'not_attempted',
      emailSent: false,
      pushed: false
    };
  }

  let emailStatus = 'not_attempted';
  let pushStatus = 'not_attempted';
  let emailError = null;
  let pushError = null;

  const tasks = [];

  if (channels.includes('email')) {
    tasks.push((async () => {
      if (!profile.email) {
        emailStatus = 'skipped';
        console.log(`[EMAIL] No email address for ${userId}`);
        return;
      }

      const safeBody = String(body || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;padding:20px;border:1px solid #e0e0e0;border-radius:8px;">
          <h2 style="color:#F5A623;">Creator Accountability</h2>
          <p style="font-size:16px;">${safeBody}</p>
          <div style="text-align:center;margin:20px 0;">
            <a href="https://creator-accountability.vercel.app/dashboard"
               style="background:#F5A623;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
              Open Dashboard
            </a>
          </div>
          <p style="font-size:12px;color:#999;text-align:center;">
            You're receiving this because you're part of Creator Accountability.
          </p>
        </div>
      `;

      try {
        const sent = await sendEmail(profile.email, title, html);

        emailStatus = sent ? 'sent' : 'failed';
        emailError = sent ? null : 'Email delivery failed';

      } catch (err) {
        emailStatus = 'failed';
        emailError = err.message || 'Email delivery failed';
      }
    })());
  }

  if (channels.includes('push')) {
    tasks.push((async () => {
      try {
        const result = await sendPushDetailed(
          userId,
          title,
          body,
          data
        );

        pushStatus = result.status;
        pushError = result.error;
      } catch (err) {
        pushStatus = 'failed';
        pushError = err.message || 'Push delivery failed';
      }
    })());
  }

  await Promise.allSettled(tasks);

  const emailSent = emailStatus === 'sent';
  const pushed = pushStatus === 'sent';

  const success = emailSent || pushed;

  if (success) {
    await logNotification(
      userId,
      'system',
      true,
      title,
      null,
      body,
      data.action || null
    );
  }

  console.log(
    `[DELIVERY] ${userId} | Email: ${emailStatus} | Push: ${pushStatus}`
  );

  return {
    success,
    emailSent,
    pushed,
    emailStatus,
    pushStatus,
    emailError,
    pushError
  };
}

// ==========================================
// IN-APP NOTIFICATIONS
// ==========================================

async function notifyInApp(
  userId,
  title,
  body,
  type = 'system',
  action = null,
  metadata = {}
) {
  const { data, error } = await supabase
    .from('notification_log')
    .insert({
      user_id: userId,
      title,
      body,
      type,
      action,
      delivered: true,
      sent_at: new Date().toISOString(),
      metadata
    })
    .select()
    .single();

  if (error) {
    console.error('[IN-APP] Insert failed:', error.message);
    return null;
  }

  if (vapidReady) {
    sendPush(
      userId,
      title,
      body,
      { action, type, ...(metadata || {}) }
    ).catch(err => {
      console.error('[IN-APP] Push failed:', err.message);
    });
  }

  return data;
}

// ==========================================
// ACHIEVEMENTS
// ==========================================

async function awardAchievement(userId, achievementKey) {
  const { data: achievement, error } = await supabase
    .from('achievements')
    .select('id, name, description, icon, points')
    .eq('key', achievementKey)
    .single();

  if (error || !achievement) return null;

  const { error: insertError } = await supabase
    .from('user_achievements')
    .insert({
      user_id: userId,
      achievement_id: achievement.id
    });

  if (insertError) {
    if (insertError.code === '23505') return null;

    console.error('[ACHIEVEMENT] Insert failed:', insertError.message);
    return null;
  }

  await notifyInApp(
    userId,
    `🎖️ Achievement unlocked: ${achievement.name}`,
    achievement.description || `You earned "${achievement.name}".`,
    'achievement',
    'view_achievement',
    { achievement_key: achievementKey }
  );

  return achievement;
}

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  notifyInApp,
  awardAchievement,
  sendPush,
  sendEmail,
  notifyUser,
  getRandomNudgeMessage
};

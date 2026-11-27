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
// CREATOR ACCOUNTABILITY EMAIL DESIGN
// ==========================================

function escapeEmailHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildNotificationEmail(name, title, body, template = '') {
  const templates = {
    daily_reminder: {
      eyebrow: 'DAILY CHECK-IN',
      heading: 'Your next post starts here.',
      label: 'TODAY’S FOCUS',
      note: 'You made a commitment to show up. Give that commitment a place in your day.'
    },
    evening_warning: {
      eyebrow: 'EVENING CHECK-IN',
      heading: 'There is still time to show up.',
      label: 'BEFORE THE DAY ENDS',
      note: 'A small completed action is better than another day of postponing your progress.'
    },
    partner_alert: {
      eyebrow: 'PARTNER ACTIVITY',
      heading: 'Your accountability partner showed up.',
      label: 'YOUR PARTNER UPDATE',
      note: 'Your partner has taken action. Now it is your turn to keep the momentum going.'
    },
    missed_day_followup: {
      eyebrow: 'YOUR ACCOUNTABILITY CHECK-IN',
      heading: 'One missed day does not define your progress.',
      label: 'TIME TO RESET',
      note: 'Do not let one missed day become a reason to abandon the bigger commitment. Reflect, reset and continue.'
    },
    weekly_summary: {
      eyebrow: 'WEEKLY REVIEW',
      heading: 'Take a look at your week.',
      label: 'YOUR WEEK IN REVIEW',
      note: 'Progress becomes easier to understand when you take time to review what actually happened.'
    }
  };

  const design = templates[template] || {
    eyebrow: 'CREATOR ACCOUNTABILITY',
    heading: 'A new update for you.',
    label: 'YOUR NOTIFICATION',
    note: 'Your progress deserves your attention. Open your dashboard to see what comes next.'
  };

  const safeName = escapeEmailHtml(name || 'Creator');
  const safeTitle = escapeEmailHtml(title);
  const safeBody = escapeEmailHtml(body).replace(/\r?\n/g, '<br>');
  const dashboardUrl = 'https://creator-accountability.vercel.app/dashboard';

  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#15191f7ed;font-family:Arial,Helvetica,sans-serif;color:#f4f1e9;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#15191f7ed;">
      <tr>
        <td align="center" style="padding:38px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;">

            <tr>
              <td style="padding:0 8px 26px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="left" style="font-size:19px;font-weight:800;letter-spacing:1.5px;color:#f97316;">
                      CREATOR<span style="color:#f4f1e9;"> ACCOUNTABILITY</span>
                    </td>
                    <td align="right" style="font-size:10px;letter-spacing:2px;color:#777d86;">
                      SHOW UP. BUILD. REPEAT.
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="background-color:#15191f;border:1px solid #292e36;border-radius:14px;overflow:hidden;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">

                  <tr>
                    <td style="padding:34px 30px 30px;background-color:#f97316;border-bottom:1px solid #34302a;">
                      <p style="margin:0 0 18px;font-size:10px;font-weight:bold;letter-spacing:3px;color:#f97316;">
                        ${design.eyebrow}
                      </p>
                      <h1 style="margin:0;color:#ffffff;font-size:32px;line-height:1.2;font-weight:800;">
                        ${design.heading}
                      </h1>
                      <p style="margin:18px 0 0;color:#a8adb5;font-size:14px;line-height:1.8;">
                        Accountability is built through the actions you choose to take, one day at a time.
                      </p>
                    </td>
                  </tr>

                  <tr>
                    <td style="padding:30px;">
                      <p style="margin:0 0 8px;color:#a8adb5;font-size:13px;">
                        Hello ${safeName},
                      </p>

                      <h2 style="margin:0 0 22px;color:#f4f1e9;font-size:21px;line-height:1.4;">
                        ${safeTitle}
                      </h2>

                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#15191f1e6;border:1px solid #34302a;border-radius:10px;">
                        <tr>
                          <td style="padding:22px 22px 20px;">
                            <p style="margin:0 0 13px;color:#f97316;font-size:10px;font-weight:bold;letter-spacing:2px;">
                              ${design.label}
                            </p>
                            <p style="margin:0;color:#e2e4e8;font-size:15px;line-height:1.9;">
                              ${safeBody}
                            </p>
                          </td>
                        </tr>
                      </table>

                      <p style="margin:23px 0 27px;color:#a8adb5;font-size:13px;line-height:1.8;">
                        ${design.note}
                      </p>

                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                        <tr>
                          <td align="center" style="padding:0 0 12px;">
                            <a href="${dashboardUrl}" style="display:inline-block;background-color:#f97316;color:#111111;text-decoration:none;font-size:14px;font-weight:bold;padding:16px 30px;border-radius:6px;">
                              OPEN MY DASHBOARD &nbsp; &#8594;
                            </a>
                          </td>
                        </tr>
                      </table>

                      <p style="margin:15px 0 0;text-align:center;color:#747b85;font-size:11px;line-height:1.7;">
                        Your progress is built by what you do next.
                      </p>
                    </td>
                  </tr>

                </table>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding:27px 15px 0;">
                <p style="margin:0 0 9px;color:#f97316;font-size:11px;font-weight:bold;letter-spacing:2px;">
                  CREATOR ACCOUNTABILITY
                </p>
                <p style="margin:0;color:#737983;font-size:11px;line-height:1.8;">
                  You're receiving this email because you're a member of Creator Accountability.
                  <br>
                  Keep showing up for the work that matters.
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

      const html = buildNotificationEmail(
        profile.name,
        title,
        body,
        options.emailTemplate || data.type || ''
      );

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
  getRandomNudgeMessage,
  buildNotificationEmail
};

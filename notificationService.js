const webpush = require('web-push');
const sgMail = require('@sendgrid/mail');
const supabase = require('./supabase');

// ---- SendGrid setup ----
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ---- VAPID setup (push) ----
try {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@example.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} catch (err) {
  console.warn('⚠️ VAPID setup failed (push disabled):', err.message);
}

// ---- Send push notification ----
async function sendPush(userId, title, body, data = {}) {
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId);

  if (!subs || subs.length === 0) return false;

  const payload = JSON.stringify({ title, body, data, icon: '/icon-192.png' });
  let success = false;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      success = true;
      await logNotification(userId, 'push', true, title);
    } catch (err) {
      if (err.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      }
      await logNotification(userId, 'push', false, title, err.message);
    }
  }
  return success;
}

// ---- Send email with SendGrid ----
async function sendEmail(to, subject, html) {
  try {
    await sgMail.send({
      to,
      from: process.env.SENDER_EMAIL,  // verified sender email in SendGrid
      subject,
      html
    });
    console.log(`✅ Email sent to ${to}`);
    return true;
  } catch (err) {
    console.error('❌ SendGrid error:', err.response?.body || err.message);
    return false;
  }
}

// ---- Combined notify: push first, email fallback ----
async function notifyUser(userId, title, body, data = {}) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('name, email')
    .eq('id', userId)
    .single();

  if (!profile) return;

  // Try push if VAPID keys exist
  let pushed = false;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    pushed = await sendPush(userId, title, body, data);
  } else {
    console.log('Push disabled – VAPID keys not set.');
  }

  // Fallback to email if push failed or no subscription
  if (!pushed && profile.email) {
    await sendEmail(profile.email, title, `
      <div style="font-family: sans-serif; max-width: 600px;">
        <h2 style="color: #F5A623;">🔥 Streak</h2>
        <p>${body}</p>
        <a href="https://creator-accountability.netlify.app/dashboard" 
           style="background: #F5A623; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none;">
          Open Dashboard
        </a>
      </div>
    `);
  }
}

// ---- Log helper ----
async function logNotification(userId, type, delivered, title, error = null) {
  await supabase.from('notification_log').insert({
    user_id: userId,
    type,
    delivered,
    error,
    metadata: { title }
  });
}

module.exports = { sendPush, sendEmail, notifyUser };

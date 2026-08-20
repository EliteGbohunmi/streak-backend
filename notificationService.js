const webpush = require('web-push');
const sgMail = require('@sendgrid/mail');
const supabase = require('./supabase');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

try {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@example.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} catch (err) {
  console.warn('⚠️ VAPID setup failed (push disabled):', err.message);
}

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

async function sendEmail(to, subject, html) {
  try {
    await sgMail.send({
      to,
      from: process.env.SENDER_EMAIL,
      subject,
      html,
      replyTo: process.env.SENDER_EMAIL
    });
    console.log(`✅ Email sent to ${to}`);
    return true;
  } catch (err) {
    console.error('❌ SendGrid error:', err.response?.body || err.message);
    return false;
  }
}

async function notifyUser(userId, title, body, data = {}) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('name, email')
    .eq('id', userId)
    .single();

  if (!profile) return;

  let pushed = false;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    pushed = await sendPush(userId, title, body, data);
  } else {
    console.log('Push disabled – VAPID keys not set.');
  }

  if (!pushed && profile.email) {
    const fallbackHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Nudge from your partner</title>
      </head>
      <body style="font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0;">
        <div style="max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <!-- Header -->
          <div style="background: #F5A623; padding: 24px; text-align: center;">
            <h1 style="color: #fff; margin: 0; font-size: 28px;">🔥 Streak</h1>
            <p style="color: #fff; margin: 4px 0 0; font-size: 14px;">Stay on track</p>
          </div>

          <!-- Body -->
          <div style="padding: 28px 24px;">
            <h2 style="color: #333; font-size: 22px; margin-top: 0;">${title}</h2>
            <p style="font-size: 16px; line-height: 1.6; color: #444;">
              ${body}
            </p>
            <p style="font-size: 16px; line-height: 1.6; color: #444;">
              A quick post now keeps your streak alive. You've got this!
            </p>

            <div style="text-align: center; margin: 30px 0;">
              <a href="https://creator-accountability.netlify.app/dashboard"
                 style="background: #F5A623; color: #000; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
                Post Now
              </a>
            </div>

            <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">

            <!-- Contact / Support -->
            <div style="background: #f9f9f9; padding: 16px; border-radius: 6px;">
              <p style="font-size: 14px; color: #555; margin: 0;">
                <strong>💬 Need help or have feedback?</strong><br>
                We're here for you. Reply to this email or contact us at:
              </p>
              <p style="font-size: 14px; color: #333; margin: 8px 0 0;">
                <a href="mailto:${process.env.SENDER_EMAIL}" style="color: #F5A623; text-decoration: none;">
                  ${process.env.SENDER_EMAIL}
                </a>
              </p>
              <p style="font-size: 13px; color: #777; margin: 6px 0 0;">
                (Developer contact for support and suggestions)
              </p>
            </div>

            <!-- Footer -->
            <div style="margin-top: 24px; text-align: center; font-size: 12px; color: #999;">
              <p style="margin: 4px 0;">
                You're receiving this because you're part of <strong>Creator Accountability</strong>.
              </p>
              <p style="margin: 4px 0;">
                <a href="https://creator-accountability.netlify.app/unsubscribe?email=${profile.email}" style="color: #999; text-decoration: underline;">
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
    await sendEmail(profile.email, title, fallbackHtml);
  }
}

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

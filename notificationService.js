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

// ----- Nudge messages (20 variations) -----
const NUDGE_MESSAGES = [
  "Hey {to}, {from} is checking on you. Have you posted today? Don't break your streak!",
  "Your partner {from} nudged you, {to}. Time to post and keep that streak alive!",
  "{to}, {from} just sent a nudge – you're falling behind! Post something now.",
  "Accountability check! {from} reminded you to post, {to}. Don't let them down.",
  "{to}, your streak is at risk! {from} is counting on you to post today.",
  "Hey {to}, {from} noticed you haven't posted yet. Let's go!",
  "{from} says: '{to}, get that post up! Your streak depends on it.'",
  "{to}, this is your nudge from {from}. One post today keeps the flame alive.",
  "Don't break the chain, {to}. {from} believes in you – post now!",
  "{to}, {from} is waiting for your post. You've got this!",
  "Time to create, {to}. {from} just nudged you to share your work.",
  "{to}, your partner {from} is holding you accountable. Post something!",
  "Nudge from {from}: '{to}, what are you waiting for? Post today!'",
  "{to}, {from} checked in and saw you missed today. Let's fix that!",
  "Hey {to}, {from} is on fire – don't let the streak die. Post now!",
  "{to}, this is your reminder from {from} to post. You'll thank yourself later.",
  "Accountability partner {from} says: '{to}, don't procrastinate – post today!'",
  "{to}, {from} is watching your streak. Keep it going with one post!",
  "Nudge! {from} wants to see your post, {to}. The community is waiting.",
  "{to}, {from} just sent a nudge – it's your turn to create something amazing!"
];

function getRandomNudgeMessage(fromName, toName) {
  const raw = NUDGE_MESSAGES[Math.floor(Math.random() * NUDGE_MESSAGES.length)];
  return raw.replace(/{from}/g, fromName).replace(/{to}/g, toName);
}

// ----- Push / Email / Notification functions -----

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
      <div style="font-family: Arial, sans-serif; max-width: 600px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #F5A623;">🔥 Streak</h2>
        <p style="font-size: 16px;">${body}</p>
        <div style="text-align: center; margin: 20px 0;">
          <a href="https://creator-accountability.netlify.app/dashboard" style="background: #F5A623; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Open Dashboard</a>
        </div>
        <p style="font-size: 12px; color: #999; text-align: center;">You're receiving this because you're part of Creator Accountability.</p>
      </div>
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

module.exports = { sendPush, sendEmail, notifyUser, getRandomNudgeMessage };

const webpush = require('web-push')
const { Resend } = require('resend')
const supabase = require('../supabase')

webpush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
)

const resend = new Resend(process.env.RESEND_API_KEY)

async function sendPush(userId, title, body, data = {}) {
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId)

  if (!subs || subs.length === 0) return false

  const payload = JSON.stringify({ title, body, data, icon: '/icon-192.png' })

  for (const sub of subs) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }, payload)
      await logNotification(userId, 'push', true, title)
    } catch (err) {
      if (err.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
      }
      await logNotification(userId, 'push', false, title, err.message)
    }
  }
  return true
}

async function sendEmail(to, subject, html) {
  try {
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to,
      subject,
      html
    })
    return true
  } catch (err) {
    console.error('Email error:', err)
    return false
  }
}

async function notifyUser(userId, title, body, data = {}) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('name, email')
    .eq('id', userId)
    .single()

  if (!profile) return

  // Try push first
  const pushed = await sendPush(userId, title, body, data)

  // Fall back to email if no push subscription
  if (!pushed && profile.email) {
    await sendEmail(profile.email, title, `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #F5A623;">🔥 Streak</h2>
        <p>${body}</p>
        <a href="https://creator-accountability.netlify.app/dashboard" 
           style="background: #F5A623; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
          Open Dashboard
        </a>
      </div>
    `)
  }
}

async function logNotification(userId, type, delivered, title, error = null) {
  await supabase.from('notification_log').insert({
    user_id: userId, type, delivered, error,
    metadata: { title }
  })
}

module.exports = { sendPush, sendEmail, notifyUser }

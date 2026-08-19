const router = require('express').Router()
const supabase = require('../supabase')
const { notifyUser, sendEmail } = require('../services/notificationService')
const webpush = require('web-push')

// Save push subscription
router.post('/subscribe', async (req, res) => {
  const { user_id, endpoint, p256dh, auth } = req.body
  if (!user_id || !endpoint || !p256dh || !auth) {
    return res.status(400).json({ error: 'Missing fields' })
  }

  await supabase.from('push_subscriptions').upsert({
    user_id, endpoint, p256dh, auth
  }, { onConflict: 'endpoint' })

  res.json({ success: true })
})

// Unsubscribe
router.delete('/subscribe', async (req, res) => {
  const { endpoint } = req.body
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
  res.json({ success: true })
})

// Send nudge to partner – with full error handling and email HTML
router.post('/nudge', async (req, res) => {
  console.log('📨 Nudge endpoint called')
  const { from_user_id, to_user_id } = req.body
  console.log('from:', from_user_id, 'to:', to_user_id)

  try {
    // Fetch both profiles
    const { data: fromProfile, error: fromErr } = await supabase
      .from('profiles').select('name, email').eq('id', from_user_id).single()
    const { data: toProfile, error: toErr } = await supabase
      .from('profiles').select('name, email').eq('id', to_user_id).single()

    if (fromErr || toErr || !fromProfile || !toProfile) {
      console.error('❌ Profile fetch error:', fromErr || toErr)
      return res.status(404).json({ error: 'User(s) not found' })
    }

    // 1. Push notification to partner
    await notifyUser(
      to_user_id,
      '👋 You got nudged!',
      `${fromProfile.name} is checking on you. Have you posted today?`,
      { action: 'checkin' }
    )

    // 2. Email to partner
    if (toProfile.email) {
      await sendEmail(
        toProfile.email,
        '💪 Your accountability partner nudged you!',
        `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #F5A623;">🔥 Streak</h2>
          <p><strong>${fromProfile.name}</strong> just nudged you to post today.</p>
          <p>Don't break your streak – post something now!</p>
          <a href="https://creator-accountability.netlify.app/dashboard" 
             style="background: #F5A623; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
            Open Dashboard
          </a>
        </div>
        `
      )
    } else {
      console.warn('⚠️ Partner has no email, skipping')
    }

    // 3. Confirmation email to the person who nudged
    if (fromProfile.email) {
      await sendEmail(
        fromProfile.email,
        '📬 Nudge sent!',
        `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #F5A623;">🔥 Streak</h2>
          <p>You just nudged <strong>${toProfile.name}</strong>.</p>
          <p>We'll keep you both accountable. Keep up the great work!</p>
          <a href="https://creator-accountability.netlify.app/dashboard" 
             style="background: #F5A623; color: #000; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
            Go to Dashboard
          </a>
        </div>
        `
      )
    }

    res.json({ success: true, message: 'Nudge sent via push and email to both partners.' })
  } catch (err) {
    console.error('💥 Nudge error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Get VAPID public key
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY })
})

module.exports = router

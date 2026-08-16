const router = require('express').Router()
const supabase = require('../supabase')
const { notifyUser } = require('../services/notificationService')
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

// Send nudge to partner
router.post('/nudge', async (req, res) => {
  const { from_user_id, to_user_id } = req.body

  const { data: profile } = await supabase
    .from('profiles').select('name').eq('id', from_user_id).single()

  await notifyUser(
    to_user_id,
    '👋 You got nudged!',
    `${profile?.name || 'Your partner'} is checking on you. Have you posted today?`,
    { action: 'checkin' }
  )

  res.json({ success: true })
})

// Get VAPID public key
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY })
})

module.exports = router

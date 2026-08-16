const router = require('express').Router()
const supabase = require('../supabase')
const { notifyUser } = require('../services/notificationService')

// Called after check-in to notify partner
router.post('/checkin-notify', async (req, res) => {
  const { user_id } = req.body

  const { data: profile } = await supabase
    .from('profiles').select('name').eq('id', user_id).single()

  // Find partner
  const { data: p1 } = await supabase
    .from('accountability_partners')
    .select('user2_id').eq('user1_id', user_id).single()
  const { data: p2 } = await supabase
    .from('accountability_partners')
    .select('user1_id').eq('user2_id', user_id).single()

  const partnerId = p1?.user2_id || p2?.user1_id
  if (partnerId) {
    await notifyUser(
      partnerId,
      '✅ Partner posted!',
      `${profile?.name || 'Your partner'} just checked in. Your turn!`,
      { action: 'checkin' }
    )
  }

  res.json({ success: true })
})

module.exports = router

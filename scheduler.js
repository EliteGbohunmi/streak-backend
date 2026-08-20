const cron = require('node-cron');
const supabase = require('./supabase');
const { notifyUser, sendEmail } = require('./notificationService');

function startScheduler() {
  console.log('🕒 Scheduler started.');

  // ---- Daily reminder at user's chosen time (every 15 minutes) ----
  cron.schedule('*/15 * * * *', async () => {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const today = now.toISOString().split('T')[0];

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, name, reminder_hour, reminder_minute')
        .not('reminder_hour', 'is', null);

      for (const profile of profiles || []) {
        if (
          profile.reminder_hour === currentHour &&
          Math.abs(profile.reminder_minute - currentMinute) <= 7
        ) {
          const { data: streak } = await supabase
            .from('streaks')
            .select('last_checked_in')
            .eq('user_id', profile.id)
            .single();

          if (streak?.last_checked_in !== today) {
            await notifyUser(
              profile.id,
              '🔥 Time to post!',
              `${profile.name || 'Creator'}, you haven't posted today. Don't break your streak!`,
              { action: 'checkin' }
            );
          }
        }
      }
    } catch (err) {
      console.error('Reminder job error:', err);
    }
  });

  // ---- 8pm streak warning ----
  cron.schedule('0 20 * * *', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data: streaks } = await supabase
        .from('streaks')
        .select('user_id, current_streak, last_checked_in, profiles(name)')
        .gt('current_streak', 0)
        .neq('last_checked_in', today);

      for (const s of streaks || []) {
        await notifyUser(
          s.user_id,
          '⏰ 4 hours left!',
          `Your ${s.current_streak}-day streak is at risk. Post something tonight to keep it alive.`,
          { action: 'checkin' }
        );
      }
    } catch (err) {
      console.error('Streak warning job error:', err);
    }
  });

  // ---- 9am partner alert ----
  cron.schedule('0 9 * * *', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data: partners } = await supabase
        .from('accountability_partners')
        .select('user1_id, user2_id, profiles!accountability_partners_user1_id_fkey(name), profiles!accountability_partners_user2_id_fkey(name)');

      for (const pair of partners || []) {
        const { data: s1 } = await supabase
          .from('streaks')
          .select('last_checked_in')
          .eq('user_id', pair.user1_id)
          .single();
        const { data: s2 } = await supabase
          .from('streaks')
          .select('last_checked_in')
          .eq('user_id', pair.user2_id)
          .single();

        const user1Posted = s1?.last_checked_in === today;
        const user2Posted = s2?.last_checked_in === today;

        if (user1Posted && !user2Posted) {
          await notifyUser(
            pair.user2_id,
            '👀 Your partner posted!',
            `${pair.profiles?.['profiles!accountability_partners_user1_id_fkey']?.name || 'Your partner'} already posted today. Don't let them down!`,
            { action: 'checkin' }
          );
        } else if (user2Posted && !user1Posted) {
          await notifyUser(
            pair.user1_id,
            '👀 Your partner posted!',
            `${pair.profiles?.['profiles!accountability_partners_user2_id_fkey']?.name || 'Your partner'} already posted today. Don't let them down!`,
            { action: 'checkin' }
          );
        }
      }
    } catch (err) {
      console.error('Partner alert job error:', err);
    }
  });

  // ---- 11pm missed day follow-up ----
  cron.schedule('0 23 * * *', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data: streaks } = await supabase
        .from('streaks')
        .select('user_id, current_streak, profiles(name)')
        .gt('current_streak', 2)
        .neq('last_checked_in', today);

      for (const s of streaks || []) {
        await notifyUser(
          s.user_id,
          '💔 You missed today',
          `It happens. Tomorrow is a fresh start. What got in the way today?`,
          { action: 'reflection' }
        );
      }
    } catch (err) {
      console.error('Missed day job error:', err);
    }
  });

  // ---- Sunday 9am weekly summary ----
  cron.schedule('0 9 * * 0', async () => {
    try {
      const today = new Date();
      const weekAgo = new Date(today);
      weekAgo.setDate(today.getDate() - 7);
      const weekAgoStr = weekAgo.toISOString().split('T')[0];

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, name, email');

      for (const profile of profiles || []) {
        const { data: tasks } = await supabase
          .from('tasks')
          .select('completed')
          .eq('user_id', profile.id)
          .gte('date', weekAgoStr);

        const { data: streak } = await supabase
          .from('streaks')
          .select('current_streak, best_streak')
          .eq('user_id', profile.id)
          .single();

        const total = tasks?.length || 0;
        const done = tasks?.filter(t => t.completed).length || 0;
        const rate = total > 0 ? Math.round((done / total) * 100) : 0;

        await notifyUser(
          profile.id,
          '📊 Your Weekly Summary',
          `${done} posts this week · ${rate}% completion · ${streak?.current_streak || 0} day streak. ${rate >= 80 ? 'Incredible week!' : rate >= 50 ? 'Solid effort. Keep pushing.' : 'New week, fresh start.'}`,
          { action: 'analytics' }
        );
      }
    } catch (err) {
      console.error('Weekly summary job error:', err);
    }
  });

  console.log('✅ All cron jobs scheduled.');
}

module.exports = { startScheduler };

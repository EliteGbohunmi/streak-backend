const supabase = require('./supabase');
const { notifyUser } = require('./notificationService');

const TIME_ZONE = 'Africa/Lagos';

function getLagosTime() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const result = {};
  for (const part of parts) {
    result[part.type] = part.value;
  }

  return {
    date: `${result.year}-${result.month}-${result.day}`,
    hour: Number(result.hour),
    minute: Number(result.minute),
    weekday: result.weekday,
    minutes: Number(result.hour) * 60 + Number(result.minute)
  };
}

function dateDaysAgo(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function checkedInToday(value, today) {
  return String(value || '').slice(0, 10) === today;
}

async function claimNotification(jobKey, userId, today) {
  const { error } = await supabase
    .from('scheduled_notification_runs')
    .insert({
      job_key: jobKey,
      recipient_id: String(userId),
      scheduled_for: today,
      status: 'processing'
    });

  if (error?.code === '23505') {
    return false;
  }

  if (error) {
    throw error;
  }

  return true;
}

async function sendOnce(jobKey, userId, today, title, body, data = {}) {
  let claimed = false;

  try {
    claimed = await claimNotification(jobKey, userId, today);

    if (!claimed) {
      return;
    }

    const result = await notifyUser(
      userId,
      title,
      body,
      data,
      { forceEmail: true }
    );

    if (!result?.success) {
      throw new Error(
        `Notification delivery failed for user ${userId}`
      );
    }

    const { error } = await supabase
      .from('scheduled_notification_runs')
      .update({
        status: 'sent',
        updated_at: new Date().toISOString(),
        error_message: null
      })
      .eq('job_key', jobKey)
      .eq('recipient_id', String(userId))
      .eq('scheduled_for', today);

    if (error) {
      console.error('Could not update notification status:', error.message);
    }

    console.log(`Sent ${jobKey} to ${userId}`);
  } catch (error) {
    console.error(`${jobKey} failed for ${userId}:`, error.message);

    if (claimed) {
      await supabase
        .from('scheduled_notification_runs')
        .delete()
        .eq('job_key', jobKey)
        .eq('recipient_id', String(userId))
        .eq('scheduled_for', today);
    }
  }
}

async function getRows(table, columns, configure = q => q) {
  const { data, error } = await configure(
    supabase.from(table).select(columns)
  );

  if (error) {
    throw error;
  }

  return data || [];
}

async function dailyReminders(now) {
  const profiles = await getRows(
    'profiles',
    'id, name, email, reminder_hour, reminder_minute',
    q => q.not('reminder_hour', 'is', null)
  );

  for (const profile of profiles) {
    if (!profile.email || profile.reminder_minute == null) continue;

    const target =
      Number(profile.reminder_hour) * 60 +
      Number(profile.reminder_minute);

    const age = now.minutes - target;

    // Allow a 25-minute delivery window for delayed workflow runs.
    if (age < 0 || age > 25) continue;

    const { data: streak, error } = await supabase
      .from('streaks')
      .select('last_checked_in')
      .eq('user_id', profile.id)
      .maybeSingle();

    if (error) throw error;

    if (checkedInToday(streak?.last_checked_in, now.date)) continue;

    await sendOnce(
      'daily_reminder',
      profile.id,
      now.date,
      '🔥 Time to post!',
      `${profile.name || 'Creator'}, you haven't posted today. Don't break your streak!`,
      { action: 'checkin' }
    );
  }
}

async function eveningWarnings(now) {
  if (now.hour !== 20) return;

  const streaks = await getRows(
    'streaks',
    'user_id, current_streak, last_checked_in',
    q => q.gt('current_streak', 0)
  );

  for (const streak of streaks) {
    if (checkedInToday(streak.last_checked_in, now.date)) continue;

    await sendOnce(
      'evening_warning',
      streak.user_id,
      now.date,
      '⏰ Time is running out!',
      `Your ${streak.current_streak}-day streak is at risk. Post something tonight to keep it alive.`,
      { action: 'checkin' }
    );
  }
}

async function partnerAlerts(now) {
  if (now.hour !== 9) return;

  const pairs = await getRows(
    'accountability_partners',
    'user1_id, user2_id'
  );

  for (const pair of pairs) {
    const [a, b] = await Promise.all([
      supabase
        .from('streaks')
        .select('last_checked_in')
        .eq('user_id', pair.user1_id)
        .maybeSingle(),

      supabase
        .from('streaks')
        .select('last_checked_in')
        .eq('user_id', pair.user2_id)
        .maybeSingle()
    ]);

    if (a.error) throw a.error;
    if (b.error) throw b.error;

    const user1Posted = checkedInToday(
      a.data?.last_checked_in, now.date
    );

    const user2Posted = checkedInToday(
      b.data?.last_checked_in, now.date
    );

    if (user1Posted === user2Posted) continue;

    const postedUserId = user1Posted
      ? pair.user1_id
      : pair.user2_id;

    const unpostedUserId = user1Posted
      ? pair.user2_id
      : pair.user1_id;

    const { data: postedProfile, error } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', postedUserId)
      .maybeSingle();

    if (error) throw error;

    await sendOnce(
      'partner_alert',
      unpostedUserId,
      now.date,
      '👀 Your partner posted!',
      `${postedProfile?.name || 'Your partner'} already posted today. Don't let them down!`,
      { action: 'checkin' }
    );
  }
}

async function missedDayFollowups(now) {
  if (now.hour !== 23) return;

  const streaks = await getRows(
    'streaks',
    'user_id, current_streak, last_checked_in',
    q => q.gt('current_streak', 2)
  );

  for (const streak of streaks) {
    if (checkedInToday(streak.last_checked_in, now.date)) continue;

    await sendOnce(
      'missed_day_followup',
      streak.user_id,
      now.date,
      '💔 You missed today',
      'It happens. Tomorrow is a fresh start. What got in the way today?',
      { action: 'reflection' }
    );
  }
}

async function weeklySummaries(now) {
  if (now.weekday !== 'Sun' || now.hour !== 9) return;

  const profiles = await getRows(
    'profiles',
    'id, name, email'
  );

  const weekAgo = dateDaysAgo(now.date, 7);

  for (const profile of profiles) {
    if (!profile.email) continue;

    const { data: tasks, error: taskError } = await supabase
      .from('tasks')
      .select('completed')
      .eq('user_id', profile.id)
      .gte('date', weekAgo)
      .lte('date', now.date);

    if (taskError) throw taskError;

    const { data: streak, error: streakError } = await supabase
      .from('streaks')
      .select('current_streak, best_streak')
      .eq('user_id', profile.id)
      .maybeSingle();

    if (streakError) throw streakError;

    const total = tasks?.length || 0;
    const done = tasks?.filter(task => task.completed).length || 0;
    const rate = total ? Math.round(done / total * 100) : 0;

    const message =
      `${done} posts this week · ${rate}% completion · ` +
      `${streak?.current_streak || 0} day streak. ` +
      (rate >= 80
        ? 'Incredible week!'
        : rate >= 50
          ? 'Solid effort. Keep pushing.'
          : 'New week, fresh start.');

    await sendOnce(
      'weekly_summary',
      profile.id,
      now.date,
      '📊 Your Weekly Summary',
      message,
      { action: 'analytics' }
    );
  }
}

async function main() {
  const now = getLagosTime();

  console.log(
    `Scheduled notification run: ${now.date} ` +
    `${String(now.hour).padStart(2, '0')}:` +
    `${String(now.minute).padStart(2, '0')} WAT`
  );

  await dailyReminders(now);
  await eveningWarnings(now);
  await partnerAlerts(now);
  await missedDayFollowups(now);
  await weeklySummaries(now);

  console.log('Scheduled notification run finished.');
}

main().catch(error => {
  console.error('Scheduled runner failed:', error);
  process.exitCode = 1;
});

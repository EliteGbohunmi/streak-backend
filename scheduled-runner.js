const supabase = require('./supabase');
const { notifyUser } = require('./notificationService');

const TIME_ZONE = 'Africa/Lagos';
const DEFAULT_REMINDER_HOUR = 8;
const DEFAULT_REMINDER_MINUTE = 0;

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
      console.log(
        `[SKIP] ${jobKey}: notification already recorded for user ${userId}`
      );
      return;
    }

    console.log(`[ATTEMPT] ${jobKey} for user ${userId}`);

    const result = await notifyUser(
      userId,
      title,
      body,
      data,
      { forceEmail: true }
    );

    if (!result?.success) {
      throw new Error(
        `Notification delivery failed for user ${userId}. ` +
        `Reason: ${result?.reason || 'delivery unsuccessful'}`
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
      console.error(
        '[DB ERROR] Could not update notification status:',
        error.message
      );
    }

    console.log(
      `[SENT] ${jobKey} to user ${userId}. ` +
      `Email: ${result.emailSent ? 'success' : 'not confirmed'}; ` +
      `Push: ${result.pushed ? 'success' : 'not confirmed'}`
    );
  } catch (error) {
    console.error(`[FAILED] ${jobKey} for user ${userId}:`, error.message);

    if (claimed) {
      const { error: deleteError } = await supabase
        .from('scheduled_notification_runs')
        .delete()
        .eq('job_key', jobKey)
        .eq('recipient_id', String(userId))
        .eq('scheduled_for', today);

      if (deleteError) {
        console.error(
          '[DB ERROR] Could not release notification claim:',
          deleteError.message
        );
      }
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
  console.log('[DAILY] Checking profiles for reminders...');

  const profiles = await getRows(
    'profiles',
    'id, name, email, reminder_hour, reminder_minute'
  );

  let missingEmail = 0;
  let outsideWindow = 0;
  let alreadyCheckedIn = 0;
  let eligible = 0;
  let defaultedReminders = 0;

  console.log(`[DAILY] Profiles found: ${profiles.length}`);

  for (const profile of profiles) {
    if (!profile.email) {
      missingEmail++;
      continue;
    }

    const usesDefault =
      profile.reminder_hour == null ||
      profile.reminder_minute == null;

    const reminderHour =
      profile.reminder_hour == null
        ? DEFAULT_REMINDER_HOUR
        : Number(profile.reminder_hour);

    const reminderMinute =
      profile.reminder_minute == null
        ? DEFAULT_REMINDER_MINUTE
        : Number(profile.reminder_minute);

    if (
      !Number.isInteger(reminderHour) ||
      reminderHour < 0 ||
      reminderHour > 23 ||
      !Number.isInteger(reminderMinute) ||
      reminderMinute < 0 ||
      reminderMinute > 59
    ) {
      console.error(
        `[SKIP] Invalid reminder settings for user ${profile.id}`
      );
      continue;
    }

    if (usesDefault) {
      defaultedReminders++;
    }

    const target = reminderHour * 60 + reminderMinute;
    const age = now.minutes - target;

    // Allow a 25-minute delivery window for delayed workflow runs.
    if (age < 0 || age > 25) {
      outsideWindow++;
      continue;
    }

    const { data: streak, error } = await supabase
      .from('streaks')
      .select('last_checked_in')
      .eq('user_id', profile.id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (checkedInToday(streak?.last_checked_in, now.date)) {
      alreadyCheckedIn++;
      continue;
    }

    eligible++;

    await sendOnce(
      'daily_reminder',
      profile.id,
      now.date,
      '🔥 Time to post!',
      `${profile.name || 'Creator'}, you haven't posted today. Don't break your streak!`,
      { action: 'checkin' }
    );
  }

  console.log(
    `[DAILY SUMMARY] Eligible: ${eligible}; ` +
    `outside reminder window: ${outsideWindow}; ` +
    `missing email: ${missingEmail}; ` +
    `already checked in: ${alreadyCheckedIn}; ` +
    `using default 8:00 AM: ${defaultedReminders}`
  );
}

async function eveningWarnings(now) {
  if (now.hour !== 20) {
    console.log(
      `[SKIP] Evening warnings only run at 20:00 WAT. ` +
      `Current hour: ${now.hour}.`
    );
    return;
  }

  const streaks = await getRows(
    'streaks',
    'user_id, current_streak, last_checked_in',
    q => q.gt('current_streak', 0)
  );

  console.log(`[EVENING] Active streaks found: ${streaks.length}`);

  for (const streak of streaks) {
    if (checkedInToday(streak.last_checked_in, now.date)) {
      console.log(
        `[SKIP] Evening warning: user ${streak.user_id} already checked in.`
      );
      continue;
    }

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
  if (now.hour !== 9) {
    console.log(
      `[SKIP] Partner alerts only run during the 09:00 hour WAT. ` +
      `Current hour: ${now.hour}.`
    );
    return;
  }

  const pairs = await getRows(
    'accountability_partners',
    'user1_id, user2_id'
  );

  console.log(`[PARTNERS] Accountability pairs found: ${pairs.length}`);

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
      a.data?.last_checked_in,
      now.date
    );

    const user2Posted = checkedInToday(
      b.data?.last_checked_in,
      now.date
    );

    if (user1Posted === user2Posted) {
      console.log(
        `[SKIP] Partner pair ${pair.user1_id}/${pair.user2_id}: ` +
        'both posted or neither posted.'
      );
      continue;
    }

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
  if (now.hour !== 23) {
    console.log(
      `[SKIP] Missed-day follow-ups only run during the 23:00 hour WAT. ` +
      `Current hour: ${now.hour}.`
    );
    return;
  }

  const streaks = await getRows(
    'streaks',
    'user_id, current_streak, last_checked_in',
    q => q.gt('current_streak', 2)
  );

  console.log(`[MISSED DAY] Streaks over two days found: ${streaks.length}`);

  for (const streak of streaks) {
    if (checkedInToday(streak.last_checked_in, now.date)) {
      console.log(
        `[SKIP] Missed-day follow-up: user ${streak.user_id} checked in today.`
      );
      continue;
    }

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
  if (now.weekday !== 'Sun' || now.hour !== 9) {
    console.log(
      `[SKIP] Weekly summaries run Sunday during the 09:00 hour WAT. ` +
      `Current day/hour: ${now.weekday} ${now.hour}.`
    );
    return;
  }

  const profiles = await getRows(
    'profiles',
    'id, name, email'
  );

  console.log(`[WEEKLY] Profiles found: ${profiles.length}`);

  const weekAgo = dateDaysAgo(now.date, 7);

  for (const profile of profiles) {
    if (!profile.email) {
      console.log(
        `[SKIP] Weekly summary: profile ${profile.id} has no email.`
      );
      continue;
    }

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

  const jobs = [
    ['Daily reminders', dailyReminders],
    ['Evening warnings', eveningWarnings],
    ['Partner alerts', partnerAlerts],
    ['Missed-day follow-ups', missedDayFollowups],
    ['Weekly summaries', weeklySummaries]
  ];

  for (const [name, job] of jobs) {
    console.log(`[START] ${name}`);

    try {
      await job(now);
      console.log(`[DONE] ${name}`);
    } catch (error) {
      console.error(`[FAILED] ${name}:`, error.message);
      throw error;
    }
  }

  console.log('Scheduled notification run finished.');
}

main().catch(error => {
  console.error('Scheduled runner failed:', error);
  process.exitCode = 1;
});

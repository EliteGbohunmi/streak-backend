const supabase = require('./supabase');
const { notifyUser } = require('./notificationService');
const { pickMessage, buildIndexUpdate } = require('./notificationTemplates');

const TIME_ZONE = 'Africa/Lagos';
const DEFAULT_REMINDER_HOUR = 8;
const DEFAULT_REMINDER_MINUTE = 0;
const PROCESSING_TIMEOUT_MINUTES = 30;

async function resolveMessage(jobType, profile, context) {
  const result = pickMessage(jobType, profile, context);
  if (!result) return null;

  await supabase
    .from('profiles')
    .update({
      last_message_index: buildIndexUpdate(
        profile,
        jobType,
        result.nextIndex
      )
    })
    .eq('id', profile.id);

  return result.text;
}

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
  for (const part of parts) result[part.type] = part.value;

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

async function getRows(table, columns, configure = q => q) {
  const { data, error } = await configure(
    supabase.from(table).select(columns)
  );

  if (error) throw error;
  return data || [];
}

function isTerminal(status) {
  return status === 'sent' || status === 'skipped';
}

function minutesSince(value) {
  if (!value) return Infinity;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return Infinity;
  return (Date.now() - timestamp) / 60000;
}

async function getOrCreateRun(jobKey, userId, today) {
  const query = () => supabase
    .from('scheduled_notification_runs')
    .select('*')
    .eq('job_key', jobKey)
    .eq('recipient_id', String(userId))
    .eq('scheduled_for', today)
    .maybeSingle();

  let { data: run, error } = await query();
  if (error) throw error;

  if (run) return run;

  const { data: inserted, error: insertError } = await supabase
    .from('scheduled_notification_runs')
    .insert({
      job_key: jobKey,
      recipient_id: String(userId),
      scheduled_for: today,
      status: 'pending',
      email_status: 'pending',
      push_status: 'pending',
      updated_at: new Date().toISOString()
    })
    .select('*')
    .single();

  if (!insertError) return inserted;

  // Another runner may have created this record at the same time.
  if (insertError.code === '23505') {
    const existing = await query();
    if (existing.error) throw existing.error;
    if (existing.data) return existing.data;
  }

  throw insertError;
}

async function sendOnce(jobKey, userId, today, title, body, data = {}) {
  let run;

  try {
    run = await getOrCreateRun(jobKey, userId, today);

    const emailStatus = run.email_status || 'pending';
    const pushStatus = run.push_status || 'pending';

    if (isTerminal(emailStatus) && isTerminal(pushStatus)) {
      console.log(`[SKIP] ${jobKey}: both channels already processed for ${userId}`);
      return;
    }

    if (
      run.status === 'processing' &&
      minutesSince(run.updated_at) < PROCESSING_TIMEOUT_MINUTES
    ) {
      console.log(`[SKIP] ${jobKey}: another runner may be processing ${userId}`);
      return;
    }

    const channels = [];

    if (!isTerminal(emailStatus)) channels.push('email');
    if (!isTerminal(pushStatus)) channels.push('push');

    if (!channels.length) return;

    const startedAt = new Date().toISOString();

    const { error: claimError } = await supabase
      .from('scheduled_notification_runs')
      .update({
        status: 'processing',
        updated_at: startedAt
      })
      .eq('id', run.id);

    if (claimError) throw claimError;

    console.log(
      `[ATTEMPT] ${jobKey} for ${userId}. Channels: ${channels.join(', ')}`
    );

    let result;

    try {
      result = await notifyUser(
        userId,
        title,
        body,
        data,
        { channels, emailTemplate: jobKey }
      );
    } catch (deliveryError) {
      const message = deliveryError.message || 'Unknown delivery error';

      const updates = {
        status: 'failed',
        updated_at: new Date().toISOString(),
        error_message: message
      };

      if (channels.includes('email')) {
        updates.email_status = 'failed';
        updates.email_error = message;
      }

      if (channels.includes('push')) {
        updates.push_status = 'failed';
        updates.push_error = message;
      }

      const { error: updateError } = await supabase
        .from('scheduled_notification_runs')
        .update(updates)
        .eq('id', run.id);

      if (updateError) {
        console.error('[DB ERROR] Could not save failed delivery:', updateError.message);
      }

      console.error(`[FAILED] ${jobKey} for ${userId}: ${message}`);
      return;
    }

    // The notification service reports each channel independently.
    const emailResult = result?.emailStatus ||
      (result?.emailSent ? 'sent' : 'failed');

    const pushResult = result?.pushStatus ||
      (result?.pushed ? 'sent' : 'failed');

    const updates = {
      updated_at: new Date().toISOString()
    };

    if (channels.includes('email')) {
      updates.email_status = emailResult;
      updates.email_error = emailResult === 'failed'
        ? (result?.emailError || 'Email delivery was unsuccessful')
        : null;
    }

    if (channels.includes('push')) {
      updates.push_status = pushResult;
      updates.push_error = pushResult === 'failed'
        ? (result?.pushError || 'Push delivery was unsuccessful')
        : null;
    }

    const finalEmailStatus = channels.includes('email')
      ? emailResult
      : emailStatus;

    const finalPushStatus = channels.includes('push')
      ? pushResult
      : pushStatus;

    const allFinished =
      isTerminal(finalEmailStatus) &&
      isTerminal(finalPushStatus);

    const anyFailed =
      finalEmailStatus === 'failed' ||
      finalPushStatus === 'failed';

    updates.status = allFinished
      ? 'sent'
      : anyFailed
        ? 'failed'
        : 'processing';

    updates.error_message = [
      updates.email_error || run.email_error,
      updates.push_error || run.push_error
    ].filter(Boolean).join(' | ') || null;

    const { error: updateError } = await supabase
      .from('scheduled_notification_runs')
      .update(updates)
      .eq('id', run.id);

    if (updateError) {
      console.error('[DB ERROR] Could not save delivery results:', updateError.message);
      return;
    }

    console.log(
      `[RESULT] ${jobKey} for ${userId}: ` +
      `Email=${finalEmailStatus}, Push=${finalPushStatus}`
    );
  } catch (error) {
    console.error(`[FAILED] ${jobKey} for ${userId}:`, error.message);
  }
}

async function dailyReminders(now) {
  console.log('[DAILY] Checking profiles for reminders...');

  const profiles = await getRows(
    'profiles',
    'id, name, email, reminder_hour, reminder_minute, last_message_index, use_emojis'
  );

  let outsideWindow = 0;
  let alreadyCheckedIn = 0;
  let eligible = 0;
  let defaultedReminders = 0;

  console.log(`[DAILY] Profiles found: ${profiles.length}`);

  for (const profile of profiles) {
    const usesDefault =
      profile.reminder_hour == null ||
      profile.reminder_minute == null;

    const reminderHour = profile.reminder_hour == null
      ? DEFAULT_REMINDER_HOUR
      : Number(profile.reminder_hour);

    const reminderMinute = profile.reminder_minute == null
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
      console.error(`[SKIP] Invalid reminder settings for ${profile.id}`);
      continue;
    }

    if (usesDefault) defaultedReminders++;

    const target = reminderHour * 60 + reminderMinute;
    const age = now.minutes - target;

    // Catch up if the scheduled time has passed today.
    // The database record prevents a second reminder that same day.
    if (age < 0 || age >= 24 * 60) {
      outsideWindow++;
      continue;
    }

    const { data: streak, error } = await supabase
      .from('streaks')
      .select('last_checked_in')
      .eq('user_id', profile.id)
      .maybeSingle();

    if (error) throw error;

    if (checkedInToday(streak?.last_checked_in, now.date)) {
      alreadyCheckedIn++;
      continue;
    }

    eligible++;

    const msg = await resolveMessage(
      'daily_reminder',
      profile,
      { streak: 0 }
    );

    if (msg) {
      await sendOnce(
        'daily_reminder',
        profile.id,
        now.date,
        'Time to post',
        msg,
        { action: 'checkin' }
      );
    }
  }

  console.log(
    `[DAILY SUMMARY] Eligible: ${eligible}; ` +
    `not due yet: ${outsideWindow}; ` +
    `already checked in: ${alreadyCheckedIn}; ` +
    `using default 8:00 AM: ${defaultedReminders}`
  );
}

async function eveningWarnings(now) {
  if (now.hour !== 20) {
    console.log(`[SKIP] Evening warnings run at 20:00 WAT. Current hour: ${now.hour}`);
    return;
  }

  const streaks = await getRows(
    'streaks',
    'user_id, current_streak, last_checked_in',
    q => q.gt('current_streak', 0)
  );

  console.log(`[EVENING] Active streaks found: ${streaks.length}`);

  for (const streak of streaks) {
    if (checkedInToday(streak.last_checked_in, now.date)) continue;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, name, email, last_message_index, use_emojis')
      .eq('id', streak.user_id)
      .maybeSingle();

    if (error) throw error;
    if (!profile) continue;

    const msg = await resolveMessage(
      'evening_warning',
      profile,
      { streak: streak.current_streak }
    );

    if (msg) {
      await sendOnce(
        'evening_warning',
        streak.user_id,
        now.date,
        'Time is running out',
        msg,
        { action: 'checkin' }
      );
    }
  }
}

async function partnerAlerts(now) {
  if (now.hour !== 9) {
    console.log(`[SKIP] Partner alerts run during the 09:00 hour WAT. Current hour: ${now.hour}`);
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

    const user1Posted = checkedInToday(a.data?.last_checked_in, now.date);
    const user2Posted = checkedInToday(b.data?.last_checked_in, now.date);

    if (user1Posted === user2Posted) continue;

    const postedUserId = user1Posted ? pair.user1_id : pair.user2_id;
    const unpostedUserId = user1Posted ? pair.user2_id : pair.user1_id;

    const { data: postedProfile, error: postedError } = await supabase
      .from('profiles')
      .select('name')
      .eq('id', postedUserId)
      .maybeSingle();

    if (postedError) throw postedError;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, name, email, last_message_index, use_emojis')
      .eq('id', unpostedUserId)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile) continue;

    const msg = await resolveMessage(
      'partner_alert',
      profile,
      { partner: postedProfile?.name }
    );

    if (msg) {
      await sendOnce(
        'partner_alert',
        unpostedUserId,
        now.date,
        'Your partner posted',
        msg,
        { action: 'checkin' }
      );
    }
  }
}

async function missedDayFollowups(now) {
  if (now.hour !== 23) {
    console.log(`[SKIP] Missed-day follow-ups run during the 23:00 hour WAT. Current hour: ${now.hour}`);
    return;
  }

  const streaks = await getRows(
    'streaks',
    'user_id, current_streak, last_checked_in',
    q => q.gt('current_streak', 2)
  );

  console.log(`[MISSED DAY] Streaks over two days found: ${streaks.length}`);

  for (const streak of streaks) {
    if (checkedInToday(streak.last_checked_in, now.date)) continue;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, name, email, last_message_index, use_emojis')
      .eq('id', streak.user_id)
      .maybeSingle();

    if (error) throw error;
    if (!profile) continue;

    const msg = await resolveMessage(
      'missed_day_followup',
      profile,
      {}
    );

    if (msg) {
      await sendOnce(
        'missed_day_followup',
        streak.user_id,
        now.date,
        'You missed today',
        msg,
        { action: 'reflection' }
      );
    }
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
    'id, name, email, last_message_index, use_emojis'
  );

  console.log(`[WEEKLY] Profiles found: ${profiles.length}`);

  const weekAgo = dateDaysAgo(now.date, 7);

  for (const profile of profiles) {
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
    const rate = total ? Math.round((done / total) * 100) : 0;

    const msg = await resolveMessage(
      'weekly_summary',
      profile,
      {
        posts: done,
        rate,
        streak: streak?.current_streak || 0
      }
    );

    const message = msg || `${done} posts this week. ${rate}% completion.`;

    await sendOnce(
      'weekly_summary',
      profile.id,
      now.date,
      'Your Weekly Summary',
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

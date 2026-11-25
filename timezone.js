function getUserTimezone(profile) {
  return profile?.timezone || 'Africa/Lagos'
}

function getTimeInZone(timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(new Date())

  const r = {}
  for (const p of parts) r[p.type] = p.value

  return {
    date: `${r.year}-${r.month}-${r.day}`,
    hour: Number(r.hour),
    minute: Number(r.minute),
    weekday: r.weekday,
    minutes: Number(r.hour) * 60 + Number(r.minute)
  }
}

module.exports = { getUserTimezone, getTimeInZone }

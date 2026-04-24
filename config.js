// ══════════════════════════════════════════════════
//   ⚙️  CONFIGURATION — Edit these values
// ══════════════════════════════════════════════════

module.exports = {

  // 📌 Exact name of the WhatsApp group to monitor
  GROUP_NAME: 'Employees Zone of NCPL',

  // 📞 Phone numbers of Training Leads (WITHOUT + sign)
  // They will receive inactivity alerts
  // Example: ['919876543210', '918765432109']
  TL_NUMBERS: ['917286822658'],

  // 🚫 Numbers to SKIP (admins, bot accounts, etc.)
  SKIP_NUMBERS: [],

  // ⏰ When to run the daily check (cron format)
  // '0 18 * * 1-5' = 6:00 PM, Monday to Friday
  // '0 20 * * *'   = 8:00 PM every day
  DAILY_CHECK_TIME: '0 18 * * 1-5',

  // 🌍 Your timezone
  TIMEZONE: 'Asia/Kolkata',

};

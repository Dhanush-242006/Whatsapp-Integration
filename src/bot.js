const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const config = require('../config');

// ─── Activity Store ───────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, '../data/activity.json');

function loadActivity() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function saveActivity(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0]; // "2025-04-24"
}

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with your WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('✅ WhatsApp Bot is ready and monitoring!');
  console.log(`📌 Watching group: "${config.GROUP_NAME}"`);
  console.log(`⏰ Daily check at: ${config.DAILY_CHECK_TIME}`);
  startDailyCheck();
  await saveMemberList();
  await printMemberReport();
});

client.on('auth_failure', () => {
  console.error('❌ Authentication failed. Delete the .wwebjs_auth folder and try again.');
});

// ─── Message Listener ─────────────────────────────────────────────────────────
client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();

    // Only monitor the configured group
    if (!chat.isGroup) return;
    if (chat.name !== config.GROUP_NAME) return;

    const contact = await msg.getContact();
    const candidateName = contact.pushname || contact.number;
    const phoneNumber = contact.number;
    const today = getTodayKey();

    // Log activity
    const activity = loadActivity();
    if (!activity[today]) activity[today] = {};

    activity[today][phoneNumber] = {
      name: candidateName,
      lastMessage: msg.body.substring(0, 100),
      timestamp: new Date().toISOString()
    };

    saveActivity(activity);
    const time = new Date().toLocaleTimeString('en-IN', { timeZone: config.TIMEZONE });
    console.log(`\n📝 New message in group:`);
    console.log(`   👤 ${candidateName} (+${phoneNumber})`);
    console.log(`   🕐 ${time}`);
    console.log(`   💬 ${msg.body.substring(0, 100)}`);
  } catch (err) {
    console.error('Error processing message:', err.message);
  }
});

// ─── Save Member List ─────────────────────────────────────────────────────────
const MEMBERS_FILE = path.join(__dirname, '../data/members.json');

async function saveMemberList() {
  try {
    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name === config.GROUP_NAME);
    if (!group) return;

    const members = group.participants.map(p => ({
      number: p.id.user,
      isTL: config.TL_NUMBERS.includes(p.id.user),
      isAdmin: p.isAdmin || p.isSuperAdmin
    }));

    fs.writeFileSync(MEMBERS_FILE, JSON.stringify({ groupName: group.name, members, updatedAt: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error('Error saving member list:', err.message);
  }
}

// ─── Console Member Report ────────────────────────────────────────────────────
async function printMemberReport() {
  try {
    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name === config.GROUP_NAME);
    if (!group) {
      console.log(`❌ Group "${config.GROUP_NAME}" not found.`);
      return;
    }

    const activity = loadActivity();
    const today = getTodayKey();
    const allDays = Object.keys(activity).sort().reverse();
    const members = group.participants.filter(p => !config.TL_NUMBERS.includes(p.id.user));

    console.log('\n' + '─'.repeat(60));
    console.log(`👥 GROUP MEMBERS & LAST ACTIVITY — ${today}`);
    console.log('─'.repeat(60));

    for (const participant of members) {
      const number = participant.id.user;
      let lastEntry = null;
      for (const day of allDays) {
        if (activity[day] && activity[day][number]) {
          lastEntry = { ...activity[day][number], day };
          break;
        }
      }

      if (lastEntry) {
        const time = new Date(lastEntry.timestamp).toLocaleString('en-IN', { timeZone: config.TIMEZONE });
        const activeToday = lastEntry.day === today ? ' ✅' : ' ⚠️';
        console.log(`\n  👤 ${lastEntry.name} (+${number})${activeToday}`);
        console.log(`     🕐 ${time}`);
        console.log(`     💬 ${lastEntry.lastMessage || '—'}`);
      } else {
        console.log(`\n  👤 +${number} ❌`);
        console.log(`     No activity recorded yet`);
      }
    }

    const activeToday = members.filter(p => activity[today] && activity[today][p.id.user]).length;
    console.log('\n' + '─'.repeat(60));
    console.log(`📊 Active today: ${activeToday}/${members.length} members`);
    console.log('─'.repeat(60) + '\n');
  } catch (err) {
    console.error('Error printing member report:', err.message);
  }
}

// ─── Daily Inactivity Check ───────────────────────────────────────────────────
function startDailyCheck() {
  cron.schedule(config.DAILY_CHECK_TIME, async () => {
    console.log('\n🔍 Running daily inactivity check...');
    await checkInactivity();
  }, { timezone: config.TIMEZONE });
}

async function checkInactivity() {
  try {
    const today = getTodayKey();
    const activity = loadActivity();
    const todayActivity = activity[today] || {};
    const activeNumbers = Object.keys(todayActivity);

    // Get group chat
    const chats = await client.getChats();
    const group = chats.find(c => c.isGroup && c.name === config.GROUP_NAME);

    if (!group) {
      console.error(`❌ Group "${config.GROUP_NAME}" not found!`);
      return;
    }

    // Get all participants
    const participants = group.participants;
    const inactiveCandidates = [];

    for (const participant of participants) {
      const number = participant.id.user;

      // Skip the TL and bot itself
      if (config.TL_NUMBERS.includes(number)) continue;
      if (config.SKIP_NUMBERS.includes(number)) continue;

      if (!activeNumbers.includes(number)) {
        // Try to get name from activity history or use number
        const name = getLastKnownName(activity, number) || number;
        inactiveCandidates.push({ name, number });
      }
    }

    console.log(`📊 Active today: ${activeNumbers.length} | Inactive: ${inactiveCandidates.length}`);

    if (inactiveCandidates.length === 0) {
      console.log('✅ All candidates were active today! No alerts needed.');
      await notifyTL(`✅ *Daily Report - ${today}*\n\nAll candidates were active today! 🎉`, true);
      return;
    }

    // Build alert message
    const inactiveList = inactiveCandidates
      .map((c, i) => `${i + 1}. ${c.name} (+${c.number})`)
      .join('\n');

    const alertMessage =
      `⚠️ *Inactivity Alert - ${today}*\n\n` +
      `The following candidates have been *inactive* today and have not reported:\n\n` +
      `${inactiveList}\n\n` +
      `Please follow up with them. 🙏`;

    await notifyTL(alertMessage);
    console.log(`🚨 Alert sent to TL for ${inactiveCandidates.length} inactive candidate(s).`);

  } catch (err) {
    console.error('Error during inactivity check:', err.message);
  }
}

function getLastKnownName(activity, number) {
  const allDays = Object.keys(activity).sort().reverse();
  for (const day of allDays) {
    if (activity[day][number]) {
      return activity[day][number].name;
    }
  }
  return null;
}

// ─── Notify TL ────────────────────────────────────────────────────────────────
async function notifyTL(message, isGoodNews = false) {
  for (const tlNumber of config.TL_NUMBERS) {
    try {
      const chatId = `${tlNumber}@c.us`;
      await client.sendMessage(chatId, message);
      console.log(`📤 Notification sent to TL: ${tlNumber}`);
    } catch (err) {
      console.error(`Failed to send to TL ${tlNumber}:`, err.message);
    }
  }
}

// ─── Manual Check Command ─────────────────────────────────────────────────────
// TL can send "!check" in the group to trigger an immediate check
client.on('message', async (msg) => {
  if (msg.body === '!check') {
    const contact = await msg.getContact();
    if (config.TL_NUMBERS.includes(contact.number)) {
      await msg.reply('🔍 Running inactivity check now...');
      await checkInactivity();
    }
  }

  if (msg.body === '!status') {
    const contact = await msg.getContact();
    if (config.TL_NUMBERS.includes(contact.number)) {
      const today = getTodayKey();
      const activity = loadActivity();
      const todayActivity = activity[today] || {};
      const count = Object.keys(todayActivity).length;
      const names = Object.values(todayActivity).map(a => `• ${a.name}`).join('\n');
      await msg.reply(`📊 *Active today (${today}):* ${count}\n\n${names || 'Nobody yet'}`);
    }
  }

  if (msg.body === '!report') {
    const contact = await msg.getContact();
    if (config.TL_NUMBERS.includes(contact.number)) {
      try {
        const chats = await client.getChats();
        const group = chats.find(c => c.isGroup && c.name === config.GROUP_NAME);
        if (!group) {
          await msg.reply(`❌ Group "${config.GROUP_NAME}" not found.`);
          return;
        }

        const activity = loadActivity();
        const lines = [];

        for (const participant of group.participants) {
          const number = participant.id.user;
          if (config.TL_NUMBERS.includes(number)) continue;

          // Find last activity across all days
          const allDays = Object.keys(activity).sort().reverse();
          let lastEntry = null;
          let lastDay = null;
          for (const day of allDays) {
            if (activity[day][number]) {
              lastEntry = activity[day][number];
              lastDay = day;
              break;
            }
          }

          if (lastEntry) {
            const time = new Date(lastEntry.timestamp).toLocaleString('en-IN', { timeZone: config.TIMEZONE });
            lines.push(`👤 *${lastEntry.name}*\n   📅 ${time}\n   💬 ${lastEntry.lastMessage || '—'}`);
          } else {
            const name = number;
            lines.push(`👤 *+${name}*\n   ❌ No activity recorded`);
          }
        }

        const report = `📋 *Member Activity Report*\n_(${group.participants.length - config.TL_NUMBERS.length} members)_\n\n` + lines.join('\n\n');
        await msg.reply(report);
      } catch (err) {
        await msg.reply(`❌ Error: ${err.message}`);
      }
    }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('🚀 Starting WhatsApp Inactivity Monitor...');
client.initialize();

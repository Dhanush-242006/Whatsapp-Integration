const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const app = express();
const PORT = 3000;

const ACTIVITY_FILE = path.join(__dirname, '../data/activity.json');
const MEMBERS_FILE  = path.join(__dirname, '../data/members.json');

function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

app.use(express.static(path.join(__dirname, '../public')));

app.get('/api/dashboard', (req, res) => {
  const membersData = readJSON(MEMBERS_FILE);
  const activity    = readJSON(ACTIVITY_FILE) || {};
  const today       = getTodayKey();
  const allDays     = Object.keys(activity).sort().reverse();

  if (!membersData) {
    return res.json({ error: 'Bot not started yet. Run node src/bot.js first.' });
  }

  const rows = membersData.members
    .filter(m => !m.isTL)
    .map(m => {
      const number = m.number;
      let lastEntry = null;
      let lastDay   = null;
      for (const day of allDays) {
        if (activity[day] && activity[day][number]) {
          lastEntry = activity[day][number];
          lastDay   = day;
          break;
        }
      }

      const activeToday = !!(activity[today] && activity[today][number]);

      return {
        number,
        name:        lastEntry ? lastEntry.name : null,
        lastMessage: lastEntry ? lastEntry.lastMessage : null,
        lastSeen:    lastEntry ? lastEntry.timestamp : null,
        lastDay,
        activeToday,
        isAdmin:     m.isAdmin
      };
    });

  const activeCount   = rows.filter(r => r.activeToday).length;
  const inactiveCount = rows.filter(r => !r.activeToday && r.lastEntry).length;
  const neverActive   = rows.filter(r => !r.lastSeen).length;

  res.json({
    groupName:   membersData.groupName,
    today,
    updatedAt:   membersData.updatedAt,
    stats: { total: rows.length, activeToday: activeCount, neverActive },
    members: rows
  });
});

app.listen(PORT, () => {
  console.log(`\n🌐 Dashboard running at http://localhost:${PORT}\n`);
});

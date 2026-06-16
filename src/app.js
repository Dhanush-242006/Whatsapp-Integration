const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

// Prevent auth timeout / internal library rejections from crashing Node v24
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled rejection:', reason?.message || reason);
});

// Remove Chrome lockfile left by a previous unclean shutdown
const lockFile = path.join(__dirname, '../.wwebjs_auth/session/SingletonLock');
try { fs.unlinkSync(lockFile); console.log('🔓 Removed stale Chrome lockfile'); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR   = path.join(__dirname, '../data');
const ACTIVITY_FILE  = path.join(DATA_DIR, 'activity.json');
const GROUPS_FILE    = path.join(DATA_DIR, 'groups.json');
const MESSAGES_FILE  = path.join(DATA_DIR, 'messages.json');
const SUMMARIES_FILE = path.join(DATA_DIR, 'summaries.json');
const CONFIG_FILE    = path.join(DATA_DIR, 'config.json');

const sseClients = new Set();
let botStatus = 'initializing';
let cachedQR  = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}
function writeJSON(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getTodayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
function broadcast(event, data) {
  const msg = `data: ${JSON.stringify({ event, data })}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}
function cleanOldMessages(msgs) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const gId of Object.keys(msgs)) {
    for (const num of Object.keys(msgs[gId])) {
      msgs[gId][num] = msgs[gId][num].filter(m => new Date(m.timestamp).getTime() > cutoff);
      if (!msgs[gId][num].length) delete msgs[gId][num];
    }
    if (!Object.keys(msgs[gId]).length) delete msgs[gId];
  }
  return msgs;
}

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    protocolTimeout: 300000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-zygote'
    ]
  }
});

client.on('qr', async (qr) => {
  botStatus = 'qr';
  try {
    cachedQR = await QRCode.toDataURL(qr, { width: 280, margin: 2, color: { dark: '#000', light: '#fff' } });
    broadcast('qr', { image: cachedQR });
    console.log('📱 QR code ready — open http://localhost:' + PORT);
  } catch (err) {
    console.error('QR error:', err.message);
  }
});

client.on('ready', async () => {
  botStatus = 'ready';
  cachedQR  = null;
  console.log('✅ WhatsApp connected!');
  broadcast('ready', {});

  console.log('⏳ Waiting 60s before fetching groups...');
  
  setTimeout(async () => { await saveGroups(); }, 60000);
});
client.on('auth_failure', () => {
  botStatus = 'auth_failure';
  broadcast('error', { message: 'Authentication failed. Please restart.' });
});

client.on('disconnected', () => {
  botStatus = 'disconnected';
  broadcast('error', { message: 'Disconnected. Please restart.' });
});

client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    if (!chat.isGroup) return;
    const groupId = chat.id._serialized;
    let number, name;
    if (msg.fromMe) {
      number = client.info.wid.user;
      name   = client.info.pushname || number;
    } else {
      const contact = await msg.getContact();
      number = contact.number;
      name   = contact.pushname || number;
    }
    const now   = new Date().toISOString();
    const today = getTodayKey();

    // Resolve @mentions to real names
    let body = msg.body || '';
    if (msg.mentionedIds && msg.mentionedIds.length > 0) {
      for (const cid of msg.mentionedIds) {
        try {
          const cidStr = cid._serialized || cid;
          const num    = cidStr.split('@')[0];
          const mc     = await client.getContactById(cidStr);
          const mname  = mc.pushname || mc.name || num;
          body = body.split('@' + num).join('@' + mname);
        } catch {}
      }
    }

    // Update activity (last message summary)
    const activity = readJSON(ACTIVITY_FILE) || {};
    if (!activity[groupId])        activity[groupId] = {};
    if (!activity[groupId][today]) activity[groupId][today] = {};
    activity[groupId][today][number] = { name, lastMessage: body.substring(0, 120), timestamp: now, count: ((activity[groupId][today][number]||{}).count||0)+1 };
    writeJSON(ACTIVITY_FILE, activity);

    // Save full message to history
    const msgEntry = { msgId: msg.id._serialized, body, timestamp: now, type: msg.type, fromMe: msg.fromMe, name };
    if (msg.hasMedia && !['video', 'sticker', 'gif'].includes(msg.type)) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          msgEntry.mediaData = media.data;
          msgEntry.mimetype  = media.mimetype;
          msgEntry.filename  = media.filename || `file.${(media.mimetype||'').split('/')[1] || 'bin'}`;
        }
      } catch {}
    }
    const msgs = cleanOldMessages(readJSON(MESSAGES_FILE) || {});
    if (!msgs[groupId])         msgs[groupId] = {};
    if (!msgs[groupId][number]) msgs[groupId][number] = [];
    msgs[groupId][number].push(msgEntry);
    writeJSON(MESSAGES_FILE, msgs);
  } catch {}
});

async function backfillMessages() {
  console.log('📥 Backfilling pre-login messages from store...');
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try { if (!client.pupPage || client.pupPage.isClosed()) return;
    const groupData = readJSON(GROUPS_FILE);
    if (!groupData) return;
    const activity = readJSON(ACTIVITY_FILE) || {};
    const msgs = cleanOldMessages(readJSON(MESSAGES_FILE) || {});
    let total = 0;

    for (const group of groupData.groups) {
      try {
        const groupId = group.id;
        const fetched = await client.pupPage.evaluate((chatId, cutoffMs) => {
          try {
            const chat = window.Store.Chat.get(chatId);
            if (!chat || !chat.msgs || !chat.msgs.models) return [];
            return chat.msgs.models
              .filter(m => m.t * 1000 > cutoffMs && !m.isNotification && m.type !== 'e2e_notification' && m.type !== 'notification_template')
              .map(m => ({
                id:       m.id._serialized,
                body:     m.body || m.caption || '',
                timestamp: m.t,
                type:     m.type,
                fromMe:   m.id.fromMe,
                author:   m.author ? m.author._serialized : null
              }));
          } catch (e) { return []; }
        }, groupId, cutoff);

        if (!fetched.length) continue;

        for (const m of fetched) {
          const ts  = m.timestamp * 1000;
          const now = new Date(ts).toISOString();
          const day = new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

          let number, name;
          if (m.fromMe) {
            number = client.info.wid.user;
            name   = client.info.pushname || number;
          } else {
            const raw = (m.author || '').replace(/@\S+/, '');
            number = raw || 'unknown';
            // Try to get name from existing activity
            name = (activity[groupId]?.[day]?.[number]?.name) || number;
          }
          if (!number || number === 'unknown') continue;

          // Update activity
          if (!activity[groupId])        activity[groupId] = {};
          if (!activity[groupId][day])   activity[groupId][day] = {};
          const ex = activity[groupId][day][number] || {};
          const isNewer = !ex.timestamp || ts > new Date(ex.timestamp).getTime();
          activity[groupId][day][number] = {
            name,
            lastMessage: isNewer ? m.body.substring(0, 120) : ex.lastMessage,
            timestamp:   isNewer ? now : ex.timestamp,
            count:       (ex.count || 0) + 1
          };

          // Save message, dedup by id
          if (!msgs[groupId])          msgs[groupId] = {};
          if (!msgs[groupId][number])  msgs[groupId][number] = [];
          if (!msgs[groupId][number].some(x => x.msgId === m.id)) {
            msgs[groupId][number].push({ msgId: m.id, body: m.body, timestamp: now, type: m.type, fromMe: m.fromMe, name });
            total++;
          }
        }
      } catch (err) {
        console.error(`Backfill error for ${group.name}:`, err.message);
      }
    }

    writeJSON(ACTIVITY_FILE, activity);
    writeJSON(MESSAGES_FILE, msgs);
    console.log(`📥 Backfill complete — ${total} messages loaded`);
  } catch (err) {
    console.error('Backfill failed:', err.message);
  }
}

async function saveGroups(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`📋 Fetching groups (attempt ${i + 1}/${retries})...`);
      const chats = await client.getChats();

      // Fetch all contact names from WhatsApp's in-memory store
      let contactNames = {};
      try {
        contactNames = await client.pupPage.evaluate(() => {
          const map = {};
          try {
            (window.Store.Contact.getModelsArray() || []).forEach(c => {
              if (c.id && c.id.user) {
                map[c.id.user] = c.pushname || c.name || c.verifiedName || null;
              }
            });
          } catch {}
          return map;
        });
      } catch {}

      const groups = chats.filter(c => c.isGroup).map(g => ({
        id:           g.id._serialized,
        name:         g.name,
        participants: g.participants.map(p => ({
          number:  p.id.user,
          name:    contactNames[p.id.user] || null,
          isAdmin: !!(p.isAdmin || p.isSuperAdmin)
        }))
      }));
      writeJSON(GROUPS_FILE, { groups, updatedAt: new Date().toISOString() });
      console.log(`📋 ${groups.length} groups saved`);
      return;
    } catch (err) {
      console.error(`saveGroups attempt ${i + 1}:`, err.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 8000));
    }
  }
}

function generateDailySummary() {
  const today = getTodayKey();
  const data = readJSON(GROUPS_FILE);
  if (!data) return;
  const activity = readJSON(ACTIVITY_FILE) || {};
  const summary = {
    date: today,
    groups: data.groups.map(g => {
      const todayAct = (activity[g.id] && activity[g.id][today]) ? activity[g.id][today] : {};
      const activeMembers = Object.keys(todayAct).length;
      const totalMessages = Object.values(todayAct).reduce((s, m) => s + (m.count || 1), 0);
      return { id: g.id, name: g.name, activeMembers, totalMembers: g.participants.length, totalMessages };
    })
  };
  const summaries = readJSON(SUMMARIES_FILE) || [];
  const filtered = summaries.filter(s => s.date !== today);
  filtered.unshift(summary);
  writeJSON(SUMMARIES_FILE, filtered.slice(0, 30));
  console.log('📊 Daily summary saved for ' + today);
  sendDailySummaryEmail(summary).catch(err => console.error('Email error:', err.message));
}
cron.schedule('59 23 * * *', generateDailySummary, { timezone: 'Asia/Kolkata' });

async function sendDailySummaryEmail(summary) {
  const config = readJSON(CONFIG_FILE) || {};
  const ec = config.email || {};
  if (!ec.host || !ec.to || !ec.user || !ec.pass) return;
  const transporter = nodemailer.createTransport({ host: ec.host, port: ec.port || 587, secure: !!ec.secure, auth: { user: ec.user, pass: ec.pass } });
  const rows = summary.groups.map(g => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${g.name}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">${g.activeMembers}/${g.totalMembers}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">${g.totalMessages}</td></tr>`).join('');
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto"><h2 style="color:#16a34a">📊 WhatsApp Monitor — ${summary.date}</h2><table style="width:100%;border-collapse:collapse;margin-top:16px"><thead><tr style="background:#f1f5f9"><th style="padding:8px 12px;text-align:left">Group</th><th style="padding:8px 12px">Active Members</th><th style="padding:8px 12px">Messages</th></tr></thead><tbody>${rows}</tbody></table><p style="color:#94a3b8;font-size:12px;margin-top:24px">WhatsApp Monitor · Daily Summary</p></div>`;
  await transporter.sendMail({ from: ec.from || ec.user, to: ec.to, subject: `WhatsApp Monitor Daily Summary — ${summary.date}`, html });
  console.log('📧 Daily summary email sent to ' + ec.to);
}

// Midnight IST — clean activity entries older than 7 days
cron.schedule('0 0 * * *', () => {
  const activity = readJSON(ACTIVITY_FILE) || {};
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffKey = cutoff.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  for (const gId of Object.keys(activity)) {
    for (const day of Object.keys(activity[gId])) {
      if (day < cutoffKey) delete activity[gId][day];
    }
    if (!Object.keys(activity[gId]).length) delete activity[gId];
  }
  writeJSON(ACTIVITY_FILE, activity);
  console.log('🧹 Cleaned activity entries older than 7 days');
}, { timezone: 'Asia/Kolkata' });

// ─── Express ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, '../public')));

// Server-Sent Events — real-time QR / ready push
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  // Send current state immediately
  if      (botStatus === 'ready')          res.write(`data: ${JSON.stringify({ event: 'ready', data: {} })}\n\n`);
  else if (botStatus === 'qr' && cachedQR) res.write(`data: ${JSON.stringify({ event: 'qr', data: { image: cachedQR } })}\n\n`);
  else                                     res.write(`data: ${JSON.stringify({ event: 'status', data: { status: botStatus } })}\n\n`);
  if (res.flush) res.flush();
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/status', (req, res) => {
  res.json({ status: botStatus, qr: (botStatus === 'qr' && cachedQR) ? cachedQR : null });
});

app.get('/api/day-messages/:groupId/:date', (req, res) => {
  const groupId = decodeURIComponent(req.params.groupId);
  const date    = req.params.date;
  const msgs    = readJSON(MESSAGES_FILE) || {};
  const groupMsgs = msgs[groupId] || {};
  const dayMsgs = [];
  for (const [number, list] of Object.entries(groupMsgs)) {
    for (const m of list) {
      const msgDate = new Date(m.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      if (msgDate === date) dayMsgs.push({ ...m, number });
    }
  }
  dayMsgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  res.json({ messages: dayMsgs });
});

app.get('/api/member-messages/:groupId/:number', (req, res) => {
  const groupId = decodeURIComponent(req.params.groupId);
  const number  = req.params.number;
  const msgs    = cleanOldMessages(readJSON(MESSAGES_FILE) || {});
  const list    = (msgs[groupId]?.[number] || []).slice().reverse();
  res.json({ messages: list });
});

app.get('/api/member-stats/:groupId/:number', (req, res) => {
  const groupId = decodeURIComponent(req.params.groupId);
  const number  = req.params.number;
  const activity = readJSON(ACTIVITY_FILE) || {};
  const groupAct = activity[groupId] || {};
  let totalMessages = 0, activeDays = 0;
  const stats = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateKey = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // IST
    const dayData = groupAct[dateKey] && groupAct[dateKey][number];
    if (dayData) { activeDays++; totalMessages += dayData.count || 1; }
    stats.push({ date: dateKey, active: !!dayData, count: dayData ? (dayData.count || 1) : 0 });
  }
  res.json({ totalMessages, activeDays, stats });
});

app.get('/api/summaries', (req, res) => {
  res.json({ summaries: readJSON(SUMMARIES_FILE) || [] });
});

app.post('/api/refresh-groups', async (req, res) => {
  if (botStatus !== 'ready') return res.json({ ok: false, error: 'Not connected' });
  await saveGroups();
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  try {
    botStatus = 'initializing';
    cachedQR  = null;
    broadcast('status', { status: 'initializing' });
    await client.logout();
    console.log('👋 Logged out — waiting for new QR...');
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/groups', (req, res) => {
  const data = readJSON(GROUPS_FILE);
  if (!data) return res.json({ groups: [] });
  const activity = readJSON(ACTIVITY_FILE) || {};
  const today    = getTodayKey();
  const groups   = data.groups.map(g => {
    const todayAct   = (activity[g.id] && activity[g.id][today]) ? activity[g.id][today] : {};
    const activeToday = Object.keys(todayAct).length;
    return {
      id:           g.id,
      name:         g.name,
      totalMembers: g.participants.length,
      activeToday,
      inactiveToday: g.participants.length - activeToday
    };
  });
  res.json({ groups });
});

app.get('/api/group/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  const data    = readJSON(GROUPS_FILE);
  if (!data) return res.status(404).json({ error: 'No data' });
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const activity      = readJSON(ACTIVITY_FILE) || {};
  const groupActivity = activity[groupId] || {};
  const today         = getTodayKey();
  const allDays       = Object.keys(groupActivity).sort().reverse();

  // Build members list with last activity
  const members = group.participants.map(p => {
    let lastEntry = null;
    for (const day of allDays) {
      if (groupActivity[day] && groupActivity[day][p.number]) {
        lastEntry = { ...groupActivity[day][p.number], day };
        break;
      }
    }
    return {
      number:      p.number,
      name:        (lastEntry ? lastEntry.name : null) || p.name || null,
      lastMessage: lastEntry ? lastEntry.lastMessage : null,
      lastSeen:    lastEntry ? lastEntry.timestamp   : null,
      activeToday: !!(groupActivity[today] && groupActivity[today][p.number]),
      isAdmin:     p.isAdmin
    };
  });

  // Last 7 days stats
  const weekStats = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey    = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const dayName    = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' });
    const dateLabel  = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    const dayAct     = groupActivity[dateKey] || {};
    const activeNums = Object.keys(dayAct);
    weekStats.push({
      date:          dateKey,
      day:           dayName,
      label:         `${dayName}\n${dateLabel}`,
      active:        activeNums.length,
      total:         group.participants.length,
      activeMembers: activeNums.map(n => ({
        number:      n,
        name:        dayAct[n].name,
        lastMessage: dayAct[n].lastMessage,
        timestamp:   dayAct[n].timestamp
      }))
    });
  }

  res.json({ id: group.id, name: group.name, totalMembers: group.participants.length, members, weekStats });
});

// ── Message type breakdown ──────────────────────────────────────────────────
app.get('/api/message-types/:groupId', (req, res) => {
  const groupId = decodeURIComponent(req.params.groupId);
  const msgs = readJSON(MESSAGES_FILE) || {};
  const groupMsgs = msgs[groupId] || {};
  const types = { text: 0, image: 0, audio: 0, document: 0, video: 0, other: 0 };
  for (const list of Object.values(groupMsgs)) {
    for (const m of list) {
      if      (m.type === 'chat' || (!m.type && m.body))          types.text++;
      else if (m.type === 'image')                                 types.image++;
      else if (m.type === 'audio' || m.type === 'ptt')            types.audio++;
      else if (m.type === 'document')                             types.document++;
      else if (m.type === 'video')                                types.video++;
      else                                                        types.other++;
    }
  }
  res.json({ types });
});

// ── Global search ───────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json({ results: [] });
  const msgs = readJSON(MESSAGES_FILE) || {};
  const groupData = readJSON(GROUPS_FILE);
  const groupMap = {};
  if (groupData) groupData.groups.forEach(g => { groupMap[g.id] = g.name; });
  const results = [];
  for (const [groupId, groupMsgs] of Object.entries(msgs)) {
    for (const [number, list] of Object.entries(groupMsgs)) {
      for (const m of list) {
        if (m.body && m.body.toLowerCase().includes(q)) {
          results.push({ groupId, groupName: groupMap[groupId] || groupId, number, name: m.name, body: m.body, timestamp: m.timestamp });
        }
      }
    }
  }
  results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json({ results: results.slice(0, 100) });
});

// ── PDF export data ─────────────────────────────────────────────────────────
app.get('/api/export/:groupId', (req, res) => {
  const groupId = decodeURIComponent(req.params.groupId);
  const range   = req.query.range || 'daily';
  const data    = readJSON(GROUPS_FILE);
  if (!data) return res.status(404).json({ error: 'No data' });
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const activity = readJSON(ACTIVITY_FILE) || {};
  const groupAct = activity[groupId] || {};
  const days = range === 'weekly' ? 7 : 1;
  const dateRange = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dateRange.push(d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  }
  const members = group.participants.map(p => {
    let totalMsgs = 0, lastSeen = null, lastMsg = '', name = null;
    for (const day of dateRange) {
      const dd = groupAct[day]?.[p.number];
      if (dd) {
        totalMsgs += dd.count || 1;
        if (!lastSeen || new Date(dd.timestamp) > new Date(lastSeen)) { lastSeen = dd.timestamp; lastMsg = dd.lastMessage || ''; name = dd.name; }
      }
    }
    return { number: p.number, name, totalMsgs, lastSeen, lastMsg, isAdmin: p.isAdmin };
  }).sort((a, b) => b.totalMsgs - a.totalMsgs);
  res.json({ groupName: group.name, totalMembers: group.participants.length, activeCount: members.filter(m => m.totalMsgs > 0).length, totalMessages: members.reduce((s, m) => s + m.totalMsgs, 0), dateRange, range, members, generatedAt: new Date().toISOString() });
});

// ── Email config ────────────────────────────────────────────────────────────
app.get('/api/config/email', (req, res) => {
  const config = readJSON(CONFIG_FILE) || {};
  const ec = config.email || {};
  res.json({ email: { host: ec.host||'', port: ec.port||587, secure: !!ec.secure, user: ec.user||'', pass: ec.pass?'••••••••':'', to: ec.to||'', from: ec.from||'' } });
});
app.post('/api/config/email', express.json(), (req, res) => {
  const config = readJSON(CONFIG_FILE) || {};
  const ex = config.email || {};
  config.email = { host: req.body.host||ex.host||'', port: Number(req.body.port)||ex.port||587, secure: !!req.body.secure, user: req.body.user||ex.user||'', pass: (req.body.pass && req.body.pass !== '••••••••') ? req.body.pass : (ex.pass||''), to: req.body.to||ex.to||'', from: req.body.from||ex.from||'' };
  writeJSON(CONFIG_FILE, config);
  res.json({ ok: true });
});

// ── Test email ───────────────────────────────────────────────────────────────
app.post('/api/test-email', async (req, res) => {
  const config = readJSON(CONFIG_FILE) || {};
  const ec = config.email || {};
  if (!ec.host || !ec.to || !ec.user || !ec.pass) return res.json({ ok: false, error: 'Email not configured. Please save settings first.' });
  try {
    const transporter = nodemailer.createTransport({ host: ec.host, port: ec.port || 587, secure: !!ec.secure, auth: { user: ec.user, pass: ec.pass } });
    await transporter.sendMail({
      from: ec.from || ec.user,
      to: ec.to,
      subject: '✅ WhatsApp Monitor — Test Email',
      html: `<div style="font-family:sans-serif;max-width:500px;margin:auto;padding:24px">
        <h2 style="color:#16a34a">✅ Test Email Successful!</h2>
        <p>Your WhatsApp Monitor email settings are working correctly.</p>
        <p style="color:#64748b;font-size:13px">Daily summary emails will be sent to <b>${ec.to}</b> every night at 11:59 PM IST.</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
        <p style="color:#94a3b8;font-size:12px">WhatsApp Monitor · Test Email</p>
      </div>`
    });
    console.log('📧 Test email sent to ' + ec.to);
    res.json({ ok: true });
  } catch (err) {
    console.error('Test email error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ── Contacts list ───────────────────────────────────────────────────────────
app.get('/api/contacts', (req, res) => {
  const groupData = readJSON(GROUPS_FILE);
  if (!groupData) return res.json({ active: [], inactive: [] });
  const msgs     = readJSON(MESSAGES_FILE) || {};
  const activity = readJSON(ACTIVITY_FILE) || {};
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const contacts = {};

  // Seed from group participants (use stored contact name if available)
  groupData.groups.forEach(group => {
    group.participants.forEach(p => {
      const phone = p.number;
      if (!contacts[phone]) contacts[phone] = { phone, name: p.name || null, groups: [], lastSeen: null, msgCount: 0 };
      // Update name if we have one now but didn't before
      if (!contacts[phone].name && p.name) contacts[phone].name = p.name;
      if (!contacts[phone].groups.find(g => g.id === group.id))
        contacts[phone].groups.push({ id: group.id, name: group.name });
    });
  });

  // Enrich from messages
  for (const [groupId, groupMsgs] of Object.entries(msgs)) {
    const grp = groupData.groups.find(g => g.id === groupId);
    for (const [phone, list] of Object.entries(groupMsgs)) {
      if (!contacts[phone]) contacts[phone] = { phone, name: null, groups: [], lastSeen: null, msgCount: 0 };
      if (grp && !contacts[phone].groups.find(g => g.id === grp.id))
        contacts[phone].groups.push({ id: grp.id, name: grp.name });
      contacts[phone].msgCount += list.length;
      for (const m of list) {
        const ts = new Date(m.timestamp).getTime();
        if (!contacts[phone].lastSeen || ts > contacts[phone].lastSeen) {
          contacts[phone].lastSeen = ts;
          if (!contacts[phone].name && m.name) contacts[phone].name = m.name;
        }
      }
    }
  }

  // Enrich names from activity
  for (const groupAct of Object.values(activity)) {
    for (const dayAct of Object.values(groupAct)) {
      for (const [phone, info] of Object.entries(dayAct)) {
        if (!contacts[phone]) continue;
        if (!contacts[phone].name && info.name) contacts[phone].name = info.name;
        if (info.timestamp) {
          const ts = new Date(info.timestamp).getTime();
          if (!contacts[phone].lastSeen || ts > contacts[phone].lastSeen) contacts[phone].lastSeen = ts;
        }
      }
    }
  }

  const all = Object.values(contacts);
  const active   = all.filter(c => c.lastSeen && c.lastSeen > sevenDaysAgo).sort((a, b) => b.lastSeen - a.lastSeen);
  const inactive = all.filter(c => !c.lastSeen || c.lastSeen <= sevenDaysAgo).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json({ active, inactive });
});

// ── Contact detail ───────────────────────────────────────────────────────────
app.get('/api/contact/:phone', (req, res) => {
  const { phone } = req.params;
  const groupData = readJSON(GROUPS_FILE);
  const msgs      = readJSON(MESSAGES_FILE) || {};
  const activity  = readJSON(ACTIVITY_FILE) || {};
  const msgsByDay = {};
  const inGroups  = new Set();
  let name = null;

  if (groupData) {
    for (const group of groupData.groups) {
      const list = (msgs[group.id] || {})[phone] || [];
      if (list.length) {
        inGroups.add(group.id);
        for (const m of list) {
          if (!name && m.name) name = m.name;
          const day = new Date(m.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
          if (!msgsByDay[day]) msgsByDay[day] = [];
          msgsByDay[day].push({ ...m, groupName: group.name, groupId: group.id });
        }
      }
    }
  }

  for (const day of Object.keys(msgsByDay))
    msgsByDay[day].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const groupsIn = (groupData ? groupData.groups : [])
    .filter(g => g.participants.some(p => p.number === phone) || inGroups.has(g.id))
    .map(g => ({ id: g.id, name: g.name, isParticipant: g.participants.some(p => p.number === phone), hasMessages: inGroups.has(g.id) }));

  // Try activity data for name
  if (!name) {
    outer: for (const groupAct of Object.values(activity)) {
      for (const dayAct of Object.values(groupAct)) {
        if (dayAct[phone]?.name) { name = dayAct[phone].name; break outer; }
      }
    }
  }
  // Fall back to stored participant name from groups.json
  if (!name && groupData) {
    outer2: for (const group of groupData.groups) {
      for (const p of group.participants) {
        if (p.number === phone && p.name) { name = p.name; break outer2; }
      }
    }
  }

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const dateKey  = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const dayName  = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Kolkata' });
    const dateLabel = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    const dayMsgs  = msgsByDay[dateKey] || [];
    last7Days.push({ date: dateKey, day: dayName, label: dateLabel, msgCount: dayMsgs.length, active: dayMsgs.length > 0 });
  }

  res.json({ phone, name: name || phone, groups: groupsIn, msgsByDay, last7Days });
});

app.listen(PORT, () => console.log(`🌐 Dashboard: http://localhost:${PORT}`));
console.log('🚀 Starting WhatsApp Monitor...');
client.initialize();

// Watchdog: if not connected within 3 minutes, exit so PM2 restarts us
setTimeout(() => {
  if (botStatus !== 'ready') {
    console.error('⏰ Watchdog: not connected after 3 minutes — restarting...');
    process.exit(1);
  }
}, 3 * 60 * 1000);

const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Pool } = require('pg');
const dns = require('dns'); dns.setDefaultResultOrder('ipv4first');
const http = require('http'), https = require('https');
const sharp = require('sharp');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── DB ─────────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS configs            (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS warnings           (key TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS history            (id SERIAL PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS notes              (id BIGINT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS scam_hashes        (id SERIAL PRIMARY KEY, guild_id TEXT NOT NULL, hash TEXT NOT NULL, label TEXT, added_by TEXT, added_at BIGINT);
        CREATE TABLE IF NOT EXISTS global_scam_hashes (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, label TEXT NOT NULL, added_by TEXT, added_at BIGINT);
        CREATE INDEX IF NOT EXISTS warnings_guild_user ON warnings(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS history_guild_user  ON history(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS notes_guild_user    ON notes(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS scam_hashes_guild   ON scam_hashes(guild_id);
    `);
}

const configCache = new Map(), activeWarnings = new Map();
async function getConfig(guildId) {
    if (configCache.has(guildId)) return configCache.get(guildId);
    const res = await pool.query('SELECT data FROM configs WHERE guild_id = $1', [guildId]);
    const data = res.rows[0]?.data ?? { levels: {} };
    configCache.set(guildId, data); return data;
}
function saveConfig(guildId, data) {
    configCache.set(guildId, data);
    pool.query('INSERT INTO configs (guild_id, data) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET data = $2', [guildId, data]).catch(e => console.error('saveConfig:', e.message));
}
function saveWarning(key, data) {
    activeWarnings.set(key, data);
    pool.query('INSERT INTO warnings (key, guild_id, user_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO UPDATE SET data = $4', [key, data.guildId, data.userId, data]).catch(e => console.error('saveWarning:', e.message));
}
function deleteWarning(key) { activeWarnings.delete(key); pool.query('DELETE FROM warnings WHERE key = $1', [key]).catch(e => console.error('deleteWarning:', e.message)); }
function addHistory(guildId, userId, entry) { pool.query('INSERT INTO history (guild_id, user_id, data) VALUES ($1, $2, $3)', [guildId, userId, entry]).catch(e => console.error('addHistory:', e.message)); }
async function getHistory(guildId, userId) { const res = await pool.query('SELECT data FROM history WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 10', [guildId, userId]); return res.rows.map(r => r.data).reverse(); }
async function getAllHistory(guildId, userId) { const res = await pool.query('SELECT data FROM history WHERE guild_id = $1 AND user_id = $2 ORDER BY id', [guildId, userId]); return res.rows.map(r => r.data); }
async function getNotes(guildId, userId) { const res = await pool.query('SELECT data FROM notes WHERE guild_id = $1 AND user_id = $2 ORDER BY id', [guildId, userId]); return res.rows.map(r => r.data); }
function addNote(guildId, userId, note) { pool.query('INSERT INTO notes (id, guild_id, user_id, data) VALUES ($1, $2, $3, $4)', [note.id, guildId, userId, note]).catch(e => console.error('addNote:', e.message)); }
async function deleteNote(guildId, userId, id) { const res = await pool.query('DELETE FROM notes WHERE guild_id = $1 AND user_id = $2 AND id = $3', [guildId, userId, id]); return res.rowCount > 0; }

// ── Helpers ────────────────────────────────────────────────────────────────
async function logMod(guild, guildId, embed) { const cfg = await getConfig(guildId); const ch = cfg.logChannelId && guild.channels.cache.get(cfg.logChannelId); if (ch) ch.send({ embeds: [embed] }).catch(() => {}); }
async function hasCommandPermission(interaction, guildId) { if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true; const cfg = await getConfig(guildId); return cfg.accessRoleId ? interaction.member.roles.cache.has(cfg.accessRoleId) : false; }
async function showAccessControlConfig(interaction, guildId) {
    await interaction.reply({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🔒 Access Configuration').setDescription('Select which role should have access to moderation commands:\n\n**Commands affected:**\n• `/warn` `/unwarn` `/timeout` `/config set/view`\n• `/config access` `/warnlist` `/history` `/escalation`\n\n**Note:** Server administrators always have access.').setFooter({ text: 'Select a role from the dropdown below' })], components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`access_role_${guildId}`).setPlaceholder('Select a role for command access').setMinValues(1).setMaxValues(1))], flags: [MessageFlags.Ephemeral] });
}
function parseDuration(s) {
    if (s.toLowerCase() === 'forever') return { days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: null, isForever: true };
    const parts = s.split(':').map(p => { const n = parseInt(p.trim()); return (n < 0 || n > 9999) ? NaN : n; });
    if (parts.some(isNaN) || parts.length < 2 || parts.length > 4) return null;
    let days = 0, hours = 0, minutes = 0, seconds = 0;
    if (parts.length === 2) [minutes, seconds] = parts;
    else if (parts.length === 3) [hours, minutes, seconds] = parts;
    else [days, hours, minutes, seconds] = parts;
    const totalMs = (days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000;
    return (totalMs <= 0 || totalMs > 365 * 86400 * 1000) ? null : { days, hours, minutes, seconds, totalMs, isForever: false };
}
function formatDuration(d, h, m, s, isForever = false) { if (isForever) return 'Forever'; return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s'; }

// Fetch+bulkDelete messages in a channel matching optional userId and since timestamp. Returns count deleted.
async function bulkDeleteInRange(channel, { userId, since, maxCount = Infinity } = {}) {
    let deleted = 0, lastId;
    const MAX_AGE = 1_209_600_000; // 14 days — Discord bulkDelete limit
    do {
        const fetched = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
        if (!fetched.size) break;
        const eligible = fetched.filter(m => (!userId || m.author.id === userId) && (!since || m.createdTimestamp >= since) && (Date.now() - m.createdTimestamp < MAX_AGE));
        const batch = [...eligible.values()].slice(0, maxCount - deleted);
        if (batch.length) { await channel.bulkDelete(batch).catch(() => {}); deleted += batch.length; }
        if (deleted >= maxCount || (since && fetched.last()?.createdTimestamp < since)) break;
        lastId = fetched.last()?.id;
    } while (true);
    return deleted;
}

// ── Scam protection ────────────────────────────────────────────────────────
async function dHash(buffer) {
    const result = await sharp(buffer).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const data = result.data; let hash = 0n;
    for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) if (data[row * 9 + col] > data[row * 9 + col + 1]) hash |= (1n << BigInt(row * 8 + col));
    return hash.toString(16).padStart(16, '0');
}
function hammingDistance(a, b) { let diff = BigInt('0x' + a) ^ BigInt('0x' + b), dist = 0; while (diff) { dist += Number(diff & 1n); diff >>= 1n; } return dist; }
function fetchImageBuffer(url) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        mod.get(url, { headers: { 'User-Agent': 'PoliceBot/1.0' } }, res => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
        }).on('error', reject);
    });
}
const scamHashCache = new Map();
async function getScamHashes(guildId) {
    if (scamHashCache.has(guildId)) return scamHashCache.get(guildId);
    const res = await pool.query('SELECT id, hash, label, added_by, added_at FROM scam_hashes WHERE guild_id = $1 ORDER BY id', [guildId]);
    const hashes = res.rows.map(r => ({ id: r.id, hash: r.hash, label: r.label, addedBy: r.added_by, addedAt: r.added_at }));
    scamHashCache.set(guildId, hashes); return hashes;
}
async function addScamHash(guildId, hash, label, addedBy) {
    const res = await pool.query('INSERT INTO scam_hashes (guild_id, hash, label, added_by, added_at) VALUES ($1, $2, $3, $4, $5) RETURNING id', [guildId, hash, label, addedBy, Date.now()]);
    const entry = { id: res.rows[0].id, hash, label, addedBy, addedAt: Date.now() };
    const cached = scamHashCache.get(guildId) ?? []; cached.push(entry); scamHashCache.set(guildId, cached); return entry;
}
async function removeScamHash(guildId, id) {
    const res = await pool.query('DELETE FROM scam_hashes WHERE guild_id = $1 AND id = $2', [guildId, id]);
    if (res.rowCount > 0) scamHashCache.set(guildId, (scamHashCache.get(guildId) ?? []).filter(h => h.id !== id));
    return res.rowCount > 0;
}
// Global hashes — managed in DB directly:
// INSERT INTO global_scam_hashes (hash, label, added_by, added_at) VALUES ('...', 'label', 'admin', extract(epoch from now())*1000);
let globalScamHashCache = null;
async function getGlobalScamHashes() {
    if (globalScamHashCache !== null) return globalScamHashCache;
    const res = await pool.query('SELECT id, hash, label FROM global_scam_hashes ORDER BY id');
    globalScamHashCache = res.rows.map(r => ({ id: r.id, hash: r.hash, label: r.label, global: true })); return globalScamHashCache;
}
setInterval(() => { globalScamHashCache = null; }, 5 * 60 * 1000);
async function getScamProtConfig(guildId) { const cfg = await getConfig(guildId); return { enabled: true, threshold: 10, timeoutMs: 5 * 60 * 1000, timeoutDisplay: '5m', deleteMsg: true, ...cfg.scamProt }; }

// ── Spam protection ────────────────────────────────────────────────────────
const spamTracker = new Map(), spamCooldown = new Set();
function normalise(s) { return s.trim().toLowerCase().replace(/\s+/g, ' '); }
function similarity(a, b) {
    if (a === b) return 1; if (!a.length || !b.length) return 0;
    if (a.length <= 4 && b.length <= 4 && a.split('').sort().join('') === b.split('').sort().join('')) return 0.9;
    if (a.length < 2 || b.length < 2) return 0;
    const bg = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i+2); m.set(k, (m.get(k) ?? 0) + 1); } return m; };
    const aMap = bg(a), bMap = bg(b); let ix = 0;
    for (const [k, c] of aMap) ix += Math.min(c, bMap.get(k) ?? 0);
    return (2 * ix) / (a.length - 1 + b.length - 1);
}
async function getSpamConfig(guildId) { const cfg = await getConfig(guildId); return { enabled: true, count: 5, windowMs: 10_000, timeoutMs: 10 * 60 * 1000, timeoutDisplay: '10m', deleteMsg: true, similarityThreshold: 0.7, ...cfg.spamProt }; }
async function handleSpam(message, matchedMessages, spc) {
    const { guild, author, channel } = message, guildId = guild.id, key = `${guildId}-${author.id}`;
    if (spamCooldown.has(key)) return;
    spamCooldown.add(key); setTimeout(() => spamCooldown.delete(key), 5000);
    const botMember = guild.members.me, canDelete = spc.deleteMsg && botMember.permissionsIn(channel).has(PermissionFlagsBits.ManageMessages);
    if (canDelete) {
        // Skip messages that have reactions — may be pinned/community content
        const idsToDelete = matchedMessages.filter(m => !m.hasReactions).map(m => m.msgId);
        if (idsToDelete.length) channel.bulkDelete(idsToDelete).catch(async () => {
            for (const id of idsToDelete) { const msg = await channel.messages.fetch(id).catch(() => null); if (msg) msg.delete().catch(() => {}); }
        });
    }
    let timedOut = false;
    if (spc.timeoutMs && botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        const member = guild.members.cache.get(author.id) ?? await guild.members.fetch(author.id).catch(() => null);
        if (member && !member.permissions.has(PermissionFlagsBits.Administrator)) { await member.timeout(spc.timeoutMs, 'Spam detection').catch(() => {}); timedOut = true; }
    }
    const cfg = await getConfig(guildId);
    const E2 = (c, t) => new EmbedBuilder().setColor(c).setTitle(t).setTimestamp();
    channel.send({ embeds: [E2('#ff6600','Spam Detected').setDescription(`${author}'s repeated messages were removed.`).addFields({ name: 'Messages Removed', value: `${matchedMessages.length}`, inline: true }, ...(timedOut ? [{ name: 'Consequence', value: `Timed out for ${spc.timeoutDisplay}`, inline: true }] : []))] }).catch(() => {});
    if (cfg.warnDm !== false) author.send({ embeds: [E2('#ff6600','Your messages were removed').setDescription(`You were detected as spamming in **${guild.name}**.`).addFields(...(timedOut ? [{ name: 'Consequence', value: `Timed out for ${spc.timeoutDisplay}`, inline: true }] : [])).setFooter({ text: 'If you believe this is a mistake, contact a moderator' })] }).catch(() => {});
    logMod(guild, guildId, E2('#ff6600','Spam Auto-Removed').addFields({ name: 'User', value: `${author} (${author.tag})`, inline: true }, { name: 'Channel', value: `${channel}`, inline: true }, { name: 'Messages Removed', value: `${matchedMessages.length}`, inline: true }, ...(timedOut ? [{ name: 'Timeout', value: spc.timeoutDisplay, inline: true }] : []), { name: 'Content', value: matchedMessages[0]?.content?.slice(0, 200) || '(empty)' }));
    addHistory(guildId, author.id, { guildId, userId: author.id, userTag: author.tag, type: 'spam_remove', reason: `Spam: ${matchedMessages.length}x`, issuedBy: client.user.tag, issuedAt: Date.now() });
}

// ── Warning timers ─────────────────────────────────────────────────────────
const warningTimers = new Map(), pendingUnwarns = new Map(), banTimers = new Map();
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
async function handleWarningExpiry(key, guildId, userId, roleId, channelId) {
    const w = activeWarnings.get(key);
    try {
        const guild = client.guilds.cache.get(guildId); if (!guild) return;
        const member = await guild.members.fetch(userId).catch(() => null), role = guild.roles.cache.get(roleId);
        if (member && role && member.roles.cache.has(roleId)) {
            await member.roles.remove(role);
            member.user.send({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('Warning Expired').setDescription(`Your warning in **${guild.name}** has expired and the role has been removed.`).addFields({ name: 'Warning Level', value: `${w?.level ?? 'Unknown'}`, inline: true }, { name: 'Role Removed', value: role.name, inline: true }).setFooter({ text: 'You no longer carry this warning role' }).setTimestamp()] }).catch(() => {});
            const ch = guild.channels.cache.get(channelId);
            if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('Warning Expired').setDescription(`<@${userId}>'s warning has expired and the role has been removed.`).setTimestamp()] });
        }
    } catch (e) {
        console.error(`Failed to remove role: ${e}`);
        try { const ch = client.guilds.cache.get(guildId)?.channels.cache.get(channelId); if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('Warning Removal Failed').setDescription(`Could not remove role from <@${userId}>. Check bot permissions.`).setTimestamp()] }); } catch {}
    }
    if (w) addHistory(guildId, userId, { ...w, endedAt: Date.now(), endReason: 'expired' });
    warningTimers.delete(key); deleteWarning(key);
}
function scheduleWarningRemoval(key, guildId, userId, roleId, expiresAt, channelId) {
    const t = expiresAt - Date.now();
    if (t <= 0) return handleWarningExpiry(key, guildId, userId, roleId, channelId);
    warningTimers.set(key, setTimeout(() => handleWarningExpiry(key, guildId, userId, roleId, channelId), t));
}
function scheduleBanExpiry(guildId, userId, userTag, expiresAt, reason) {
    const t = expiresAt - Date.now(); if (t <= 0) return;
    const key = `${guildId}-${userId}`;
    banTimers.set(key, setTimeout(async () => {
        banTimers.delete(key);
        try {
            const guild = client.guilds.cache.get(guildId); if (!guild) return;
            const ban = await guild.bans.fetch(userId).catch(() => null); if (!ban) return;
            await guild.members.unban(userId, 'Timed ban expired');
            addHistory(guildId, userId, { guildId, userId, userTag, type: 'unban', reason: 'Timed ban expired', issuedBy: client.user.tag, issuedAt: Date.now() });
            logMod(guild, guildId, new EmbedBuilder().setColor('#00ff00').setTitle('Timed Ban Expired').addFields({ name: 'User', value: `${userTag} (${userId})`, inline: true }, { name: 'Original Reason', value: reason }).setTimestamp());
        } catch (e) { console.error('Ban expiry failed:', e.message); }
    }, t));
}
async function applyWarning(guild, member, user, guildId, level, reason, channelId, issuedByTag) {
    const cfg = await getConfig(guildId), lc = cfg.levels[level], role = guild.roles.cache.get(lc?.roleId);
    if (!lc || !role) return { error: `Level ${level} config or role not found.` };
    if (role.position >= guild.members.me.roles.highest.position) return { error: `Role hierarchy: my role must be above ${role.name}.` };
    await member.roles.add(role);
    if (cfg.warnDm !== false) user.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ You Received a Warning').setDescription(`You have been warned in **${guild.name}**.`).addFields({ name: 'Warning Level', value: `${level}`, inline: true }, { name: 'Duration', value: lc.durationDisplay || 'Unknown', inline: true }, { name: 'Reason', value: reason }).setFooter({ text: `Use /mywarnings in ${guild.name} to check when this warning expires` }).setTimestamp()] }).catch(() => {});
    const base = { guildId, userId: user.id, userTag: user.tag, roleId: role.id, roleName: role.name, level, reason, issuedBy: issuedByTag, issuedAt: Date.now() };
    const key = `${guildId}-${user.id}-${level}-${Date.now()}`;
    if (!lc.isForever) { const expiresAt = Date.now() + lc.durationMs; saveWarning(key, { ...base, expiresAt, channelId, isForever: false }); scheduleWarningRemoval(key, guildId, user.id, role.id, expiresAt, channelId); }
    else saveWarning(key, { ...base, expiresAt: null, channelId, isForever: true });
    return { success: true, role, config: lc };
}
async function checkEscalation(guild, member, user, guildId, level, channelId, issuedByTag) {
    const cfg = await getConfig(guildId), esc = cfg.escalation ?? {}, cap = esc.cap, nextLevel = level + 1;
    if (cap != null && nextLevel > cap) return { atCap: true, cap };
    const count = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === user.id && w.level === level).length;
    const toCfg = esc.timeouts?.[nextLevel];
    if (toCfg?.threshold != null) {
        if (count < toCfg.threshold) return { counted: true, count, threshold: toCfg.threshold };
        if (!cfg.levels[nextLevel]) return { noNextLevel: true, nextLevel };
        const r = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
        if (r.error) return { escalationError: r.error };
        await member.timeout(toCfg.durationMs, `Auto-escalated to Level ${nextLevel}`).catch(() => {});
        user.send({ embeds: [new EmbedBuilder().setColor('#ff6600').setTitle('⚠️ You Have Been Timed Out').setDescription(`You were auto-timed-out in **${guild.name}** upon reaching Warning Level ${nextLevel}.`).addFields({ name: 'Timeout Duration', value: toCfg.durationDisplay, inline: true }).setTimestamp()] }).catch(() => {});
        return { escalated: true, nextLevel, role: r.role, config: r.config, hitCap: cap != null && nextLevel === cap, timedOut: true, timeoutDisplay: toCfg.durationDisplay };
    }
    const threshold = esc.thresholds?.[level]; if (!threshold) return null;
    if (count < threshold) return { counted: true, count, threshold };
    if (!cfg.levels[nextLevel]) return { noNextLevel: true, nextLevel };
    const r = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
    if (r.error) return { escalationError: r.error };
    return { escalated: true, nextLevel, role: r.role, config: r.config, hitCap: cap != null && nextLevel === cap, timedOut: false };
}

// ── Keep-alive ─────────────────────────────────────────────────────────────
function keepAlive() {
    const ping = () => { const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`; fetch(`${url}/health`).then(() => console.log('🏓 Keep-alive ping')).catch(() => {}); };
    setTimeout(ping, 5000); setInterval(ping, 14 * 60 * 1000);
}

// ── Warnlist / Help ────────────────────────────────────────────────────────
function buildWarnlistEmbed(guildId, page) {
    const all = [...activeWarnings.values()].filter(w => w.guildId === guildId), byUser = {};
    for (const w of all) { byUser[w.userId] ??= []; byUser[w.userId].push(w); }
    const userIds = Object.keys(byUser), total = Math.max(1, Math.ceil(userIds.length / 10));
    page = Math.max(0, Math.min(page, total - 1));
    const embed = new EmbedBuilder().setColor('#FFA500').setTitle(`Active Warnings (${all.length})`).setTimestamp().setFooter({ text: total > 1 ? `Page ${page + 1} of ${total}` : `${userIds.length} user(s) warned` });
    if (!userIds.length) return { embed: embed.setDescription('No active warnings in this server.'), totalPages: total, page };
    for (const uid of userIds.slice(page * 10, (page + 1) * 10)) {
        const w0 = byUser[uid][0];
        embed.addFields({ name: w0.userTag || `<@${uid}>`, value: byUser[uid].map(w => `• Level ${w.level} — ${w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt / 1000)}:R>`}`).join('\n') });
    }
    return { embed, totalPages: total, page };
}
function warnlistRow(page, total, guildId) {
    const refresh = new ButtonBuilder().setCustomId(`wl_${page}_${guildId}`).setLabel('↻ Refresh').setStyle(ButtonStyle.Secondary);
    if (total <= 1) return [new ActionRowBuilder().addComponents(refresh)];
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wl_${page - 1}_${guildId}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0), refresh, new ButtonBuilder().setCustomId(`wl_${page + 1}_${guildId}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page === total - 1))];
}
const refreshBtn = (id) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel('↻ Refresh').setStyle(ButtonStyle.Secondary));
const customIdMatches = (id, prefixes) => prefixes.some(p => id.startsWith(p));

async function buildScamListEmbed(guildId) {
    const hashes = await getScamHashes(guildId), spc = await getScamProtConfig(guildId);
    if (!hashes.length) return { embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('Scam Image Registry').setDescription('No scam images registered. Use `/scam add` to add one.')], components: [] };
    const embed = new EmbedBuilder().setColor('#ff0000').setTitle('Scam Image Registry').setTimestamp().setDescription(`**${hashes.length}** image${hashes.length>1?'s':''} registered — detection **${spc.enabled?'enabled':'disabled'}**`).addFields({ name: 'Threshold', value: `${spc.threshold} (Hamming distance)`, inline: true }, { name: 'On Detection', value: [spc.deleteMsg?'Delete message':null, spc.timeoutMs?`Timeout ${spc.timeoutDisplay}`:null].filter(Boolean).join(' + ')||'No action', inline: true });
    for (const h of hashes.slice(0,20)) embed.addFields({ name: `ID ${h.id} — ${h.label}`, value: `Hash: \`${h.hash}\` · Added by ${h.addedBy} <t:${Math.floor(h.addedAt/1000)}:R>` });
    if (hashes.length > 20) embed.setFooter({ text: `Showing first 20 of ${hashes.length}` });
    const components = [refreshBtn(`scamlist_refresh_${guildId}`)];
    components.unshift(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`scamlist_remove_${guildId}`).setPlaceholder('Remove a scam image…').addOptions(hashes.slice(0,25).map(h => ({ label: `ID ${h.id} — ${h.label}`.slice(0,100), value: `${h.id}` })))));
    return { embeds: [embed], components };
}

async function buildLogChannelEmbed(guildId) {
    const cfg = await getConfig(guildId);
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Mod-Log Channel').setTimestamp()
        .setDescription(cfg.logChannelId ? `Mod actions are currently logged to <#${cfg.logChannelId}>.` : 'No mod-log channel is currently set.');
    const row1 = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`logchannel_select_${guildId}`).setPlaceholder('Select a channel…').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1));
    const components = [row1];
    if (cfg.logChannelId) components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`removelogchannel_${guildId}`).setLabel('Remove Log Channel').setStyle(ButtonStyle.Danger)));
    return { embeds: [embed], components };
}

async function buildNoteViewEmbed(guildId, user) {
    const notes = await getNotes(guildId, user.id);
    if (!notes.length) return { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle(`Notes — ${user.tag}`).setDescription('No notes found for this user.')], components: [] };
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle(`Notes — ${user.tag}`).setTimestamp().setDescription(`${notes.length} note${notes.length>1?'s':''} on record.`);
    const shown = notes.slice(-10);
    for (const n of shown) embed.addFields({ name: `ID: ${n.id} — <t:${Math.floor(n.addedAt/1000)}:d> — ${n.addedBy}`, value: n.text });
    if (notes.length > 10) embed.setFooter({ text: `Showing last 10 of ${notes.length} notes` });
    const components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`noteview_remove_${guildId}_${user.id}`).setPlaceholder('Remove a note…').addOptions(shown.slice(0,25).map(n => ({ label: `ID ${n.id} — ${n.text.slice(0,80)}`.slice(0,100), value: `${n.id}` }))))];
    return { embeds: [embed], components };
}async function buildConfigViewEmbed(guildId) {
    const cfg = await getConfig(guildId);
    if (!cfg.levels || !Object.keys(cfg.levels).length) return { embeds: [new EmbedBuilder().setColor('#0099ff').setTitle('Warning Configuration').setDescription('📋 No warning levels configured yet.')], components: [] };
    const embed = new EmbedBuilder().setColor('#0099ff').setTitle('Warning Configuration').setTimestamp(), normalLevels = {}, timeoutLevels = {};
    for (const [lvl, d] of Object.entries(cfg.levels)) { if (d.isTimeoutLevel) timeoutLevels[lvl] = d; else normalLevels[lvl] = d; }
    if (Object.keys(normalLevels).length) for (const [lvl, d] of Object.entries(normalLevels)) embed.addFields({ name: `Level ${lvl}`, value: `Role: <@&${d.roleId}>\nDuration: ${d.durationDisplay}`, inline: true });
    if (Object.keys(timeoutLevels).length) embed.addFields({ name: '⏱️ Timeout Levels (Auto-Escalation)', value: Object.entries(timeoutLevels).sort(([a],[b])=>a-b).map(([lvl,t])=>`• **Level ${lvl}** — Timeout: **${t.timeoutDisplay}**`).join('\n'), inline: false });
    embed.addFields({ name: 'Notifications', value: cfg.warnDm === false ? 'Disabled' : 'Enabled', inline: true });
    const components = [refreshBtn(`configview_refresh_${guildId}`)];
    const levelKeys = Object.keys(cfg.levels);
    if (levelKeys.length) components.unshift(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`configview_removelevel_${guildId}`).setPlaceholder('Remove a warning level…').addOptions(levelKeys.slice(0,25).map(lvl => ({ label: `Level ${lvl}${cfg.levels[lvl].roleName ? ` — ${cfg.levels[lvl].roleName}` : ''}`, value: lvl })))));
    return { embeds: [embed], components };
}

async function buildEscalationViewEmbed(guildId) {
    const cfg = await getConfig(guildId), esc = cfg.escalation ?? {}, th = esc.thresholds ?? {}, to = esc.timeouts ?? {};
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Escalation Configuration').setTimestamp();
    if (!Object.keys(th).length && !esc.cap && !Object.keys(to).length) embed.setDescription('No escalation rules configured. Use `/escalation set` to add thresholds.');
    else {
        if (Object.keys(th).length) embed.addFields({ name: 'Thresholds', value: Object.entries(th).sort(([a],[b])=>a-b).map(([l,t])=>`• **${t}x** Level ${l} → auto Level ${parseInt(l)+1}`).join('\n') });
        if (Object.keys(to).length) embed.addFields({ name: 'Timeouts on Escalation', value: Object.entries(to).sort(([a],[b])=>a-b).map(([l,t])=>`• ${t.threshold}x Level ${parseInt(l)-1} → auto Level ${l} + **${t.durationDisplay}** timeout`).join('\n') });
        embed.addFields({ name: 'Level Cap', value: esc.cap ? `Level **${esc.cap}**` : 'None' });
    }
    const components = [];
    const thKeys = Object.keys(th), toKeys = Object.keys(to);
    if (thKeys.length) components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`escview_removethreshold_${guildId}`).setPlaceholder('Remove a threshold…').addOptions(thKeys.slice(0,25).map(l => ({ label: `Level ${l} (${th[l]}x → Level ${parseInt(l)+1})`, value: l })))));
    if (toKeys.length) components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`escview_removetimeout_${guildId}`).setPlaceholder('Remove a timeout escalation…').addOptions(toKeys.slice(0,25).map(l => ({ label: `Level ${l} (${to[l].threshold}x → +${to[l].durationDisplay} timeout)`, value: l })))));
    const lastRow = [refreshBtn(`escalationview_refresh_${guildId}`).components[0]];
    if (esc.cap) lastRow.push(new ButtonBuilder().setCustomId(`escview_removecap_${guildId}`).setLabel('Remove Level Cap').setStyle(ButtonStyle.Danger));
    components.push(new ActionRowBuilder().addComponents(...lastRow));
    return { embeds: [embed], components };
}

const helpPages = {
    help_warn: new EmbedBuilder().setColor('#ff0000').setTitle('Warning Commands').addFields({ name: '/warning give', value: 'Issue a warning at a configured level. Requires a reason. Triggers escalation checks automatically.' }, { name: '/warning remove', value: 'Remove a warning from a user via a dropdown and confirm prompt.' }, { name: '/warning list', value: 'View all active warnings in the server, paginated 10 users per page.' }, { name: '/warning history', value: 'View the last 10 warning history entries for a specific user.' }, { name: '/mywarnings', value: 'Check your own active warnings and how long is left on each one.' }, { name: '/timeout give', value: 'Apply a Discord native timeout. Duration: `m:s`, `h:m:s`, or `d:h:m:s` (max 28 days).' }, { name: '/userinfo', value: "View a user's full moderation profile — warnings, kicks, bans, notes, and more." }).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_mod: new EmbedBuilder().setColor('#ff6600').setTitle('Moderation Commands').addFields({ name: '/kick', value: 'Kick a user. Sends a DM, logs to history, posts to mod-log.' }, { name: '/ban give', value: 'Ban a user. Optional timed ban with auto-unban. Optionally delete recent messages (0–7 days).' }, { name: '/ban remove', value: 'Unban a user by their ID. Logs to history and mod-log channel.' }, { name: '/timeout give / remove', value: 'Apply or remove a Discord native timeout. Duration: `m:s`, `h:m:s`, or `d:h:m:s` (max 28 days).' }, { name: '/userinfo', value: 'View account info, roles, active warnings, warn counts per level, kicks, bans, and notes for any user.' }).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_config: new EmbedBuilder().setColor('#00ff00').setTitle('Config Commands').addFields({ name: '/config set', value: 'Set up a warning level: assign a role and a duration (`m:s`, `h:m:s`, `d:h:m:s`, or `forever`).' }, { name: '/config view', value: 'View all configured warning levels, roles, durations, and notification status. Use the dropdown here to remove a level.' }, { name: '/config access', value: 'Choose which role can use moderation commands. Admins always have access.' }, { name: '/config logchannel', value: 'Opens a dropdown to select the mod-log channel where every mod action is automatically logged, with a button to remove it.' }, { name: '/config notifications', value: "Toggle whether users are DM'd when they receive a warning. Enabled by default." }).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_escalation: new EmbedBuilder().setColor('#ff9900').setTitle('Escalation Commands').addFields({ name: '/escalation set', value: 'Set a threshold: N warnings at level X → auto-escalate to level X+1.' }, { name: '/escalation cap', value: 'Set the maximum escalation level.' }, { name: '/escalation timeout', value: 'N warnings at level X → auto level X+1 + a timeout.' }, { name: '/escalation view', value: 'View all active escalation rules. Use the dropdowns/buttons here to remove thresholds, timeouts, or the level cap.' }).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_notes: new EmbedBuilder().setColor('#9b59b6').setTitle('Note Commands').addFields({ name: '/note add', value: 'Add a private mod note to a user. Not visible to the user.' }, { name: '/note remove', value: 'View all notes on a user, with timestamps and which mod added them. Use the dropdown here to remove a note.' }).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_storage: new EmbedBuilder().setColor('#5865F2').setTitle('Database Storage').setDescription('Police Bot uses PostgreSQL to store all data persistently. Nothing is lost on restarts.').addFields({ name: 'warnings', value: 'Active warnings with expiry timestamps, user IDs, role IDs, and channel IDs.' }, { name: 'history', value: 'Full mod history per server — every warn, kick, and ban.' }, { name: 'configs', value: 'Per-server config: warning levels, roles, durations, escalation rules, access role.' }, { name: 'notes', value: 'Private mod notes per user.' }, { name: 'scam_hashes / global_scam_hashes', value: 'Registered scam image hashes, per-guild and global.' }).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_features: new EmbedBuilder().setColor('#9b59b6').setTitle('Other Features').addFields({ name: 'Scam protection', value: 'Upload known scam images — any similar image posted is auto-removed.' }, { name: 'Spam protection', value: 'Detects repeated/similar messages and auto-removes with configurable timeouts.' }, { name: 'Rejoin protection', value: 'If a warned user leaves and rejoins, their warning roles are reapplied.' }, { name: 'Timer restoration', value: 'On bot restart, all active warning timers are restored from the database.' }, { name: '/invite', value: 'Get a pre-configured invite link with all required permissions.' }).setFooter({ text: 'Use the buttons to explore other categories' }),
};
const helpOverviewEmbed = () => new EmbedBuilder().setColor('#5865F2').setTitle('Police Bot').setDescription("I'm just your friendly neighbourhood policemen, but I do have some tricks up my sleeve. Press the buttons below to learn about my commands.").setFooter({ text: 'Mod commands require the configured access role or Administrator' });
function helpRows(active = '') {
    const p = (id, label, sec = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(active === id ? ButtonStyle.Success : sec ? ButtonStyle.Secondary : ButtonStyle.Primary);
    return [new ActionRowBuilder().addComponents(p('help_warn','Warnings'), p('help_mod','Moderation'), p('help_config','Config'), p('help_escalation','Escalation')), new ActionRowBuilder().addComponents(p('help_notes','Notes',true), p('help_storage','Storage',true), p('help_features','Features',true), ...(active ? [p('help_back','Back',true)] : []))];
}

// ── Bot ready ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`✅ Police bot online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Monitoring the security cameras', type: ActivityType.Watching }], status: 'online' });
    const commands = [
        new SlashCommandBuilder().setName('invite').setDescription('Get a link to invite this bot to another server'),
        new SlashCommandBuilder().setName('warning').setDescription('Manage warnings')
            .addSubcommand(s => s.setName('give').setDescription('Give a warning').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')))
            .addSubcommand(s => s.setName('remove').setDescription('Remove a warning').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('View all active warnings'))
            .addSubcommand(s => s.setName('history').setDescription('View warning history').addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
        new SlashCommandBuilder().setName('timeout').setDescription('Manage timeouts')
            .addSubcommand(s => s.setName('give').setDescription('Timeout a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('m:s / h:m:s / d:h:m:s').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')))
            .addSubcommand(s => s.setName('remove').setDescription('Remove a timeout').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason'))),
        new SlashCommandBuilder().setName('mywarnings').setDescription('Check your active warnings'),
        new SlashCommandBuilder().setName('kick').setDescription('Kick a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
        new SlashCommandBuilder().setName('ban').setDescription('Manage bans')
            .addSubcommand(s => s.setName('give').setDescription('Ban a user').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('Optional timed ban duration')).addIntegerOption(o => o.setName('delete_days').setDescription('Days of messages to delete (0-7)').setMinValue(0).setMaxValue(7)).addStringOption(o => o.setName('delete_messages').setDescription('Also delete messages in last X time after ban (e.g. 1:0:0 = 1 hour)')))
            .addSubcommand(s => s.setName('remove').setDescription('Unban a user').addStringOption(o => o.setName('user_id').setDescription('User ID').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason'))),
        new SlashCommandBuilder().setName('userinfo').setDescription('View user info and mod history').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
        new SlashCommandBuilder().setName('note').setDescription('Manage mod notes')
            .addSubcommand(s => s.setName('add').setDescription('Add a note').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('text').setDescription('Note content').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('View and remove notes').addUserOption(o => o.setName('user').setDescription('User').setRequired(true))),
        new SlashCommandBuilder().setName('config').setDescription('Configure the bot')
            .addSubcommand(s => s.setName('set').setDescription('Set up a warning level').addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('d:h:m:s or "forever"').setRequired(true)))
            .addSubcommand(s => s.setName('view').setDescription('View warning levels'))
            .addSubcommand(s => s.setName('access').setDescription('Set which role can use mod commands'))
            .addSubcommand(s => s.setName('logchannel').setDescription('Set or remove the mod-log channel'))
            .addSubcommand(s => s.setName('notifications').setDescription('Toggle DM notifications to users').addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable').setRequired(true))),
        new SlashCommandBuilder().setName('escalation').setDescription('Configure auto-escalation rules')
            .addSubcommand(s => s.setName('set').setDescription('Set escalation threshold').addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true)).addIntegerOption(o => o.setName('threshold').setDescription('Number of warnings to trigger').setRequired(true)))
            .addSubcommand(s => s.setName('cap').setDescription('Set max escalation level').addIntegerOption(o => o.setName('level').setDescription('Cap level').setRequired(true)))
            .addSubcommand(s => s.setName('timeout').setDescription('Configure timeout-escalation').addIntegerOption(o => o.setName('level').setDescription('Target level (>=2)').setRequired(true)).addIntegerOption(o => o.setName('threshold').setDescription('Warnings needed').setRequired(true)).addStringOption(o => o.setName('duration').setDescription('Timeout duration').setRequired(true)))
            .addSubcommand(s => s.setName('view').setDescription('View escalation configuration')),
        new SlashCommandBuilder().setName('help').setDescription('View all commands and features'),
        new SlashCommandBuilder().setName('scam').setDescription('Manage scam image protection')
            .addSubcommand(s => s.setName('add').setDescription('Register a scam image').addAttachmentOption(o => o.setName('image').setDescription('The scam image').setRequired(true)).addStringOption(o => o.setName('label').setDescription('Label').setRequired(true)))
            .addSubcommand(s => s.setName('list').setDescription('List registered scam images'))
            .addSubcommand(s => s.setName('config').setDescription('Configure scam protection').addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable')).addBooleanOption(o => o.setName('delete').setDescription('Delete scam messages')).addStringOption(o => o.setName('timeout').setDescription('Timeout duration or "none"')).addIntegerOption(o => o.setName('threshold').setDescription('Similarity threshold 0-20').setMinValue(0).setMaxValue(20))),
        new SlashCommandBuilder().setName('messages').setDescription('Bulk delete messages')
            .addSubcommand(s => s.setName('delete').setDescription('Delete messages in this channel')
                .addUserOption(o => o.setName('user').setDescription('Only delete messages from this user'))
                .addIntegerOption(o => o.setName('count').setDescription('Max number of messages to delete (default 100)').setMinValue(1).setMaxValue(1000))
                .addStringOption(o => o.setName('within').setDescription('Only delete messages sent in the last X time (e.g. 1:0:0 = 1 hour)')))
            .addSubcommand(s => s.setName('purge').setDescription('Delete all messages in all channels in the last X time')
                .addStringOption(o => o.setName('within').setDescription('Time window (e.g. 1:0:0 = 1 hour)').setRequired(true))
                .addUserOption(o => o.setName('user').setDescription('Only purge messages from this user'))),
        new SlashCommandBuilder().setName('spam').setDescription('Configure spam protection')
            .addSubcommand(s => s.setName('config').setDescription('Configure spam detection').addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable')).addBooleanOption(o => o.setName('delete').setDescription('Delete spam messages')).addIntegerOption(o => o.setName('count').setDescription('Messages to trigger (default 5)').setMinValue(2).setMaxValue(20)).addIntegerOption(o => o.setName('window').setDescription('Time window in seconds (default 10)').setMinValue(3).setMaxValue(60)).addStringOption(o => o.setName('timeout').setDescription('Timeout duration or "none"')).addIntegerOption(o => o.setName('similarity').setDescription('Similarity % (default 70)').setMinValue(50).setMaxValue(100)))
            .addSubcommand(s => s.setName('view').setDescription('View spam protection settings')),
    ].map(c => c.toJSON());
    client.application.commands.set(commands);
    console.log('✅ Commands registered');
    try {
        await initDB();
        const [wRes, cRes] = await Promise.all([pool.query('SELECT key, data FROM warnings'), pool.query('SELECT guild_id, data FROM configs')]);
        for (const { key, data } of wRes.rows) activeWarnings.set(key, data);
        for (const { guild_id, data } of cRes.rows) configCache.set(guild_id, data);
        for (const [key, w] of activeWarnings.entries()) if (!w.isForever) scheduleWarningRemoval(key, w.guildId, w.userId, w.roleId, w.expiresAt, w.channelId);
        const shRes = await pool.query('SELECT guild_id, id, hash, label, added_by, added_at FROM scam_hashes ORDER BY id');
        for (const r of shRes.rows) { const arr = scamHashCache.get(r.guild_id) ?? []; arr.push({ id: r.id, hash: r.hash, label: r.label, addedBy: r.added_by, addedAt: r.added_at }); scamHashCache.set(r.guild_id, arr); }
        await getGlobalScamHashes();
        console.log(`✅ Loaded scam hashes for ${scamHashCache.size} guild(s), ${globalScamHashCache?.length ?? 0} global`);
        const banRes = await pool.query("SELECT guild_id, user_id, data FROM history WHERE data->>'type' = 'ban' AND data->>'expiresAt' IS NOT NULL ORDER BY id DESC");
        const seenBans = new Set();
        for (const { guild_id, user_id, data } of banRes.rows) {
            const bkey = `${guild_id}-${user_id}`; if (seenBans.has(bkey)) continue; seenBans.add(bkey);
            const unbanRes = await pool.query("SELECT id FROM history WHERE guild_id = $1 AND user_id = $2 AND data->>'type' = 'unban' AND id > (SELECT id FROM history WHERE guild_id = $1 AND user_id = $2 AND data = $3::jsonb LIMIT 1) LIMIT 1", [guild_id, user_id, JSON.stringify(data)]);
            if (!unbanRes.rows.length && data.expiresAt > Date.now()) scheduleBanExpiry(guild_id, user_id, data.userTag, data.expiresAt, data.reason);
        }
    } catch (e) { console.error('❌ DB init failed:', e.message); }
    keepAlive();
});

client.on('guildCreate', async guild => {
    const cfg = await getConfig(guild.id); if (!cfg.levels) saveConfig(guild.id, { levels: {} });
    try {
        const logs = await guild.fetchAuditLogs({ type: 28, limit: 5 });
        const entry = logs.entries.find(e => e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 60000);
        if (guild.systemChannel) guild.systemChannel.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('👋 Thanks for adding Police Bot!').setDescription(`${entry?.executor?.id ? `<@${entry.executor.id}>, please` : 'An administrator should'} run \`/config access\` to set up command permissions.\n\n**Quick Start:**\n1. \`/config access\` — set the moderator role\n2. \`/config set\` — set up warning levels\n3. \`/warn\` — start moderating!`).setFooter({ text: 'Use /help to see all commands' })] }).catch(() => {});
    } catch (e) { console.error('guildCreate error:', e); }
});

client.on('guildMemberAdd', async member => {
    const userWarnings = [...activeWarnings.entries()].filter(([, w]) => w.guildId === member.guild.id && w.userId === member.id);
    if (!userWarnings.length) return;
    for (const [, w] of userWarnings) { const role = member.guild.roles.cache.get(w.roleId); if (role) await member.roles.add(role).catch(() => {}); }
    member.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ Warning Reinstated').setDescription(`Your active warning(s) in **${member.guild.name}** have been reapplied because you rejoined.`).addFields({ name: 'Active Warnings', value: userWarnings.map(([, w]) => `Level ${w.level} — ${w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt / 1000)}:R>`}`).join('\n') }).setTimestamp()] }).catch(() => {});
});

// ── Scam detection ─────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    const attachments = [...message.attachments.values()].filter(a => /\.(png|jpg|jpeg|gif|webp)$/i.test(a.name ?? '') || a.contentType?.startsWith('image/'));
    if (!attachments.length) return;
    const guildId = message.guild.id, spc = await getScamProtConfig(guildId);
    if (!spc.enabled) return;
    const hashes = await getScamHashes(guildId), globalHashes = await getGlobalScamHashes();
    if (!hashes.length && !globalHashes.length) return;
    const botMember = message.guild.members.me;
    const canTimeout = botMember.permissions.has(PermissionFlagsBits.ModerateMembers);
    for (const att of attachments) {
        let buffer; try { buffer = await fetchImageBuffer(att.url); } catch (e) { console.error('scam: fetch failed:', e.message); continue; }
        let imgHash; try { imgHash = await dHash(buffer); } catch (e) { console.error('scam: hash failed:', e.message); continue; }
        let match = null, isGlobal = false, matchDistance = 0;
        for (const entry of globalHashes) { const dist = hammingDistance(imgHash, entry.hash); if (dist <= 10) { match = entry; isGlobal = true; matchDistance = dist; break; } }
        if (!match) { for (const entry of hashes) { const dist = hammingDistance(imgHash, entry.hash); if (dist <= spc.threshold) { match = entry; matchDistance = dist; break; } } }
        if (!match) continue;
        console.log(`🚨 ${isGlobal ? '[GLOBAL] ' : ''}Scam: ${message.author.tag} in ${guildId} ("${match.label}")`);
        const cfg2 = await getConfig(guildId);
        const shouldDelete = isGlobal ? true : spc.deleteMsg, shouldTimeout = isGlobal ? true : !!spc.timeoutMs;
        const timeoutMs = isGlobal ? (spc.timeoutMs ?? 5 * 60 * 1000) : spc.timeoutMs, timeoutDisplay = isGlobal ? (spc.timeoutDisplay ?? '5m') : spc.timeoutDisplay;
        const canDelete = shouldDelete && botMember.permissionsIn(message.channel).has(PermissionFlagsBits.ManageMessages);
        if (shouldDelete) { if (canDelete) message.delete().catch(e => console.error('scam: delete failed:', e.message)); else console.error(`scam: cannot delete in ${message.channel.id} — missing ManageMessages`); }
        let timedOut = false;
        if (shouldTimeout && timeoutMs && canTimeout) {
            const member = message.guild.members.cache.get(message.author.id) ?? await message.guild.members.fetch(message.author.id).catch(() => null);
            if (member && !member.permissions.has(PermissionFlagsBits.Administrator)) { await member.timeout(timeoutMs, `${isGlobal ? '[Global] ' : ''}Scam: ${match.label}`).catch(() => {}); timedOut = true; }
        }
        const E2 = (c, t) => new EmbedBuilder().setColor(c).setTitle(t).setTimestamp();
        const logCh = cfg2.logChannelId && message.guild.channels.cache.get(cfg2.logChannelId);
        message.channel.send({ embeds: [E2('#ff0000','Scam Image Detected').setDescription(`${message.author}'s message was removed — it matched a known scam image.`).addFields({ name: 'Matched', value: match.label, inline: true }, ...(timedOut ? [{ name: 'Consequence', value: `Timed out for ${timeoutDisplay}`, inline: true }] : []))] }).catch(() => {});
        if (cfg2.warnDm !== false) message.author.send({ embeds: [E2('#ff0000','Your message was removed').setDescription(`A message you sent in **${message.guild.name}** was detected as a known scam image and removed.`).addFields({ name: 'Matched Pattern', value: match.label, inline: true }, ...(timedOut ? [{ name: 'Consequence', value: `You have been timed out for ${timeoutDisplay}`, inline: true }] : [])).setFooter({ text: 'If you believe this is a mistake, contact a moderator' })] }).catch(() => {});
        if (logCh) {
            await logCh.send({ embeds: [E2('#ff0000',`Scam Image Auto-Removed${isGlobal ? ' (Global)' : ''}`).addFields({ name: 'User', value: `${message.author} (${message.author.tag})`, inline: true }, { name: 'Channel', value: `${message.channel}`, inline: true }, { name: 'Matched', value: `${match.label}${isGlobal ? ' *(global)*' : ''}`, inline: true }, ...(timedOut ? [{ name: 'Timeout', value: timeoutDisplay, inline: true }] : []), { name: 'Message Deleted', value: (shouldDelete && canDelete) ? 'Yes' : shouldDelete ? 'No (missing ManageMessages)' : 'No', inline: true }, { name: 'Match Distance', value: matchDistance === 0 ? 'Exact' : `${matchDistance} bit${matchDistance !== 1 ? 's' : ''} different`, inline: true })] }).catch(() => {});
            if (matchDistance > 0) await logCh.send({ embeds: [E2('#ff9900','⚠️ Near-Match — Please Review').setDescription(`This image was **similar but not identical** to the registered scam hash for **${match.label}**.\nIf this is a false positive, use \`/scam list\` to remove it or adjust the threshold with \`/scam config threshold\`.`).setImage(att.url).addFields({ name: 'Similarity', value: `${matchDistance} bit${matchDistance !== 1 ? 's' : ''} different (threshold: ${isGlobal ? 10 : spc.threshold})`, inline: true })] }).catch(() => {});
        }
        addHistory(guildId, message.author.id, { guildId, userId: message.author.id, userTag: message.author.tag, type: 'scam_remove', reason: `Scam: ${match.label}`, issuedBy: client.user.tag, issuedAt: Date.now() });
        break;
    }
});

// ── Spam detection ─────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot || !message.content) return;
    const guildId = message.guild.id, spc2 = await getSpamConfig(guildId);
    if (!spc2.enabled) return;
    const spamKey = `${guildId}-${message.author.id}`, now = Date.now();
    const fresh = (spamTracker.get(spamKey) ?? []).filter(e => now - e.ts < spc2.windowMs);
    fresh.push({ content: normalise(message.content), msgId: message.id, channelId: message.channel.id, ts: now, hasReactions: message.reactions.cache.size > 0 });
    spamTracker.set(spamKey, fresh);
    const latest = normalise(message.content), matches = fresh.filter(e => e.channelId === message.channel.id && similarity(e.content, latest) >= spc2.similarityThreshold);
    if (matches.length >= spc2.count) { spamTracker.delete(spamKey); await handleSpam(message, matches, spc2); }
});

// ── Interactions ───────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isStringSelectMenu() && customIdMatches(interaction.customId, ['configview_removelevel_','escview_removethreshold_','escview_removetimeout_','scamlist_remove_','noteview_remove_'])) {
        if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const { customId, values } = interaction, value = values[0];
        await interaction.deferUpdate();
        if (customId.startsWith('configview_removelevel_')) {
            const guildId = customId.slice(23), cfg = await getConfig(guildId);
            delete cfg.levels?.[value]; saveConfig(guildId, cfg);
            const { embeds, components } = await buildConfigViewEmbed(guildId);
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('escview_removethreshold_')) {
            const guildId = customId.slice(25), cfg = await getConfig(guildId);
            delete cfg.escalation?.thresholds?.[value]; saveConfig(guildId, cfg);
            const { embeds, components } = await buildEscalationViewEmbed(guildId);
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('escview_removetimeout_')) {
            const guildId = customId.slice(22), cfg = await getConfig(guildId);
            delete cfg.escalation?.timeouts?.[value]; saveConfig(guildId, cfg);
            const { embeds, components } = await buildEscalationViewEmbed(guildId);
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('scamlist_remove_')) {
            const guildId = customId.slice(16);
            await removeScamHash(guildId, parseInt(value));
            const { embeds, components } = await buildScamListEmbed(guildId);
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('noteview_remove_')) {
            const parts = customId.slice(16).split('_'), guildId = parts[0], userId = parts[1];
            await deleteNote(guildId, userId, parseInt(value));
            const user = await interaction.client.users.fetch(userId).catch(() => null);
            if (!user) return interaction.editReply({ content: '❌ Could not fetch user.', embeds: [], components: [] });
            const { embeds, components } = await buildNoteViewEmbed(guildId, user);
            return interaction.editReply({ embeds, components });
        }
        return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('unwarn_select_')) {
        if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const pendingId = interaction.customId.slice(14), pending = pendingUnwarns.get(pendingId);
        if (!pending) return interaction.update({ content: '❌ Confirmation expired.', embeds: [], components: [] });
        if (interaction.user.id !== pending.modId) return interaction.reply({ content: '❌ Only the moderator who ran this command can use this.', flags: [MessageFlags.Ephemeral] });
        const selectedKey = interaction.values[0], w = activeWarnings.get(selectedKey);
        if (!w) return interaction.update({ content: '❌ Warning no longer exists.', embeds: [], components: [] });
        pendingUnwarns.set(pendingId, { ...pending, selectedKey, roleId: w.roleId, level: w.level });
        const role = interaction.guild.roles.cache.get(w.roleId);
        await interaction.update({ embeds: [new EmbedBuilder().setColor('#FFA500').setTitle('⚠️ Confirm Unwarn').setDescription(`Remove **Level ${w.level}** warning from <@${pending.targetUserId}>?`).addFields({ name: 'Role', value: role ? `${role}` : w.roleName, inline: true }, { name: 'Issued', value: `<t:${Math.floor(w.issuedAt/1000)}:R>`, inline: true }, { name: 'Reason', value: w.reason || 'No reason' }).setFooter({ text: 'Expires in 60 seconds' }).setTimestamp()], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`unwarn_confirm_${pendingId}`).setLabel('Confirm').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`unwarn_cancel_${pendingId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
        return;
    }
    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('logchannel_select_')) {
        if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const guildId = interaction.customId.slice(19), channel = interaction.channels.first();
        if (!channel) return interaction.reply({ content: '❌ No channel selected.', flags: [MessageFlags.Ephemeral] });
        await interaction.deferUpdate();
        const cfg = await getConfig(guildId); cfg.logChannelId = channel.id; saveConfig(guildId, cfg);
        const { embeds, components } = await buildLogChannelEmbed(guildId);
        return interaction.editReply({ embeds, components });
    }
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('access_role_')) {
        const guildId = interaction.customId.replace('access_role_', '');
        if (guildId !== interaction.guild.id) return interaction.reply({ content: '❌ Invalid interaction.', flags: [MessageFlags.Ephemeral] });
        const role = interaction.roles.first();
        if (!role) return interaction.reply({ content: '❌ No role selected.', flags: [MessageFlags.Ephemeral] });
        if (role.id === interaction.guild.id) return interaction.update({ content: '❌ Cannot use @everyone.', components: [] });
        if (role.managed) return interaction.update({ content: '❌ Cannot use managed/bot roles.', components: [] });
        const cfg = await getConfig(guildId); cfg.accessRoleId = role.id; saveConfig(guildId, cfg);
        await interaction.update({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('Access Control Updated').setDescription(`Members with the ${role} role can now use moderation commands.\n\n*Server administrators always have access.*`).setTimestamp()], components: [] });
        return;
    }
    if (interaction.isButton()) {
        const { customId } = interaction;
        if (customId.startsWith('help_') && customId !== 'help_back') { const embed = helpPages[customId]; if (!embed) return; return interaction.update({ embeds: [embed], components: helpRows(customId) }); }
        if (customId === 'help_back') return interaction.update({ embeds: [helpOverviewEmbed()], components: helpRows() });
        if (customId.startsWith('wl_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            const parts = customId.split('_'), page = parseInt(parts[1]), guildId = parts.slice(2).join('_');
            const { embed, totalPages, page: p } = buildWarnlistEmbed(guildId, page);
            return interaction.update({ embeds: [embed], components: warnlistRow(p, totalPages, guildId) });
        }
        if (customId.startsWith('mywarnings_refresh_')) {
            const ownerId = customId.slice(19);
            if (interaction.user.id !== ownerId) return interaction.reply({ content: '❌ This button is not for you.', flags: [MessageFlags.Ephemeral] });
            const guildId = interaction.guild.id, userWarnings = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === interaction.user.id);
            if (!userWarnings.length) return interaction.update({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('Your Active Warnings').setDescription('You have no active warnings!').setTimestamp()], components: [] });
            const cfg = await getConfig(guildId), embed = new EmbedBuilder().setColor('#FFA500').setTitle('Your Active Warnings').setDescription(`You have ${userWarnings.length} active warning${userWarnings.length>1?'s':''}`).setFooter({ text: 'Warnings are automatically removed when they expire' }).setTimestamp();
            for (const w of userWarnings) {
                const lc = cfg.levels?.[w.level], name = `Level ${w.level} — ${lc?.roleName||'Unknown Role'}`;
                if (w.isForever) embed.addFields({ name, value: ' **Duration:** Forever\n **Status:** Permanent' });
                else { const t = w.expiresAt - Date.now(); embed.addFields({ name, value: t <= 0 ? 'Expired (will be removed shortly)' : (() => { const s = Math.floor(t/1000); return `**Time Left:** ${formatDuration(Math.floor(s/86400),Math.floor((s%86400)/3600),Math.floor((s%3600)/60),s%60)}\n**Expires:** <t:${Math.floor(w.expiresAt/1000)}:F>`; })() }); }
            }
            return interaction.update({ embeds: [embed], components: [refreshBtn(customId)] });
        }
        if (customId.startsWith('userinfo_refresh_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            const parts = customId.slice(17).split('_'), userId = parts[0], guildId = parts[1];
            await interaction.deferUpdate();
            const user = await interaction.client.users.fetch(userId).catch(() => null);
            if (!user) return interaction.editReply({ content: '❌ Could not fetch user.', embeds: [], components: [] });
            const [member, history, notes] = await Promise.all([interaction.guild.members.fetch(userId).catch(() => null), getAllHistory(guildId, userId), getNotes(guildId, userId)]);
            const embed = new EmbedBuilder().setColor('#5865F2').setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 256 }) }).setThumbnail(user.displayAvatarURL({ size: 256 })).addFields({ name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp/1000)}:F>\n<t:${Math.floor(user.createdTimestamp/1000)}:R>`, inline: true }, { name: 'Joined Server', value: member ? `<t:${Math.floor(member.joinedTimestamp/1000)}:F>\n<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : '*Not in server*', inline: true }).setTimestamp();
            const activeUserWarnings = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === userId), activeByLevel = {};
            for (const w of activeUserWarnings) activeByLevel[w.level] = (activeByLevel[w.level] || 0) + 1;
            embed.addFields({ name: 'Active Warnings', value: Object.keys(activeByLevel).length ? Object.entries(activeByLevel).sort(([a],[b])=>a-b).map(([l,c])=>`Level ${l}: **${c}**`).join('\n') : 'None', inline: true });
            const warnCounts = {}, timeoutCount = history.filter(e => e.type === 'timeout').length, kickCount = history.filter(e => e.type === 'kick').length, banCount = history.filter(e => e.type === 'ban').length;
            for (const e of history) if (e.level != null) warnCounts[e.level] = (warnCounts[e.level] || 0) + 1;
            if (Object.keys(warnCounts).length) embed.addFields({ name: 'Warn History', value: Object.entries(warnCounts).sort(([a],[b])=>a-b).map(([l,c])=>`Level ${l}: **${c}**`).join('\n'), inline: true });
            const modLines = [...(timeoutCount?[`Timeouts: **${timeoutCount}**`]:[]), ...(kickCount?[`Kicks: **${kickCount}**`]:[]), ...(banCount?[`Bans: **${banCount}**`]:[])];
            if (modLines.length) embed.addFields({ name: 'Mod Actions', value: modLines.join('\n'), inline: true });
            if (notes.length) { const shown = notes.slice(-5); embed.addFields({ name: `Notes (${notes.length})`, value: shown.map(n => `\`${n.id}\` <t:${Math.floor(n.addedAt/1000)}:d> by **${n.addedBy}**\n${n.text.slice(0,100)}${n.text.length>100?'…':''}`).join('\n\n') }); if (notes.length > 5) embed.setFooter({ text: `Showing last 5 of ${notes.length} notes` }); }
            return interaction.editReply({ embeds: [embed], components: [refreshBtn(customId)] });
        }
        if (customId.startsWith('removelogchannel_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            await interaction.deferUpdate();
            const guildId = customId.slice(18), cfg = await getConfig(guildId);
            delete cfg.logChannelId; saveConfig(guildId, cfg);
            const { embeds, components } = await buildLogChannelEmbed(guildId);
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('configview_refresh_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            await interaction.deferUpdate();
            const { embeds, components } = await buildConfigViewEmbed(customId.slice(19));
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('escalationview_refresh_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            await interaction.deferUpdate();
            const { embeds, components } = await buildEscalationViewEmbed(customId.slice(23));
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('escview_removecap_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            await interaction.deferUpdate();
            const guildId = customId.slice(19), cfg = await getConfig(guildId);
            delete cfg.escalation?.cap; saveConfig(guildId, cfg);
            const { embeds, components } = await buildEscalationViewEmbed(guildId);
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('scamlist_refresh_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            await interaction.deferUpdate();
            const guildId = customId.slice(17); scamHashCache.delete(guildId);
            const { embeds, components } = await buildScamListEmbed(guildId);
            return interaction.editReply({ embeds, components });
        }
        if (customId.startsWith('unwarn_confirm_') || customId.startsWith('unwarn_cancel_')) {
            const isConfirm = customId.startsWith('unwarn_confirm_'), pendingId = customId.slice(isConfirm ? 15 : 13), pending = pendingUnwarns.get(pendingId);
            if (!pending) return interaction.update({ content: '❌ Confirmation expired.', embeds: [], components: [] });
            if (interaction.user.id !== pending.modId) return interaction.reply({ content: '❌ Only the moderator who ran this command can confirm.', flags: [MessageFlags.Ephemeral] });
            if (!isConfirm) { pendingUnwarns.delete(pendingId); return interaction.update({ content: 'Unwarn cancelled.', embeds: [], components: [] }); }
            pendingUnwarns.delete(pendingId);
            const { targetUserId, targetUserTag, level, guildId, roleId, selectedKey } = pending;
            const member = interaction.guild.members.cache.get(targetUserId), role = interaction.guild.roles.cache.get(roleId);
            if (!member) return interaction.update({ content: '❌ User is no longer in this server.', embeds: [], components: [] });
            if (!role) return interaction.update({ content: '❌ Role not found.', embeds: [], components: [] });
            await member.roles.remove(role);
            const keys = selectedKey ? [selectedKey] : [...activeWarnings.entries()].filter(([, w]) => w.userId === targetUserId && w.guildId === guildId && w.level === level).map(([k]) => k);
            for (const k of keys) { addHistory(guildId, targetUserId, { ...activeWarnings.get(k), endedAt: Date.now(), endReason: 'manual' }); clearTimeout(warningTimers.get(k)); warningTimers.delete(k); deleteWarning(k); }
            logMod(interaction.guild, guildId, new EmbedBuilder().setColor('#00ff00').setTitle('Warning Removed').addFields({ name: 'User', value: `<@${targetUserId}> (${targetUserTag})`, inline: true }, { name: 'Level', value: `${level}`, inline: true }, { name: 'Role', value: `${role}`, inline: true }, { name: 'Removed by', value: `${interaction.user}` }).setTimestamp());
            await interaction.update({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('Warning Removed').addFields({ name: 'User', value: `<@${targetUserId}>`, inline: true }, { name: 'Level', value: `${level}`, inline: true }, { name: 'Role', value: `${role}`, inline: true }, { name: 'Removed by', value: `${interaction.user}` }).setTimestamp()], components: [] });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guildId } = interaction;
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only.', flags: [MessageFlags.Ephemeral] });
    const restricted = ['config','warning','timeout','kick','ban','note','userinfo','escalation','scam','spam','messages'];
    if (restricted.includes(commandName) && !await hasCommandPermission(interaction, guildId)) {
        const cfg = await getConfig(guildId);
        return interaction.reply({ content: `❌ No permission.\n\n**Required:** Administrator OR ${cfg.accessRoleId ? `<@&${cfg.accessRoleId}>` : 'no role configured'}\n\nAsk an admin to run \`/config access\`.`, flags: [MessageFlags.Ephemeral] });
    }
    const E = (color, title) => new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
    const reply = (opts) => {
        if (interaction.deferred) { if (typeof opts === 'string') return interaction.editReply({ content: opts }); const { flags, ...rest } = opts; return interaction.editReply(rest); }
        return interaction.reply(typeof opts === 'string' ? { content: opts, flags: [MessageFlags.Ephemeral] } : opts);
    };

    if (commandName === 'invite') {
        const perms = PermissionFlagsBits.ManageRoles | PermissionFlagsBits.KickMembers | PermissionFlagsBits.BanMembers | PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.ViewAuditLog;
        return reply({ embeds: [E('#5865F2','➕ Invite Police Bot').setDescription(`[**Click here to invite me**](https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${perms}&scope=bot%20applications.commands)\n\nThis link requests the minimum permissions needed to function correctly.`).addFields({ name: 'Permissions Requested', value: '• Manage Roles — assign/remove warning roles\n• Kick & Ban Members — moderation commands\n• Moderate Members — timeouts\n• Send Messages & Embed Links — responses\n• View Audit Log — detect who added the bot\n• Read Message History — channel access' }).setFooter({ text: 'You can adjust permissions after inviting' })], flags: [MessageFlags.Ephemeral] });
    }
    else if (commandName === 'help') { await reply({ embeds: [helpOverviewEmbed()], components: helpRows(), flags: [MessageFlags.Ephemeral] }); }
    else if (commandName === 'config') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'access') { await showAccessControlConfig(interaction, guildId); }
        else if (sub === 'set') {
            const level = interaction.options.getInteger('level'), role = interaction.options.getRole('role'), durationStr = interaction.options.getString('duration');
            if (level < 1 || level > 100) return reply('❌ Level must be between 1 and 100.');
            const dur = parseDuration(durationStr); if (!dur) return reply('❌ Invalid duration. Use `m:s`, `h:m:s`, `d:h:m:s`, or `forever`. Max 365 days.');
            const cfg = await getConfig(guildId); cfg.levels ??= {};
            cfg.levels[level] = { roleId: role.id, roleName: role.name, durationMs: dur.totalMs, isForever: dur.isForever, durationDisplay: formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds, dur.isForever) };
            saveConfig(guildId, cfg);
            await reply({ embeds: [E('#00ff00','Warning Level Configured').addFields({ name: 'Level', value: `${level}`, inline: true }, { name: 'Role', value: `${role}`, inline: true }, { name: 'Duration', value: formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds, dur.isForever), inline: true })], flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'view') {
            const { embeds, components } = await buildConfigViewEmbed(guildId);
            await reply({ embeds, components, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'logchannel') {
            const { embeds, components } = await buildLogChannelEmbed(guildId);
            await reply({ embeds, components, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'notifications') {
            const enabled = interaction.options.getBoolean('enabled'), cfg = await getConfig(guildId); cfg.warnDm = enabled; saveConfig(guildId, cfg);
            await reply({ embeds: [E(enabled ? '#00ff00' : '#FFA500', enabled ? 'Notifications Enabled' : 'Notifications Disabled').setDescription(enabled ? "Users will be DM'd for warnings, scam removals, and spam removals." : "Users will **not** be DM'd for warnings, scam removals, or spam removals.")], flags: [MessageFlags.Ephemeral] });
        }
    }
    else if (commandName === 'warning' && interaction.options.getSubcommand() === 'give') {
        const user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
        const level = interaction.options.getInteger('level'), reason = (interaction.options.getString('reason') || 'No reason provided').slice(0,1000).replace(/[\x00-\x1F\x7F]/g,'');
        if (level < 1 || level > 100) return reply('❌ Level must be between 1 and 100.');
        if (!member) return reply(`❌ ${user} is not in this server.`);
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const cfg = await getConfig(guildId);
        if (!cfg.levels?.[level]) return reply(`❌ Level ${level} is not configured. Use /config set first.`);
        const botMember = interaction.guild.members.me, configRole = interaction.guild.roles.cache.get(cfg.levels[level].roleId);
        if (!configRole) return reply('❌ Configured role not found. Please re-run /config set.');
        if (configRole.position >= botMember.roles.highest.position) return reply(`❌ My role must be above ${configRole} in the role list.`);
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return reply('❌ I need the "Manage Roles" permission.');
        try {
            const result = await applyWarning(interaction.guild, member, user, guildId, level, reason, interaction.channel.id, interaction.user.tag);
            if (result.error) return reply(`❌ ${result.error}`);
            logMod(interaction.guild, guildId, E('#ff0000','Warning Issued').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Level', value: `${level}`, inline: true }, { name: 'Duration', value: result.config.durationDisplay||'Unknown', inline: true }, { name: 'Reason', value: reason }, { name: 'Moderator', value: `${interaction.user}` }));
            await reply({ embeds: [E('#ff0000','Warning Issued').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Level', value: `${level}`, inline: true }, { name: 'Role', value: `${result.role}`, inline: true }, { name: 'Duration', value: result.config.durationDisplay||'Unknown', inline: true }, { name: 'Reason', value: reason }, { name: 'Issued by', value: `${interaction.user}` })] });
            const esc = await checkEscalation(interaction.guild, member, user, guildId, level, interaction.channel.id, interaction.user.tag);
            if (esc?.escalated) await interaction.followUp({ content: `${user} auto-escalated to **Level ${esc.nextLevel}** (${esc.role}).${esc.timedOut?` Timeout: **${esc.timeoutDisplay}**.`:''}${esc.hitCap?`\nReached cap (Level ${esc.nextLevel}).`:''}`, flags: [MessageFlags.Ephemeral] });
            else if (esc?.atCap) await interaction.followUp({ content: `Threshold hit for Level ${level}, but cap (Level ${esc.cap}) prevents further escalation.`, flags: [MessageFlags.Ephemeral] });
            else if (esc?.noNextLevel) await interaction.followUp({ content: `Threshold hit for Level ${level}, but Level ${esc.nextLevel} isn't configured.`, flags: [MessageFlags.Ephemeral] });
            else if (esc?.counted) await interaction.followUp({ content: `Escalation: ${esc.count}/${esc.threshold} warnings at Level ${level}.`, flags: [MessageFlags.Ephemeral] });
        } catch (e) { console.error(e); await reply('❌ Failed to assign warning. Check permissions.'); }
    }
    else if (commandName === 'warning' && interaction.options.getSubcommand() === 'remove') {
        const user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
        if (!member) return reply(`❌ ${user} is not in this server.`);
        const userWarnings = [...activeWarnings.entries()].filter(([, w]) => w.guildId === guildId && w.userId === user.id);
        if (!userWarnings.length) return reply(`❌ ${user} has no active warnings.`);
        const embed = E('#FFA500','⚠️ Remove a Warning').setDescription(`${user} has **${userWarnings.length}** active warning${userWarnings.length>1?'s':''}. Select one below to remove it.`).setFooter({ text: 'Expires in 60 seconds' });
        const options = userWarnings.slice(0, 25).map(([key, w]) => {
            let expires;
            if (w.isForever) expires = 'Permanent';
            else { const s = Math.max(0, Math.floor((w.expiresAt - Date.now()) / 1000)), d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60), sec = s%60; expires = `Expires in ${[d&&`${d}d`,h&&`${h}h`,m&&`${m}m`,(!d&&!h)&&`${sec}s`].filter(Boolean).join(' ')||'<1m'}`; }
            embed.addFields({ name: `Level ${w.level} — ${w.roleName}`, value: `${expires}\nReason: ${(w.reason||'No reason').slice(0,100)}` });
            return { label: `Level ${w.level} — ${w.roleName}`, description: `${expires} · ${(w.reason||'No reason').slice(0,50)}`, value: key };
        });
        const pendingId = interaction.id;
        pendingUnwarns.set(pendingId, { targetUserId: user.id, targetUserTag: user.tag, guildId, modId: interaction.user.id });
        setTimeout(() => pendingUnwarns.delete(pendingId), 60_000);
        await reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`unwarn_select_${pendingId}`).setPlaceholder('Select a warning to remove…').addOptions(options))], flags: [MessageFlags.Ephemeral] });
    }
    else if (commandName === 'timeout') {
        const sub = interaction.options.getSubcommand(), user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
        const reason = (interaction.options.getString('reason') || 'No reason provided').slice(0,512).replace(/[\x00-\x1F\x7F]/g,'');
        if (!member) return reply(`❌ ${user} is not in this server.`);
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) return reply('❌ I need the "Moderate Members" permission.');
        if (member.roles.highest.position >= botMember.roles.highest.position) return reply(`❌ Cannot ${sub === 'give' ? 'timeout' : 'remove timeout from'} this user — their role is equal to or above mine.`);
        if (sub === 'give') {
            const dur = parseDuration(interaction.options.getString('duration'));
            if (!dur || dur.isForever) return reply('❌ Invalid duration. Use `m:s`, `h:m:s`, or `d:h:m:s`. Max 28 days.');
            if (dur.totalMs > MAX_TIMEOUT_MS) return reply('❌ Discord timeouts cannot exceed 28 days.');
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                await member.timeout(dur.totalMs, reason);
                const dd = formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds), exTs = Math.floor((Date.now()+dur.totalMs)/1000);
                logMod(interaction.guild, guildId, E('#ff6600','Member Timed Out').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Duration', value: dd, inline: true }, { name: 'Expires', value: `<t:${exTs}:R>`, inline: true }, { name: 'Reason', value: reason }, { name: 'Moderator', value: `${interaction.user}` }));
                user.send({ embeds: [E('#ff6600','You Have Been Timed Out').setDescription(`You were timed out in **${interaction.guild.name}**.`).addFields({ name: 'Duration', value: dd, inline: true }, { name: 'Expires', value: `<t:${exTs}:R>`, inline: true }, { name: 'Reason', value: reason })] }).catch(() => {});
                addHistory(guildId, user.id, { guildId, userId: user.id, userTag: user.tag, type: 'timeout', reason, issuedBy: interaction.user.tag, issuedAt: Date.now(), duration: dd });
                await reply({ embeds: [E('#ff6600','Timeout Applied').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Duration', value: dd, inline: true }, { name: 'Expires', value: `<t:${exTs}:R>`, inline: true }, { name: 'Reason', value: reason }, { name: 'Issued by', value: `${interaction.user}` })] });
            } catch (e) { console.error(e); await reply('❌ Failed to apply timeout.'); }
        } else {
            if (!member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp < Date.now()) return reply(`❌ ${user} is not currently timed out.`);
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                await member.timeout(null, reason);
                logMod(interaction.guild, guildId, E('#00ff00','Timeout Removed').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Reason', value: reason }, { name: 'Moderator', value: `${interaction.user}` }));
                addHistory(guildId, user.id, { guildId, userId: user.id, userTag: user.tag, type: 'timeout_remove', reason, issuedBy: interaction.user.tag, issuedAt: Date.now() });
                await reply({ embeds: [E('#00ff00','Timeout Removed').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Reason', value: reason }, { name: 'Removed by', value: `${interaction.user}` })] });
            } catch (e) { console.error(e); await reply('❌ Failed to remove timeout.'); }
        }
    }
    else if (commandName === 'mywarnings') {
        const userWarnings = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === interaction.user.id);
        if (!userWarnings.length) return reply('You have no active warnings!');
        const cfg = await getConfig(guildId), embed = E('#FFA500','Your Active Warnings').setDescription(`You have ${userWarnings.length} active warning${userWarnings.length>1?'s':''}`).setFooter({ text: 'Warnings are automatically removed when they expire' });
        for (const w of userWarnings) {
            const lc = cfg.levels?.[w.level], name = `Level ${w.level} — ${lc?.roleName||'Unknown Role'}`;
            if (w.isForever) embed.addFields({ name, value: ' **Duration:** Forever\n **Status:** Permanent' });
            else { const t = w.expiresAt - Date.now(); embed.addFields({ name, value: t <= 0 ? 'Expired (will be removed shortly)' : (() => { const s = Math.floor(t/1000); return `**Time Left:** ${formatDuration(Math.floor(s/86400),Math.floor((s%86400)/3600),Math.floor((s%3600)/60),s%60)}\n**Expires:** <t:${Math.floor(w.expiresAt/1000)}:F>`; })() }); }
        }
        await reply({ embeds: [embed], components: [refreshBtn(`mywarnings_refresh_${interaction.user.id}`)], flags: [MessageFlags.Ephemeral] });
    }
    else if (commandName === 'warning' && interaction.options.getSubcommand() === 'list') {
        const { embed, totalPages, page } = buildWarnlistEmbed(guildId, 0);
        await reply({ embeds: [embed], components: warnlistRow(page, totalPages, guildId) });
    }
    else if (commandName === 'warning' && interaction.options.getSubcommand() === 'history') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const user = interaction.options.getUser('user'), entries = await getHistory(guildId, user.id);
        if (!entries.length) return interaction.editReply({ content: `❌ No warning history found for ${user}.` });
        const embed = E('#5865F2',`Warning History — ${user.tag}`).setDescription(`Showing last ${entries.length} record${entries.length>1?'s':''}.`);
        for (const e of entries) {
            if (e.type === 'kick') embed.addFields({ name: `Kick — <t:${Math.floor(e.issuedAt/1000)}:d>`, value: `by ${e.issuedBy}\n${e.reason}` });
            else if (e.type === 'ban') embed.addFields({ name: `Ban — <t:${Math.floor(e.issuedAt/1000)}:d>`, value: `by ${e.issuedBy}\n${e.reason}` });
            else { const s = e.endReason==='expired'?'Expired':e.endReason==='manual'?'Removed':'Active'; embed.addFields({ name: `Level ${e.level} — ${e.roleName} — <t:${Math.floor(e.issuedAt/1000)}:d>`, value: `${s} • by ${e.issuedBy}\n${e.reason}` }); }
        }
        await interaction.editReply({ embeds: [embed] });
    }
    else if (commandName === 'kick') {
        const user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
        const reason = interaction.options.getString('reason').slice(0,512).replace(/[\x00-\x1F\x7F]/g,'');
        if (!member) return reply(`❌ ${user} is not in this server.`);
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) return reply('❌ I need the "Kick Members" permission.');
        if (member.roles.highest.position >= botMember.roles.highest.position) return reply('❌ Cannot kick this user — their role is equal to or above mine.');
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            user.send({ embeds: [E('#ff6600','You have been kicked').setDescription(`You were kicked from **${interaction.guild.name}**.`).addFields({ name: 'Reason', value: reason })] }).catch(() => {});
            await member.kick(reason);
            addHistory(guildId, user.id, { guildId, userId: user.id, userTag: user.tag, type: 'kick', reason, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            logMod(interaction.guild, guildId, E('#ff6600','Member Kicked').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Moderator', value: `${interaction.user}`, inline: true }, { name: 'Reason', value: reason }));
            await reply({ embeds: [E('#ff6600','Member Kicked').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Reason', value: reason }, { name: 'Kicked by', value: `${interaction.user}` })] });
        } catch (e) { console.error(e); await reply('❌ Failed to kick user.'); }
    }
    else if (commandName === 'ban') {
        const sub = interaction.options.getSubcommand(), botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) return reply('❌ I need the "Ban Members" permission.');
        if (sub === 'give') {
            const user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
            const reason = interaction.options.getString('reason').slice(0,512).replace(/[ -]/g,''), deleteDays = interaction.options.getInteger('delete_days') ?? 0;
            const durationStr = interaction.options.getString('duration'), dur = durationStr ? parseDuration(durationStr) : null;
            const deleteMessagesStr = interaction.options.getString('delete_messages');
            const delMsgDur = deleteMessagesStr ? parseDuration(deleteMessagesStr) : null;
            if (durationStr && (!dur || dur.isForever)) return reply('❌ Invalid duration. Omit for permanent ban.');
            if (deleteMessagesStr && (!delMsgDur || delMsgDur.isForever)) return reply('❌ Invalid delete_messages duration. Use `m:s`, `h:m:s`, or `d:h:m:s`.');
            if (member && member.roles.highest.position >= botMember.roles.highest.position) return reply('❌ Cannot ban this user — their role is equal to or above mine.');
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                const dd = dur ? formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds) : null, expiresAt = dur ? Date.now() + dur.totalMs : null, exTs = expiresAt ? Math.floor(expiresAt / 1000) : null;
                if (member) user.send({ embeds: [E('#ff0000','You have been banned').setDescription(`You were banned from **${interaction.guild.name}**.`).addFields({ name: 'Reason', value: reason }, ...(dd ? [{ name: 'Duration', value: dd, inline: true }, { name: 'Expires', value: `<t:${exTs}:R>`, inline: true }] : []))] }).catch(() => {});
                await interaction.guild.members.ban(user, { reason, deleteMessageDays: deleteDays });
                addHistory(guildId, user.id, { guildId, userId: user.id, userTag: user.tag, type: 'ban', reason, issuedBy: interaction.user.tag, issuedAt: Date.now(), deleteDays, expiresAt });
                if (expiresAt) scheduleBanExpiry(guildId, user.id, user.tag, expiresAt, reason);
                // Time-based message deletion across all channels
                let deletedMsgCount = 0;
                if (delMsgDur) {
                    const since = Date.now() - delMsgDur.totalMs;
                    const channels = interaction.guild.channels.cache.filter(c => c.isTextBased() && c.permissionsFor(interaction.guild.members.me).has(PermissionFlagsBits.ManageMessages));
                    for (const ch of channels.values()) deletedMsgCount += await bulkDeleteInRange(ch, { userId: user.id, since }).catch(() => 0);
                }
                const delDisplay = delMsgDur ? formatDuration(delMsgDur.days, delMsgDur.hours, delMsgDur.minutes, delMsgDur.seconds) : null;
                logMod(interaction.guild, guildId, E('#ff0000','Member Banned').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Moderator', value: `${interaction.user}`, inline: true }, { name: 'Duration', value: dd || 'Permanent', inline: true }, ...(exTs ? [{ name: 'Expires', value: `<t:${exTs}:R>`, inline: true }] : []), { name: 'Messages Deleted', value: deleteDays ? `${deleteDays} day(s) via Discord` : delDisplay ? `${deletedMsgCount} msgs in last ${delDisplay}` : 'None', inline: true }, { name: 'Reason', value: reason }));
                await reply({ embeds: [E('#ff0000','Member Banned').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Duration', value: dd || 'Permanent', inline: true }, ...(exTs ? [{ name: 'Expires', value: `<t:${exTs}:R>`, inline: true }] : []), { name: 'Messages Deleted', value: deleteDays ? `${deleteDays} day(s) via Discord` : delDisplay ? `${deletedMsgCount} msgs in last ${delDisplay}` : 'None', inline: true }, { name: 'Reason', value: reason }, { name: 'Banned by', value: `${interaction.user}` })] });
            } catch (e) { console.error(e); await reply('❌ Failed to ban user.'); }
        } else {
            const userId = interaction.options.getString('user_id').trim(), reason = (interaction.options.getString('reason') || 'No reason provided').slice(0,512).replace(/[\x00-\x1F\x7F]/g,'');
            if (!/^\d{17,20}$/.test(userId)) return reply('❌ Invalid user ID. Must be a Discord snowflake (17-20 digits).');
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                const ban = await interaction.guild.bans.fetch(userId).catch(() => null); if (!ban) return reply('❌ That user is not banned.');
                await interaction.guild.members.unban(userId, reason);
                const user = ban.user;
                addHistory(guildId, userId, { guildId, userId, userTag: user.tag, type: 'unban', reason, issuedBy: interaction.user.tag, issuedAt: Date.now() });
                logMod(interaction.guild, guildId, E('#00ff00','Member Unbanned').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Moderator', value: `${interaction.user}`, inline: true }, { name: 'Reason', value: reason }));
                await reply({ embeds: [E('#00ff00','Member Unbanned').addFields({ name: 'User', value: `${user.tag}`, inline: true }, { name: 'Reason', value: reason }, { name: 'Unbanned by', value: `${interaction.user}` })] });
            } catch (e) { console.error(e); await reply('❌ Failed to unban.'); }
        }
    }
    else if (commandName === 'userinfo') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const user = interaction.options.getUser('user');
        const [member, history, notes] = await Promise.all([interaction.guild.members.fetch(user.id).catch(() => null), getAllHistory(guildId, user.id), getNotes(guildId, user.id)]);
        const embed = new EmbedBuilder().setColor('#5865F2').setAuthor({ name: user.tag, iconURL: user.displayAvatarURL({ size: 256 }) }).setThumbnail(user.displayAvatarURL({ size: 256 })).addFields({ name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp/1000)}:F>\n<t:${Math.floor(user.createdTimestamp/1000)}:R>`, inline: true }, { name: 'Joined Server', value: member ? `<t:${Math.floor(member.joinedTimestamp/1000)}:F>\n<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : '*Not in server*', inline: true }).setTimestamp();
        const activeUserWarnings = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === user.id), activeByLevel = {};
        for (const w of activeUserWarnings) activeByLevel[w.level] = (activeByLevel[w.level] || 0) + 1;
        embed.addFields({ name: 'Active Warnings', value: Object.keys(activeByLevel).length ? Object.entries(activeByLevel).sort(([a],[b])=>a-b).map(([l,c])=>`Level ${l}: **${c}**`).join('\n') : 'None', inline: true });
        const warnCounts = {}, timeoutCount = history.filter(e => e.type === 'timeout').length, kickCount = history.filter(e => e.type === 'kick').length, banCount = history.filter(e => e.type === 'ban').length;
        for (const e of history) if (e.level != null) warnCounts[e.level] = (warnCounts[e.level] || 0) + 1;
        if (Object.keys(warnCounts).length) embed.addFields({ name: 'Warn History', value: Object.entries(warnCounts).sort(([a],[b])=>a-b).map(([l,c])=>`Level ${l}: **${c}**`).join('\n'), inline: true });
        const modLines = [...(timeoutCount?[`Timeouts: **${timeoutCount}**`]:[]), ...(kickCount?[`Kicks: **${kickCount}**`]:[]), ...(banCount?[`Bans: **${banCount}**`]:[])];
        if (modLines.length) embed.addFields({ name: 'Mod Actions', value: modLines.join('\n'), inline: true });
        if (notes.length) { const shown = notes.slice(-5); embed.addFields({ name: `Notes (${notes.length})`, value: shown.map(n => `\`${n.id}\` <t:${Math.floor(n.addedAt/1000)}:d> by **${n.addedBy}**\n${n.text.slice(0,100)}${n.text.length>100?'…':''}`).join('\n\n') }); if (notes.length > 5) embed.setFooter({ text: `Showing last 5 of ${notes.length} notes` }); }
        await interaction.editReply({ embeds: [embed], components: [refreshBtn(`userinfo_refresh_${user.id}_${guildId}`)] });
    }
    else if (commandName === 'note') {
        const sub = interaction.options.getSubcommand(), user = interaction.options.getUser('user');
        if (sub === 'add') {
            const text = interaction.options.getString('text').slice(0,1000).replace(/[\x00-\x1F\x7F]/g,'');
            const note = { id: Date.now(), text, addedBy: interaction.user.tag, addedAt: Date.now() };
            addNote(guildId, user.id, note); await reply(`✅ Note added to ${user} (ID: \`${note.id}\`).`);
        } else if (sub === 'remove') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const { embeds, components } = await buildNoteViewEmbed(guildId, user);
            await interaction.editReply({ embeds, components });
        }
    }
    else if (commandName === 'scam') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
            const att = interaction.options.getAttachment('image'), label = interaction.options.getString('label').slice(0,100).replace(/[\x00-\x1F\x7F]/g,'');
            if (!att.contentType?.startsWith('image/') && !/\.(png|jpg|jpeg|gif|webp)$/i.test(att.name ?? '')) return reply('❌ Please attach an image file (PNG, JPG, GIF, or WebP).');
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            let buffer; try { buffer = await fetchImageBuffer(att.url); } catch (e) { return reply(`❌ Failed to download image: ${e.message}`); }
            let hash; try { hash = await dHash(buffer); } catch (e) { return reply(`❌ Failed to process image: ${e.message}`); }
            const existing = await getScamHashes(guildId), spc = await getScamProtConfig(guildId);
            for (const e of existing) { if (hammingDistance(hash, e.hash) <= spc.threshold) return reply(`❌ Already registered (or similar to) **${e.label}** (ID: \`${e.id}\`).`); }
            const entry = await addScamHash(guildId, hash, label, interaction.user.tag);
            await reply({ embeds: [E('#00ff00','Scam Image Registered').addFields({ name: 'Label', value: label, inline: true }, { name: 'ID', value: `${entry.id}`, inline: true }, { name: 'Hash', value: `\`${hash}\``, inline: false }).setFooter({ text: 'Any similar image posted in this server will now be actioned' })] });
        } else if (sub === 'list') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const { embeds, components } = await buildScamListEmbed(guildId);
            await interaction.editReply({ embeds, components });
        } else if (sub === 'config') {
            const enabled = interaction.options.getBoolean('enabled'), del = interaction.options.getBoolean('delete'), toStr = interaction.options.getString('timeout'), thresh = interaction.options.getInteger('threshold');
            const cfg = await getConfig(guildId); cfg.scamProt ??= {};
            if (enabled !== null) cfg.scamProt.enabled = enabled;
            if (del !== null) cfg.scamProt.deleteMsg = del;
            if (thresh !== null) cfg.scamProt.threshold = thresh;
            if (toStr !== null) {
                if (toStr.toLowerCase() === 'none') { cfg.scamProt.timeoutMs = null; cfg.scamProt.timeoutDisplay = 'None'; }
                else { const dur = parseDuration(toStr); if (!dur || dur.isForever) return reply('❌ Invalid timeout.'); if (dur.totalMs > MAX_TIMEOUT_MS) return reply('❌ Timeouts cannot exceed 28 days.'); cfg.scamProt.timeoutMs = dur.totalMs; cfg.scamProt.timeoutDisplay = formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds); }
            }
            saveConfig(guildId, cfg);
            const spc = { enabled: true, threshold: 10, timeoutMs: 5*60*1000, timeoutDisplay: '5m', deleteMsg: true, ...cfg.scamProt };
            await reply({ embeds: [E('#5865F2','Scam Protection Config').addFields({ name: 'Detection', value: spc.enabled?'Enabled':'Disabled', inline: true }, { name: 'Delete Messages', value: spc.deleteMsg?'Yes':'No', inline: true }, { name: 'Timeout', value: spc.timeoutMs?spc.timeoutDisplay:'None', inline: true }, { name: 'Threshold', value: `${spc.threshold}`, inline: true })], flags: [MessageFlags.Ephemeral] });
        }
    }
    else if (commandName === 'spam') {
        const sub = interaction.options.getSubcommand();
        const spamEmbed = (sp) => { const s = { enabled: true, count: 5, windowMs: 10_000, timeoutMs: 10*60*1000, timeoutDisplay: '10m', deleteMsg: true, similarityThreshold: 0.7, ...sp }; return E('#ff6600','Spam Protection Config').addFields({ name: 'Detection', value: s.enabled?'Enabled':'Disabled', inline: true }, { name: 'Trigger', value: `${s.count} similar msgs within ${s.windowMs/1000}s`, inline: true }, { name: 'Similarity', value: `${Math.round(s.similarityThreshold*100)}%`, inline: true }, { name: 'Delete Messages', value: s.deleteMsg?'Yes':'No', inline: true }, { name: 'Timeout', value: s.timeoutMs?s.timeoutDisplay:'None', inline: true }); };
        if (sub === 'config') {
            const enabled = interaction.options.getBoolean('enabled'), del = interaction.options.getBoolean('delete'), count = interaction.options.getInteger('count'), window = interaction.options.getInteger('window'), toStr = interaction.options.getString('timeout'), simPct = interaction.options.getInteger('similarity');
            const cfg = await getConfig(guildId); cfg.spamProt ??= {};
            if (enabled !== null) cfg.spamProt.enabled = enabled;
            if (del !== null) cfg.spamProt.deleteMsg = del;
            if (count !== null) cfg.spamProt.count = count;
            if (window !== null) cfg.spamProt.windowMs = window * 1000;
            if (simPct !== null) cfg.spamProt.similarityThreshold = simPct / 100;
            if (toStr !== null) {
                if (toStr.toLowerCase() === 'none') { cfg.spamProt.timeoutMs = null; cfg.spamProt.timeoutDisplay = 'None'; }
                else { const dur = parseDuration(toStr); if (!dur || dur.isForever) return reply('❌ Invalid timeout.'); if (dur.totalMs > MAX_TIMEOUT_MS) return reply('❌ Timeouts cannot exceed 28 days.'); cfg.spamProt.timeoutMs = dur.totalMs; cfg.spamProt.timeoutDisplay = formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds); }
            }
            saveConfig(guildId, cfg);
            await reply({ embeds: [spamEmbed(cfg.spamProt)], flags: [MessageFlags.Ephemeral] });
        } else {
            const cfg = await getConfig(guildId);
            await reply({ embeds: [spamEmbed(cfg.spamProt)], flags: [MessageFlags.Ephemeral] });
        }
    }
    else if (commandName === 'messages') {
        const sub = interaction.options.getSubcommand();
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.ManageMessages)) return reply('❌ I need the "Manage Messages" permission.');

        if (sub === 'delete') {
            const filterUser = interaction.options.getUser('user'), count = interaction.options.getInteger('count') ?? 100;
            const withinStr = interaction.options.getString('within'), withinDur = withinStr ? parseDuration(withinStr) : null;
            if (withinStr && (!withinDur || withinDur.isForever)) return reply('❌ Invalid within duration. Use `m:s`, `h:m:s`, or `d:h:m:s`.');
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            if (!botMember.permissionsIn(interaction.channel).has(PermissionFlagsBits.ManageMessages)) return reply('❌ I need ManageMessages in this channel.');
            const since = withinDur ? Date.now() - withinDur.totalMs : null;
            const deleted = await bulkDeleteInRange(interaction.channel, { userId: filterUser?.id, since, maxCount: count });
            const withinDisplay = withinDur ? formatDuration(withinDur.days, withinDur.hours, withinDur.minutes, withinDur.seconds) : null;
            logMod(interaction.guild, guildId, E('#ff6600','Messages Deleted').addFields({ name: 'Channel', value: `${interaction.channel}`, inline: true }, { name: 'Deleted', value: `${deleted}`, inline: true }, ...(filterUser ? [{ name: 'User Filter', value: `${filterUser}`, inline: true }] : []), ...(withinDisplay ? [{ name: 'Within', value: withinDisplay, inline: true }] : []), { name: 'Moderator', value: `${interaction.user}`, inline: true }));
            await reply(`✅ Deleted **${deleted}** message${deleted !== 1 ? 's' : ''} in ${interaction.channel}.`);
        }
        else if (sub === 'purge') {
            const withinStr = interaction.options.getString('within'), filterUser = interaction.options.getUser('user');
            const withinDur = parseDuration(withinStr);
            if (!withinDur || withinDur.isForever) return reply('❌ Invalid within duration. Use `m:s`, `h:m:s`, or `d:h:m:s`.');
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const since = Date.now() - withinDur.totalMs;
            const channels = interaction.guild.channels.cache.filter(c => c.isTextBased() && botMember.permissionsIn(c).has(PermissionFlagsBits.ManageMessages));
            let totalDeleted = 0, channelsAffected = 0;
            for (const ch of channels.values()) { const n = await bulkDeleteInRange(ch, { userId: filterUser?.id, since }); if (n > 0) { totalDeleted += n; channelsAffected++; } }
            const withinDisplay = formatDuration(withinDur.days, withinDur.hours, withinDur.minutes, withinDur.seconds);
            logMod(interaction.guild, guildId, E('#ff0000','Messages Purged').addFields({ name: 'Deleted', value: `${totalDeleted} messages`, inline: true }, { name: 'Channels Affected', value: `${channelsAffected}`, inline: true }, { name: 'Within', value: withinDisplay, inline: true }, ...(filterUser ? [{ name: 'User Filter', value: `${filterUser}`, inline: true }] : []), { name: 'Moderator', value: `${interaction.user}`, inline: true }));
            await reply(`✅ Purged **${totalDeleted}** message${totalDeleted !== 1 ? 's' : ''} across **${channelsAffected}** channel${channelsAffected !== 1 ? 's' : ''} in the last **${withinDisplay}**.`);
        }
    }
    else if (commandName === 'escalation') {
        const sub = interaction.options.getSubcommand(), cfg = await getConfig(guildId);
        cfg.escalation ??= { thresholds: {} }; const esc = cfg.escalation;
        if (sub === 'set') {
            const level = interaction.options.getInteger('level'), threshold = interaction.options.getInteger('threshold');
            if (level < 1 || level > 100) return reply('❌ Level must be between 1 and 100.');
            if (threshold < 2 || threshold > 50) return reply('❌ Threshold must be between 2 and 50.');
            if (!cfg.levels?.[level]) return reply(`❌ Level ${level} not configured. Use /config set first.`);
            const targetLevel = level + 1; if (!cfg.levels?.[targetLevel]) return reply(`❌ Level ${targetLevel} not configured. Use /config set first.`);
            esc.thresholds[level] = threshold; saveConfig(guildId, cfg);
            await reply(`**${threshold}x** Level ${level} → auto Level ${targetLevel}.`);
        } else if (sub === 'cap') {
            const level = interaction.options.getInteger('level'); if (level < 1 || level > 100) return reply('❌ Cap must be between 1 and 100.');
            esc.cap = level; saveConfig(guildId, cfg); await reply(`Level cap set to **${level}**.`);
        } else if (sub === 'timeout') {
            const level = interaction.options.getInteger('level'), threshold = interaction.options.getInteger('threshold'), durationStr = interaction.options.getString('duration');
            if (level < 2 || level > 100) return reply('❌ Target level must be between 2 and 100.');
            if (threshold < 2 || threshold > 50) return reply('❌ Threshold must be between 2 and 50.');
            const dur = parseDuration(durationStr); if (!dur || dur.isForever) return reply('❌ Invalid duration.'); if (dur.totalMs > MAX_TIMEOUT_MS) return reply('❌ Timeouts cannot exceed 28 days.');
            cfg.levels ??= {};
            if (!cfg.levels[level]) cfg.levels[level] = { isTimeoutLevel: true, timeoutDurationMs: dur.totalMs, timeoutDisplay: formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds) };
            esc.timeouts ??= {}; esc.timeouts[level] = { durationMs: dur.totalMs, durationDisplay: formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds), threshold };
            saveConfig(guildId, cfg); await reply(`Timeout escalation: **${threshold}x** Level ${level-1} → Level ${level} + **${esc.timeouts[level].durationDisplay}** timeout.`);
        } else if (sub === 'view') {
            const { embeds, components } = await buildEscalationViewEmbed(guildId);
            await reply({ embeds, components, flags: [MessageFlags.Ephemeral] });
        }
    }

  } catch (error) {
      if (error?.code === 40060) return;
      console.error('❌ Interaction error:', error);
      try {
          if (interaction.deferred) await interaction.editReply({ content: '❌ Something went wrong. Please try again.' }).catch(() => {});
          else if (!interaction.replied) await interaction.reply({ content: '❌ Something went wrong. Please try again.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
      } catch {}
  }
});

process.on('unhandledRejection', e => console.error('⚠️ Unhandled rejection:', e));
client.on('error', e => console.error('⚠️ Discord client error:', e));
client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { const ok = req.url === '/' || req.url === '/health'; res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' }); res.end(ok ? 'Police bot is running!' : 'Not found'); }).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

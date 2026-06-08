const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle } = require('discord.js');
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
    const threshold = esc.thre

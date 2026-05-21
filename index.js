const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Pool } = require('pg');
const dns = require('dns'); dns.setDefaultResultOrder('ipv4first');
const http = require('http'), https = require('https');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// ── DB ─────────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS configs  (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS warnings (key TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS history  (id SERIAL PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL);
        CREATE TABLE IF NOT EXISTS notes    (id BIGINT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, data JSONB NOT NULL);
        CREATE INDEX IF NOT EXISTS warnings_guild_user ON warnings(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS history_guild_user  ON history(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS notes_guild_user    ON notes(guild_id, user_id);
    `);
    console.log('✅ Database initialised');
}

const configCache = new Map();
const activeWarnings = new Map();

async function getConfig(guildId) {
    if (configCache.has(guildId)) return configCache.get(guildId);
    const res = await pool.query('SELECT data FROM configs WHERE guild_id = $1', [guildId]);
    const data = res.rows[0]?.data ?? { levels: {} };
    configCache.set(guildId, data);
    return data;
}
function saveConfig(guildId, data) {
    configCache.set(guildId, data);
    pool.query('INSERT INTO configs (guild_id, data) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET data = $2', [guildId, data]).catch(e => console.error('saveConfig:', e.message));
}
function saveWarning(key, data) {
    activeWarnings.set(key, data);
    pool.query('INSERT INTO warnings (key, guild_id, user_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO UPDATE SET data = $4', [key, data.guildId, data.userId, data]).catch(e => console.error('saveWarning:', e.message));
}
function deleteWarning(key) {
    activeWarnings.delete(key);
    pool.query('DELETE FROM warnings WHERE key = $1', [key]).catch(e => console.error('deleteWarning:', e.message));
}
function addHistory(guildId, userId, entry) {
    pool.query('INSERT INTO history (guild_id, user_id, data) VALUES ($1, $2, $3)', [guildId, userId, entry]).catch(e => console.error('addHistory:', e.message));
}
async function getHistory(guildId, userId) {
    const res = await pool.query('SELECT data FROM history WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 10', [guildId, userId]);
    return res.rows.map(r => r.data).reverse();
}
async function getAllHistory(guildId, userId) {
    const res = await pool.query('SELECT data FROM history WHERE guild_id = $1 AND user_id = $2 ORDER BY id', [guildId, userId]);
    return res.rows.map(r => r.data);
}
async function getNotes(guildId, userId) {
    const res = await pool.query('SELECT data FROM notes WHERE guild_id = $1 AND user_id = $2 ORDER BY id', [guildId, userId]);
    return res.rows.map(r => r.data);
}
function addNote(guildId, userId, note) {
    pool.query('INSERT INTO notes (id, guild_id, user_id, data) VALUES ($1, $2, $3, $4)', [note.id, guildId, userId, note]).catch(e => console.error('addNote:', e.message));
}
async function deleteNote(guildId, userId, id) {
    const res = await pool.query('DELETE FROM notes WHERE guild_id = $1 AND user_id = $2 AND id = $3', [guildId, userId, id]);
    return res.rowCount > 0;
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function logMod(guild, guildId, embed) {
    const cfg = await getConfig(guildId);
    const ch = cfg.logChannelId && guild.channels.cache.get(cfg.logChannelId);
    if (ch) ch.send({ embeds: [embed] }).catch(() => {});
}
async function hasCommandPermission(interaction, guildId) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const cfg = await getConfig(guildId);
    return cfg.accessRoleId ? interaction.member.roles.cache.has(cfg.accessRoleId) : false;
}
async function showAccessControlConfig(interaction, guildId) {
    await interaction.reply({
        embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🔒 Access Configuration')
            .setDescription('Select which role should have access to moderation commands:\n\n**Commands affected:**\n• `/warn` `/unwarn` `/timeout` `/config set/view`\n• `/config access` `/warnlist` `/history` `/escalation`\n\n**Note:** Server administrators always have access.')
            .setFooter({ text: 'Select a role from the dropdown below' })],
        components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`access_role_${guildId}`).setPlaceholder('Select a role for command access').setMinValues(1).setMaxValues(1))],
        flags: [MessageFlags.Ephemeral]
    });
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
function formatDuration(d, h, m, s, isForever = false) {
    if (isForever) return 'Forever';
    return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
}

// ── Warning timers ─────────────────────────────────────────────────────────
const warningTimers = new Map(), pendingUnwarns = new Map(), banTimers = new Map();
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

async function handleWarningExpiry(key, guildId, userId, roleId, channelId) {
    const w = activeWarnings.get(key);
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const member = await guild.members.fetch(userId).catch(() => null);
        const role = guild.roles.cache.get(roleId);
        if (member && role && member.roles.cache.has(roleId)) {
            await member.roles.remove(role);
            member.user.send({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Warning Expired')
                .setDescription(`Your warning in **${guild.name}** has expired and the role has been removed.`)
                .addFields({ name: 'Warning Level', value: `${w?.level ?? 'Unknown'}`, inline: true }, { name: 'Role Removed', value: role.name, inline: true })
                .setFooter({ text: 'You no longer carry this warning role' }).setTimestamp()]
            }).catch(() => {});
            const ch = guild.channels.cache.get(channelId);
            if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Warning Expired').setDescription(`<@${userId}>'s warning has expired and the role has been removed.`).setTimestamp()] });
        }
    } catch (e) {
        console.error(`Failed to remove role: ${e}`);
        try { const ch = client.guilds.cache.get(guildId)?.channels.cache.get(channelId); if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Warning Removal Failed').setDescription(`Could not remove role from <@${userId}>. Check bot permissions.`).setTimestamp()] }); } catch {}
    }
    if (w) addHistory(guildId, userId, { ...w, endedAt: Date.now(), endReason: 'expired' });
    warningTimers.delete(key);
    deleteWarning(key);
}
function scheduleWarningRemoval(key, guildId, userId, roleId, expiresAt, channelId) {
    const t = expiresAt - Date.now();
    if (t <= 0) return handleWarningExpiry(key, guildId, userId, roleId, channelId);
    warningTimers.set(key, setTimeout(() => handleWarningExpiry(key, guildId, userId, roleId, channelId), t));
}
function scheduleBanExpiry(guildId, userId, userTag, expiresAt, reason) {
    const t = expiresAt - Date.now();
    if (t <= 0) return;
    const key = `${guildId}-${userId}`;
    banTimers.set(key, setTimeout(async () => {
        banTimers.delete(key);
        try {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return;
            const ban = await guild.bans.fetch(userId).catch(() => null);
            if (!ban) return;
            await guild.members.unban(userId, 'Timed ban expired');
            addHistory(guildId, userId, { guildId, userId, userTag, type: 'unban', reason: 'Timed ban expired', issuedBy: client.user.tag, issuedAt: Date.now() });
            logMod(guild, guildId, new EmbedBuilder().setColor('#00ff00').setTitle('Timed Ban Expired').addFields({ name: 'User', value: `${userTag} (${userId})`, inline: true }, { name: 'Original Reason', value: reason }).setTimestamp());
            console.log(`🔒 Timed ban expired for ${userTag} in ${guildId}`);
        } catch (e) { console.error('Ban expiry failed:', e.message); }
    }, t));
}

async function applyWarning(guild, member, user, guildId, level, reason, channelId, issuedByTag) {
    const cfg = await getConfig(guildId);
    const lc = cfg.levels[level];
    const role = guild.roles.cache.get(lc?.roleId);
    if (!lc || !role) return { error: `Level ${level} config or role not found.` };
    if (role.position >= guild.members.me.roles.highest.position) return { error: `Role hierarchy: my role must be above ${role.name}.` };
    await member.roles.add(role);
    if (cfg.warnDm !== false) user.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ You Received a Warning')
        .setDescription(`You have been warned in **${guild.name}**.`)
        .addFields({ name: 'Warning Level', value: `${level}`, inline: true }, { name: 'Duration', value: lc.durationDisplay || 'Unknown', inline: true }, { name: 'Reason', value: reason })
        .setFooter({ text: `Use /mywarnings in ${guild.name} to check when this warning expires` }).setTimestamp()]
    }).catch(() => {});
    const base = { guildId, userId: user.id, userTag: user.tag, roleId: role.id, roleName: role.name, level, reason, issuedBy: issuedByTag, issuedAt: Date.now() };
    const key = `${guildId}-${user.id}-${level}-${Date.now()}`;
    if (!lc.isForever) {
        const expiresAt = Date.now() + lc.durationMs;
        saveWarning(key, { ...base, expiresAt, channelId, isForever: false });
        scheduleWarningRemoval(key, guildId, user.id, role.id, expiresAt, channelId);
    } else {
        saveWarning(key, { ...base, expiresAt: null, channelId, isForever: true });
    }
    return { success: true, role, config: lc };
}
async function checkEscalation(guild, member, user, guildId, level, channelId, issuedByTag) {
    const cfg = await getConfig(guildId);
    const esc = cfg.escalation ?? {};
    const cap = esc.cap, nextLevel = level + 1;
    if (cap != null && nextLevel > cap) return { atCap: true, cap };
    const count = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === user.id && w.level === level).length;
    const toCfg = esc.timeouts?.[nextLevel];
    if (toCfg?.threshold != null) {
        if (count < toCfg.threshold) return { counted: true, count, threshold: toCfg.threshold };
        if (!cfg.levels[nextLevel]) return { noNextLevel: true, nextLevel };
        const r = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
        if (r.error) return { escalationError: r.error };
        await member.timeout(toCfg.durationMs, `Auto-escalated to Level ${nextLevel}`).catch(() => {});
        user.send({ embeds: [new EmbedBuilder().setColor('#ff6600').setTitle('🔇 You Have Been Timed Out').setDescription(`You were auto-timed-out in **${guild.name}** upon reaching Warning Level ${nextLevel}.`).addFields({ name: 'Timeout Duration', value: toCfg.durationDisplay, inline: true }).setTimestamp()] }).catch(() => {});
        return { escalated: true, nextLevel, role: r.role, config: r.config, hitCap: cap != null && nextLevel === cap, timedOut: true, timeoutDisplay: toCfg.durationDisplay };
    }
    const threshold = esc.thresholds?.[level];
    if (!threshold) return null;
    if (count < threshold) return { counted: true, count, threshold };
    if (!cfg.levels[nextLevel]) return { noNextLevel: true, nextLevel };
    const r = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
    if (r.error) return { escalationError: r.error };
    return { escalated: true, nextLevel, role: r.role, config: r.config, hitCap: cap != null && nextLevel === cap, timedOut: false };
}

// ── Keep-alive ─────────────────────────────────────────────────────────────
function keepAlive() {
    const ping = () => {
        const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        (url.startsWith('https://') ? https : http).get(url, r => console.log(`🏓 Keep-alive: ${r.statusCode}`)).on('error', e => console.error('Keep-alive failed:', e.message));
    };
    setTimeout(ping, 5000); setInterval(ping, 14 * 60 * 1000);
}

// ── Warnlist ───────────────────────────────────────────────────────────────
function buildWarnlistEmbed(guildId, page) {
    const all = [...activeWarnings.values()].filter(w => w.guildId === guildId);
    const byUser = {};
    for (const w of all) { byUser[w.userId] ??= []; byUser[w.userId].push(w); }
    const userIds = Object.keys(byUser);
    const total = Math.max(1, Math.ceil(userIds.length / 10));
    page = Math.max(0, Math.min(page, total - 1));
    const embed = new EmbedBuilder().setColor('#FFA500').setTitle(`⚠️ Active Warnings (${all.length})`).setTimestamp().setFooter({ text: total > 1 ? `Page ${page + 1} of ${total}` : `${userIds.length} user(s) warned` });
    if (!userIds.length) return { embed: embed.setDescription('No active warnings in this server.'), totalPages: total, page };
    for (const uid of userIds.slice(page * 10, (page + 1) * 10)) {
        const w0 = byUser[uid][0];
        const displayName = w0.userTag || `<@${uid}>`;
        embed.addFields({ name: displayName, value: byUser[uid].map(w => `• Level ${w.level} — ${w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt / 1000)}:R>`}`).join('\n') });
    }
    return { embed, totalPages: total, page };
}
function warnlistRow(page, total, guildId) {
    if (total <= 1) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wl_${page - 1}_${guildId}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`wl_${page + 1}_${guildId}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page === total - 1)
    )];
}

// ── Help pages ─────────────────────────────────────────────────────────────
const helpPages = {
    help_warn: new EmbedBuilder().setColor('#ff0000').setTitle('Warning Commands').addFields(
        { name: '/warn', value: 'Issue a warning to a user at a configured level. Requires a reason. Triggers escalation checks automatically.' },
        { name: '/userinfo', value: 'View a user\'s full moderation profile — warnings, kicks, bans, notes, and more.' },
        { name: '/unwarn', value: 'Remove a warning role from a user. Shows a confirm/cancel prompt before executing.' },
        { name: '/timeout', value: 'Apply a Discord native timeout to a user. Duration uses `m:s`, `h:m:s`, or `d:h:m:s` format (max 28 days).' },
        { name: '/mywarnings', value: 'Check your own active warnings and how long is left on each one.' },
        { name: '/warnlist', value: 'View all active warnings in the server, paginated 10 users per page.' },
        { name: '/history', value: 'View the last 10 warning history entries for a specific user, including expired and manually removed warnings.' }
    ).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_mod: new EmbedBuilder().setColor('#ff6600').setTitle('Moderation Commands').addFields(
        { name: '/kick', value: 'Kick a user from the server. Sends a DM, logs to history, and posts to the mod-log channel.' },
        { name: '/ban', value: 'Ban a user. Optional timed ban with auto-unban on expiry. Optionally delete recent messages (0–7 days).' },
        { name: '/unban', value: 'Unban a user by their ID. Logs to history and mod-log channel.' },
        { name: '/timeout', value: 'Apply a Discord native timeout. Duration uses `m:s`, `h:m:s`, or `d:h:m:s` (max 28 days).' },
        { name: '/userinfo', value: 'View account info, roles, active warnings, warn counts per level, kicks, bans, and notes for any user.' }
    ).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_config: new EmbedBuilder().setColor('#00ff00').setTitle('Config Commands').addFields(
        { name: '/config set', value: 'Set up a warning level: assign a role and a duration (`m:s`, `h:m:s`, `d:h:m:s`, or `forever`).' },
        { name: '/config view', value: 'View all configured warning levels, their roles, durations, and warn DM status.' },
        { name: '/config access', value: 'Choose which role can use moderation commands. Admins always have access regardless.' },
        { name: '/config logchannel', value: 'Set a channel where every mod action (warn, kick, ban, timeout) is automatically logged.' },
        { name: '/config removelogchannel', value: 'Remove the mod-log channel.' },
        { name: '/config remove', value: 'Remove a warning level from the configuration entirely.' },
        { name: '/config warndm', value: 'Toggle whether users are DM\'d when they receive a warning. Enabled by default.' }
    ).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_escalation: new EmbedBuilder().setColor('#ff9900').setTitle('Escalation Commands').addFields(
        { name: '/escalation set', value: 'Set a threshold: once a user reaches N warnings at level X, they are auto-escalated to level X+1.' },
        { name: '/escalation remove', value: 'Remove a threshold for a specific warning level.' },
        { name: '/escalation setcap / removecap', value: 'Set or remove a maximum warning level. Escalation will not go beyond the cap.' },
        { name: '/escalation settimeout', value: 'Configure a self-contained timeout escalation: N warnings at level X → auto level X+1 + a timeout. Fully independent from `/escalation set`.' },
        { name: '/escalation removetimeout', value: 'Remove a timeout escalation rule for a level.' },
        { name: '/escalation view', value: 'View all active escalation rules, thresholds, timeouts, and the level cap.' }
    ).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_notes: new EmbedBuilder().setColor('#9b59b6').setTitle('Note Commands').addFields(
        { name: '/note add', value: 'Add a private mod note to a user. Not visible to the user — for internal tracking only.' },
        { name: '/note view', value: 'View all notes on a user, with timestamps and which mod added them.' },
        { name: '/note delete', value: 'Delete a note by its ID (shown in `/note view`).' }
    ).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_storage: new EmbedBuilder().setColor('#5865F2').setTitle('Database Storage')
        .setDescription('Police Bot uses PostgreSQL to store all data persistently. Nothing is lost on restarts.')
        .addFields(
            { name: 'warnings', value: 'All active warnings with expiry timestamps, user IDs, role IDs, and channel IDs for timer restoration.' },
            { name: 'history', value: 'Full warning history per server — every warn, kick, and ban ever issued.' },
            { name: 'configs', value: 'All per-server configuration: warning levels, roles, durations, escalation rules, and the access role.' },
            { name: 'notes', value: 'Private mod notes per user, stored separately from the warning history.' }
        ).setFooter({ text: 'Use the buttons to explore other categories' }),
    help_features: new EmbedBuilder().setColor('#9b59b6').setTitle('Other Features').addFields(
        { name: 'Warning expiry DMs', value: 'Users are DM\'d when a warning is issued (if enabled) and again when it expires and the role is removed.' },
        { name: 'Rejoin protection', value: 'If a warned user leaves and rejoins the server, their warning roles are automatically reapplied and they are DM\'d.' },
        { name: 'Timer restoration', value: 'On bot restart, all active warning timers are restored from the database so no warning expires silently.' },
        { name: 'Audit logging', value: 'Sensitive commands (warn, unwarn, timeout, config) are logged to console with the moderator\'s tag.' },
        { name: '/invite', value: 'Get a pre-configured invite link with all required permissions to add the bot to another server.' },
        { name: '/help', value: 'This interactive help menu.' }
    ).setFooter({ text: 'Use the buttons to explore other categories' }),
};
const helpOverviewEmbed = () => new EmbedBuilder().setColor('#5865F2').setTitle('Police Bot')
    .setDescription("I'm just your friendly neighbourhood policemen, but I do have some tricks up my sleeve. Press the buttons below to learn about my commands.")
    .setFooter({ text: 'Mod commands require the configured access role or Administrator' });
function helpRows(active = '') {
    const p = (id, label, sec = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(active === id ? ButtonStyle.Success : sec ? ButtonStyle.Secondary : ButtonStyle.Primary);
    return [
        new ActionRowBuilder().addComponents(p('help_warn','Warnings'), p('help_mod','Moderation'), p('help_config','Config'), p('help_escalation','Escalation')),
        new ActionRowBuilder().addComponents(p('help_notes','Notes',true), p('help_storage','Storage',true), p('help_features','Features',true), ...(active ? [p('help_back','Back',true)] : []))
    ];
}

// ── Bot ready ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`✅ Police bot online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Monitoring the security cameras', type: ActivityType.Watching }], status: 'online' });

    const commands = [
        new SlashCommandBuilder().setName('invite').setDescription('Get a link to invite this bot to another server'),
        new SlashCommandBuilder().setName('warn').setDescription('Give a warning to a user')
            .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
            .addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for the warning')),
        new SlashCommandBuilder().setName('unwarn').setDescription('Remove a warning from a user')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
        new SlashCommandBuilder().setName('timeout').setDescription('Apply a Discord timeout to a user')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
            .addStringOption(o => o.setName('duration').setDescription('m:s / h:m:s / d:h:m:s, max 28 days').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason')),
        new SlashCommandBuilder().setName('mywarnings').setDescription('Check your active warnings'),
        new SlashCommandBuilder().setName('warnlist').setDescription('View all active warnings in this server'),
        new SlashCommandBuilder().setName('history').setDescription('View warning history for a user')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
        new SlashCommandBuilder().setName('kick').setDescription('Kick a user')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
        new SlashCommandBuilder().setName('ban').setDescription('Ban a user')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true))
            .addStringOption(o => o.setName('duration').setDescription('Optional timed ban duration (m:s / h:m:s / d:h:m:s)'))
            .addIntegerOption(o => o.setName('delete_days').setDescription('Days of messages to delete (0-7)').setMinValue(0).setMaxValue(7)),
        new SlashCommandBuilder().setName('userinfo').setDescription('View info and moderation history for a user')
            .addUserOption(o => o.setName('user').setDescription('User to look up').setRequired(true)),
        new SlashCommandBuilder().setName('unban').setDescription('Unban a user from the server')
            .addStringOption(o => o.setName('user_id').setDescription('User ID to unban').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for unban')),
        new SlashCommandBuilder().setName('note').setDescription('Manage mod notes on a user')
            .addSubcommand(s => s.setName('add').setDescription('Add a note').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addStringOption(o => o.setName('text').setDescription('Note content').setRequired(true)))
            .addSubcommand(s => s.setName('view').setDescription('View notes').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)))
            .addSubcommand(s => s.setName('delete').setDescription('Delete a note by ID').addUserOption(o => o.setName('user').setDescription('User').setRequired(true)).addIntegerOption(o => o.setName('id').setDescription('Note ID').setRequired(true))),
        new SlashCommandBuilder().setName('config').setDescription('Configure the bot')
            .addSubcommand(s => s.setName('set').setDescription('Set up a warning level')
                .addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true))
                .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))
                .addStringOption(o => o.setName('duration').setDescription('d:h:m:s or "forever"').setRequired(true)))
            .addSubcommand(s => s.setName('view').setDescription('View all configured warning levels'))
            .addSubcommand(s => s.setName('access').setDescription('Set which role can use moderation commands'))
            .addSubcommand(s => s.setName('logchannel').setDescription('Set the mod-log channel').addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
            .addSubcommand(s => s.setName('removelogchannel').setDescription('Remove the mod-log channel'))
            .addSubcommand(s => s.setName('remove').setDescription('Remove a warning level').addIntegerOption(o => o.setName('level').setDescription('Warning level to remove').setRequired(true)))
            .addSubcommand(s => s.setName('warndm').setDescription('Toggle whether users are DM\'d when warned').addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable warn DMs').setRequired(true))),
        new SlashCommandBuilder().setName('escalation').setDescription('Configure auto-escalation rules')
            .addSubcommand(s => s.setName('set').setDescription('Set escalation threshold')
                .addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true))
                .addIntegerOption(o => o.setName('threshold').setDescription('Number of warnings to trigger escalation').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('Remove escalation threshold').addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true)))
            .addSubcommand(s => s.setName('setcap').setDescription('Set max escalation level').addIntegerOption(o => o.setName('level').setDescription('Cap level').setRequired(true)))
            .addSubcommand(s => s.setName('removecap').setDescription('Remove the level cap'))
            .addSubcommand(s => s.setName('settimeout').setDescription('Configure timeout-escalation: N warnings → escalate + timeout')
                .addIntegerOption(o => o.setName('level').setDescription('Target level (≥2)').setRequired(true))
                .addIntegerOption(o => o.setName('threshold').setDescription('Warnings needed (2–50)').setRequired(true))
                .addStringOption(o => o.setName('duration').setDescription('Timeout duration (max 28 days)').setRequired(true)))
            .addSubcommand(s => s.setName('removetimeout').setDescription('Remove timeout from escalation level').addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true)))
            .addSubcommand(s => s.setName('view').setDescription('View escalation configuration')),
        new SlashCommandBuilder().setName('help').setDescription('View all commands and features'),
    ].map(c => c.toJSON());

    client.application.commands.set(commands);
    console.log('✅ Commands registered');
    try {
        await initDB();
        const [wRes, cRes] = await Promise.all([pool.query('SELECT key, data FROM warnings'), pool.query('SELECT guild_id, data FROM configs')]);
        for (const { key, data } of wRes.rows) activeWarnings.set(key, data);
        for (const { guild_id, data } of cRes.rows) configCache.set(guild_id, data);
        console.log(`🔄 Loaded ${activeWarnings.size} warnings, ${configCache.size} configs`);
        for (const [key, w] of activeWarnings.entries()) if (!w.isForever) scheduleWarningRemoval(key, w.guildId, w.userId, w.roleId, w.expiresAt, w.channelId);
        // Restore timed bans
        const banRes = await pool.query("SELECT guild_id, user_id, data FROM history WHERE data->>'type' = 'ban' AND data->>'expiresAt' IS NOT NULL ORDER BY id DESC");
        const seenBans = new Set();
        for (const { guild_id, user_id, data } of banRes.rows) {
            const key = `${guild_id}-${user_id}`;
            if (seenBans.has(key)) continue; seenBans.add(key);
            // Check not already unbanned (look for a later unban entry)
            const unbanRes = await pool.query("SELECT id FROM history WHERE guild_id = $1 AND user_id = $2 AND data->>'type' = 'unban' AND id > (SELECT id FROM history WHERE guild_id = $1 AND user_id = $2 AND data = $3::jsonb LIMIT 1) LIMIT 1", [guild_id, user_id, JSON.stringify(data)]);
            if (unbanRes.rows.length) continue;
            if (data.expiresAt > Date.now()) scheduleBanExpiry(guild_id, user_id, data.userTag, data.expiresAt, data.reason);
        }
        console.log('🔄 Timed bans restored');
    } catch (e) { console.error('❌ DB init failed:', e.message); }
    keepAlive();
});

// ── Guild join ─────────────────────────────────────────────────────────────
client.on('guildCreate', async guild => {
    console.log(`Bot joined: ${guild.name}`);
    const cfg = await getConfig(guild.id);
    if (!cfg.levels) saveConfig(guild.id, { levels: {} });
    try {
        const logs = await guild.fetchAuditLogs({ type: 28, limit: 5 });
        const entry = logs.entries.find(e => e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 60000);
        if (guild.systemChannel) guild.systemChannel.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('👋 Thanks for adding Police Bot!')
            .setDescription(`${entry?.executor?.id ? `<@${entry.executor.id}>, please` : 'An administrator should'} run \`/config access\` to set up command permissions.\n\n**Quick Start:**\n1. \`/config access\` — set the moderator role\n2. \`/config set\` — set up warning levels\n3. \`/warn\` — start moderating!`)
            .setFooter({ text: 'Use /help to see all commands' })] }).catch(() => {});
    } catch (e) { console.error('guildCreate error:', e); }
});

// ── Rejoin protection ──────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
    const userWarnings = [...activeWarnings.entries()].filter(([, w]) => w.guildId === member.guild.id && w.userId === member.id);
    if (!userWarnings.length) return;
    for (const [, w] of userWarnings) { const role = member.guild.roles.cache.get(w.roleId); if (role) await member.roles.add(role).catch(() => {}); }
    member.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ Warning Reinstated')
        .setDescription(`Your active warning(s) in **${member.guild.name}** have been reapplied because you rejoined.`)
        .addFields({ name: 'Active Warnings', value: userWarnings.map(([, w]) => `Level ${w.level} — ${w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt / 1000)}:R>`}`).join('\n') }).setTimestamp()]
    }).catch(() => {});
});

// ── Interactions ───────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('unwarn_select_')) {
        if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const pendingId = interaction.customId.slice(14);
        const pending = pendingUnwarns.get(pendingId);
        if (!pending) return interaction.update({ content: '❌ Confirmation expired. Run `/unwarn` again.', embeds: [], components: [] });
        if (interaction.user.id !== pending.modId) return interaction.reply({ content: '❌ Only the moderator who ran this command can use this.', flags: [MessageFlags.Ephemeral] });
        const selectedKey = interaction.values[0];
        const w = activeWarnings.get(selectedKey);
        if (!w) return interaction.update({ content: '❌ Warning no longer exists.', embeds: [], components: [] });
        pendingUnwarns.set(pendingId, { ...pending, selectedKey, roleId: w.roleId, level: w.level });
        const role = interaction.guild.roles.cache.get(w.roleId);
        const E2 = (color, title) => new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
        await interaction.update({ embeds: [E2('#FFA500','⚠️ Confirm Unwarn').setDescription(`Remove **Level ${w.level}** warning from <@${pending.targetUserId}>?`).addFields({ name: 'Role', value: role ? `${role}` : w.roleName, inline: true }, { name: 'Issued', value: `<t:${Math.floor(w.issuedAt/1000)}:R>`, inline: true }, { name: 'Reason', value: w.reason || 'No reason', inline: false }).setFooter({ text: 'Expires in 60 seconds' })], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`unwarn_confirm_${pendingId}`).setLabel('Confirm').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`unwarn_cancel_${pendingId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
        return;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('access_role_')) {
        const guildId = interaction.customId.replace('access_role_', '');
        if (guildId !== interaction.guild.id) return interaction.reply({ content: '❌ Invalid interaction.', flags: [MessageFlags.Ephemeral] });
        const role = interaction.roles.first();
        if (!role) return interaction.reply({ content: '❌ No role selected.', flags: [MessageFlags.Ephemeral] });
        if (role.id === interaction.guild.id) return interaction.update({ content: '❌ Cannot use @everyone.', components: [] });
        if (role.managed) return interaction.update({ content: '❌ Cannot use managed/bot roles.', components: [] });
        const cfg = await getConfig(guildId); cfg.accessRoleId = role.id; saveConfig(guildId, cfg);
        await interaction.update({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Access Control Updated').setDescription(`Members with the ${role} role can now use moderation commands.\n\n*Server administrators always have access.*`).setTimestamp()], components: [] });
        console.log(`🔒 [AUDIT] Access role set to ${role.name} in ${interaction.guild.name}`);
        return;
    }

    if (interaction.isButton()) {
        const { customId } = interaction;
        if (customId.startsWith('help_') && customId !== 'help_back') {
            const embed = helpPages[customId];
            if (!embed) return;
            return interaction.update({ embeds: [embed], components: helpRows(customId) });
        }
        if (customId === 'help_back') return interaction.update({ embeds: [helpOverviewEmbed()], components: helpRows() });
        if (customId.startsWith('wl_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            const parts = customId.split('_'), page = parseInt(parts[1]), guildId = parts.slice(2).join('_');
            const { embed, totalPages, page: p } = buildWarnlistEmbed(guildId, page);
            return interaction.update({ embeds: [embed], components: warnlistRow(p, totalPages, guildId) });
        }
        if (customId.startsWith('unwarn_confirm_') || customId.startsWith('unwarn_cancel_')) {
            const isConfirm = customId.startsWith('unwarn_confirm_');
            const pendingId = customId.slice(isConfirm ? 15 : 13);
            const pending = pendingUnwarns.get(pendingId);
            if (!pending) return interaction.update({ content: '❌ Confirmation expired. Run `/unwarn` again.', embeds: [], components: [] });
            if (interaction.user.id !== pending.modId) return interaction.reply({ content: '❌ Only the moderator who ran this command can confirm.', flags: [MessageFlags.Ephemeral] });
            if (!isConfirm) { pendingUnwarns.delete(pendingId); return interaction.update({ content: '✅ Unwarn cancelled.', embeds: [], components: [] }); }
            pendingUnwarns.delete(pendingId);
            const { targetUserId, targetUserTag, level, guildId, roleId, selectedKey } = pending;
            const member = interaction.guild.members.cache.get(targetUserId);
            const role = interaction.guild.roles.cache.get(roleId);
            if (!member) return interaction.update({ content: '❌ User is no longer in this server.', embeds: [], components: [] });
            if (!role) return interaction.update({ content: '❌ Role not found.', embeds: [], components: [] });
            await member.roles.remove(role);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} unwarned ${targetUserTag} (Level ${level}) in ${interaction.guild.name}`);
            // If a specific warning key was selected, remove only that one; else remove all at that level
            const keys = selectedKey ? [selectedKey] : [...activeWarnings.entries()].filter(([, w]) => w.userId === targetUserId && w.guildId === guildId && w.level === level).map(([k]) => k);
            for (const k of keys) { addHistory(guildId, targetUserId, { ...activeWarnings.get(k), endedAt: Date.now(), endReason: 'manual' }); clearTimeout(warningTimers.get(k)); warningTimers.delete(k); deleteWarning(k); }
            logMod(interaction.guild, guildId, new EmbedBuilder().setColor('#00ff00').setTitle('Warning Removed').addFields({ name: 'User', value: `<@${targetUserId}> (${targetUserTag})`, inline: true }, { name: 'Level', value: `${level}`, inline: true }, { name: 'Role', value: `${role}`, inline: true }, { name: 'Removed by', value: `${interaction.user}` }).setTimestamp());
            await interaction.update({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Warning Removed').addFields({ name: 'User', value: `<@${targetUserId}>`, inline: true }, { name: 'Level', value: `${level}`, inline: true }, { name: 'Role', value: `${role}`, inline: true }, { name: 'Removed by', value: `${interaction.user}` }).setTimestamp()], components: [] });
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;
    const { commandName, guildId } = interaction;
    if (!interaction.guild) return interaction.reply({ content: '❌ Server only.', flags: [MessageFlags.Ephemeral] });

    const restricted = ['config','warn','unwarn','timeout','kick','ban','unban','note','userinfo','warnlist','history','escalation'];
    if (restricted.includes(commandName) && !await hasCommandPermission(interaction, guildId)) {
        const cfg = await getConfig(guildId);
        return interaction.reply({ content: `❌ No permission.\n\n**Required:** Administrator OR ${cfg.accessRoleId ? `<@&${cfg.accessRoleId}>` : 'no role configured'}\n\nAsk an admin to run \`/config access\`.`, flags: [MessageFlags.Ephemeral] });
    }

    const E = (color, title) => new EmbedBuilder().setColor(color).setTitle(title).setTimestamp();
    const reply = (opts) => interaction.reply(typeof opts === 'string' ? { content: opts, flags: [MessageFlags.Ephemeral] } : opts);

    if (commandName === 'invite') {
        const perms = PermissionFlagsBits.ManageRoles | PermissionFlagsBits.KickMembers | PermissionFlagsBits.BanMembers | PermissionFlagsBits.ModerateMembers | PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.ReadMessageHistory | PermissionFlagsBits.ViewAuditLog;
        const url = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${perms}&scope=bot%20applications.commands`;
        return reply({ embeds: [E('#5865F2','➕ Invite Police Bot').setDescription(`[**Click here to invite me**](${url})\n\nThis link requests the minimum permissions needed to function correctly.`).addFields({ name: 'Permissions Requested', value: '• Manage Roles — assign/remove warning roles\n• Kick & Ban Members — moderation commands\n• Moderate Members — timeouts\n• Send Messages & Embed Links — responses\n• View Audit Log — detect who added the bot\n• Read Message History — channel access' }).setFooter({ text: 'You can adjust permissions after inviting' })], flags: [MessageFlags.Ephemeral] });
    }

    else if (commandName === 'help') {
        await reply({ embeds: [helpOverviewEmbed()], components: helpRows(), flags: [MessageFlags.Ephemeral] });
    }

    else if (commandName === 'config') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'access') { await showAccessControlConfig(interaction, guildId); }
        else if (sub === 'set') {
            const level = interaction.options.getInteger('level'), role = interaction.options.getRole('role'), durationStr = interaction.options.getString('duration');
            if (level < 1 || level > 100) return reply('❌ Level must be between 1 and 100.');
            const dur = parseDuration(durationStr);
            if (!dur) return reply('❌ Invalid duration. Use `m:s`, `h:m:s`, `d:h:m:s`, or `forever`. Max 365 days.');
            const cfg = await getConfig(guildId); cfg.levels ??= {};
            cfg.levels[level] = { roleId: role.id, roleName: role.name, durationMs: dur.totalMs, isForever: dur.isForever, durationDisplay: formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds, dur.isForever) };
            saveConfig(guildId, cfg);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} configured Level ${level} → ${role.name} in ${interaction.guild.name}`);
            await reply({ embeds: [E('#00ff00','🚨 Warning Level Configured').addFields({ name: 'Level', value: `${level}`, inline: true }, { name: 'Role', value: `${role}`, inline: true }, { name: 'Duration', value: formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds, dur.isForever), inline: true })], flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'view') {
            const cfg = await getConfig(guildId);
            if (!cfg.levels || !Object.keys(cfg.levels).length) return reply('📋 No warning levels configured yet. Use /config set to add some.');
            const embed = E('#0099ff','🚨 Warning Configuration');
            for (const [lvl, d] of Object.entries(cfg.levels)) embed.addFields({ name: `Level ${lvl}`, value: `Role: <@&${d.roleId}>\nDuration: ${d.durationDisplay}`, inline: true });
            embed.addFields({ name: 'Warn DMs', value: cfg.warnDm === false ? '🔕 Disabled' : '✅ Enabled', inline: true });
            await reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'logchannel') {
            const channel = interaction.options.getChannel('channel');
            if (!channel.isTextBased()) return reply('❌ Please select a text channel.');
            const cfg = await getConfig(guildId); cfg.logChannelId = channel.id; saveConfig(guildId, cfg);
            await reply(`✅ Mod-log channel set to ${channel}.`);
        } else if (sub === 'removelogchannel') {
            const cfg = await getConfig(guildId);
            if (!cfg.logChannelId) return reply('❌ No log channel is currently set.');
            delete cfg.logChannelId; saveConfig(guildId, cfg);
            await reply('✅ Mod-log channel removed.');
        } else if (sub === 'remove') {
            const level = interaction.options.getInteger('level');
            const cfg = await getConfig(guildId);
            if (!cfg.levels?.[level]) return reply(`❌ Level ${level} is not configured.`);
            const roleName = cfg.levels[level].roleName;
            delete cfg.levels[level]; saveConfig(guildId, cfg);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} removed Level ${level} config in ${interaction.guild.name}`);
            await reply(`✅ Warning Level ${level} (${roleName}) removed from config.`);
        } else if (sub === 'warndm') {
            const enabled = interaction.options.getBoolean('enabled');
            const cfg = await getConfig(guildId); cfg.warnDm = enabled; saveConfig(guildId, cfg);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} set warnDm=${enabled} in ${interaction.guild.name}`);
            await reply({ embeds: [E(enabled ? '#00ff00' : '#FFA500', enabled ? '✅ Warn DMs Enabled' : '🔕 Warn DMs Disabled').setDescription(enabled ? 'Users will be DM\'d when they receive a warning.' : 'Users will **not** be DM\'d when they receive a warning.')], flags: [MessageFlags.Ephemeral] });
        }
    }

    else if (commandName === 'warn') {
        const user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
        const level = interaction.options.getInteger('level'), reason = (interaction.options.getString('reason') || 'No reason provided').slice(0,1000).replace(/[\x00-\x1F\x7F]/g,'');
        if (level < 1 || level > 100) return reply('❌ Level must be between 1 and 100.');
        if (!member) return reply(`❌ ${user} is not in this server.`);
        const cfg = await getConfig(guildId);
        if (!cfg.levels?.[level]) return reply(`❌ Level ${level} is not configured. Use /config set first.`);
        const botMember = interaction.guild.members.me, configRole = interaction.guild.roles.cache.get(cfg.levels[level].roleId);
        if (!configRole) return reply('❌ Configured role not found. Please re-run /config set.');
        if (configRole.position >= botMember.roles.highest.position) return reply(`❌ My role must be above ${configRole} in the role list.`);
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return reply('❌ I need the "Manage Roles" permission.');
        try {
            const result = await applyWarning(interaction.guild, member, user, guildId, level, reason, interaction.channel.id, interaction.user.tag);
            if (result.error) return reply(`❌ ${result.error}`);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} warned ${user.tag} (Level ${level}) in ${interaction.guild.name}`);
            logMod(interaction.guild, guildId, E('#ff0000','Warning Issued').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Level', value: `${level}`, inline: true }, { name: 'Duration', value: result.config.durationDisplay||'Unknown', inline: true }, { name: 'Reason', value: reason }, { name: 'Moderator', value: `${interaction.user}` }));
            await reply({ embeds: [E('#ff0000','⚠️ Warning Issued').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Level', value: `${level}`, inline: true }, { name: 'Role', value: `${result.role}`, inline: true }, { name: 'Duration', value: result.config.durationDisplay||'Unknown', inline: true }, { name: 'Reason', value: reason }, { name: 'Issued by', value: `${interaction.user}` })] });
            const esc = await checkEscalation(interaction.guild, member, user, guildId, level, interaction.channel.id, interaction.user.tag);
            if (esc?.escalated) await interaction.followUp({ content: `⬆️ ${user} auto-escalated to **Level ${esc.nextLevel}** (${esc.role}).${esc.timedOut?` 🔇 Timeout: **${esc.timeoutDisplay}**.`:''}${esc.hitCap?`\n🚨 Reached cap (Level ${esc.nextLevel}).`:''}`, flags: [MessageFlags.Ephemeral] });
            else if (esc?.atCap) await interaction.followUp({ content: `🚨 Threshold hit for Level ${level}, but cap (Level ${esc.cap}) prevents further escalation.`, flags: [MessageFlags.Ephemeral] });
            else if (esc?.noNextLevel) await interaction.followUp({ content: `ℹ️ Threshold hit for Level ${level}, but Level ${esc.nextLevel} isn't configured.`, flags: [MessageFlags.Ephemeral] });
            else if (esc?.counted) await interaction.followUp({ content: `📊 Escalation: ${esc.count}/${esc.threshold} warnings at Level ${level}.`, flags: [MessageFlags.Ephemeral] });
        } catch (e) { console.error(e); await reply('❌ Failed to assign warning. Check permissions.'); }
    }

    else if (commandName === 'unwarn') {
        const user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
        if (!member) return reply(`❌ ${user} is not in this server.`);
        const userWarnings = [...activeWarnings.entries()].filter(([, w]) => w.guildId === guildId && w.userId === user.id);
        if (!userWarnings.length) return reply(`❌ ${user} has no active warnings.`);
        const options = userWarnings.slice(0, 25).map(([key, w]) => {
            const expires = w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt/1000)}:R>`;
            return { label: `Level ${w.level} — ${w.roleName}`, description: `${expires} · ${(w.reason||'No reason').slice(0,50)}`, value: key };
        });
        const pendingId = interaction.id;
        pendingUnwarns.set(pendingId, { targetUserId: user.id, targetUserTag: user.tag, guildId, modId: interaction.user.id });
        setTimeout(() => pendingUnwarns.delete(pendingId), 60_000);
        const cfg = await getConfig(guildId);
        await reply({ embeds: [E('#FFA500','⚠️ Remove a Warning').setDescription(`Select which warning to remove from ${user}.`).addFields({ name: 'Active Warnings', value: `${userWarnings.length} warning${userWarnings.length>1?'s':''} on record` }).setFooter({ text: 'Expires in 60 seconds' })], components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`unwarn_select_${pendingId}`).setPlaceholder('Select a warning to remove…').addOptions(options))], flags: [MessageFlags.Ephemeral] });
    }

    else if (commandName === 'timeout') {
        const user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
        const reason = (interaction.options.getString('reason') || 'No reason provided').slice(0,512).replace(/[\x00-\x1F\x7F]/g,'');
        if (!member) return reply(`❌ ${user} is not in this server.`);
        const dur = parseDuration(interaction.options.getString('duration'));
        if (!dur || dur.isForever) return reply('❌ Invalid duration. Use `m:s`, `h:m:s`, or `d:h:m:s`. Max 28 days.');
        if (dur.totalMs > MAX_TIMEOUT_MS) return reply('❌ Discord timeouts cannot exceed 28 days.');
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) return reply('❌ I need the "Moderate Members" permission.');
        if (member.roles.highest.position >= botMember.roles.highest.position) return reply('❌ Cannot timeout this user — their role is equal to or above mine.');
        try {
            await member.timeout(dur.totalMs, reason);
            const dd = formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds), exTs = Math.floor((Date.now()+dur.totalMs)/1000);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} timed out ${user.tag} for ${dd} in ${interaction.guild.name}`);
            logMod(interaction.guild, guildId, E('#ff6600','Member Timed Out').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Duration', value: dd, inline: true }, { name: 'Expires', value: `<t:${exTs}:R>`, inline: true }, { name: 'Reason', value: reason }, { name: 'Moderator', value: `${interaction.user}` }));
            user.send({ embeds: [E('#ff6600','🔇 You Have Been Timed Out').setDescription(`You were timed out in **${interaction.guild.name}**.`).addFields({ name: 'Duration', value: dd, inline: true }, { name: 'Expires', value: `<t:${exTs}:R>`, inline: true }, { name: 'Reason', value: reason })] }).catch(() => {});
            await reply({ embeds: [E('#ff6600','🔇 Timeout Applied').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Duration', value: dd, inline: true }, { name: 'Expires', value: `<t:${exTs}:R>`, inline: true }, { name: 'Reason', value: reason }, { name: 'Issued by', value: `${interaction.user}` })] });
        } catch (e) { console.error(e); await reply('❌ Failed to apply timeout. Check permissions.'); }
    }

    else if (commandName === 'mywarnings') {
        const userWarnings = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === interaction.user.id);
        if (!userWarnings.length) return reply('✅ You have no active warnings!');
        const cfg = await getConfig(guildId);
        const embed = E('#FFA500','⏰ Your Active Warnings').setDescription(`You have ${userWarnings.length} active warning${userWarnings.length>1?'s':''}`).setFooter({ text: 'Warnings are automatically removed when they expire' });
        for (const w of userWarnings) {
            const lc = cfg.levels?.[w.level], name = `Level ${w.level} — ${lc?.roleName||'Unknown Role'}`;
            if (w.isForever) embed.addFields({ name, value: '⏳ **Duration:** Forever\n🔒 **Status:** Permanent' });
            else {
                const t = w.expiresAt - Date.now();
                embed.addFields({ name, value: t <= 0 ? '⏳ Expired (will be removed shortly)' : (() => { const s = Math.floor(t/1000); return `⏳ **Time Left:** ${formatDuration(Math.floor(s/86400),Math.floor((s%86400)/3600),Math.floor((s%3600)/60),s%60)}\n📅 **Expires:** <t:${Math.floor(w.expiresAt/1000)}:F>`; })() });
            }
        }
        await reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    else if (commandName === 'warnlist') {
        const { embed, totalPages, page } = buildWarnlistEmbed(guildId, 0);
        await reply({ embeds: [embed], components: warnlistRow(page, totalPages, guildId) });
    }

    else if (commandName === 'history') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const user = interaction.options.getUser('user');
        const entries = await getHistory(guildId, user.id);
        if (!entries.length) return interaction.editReply({ content: `📋 No warning history found for ${user}.` });
        const embed = E('#5865F2',`📋 Warning History — ${user.tag}`).setDescription(`Showing last ${entries.length} record${entries.length>1?'s':''}.`);
        for (const e of entries) {
            if (e.type === 'kick') embed.addFields({ name: `Kick — <t:${Math.floor(e.issuedAt/1000)}:d>`, value: `by ${e.issuedBy}\n${e.reason}` });
            else if (e.type === 'ban') embed.addFields({ name: `Ban — <t:${Math.floor(e.issuedAt/1000)}:d>`, value: `by ${e.issuedBy}\n${e.reason}` });
            else { const s = e.endReason==='expired'?'✅ Expired':e.endReason==='manual'?'🔓 Removed':'⏳ Active'; embed.addFields({ name: `Level ${e.level} — ${e.roleName} — <t:${Math.floor(e.issuedAt/1000)}:d>`, value: `${s} • by ${e.issuedBy}\n${e.reason}` }); }
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
        try {
            user.send({ embeds: [E('#ff6600','You have been kicked').setDescription(`You were kicked from **${interaction.guild.name}**.`).addFields({ name: 'Reason', value: reason })] }).catch(() => {});
            await member.kick(reason);
            addHistory(guildId, user.id, { guildId, userId: user.id, userTag: user.tag, type: 'kick', reason, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            console.log(`🔒 [AUDIT] ${interaction.user.tag} kicked ${user.tag} from ${interaction.guild.name}`);
            logMod(interaction.guild, guildId, E('#ff6600','Member Kicked').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Moderator', value: `${interaction.user}`, inline: true }, { name: 'Reason', value: reason }));
            await reply({ embeds: [E('#ff6600','Member Kicked').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Reason', value: reason }, { name: 'Kicked by', value: `${interaction.user}` })] });
        } catch (e) { console.error(e); await reply('❌ Failed to kick user. Check permissions.'); }
    }

    else if (commandName === 'ban') {
        const user = interaction.options.getUser('user'), member = interaction.guild.members.cache.get(user.id);
        const reason = interaction.options.getString('reason').slice(0,512).replace(/[ -]/g,''), deleteDays = interaction.options.getInteger('delete_days') ?? 0;
        const durationStr = interaction.options.getString('duration');
        const dur = durationStr ? parseDuration(durationStr) : null;
        if (durationStr && (!dur || dur.isForever)) return reply('❌ Invalid duration. Use `m:s`, `h:m:s`, or `d:h:m:s`. "forever" is not valid — omit duration for a permanent ban.');
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) return reply('❌ I need the "Ban Members" permission.');
        if (member && member.roles.highest.position >= botMember.roles.highest.position) return reply('❌ Cannot ban this user — their role is equal to or above mine.');
        try {
            const dd = dur ? formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds) : null;
            const expiresAt = dur ? Date.now() + dur.totalMs : null;
            const exTs = expiresAt ? Math.floor(expiresAt / 1000) : null;
            if (member) user.send({ embeds: [E('#ff0000','You have been banned').setDescription(`You were banned from **${interaction.guild.name}**.`).addFields({ name: 'Reason', value: reason }, ...(dd ? [{ name: 'Duration', value: dd, inline: true }, { name: 'Expires', value: `<t:${exTs}:R>`, inline: true }] : []))] }).catch(() => {});
            await interaction.guild.members.ban(user, { reason, deleteMessageDays: deleteDays });
            addHistory(guildId, user.id, { guildId, userId: user.id, userTag: user.tag, type: 'ban', reason, issuedBy: interaction.user.tag, issuedAt: Date.now(), deleteDays, expiresAt });
            if (expiresAt) scheduleBanExpiry(guildId, user.id, user.tag, expiresAt, reason);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} banned ${user.tag} from ${interaction.guild.name}${dd ? ` for ${dd}` : ''}`);
            logMod(interaction.guild, guildId, E('#ff0000','Member Banned').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Moderator', value: `${interaction.user}`, inline: true }, { name: 'Duration', value: dd || 'Permanent', inline: true }, ...(exTs ? [{ name: 'Expires', value: `<t:${exTs}:R>`, inline: true }] : []), { name: 'Messages Deleted', value: `${deleteDays} day(s)`, inline: true }, { name: 'Reason', value: reason }));
            await reply({ embeds: [E('#ff0000','Member Banned').addFields({ name: 'User', value: `${user}`, inline: true }, { name: 'Duration', value: dd || 'Permanent', inline: true }, ...(exTs ? [{ name: 'Expires', value: `<t:${exTs}:R>`, inline: true }] : []), { name: 'Messages Deleted', value: `${deleteDays} day(s)`, inline: true }, { name: 'Reason', value: reason }, { name: 'Banned by', value: `${interaction.user}` })] });
        } catch (e) { console.error(e); await reply('❌ Failed to ban user. Check permissions.'); }
    }

    else if (commandName === 'userinfo') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const user = interaction.options.getUser('user');
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        const cfg = await getConfig(guildId);
        const allHistory = await getAllHistory(guildId, user.id);
        const activeUserWarnings = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === user.id);
        const notes = await getNotes(guildId, user.id);

        // Stats from history
        const warnCounts = {}, kicks = allHistory.filter(e => e.type === 'kick').length, bans = allHistory.filter(e => e.type === 'ban').length;
        for (const e of allHistory.filter(e => !e.type)) { warnCounts[e.level] = (warnCounts[e.level] || 0) + 1; }
        const timeoutCount = allHistory.filter(e => e.type === 'timeout').length;

        const embed = E('#5865F2', `👤 ${user.tag}`)
            .setThumbnail(user.displayAvatarURL())
            .addFields(
                { name: 'Account Created', value: `<t:${Math.floor(user.createdTimestamp/1000)}:D> (<t:${Math.floor(user.createdTimestamp/1000)}:R>)`, inline: true },
                { name: 'Joined Server', value: member ? `<t:${Math.floor(member.joinedTimestamp/1000)}:D> (<t:${Math.floor(member.joinedTimestamp/1000)}:R>)` : 'Not in server', inline: true }
            );

        if (member) {
            const roles = member.roles.cache.filter(r => r.id !== interaction.guild.id).sort((a,b) => b.position - a.position).map(r => `${r}`).slice(0,10).join(' ');
            if (roles) embed.addFields({ name: 'Roles', value: roles || 'None' });
        }

        const warnSummary = Object.keys(warnCounts).length
            ? Object.entries(warnCounts).sort(([a],[b])=>a-b).map(([l,c]) => `Level ${l}: **${c}**`).join(' • ')
            : 'None';
        embed.addFields(
            { name: 'Active Warnings', value: activeUserWarnings.length ? activeUserWarnings.map(w => { const exp = w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt/1000)}:R>`; return `Level ${w.level} — ${exp}`; }).join('\n') : 'None', inline: true },
            { name: 'Total Warns (all time)', value: warnSummary, inline: true },
            { name: 'Kicks', value: `${kicks}`, inline: true },
            { name: 'Bans', value: `${bans}`, inline: true },
            { name: 'Notes', value: `${notes.length}`, inline: true }
        );

        if (allHistory.length) {
            const last = allHistory[allHistory.length - 1];
            const typeLabel = last.type === 'kick' ? 'Kick' : last.type === 'ban' ? 'Ban' : `Level ${last.level} warn`;
            embed.addFields({ name: 'Last Action', value: `${typeLabel} <t:${Math.floor(last.issuedAt/1000)}:R> by ${last.issuedBy}` });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (commandName === 'unban') {
        const userId = interaction.options.getString('user_id').trim();
        const reason = (interaction.options.getString('reason') || 'No reason provided').slice(0,512).replace(/[\x00-\x1F\x7F]/g,'');
        if (!/^\d{17,20}$/.test(userId)) return reply('❌ Invalid user ID. Must be a Discord snowflake (17-20 digits).');
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) return reply('❌ I need the "Ban Members" permission.');
        try {
            const ban = await interaction.guild.bans.fetch(userId).catch(() => null);
            if (!ban) return reply('❌ That user is not banned in this server.');
            await interaction.guild.members.unban(userId, reason);
            const user = ban.user;
            addHistory(guildId, userId, { guildId, userId, userTag: user.tag, type: 'unban', reason, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            console.log(`🔒 [AUDIT] ${interaction.user.tag} unbanned ${user.tag} from ${interaction.guild.name}`);
            logMod(interaction.guild, guildId, E('#00ff00','Member Unbanned').addFields({ name: 'User', value: `${user} (${user.tag})`, inline: true }, { name: 'Moderator', value: `${interaction.user}`, inline: true }, { name: 'Reason', value: reason }));
            await reply({ embeds: [E('#00ff00','✅ Member Unbanned').addFields({ name: 'User', value: `${user.tag}`, inline: true }, { name: 'Reason', value: reason }, { name: 'Unbanned by', value: `${interaction.user}` })] });
        } catch (e) { console.error(e); await reply('❌ Failed to unban. Check permissions.'); }
    }

    else if (commandName === 'note') {
        const sub = interaction.options.getSubcommand(), user = interaction.options.getUser('user');
        if (sub === 'add') {
            const text = interaction.options.getString('text').slice(0,1000).replace(/[\x00-\x1F\x7F]/g,'');
            const note = { id: Date.now(), text, addedBy: interaction.user.tag, addedAt: Date.now() };
            addNote(guildId, user.id, note);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} added note to ${user.tag} in ${interaction.guild.name}`);
            await reply(`✅ Note added to ${user} (ID: \`${note.id}\`).`);
        } else if (sub === 'view') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            const notes = await getNotes(guildId, user.id);
            if (!notes.length) return interaction.editReply({ content: `📋 No notes found for ${user}.` });
            const embed = E('#5865F2',`Notes — ${user.tag}`).setDescription(`${notes.length} note${notes.length>1?'s':''} on record.`);
            for (const n of notes.slice(-10)) embed.addFields({ name: `ID: ${n.id} — <t:${Math.floor(n.addedAt/1000)}:d> — ${n.addedBy}`, value: n.text });
            if (notes.length > 10) embed.setFooter({ text: `Showing last 10 of ${notes.length} notes` });
            await interaction.editReply({ embeds: [embed] });
        } else if (sub === 'delete') {
            const id = interaction.options.getInteger('id');
            const deleted = await deleteNote(guildId, user.id, id);
            await reply(deleted ? `✅ Note \`${id}\` deleted.` : `❌ Note ID \`${id}\` not found for ${user}.`);
        }
    }

    else if (commandName === 'escalation') {
        const sub = interaction.options.getSubcommand(), cfg = await getConfig(guildId);
        cfg.escalation ??= { thresholds: {} };
        const esc = cfg.escalation;
        if (sub === 'set') {
            const level = interaction.options.getInteger('level'), threshold = interaction.options.getInteger('threshold');
            if (level < 1 || level > 100) return reply('❌ Level must be between 1 and 100.');
            if (threshold < 2 || threshold > 50) return reply('❌ Threshold must be between 2 and 50.');
            esc.thresholds[level] = threshold; saveConfig(guildId, cfg);
            await reply(`✅ **${threshold}x** Level ${level} warnings → auto Level ${level+1}.`);
        } else if (sub === 'remove') {
            const level = interaction.options.getInteger('level');
            if (!esc.thresholds[level]) return reply(`❌ No threshold set for Level ${level}.`);
            delete esc.thresholds[level]; saveConfig(guildId, cfg);
            await reply(`✅ Removed escalation threshold for Level ${level}.`);
        } else if (sub === 'setcap') {
            const level = interaction.options.getInteger('level');
            if (level < 1 || level > 100) return reply('❌ Cap must be between 1 and 100.');
            esc.cap = level; saveConfig(guildId, cfg);
            await reply(`✅ Level cap set to **${level}**.`);
        } else if (sub === 'removecap') {
            if (!esc.cap) return reply('❌ No level cap is set.');
            delete esc.cap; saveConfig(guildId, cfg);
            await reply('✅ Level cap removed.');
        } else if (sub === 'settimeout') {
            const level = interaction.options.getInteger('level'), threshold = interaction.options.getInteger('threshold'), durationStr = interaction.options.getString('duration');
            if (level < 2 || level > 100) return reply('❌ Target level must be between 2 and 100.');
            if (threshold < 2 || threshold > 50) return reply('❌ Threshold must be between 2 and 50.');
            const dur = parseDuration(durationStr);
            if (!dur || dur.isForever) return reply('❌ Invalid duration. Use `m:s`, `h:m:s`, or `d:h:m:s`. Max 28 days.');
            if (dur.totalMs > MAX_TIMEOUT_MS) return reply('❌ Discord timeouts cannot exceed 28 days.');
            esc.timeouts ??= {};
            esc.timeouts[level] = { durationMs: dur.totalMs, durationDisplay: formatDuration(dur.days, dur.hours, dur.minutes, dur.seconds), threshold };
            saveConfig(guildId, cfg);
            await reply(`✅ Timeout escalation set: **${threshold}x** Level ${level-1} warnings → auto Level ${level} + **${esc.timeouts[level].durationDisplay}** timeout.`);
        } else if (sub === 'removetimeout') {
            const level = interaction.options.getInteger('level');
            if (!esc.timeouts?.[level]) return reply(`❌ No escalation timeout for Level ${level}.`);
            delete esc.timeouts[level]; saveConfig(guildId, cfg);
            await reply(`✅ Removed escalation timeout for Level ${level}.`);
        } else if (sub === 'view') {
            const embed = E('#5865F2','⬆️ Escalation Configuration');
            const th = esc.thresholds ?? {}, to = esc.timeouts ?? {};
            if (!Object.keys(th).length && !esc.cap && !Object.keys(to).length) { embed.setDescription('No escalation rules configured. Use `/escalation set` to add thresholds.'); }
            else {
                if (Object.keys(th).length) embed.addFields({ name: 'Thresholds', value: Object.entries(th).sort(([a],[b])=>a-b).map(([l,t])=>`• **${t}x** Level ${l} → auto Level ${parseInt(l)+1}`).join('\n') });
                if (Object.keys(to).length) embed.addFields({ name: 'Timeouts on Escalation', value: Object.entries(to).sort(([a],[b])=>a-b).map(([l,t])=>`• ${t.threshold}x Level ${parseInt(l)-1} → auto Level ${l} + **${t.durationDisplay}** timeout`).join('\n') });
                embed.addFields({ name: 'Level Cap', value: esc.cap ? `Level **${esc.cap}**` : 'None' });
            }
            await reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
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

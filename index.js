const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, RoleSelectMenuBuilder, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Pool } = require('pg');
const http = require('http');
const https = require('https');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, family: 4 });

// ── DB init ────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS configs (
            guild_id TEXT PRIMARY KEY,
            data JSONB NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS warnings (
            key TEXT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            data JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history (
            id SERIAL PRIMARY KEY,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            data JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes (
            id BIGINT PRIMARY KEY,
            guild_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            data JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS warnings_guild_user ON warnings(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS history_guild_user  ON history(guild_id, user_id);
        CREATE INDEX IF NOT EXISTS notes_guild_user    ON notes(guild_id, user_id);
    `);
    console.log('✅ Database initialised');
}

// ── Config helpers ─────────────────────────────────────────────────────────
const configCache = new Map();

async function getConfig(guildId) {
    if (configCache.has(guildId)) return configCache.get(guildId);
    const res = await pool.query('SELECT data FROM configs WHERE guild_id = $1', [guildId]);
    const data = res.rows[0]?.data ?? { levels: {} };
    configCache.set(guildId, data);
    return data;
}
async function saveConfig(guildId, data) {
    configCache.set(guildId, data);
    await pool.query(
        'INSERT INTO configs (guild_id, data) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET data = $2',
        [guildId, data]
    );
}

// ── Warning helpers ────────────────────────────────────────────────────────
const activeWarnings = new Map(); // key → data (in-memory for fast timer access)

async function loadAllWarnings() {
    const res = await pool.query('SELECT key, data FROM warnings');
    for (const { key, data } of res.rows) activeWarnings.set(key, data);
    console.log(`🔄 Loaded ${activeWarnings.size} active warnings from DB`);
}
async function saveWarning(key, data) {
    activeWarnings.set(key, data);
    await pool.query(
        'INSERT INTO warnings (key, guild_id, user_id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO UPDATE SET data = $4',
        [key, data.guildId, data.userId, data]
    );
}
async function deleteWarning(key) {
    activeWarnings.delete(key);
    await pool.query('DELETE FROM warnings WHERE key = $1', [key]);
}

// ── History helpers ────────────────────────────────────────────────────────
async function addHistory(guildId, userId, entry) {
    await pool.query(
        'INSERT INTO history (guild_id, user_id, data) VALUES ($1, $2, $3)',
        [guildId, userId, entry]
    );
}
async function getHistory(guildId, userId) {
    const res = await pool.query(
        'SELECT data FROM history WHERE guild_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 10',
        [guildId, userId]
    );
    return res.rows.map(r => r.data).reverse();
}

// ── Notes helpers ──────────────────────────────────────────────────────────
async function getNotes(guildId, userId) {
    const res = await pool.query(
        'SELECT data FROM notes WHERE guild_id = $1 AND user_id = $2 ORDER BY id',
        [guildId, userId]
    );
    return res.rows.map(r => r.data);
}
async function addNote(guildId, userId, note) {
    await pool.query(
        'INSERT INTO notes (id, guild_id, user_id, data) VALUES ($1, $2, $3, $4)',
        [note.id, guildId, userId, note]
    );
}
async function deleteNote(guildId, userId, id) {
    const res = await pool.query(
        'DELETE FROM notes WHERE guild_id = $1 AND user_id = $2 AND id = $3',
        [guildId, userId, id]
    );
    return res.rowCount > 0;
}

// ── Mod log ────────────────────────────────────────────────────────────────
async function logMod(guild, guildId, embed) {
    const config = await getConfig(guildId);
    const channelId = config.logChannelId;
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId);
    if (channel) await channel.send({ embeds: [embed] }).catch(e => console.error('Log channel send failed:', e.message));
}

// ── Permission check ───────────────────────────────────────────────────────
async function hasCommandPermission(interaction, guildId) {
    const member = interaction.member;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const config = await getConfig(guildId);
    return config.accessRoleId ? member.roles.cache.has(config.accessRoleId) : false;
}

async function showAccessControlConfig(interaction, guildId) {
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🔒 Access Configuration')
        .setDescription('Select which role should have access to moderation commands:\n\n**Commands affected:**\n• `/warn` `/unwarn` `/timeout` `/config set/view`\n• `/config access` `/warnlist` `/history` `/escalation`\n\n**Note:** Server administrators always have access.')
        .setFooter({ text: 'Select a role from the dropdown below' });
    const row = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId(`access_role_${guildId}`).setPlaceholder('Select a role for command access').setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
}

// ── Duration helpers ───────────────────────────────────────────────────────
function parseDuration(durationStr) {
    if (durationStr.toLowerCase() === 'forever') return { days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: null, isForever: true };
    const parts = durationStr.split(':').map(p => { const n = parseInt(p.trim()); return (n < 0 || n > 9999) ? NaN : n; });
    if (parts.some(isNaN) || parts.length < 2 || parts.length > 4) return null;
    let days = 0, hours = 0, minutes = 0, seconds = 0;
    if (parts.length === 2) [minutes, seconds] = parts;
    else if (parts.length === 3) [hours, minutes, seconds] = parts;
    else [days, hours, minutes, seconds] = parts;
    const totalMs = (days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000;
    return (totalMs <= 0 || totalMs > 365 * 86400 * 1000) ? null : { days, hours, minutes, seconds, totalMs, isForever: false };
}
function formatDuration(days, hours, minutes, seconds, isForever = false) {
    if (isForever) return 'Forever';
    return [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`, seconds && `${seconds}s`].filter(Boolean).join(' ') || '0s';
}

// ── Warning timers ─────────────────────────────────────────────────────────
const warningTimers = new Map();
const pendingUnwarns = new Map();
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

async function handleWarningExpiry(warningKey, guildId, userId, roleId, channelId) {
    const w = activeWarnings.get(warningKey);
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const member = await guild.members.fetch(userId).catch(() => null);
        const role = guild.roles.cache.get(roleId);
        if (member && role && member.roles.cache.has(roleId)) {
            await member.roles.remove(role);
            member.user.send({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Warning Expired')
                .setDescription(`Your warning in **${guild.name}** has expired and the role has been removed.`)
                .addFields(
                    { name: 'Warning Level', value: `${w?.level ?? 'Unknown'}`, inline: true },
                    { name: 'Role Removed', value: role.name, inline: true }
                ).setFooter({ text: 'You no longer carry this warning role' }).setTimestamp()]
            }).catch(() => {});
            const channel = guild.channels.cache.get(channelId);
            if (channel) await channel.send({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Warning Expired').setDescription(`<@${userId}>'s warning has expired and the role has been removed.`).setTimestamp()] });
        }
    } catch (error) {
        console.error(`Failed to remove role: ${error}`);
        try {
            const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
            if (channel) await channel.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Warning Removal Failed').setDescription(`Could not remove role from <@${userId}>. Check bot permissions.`).setTimestamp()] });
        } catch {}
    }
    if (w) await addHistory(guildId, userId, { ...w, endedAt: Date.now(), endReason: 'expired' });
    warningTimers.delete(warningKey);
    await deleteWarning(warningKey);
}

function scheduleWarningRemoval(warningKey, guildId, userId, roleId, expiresAt, channelId) {
    const timeLeft = expiresAt - Date.now();
    if (timeLeft <= 0) return handleWarningExpiry(warningKey, guildId, userId, roleId, channelId);
    warningTimers.set(warningKey, setTimeout(() => handleWarningExpiry(warningKey, guildId, userId, roleId, channelId), timeLeft));
}

async function applyWarning(guild, member, user, guildId, level, reason, channelId, issuedByTag) {
    const config = await getConfig(guildId);
    const levelConfig = config.levels[level];
    const role = guild.roles.cache.get(levelConfig?.roleId);
    if (!levelConfig || !role) return { error: `Level ${level} config or role not found.` };
    const botMember = guild.members.me;
    if (role.position >= botMember.roles.highest.position) return { error: `Role hierarchy: my role must be above ${role.name}.` };
    await member.roles.add(role);
    user.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ You Received a Warning')
        .setDescription(`You have been warned in **${guild.name}**.`)
        .addFields(
            { name: 'Warning Level', value: `${level}`, inline: true },
            { name: 'Duration', value: levelConfig.durationDisplay || 'Unknown', inline: true },
            { name: 'Reason', value: reason }
        ).setFooter({ text: `Use /mywarnings in ${guild.name} to check when this warning expires` }).setTimestamp()]
    }).catch(() => {});
    const baseEntry = { guildId, userId: user.id, userTag: user.tag, roleId: role.id, roleName: role.name, level, reason, issuedBy: issuedByTag, issuedAt: Date.now() };
    const warningKey = `${guildId}-${user.id}-${level}-${Date.now()}`;
    if (!levelConfig.isForever) {
        const expiresAt = Date.now() + levelConfig.durationMs;
        const warnData = { ...baseEntry, expiresAt, channelId, isForever: false };
        await saveWarning(warningKey, warnData);
        scheduleWarningRemoval(warningKey, guildId, user.id, role.id, expiresAt, channelId);
    } else {
        await saveWarning(warningKey, { ...baseEntry, expiresAt: null, channelId, isForever: true });
    }
    return { success: true, role, config: levelConfig };
}

async function checkEscalation(guild, member, user, guildId, level, channelId, issuedByTag) {
    const config = await getConfig(guildId);
    const esc = config.escalation ?? {};
    const cap = esc.cap;
    const nextLevel = level + 1;
    if (cap != null && nextLevel > cap) return { atCap: true, cap };

    const count = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === user.id && w.level === level).length;

    const timeoutCfg = esc.timeouts?.[nextLevel];
    if (timeoutCfg?.threshold != null) {
        if (count < timeoutCfg.threshold) return { counted: true, count, threshold: timeoutCfg.threshold };
        if (!config.levels[nextLevel]) return { noNextLevel: true, nextLevel };
        const result = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
        if (result.error) return { escalationError: result.error };
        await member.timeout(timeoutCfg.durationMs, `Auto-escalated to Level ${nextLevel}`).catch(e => console.error('Escalation timeout failed:', e.message));
        user.send({ embeds: [new EmbedBuilder().setColor('#ff6600').setTitle('🔇 You Have Been Timed Out')
            .setDescription(`You were auto-timed-out in **${guild.name}** upon reaching Warning Level ${nextLevel}.`)
            .addFields({ name: 'Timeout Duration', value: timeoutCfg.durationDisplay, inline: true }).setTimestamp()]
        }).catch(() => {});
        return { escalated: true, nextLevel, role: result.role, config: result.config, hitCap: cap != null && nextLevel === cap, timedOut: true, timeoutDisplay: timeoutCfg.durationDisplay };
    }

    const threshold = esc.thresholds?.[level];
    if (!threshold) return null;
    if (count < threshold) return { counted: true, count, threshold };
    if (!config.levels[nextLevel]) return { noNextLevel: true, nextLevel };
    const result = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
    if (result.error) return { escalationError: result.error };
    return { escalated: true, nextLevel, role: result.role, config: result.config, hitCap: cap != null && nextLevel === cap, timedOut: false };
}

// ── Keep-alive ─────────────────────────────────────────────────────────────
function keepAlive() {
    const ping = () => {
        const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        const protocol = url.startsWith('https://') ? https : http;
        try {
            protocol.get(url, res => console.log(`🏓 Keep-alive ping - Status: ${res.statusCode}`))
                .on('error', err => console.error('❌ Keep-alive ping failed:', err.message));
        } catch (e) { console.error('❌ Keep-alive error:', e.message); }
    };
    setTimeout(ping, 5000);
    setInterval(ping, 14 * 60 * 1000);
}

// ── Warnlist helpers ───────────────────────────────────────────────────────
const WARN_PAGE_SIZE = 10;

function buildWarnlistEmbed(guildId, page) {
    const allWarnings = [...activeWarnings.values()].filter(w => w.guildId === guildId);
    const byUser = {};
    for (const w of allWarnings) { byUser[w.userId] ??= []; byUser[w.userId].push(w); }
    const userIds = Object.keys(byUser);
    const totalPages = Math.max(1, Math.ceil(userIds.length / WARN_PAGE_SIZE));
    page = Math.max(0, Math.min(page, totalPages - 1));
    const embed = new EmbedBuilder().setColor('#FFA500').setTitle(`⚠️ Active Warnings (${allWarnings.length})`).setTimestamp()
        .setFooter({ text: totalPages > 1 ? `Page ${page + 1} of ${totalPages}` : `${userIds.length} user(s) warned` });
    if (!userIds.length) return { embed: embed.setDescription('No active warnings in this server.'), totalPages, page };
    for (const uid of userIds.slice(page * WARN_PAGE_SIZE, (page + 1) * WARN_PAGE_SIZE))
        embed.addFields({ name: `<@${uid}>`, value: byUser[uid].map(w => `• Level ${w.level} — ${w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt / 1000)}:R>`}`).join('\n') });
    return { embed, totalPages, page };
}
function warnlistRow(page, totalPages, guildId) {
    if (totalPages <= 1) return [];
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wl_${page - 1}_${guildId}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`wl_${page + 1}_${guildId}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages - 1)
    )];
}

// ── Bot ready ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`✅ Police bot is online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Monitoring the security cameras', type: ActivityType.Watching }], status: 'online' });

    const commands = [
        new SlashCommandBuilder().setName('warn').setDescription('Give a warning to a user')
            .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
            .addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(true)),
        new SlashCommandBuilder().setName('unwarn').setDescription('Manually remove a warning role from a user')
            .addUserOption(o => o.setName('user').setDescription('User to remove warning from').setRequired(true))
            .addIntegerOption(o => o.setName('level').setDescription('Warning level to remove').setRequired(true)),
        new SlashCommandBuilder().setName('timeout').setDescription('Apply a Discord timeout to a user')
            .addUserOption(o => o.setName('user').setDescription('User to timeout').setRequired(true))
            .addStringOption(o => o.setName('duration').setDescription('Duration (m:s / h:m:s / d:h:m:s, max 28 days)').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for the timeout')),
        new SlashCommandBuilder().setName('mywarnings').setDescription('Check how much time is left on your warnings'),
        new SlashCommandBuilder().setName('warnlist').setDescription('View all active warnings in this server'),
        new SlashCommandBuilder().setName('history').setDescription('View warning history for a user')
            .addUserOption(o => o.setName('user').setDescription('User to look up').setRequired(true)),
        new SlashCommandBuilder().setName('escalation').setDescription('Configure auto-escalation rules')
            .addSubcommand(s => s.setName('set').setDescription('Set threshold: how many level-N warns trigger escalation')
                .addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true))
                .addIntegerOption(o => o.setName('threshold').setDescription('Number of warnings to trigger escalation').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('Remove escalation threshold for a level')
                .addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true)))
            .addSubcommand(s => s.setName('setcap').setDescription('Set maximum warning level for escalation')
                .addIntegerOption(o => o.setName('level').setDescription('Cap level').setRequired(true)))
            .addSubcommand(s => s.setName('removecap').setDescription('Remove the level cap'))
            .addSubcommand(s => s.setName('settimeout').setDescription('Configure a timeout-escalation: N warnings at level X → escalate to X+1 with a timeout')
                .addIntegerOption(o => o.setName('level').setDescription('Target level to escalate TO (must be ≥2)').setRequired(true))
                .addIntegerOption(o => o.setName('threshold').setDescription('How many level (target-1) warnings trigger this (2–50)').setRequired(true))
                .addStringOption(o => o.setName('duration').setDescription('Timeout duration (m:s / h:m:s / d:h:m:s, max 28 days)').setRequired(true)))
            .addSubcommand(s => s.setName('removetimeout').setDescription('Remove timeout from an escalation level')
                .addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true)))
            .addSubcommand(s => s.setName('view').setDescription('View current escalation configuration')),
        new SlashCommandBuilder().setName('kick').setDescription('Kick a user from the server')
            .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for the kick').setRequired(true)),
        new SlashCommandBuilder().setName('ban').setDescription('Ban a user from the server')
            .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(true))
            .addIntegerOption(o => o.setName('delete_days').setDescription('Days of messages to delete (0-7)').setMinValue(0).setMaxValue(7)),
        new SlashCommandBuilder().setName('note').setDescription('Manage mod notes on a user')
            .addSubcommand(s => s.setName('add').setDescription('Add a note to a user')
                .addUserOption(o => o.setName('user').setDescription('User to note').setRequired(true))
                .addStringOption(o => o.setName('text').setDescription('Note content').setRequired(true)))
            .addSubcommand(s => s.setName('view').setDescription('View all notes for a user')
                .addUserOption(o => o.setName('user').setDescription('User to look up').setRequired(true)))
            .addSubcommand(s => s.setName('delete').setDescription('Delete a note by ID')
                .addUserOption(o => o.setName('user').setDescription('User the note belongs to').setRequired(true))
                .addIntegerOption(o => o.setName('id').setDescription('Note ID to delete').setRequired(true))),
        new SlashCommandBuilder().setName('config').setDescription('Configure the bot')
            .addSubcommand(s => s.setName('set').setDescription('Set up a warning level')
                .addIntegerOption(o => o.setName('level').setDescription('Warning level (1, 2, 3...)').setRequired(true))
                .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))
                .addStringOption(o => o.setName('duration').setDescription('d:h:m:s or "forever"').setRequired(true)))
            .addSubcommand(s => s.setName('view').setDescription('View all configured warning levels'))
            .addSubcommand(s => s.setName('access').setDescription('Set which role can use moderation commands'))
            .addSubcommand(s => s.setName('logchannel').setDescription('Set the mod-log channel')
                .addChannelOption(o => o.setName('channel').setDescription('Channel to send mod logs to').setRequired(true)))
            .addSubcommand(s => s.setName('removelogchannel').setDescription('Remove the mod-log channel')),
        new SlashCommandBuilder().setName('help').setDescription('View all commands and features of the bot'),
    ].map(c => c.toJSON());

    client.application.commands.set(commands);
    console.log('✅ Commands registered');

    try {
        await initDB();
        await loadAllWarnings();
        for (const [key, w] of activeWarnings.entries()) {
            if (!w.isForever) scheduleWarningRemoval(key, w.guildId, w.userId, w.roleId, w.expiresAt, w.channelId);
        }
    } catch (e) {
        console.error('❌ DB init failed:', e.message);
    }
    keepAlive();
});

// ── Guild join ─────────────────────────────────────────────────────────────
client.on('guildCreate', async guild => {
    console.log(`Bot joined: ${guild.name} (${guild.id})`);
    const existing = await getConfig(guild.id);
    if (!existing.levels) await saveConfig(guild.id, { levels: {} });
    try {
        const logs = await guild.fetchAuditLogs({ type: 28, limit: 5 });
        const entry = logs.entries.find(e => e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 60000);
        const inviterId = entry?.executor?.id;
        if (guild.systemChannel) {
            const embed = new EmbedBuilder().setColor('#5865F2').setTitle('👋 Thanks for adding Police Bot!')
                .setDescription(`${inviterId ? `<@${inviterId}>, please` : 'An administrator should'} run \`/config access\` to set up command permissions.\n\n**Quick Start:**\n1. \`/config access\` — set the moderator role\n2. \`/config set\` — set up warning levels\n3. \`/warn\` — start moderating!`)
                .setFooter({ text: 'Use /help to see all commands' });
            await guild.systemChannel.send({ embeds: [embed] }).catch(e => console.log(`⚠️ Could not send setup message: ${e.message}`));
        }
    } catch (e) { console.error('Error in guildCreate:', e); }
});

// ── Rejoin protection ──────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
    const { guild, id: userId } = member;
    const userWarnings = [...activeWarnings.entries()].filter(([, w]) => w.guildId === guild.id && w.userId === userId);
    if (!userWarnings.length) return;
    console.log(`🔄 Reapplying ${userWarnings.length} warning(s) to rejoining user ${member.user.tag}`);
    for (const [, w] of userWarnings) {
        const role = guild.roles.cache.get(w.roleId);
        if (role) await member.roles.add(role).catch(e => console.error(`Failed to reapply warning role: ${e.message}`));
    }
    member.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ Warning Reinstated')
        .setDescription(`Your active warning(s) in **${guild.name}** have been reapplied because you rejoined.`)
        .addFields({ name: 'Active Warnings', value: userWarnings.map(([, w]) => `Level ${w.level} — ${w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt / 1000)}:R>`}`).join('\n') })
        .setTimestamp()]
    }).catch(() => {});
});

// ── Interactions ───────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {

    // Role select (config access)
    if (interaction.isRoleSelectMenu()) {
        if (!interaction.customId.startsWith('access_role_')) return;
        const guildId = interaction.customId.replace('access_role_', '');
        if (guildId !== interaction.guild.id) return interaction.reply({ content: '❌ Invalid interaction. Please run /config access again.', flags: [MessageFlags.Ephemeral] });
        const selectedRole = interaction.roles.first();
        if (!selectedRole) return interaction.reply({ content: '❌ No role selected.', flags: [MessageFlags.Ephemeral] });
        if (selectedRole.id === interaction.guild.id) return interaction.update({ content: '❌ Cannot use @everyone as access role.', components: [] });
        if (selectedRole.managed) return interaction.update({ content: '❌ Cannot use managed/bot roles as access role.', components: [] });
        const config = await getConfig(guildId);
        config.accessRoleId = selectedRole.id;
        await saveConfig(guildId, config);
        await interaction.update({
            embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Access Control Updated')
                .setDescription(`Members with the ${selectedRole} role can now use moderation commands.\n\n*Server administrators always have access.*`)
                .setTimestamp()],
            components: []
        });
        console.log(`🔒 [AUDIT] Access role set to ${selectedRole.name} in ${interaction.guild.name}`);
        return;
    }

    // Buttons
    if (interaction.isButton()) {
        const { customId } = interaction;

        if (customId.startsWith('help_')) {
            const pages = {
                help_warn: new EmbedBuilder().setColor('#ff0000').setTitle('Warning Commands')
                    .addFields(
                        { name: '/warn', value: 'Issue a warning to a user at a configured level. Requires a reason. Triggers escalation checks automatically.' },
                        { name: '/unwarn', value: 'Remove a warning role from a user. Shows a confirm/cancel prompt before executing.' },
                        { name: '/timeout', value: 'Apply a Discord native timeout to a user. Duration uses `m:s`, `h:m:s`, or `d:h:m:s` format (max 28 days).' },
                        { name: '/mywarnings', value: 'Check your own active warnings and how long is left on each one.' },
                        { name: '/warnlist', value: 'View all active warnings in the server, paginated 10 users per page.' },
                        { name: '/history', value: 'View the last 10 warning history entries for a specific user, including expired and manually removed warnings.' }
                    ).setFooter({ text: 'Use the buttons to explore other categories' }),
                help_mod: new EmbedBuilder().setColor('#ff6600').setTitle('Moderation Commands')
                    .addFields(
                        { name: '/kick', value: 'Kick a user from the server. Sends a DM, logs to history, and posts to the mod-log channel.' },
                        { name: '/ban', value: 'Ban a user. Optionally delete their recent messages (0–7 days). Sends a DM if they are still in the server.' },
                        { name: '/timeout', value: 'Apply a Discord native timeout. Duration uses `m:s`, `h:m:s`, or `d:h:m:s` (max 28 days).' }
                    ).setFooter({ text: 'Use the buttons to explore other categories' }),
                help_config: new EmbedBuilder().setColor('#00ff00').setTitle('Config Commands')
                    .addFields(
                        { name: '/config set', value: 'Set up a warning level: assign a role and a duration (`m:s`, `h:m:s`, `d:h:m:s`, or `forever`).' },
                        { name: '/config view', value: 'View all configured warning levels and their roles and durations.' },
                        { name: '/config access', value: 'Choose which role can use moderation commands. Admins always have access regardless.' },
                        { name: '/config logchannel', value: 'Set a channel where every mod action (warn, kick, ban, timeout) is automatically logged.' },
                        { name: '/config removelogchannel', value: 'Remove the mod-log channel.' }
                    ).setFooter({ text: 'Use the buttons to explore other categories' }),
                help_escalation: new EmbedBuilder().setColor('#ff9900').setTitle('Escalation Commands')
                    .addFields(
                        { name: '/escalation set', value: 'Set a threshold: once a user reaches N warnings at level X, they are auto-escalated to level X+1.' },
                        { name: '/escalation remove', value: 'Remove a threshold for a specific warning level.' },
                        { name: '/escalation setcap / removecap', value: 'Set or remove a maximum warning level. Escalation will not go beyond the cap.' },
                        { name: '/escalation settimeout', value: 'Configure a self-contained timeout escalation: N warnings at level X → auto level X+1 + a timeout. Fully independent from `/escalation set`.' },
                        { name: '/escalation removetimeout', value: 'Remove a timeout escalation rule for a level.' },
                        { name: '/escalation view', value: 'View all active escalation rules, thresholds, timeouts, and the level cap.' }
                    ).setFooter({ text: 'Use the buttons to explore other categories' }),
                help_notes: new EmbedBuilder().setColor('#9b59b6').setTitle('Note Commands')
                    .addFields(
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
                help_features: new EmbedBuilder().setColor('#9b59b6').setTitle('Other Features')
                    .addFields(
                        { name: 'Warning expiry DMs', value: 'Users are DM\'d when a warning is issued and again when it expires and the role is removed.' },
                        { name: 'Rejoin protection', value: 'If a warned user leaves and rejoins the server, their warning roles are automatically reapplied and they are DM\'d.' },
                        { name: 'Timer restoration', value: 'On bot restart, all active warning timers are restored from the database so no warning expires silently.' },
                        { name: 'Audit logging', value: 'Sensitive commands (warn, unwarn, timeout, config) are logged to console with the moderator\'s tag.' },
                        { name: '/help', value: 'This interactive help menu.' }
                    ).setFooter({ text: 'Use the buttons to explore other categories' }),
            };
            const embed = pages[customId];
            if (!embed) return;
            const helpButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_warn').setLabel('Warnings').setStyle(customId === 'help_warn' ? ButtonStyle.Success : ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_mod').setLabel('Moderation').setStyle(customId === 'help_mod' ? ButtonStyle.Success : ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_config').setLabel('Config').setStyle(customId === 'help_config' ? ButtonStyle.Success : ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_escalation').setLabel('Escalation').setStyle(customId === 'help_escalation' ? ButtonStyle.Success : ButtonStyle.Primary)
            );
            const helpButtons2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_notes').setLabel('Notes').setStyle(customId === 'help_notes' ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('help_storage').setLabel('Storage').setStyle(customId === 'help_storage' ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('help_features').setLabel('Features').setStyle(customId === 'help_features' ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('help_back').setLabel('Back').setStyle(ButtonStyle.Secondary)
            );
            return interaction.update({ embeds: [embed], components: [helpButtons, helpButtons2] });
        }

        if (customId === 'help_back') {
            const helpOverview = new EmbedBuilder().setColor('#5865F2').setTitle('Police Bot')
                .setDescription("I'm just your friendly neighbourhood policemen, but I do have some tricks up my sleeve. Press the buttons below to learn about my commands.")
                .setFooter({ text: 'Mod commands require the configured access role or Administrator' });
            const helpButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_warn').setLabel('Warnings').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_mod').setLabel('Moderation').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_config').setLabel('Config').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('help_escalation').setLabel('Escalation').setStyle(ButtonStyle.Primary)
            );
            const helpButtons2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('help_notes').setLabel('Notes').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('help_storage').setLabel('Storage').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('help_features').setLabel('Features').setStyle(ButtonStyle.Secondary)
            );
            return interaction.update({ embeds: [helpOverview], components: [helpButtons, helpButtons2] });
        }

        if (customId.startsWith('wl_')) {
            if (!await hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
            const parts = customId.split('_');
            const page = parseInt(parts[1]);
            const guildId = parts.slice(2).join('_');
            const { embed, totalPages, page: newPage } = buildWarnlistEmbed(guildId, page);
            return interaction.update({ embeds: [embed], components: warnlistRow(newPage, totalPages, guildId) });
        }

        if (customId.startsWith('unwarn_confirm_') || customId.startsWith('unwarn_cancel_')) {
            const isConfirm = customId.startsWith('unwarn_confirm_');
            const pendingId = customId.slice(isConfirm ? 15 : 13);
            const pending = pendingUnwarns.get(pendingId);
            if (!pending) return interaction.update({ content: '❌ This confirmation has expired. Please run `/unwarn` again.', embeds: [], components: [] });
            if (interaction.user.id !== pending.modId) return interaction.reply({ content: '❌ Only the moderator who ran this command can confirm.', flags: [MessageFlags.Ephemeral] });
            if (!isConfirm) {
                pendingUnwarns.delete(pendingId);
                return interaction.update({ content: '✅ Unwarn cancelled.', embeds: [], components: [] });
            }
            pendingUnwarns.delete(pendingId);
            const { targetUserId, targetUserTag, level, guildId, roleId } = pending;
            try {
                const member = interaction.guild.members.cache.get(targetUserId);
                const role = interaction.guild.roles.cache.get(roleId);
                if (!member) return interaction.update({ content: '❌ User is no longer in this server.', embeds: [], components: [] });
                if (!role) return interaction.update({ content: '❌ Configured role not found.', embeds: [], components: [] });
                await member.roles.remove(role);
                console.log(`🔒 [AUDIT] ${interaction.user.tag} unwarned ${targetUserTag} (Level ${level}) in ${interaction.guild.name}`);
                const keysToRemove = [...activeWarnings.entries()]
                    .filter(([, w]) => w.userId === targetUserId && w.guildId === guildId && w.level === level)
                    .map(([k]) => k);
                for (const k of keysToRemove) {
                    await addHistory(guildId, targetUserId, { ...activeWarnings.get(k), endedAt: Date.now(), endReason: 'manual' });
                    clearTimeout(warningTimers.get(k));
                    warningTimers.delete(k);
                    await deleteWarning(k);
                }
                await interaction.update({
                    embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Warning Removed')
                        .addFields(
                            { name: 'User', value: `<@${targetUserId}>`, inline: true },
                            { name: 'Level', value: `${level}`, inline: true },
                            { name: 'Role', value: `${role}`, inline: true },
                            { name: 'Removed by', value: `${interaction.user}` }
                        ).setTimestamp()],
                    components: []
                });
            } catch (error) {
                console.error(error);
                await interaction.update({ content: '❌ Failed to remove warning. Check bot permissions.', embeds: [], components: [] });
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId } = interaction;
    if (!interaction.guild) return interaction.reply({ content: '❌ This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });

    const restrictedCommands = ['config', 'warn', 'unwarn', 'timeout', 'kick', 'ban', 'note', 'warnlist', 'history', 'escalation'];
    if (restrictedCommands.includes(commandName) && !await hasCommandPermission(interaction, guildId)) {
        const config = await getConfig(guildId);
        return interaction.reply({
            content: `❌ You don't have permission to use this command.\n\n**Required:** Administrator OR ${config.accessRoleId ? `<@&${config.accessRoleId}>` : 'no access role configured'}\n\nAsk an admin to run \`/config access\`.`,
            flags: [MessageFlags.Ephemeral]
        });
    }

    // ── /help ──────────────────────────────────────────────────────────────
    if (commandName === 'help') {
        const helpOverview = new EmbedBuilder().setColor('#5865F2').setTitle('Police Bot')
            .setDescription("I'm just your friendly neighbourhood policemen, but I do have some tricks up my sleeve. Press the buttons below to learn about my commands.")
            .setFooter({ text: 'Mod commands require the configured access role or Administrator' });
        const helpButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('help_warn').setLabel('Warnings').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('help_mod').setLabel('Moderation').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('help_config').setLabel('Config').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('help_escalation').setLabel('Escalation').setStyle(ButtonStyle.Primary)
        );
        const helpButtons2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('help_notes').setLabel('Notes').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_storage').setLabel('Storage').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('help_features').setLabel('Features').setStyle(ButtonStyle.Secondary)
        );
        await interaction.reply({ embeds: [helpOverview], components: [helpButtons, helpButtons2], flags: [MessageFlags.Ephemeral] });
    }

    // ── /config ────────────────────────────────────────────────────────────
    else if (commandName === 'config') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'access') {
            await showAccessControlConfig(interaction, guildId);
        } else if (sub === 'set') {
            const level = interaction.options.getInteger('level');
            const role = interaction.options.getRole('role');
            const durationStr = interaction.options.getString('duration');
            if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
            const duration = parseDuration(durationStr);
            if (!duration) return interaction.reply({ content: '❌ Invalid duration. Use `m:s`, `h:m:s`, `d:h:m:s`, or `forever`. Max 365 days.', flags: [MessageFlags.Ephemeral] });
            const config = await getConfig(guildId);
            config.levels ??= {};
            config.levels[level] = {
                roleId: role.id, roleName: role.name,
                durationMs: duration.totalMs, isForever: duration.isForever,
                durationDisplay: formatDuration(duration.days, duration.hours, duration.minutes, duration.seconds, duration.isForever)
            };
            await saveConfig(guildId, config);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} configured Level ${level} → ${role.name} in ${interaction.guild.name}`);
            await interaction.reply({
                embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('🚨 Warning Level Configured')
                    .addFields(
                        { name: 'Level', value: `${level}`, inline: true },
                        { name: 'Role', value: `${role}`, inline: true },
                        { name: 'Duration', value: formatDuration(duration.days, duration.hours, duration.minutes, duration.seconds, duration.isForever), inline: true }
                    ).setTimestamp()],
                flags: [MessageFlags.Ephemeral]
            });
        } else if (sub === 'view') {
            const config = await getConfig(guildId);
            if (!config.levels || Object.keys(config.levels).length === 0) return interaction.reply({ content: '📋 No warning levels configured yet. Use /config set to add some.', flags: [MessageFlags.Ephemeral] });
            const embed = new EmbedBuilder().setColor('#0099ff').setTitle('🚨 Warning Configuration').setTimestamp();
            for (const [level, data] of Object.entries(config.levels))
                embed.addFields({ name: `Level ${level}`, value: `Role: <@&${data.roleId}>\nDuration: ${data.durationDisplay}`, inline: true });
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'logchannel') {
            const channel = interaction.options.getChannel('channel');
            if (!channel.isTextBased()) return interaction.reply({ content: '❌ Please select a text channel.', flags: [MessageFlags.Ephemeral] });
            const config = await getConfig(guildId);
            config.logChannelId = channel.id;
            await saveConfig(guildId, config);
            await interaction.reply({ content: `✅ Mod-log channel set to ${channel}.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'removelogchannel') {
            const config = await getConfig(guildId);
            if (!config.logChannelId) return interaction.reply({ content: '❌ No log channel is currently set.', flags: [MessageFlags.Ephemeral] });
            delete config.logChannelId;
            await saveConfig(guildId, config);
            await interaction.reply({ content: '✅ Mod-log channel removed.', flags: [MessageFlags.Ephemeral] });
        }
    }

    // ── /warn ──────────────────────────────────────────────────────────────
    else if (commandName === 'warn') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const level = interaction.options.getInteger('level');
        const reason = interaction.options.getString('reason').slice(0, 1000).replace(/[\x00-\x1F\x7F]/g, '');
        if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
        if (!member) return interaction.reply({ content: `❌ ${user} is not in this server.`, flags: [MessageFlags.Ephemeral] });
        const config = await getConfig(guildId);
        if (!config.levels?.[level]) return interaction.reply({ content: `❌ Level ${level} is not configured. Use /config set first.`, flags: [MessageFlags.Ephemeral] });
        const botMember = interaction.guild.members.me;
        const configRole = interaction.guild.roles.cache.get(config.levels[level].roleId);
        if (!configRole) return interaction.reply({ content: '❌ Configured role not found. Please re-run /config set.', flags: [MessageFlags.Ephemeral] });
        if (configRole.position >= botMember.roles.highest.position) return interaction.reply({ content: `❌ My role must be above ${configRole} in the role list.`, flags: [MessageFlags.Ephemeral] });
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: '❌ I need the "Manage Roles" permission.', flags: [MessageFlags.Ephemeral] });
        try {
            const result = await applyWarning(interaction.guild, member, user, guildId, level, reason, interaction.channel.id, interaction.user.tag);
            if (result.error) return interaction.reply({ content: `❌ ${result.error}`, flags: [MessageFlags.Ephemeral] });
            console.log(`🔒 [AUDIT] ${interaction.user.tag} warned ${user.tag} (Level ${level}) in ${interaction.guild.name}`);
            await logMod(interaction.guild, guildId, new EmbedBuilder().setColor('#ff0000').setTitle('Warning Issued')
                .addFields(
                    { name: 'User', value: `${user} (${user.tag})`, inline: true },
                    { name: 'Level', value: `${level}`, inline: true },
                    { name: 'Duration', value: result.config.durationDisplay || 'Unknown', inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: `${interaction.user}` }
                ).setTimestamp());
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ Warning Issued')
                .addFields(
                    { name: 'User', value: `${user}`, inline: true },
                    { name: 'Level', value: `${level}`, inline: true },
                    { name: 'Role', value: `${result.role}`, inline: true },
                    { name: 'Duration', value: result.config.durationDisplay || 'Unknown', inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Issued by', value: `${interaction.user}` }
                ).setTimestamp()]
            });
            const esc = await checkEscalation(interaction.guild, member, user, guildId, level, interaction.channel.id, interaction.user.tag);
            if (esc?.escalated) {
                await interaction.followUp({ content: `⬆️ ${user} auto-escalated to **Level ${esc.nextLevel}** (${esc.role}).${esc.timedOut ? ` 🔇 Timeout: **${esc.timeoutDisplay}**.` : ''}${esc.hitCap ? `\n🚨 Reached cap (Level ${esc.nextLevel}).` : ''}`, flags: [MessageFlags.Ephemeral] });
            } else if (esc?.atCap) {
                await interaction.followUp({ content: `🚨 Escalation threshold hit for Level ${level}, but Level ${esc.cap} cap prevents further escalation.`, flags: [MessageFlags.Ephemeral] });
            } else if (esc?.noNextLevel) {
                await interaction.followUp({ content: `ℹ️ Escalation threshold hit for Level ${level}, but Level ${esc.nextLevel} isn't configured.`, flags: [MessageFlags.Ephemeral] });
            } else if (esc?.counted) {
                await interaction.followUp({ content: `📊 Escalation: ${esc.count}/${esc.threshold} warnings at Level ${level}.`, flags: [MessageFlags.Ephemeral] });
            }
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ Failed to assign warning. Check permissions.', flags: [MessageFlags.Ephemeral] });
        }
    }

    // ── /unwarn ────────────────────────────────────────────────────────────
    else if (commandName === 'unwarn') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const level = interaction.options.getInteger('level');
        if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
        if (!member) return interaction.reply({ content: `❌ ${user} is not in this server.`, flags: [MessageFlags.Ephemeral] });
        const config = await getConfig(guildId);
        if (!config.levels?.[level]) return interaction.reply({ content: `❌ Level ${level} is not configured.`, flags: [MessageFlags.Ephemeral] });
        const role = interaction.guild.roles.cache.get(config.levels[level].roleId);
        if (!role) return interaction.reply({ content: '❌ Configured role not found.', flags: [MessageFlags.Ephemeral] });
        if (!member.roles.cache.has(role.id)) return interaction.reply({ content: `❌ ${user} doesn't have the ${role} role.`, flags: [MessageFlags.Ephemeral] });
        const pendingId = interaction.id;
        pendingUnwarns.set(pendingId, { targetUserId: user.id, targetUserTag: user.tag, level, guildId, roleId: role.id, modId: interaction.user.id });
        setTimeout(() => pendingUnwarns.delete(pendingId), 60_000);
        await interaction.reply({
            embeds: [new EmbedBuilder().setColor('#FFA500').setTitle('⚠️ Confirm Unwarn')
                .setDescription(`Remove **Level ${level}** warning from ${user}?`)
                .addFields({ name: 'Role to remove', value: `${role}`, inline: true })
                .setFooter({ text: 'Expires in 60 seconds' })],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`unwarn_confirm_${pendingId}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(`unwarn_cancel_${pendingId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
            )],
            flags: [MessageFlags.Ephemeral]
        });
    }

    // ── /timeout ───────────────────────────────────────────────────────────
    else if (commandName === 'timeout') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const durationStr = interaction.options.getString('duration');
        const reason = (interaction.options.getString('reason') || 'No reason provided').slice(0, 512).replace(/[\x00-\x1F\x7F]/g, '');
        if (!member) return interaction.reply({ content: `❌ ${user} is not in this server.`, flags: [MessageFlags.Ephemeral] });
        const duration = parseDuration(durationStr);
        if (!duration || duration.isForever) return interaction.reply({ content: '❌ Invalid duration. Use `m:s`, `h:m:s`, or `d:h:m:s`. Max 28 days.', flags: [MessageFlags.Ephemeral] });
        if (duration.totalMs > MAX_TIMEOUT_MS) return interaction.reply({ content: '❌ Discord timeouts cannot exceed 28 days.', flags: [MessageFlags.Ephemeral] });
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: '❌ I need the "Moderate Members" permission for timeouts.', flags: [MessageFlags.Ephemeral] });
        if (member.roles.highest.position >= botMember.roles.highest.position) return interaction.reply({ content: '❌ I cannot timeout this user — their role is equal to or above mine.', flags: [MessageFlags.Ephemeral] });
        try {
            await member.timeout(duration.totalMs, reason);
            const durationDisplay = formatDuration(duration.days, duration.hours, duration.minutes, duration.seconds);
            const expiresTs = Math.floor((Date.now() + duration.totalMs) / 1000);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} timed out ${user.tag} for ${durationDisplay} in ${interaction.guild.name}`);
            await logMod(interaction.guild, guildId, new EmbedBuilder().setColor('#ff6600').setTitle('Member Timed Out')
                .addFields(
                    { name: 'User', value: `${user} (${user.tag})`, inline: true },
                    { name: 'Duration', value: durationDisplay, inline: true },
                    { name: 'Expires', value: `<t:${expiresTs}:R>`, inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: `${interaction.user}` }
                ).setTimestamp());
            user.send({ embeds: [new EmbedBuilder().setColor('#ff6600').setTitle('🔇 You Have Been Timed Out')
                .setDescription(`You were timed out in **${interaction.guild.name}**.`)
                .addFields(
                    { name: 'Duration', value: durationDisplay, inline: true },
                    { name: 'Expires', value: `<t:${expiresTs}:R>`, inline: true },
                    { name: 'Reason', value: reason }
                ).setTimestamp()]
            }).catch(() => {});
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ff6600').setTitle('🔇 Timeout Applied')
                .addFields(
                    { name: 'User', value: `${user}`, inline: true },
                    { name: 'Duration', value: durationDisplay, inline: true },
                    { name: 'Expires', value: `<t:${expiresTs}:R>`, inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Issued by', value: `${interaction.user}` }
                ).setTimestamp()]
            });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ Failed to apply timeout. Check permissions and role hierarchy.', flags: [MessageFlags.Ephemeral] });
        }
    }

    // ── /mywarnings ────────────────────────────────────────────────────────
    else if (commandName === 'mywarnings') {
        const userId = interaction.user.id;
        const userWarnings = [...activeWarnings.values()].filter(w => w.guildId === guildId && w.userId === userId);
        if (!userWarnings.length) return interaction.reply({ content: '✅ You have no active warnings!', flags: [MessageFlags.Ephemeral] });
        const config = await getConfig(guildId);
        const embed = new EmbedBuilder().setColor('#FFA500').setTitle('⏰ Your Active Warnings')
            .setDescription(`You have ${userWarnings.length} active warning${userWarnings.length > 1 ? 's' : ''}:`)
            .setFooter({ text: 'Warnings are automatically removed when they expire' }).setTimestamp();
        for (const warning of userWarnings) {
            const levelConfig = config.levels?.[warning.level];
            const fieldName = `Level ${warning.level} — ${levelConfig?.roleName || 'Unknown Role'}`;
            if (warning.isForever) {
                embed.addFields({ name: fieldName, value: '⏳ **Duration:** Forever\n🔒 **Status:** Permanent' });
            } else {
                const timeLeft = warning.expiresAt - Date.now();
                if (timeLeft <= 0) {
                    embed.addFields({ name: fieldName, value: '⏳ Expired (will be removed shortly)' });
                } else {
                    const s = Math.floor(timeLeft / 1000);
                    embed.addFields({ name: fieldName, value: `⏳ **Time Left:** ${formatDuration(Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60)}\n📅 **Expires:** <t:${Math.floor(warning.expiresAt / 1000)}:F>` });
                }
            }
        }
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    // ── /warnlist ──────────────────────────────────────────────────────────
    else if (commandName === 'warnlist') {
        const { embed, totalPages, page } = buildWarnlistEmbed(guildId, 0);
        await interaction.reply({ embeds: [embed], components: warnlistRow(page, totalPages, guildId), flags: [MessageFlags.Ephemeral] });
    }

    // ── /history ───────────────────────────────────────────────────────────
    else if (commandName === 'history') {
        const user = interaction.options.getUser('user');
        const entries = await getHistory(guildId, user.id);
        if (!entries.length) return interaction.reply({ content: `📋 No warning history found for ${user}.`, flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setColor('#5865F2')
            .setTitle(`📋 Warning History — ${user.tag}`)
            .setDescription(`Showing last ${entries.length} record${entries.length > 1 ? 's' : ''}.`)
            .setTimestamp();
        for (const e of entries) {
            if (e.type === 'kick') {
                embed.addFields({ name: `Kick — <t:${Math.floor(e.issuedAt / 1000)}:d>`, value: `by ${e.issuedBy}\n${e.reason}` });
            } else if (e.type === 'ban') {
                embed.addFields({ name: `Ban — <t:${Math.floor(e.issuedAt / 1000)}:d>`, value: `by ${e.issuedBy}\n${e.reason}` });
            } else {
                const status = e.endReason === 'expired' ? '✅ Expired' : e.endReason === 'manual' ? '🔓 Removed' : '⏳ Active';
                embed.addFields({ name: `Level ${e.level} — ${e.roleName} — <t:${Math.floor(e.issuedAt / 1000)}:d>`, value: `${status} • by ${e.issuedBy}\n${e.reason}` });
            }
        }
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    // ── /kick ──────────────────────────────────────────────────────────────
    else if (commandName === 'kick') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const reason = interaction.options.getString('reason').slice(0, 512).replace(/[\x00-\x1F\x7F]/g, '');
        if (!member) return interaction.reply({ content: `❌ ${user} is not in this server.`, flags: [MessageFlags.Ephemeral] });
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: '❌ I need the "Kick Members" permission.', flags: [MessageFlags.Ephemeral] });
        if (member.roles.highest.position >= botMember.roles.highest.position) return interaction.reply({ content: '❌ I cannot kick this user — their role is equal to or above mine.', flags: [MessageFlags.Ephemeral] });
        try {
            user.send({ embeds: [new EmbedBuilder().setColor('#ff6600').setTitle('You have been kicked')
                .setDescription(`You were kicked from **${interaction.guild.name}**.`)
                .addFields({ name: 'Reason', value: reason }).setTimestamp()]
            }).catch(() => {});
            await member.kick(reason);
            await addHistory(guildId, user.id, { guildId, userId: user.id, userTag: user.tag, type: 'kick', reason, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            console.log(`🔒 [AUDIT] ${interaction.user.tag} kicked ${user.tag} from ${interaction.guild.name}`);
            await logMod(interaction.guild, guildId, new EmbedBuilder().setColor('#ff6600').setTitle('Member Kicked')
                .addFields(
                    { name: 'User', value: `${user} (${user.tag})`, inline: true },
                    { name: 'Moderator', value: `${interaction.user}`, inline: true },
                    { name: 'Reason', value: reason }
                ).setTimestamp());
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ff6600').setTitle('Member Kicked')
                .addFields(
                    { name: 'User', value: `${user}`, inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Kicked by', value: `${interaction.user}` }
                ).setTimestamp()]
            });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ Failed to kick user. Check permissions.', flags: [MessageFlags.Ephemeral] });
        }
    }

    // ── /ban ───────────────────────────────────────────────────────────────
    else if (commandName === 'ban') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const reason = interaction.options.getString('reason').slice(0, 512).replace(/[\x00-\x1F\x7F]/g, '');
        const deleteDays = interaction.options.getInteger('delete_days') ?? 0;
        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: '❌ I need the "Ban Members" permission.', flags: [MessageFlags.Ephemeral] });
        if (member && member.roles.highest.position >= botMember.roles.highest.position) return interaction.reply({ content: '❌ I cannot ban this user — their role is equal to or above mine.', flags: [MessageFlags.Ephemeral] });
        try {
            if (member) {
                user.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('You have been banned')
                    .setDescription(`You were banned from **${interaction.guild.name}**.`)
                    .addFields({ name: 'Reason', value: reason }).setTimestamp()]
                }).catch(() => {});
            }
            await interaction.guild.members.ban(user, { reason, deleteMessageDays: deleteDays });
            await addHistory(guildId, user.id, { guildId, userId: user.id, userTag: user.tag, type: 'ban', reason, issuedBy: interaction.user.tag, issuedAt: Date.now(), deleteDays });
            console.log(`🔒 [AUDIT] ${interaction.user.tag} banned ${user.tag} from ${interaction.guild.name}`);
            await logMod(interaction.guild, guildId, new EmbedBuilder().setColor('#ff0000').setTitle('Member Banned')
                .addFields(
                    { name: 'User', value: `${user} (${user.tag})`, inline: true },
                    { name: 'Moderator', value: `${interaction.user}`, inline: true },
                    { name: 'Messages Deleted', value: `${deleteDays} day(s)`, inline: true },
                    { name: 'Reason', value: reason }
                ).setTimestamp());
            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('Member Banned')
                .addFields(
                    { name: 'User', value: `${user}`, inline: true },
                    { name: 'Messages Deleted', value: `${deleteDays} day(s)`, inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Banned by', value: `${interaction.user}` }
                ).setTimestamp()]
            });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ Failed to ban user. Check permissions.', flags: [MessageFlags.Ephemeral] });
        }
    }

    // ── /note ──────────────────────────────────────────────────────────────
    else if (commandName === 'note') {
        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('user');

        if (sub === 'add') {
            const text = interaction.options.getString('text').slice(0, 1000).replace(/[\x00-\x1F\x7F]/g, '');
            const note = { id: Date.now(), text, addedBy: interaction.user.tag, addedAt: Date.now() };
            await addNote(guildId, user.id, note);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} added note to ${user.tag} in ${interaction.guild.name}`);
            await interaction.reply({ content: `✅ Note added to ${user} (ID: \`${note.id}\`).`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'view') {
            const notes = await getNotes(guildId, user.id);
            if (!notes.length) return interaction.reply({ content: `📋 No notes found for ${user}.`, flags: [MessageFlags.Ephemeral] });
            const embed = new EmbedBuilder().setColor('#5865F2').setTitle(`Notes — ${user.tag}`)
                .setDescription(`${notes.length} note${notes.length > 1 ? 's' : ''} on record.`).setTimestamp();
            for (const n of notes.slice(-10))
                embed.addFields({ name: `ID: ${n.id} — <t:${Math.floor(n.addedAt / 1000)}:d> — ${n.addedBy}`, value: n.text });
            if (notes.length > 10) embed.setFooter({ text: `Showing last 10 of ${notes.length} notes` });
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'delete') {
            const id = interaction.options.getInteger('id');
            const deleted = await deleteNote(guildId, user.id, id);
            if (!deleted) return interaction.reply({ content: `❌ Note ID \`${id}\` not found for ${user}.`, flags: [MessageFlags.Ephemeral] });
            await interaction.reply({ content: `✅ Note \`${id}\` deleted.`, flags: [MessageFlags.Ephemeral] });
        }
    }

    // ── /escalation ────────────────────────────────────────────────────────
    else if (commandName === 'escalation') {

        const sub = interaction.options.getSubcommand();
        const config = await getConfig(guildId);
        config.escalation ??= { thresholds: {} };
        const esc = config.escalation;

        if (sub === 'set') {
            const level = interaction.options.getInteger('level');
            const threshold = interaction.options.getInteger('threshold');
            if (level < 1 || level > 100) return interaction.reply({ content: '❌ Level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
            if (threshold < 2 || threshold > 50) return interaction.reply({ content: '❌ Threshold must be between 2 and 50.', flags: [MessageFlags.Ephemeral] });
            esc.thresholds[level] = threshold;
            await saveConfig(guildId, config);
            await interaction.reply({ content: `✅ **${threshold}x** Level ${level} warnings → auto Level ${level + 1}.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'remove') {
            const level = interaction.options.getInteger('level');
            if (!esc.thresholds[level]) return interaction.reply({ content: `❌ No threshold set for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
            delete esc.thresholds[level];
            await saveConfig(guildId, config);
            await interaction.reply({ content: `✅ Removed escalation threshold for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'setcap') {
            const level = interaction.options.getInteger('level');
            if (level < 1 || level > 100) return interaction.reply({ content: '❌ Cap must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
            esc.cap = level;
            await saveConfig(guildId, config);
            await interaction.reply({ content: `✅ Level cap set to **${level}**.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'removecap') {
            if (!esc.cap) return interaction.reply({ content: '❌ No level cap is set.', flags: [MessageFlags.Ephemeral] });
            delete esc.cap;
            await saveConfig(guildId, config);
            await interaction.reply({ content: '✅ Level cap removed.', flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'settimeout') {
            const level = interaction.options.getInteger('level');
            const threshold = interaction.options.getInteger('threshold');
            const durationStr = interaction.options.getString('duration');
            if (level < 2 || level > 100) return interaction.reply({ content: '❌ Target level must be between 2 and 100.', flags: [MessageFlags.Ephemeral] });
            if (threshold < 2 || threshold > 50) return interaction.reply({ content: '❌ Threshold must be between 2 and 50.', flags: [MessageFlags.Ephemeral] });
            const duration = parseDuration(durationStr);
            if (!duration || duration.isForever) return interaction.reply({ content: '❌ Invalid duration. Use `m:s`, `h:m:s`, or `d:h:m:s`. Max 28 days.', flags: [MessageFlags.Ephemeral] });
            if (duration.totalMs > MAX_TIMEOUT_MS) return interaction.reply({ content: '❌ Discord timeouts cannot exceed 28 days.', flags: [MessageFlags.Ephemeral] });
            esc.timeouts ??= {};
            esc.timeouts[level] = { durationMs: duration.totalMs, durationDisplay: formatDuration(duration.days, duration.hours, duration.minutes, duration.seconds), threshold };
            await saveConfig(guildId, config);
            await interaction.reply({ content: `✅ Timeout escalation set: **${threshold}x** Level ${level - 1} warnings → auto Level ${level} + **${esc.timeouts[level].durationDisplay}** timeout.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'removetimeout') {
            const level = interaction.options.getInteger('level');
            if (!esc.timeouts?.[level]) return interaction.reply({ content: `❌ No escalation timeout for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
            delete esc.timeouts[level];
            await saveConfig(guildId, config);
            await interaction.reply({ content: `✅ Removed escalation timeout for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'view') {
            const embed = new EmbedBuilder().setColor('#5865F2').setTitle('⬆️ Escalation Configuration').setTimestamp();
            const thresholds = esc.thresholds ?? {};
            const timeouts = esc.timeouts ?? {};
            if (!Object.keys(thresholds).length && !esc.cap && !Object.keys(timeouts).length) {
                embed.setDescription('No escalation rules configured. Use `/escalation set` to add thresholds.');
            } else {
                if (Object.keys(thresholds).length)
                    embed.addFields({ name: 'Thresholds', value: Object.entries(thresholds).sort(([a], [b]) => a - b).map(([lvl, t]) => `• **${t}x** Level ${lvl} → auto Level ${parseInt(lvl) + 1}`).join('\n') });
                if (Object.keys(timeouts).length)
                    embed.addFields({ name: 'Timeouts on Escalation', value: Object.entries(timeouts).sort(([a], [b]) => a - b).map(([lvl, t]) => `• ${t.threshold}x Level ${parseInt(lvl) - 1} → auto Level ${lvl} + **${t.durationDisplay}** timeout`).join('\n') });
                embed.addFields({ name: 'Level Cap', value: esc.cap ? `Level **${esc.cap}**` : 'None' });
            }
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        }
    }

  } catch (error) {
      console.error('❌ Interaction error:', error);
      try {
          const msg = { content: '❌ Something went wrong. Please try again.', flags: [MessageFlags.Ephemeral] };
          if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
          else await interaction.reply(msg);
      } catch {}
  }
});

process.on('unhandledRejection', error => console.error('⚠️ Unhandled rejection:', error));
client.on('error', error => console.error('⚠️ Discord client error:', error));

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    const ok = req.url === '/' || req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(ok ? 'Police bot is running!' : 'Not found');
});
server.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));

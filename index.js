const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, RoleSelectMenuBuilder, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const configPath   = path.join(__dirname, 'config.json');
const warningsPath = path.join(__dirname, 'warnings.json');
const historyPath  = path.join(__dirname, 'history.json');

function loadJSON(filePath, label, fallback) {
    if (!fs.existsSync(filePath)) return fallback;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        console.log(`✅ Loaded ${label} successfully`);
        return data;
    } catch (e) {
        console.error(`❌ Failed to load ${label}:`, e.message);
        return fallback;
    }
}

let guildConfigs   = loadJSON(configPath,   'config.json',   {});
let activeWarnings = loadJSON(warningsPath, 'warnings.json', {});
let warnHistory    = loadJSON(historyPath,  'history.json',  {});

function saveConfigs() {
    fs.writeFileSync(configPath, JSON.stringify(guildConfigs, null, 2));
    saveFileToGitHub(configPath, 'config.json', 'Auto-save: Update config.json').catch(e => console.error('Config GitHub save failed:', e.message));
}
function saveWarnings() {
    fs.writeFileSync(warningsPath, JSON.stringify(activeWarnings, null, 2));
    saveFileToGitHub(warningsPath, 'warnings.json', 'Auto-save: Update warnings.json').catch(e => console.error('Warning GitHub save failed:', e.message));
}
function saveHistory() {
    fs.writeFileSync(historyPath, JSON.stringify(warnHistory, null, 2));
    saveFileToGitHub(historyPath, 'history.json', 'Auto-save: Update history.json').catch(e => console.error('History GitHub save failed:', e.message));
}
function addHistory(guildId, entry) {
    warnHistory[guildId] ??= [];
    warnHistory[guildId].push(entry);
    if (warnHistory[guildId].length > 1000) warnHistory[guildId] = warnHistory[guildId].slice(-1000);
    saveHistory();
}

async function saveFileToGitHub(filePath, fileName, commitMessage) {
    const { GITHUB_TOKEN: token, GITHUB_OWNER: owner, GITHUB_REPO: repo } = process.env;
    if (!token || !owner || !repo) { console.warn(`⚠️ GitHub save skipped for ${fileName}`); return false; }
    try {
        const base64Content = Buffer.from(fs.readFileSync(filePath, 'utf8')).toString('base64');
        const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${fileName}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Police-Discord-Bot' }
        });
        const sha = getRes.ok ? (await getRes.json()).sha : null;
        const updateRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${fileName}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'Police-Discord-Bot' },
            body: JSON.stringify({ message: commitMessage, content: base64Content, branch: 'main', ...(sha && { sha }) })
        });
        if (updateRes.ok) { console.log(`💾 ${fileName} saved to GitHub`); return true; }
        console.error(`❌ GitHub save failed:`, (await updateRes.json()).message);
        return false;
    } catch (e) { console.error(`❌ GitHub save error:`, e.message); return false; }
}

async function showAccessControlConfig(interaction, guildId) {
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🔒 Access Configuration')
        .setDescription('Select which role should have access to moderation commands:\n\n**Commands affected:**\n• `/warn` `/unwarn` `/timeout` `/config set/view`\n• `/accessconfig` `/warnlist` `/history` `/escalation`\n\n**Note:** Server administrators always have access.')
        .setFooter({ text: 'Select a role from the dropdown below' });
    const row = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId(`access_role_${guildId}`).setPlaceholder('Select a role for command access').setMinValues(1).setMaxValues(1)
    );
    await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
}

function hasCommandPermission(interaction, guildId) {
    const member = interaction.member;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const accessRoleId = guildConfigs[guildId]?.accessRoleId;
    return accessRoleId ? member.roles.cache.has(accessRoleId) : false;
}

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

const warningTimers = new Map();
const pendingUnwarns = new Map();
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

async function handleWarningExpiry(warningKey, guildId, userId, roleId, channelId) {
    const w = activeWarnings[warningKey];
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
    if (w) addHistory(guildId, { ...w, endedAt: Date.now(), endReason: 'expired' });
    warningTimers.delete(warningKey);
    delete activeWarnings[warningKey];
    saveWarnings();
}

async function scheduleWarningRemoval(warningKey, guildId, userId, roleId, expiresAt, channelId) {
    const timeLeft = expiresAt - Date.now();
    if (timeLeft <= 0) return handleWarningExpiry(warningKey, guildId, userId, roleId, channelId);
    warningTimers.set(warningKey, setTimeout(() => handleWarningExpiry(warningKey, guildId, userId, roleId, channelId), timeLeft));
}

async function applyWarning(guild, member, user, guildId, level, reason, channelId, issuedByTag) {
    const config = guildConfigs[guildId].levels[level];
    const role = guild.roles.cache.get(config?.roleId);
    if (!config || !role) return { error: `Level ${level} config or role not found.` };
    const botMember = guild.members.me;
    if (role.position >= botMember.roles.highest.position) return { error: `Role hierarchy: my role must be above ${role.name}.` };
    await member.roles.add(role);
    user.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ You Received a Warning')
        .setDescription(`You have been warned in **${guild.name}**.`)
        .addFields(
            { name: 'Warning Level', value: `${level}`, inline: true },
            { name: 'Duration', value: config.durationDisplay || 'Unknown', inline: true },
            { name: 'Reason', value: reason }
        ).setFooter({ text: `Use /mywarnings in ${guild.name} to check when this warning expires` }).setTimestamp()]
    }).catch(() => {});
    const baseEntry = { guildId, userId: user.id, userTag: user.tag, roleId: role.id, roleName: role.name, level, reason, issuedBy: issuedByTag, issuedAt: Date.now() };
    const warningKey = `${guildId}-${user.id}-${level}-${Date.now()}`;
    if (!config.isForever) {
        const expiresAt = Date.now() + config.durationMs;
        activeWarnings[warningKey] = { ...baseEntry, expiresAt, channelId, isForever: false };
        saveWarnings();
        scheduleWarningRemoval(warningKey, guildId, user.id, role.id, expiresAt, channelId);
    } else {
        activeWarnings[warningKey] = { ...baseEntry, expiresAt: null, channelId, isForever: true };
        saveWarnings();
    }
    return { success: true, role, config };
}

async function checkEscalation(guild, member, user, guildId, level, channelId, issuedByTag) {
    const esc = guildConfigs[guildId].escalation ?? {};
    const cap = esc.cap;
    const nextLevel = level + 1;
    if (cap != null && nextLevel > cap) return { atCap: true, cap };

    const count = Object.values(activeWarnings).filter(w => w.guildId === guildId && w.userId === user.id && w.level === level).length;

    // Timeout-escalation: self-contained with its own threshold stored in timeouts[nextLevel].threshold
    const timeoutCfg = esc.timeouts?.[nextLevel];
    if (timeoutCfg?.threshold != null) {
        if (count < timeoutCfg.threshold) return { counted: true, count, threshold: timeoutCfg.threshold };
        if (!guildConfigs[guildId].levels[nextLevel]) return { noNextLevel: true, nextLevel };
        const result = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
        if (result.error) return { escalationError: result.error };
        await member.timeout(timeoutCfg.durationMs, `Auto-escalated to Level ${nextLevel}`).catch(e => console.error('Escalation timeout failed:', e.message));
        user.send({ embeds: [new EmbedBuilder().setColor('#ff6600').setTitle('🔇 You Have Been Timed Out')
            .setDescription(`You were auto-timed-out in **${guild.name}** upon reaching Warning Level ${nextLevel}.`)
            .addFields({ name: 'Timeout Duration', value: timeoutCfg.durationDisplay, inline: true })
            .setTimestamp()]
        }).catch(() => {});
        return { escalated: true, nextLevel, role: result.role, config: result.config, hitCap: cap != null && nextLevel === cap, timedOut: true, timeoutDisplay: timeoutCfg.durationDisplay };
    }

    // Regular threshold escalation (no timeout)
    const threshold = esc.thresholds?.[level];
    if (!threshold) return null;
    if (count < threshold) return { counted: true, count, threshold };
    if (!guildConfigs[guildId].levels[nextLevel]) return { noNextLevel: true, nextLevel };
    const result = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
    if (result.error) return { escalationError: result.error };
    return { escalated: true, nextLevel, role: result.role, config: result.config, hitCap: cap != null && nextLevel === cap, timedOut: false };
}

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

const WARN_PAGE_SIZE = 10;

function buildWarnlistEmbed(guildId, page) {
    const allWarnings = Object.values(activeWarnings).filter(w => w.guildId === guildId);
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

client.once('ready', () => {
    console.log(`✅ Police bot is online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Monitoring the security cameras', type: ActivityType.Watching }], status: 'online' });
    console.log(`🔄 Restoring ${Object.keys(activeWarnings).length} active warnings...`);
    for (const [key, w] of Object.entries(activeWarnings)) scheduleWarningRemoval(key, w.guildId, w.userId, w.roleId, w.expiresAt, w.channelId);
    keepAlive();
    console.log('🏓 Keep-alive system started');

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
        new SlashCommandBuilder().setName('config').setDescription('Configure warning levels')
            .addIntegerOption(o => o.setName('level').setDescription('Warning level (1, 2, 3...)').setRequired(true))
            .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true))
            .addStringOption(o => o.setName('duration').setDescription('d:h:m:s or "forever"').setRequired(true)),
        new SlashCommandBuilder().setName('config_view').setDescription('View all configured warning levels'),
        new SlashCommandBuilder().setName('accessconfig').setDescription('Configure which role can access moderation commands'),
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
        new SlashCommandBuilder().setName('help').setDescription('View all available commands'),
    ].map(c => c.toJSON());

    client.application.commands.set(commands);
});

client.on('guildCreate', async guild => {
    console.log(`Bot joined: ${guild.name} (${guild.id})`);
    if (!guildConfigs[guild.id]) { guildConfigs[guild.id] = { levels: {} }; saveConfigs(); }
    try {
        const logs = await guild.fetchAuditLogs({ type: 28, limit: 5 });
        const entry = logs.entries.find(e => e.target?.id === client.user.id && Date.now() - e.createdTimestamp < 60000);
        const inviterId = entry?.executor?.id;
        if (guild.systemChannel) {
            const embed = new EmbedBuilder().setColor('#5865F2').setTitle('👋 Thanks for adding Police Bot!')
                .setDescription(`${inviterId ? `<@${inviterId}>, please` : 'An administrator should'} run \`/accessconfig\` to set up command permissions.\n\n**Quick Start:**\n1. \`/accessconfig\` — set the moderator role\n2. \`/config\` — set up warning levels\n3. \`/warn\` — start moderating!`)
                .setFooter({ text: 'Use /help to see all commands' });
            await guild.systemChannel.send({ embeds: [embed] }).catch(e => console.log(`⚠️ Could not send setup message: ${e.message}`));
        }
    } catch (e) { console.error('Error in guildCreate:', e); }
});

client.on('guildMemberAdd', async member => {
    const { guild, id: userId } = member;
    const userWarnings = Object.entries(activeWarnings).filter(([, w]) => w.guildId === guild.id && w.userId === userId);
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

client.on('interactionCreate', async interaction => {

    if (interaction.isRoleSelectMenu()) {
        if (!interaction.customId.startsWith('access_role_')) return;
        const guildId = interaction.customId.replace('access_role_', '');
        if (guildId !== interaction.guild.id) return interaction.reply({ content: '❌ Invalid interaction. Please run /accessconfig again.', flags: [MessageFlags.Ephemeral] });
        const selectedRole = interaction.roles.first();
        if (!selectedRole) return interaction.reply({ content: '❌ No role selected.', flags: [MessageFlags.Ephemeral] });
        if (selectedRole.id === interaction.guild.id) return interaction.update({ content: '❌ Cannot use @everyone as access role.', components: [] });
        if (selectedRole.managed) return interaction.update({ content: '❌ Cannot use managed/bot roles as access role.', components: [] });
        guildConfigs[guildId] ??= { levels: {} };
        guildConfigs[guildId].accessRoleId = selectedRole.id;
        saveConfigs();
        await interaction.update({
            embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Access Control Updated')
                .setDescription(`Members with the ${selectedRole} role can now use moderation commands.\n\n*Server administrators always have access.*`)
                .setTimestamp()],
            components: []
        });
        console.log(`🔒 [AUDIT] Access role set to ${selectedRole.name} in ${interaction.guild.name}`);
        return;
    }

    if (interaction.isButton()) {
        const { customId } = interaction;

        if (customId.startsWith('wl_')) {
            if (!hasCommandPermission(interaction, interaction.guild.id)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
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
                const warningKeys = Object.keys(activeWarnings).filter(k => {
                    const w = activeWarnings[k];
                    return w.userId === targetUserId && w.guildId === guildId && w.level === level;
                });
                warningKeys.forEach(k => {
                    addHistory(guildId, { ...activeWarnings[k], endedAt: Date.now(), endReason: 'manual' });
                    clearTimeout(warningTimers.get(k));
                    warningTimers.delete(k);
                    delete activeWarnings[k];
                });
                if (warningKeys.length > 0) saveWarnings();
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

    guildConfigs[guildId] ??= { levels: {} };

    const restrictedCommands = ['config', 'config_view', 'warn', 'unwarn', 'timeout', 'accessconfig', 'warnlist', 'history', 'escalation'];
    if (restrictedCommands.includes(commandName) && !hasCommandPermission(interaction, guildId)) {
        const accessRole = guildConfigs[guildId]?.accessRoleId;
        return interaction.reply({
            content: `❌ You don't have permission to use this command.\n\n**Required:** Administrator OR ${accessRole ? `<@&${accessRole}>` : 'no access role configured'}\n\nAsk an admin to run \`/accessconfig\`.`,
            flags: [MessageFlags.Ephemeral]
        });
    }

    if (commandName === 'help') {
        await interaction.reply({
            embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('📖 Police Bot — Commands')
                .addFields(
                    { name: '⚠️ Warn', value: '`/warn` — warn a user at a configured level\n`/unwarn` — remove a warning (with confirmation)\n`/timeout` — apply a Discord timeout\n`/mywarnings` — check your own active warnings\n`/warnlist` — see all active warnings\n`/history` — view a user\'s full warning history' },
                    { name: '⚙️ Config', value: '`/config` — set up a warning level (role + duration)\n`/config view` — view all configured levels\n`/accessconfig` — set the moderator role' },
                    { name: '⬆️ Escalation', value: '`/escalation set` — set a threshold to auto-escalate\n`/escalation remove` — remove a threshold\n`/escalation setcap` / `removecap` — set/remove the level cap\n`/escalation settimeout` — timeout on escalation to a level\n`/escalation removetimeout` — remove that timeout\n`/escalation view` — view all rules' },
                    { name: '❓ Other', value: '`/help` — this menu' }
                ).setFooter({ text: 'Mod commands require the configured access role or Administrator' })],
            flags: [MessageFlags.Ephemeral]
        });
    }

    else if (commandName === 'accessconfig') {
        await showAccessControlConfig(interaction, guildId);
    }

    else if (commandName === 'config') {
        const level = interaction.options.getInteger('level');
        const role = interaction.options.getRole('role');
        const durationStr = interaction.options.getString('duration');
        if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
        const duration = parseDuration(durationStr);
        if (!duration) return interaction.reply({ content: '❌ Invalid duration. Use `m:s`, `h:m:s`, `d:h:m:s`, or `forever`. Max 365 days.', flags: [MessageFlags.Ephemeral] });
        guildConfigs[guildId].levels[level] = {
            roleId: role.id, roleName: role.name,
            durationMs: duration.totalMs, isForever: duration.isForever,
            durationDisplay: formatDuration(duration.days, duration.hours, duration.minutes, duration.seconds, duration.isForever)
        };
        saveConfigs();
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
    }

    else if (commandName === 'config_view') {
        const config = guildConfigs[guildId];
        if (!config || Object.keys(config.levels).length === 0) return interaction.reply({ content: '📋 No warning levels configured yet. Use /config to add some.', flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setColor('#0099ff').setTitle('🚨 Warning Configuration').setTimestamp();
        for (const [level, data] of Object.entries(config.levels))
            embed.addFields({ name: `Level ${level}`, value: `Role: <@&${data.roleId}>\nDuration: ${data.durationDisplay}`, inline: true });
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    else if (commandName === 'warn') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const level = interaction.options.getInteger('level');
        const reason = (interaction.options.getString('reason') || 'No reason provided').slice(0, 1000).replace(/[\x00-\x1F\x7F]/g, '');
        if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
        if (!member) return interaction.reply({ content: `❌ ${user} is not in this server.`, flags: [MessageFlags.Ephemeral] });
        if (!guildConfigs[guildId].levels[level]) return interaction.reply({ content: `❌ Level ${level} is not configured. Use /config first.`, flags: [MessageFlags.Ephemeral] });
        const botMember = interaction.guild.members.me;
        const configRole = interaction.guild.roles.cache.get(guildConfigs[guildId].levels[level].roleId);
        if (!configRole) return interaction.reply({ content: '❌ Configured role not found. Please re-run /config.', flags: [MessageFlags.Ephemeral] });
        if (configRole.position >= botMember.roles.highest.position) return interaction.reply({ content: `❌ My role must be above ${configRole} in the role list.`, flags: [MessageFlags.Ephemeral] });
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: '❌ I need the "Manage Roles" permission.', flags: [MessageFlags.Ephemeral] });
        try {
            const result = await applyWarning(interaction.guild, member, user, guildId, level, reason, interaction.channel.id, interaction.user.tag);
            if (result.error) return interaction.reply({ content: `❌ ${result.error}`, flags: [MessageFlags.Ephemeral] });
            console.log(`🔒 [AUDIT] ${interaction.user.tag} warned ${user.tag} (Level ${level}) in ${interaction.guild.name}`);
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
            const cap = guildConfigs[guildId].escalation?.cap;
            if (cap && level === cap) await interaction.followUp({ content: `🚨 ${user} is at the cap level (Level ${cap}). No further auto-escalation.`, flags: [MessageFlags.Ephemeral] });
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

    else if (commandName === 'unwarn') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const level = interaction.options.getInteger('level');
        if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
        if (!member) return interaction.reply({ content: `❌ ${user} is not in this server.`, flags: [MessageFlags.Ephemeral] });
        if (!guildConfigs[guildId].levels[level]) return interaction.reply({ content: `❌ Level ${level} is not configured.`, flags: [MessageFlags.Ephemeral] });
        const config = guildConfigs[guildId].levels[level];
        const role = interaction.guild.roles.cache.get(config.roleId);
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

    else if (commandName === 'mywarnings') {
        const userId = interaction.user.id;
        const userWarnings = Object.entries(activeWarnings).filter(([, w]) => w.guildId === guildId && w.userId === userId);
        if (userWarnings.length === 0) return interaction.reply({ content: '✅ You have no active warnings!', flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setColor('#FFA500').setTitle('⏰ Your Active Warnings')
            .setDescription(`You have ${userWarnings.length} active warning${userWarnings.length > 1 ? 's' : ''}:`)
            .setFooter({ text: 'Warnings are automatically removed when they expire' }).setTimestamp();
        for (const [, warning] of userWarnings) {
            const config = guildConfigs[guildId]?.levels[warning.level];
            const fieldName = `Level ${warning.level} — ${config?.roleName || 'Unknown Role'}`;
            if (config?.isForever) {
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

    else if (commandName === 'warnlist') {
        const { embed, totalPages, page } = buildWarnlistEmbed(guildId, 0);
        await interaction.reply({ embeds: [embed], components: warnlistRow(page, totalPages, guildId), flags: [MessageFlags.Ephemeral] });
    }

    else if (commandName === 'history') {
        const user = interaction.options.getUser('user');
        const entries = (warnHistory[guildId] || []).filter(e => e.userId === user.id);
        if (!entries.length) return interaction.reply({ content: `📋 No warning history found for ${user}.`, flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setColor('#5865F2')
            .setTitle(`📋 Warning History — ${user.tag}`)
            .setDescription(`${entries.length} total warning${entries.length > 1 ? 's' : ''} on record.`)
            .setTimestamp();
        for (const e of entries.slice(-10)) {
            const status = e.endReason === 'expired' ? '✅ Expired' : e.endReason === 'manual' ? '🔓 Removed' : '⏳ Active';
            embed.addFields({ name: `Level ${e.level} — ${e.roleName} — <t:${Math.floor(e.issuedAt / 1000)}:d>`, value: `${status} • by ${e.issuedBy}\n${e.reason}` });
        }
        if (entries.length > 10) embed.setFooter({ text: `Showing last 10 of ${entries.length} entries` });
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }

    else if (commandName === 'escalation') {
        const sub = interaction.options.getSubcommand();
        guildConfigs[guildId].escalation ??= { thresholds: {} };
        const esc = guildConfigs[guildId].escalation;

        if (sub === 'set') {
            const level = interaction.options.getInteger('level');
            const threshold = interaction.options.getInteger('threshold');
            if (level < 1 || level > 100) return interaction.reply({ content: '❌ Level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
            if (threshold < 2 || threshold > 50) return interaction.reply({ content: '❌ Threshold must be between 2 and 50.', flags: [MessageFlags.Ephemeral] });
            esc.thresholds[level] = threshold;
            saveConfigs();
            await interaction.reply({ content: `✅ **${threshold}x** Level ${level} warnings → auto Level ${level + 1}.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'remove') {
            const level = interaction.options.getInteger('level');
            if (!esc.thresholds[level]) return interaction.reply({ content: `❌ No threshold set for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
            delete esc.thresholds[level];
            saveConfigs();
            await interaction.reply({ content: `✅ Removed escalation threshold for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'setcap') {
            const level = interaction.options.getInteger('level');
            if (level < 1 || level > 100) return interaction.reply({ content: '❌ Cap must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
            esc.cap = level;
            saveConfigs();
            await interaction.reply({ content: `✅ Level cap set to **${level}**.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'removecap') {
            if (!esc.cap) return interaction.reply({ content: '❌ No level cap is set.', flags: [MessageFlags.Ephemeral] });
            delete esc.cap;
            saveConfigs();
            await interaction.reply({ content: '✅ Level cap removed.', flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'settimeout') {
            const level = interaction.options.getInteger('level');
            const threshold = interaction.options.getInteger('threshold');
            const durationStr = interaction.options.getString('duration');
            if (level < 2 || level > 100) return interaction.reply({ content: '❌ Target level must be between 2 and 100 (level 1 has no previous level to escalate from).', flags: [MessageFlags.Ephemeral] });
            if (threshold < 2 || threshold > 50) return interaction.reply({ content: '❌ Threshold must be between 2 and 50.', flags: [MessageFlags.Ephemeral] });
            const duration = parseDuration(durationStr);
            if (!duration || duration.isForever) return interaction.reply({ content: '❌ Invalid duration. Use `m:s`, `h:m:s`, or `d:h:m:s`. Max 28 days.', flags: [MessageFlags.Ephemeral] });
            if (duration.totalMs > MAX_TIMEOUT_MS) return interaction.reply({ content: '❌ Discord timeouts cannot exceed 28 days.', flags: [MessageFlags.Ephemeral] });
            esc.timeouts ??= {};
            esc.timeouts[level] = { durationMs: duration.totalMs, durationDisplay: formatDuration(duration.days, duration.hours, duration.minutes, duration.seconds), threshold };
            saveConfigs();
            await interaction.reply({ content: `✅ Timeout escalation set: **${threshold}x** Level ${level - 1} warnings → auto Level ${level} + **${esc.timeouts[level].durationDisplay}** timeout.`, flags: [MessageFlags.Ephemeral] });
        } else if (sub === 'removetimeout') {
            const level = interaction.options.getInteger('level');
            if (!esc.timeouts?.[level]) return interaction.reply({ content: `❌ No escalation timeout for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
            delete esc.timeouts[level];
            saveConfigs();
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
                    embed.addFields({ name: 'Timeouts on Escalation', value: Object.entries(timeouts).sort(([a], [b]) => a - b).map(([lvl, t]) => `• ${t.threshold}x Level ${parseInt(lvl)-1} → auto Level ${lvl} + **${t.durationDisplay}** timeout`).join('\n') });
                embed.addFields({ name: 'Level Cap', value: esc.cap ? `Level **${esc.cap}**` : 'None' });
            }
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        }
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
server.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));s.end(ok ? 'Police bot is running!' : 'Not found');
});
server.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));

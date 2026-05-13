const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, RoleSelectMenuBuilder, ActivityType, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const configPath   = path.join(__dirname, 'config.json');
const warningsPath = path.join(__dirname, 'warnings.json');
const historyPath  = path.join(__dirname, 'history.json');
const countsPath   = path.join(__dirname, 'counts.json');

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
let warnCounts     = loadJSON(countsPath,   'counts.json',   {});

function saveConfigs() {
    fs.writeFileSync(configPath, JSON.stringify(guildConfigs, null, 2));
    saveFileToGitHub(configPath, 'config.json', 'Auto-save: Update config.json').catch(e => console.error('Config GitHub save failed:', e.message));
}
function saveCounts() {
    fs.writeFileSync(countsPath, JSON.stringify(warnCounts, null, 2));
    saveFileToGitHub(countsPath, 'counts.json', 'Auto-save: Update counts.json').catch(e => console.error('Counts GitHub save failed:', e.message));
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
    if (!token || !owner || !repo) return false;
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
    } catch (e) {
        console.error(`❌ GitHub save error:`, e.message);
        return false;
    }
}

async function showAccessControlConfig(interaction, guildId) {
    const embed = new EmbedBuilder()
        .setColor('#5865F2').setTitle('🔒 Access Configuration')
        .setDescription('Select which role should have access to moderation commands:\n\n**Commands affected:**\n• `/warn` `/unwarn` `/config` `/viewconfig`\n• `/accessconfig` `/warnlist` `/history` `/escalation`\n\n**Note:** Server administrators always have access.')
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

// Supports: m:s | h:m:s | d:h:m:s | "forever"
function parseDuration(durationStr) {
    if (durationStr.toLowerCase() === 'forever') return { days: 0, hours: 0, minutes: 0, seconds: 0, totalMs: null, isForever: true };
    const parts = durationStr.split(':').map(p => {
        const n = parseInt(p.trim());
        return (n < 0 || n > 9999) ? NaN : n;
    });
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

async function handleWarningExpiry(warningKey, guildId, userId, roleId, channelId) {
    const w = activeWarnings[warningKey];
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const member = await guild.members.fetch(userId).catch(() => null);
        const role = guild.roles.cache.get(roleId);
        if (member && role && member.roles.cache.has(roleId)) {
            await member.roles.remove(role);
            const channel = guild.channels.cache.get(channelId);
            if (channel) await channel.send({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Warning Expired').setDescription(`<@${userId}>'s warning has expired and the role has been removed.`).setTimestamp()] });
        }
    } catch (error) {
        console.error(`Failed to remove role: ${error}`);
        try {
            const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
            if (channel) await channel.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('❌ Warning Removal Failed').setDescription(`Could not remove role from <@${userId}>. Check bot permissions and role hierarchy.`).addFields({ name: 'Error', value: error.message || 'Unknown error' }).setTimestamp()] });
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

// Core warn logic — used by /warn and auto-escalation
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
        ).setFooter({ text: `Use /timeleft in ${guild.name} to check when this warning expires` }).setTimestamp()]
    }).catch(() => {});

    const baseEntry = { guildId, userId: user.id, userTag: user.tag, roleId: role.id, roleName: role.name, level, reason, issuedBy: issuedByTag, issuedAt: Date.now() };

    if (!config.isForever) {
        const warningKey = `${guildId}-${user.id}-${level}-${Date.now()}`;
        const expiresAt = Date.now() + config.durationMs;
        activeWarnings[warningKey] = { ...baseEntry, expiresAt, channelId, isForever: false };
        saveWarnings();
        scheduleWarningRemoval(warningKey, guildId, user.id, role.id, expiresAt, channelId);
    } else {
        addHistory(guildId, { ...baseEntry, expiresAt: null, isForever: true, endedAt: null, endReason: null });
    }

    return { success: true, role, config };
}

// Check escalation after a manual warn — auto-applies next level if threshold is hit
// Returns an object describing what happened (for followUp messages)
async function checkEscalation(guild, member, user, guildId, level, channelId, issuedByTag) {
    const esc = guildConfigs[guildId].escalation ?? {};
    const threshold = esc.thresholds?.[level];
    if (!threshold) return null;

    warnCounts[guildId] ??= {};
    warnCounts[guildId][user.id] ??= {};
    const count = (warnCounts[guildId][user.id][level] = (warnCounts[guildId][user.id][level] || 0) + 1);
    saveCounts();

    if (count < threshold) return { counted: true, count, threshold };

    // Threshold hit — reset and try to escalate
    warnCounts[guildId][user.id][level] = 0;
    saveCounts();

    const nextLevel = level + 1;
    const cap = esc.cap;

    if (cap && nextLevel > cap) return { atCap: true, cap };

    if (!guildConfigs[guildId].levels[nextLevel]) return { noNextLevel: true, nextLevel };

    const result = await applyWarning(guild, member, user, guildId, nextLevel, `Auto-escalated from Level ${level}`, channelId, issuedByTag);
    if (result.error) return { escalationError: result.error };

    const hitCap = cap && nextLevel === cap;
    return { escalated: true, nextLevel, role: result.role, config: result.config, hitCap };
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
            .addStringOption(o => o.setName('reason').setDescription('Reason for the warning')),
        new SlashCommandBuilder().setName('unwarn').setDescription('Manually remove a warning role from a user')
            .addUserOption(o => o.setName('user').setDescription('User to remove warning from').setRequired(true))
            .addIntegerOption(o => o.setName('level').setDescription('Warning level to remove').setRequired(true)),
        new SlashCommandBuilder().setName('config').setDescription('Configure warning levels')
            .addIntegerOption(o => o.setName('level').setDescription('What level (1, 2, 3, etc.)').setRequired(true))
            .addRoleOption(o => o.setName('role').setDescription('Which role to assign').setRequired(true))
            .addStringOption(o => o.setName('duration').setDescription('d:h:m:s or "forever"').setRequired(true)),
        new SlashCommandBuilder().setName('viewconfig').setDescription('View current warning configuration'),
        new SlashCommandBuilder().setName('accessconfig').setDescription('Configure which role can access moderation commands'),
        new SlashCommandBuilder().setName('timeleft').setDescription('Check how much time is left on your warnings'),
        new SlashCommandBuilder().setName('warnlist').setDescription('View all active warnings in this server'),
        new SlashCommandBuilder().setName('history').setDescription('View warning history for a user')
            .addUserOption(o => o.setName('user').setDescription('User to look up').setRequired(true)),
        new SlashCommandBuilder().setName('escalation').setDescription('Configure auto-escalation rules')
            .addSubcommand(s => s.setName('set').setDescription('Set threshold: how many level-N warns trigger escalation to level N+1')
                .addIntegerOption(o => o.setName('level').setDescription('Warning level to set threshold for').setRequired(true))
                .addIntegerOption(o => o.setName('threshold').setDescription('Number of warnings needed to escalate').setRequired(true)))
            .addSubcommand(s => s.setName('remove').setDescription('Remove escalation threshold for a level')
                .addIntegerOption(o => o.setName('level').setDescription('Warning level').setRequired(true)))
            .addSubcommand(s => s.setName('setcap').setDescription('Set a maximum warning level (escalation stops here)')
                .addIntegerOption(o => o.setName('level').setDescription('Cap level').setRequired(true)))
            .addSubcommand(s => s.setName('removecap').setDescription('Remove the level cap'))
            .addSubcommand(s => s.setName('view').setDescription('View current escalation configuration'))
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
                .setDescription(`${inviterId ? `<@${inviterId}>, please` : 'An administrator should'} run \`/accessconfig\` to set up command permissions.\n\n**Quick Start:**\n1. Run \`/accessconfig\` to choose which role can use moderation commands\n2. Run \`/config\` to set up warning levels\n3. Start using \`/warn\` to moderate your server!`)
                .setFooter({ text: 'Use /accessconfig to configure role-based access control' });
            await guild.systemChannel.send({ embeds: [embed] }).catch(e => console.log(`⚠️ Could not send setup message: ${e.message}`));
        }
    } catch (e) { console.error('Error in guildCreate:', e); }
});

// Reapply active warnings to users who left and rejoined
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
        if (!selectedRole) return interaction.reply({ content: '❌ No role selected. Please try again.', flags: [MessageFlags.Ephemeral] });
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
        console.log(`🔒 Access role set to ${selectedRole.name} in ${interaction.guild.name}`);
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId } = interaction;
    if (!interaction.guild) return interaction.reply({ content: '❌ This command can only be used in a server.', flags: [MessageFlags.Ephemeral] });

    guildConfigs[guildId] ??= { levels: {} };

    const restrictedCommands = ['config', 'warn', 'unwarn', 'viewconfig', 'accessconfig', 'warnlist', 'history', 'escalation'];
    if (restrictedCommands.includes(commandName) && !hasCommandPermission(interaction, guildId)) {
        const accessRole = guildConfigs[guildId]?.accessRoleId;
        return interaction.reply({
            content: `❌ You don't have permission to use this command.\n\n**Required:** Administrator permission OR ${accessRole ? `<@&${accessRole}>` : 'not configured'}\n\nAsk a server administrator to run \`/accessconfig\` to set up command access.`,
            ephemeral: true
        });
    }

    if (commandName === 'accessconfig') {
        await showAccessControlConfig(interaction, guildId);
    }

    else if (commandName === 'config') {
        const level = interaction.options.getInteger('level');
        const role = interaction.options.getRole('role');
        const durationStr = interaction.options.getString('duration');

        if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });

        const duration = parseDuration(durationStr);
        if (!duration) return interaction.reply({
            content: '❌ Invalid duration format. Use:\n• `m:s` (e.g. `30:0` = 30 minutes)\n• `h:m:s` (e.g. `1:30:0` = 1 hour 30 minutes)\n• `d:h:m:s` (e.g. `2:1:30:0` = 2 days 1 hour 30 minutes)\n• `forever` (permanent warning)\n\n**Note:** Maximum duration is 365 days.',
            flags: [MessageFlags.Ephemeral]
        });

        guildConfigs[guildId].levels[level] = {
            roleId: role.id, roleName: role.name,
            durationMs: duration.totalMs, isForever: duration.isForever,
            durationDisplay: formatDuration(duration.days, duration.hours, duration.minutes, duration.seconds, duration.isForever)
        };
        saveConfigs();
        console.log(`🔒 [AUDIT] ${interaction.user.tag} configured warning level ${level} with role ${role.name} in ${interaction.guild.name}`);

        await interaction.reply({
            embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('🚨 Warning Configuration Updated')
                .addFields(
                    { name: 'Level', value: `${level}`, inline: true },
                    { name: 'Role', value: `${role}`, inline: true },
                    { name: 'Duration', value: formatDuration(duration.days, duration.hours, duration.minutes, duration.seconds, duration.isForever), inline: true }
                ).setTimestamp()],
            ephemeral: true
        });
    }

    else if (commandName === 'warn') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const level = interaction.options.getInteger('level');
        const reason = (interaction.options.getString('reason') || 'No reason provided').slice(0, 1000).replace(/[\x00-\x1F\x7F]/g, '');

        if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
        if (!member) return interaction.reply({ content: `❌ ${user} is not in this server.`, flags: [MessageFlags.Ephemeral] });
        if (!guildConfigs[guildId].levels[level]) return interaction.reply({ content: `❌ Warning level ${level} is not configured. Use /config to set it up.`, flags: [MessageFlags.Ephemeral] });

        const botMember = interaction.guild.members.me;
        const configRole = interaction.guild.roles.cache.get(guildConfigs[guildId].levels[level].roleId);
        if (!configRole) return interaction.reply({ content: '❌ Configured role not found. Please update the configuration.', flags: [MessageFlags.Ephemeral] });
        if (configRole.position >= botMember.roles.highest.position) return interaction.reply({ content: `❌ I cannot manage the ${configRole} role. My highest role must be **above** the warning role.\n\n**Fix:** Drag my role higher than ${configRole} in Server Settings → Roles.`, flags: [MessageFlags.Ephemeral] });
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: '❌ I don\'t have the "Manage Roles" permission.', flags: [MessageFlags.Ephemeral] });

        try {
            const result = await applyWarning(interaction.guild, member, user, guildId, level, reason, interaction.channel.id, interaction.user.tag);
            if (result.error) return interaction.reply({ content: `❌ ${result.error}`, flags: [MessageFlags.Ephemeral] });

            console.log(`🔒 [AUDIT] ${interaction.user.tag} warned ${user.tag} (Level ${level}) in ${interaction.guild.name} - Reason: ${reason.slice(0, 100)}`);

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

            // Notify if this is already the cap level
            const cap = guildConfigs[guildId].escalation?.cap;
            if (cap && level === cap) {
                await interaction.followUp({ content: `🚨 ${user} has been warned at the cap level (Level ${cap}). No further auto-escalation is possible.`, flags: [MessageFlags.Ephemeral] });
            }

            // Check escalation
            const esc = await checkEscalation(interaction.guild, member, user, guildId, level, interaction.channel.id, interaction.user.tag);
            if (esc?.escalated) {
                await interaction.followUp({ content: `⬆️ ${user} has been auto-escalated to **Level ${esc.nextLevel}** (${esc.role}) after hitting the threshold.${esc.hitCap ? `\n🚨 They've now reached the cap (Level ${esc.hitCap ?? esc.nextLevel}).` : ''}`, flags: [MessageFlags.Ephemeral] });
            } else if (esc?.atCap) {
                await interaction.followUp({ content: `🚨 ${user} has hit the escalation threshold for Level ${level}, but cannot be escalated past the cap (Level ${esc.cap}).`, flags: [MessageFlags.Ephemeral] });
            } else if (esc?.noNextLevel) {
                await interaction.followUp({ content: `ℹ️ Escalation threshold hit for Level ${level}, but Level ${esc.nextLevel} is not configured.`, flags: [MessageFlags.Ephemeral] });
            } else if (esc?.counted) {
                await interaction.followUp({ content: `📊 Escalation: ${esc.count}/${esc.threshold} warnings at Level ${level}.`, flags: [MessageFlags.Ephemeral] });
            }

        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ Failed to assign warning. Make sure the bot has proper permissions.', flags: [MessageFlags.Ephemeral] });
        }
    }

    else if (commandName === 'viewconfig') {
        const config = guildConfigs[guildId];
        if (!config || Object.keys(config.levels).length === 0) return interaction.reply({ content: '📋 No warning levels configured yet. Use /config to set them up.', flags: [MessageFlags.Ephemeral] });
        const embed = new EmbedBuilder().setColor('#0099ff').setTitle('🚨 Police Bot Configuration').setDescription('Current warning level settings:').setTimestamp();
        for (const [level, data] of Object.entries(config.levels)) {
            embed.addFields({ name: `Level ${level}`, value: `Role: <@&${data.roleId}>\nDuration: ${data.durationDisplay}`, inline: true });
        }
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    else if (commandName === 'unwarn') {
        const user = interaction.options.getUser('user');
        const member = interaction.guild.members.cache.get(user.id);
        const level = interaction.options.getInteger('level');

        if (level < 1 || level > 100) return interaction.reply({ content: '❌ Warning level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
        if (!member) return interaction.reply({ content: `❌ ${user} is not in this server.`, flags: [MessageFlags.Ephemeral] });
        if (!guildConfigs[guildId].levels[level]) return interaction.reply({ content: `❌ Warning level ${level} is not configured.`, flags: [MessageFlags.Ephemeral] });

        const config = guildConfigs[guildId].levels[level];
        const role = interaction.guild.roles.cache.get(config.roleId);
        if (!role) return interaction.reply({ content: '❌ Configured role not found.', flags: [MessageFlags.Ephemeral] });
        if (!member.roles.cache.has(role.id)) return interaction.reply({ content: `❌ ${user} doesn't have the ${role} role.`, flags: [MessageFlags.Ephemeral] });

        try {
            await member.roles.remove(role);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} unwarned ${user.tag} (Level ${level}) in ${interaction.guild.name}`);

            const warningKeys = Object.keys(activeWarnings).filter(key => {
                const w = activeWarnings[key];
                return w.userId === user.id && w.guildId === guildId && w.level === level;
            });
            warningKeys.forEach(key => {
                addHistory(guildId, { ...activeWarnings[key], endedAt: Date.now(), endReason: 'manual' });
                clearTimeout(warningTimers.get(key));
                warningTimers.delete(key);
                delete activeWarnings[key];
            });
            if (warningKeys.length > 0) saveWarnings();

            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Warning Removed')
                .addFields(
                    { name: 'User', value: `${user}`, inline: true },
                    { name: 'Level', value: `${level}`, inline: true },
                    { name: 'Role', value: `${role}`, inline: true },
                    { name: 'Removed by', value: `${interaction.user}` }
                ).setTimestamp()]
            });
        } catch (error) {
            console.error(error);
            await interaction.reply({ content: '❌ Failed to remove warning. Make sure the bot has proper permissions.', flags: [MessageFlags.Ephemeral] });
        }
    }

    else if (commandName === 'timeleft') {
        const userId = interaction.user.id;
        const userWarnings = Object.entries(activeWarnings).filter(([, w]) => w.guildId === guildId && w.userId === userId);
        if (userWarnings.length === 0) return interaction.reply({ content: '✅ You have no active warnings!', flags: [MessageFlags.Ephemeral] });

        const embed = new EmbedBuilder().setColor('#FFA500').setTitle('⏰ Your Active Warnings')
            .setDescription(`You currently have ${userWarnings.length} active warning${userWarnings.length > 1 ? 's' : ''}:`)
            .setFooter({ text: 'Warnings are automatically removed when they expire' })
            .setTimestamp();

        for (const [, warning] of userWarnings) {
            const config = guildConfigs[guildId]?.levels[warning.level];
            const fieldName = `Level ${warning.level} - ${config?.roleName || 'Unknown Role'}`;
            if (config?.isForever) {
                embed.addFields({ name: fieldName, value: '⏳ **Duration:** Forever\n🔒 **Status:** Permanent (use `/unwarn` to remove)' });
            } else {
                const timeLeft = warning.expiresAt - Date.now();
                if (timeLeft <= 0) {
                    embed.addFields({ name: fieldName, value: '⏳ **Time Left:** Expired (will be removed shortly)' });
                } else {
                    const s = Math.floor(timeLeft / 1000);
                    embed.addFields({ name: fieldName, value: `⏳ **Time Left:** ${formatDuration(Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60)}\n📅 **Expires:** <t:${Math.floor(warning.expiresAt / 1000)}:F>` });
                }
            }
        }
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    else if (commandName === 'warnlist') {
        const guildWarnings = Object.values(activeWarnings).filter(w => w.guildId === guildId);
        if (!guildWarnings.length) return interaction.reply({ content: '✅ No active warnings in this server.', flags: [MessageFlags.Ephemeral] });

        const embed = new EmbedBuilder().setColor('#FFA500').setTitle(`⚠️ Active Warnings (${guildWarnings.length})`).setTimestamp();

        const byUser = {};
        for (const w of guildWarnings) { byUser[w.userId] ??= []; byUser[w.userId].push(w); }
        for (const [userId, warnings] of Object.entries(byUser)) {
            embed.addFields({ name: `<@${userId}>`, value: warnings.map(w => `• Level ${w.level} — ${w.isForever ? 'Permanent' : `expires <t:${Math.floor(w.expiresAt / 1000)}:R>`}`).join('\n') });
            if (embed.data.fields.length >= 25) break;
        }
        if (Object.keys(byUser).length > 25) embed.setFooter({ text: `Showing first 25 users of ${Object.keys(byUser).length} total` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
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
            embed.addFields({
                name: `Level ${e.level} — ${e.roleName} — <t:${Math.floor(e.issuedAt / 1000)}:d>`,
                value: `${status} • by ${e.issuedBy}\n${e.reason}`
            });
        }
        if (entries.length > 10) embed.setFooter({ text: `Showing last 10 of ${entries.length} entries` });

        await interaction.reply({ embeds: [embed], ephemeral: true });
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
            await interaction.reply({ content: `✅ Escalation set: **${threshold}** Level ${level} warnings → auto Level ${level + 1}.`, flags: [MessageFlags.Ephemeral] });
        }

        else if (sub === 'remove') {
            const level = interaction.options.getInteger('level');
            if (!esc.thresholds[level]) return interaction.reply({ content: `❌ No escalation threshold set for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
            delete esc.thresholds[level];
            saveConfigs();
            await interaction.reply({ content: `✅ Removed escalation threshold for Level ${level}.`, flags: [MessageFlags.Ephemeral] });
        }

        else if (sub === 'setcap') {
            const level = interaction.options.getInteger('level');
            if (level < 1 || level > 100) return interaction.reply({ content: '❌ Cap level must be between 1 and 100.', flags: [MessageFlags.Ephemeral] });
            esc.cap = level;
            saveConfigs();
            await interaction.reply({ content: `✅ Level cap set to **${level}**. Escalation will not go beyond this level.`, flags: [MessageFlags.Ephemeral] });
        }

        else if (sub === 'removecap') {
            if (!esc.cap) return interaction.reply({ content: '❌ No level cap is currently set.', flags: [MessageFlags.Ephemeral] });
            delete esc.cap;
            saveConfigs();
            await interaction.reply({ content: '✅ Level cap removed. Escalation is now uncapped.', flags: [MessageFlags.Ephemeral] });
        }

        else if (sub === 'view') {
            const embed = new EmbedBuilder().setColor('#5865F2').setTitle('⬆️ Escalation Configuration').setTimestamp();
            const thresholds = esc.thresholds ?? {};

            if (Object.keys(thresholds).length === 0 && !esc.cap) {
                embed.setDescription('No escalation rules configured.\nUse `/escalation set` to add thresholds.');
            } else {
                if (Object.keys(thresholds).length > 0) {
                    embed.addFields({ name: 'Thresholds', value: Object.entries(thresholds).sort(([a], [b]) => a - b).map(([lvl, t]) => `• **${t}x** Level ${lvl} → auto Level ${parseInt(lvl) + 1}`).join('\n') });
                }
                embed.addFields({ name: 'Level Cap', value: esc.cap ? `Level **${esc.cap}** (escalation stops here)` : 'None (uncapped)' });
            }

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    const ok = req.url === '/' || req.url === '/health';
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(ok ? 'Police bot is running!' : 'Not found');
});
server.listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT}`));

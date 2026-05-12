const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, RoleSelectMenuBuilder, ActivityType, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const configPath = path.join(__dirname, 'config.json');
const warningsPath = path.join(__dirname, 'warnings.json');

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

let guildConfigs = loadJSON(configPath, 'config.json', {});
let activeWarnings = loadJSON(warningsPath, 'warnings.json', {});

function saveConfigs() {
    fs.writeFileSync(configPath, JSON.stringify(guildConfigs, null, 2));
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

function saveWarnings() {
    fs.writeFileSync(warningsPath, JSON.stringify(activeWarnings, null, 2));
    saveFileToGitHub(warningsPath, 'warnings.json', 'Auto-save: Update warnings.json').catch(e => console.error('Warning GitHub save failed:', e.message));
}

async function showAccessControlConfig(interaction, guildId) {
    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🔒 Access Configuration')
        .setDescription('Select which role should have access to moderation commands:\n\n**Commands affected:**\n• `/warn` - Give warnings to users\n• `/unwarn` - Remove warnings from users\n• `/config` - Configure warning levels\n• `/viewconfig` - View warning configuration\n• `/accessconfig` - Change access control settings\n\n**Note:** Server administrators always have access to all commands.')
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
    warningTimers.delete(warningKey);
    delete activeWarnings[warningKey];
    saveWarnings();
}

async function scheduleWarningRemoval(warningKey, guildId, userId, roleId, expiresAt, channelId) {
    const timeLeft = expiresAt - Date.now();
    if (timeLeft <= 0) return handleWarningExpiry(warningKey, guildId, userId, roleId, channelId);
    warningTimers.set(warningKey, setTimeout(() => handleWarningExpiry(warningKey, guildId, userId, roleId, channelId), timeLeft));
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
        new SlashCommandBuilder().setName('timeleft').setDescription('Check how much time is left on your warnings')
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
        await saveFileToGitHub(configPath, 'config.json', 'Auto-save: Update config.json from Discord bot');
        await interaction.update({
            embeds: [new EmbedBuilder().setColor('#00ff00').setTitle('✅ Access Control Updated')
                .setDescription(`Members with the ${selectedRole} role can now use moderation commands.\n\n**Affected commands:**\n• \`/warn\`\n• \`/unwarn\`\n• \`/config\`\n• \`/viewconfig\`\n• \`/accessconfig\`\n\n*Server administrators always have access.*`)
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

    const restrictedCommands = ['config', 'warn', 'unwarn', 'viewconfig', 'accessconfig'];
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
        saveFileToGitHub(configPath, 'config.json', 'Auto-save: Update config.json from Discord bot');
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

        const config = guildConfigs[guildId].levels[level];
        const role = interaction.guild.roles.cache.get(config.roleId);
        if (!role) return interaction.reply({ content: '❌ Configured role not found. Please update the configuration.', flags: [MessageFlags.Ephemeral] });

        const botMember = interaction.guild.members.me;
        if (role.position >= botMember.roles.highest.position) return interaction.reply({ content: `❌ I cannot manage the ${role} role. My highest role must be **above** the warning role.\n\n**Fix:** Drag my role higher than ${role} in Server Settings → Roles.`, flags: [MessageFlags.Ephemeral] });
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: '❌ I don\'t have the "Manage Roles" permission.', flags: [MessageFlags.Ephemeral] });

        try {
            await member.roles.add(role);
            console.log(`🔒 [AUDIT] ${interaction.user.tag} warned ${user.tag} (Level ${level}) in ${interaction.guild.name} - Reason: ${reason.slice(0, 100)}`);

            user.send({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ You Received a Warning')
                .setDescription(`You have been warned in **${interaction.guild.name}**.`)
                .addFields(
                    { name: 'Warning Level', value: `${level}`, inline: true },
                    { name: 'Duration', value: config.durationDisplay || 'Unknown', inline: true },
                    { name: 'Reason', value: reason }
                ).setFooter({ text: `Use /timeleft in ${interaction.guild.name} to check when this warning expires` }).setTimestamp()]
            }).catch(e => console.log(`⚠️ Could not DM ${user.tag}: ${e.message}`));

            await interaction.reply({ embeds: [new EmbedBuilder().setColor('#ff0000').setTitle('⚠️ Warning Issued')
                .addFields(
                    { name: 'User', value: `${user}`, inline: true },
                    { name: 'Level', value: `${level}`, inline: true },
                    { name: 'Role', value: `${role}`, inline: true },
                    { name: 'Duration', value: config.durationDisplay || 'Unknown', inline: true },
                    { name: 'Reason', value: reason },
                    { name: 'Issued by', value: `${interaction.user}` }
                ).setTimestamp()]
            });

            if (!config.isForever) {
                const warningKey = `${guildId}-${user.id}-${level}-${Date.now()}`;
                const expiresAt = Date.now() + config.durationMs;
                activeWarnings[warningKey] = { guildId, userId: user.id, roleId: role.id, level, expiresAt, channelId: interaction.channel.id };
                saveWarnings();
                scheduleWarningRemoval(warningKey, guildId, user.id, role.id, expiresAt, interaction.channel.id);
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
            warningKeys.forEach(key => { clearTimeout(warningTimers.get(key)); warningTimers.delete(key); delete activeWarnings[key]; });
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
                    const timeDisplay = formatDuration(Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60);
                    embed.addFields({ name: fieldName, value: `⏳ **Time Left:** ${timeDisplay}\n📅 **Expires:** <t:${Math.floor(warning.expiresAt / 1000)}:F>` });
                }
            }
        }
        await interaction.reply({ embeds: [embed], ephemeral: true });
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

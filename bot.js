require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// Store user sessions
const userSessions = new Map();
let standupConfig = {
    hour: 10,
    minute: 0,
    cronSchedule: '0 10 * * *',
    enabled: false, // Start disabled until configured
    testMode: false,
    testUsers: []
};

// Load config from file
if (fs.existsSync('./standup-config.json')) {
    standupConfig = JSON.parse(fs.readFileSync('./standup-config.json', 'utf8'));
}

const QUESTIONS = [
    {
        number: 1,
        text: "**What did you do yesterday?**",
        key: "yesterday"
    },
    {
        number: 2,
        text: "**What are you planning to do today?**",
        key: "today"
    },
    {
        number: 3,
        text: "**Anything blocking your progress?**",
        key: "blockers"
    }
];

function saveConfig() {
    fs.writeFileSync('./standup-config.json', JSON.stringify(standupConfig, null, 2));
}

let currentJob = null;

function updateCronJob() {
    if (currentJob) {
        currentJob.stop();
    }

    if (standupConfig.enabled && !standupConfig.testMode) {
        currentJob = cron.schedule(standupConfig.cronSchedule, async () => {
            console.log("🚀 Starting scheduled standup...");
            await startStandup();
        });
        console.log(`✅ Standup scheduled at ${standupConfig.hour}:${standupConfig.minute.toString().padStart(2, '0')}`);
    } else if (standupConfig.testMode) {
        console.log("🧪 Test mode enabled - automatic standups disabled");
    } else {
        console.log("⏸️ Standup is disabled");
    }
}

async function getTargetUsers() {
    try {
        // Test mode: return only test users
        if (standupConfig.testMode && standupConfig.testUsers.length > 0) {
            const testMembers = [];
            for (const userId of standupConfig.testUsers) {
                try {
                    const member = await client.guilds.fetch(process.env.GUILD_ID)
                        .then(guild => guild.members.fetch(userId));
                    if (member) {
                        testMembers.push(member);
                        console.log(`✅ Added test user: ${member.user.tag}`);
                    }
                } catch (err) {
                    console.log(`❌ Could not fetch test user ${userId}: ${err.message}`);
                }
            }
            return testMembers;
        }

        // Production mode: get users with specific role
        if (!process.env.ROLE_ID) {
            console.log("⚠️ No ROLE_ID set in .env");
            return [];
        }

        const guild = await client.guilds.fetch(process.env.GUILD_ID);
        const roleId = process.env.ROLE_ID;
        const members = await guild.members.fetch();

        const targetUsers = [];
        for (const [id, member] of members) {
            if (!member.user.bot && member.roles.cache.has(roleId)) {
                targetUsers.push(member);
            }
        }

        console.log(`Found ${targetUsers.length} users with role`);
        return targetUsers;
    } catch (error) {
        console.error("Error fetching members:", error);
        return [];
    }
}

async function startStandup() {
    console.log("🚀 Starting standup...");

    const channel = await client.channels.fetch(process.env.CHANNEL_ID);
    const targetUsers = await getTargetUsers();
    const standupDate = new Date().toISOString().split('T')[0];

    if (targetUsers.length === 0) {
        console.log("⚠️ No target users found");
        await channel.send("⚠️ No users found for standup! " +
            (standupConfig.testMode ? "Add test users with `!test-add @user`" : "Make sure users have the configured role"));
        return;
    }

    await channel.send(`🚀 **Standup Started!** ${standupConfig.testMode ? ' (TEST MODE)' : ''}\n📊 Targeting ${targetUsers.length} users`);

    // Initialize sessions and send DMs
    let sentCount = 0;
    for (const member of targetUsers) {
        userSessions.set(member.id, {
            step: 0,
            answers: {},
            standupDate: standupDate,
            username: member.user.username
        });

        try {
            await member.send("🌅 **Daily Standup Time!** 🌅\n\nPlease answer the following questions:\n\n" + QUESTIONS[0].text);
            console.log(`✅ Sent questions to ${member.user.tag}`);
            sentCount++;
        } catch (err) {
            console.log(`❌ Cannot DM ${member.user.tag}: ${err.message}`);
            userSessions.delete(member.id);
        }
    }

    await channel.send(`📨 Sent standup questions to ${sentCount}/${targetUsers.length} users`);

    // Set timeout for responses
    const timeoutDuration = standupConfig.testMode ? 60 * 1000 : 2 * 60 * 60 * 1000; // 1 min test, 2 hours production
    const timeoutMessage = standupConfig.testMode ? "1 minute" : "2 hours";

    await channel.send(`⏰ Waiting for responses (${timeoutMessage})...`);

    setTimeout(async () => {
        await generateReport(channel, standupDate, targetUsers);
    }, timeoutDuration);
}

async function generateReport(channel, standupDate, targetUsers) {
    let report = `📢 **Daily Standup Report**\n📅 ${standupDate}\n`;
    report += standupConfig.testMode ? `🔧 **TEST MODE** 🔧\n\n` : `\n`;
    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    let submittedCount = 0;
    const missingList = [];
    const partialList = [];

    for (const member of targetUsers) {
        const session = userSessions.get(member.id);

        if (session && session.standupDate === standupDate) {
            const answerCount = Object.keys(session.answers).length;

            if (answerCount === 3) {
                submittedCount++;
                report += `✅ **${session.username}**\n`;
                report += `└  **Yesterday:** ${session.answers.yesterday}\n`;
                report += `└  **Today:** ${session.answers.today}\n`;
                report += `└  **Blockers:** ${session.answers.blockers === '.' ? 'None' : session.answers.blockers}\n\n`;
            } else if (answerCount > 0) {
                partialList.push({ username: session.username, answers: answerCount });
            } else {
                missingList.push(member.user.username);
            }
        } else {
            missingList.push(member.user.username);
        }
    }

    if (partialList.length > 0) {
        report += `⚠️ **Partially Submitted**\n`;
        for (const user of partialList) {
            report += `└ ${user.username} (${user.answers}/3 answers)\n`;
        }
        report += `\n`;
    }

    if (missingList.length > 0) {
        report += `❌ **Did Not Submit**\n`;
        for (const username of missingList) {
            report += `└ ${username}\n`;
        }
        report += `\n`;
    }

    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    report += `📊 **Summary:** ${submittedCount}/${targetUsers.length} completed`;
    if (partialList.length > 0) report += ` | ${partialList.length} partial`;
    if (missingList.length > 0) report += ` | ${missingList.length} missing`;

    await channel.send(report);
    console.log("📊 Report generated and sent");

    // Clean up old sessions
    for (const [userId, session] of userSessions.entries()) {
        if (session.standupDate !== standupDate) {
            userSessions.delete(userId);
        }
    }
}

// Handle DM responses for standup
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // Handle DM responses
    if (message.channel.type === 1) {
        const session = userSessions.get(message.author.id);
        if (!session) return;

        const currentStep = session.step;
        if (currentStep >= QUESTIONS.length) return;

        // Validate blockers answer
        if (currentStep === 2 && message.content.trim() === "") {
            await message.reply("⚠️ Please provide an answer. If no blockers, send a '.' (dot)");
            return;
        }

        // Save answer
        session.answers[QUESTIONS[currentStep].key] = message.content;

        if (currentStep + 1 < QUESTIONS.length) {
            session.step = currentStep + 1;
            userSessions.set(message.author.id, session);
            await message.reply(`✅ Got it!\n\n**Question ${currentStep + 2}/3:**\n${QUESTIONS[currentStep + 1].text}`);
        } else {
            await message.reply("🎉 **Thank you! Your standup has been submitted!** 🎉\n\nYour responses have been recorded.");
            console.log(`✅ ${message.author.tag} completed standup`);
        }
        return;
    }

    // Handle commands in any channel
    if (message.content.startsWith('!')) {
        const args = message.content.split(' ');
        const command = args[0].toLowerCase();

        // === TEST COMMANDS ===
        if (command === '!ping') {
            await message.reply('🏓 Pong! Bot is active!');
        }

        if (command === '!test-mode') {
            standupConfig.testMode = !standupConfig.testMode;
            if (!standupConfig.testMode) {
                standupConfig.testUsers = [];
            }
            saveConfig();
            updateCronJob();
            await message.reply(`${standupConfig.testMode ? '🧪 **Test Mode ENABLED**' : '✅ **Test Mode DISABLED**'}\n${standupConfig.testMode ? 'Use !test-add @user to add test users' : 'Returned to normal operation'}`);
        }

        if (command === '!test-add' && args[1]) {
            if (!standupConfig.testMode) {
                await message.reply("⚠️ Enable test mode first: `!test-mode`");
                return;
            }
            const userId = args[1].replace(/[<@!>]/g, '');
            if (!standupConfig.testUsers.includes(userId)) {
                standupConfig.testUsers.push(userId);
                saveConfig();
                try {
                    const user = await client.users.fetch(userId);
                    await message.reply(`✅ Added **${user.tag}** to test users`);
                } catch {
                    await message.reply(`✅ Added user to test list`);
                }
            } else {
                await message.reply("⚠️ User already in test list");
            }
        }

        if (command === '!test-remove' && args[1]) {
            const userId = args[1].replace(/[<@!>]/g, '');
            const index = standupConfig.testUsers.indexOf(userId);
            if (index > -1) {
                standupConfig.testUsers.splice(index, 1);
                saveConfig();
                await message.reply(`✅ Removed user from test list`);
            } else {
                await message.reply("⚠️ User not found in test list");
            }
        }

        if (command === '!test-list') {
            if (!standupConfig.testMode) {
                await message.reply("⚠️ Test mode is disabled");
                return;
            }
            if (standupConfig.testUsers.length === 0) {
                await message.reply("📋 No test users added. Use `!test-add @user`");
            } else {
                let list = "🧪 **Test Users:**\n";
                for (const userId of standupConfig.testUsers) {
                    try {
                        const user = await client.users.fetch(userId);
                        list += `└ ✅ ${user.tag}\n`;
                    } catch {
                        list += `└ ✅ ${userId}\n`;
                    }
                }
                await message.reply(list);
            }
        }

        if (command === '!test-start') {
            if (!standupConfig.testMode) {
                await message.reply("⚠️ Enable test mode first: `!test-mode`");
            } else if (standupConfig.testUsers.length === 0) {
                await message.reply("⚠️ Add test users first: `!test-add @user`");
            } else {
                await message.reply("🧪 **Starting test standup...**\n⏰ You have 1 minute to complete the questions in DMs");
                await startStandup();
            }
        }

        if (command === '!test-reset') {
            userSessions.clear();
            await message.reply("🔄 Reset all active standup sessions");
        }

        // === PRODUCTION COMMANDS ===
        if (command === '!set-time' && args.length === 3) {
            const hour = parseInt(args[1]);
            const minute = parseInt(args[2]);

            if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
                await message.reply("❌ Invalid time! Use: `!set-time HH MM` (24-hour format)\nExample: `!set-time 14 30` for 2:30 PM");
            } else {
                standupConfig.hour = hour;
                standupConfig.minute = minute;
                standupConfig.cronSchedule = `${minute} ${hour} * * *`;
                saveConfig();
                updateCronJob();
                await message.reply(`✅ Standup scheduled for **${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}** daily`);
            }
        }

        if (command === '!enable') {
            if (standupConfig.testMode) {
                await message.reply("⚠️ Disable test mode first: `!test-mode`");
            } else {
                standupConfig.enabled = true;
                saveConfig();
                updateCronJob();
                await message.reply("✅ **Standup reminders ENABLED**\nThe bot will now DM users at the scheduled time");
            }
        }

        if (command === '!disable') {
            standupConfig.enabled = false;
            saveConfig();
            updateCronJob();
            await message.reply("⏸️ **Standup reminders DISABLED**");
        }

        if (command === '!force-start') {
            if (standupConfig.testMode) {
                await message.reply("⚠️ Disable test mode first: `!test-mode`");
            } else {
                await message.reply("🚀 **Force starting standup...**\n⏰ Responses will be collected for 2 hours");
                await startStandup();
            }
        }

        if (command === '!status') {
            const status = standupConfig.enabled ? "🟢 ENABLED" : "🔴 DISABLED";
            const mode = standupConfig.testMode ? "🧪 TEST MODE" : "⚙️ PRODUCTION";
            const time = `${standupConfig.hour.toString().padStart(2, '0')}:${standupConfig.minute.toString().padStart(2, '0')}`;

            let message = `**📊 Standup Bot Status**\n\n`;
            message += `└ Mode: ${mode}\n`;
            message += `└ Status: ${status}\n`;
            message += `└ Time: ${time}\n`;

            if (standupConfig.testMode) {
                message += `└ Test Users: ${standupConfig.testUsers.length}\n`;
            } else {
                message += `└ Role ID: ${process.env.ROLE_ID || 'Not set'}\n`;
            }

            message += `└ Report Channel: ${process.env.CHANNEL_ID || 'Not set'}\n`;

            await message.reply(message);
        }

        if (command === '!help') {
            await message.reply(`
**🤖 Standup Bot Commands**

**🧪 Testing Commands:**
\`!test-mode\` - Toggle test mode on/off
\`!test-add @user\` - Add user to test list
\`!test-remove @user\` - Remove user from test list
\`!test-list\` - Show test users
\`!test-start\` - Start test standup (1 min timeout)
\`!test-reset\` - Reset all active sessions

**⚙️ Setup Commands:**
\`!set-time HH MM\` - Set daily standup time (24h)
\`!enable\` - Enable automatic standup
\`!disable\` - Disable automatic standup
\`!force-start\` - Manually start standup

**ℹ️ Info Commands:**
\`!status\` - Show bot status and settings
\`!ping\` - Check if bot is alive
\`!help\` - Show this help message

**📝 Quick Test:**
1. \`!test-mode\`
2. \`!test-add @yourname\`
3. \`!test-start\`
4. Answer DMs
5. Check report after 1 minute
            `);
        }
    }
});

client.once('ready', async () => {
    console.log(`\n✅ Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.first();
    if (guild) {
        console.log(`📡 Server: ${guild.name}`);
        const botMember = guild.members.cache.get(client.user.id);
        console.log(`🤖 Bot Role: ${botMember.roles.cache.map(r => r.name).join(', ')}`);
    }

    updateCronJob();

    console.log(`\n📊 Bot Configuration:`);
    console.log(`└ Test Mode: ${standupConfig.testMode ? 'ON' : 'OFF'}`);
    console.log(`└ Standup Time: ${standupConfig.hour}:${standupConfig.minute}`);
    console.log(`└ Auto Standup: ${standupConfig.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`\n💡 Type !help in Discord for commands\n`);
});

client.login(process.env.DISCORD_TOKEN);
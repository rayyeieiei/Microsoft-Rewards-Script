import { Client, GatewayIntentBits, Message, EmbedBuilder } from 'discord.js';
import type { MicrosoftRewardsBot } from './index';
import axios from 'axios';
import os from 'os';


export class DiscordCommander {
    private client: Client;
    private bot: MicrosoftRewardsBot;

    // ⚠️ PASTE TOKEN BARU LU DI SINI (YANG TADI UDAH BOCOR BRE, RESET LAGI!)
    private token = 'MTUxNDE3NDA0OTc5MjU1NzE2MQ.GBoS5y.Szwzv2AXJgJ1shLU4vZ5lmvDzyWkTxJba_eY5A'; 

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot;
        
        // Inisialisasi Bot dengan izin membaca pesan
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent 
            ]
        });

        this.setupListeners();
        this.start();
    }

    private setupListeners() {
        // Event pas bot berhasil hidup
        this.client.on('clientReady', () => {
            this.bot.logger.info(false, 'DISCORD-BOT', `🤖 Nexus Commander Online as ${this.client.user?.tag}`, 'green');
        });

        // Event pas ada chat masuk
        this.client.on('messageCreate', (message: Message) => {
            // Abaikan chat dari bot lain biar gak infinite loop
            if (message.author.bot) return;

            // Bikin command gak sensitif huruf besar/kecil dan rapihin spasi
            const args = message.content.trim().toLowerCase().split(/ +/);
            const command = args[0];

            // 🎛️ SWITCH COMMAND ROUTER
            switch (command) {
                case '!help':
                    this.handleHelpCommand(message);
                    break;
                case '!poin':
                    this.handlePoinCommand(message);
                    break;
                case '!status':
                    this.handleStatusCommand(message);
                    break;
                case '!ip':
                    this.handleIpCommand(message);
                    break;
                case '!stop':
                    this.handleStopCommand(message);
                    break;
            }
        });
    }

    // ==========================================
    // 🛠️ KUMPULAN FUNGSI COMMAND LU DI SINI
    // ==========================================

    private async handleHelpCommand(message: Message) {
        // Pake fitur EmbedBuilder biar pesannya di dalam kotak warna warni
        const embed = new EmbedBuilder()
            .setColor('#00ffea') // Warna Cyan khas Nexus
            .setTitle('🤖 NEXUS COMMANDER PANEL')
            .setDescription('Daftar command rahasia buat ngontrol mesin lu dari jarak jauh:')
            .addFields(
                { name: '💰 `!poin`', value: 'Cek laporan perolehan poin dari semua akun.' },
                { name: '📊 `!status`', value: 'Cek sisa RAM PC, status mode, dan uptime bot.' },
                { name: '🌐 `!ip`', value: 'Lacak IP Publik mesin sekarang (Cek rotasi ADB).' },
                { name: '🛑 `!stop`', value: 'EMERGENCY: Matikan mesin paksa dari Discord.' }
            )
            .setFooter({ text: 'Nexus.io Enterprise Automation' })
            .setTimestamp();

        message.reply({ embeds: [embed] });
    }

    private async handlePoinCommand(message: Message) {
        const loadingMsg = await message.reply('⏳ *Bentar bre, lagi narik data dari mesin Nexus...*');

        try {
            let totalAll = 0;
            let replyMsg = `📊 **REPORT POIN SEMENTARA NEXUS.IO** 📊\n\n`;

            const accounts = this.bot.accounts; 

            if (!accounts || accounts.length === 0) {
                await loadingMsg.edit('Data akun masih kosong atau belum di-load sama mesin bro!');
                return;
            }

            for (const acc of accounts) {
                const safeEmail = acc.email.replace(/(.{3})(.*)(?=@)/, '$1***');
                const currentPoin = (acc as any).currentPoints || 0; 
                
                replyMsg += `👤 **${safeEmail}** : ${currentPoin} Poin\n`;
                totalAll += currentPoin;
            }

            replyMsg += `\n💎 **TOTAL KESELURUHAN:** ${totalAll} Poin`;
            await loadingMsg.edit(replyMsg);

        } catch (error) {
            await message.reply(`🚨 Waduh, gagal narik data: ${error}`);
        }
    }

    private async handleStatusCommand(message: Message) {
        const loadingMsg = await message.reply('⏳ *Melakukan diagnosa mesin...*');

        // Tarik data RAM dan Uptime dari OS PC lu
        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
        const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
        
        // Konversi detik ke jam dan menit
        const uptimeSeconds = process.uptime();
        const uptimeHours = Math.floor(uptimeSeconds / 3600);
        const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);

        const accountsCount = this.bot.accounts ? this.bot.accounts.length : 0;
        
        // Ngebaca settingan lu lagi mode kantor (LAN) atau mode rumah (ADB)
        const mode = this.bot.config?.isOfficeMode ? '🏢 KANTOR (Manual IP)' : '🏠 RUMAH (Auto ADB IP)';

        const statusMsg = `🖥️ **DIAGNOSA MESIN NEXUS** 🖥️\n\n` +
                          `**👥 Total Akun:** ${accountsCount} Akun ter-load\n` +
                          `**⚙️ Mode Jaringan:** ${mode}\n` +
                          `**⏱️ Uptime Bot:** ${uptimeHours} Jam ${uptimeMinutes} Menit\n` +
                          `**🧠 Sisa RAM PC:** ${freeMem} GB / ${totalMem} GB\n`;

        await loadingMsg.edit(statusMsg);
    }

    private async handleIpCommand(message: Message) {
        const loadingMsg = await message.reply('⏳ *Melacak IP mesin ke server luar...*');
        try {
            // Nembak ke API gratis buat ngecek IP Publik lu
            const res = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
            await loadingMsg.edit(`🌐 **IP PUBLIC MESIN SEKARANG:** \`${res.data.ip}\`\n\n*(Gunakan command ini sesudah ADB Restart buat mastiin IP lu berubah!)*`);
        } catch (error) {
            await loadingMsg.edit(`🚨 **Gagal melacak IP:** Jaringan lagi sibuk/down bre.`);
        }
    }

    private async handleStopCommand(message: Message) {
        await message.reply('🛑 **EMERGENCY STOP DITERIMA!** Mematikan mesin Nexus dalam 3 detik...');
        
        // Ngirim log warna merah ke terminal PC lu
        this.bot.logger.warn('main', 'DISCORD-CMD', '🚨 EMERGENCY STOP DIAKTIFKAN VIA DISCORD! 🚨', 'red');

        // Tunggu 3 detik biar Discord sempat kirim pesan balasannya, baru mesinnya bunuh diri
        setTimeout(() => {
            process.exit(1);
        }, 3000);
    }

    // ==========================================

    public start() {
        this.client.login(this.token).catch(err => {
            this.bot.logger.error(false, 'DISCORD-BOT', `Gagal login Discord Bot: ${err.message}`);
        });
    }
}
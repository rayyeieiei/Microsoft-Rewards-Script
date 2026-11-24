import { exec } from 'child_process';
import { broadcastC2Log } from './DashboardServer';

const execAsync = (cmd: string): Promise<{ stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
        exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
};

export class AirplaneMode {

    private static log(msg: string, isError = false): void {
        if (isError) {
            console.error(msg);
        } else {
            console.log(msg);
        }
        try {
            broadcastC2Log(msg);
        } catch {}
    }

    private static async wait(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public static async checkIP(): Promise<string> {
        try {
            const response = await fetch('https://api.ipify.org?format=json');
            const data: any = await response.json();
            return data?.ip || 'Gagal_Cek_IP';
        } catch (error) {
            return 'Gagal_Cek_IP';
        }
    }

    /**
     * Memeriksa ketersediaan dan status device ADB dengan deteksi unauthorized, offline, dan auto-reconnect retry
     */
    public static async checkDevice(serial?: string): Promise<{ ready: boolean; reason?: string; deviceCount: number }> {
        const adbPrefix = serial ? `adb -s ${serial}` : 'adb';

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                // Jika serial adalah alamat IP:port (Wireless ADB), coba sambungkan otomatis jika belum tersambung
                if (serial && serial.includes(':') && attempt === 1) {
                    await execAsync(`adb connect ${serial}`).catch(() => {});
                }

                const { stdout } = await execAsync(`${adbPrefix} devices`);
                const lines = stdout.trim().split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean);

                // 1. Cek device aktif (authorized & ready)
                const readyDevices = lines.filter(l => l.includes('\tdevice') || l.endsWith(' device'));
                if (readyDevices.length > 0) {
                    return { ready: true, deviceCount: readyDevices.length };
                }

                // 2. Cek apakah ada device unauthorized (butuh konfirmasi di layar HP)
                const unauthorizedDevices = lines.filter(l => l.includes('unauthorized'));
                if (unauthorizedDevices.length > 0) {
                    this.log(`⚠️  [ADB-AUTH] Device terdeteksi tetapi BELUM DIIZINKAN (unauthorized)! Buka layar HP dan centang 'Selalu izinkan' lalu klik IZINKAN (ALLOW).`, true);
                    return { ready: false, reason: 'device-unauthorized', deviceCount: unauthorizedDevices.length };
                }

                // 3. Cek apakah device berstatus offline
                const offlineDevices = lines.filter(l => l.includes('offline'));
                if (offlineDevices.length > 0) {
                    this.log(`⚠️  [ADB-OFFLINE] Device terdeteksi tetapi berstatus OFFLINE. Mencoba reconnect...`);
                    await execAsync(`${adbPrefix} reconnect`).catch(() => {});
                }

                // Jika percobaan pertama belum menemukan device, coba reconnect dan beri jeda 1.5 detik
                if (attempt === 1) {
                    await execAsync(`${adbPrefix} reconnect`).catch(() => {});
                    await this.wait(1500);
                }
            } catch (err: any) {
                return { ready: false, reason: 'adb-unavailable', deviceCount: 0 };
            }
        }

        return { ready: false, reason: 'device-not-found', deviceCount: 0 };
    }

    /**
     * Eksekusi Rotasi IP via USB Tethering (Paling Stabil & Anti-Bentrok)
     */
    public static async toggle(delayBetweenMs = 8000, postDelayMs = 15000, serial?: string): Promise<boolean> {
        try {
            const adbPrefix = serial ? `adb -s ${serial}` : 'adb';

            // 0. Preflight check: Pastikan device terdeteksi
            const devCheck = await this.checkDevice(serial);
            if (!devCheck.ready) {
                this.log(`🚨  [ADB-ERROR] Device ADB tidak terdeteksi (${devCheck.reason}). deviceCount=${devCheck.deviceCount}`, true);
                return false;
            }

            this.log('\n🔍  [ADB-NETWORK] Mengecek IP (Jalur USB Tethering)...');
            const ipSebelum = await this.checkIP();
            this.log(`🌍  [ADB-NETWORK] IP Lama kamu: [ ${ipSebelum} ]`);

            this.log('\n✈️  [ADB-NETWORK] Menyalakan Airplane Mode (Membunuh sinyal data)...');

            // 1. Coba cmd connectivity (Android 11+ AOSP)
            let airplaneActivated = false;
            try {
                const out: any = await execAsync(`${adbPrefix} shell cmd connectivity airplane-mode enable`);
                const outStr = (typeof out?.stdout === 'string' ? out.stdout : '').toLowerCase();
                if (!outStr.includes('unknown') &&
                    !outStr.includes('error') &&
                    !outStr.includes('no shell command') &&
                    !outStr.includes('can\'t find service') &&
                    !outStr.includes('permission')) {
                    try {
                        const state: any = await execAsync(`${adbPrefix} shell settings get global airplane_mode_on`);
                        if (typeof state?.stdout === 'string' && state.stdout.trim() === '1') {
                            airplaneActivated = true;
                        }
                    } catch {}
                }
            } catch {}

            // 2. Fallback: Settings put global 1 + am broadcast (Universal Android)
            if (!airplaneActivated) {
                try {
                    await execAsync(`${adbPrefix} shell settings put global airplane_mode_on 1`).catch(() => {});
                    await execAsync(`${adbPrefix} shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true`).catch(() => {});
                } catch {}
            }

            // 3. Fallback jika device memiliki akses root (su)
            try {
                await execAsync(`${adbPrefix} shell su -c "cmd connectivity airplane-mode enable || (settings put global airplane_mode_on 1 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true)"`).catch(() => {});
            } catch {}

            // 4. Force cut radio data (svc data disable) agar koneksi BTS seluler pasti terputus
            try {
                await execAsync(`${adbPrefix} shell svc data disable`).catch(() => {});
            } catch {}

            this.log(`⏳  [ADB-NETWORK] Nunggu ${delayBetweenMs / 1000} detik biar IP provider keriset...`);
            await this.wait(delayBetweenMs);

            this.log('📶  [ADB-NETWORK] Mematikan Airplane Mode (Mencari sinyal 4G/5G baru)...');

            // 1. Coba cmd connectivity disable
            try {
                await execAsync(`${adbPrefix} shell cmd connectivity airplane-mode disable`).catch(() => {});
            } catch {}

            // 2. Settings put global 0 + am broadcast
            try {
                await execAsync(`${adbPrefix} shell settings put global airplane_mode_on 0`).catch(() => {});
                await execAsync(`${adbPrefix} shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false`).catch(() => {});
            } catch {}

            // 3. Fallback root (su) disable
            try {
                await execAsync(`${adbPrefix} shell su -c "cmd connectivity airplane-mode disable || (settings put global airplane_mode_on 0 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false)"`).catch(() => {});
            } catch {}

            // 4. Nyalakan kembali radio data seluler
            try {
                await execAsync(`${adbPrefix} shell svc data enable`).catch(() => {});
            } catch {}

            this.log(`⏳  [ADB-NETWORK] Nunggu 8 detik biar sinyal radio HP stabil...`);
            await this.wait(8000);

            this.log('🔌  [ADB-NETWORK] Memastikan USB Tethering tetap menyala...');
            // Ada dua command sakti, kita tembak dua-duanya biar Samsung/Xiaomi/Oppo/Vivo nurut
            await execAsync(`${adbPrefix} shell cmd tethering tether usb`).catch(() => {});
            await execAsync(`${adbPrefix} shell svc usb setFunctions rndis,adb`).catch(() => {});
            await execAsync(`${adbPrefix} shell svc usb setFunctions rndis`).catch(() => {});

            this.log(`⏳  [ADB-NETWORK] Nunggu ${postDelayMs / 1000} detik biar PC Windows ngebaca jaringan USB...`);
            await this.wait(postDelayMs);

            this.log('\n🔍  [ADB-NETWORK] Mengecek IP setelah rotasi...');
            const ipSesudah = await this.checkIP();
            this.log(`🌍  [ADB-NETWORK] IP Baru kamu: [ ${ipSesudah} ]`);

            if (ipSebelum !== ipSesudah && ipSesudah !== 'Gagal_Cek_IP') {
                this.log('\n✅  [ADB-NETWORK] SUCCESS! IP berhasil rotasi via USB Kabel! Koneksi dewa!\n');
                return true;
            } else if (ipSebelum === ipSesudah) {
                this.log('\n⚠️  [ADB-NETWORK] WARNING: IP kamu masih sama! Provider masih menahan sesi IP.\n');
                return false;
            } else {
                this.log('\n❌  [ADB-NETWORK] ERROR: Gagal cek IP. Pastikan saklar USB Tethering di HP kamu nyala.\n');
                return false;
            }
        } catch (error) {
            this.log(`🚨  [ADB-ERROR] Waduh, gagal ngeksekusi command ADB: ${error instanceof Error ? error.message : String(error)}`, true);
            return false;
        }
    }

    /**
     * Mematikan USB Tethering di HP Android secara aman via ADB.
     * Mengembalikan fungsi USB ke MTP standar agar PC Windows langsung memutus koneksi kartu jaringan virtual RNDIS.
     */
    public static async disableUsbTethering(serial?: string): Promise<boolean> {
        const adbPrefix = serial ? `adb -s ${serial}` : 'adb';
        this.log('\n🛑  [ADB-NETWORK] Mematikan USB Tethering di HP Android agar kuota tidak bocor...');
        try {
            // Preflight check device
            const devCheck = await this.checkDevice(serial);
            if (!devCheck.ready) {
                this.log(`⚠️  [ADB-NETWORK] Tidak dapat mematikan USB Tethering: Device ADB tidak terdeteksi (${devCheck.reason}).`);
                return false;
            }

            // 1. Android 11+ AOSP untether command
            try {
                await execAsync(`${adbPrefix} shell cmd tethering untether usb`).catch(() => {});
            } catch {}

            // 2. Kembalikan fungsi USB ke MTP dengan tetap mempertahankan interface ADB (mtp,adb)
            try {
                await execAsync(`${adbPrefix} shell svc usb setFunctions mtp,adb`).catch(() => {});
            } catch {}

            // 3. Fallback su / root jika diperlukan
            try {
                await execAsync(`${adbPrefix} shell su -c "cmd tethering untether usb || svc usb setFunctions mtp,adb"`).catch(() => {});
            } catch {}

            this.log('✅  [ADB-NETWORK] USB Tethering berhasil dimatikan. Laptop berhenti menyedot kuota seluler HP!\n');
            return true;
        } catch (error) {
            this.log(`⚠️  [ADB-NETWORK] Gagal mematikan USB Tethering via ADB: ${error instanceof Error ? error.message : String(error)}`, true);
            return false;
        }
    }

    /**
     * Menyalakan kembali USB Tethering di HP Android via ADB
     */
    public static async enableUsbTethering(serial?: string): Promise<boolean> {
        const adbPrefix = serial ? `adb -s ${serial}` : 'adb';
        this.log('🔌  [ADB-NETWORK] Memastikan USB Tethering aktif di HP Android...');
        try {
            const devCheck = await this.checkDevice(serial);
            if (!devCheck.ready) {
                this.log(`⚠️  [ADB-NETWORK] Device ADB tidak terdeteksi (${devCheck.reason}).`);
                return false;
            }
            await execAsync(`${adbPrefix} shell cmd tethering tether usb`).catch(() => {});
            await execAsync(`${adbPrefix} shell svc usb setFunctions rndis,adb`).catch(() => {});
            await execAsync(`${adbPrefix} shell svc usb setFunctions rndis`).catch(() => {});
            return true;
        } catch (error) {
            this.log(`⚠️  [ADB-NETWORK] Gagal mengaktifkan USB Tethering: ${error instanceof Error ? error.message : String(error)}`, true);
            return false;
        }
    }
}

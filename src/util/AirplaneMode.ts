import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class AirplaneMode {

    private static async wait(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public static async checkIP(): Promise<string> {
        try {
            const response = await fetch('https://api.ipify.org?format=json');
            const data = await response.json();
            return data.ip;
        } catch (error) {
            return 'Gagal_Cek_IP';
        }
    }

    /**
     * Eksekusi Rotasi IP via USB Tethering (Paling Stabil & Anti-Bentrok)
     */
    public static async toggle(delayBetweenMs = 8000, postDelayMs = 15000): Promise<boolean> {
        try {
            console.log('\n🔍  [ADB-NETWORK] Mengecek IP (Jalur USB Tethering)...');
            const ipSebelum = await this.checkIP();
            console.log(`🌍  [ADB-NETWORK] IP Lama kamu: [ ${ipSebelum} ]`);

            console.log('\n✈️  [ADB-NETWORK] Menyalakan Airplane Mode (Membunuh sinyal data)...');

            // 1. Coba cmd connectivity (Android 11+ AOSP)
            let airplaneActivated = false;
            try {
                const out: any = await execAsync('adb shell cmd connectivity airplane-mode enable');
                const outStr = (typeof out?.stdout === 'string' ? out.stdout : '').toLowerCase();
                if (!outStr.includes('unknown') &&
                    !outStr.includes('error') &&
                    !outStr.includes('no shell command') &&
                    !outStr.includes('can\'t find service') &&
                    !outStr.includes('permission')) {
                    try {
                        const state: any = await execAsync('adb shell settings get global airplane_mode_on');
                        if (typeof state?.stdout === 'string' && state.stdout.trim() === '1') {
                            airplaneActivated = true;
                        }
                    } catch {}
                }
            } catch {}

            // 2. Fallback: Settings put global 1 + am broadcast (Universal Android)
            if (!airplaneActivated) {
                try {
                    await execAsync('adb shell settings put global airplane_mode_on 1').catch(() => {});
                    await execAsync('adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true').catch(() => {});
                } catch {}
            }

            // 3. Fallback jika device memiliki akses root (su)
            try {
                await execAsync('adb shell su -c "cmd connectivity airplane-mode enable || (settings put global airplane_mode_on 1 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true)"').catch(() => {});
            } catch {}

            // 4. Force cut radio data (svc data disable) agar koneksi BTS seluler pasti terputus
            try {
                await execAsync('adb shell svc data disable').catch(() => {});
            } catch {}

            console.log(`⏳  [ADB-NETWORK] Nunggu ${delayBetweenMs / 1000} detik biar IP provider keriset...`);
            await this.wait(delayBetweenMs);

            console.log('📶  [ADB-NETWORK] Mematikan Airplane Mode (Mencari sinyal 4G/5G baru)...');

            // 1. Coba cmd connectivity disable
            try {
                await execAsync('adb shell cmd connectivity airplane-mode disable').catch(() => {});
            } catch {}

            // 2. Settings put global 0 + am broadcast
            try {
                await execAsync('adb shell settings put global airplane_mode_on 0').catch(() => {});
                await execAsync('adb shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false').catch(() => {});
            } catch {}

            // 3. Fallback root (su) disable
            try {
                await execAsync('adb shell su -c "cmd connectivity airplane-mode disable || (settings put global airplane_mode_on 0 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false)"').catch(() => {});
            } catch {}

            // 4. Nyalakan kembali radio data seluler
            try {
                await execAsync('adb shell svc data enable').catch(() => {});
            } catch {}

            console.log(`⏳  [ADB-NETWORK] Nunggu 8 detik biar sinyal radio HP stabil...`);
            await this.wait(8000);

            console.log('🔌  [ADB-NETWORK] Memastikan USB Tethering tetap menyala...');
            // Ada dua command sakti, kita tembak dua-duanya biar Samsung/Xiaomi/Oppo/Vivo nurut
            await execAsync('adb shell cmd tethering tether usb').catch(() => {});
            await execAsync('adb shell svc usb setFunctions rndis').catch(() => {});

            console.log(`⏳  [ADB-NETWORK] Nunggu ${postDelayMs / 1000} detik biar PC Windows ngebaca jaringan USB...`);
            await this.wait(postDelayMs);

            console.log('\n🔍  [ADB-NETWORK] Mengecek IP setelah rotasi...');
            const ipSesudah = await this.checkIP();
            console.log(`🌍  [ADB-NETWORK] IP Baru kamu: [ ${ipSesudah} ]`);

            if (ipSebelum !== ipSesudah && ipSesudah !== 'Gagal_Cek_IP') {
                console.log('\n✅  [ADB-NETWORK] SUCCESS! IP berhasil rotasi via USB Kabel! Koneksi dewa!\n');
            } else if (ipSebelum === ipSesudah) {
                console.log('\n⚠️  [ADB-NETWORK] WARNING: IP kamu masih sama! Provider masih menahan sesi IP.\n');
            } else {
                console.log('\n❌  [ADB-NETWORK] ERROR: Gagal cek IP. Pastikan saklar USB Tethering di HP kamu nyala.\n');
            }

            return true;
        } catch (error) {
            console.error('🚨  [ADB-ERROR] Waduh, gagal ngeksekusi command ADB:', error);
            return false;
        }
    }
}
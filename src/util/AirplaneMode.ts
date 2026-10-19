import { exec } from 'child_process'
import { promisify } from 'util'
import dns from 'dns'
import { broadcastC2Log } from './DashboardServer'

const execAsync = promisify(exec)

function logAdb(msg: string) {
    console.log(msg)
    broadcastC2Log(msg)
}

function errorAdb(msg: string, ...args: any[]) {
    console.error(msg, ...args)
    const extra = args.length > 0 ? ' ' + args.map(a => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : String(a))).join(' ') : ''
    broadcastC2Log(`${msg}${extra}`)
}

export class AirplaneMode {
    private static async wait(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Resolves public IP using multi-provider HTTP fallback (ipify, icanhazip, ident.me, aws).
     */
    public static async checkIP(): Promise<string> {
        const ipProviders = [
            'https://api.ipify.org',
            'https://icanhazip.com',
            'https://ident.me',
            'https://checkip.amazonaws.com'
        ]
        const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$|^([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}$/

        for (const provider of ipProviders) {
            try {
                const response = await fetch(provider, { signal: AbortSignal.timeout(5000) })
                const text = (await response.text()).trim()
                if (text && ipRegex.test(text)) {
                    return text
                }
            } catch {
                // Fallback to next provider
            }
        }
        return 'Gagal_Cek_IP'
    }

    /**
     * Eksekusi Rotasi IP via USB Tethering dengan native Linux ADB execution
     */
    public static async toggle(
        delayBetweenMs = 8000,
        postDelayMs = 15000,
        adbSerial?: string
    ): Promise<boolean> {
        const adbPrefix = adbSerial ? `adb -s ${adbSerial}` : 'adb'

        try {
            logAdb('\n🔍  [ADB-NETWORK] Mengecek IP (Jalur USB Tethering)...')
            const ipSebelum = await this.checkIP()
            logAdb(`🌍  [ADB-NETWORK] IP Lama kamu: [ ${ipSebelum} ]`)

            logAdb('\n✈️  [ADB-NETWORK] Menyalakan Airplane Mode (Membunuh sinyal data)...')

            // 1. Coba cmd connectivity (Android 11+ AOSP)
            let airplaneActivated = false
            try {
                const out: any = await execAsync(`${adbPrefix} shell cmd connectivity airplane-mode enable`)
                const outStr = (typeof out?.stdout === 'string' ? out.stdout : '').toLowerCase()
                if (
                    !outStr.includes('unknown') &&
                    !outStr.includes('error') &&
                    !outStr.includes('no shell command') &&
                    !outStr.includes("can't find service") &&
                    !outStr.includes('permission')
                ) {
                    try {
                        const state: any = await execAsync(`${adbPrefix} shell settings get global airplane_mode_on`)
                        if (typeof state?.stdout === 'string' && state.stdout.trim() === '1') {
                            airplaneActivated = true
                        }
                    } catch {}
                }
            } catch {}

            // 2. Fallback: Settings put global 1 + am broadcast (Universal Android)
            if (!airplaneActivated) {
                try {
                    await execAsync(`${adbPrefix} shell settings put global airplane_mode_on 1`).catch(() => {})
                    await execAsync(
                        `${adbPrefix} shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true`
                    ).catch(() => {})
                } catch {}
            }

            // 3. Fallback jika device memiliki akses root (su)
            try {
                await execAsync(
                    `${adbPrefix} shell su -c "cmd connectivity airplane-mode enable || (settings put global airplane_mode_on 1 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true)"`
                ).catch(() => {})
            } catch {}

            // 4. Force cut radio data (svc data disable) agar koneksi BTS seluler pasti terputus
            try {
                await execAsync(`${adbPrefix} shell svc data disable`).catch(() => {})
            } catch {}

            logAdb(`⏳  [ADB-NETWORK] Nunggu ${delayBetweenMs / 1000} detik biar IP provider keriset...`)
            await this.wait(delayBetweenMs)

            logAdb('📶  [ADB-NETWORK] Mematikan Airplane Mode (Mencari sinyal 4G/5G baru)...')

            // 1. Coba cmd connectivity disable
            try {
                await execAsync(`${adbPrefix} shell cmd connectivity airplane-mode disable`).catch(() => {})
            } catch {}

            // 2. Settings put global 0 + am broadcast
            try {
                await execAsync(`${adbPrefix} shell settings put global airplane_mode_on 0`).catch(() => {})
                await execAsync(
                    `${adbPrefix} shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false`
                ).catch(() => {})
            } catch {}

            // 3. Fallback root (su) disable
            try {
                await execAsync(
                    `${adbPrefix} shell su -c "cmd connectivity airplane-mode disable || (settings put global airplane_mode_on 0 && am broadcast -a android.intent.action.AIRPLANE_MODE --ez state false)"`
                ).catch(() => {})
            } catch {}

            // 4. Nyalakan kembali radio data seluler
            try {
                await execAsync(`${adbPrefix} shell svc data enable`).catch(() => {})
            } catch {}

            logAdb(`⏳  [ADB-NETWORK] Nunggu 8 detik biar sinyal radio HP stabil...`)
            await this.wait(8000)

            logAdb('🔌  [ADB-NETWORK] Memastikan USB Tethering tetap menyala...')
            await execAsync(`${adbPrefix} shell cmd tethering tether usb`).catch(() => {})
            await execAsync(`${adbPrefix} shell svc usb setFunctions rndis`).catch(() => {})

            logAdb(
                `⏳  [ADB-NETWORK] Nunggu ${postDelayMs / 1000} detik biar interface Linux (usb0 / rndis0) re-binding...`
            )
            await this.wait(postDelayMs)

            logAdb('\n🔍  [ADB-NETWORK] Mengecek IP setelah rotasi...')
            const ipSesudah = await this.checkIP()
            logAdb(`🌍  [ADB-NETWORK] IP Baru kamu: [ ${ipSesudah} ]`)

            if (ipSebelum !== ipSesudah && ipSesudah !== 'Gagal_Cek_IP') {
                logAdb('\n✅  [ADB-NETWORK] SUCCESS! IP berhasil rotasi via USB Kabel! Koneksi dewa!\n')
            } else if (ipSebelum === ipSesudah) {
                logAdb('\n⚠️  [ADB-NETWORK] WARNING: IP kamu masih sama! Provider masih menahan sesi IP.\n')
                process.stdout.write('\x07')
            } else {
                logAdb(
                    '\n❌  [ADB-NETWORK] ERROR: Gagal cek IP. Pastikan saklar USB Tethering di HP kamu nyala.\n'
                )
                process.stdout.write('\x07')
            }

            // DNS Readiness Guard Pasca Rotasi IP ADB: pastikan tabel DNS pulih sebelum melanjutkan ke akun berikutnya
            await this.ensureDnsReady('rewards.bing.com')

            return ipSebelum !== ipSesudah && ipSesudah !== 'Gagal_Cek_IP'
        } catch (error) {
            errorAdb('🚨  [ADB-ERROR] Waduh, gagal ngeksekusi command ADB:', error)
            process.stdout.write('\x07')
            return false
        }
    }

    /**
     * DNS Readiness Guard Pasca Rotasi IP ADB:
     * Memastikan resolver DNS Linux (systemd-resolved / NetworkManager) telah pulih
     * dan dapat me-resolve rewards.bing.com sebelum melanjutkan ke akun berikutnya.
     */
    public static async ensureDnsReady(
        host: string = 'rewards.bing.com',
        maxRetries: number = 5,
        retryDelayMs: number = 1500
    ): Promise<boolean> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await dns.promises.lookup(host)
                logAdb('🌐 [ADB-NETWORK] DNS Resolver Linux aktif & siap digunakan!')
                return true
            } catch {
                if (attempt < maxRetries) {
                    await this.wait(retryDelayMs)
                }
            }
        }
        logAdb(`⚠️ [ADB-NETWORK] DNS Resolver belum merespons untuk ${host} setelah ${maxRetries} percobaan.`)
        return false
    }
}
import type { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { Workers } from '../../Workers'

export class DailyCheckIn extends Workers {
    private oldBalance: number = 0

    public async doDailyCheckIn() {
        // 1. VALIDASI TOKEN (Wajib buat jalur API)
        if (!this.bot.accessToken) {
            this.bot.logger.warn(this.bot.isMobile, 'DAILY-CHECK-IN', 'Skipping: Access token not available.')
            return
        }

        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-CHECK-IN',
            `Starting Daily Check-In Sequence | Balance: ${this.oldBalance}`
        )

        try {
            // STEP 1: JALUR STANDARD (Type 101 & 103)
            let success = await this.runStandardSequence()

            // STEP 2: JALUR STEALTH (Kalau Jalur Standard Gagal dapet poin)
            if (!success) {
                this.bot.logger.info(this.bot.isMobile, 'DAILY-CHECK-IN', 'Standard failed to gain points. Launching Stealth Sapphire Mode...', 'yellow')
                await this.forceAppCheckIn()
            }

            // FINAL SYNC: Cek saldo akhir setelah semua usaha dilakukan
            const finalBalance = await this.bot.browser.func.getCurrentPoints()
            const totalGained = finalBalance - this.oldBalance

            if (totalGained > 0) {
                this.bot.userData.currentPoints = finalBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + totalGained
                this.bot.logger.info(this.bot.isMobile, 'DAILY-CHECK-IN', `GG! Sequence Complete | Total Gained: +${totalGained} | New Balance: ${finalBalance}`, 'green')
                
                if (finalBalance >= 500 && this.oldBalance < 500) {
                    this.bot.logger.info(this.bot.isMobile, 'MAIN', '!!! CONGRATULATIONS: ACCOUNT PROMOTED TO LEVEL 2 !!!', 'green')
                }
            } else {
                this.bot.logger.warn(this.bot.isMobile, 'DAILY-CHECK-IN', 'Sequence finished but balance remains same (Already checked-in manual?)')
            }

        } catch (error: any) {
            this.bot.logger.error(this.bot.isMobile, 'DAILY-CHECK-IN', `Critical Failure: ${error.message}`)
        }
    }

    // Sequence Nyoba 101 dan 103
    private async runStandardSequence(): Promise<boolean> {
        const types = [101, 103]
        for (const type of types) {
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', `Attempting Standard Type: ${type}`)
            const response = await this.submitDaily(type).catch(() => null)
            
            const currentBalance = Number(response?.data?.response?.balance ?? 0)
            if (currentBalance > this.oldBalance) {
                return true
            }
            await this.bot.utils.wait(2000)
        }
        return false
    }

    private async submitDaily(type: number) {
        const jsonData = {
            id: randomUUID(),
            amount: 1,
            type: type,
            attributes: { offerid: 'Gamification_Sapphire_DailyCheckIn' },
            country: this.bot.userData.geoLocale
        }

        const request: AxiosRequestConfig = {
            url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.bot.accessToken}`,
                'User-Agent': 'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2',
                'Content-Type': 'application/json',
                'X-Rewards-Country': this.bot.userData.geoLocale,
                'X-Rewards-Language': 'en',
                'X-Rewards-ismobile': 'true'
            },
            data: JSON.stringify(jsonData)
        }
        return this.bot.axios.request(request)
    }

    // FUNGSI STEALTH: Nyamar jadi Bing App Android (Sapphire API)
    public async forceAppCheckIn() {
        this.bot.logger.info(this.bot.isMobile, 'APP-CHECKIN', 'Injecting Stealth Sapphire Headers...')

        try {
            // Gunakan appToken (fallback ke accessToken jika appToken tidak ada)
            const token = (this.bot.userData as any).appToken || this.bot.accessToken

            const response = await this.bot.axios.request({
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Ms-User-Agent': 'BingSapphire/28.9.411025301 (Android 13; id-ID)',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36'
                },
                data: JSON.stringify({
                    "amount": 1,
                    "country": "id",
                    "id": "daily_checkin", 
                    "type": 101
                })
            })

            if (response.status === 200) {
                this.bot.logger.info(this.bot.isMobile, 'APP-CHECKIN', 'Stealth Packet Sent Successfully!', 'green')
            }

        } catch (error: any) {
            this.bot.logger.debug(this.bot.isMobile, 'APP-CHECKIN', `Stealth attempt finished with status: ${error.response?.status ?? 'Unknown'}`)
        }
    }
}
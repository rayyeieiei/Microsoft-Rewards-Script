import type { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'
import { UserAgentManager } from '../../../browser/UserAgent'

export class DailyCheckIn extends Workers {
    private oldBalance: number = this.bot.userData.currentPoints

    public async doDailyCheckIn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-CHECK-IN',
            `Starting Daily Check-In | geo=${this.bot.userData.geoLocale} | currentPoints=${this.oldBalance}`
        )

        try {
            // Helper to check if already claimed
            const isAlreadyClaimed = (res: any) => {
                if (!res) return false
                const bodyStr = JSON.stringify(res.data || '').toLowerCase()
                return (
                    bodyStr.includes('already') ||
                    bodyStr.includes('duplicate') ||
                    bodyStr.includes('claimed') ||
                    bodyStr.includes('processed') ||
                    bodyStr.includes('completed')
                )
            }

            // 1. Pengecekan status harian sebelum mengirim request via DAPI / Dashboard
            let alreadyClaimedToday = false
            let expectedPoints = 0

            try {
                const dapiRes = await this.bot.axios.request({
                    url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${this.bot.accessToken}`,
                        'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                        'X-Rewards-Country': this.bot.userData.geoLocale || 'US',
                        'X-Rewards-Language': 'en',
                        'X-Rewards-ismobile': 'true'
                    },
                    validateStatus: () => true,
                    timeout: 7000
                })

                // Sinkronisasi saldo jika oldBalance masih 0
                const serverBal = Number(dapiRes.data?.response?.balance ?? 0)
                if (this.oldBalance === 0 && serverBal > 0) {
                    this.oldBalance = serverBal
                    if (!this.bot.userData.currentPoints || this.bot.userData.currentPoints <= 0) {
                        this.bot.userData.currentPoints = serverBal
                    }
                    if (!this.bot.userData.initialPoints || this.bot.userData.initialPoints <= 0) {
                        this.bot.userData.initialPoints = serverBal
                    }
                }

                const promotions: any[] = dapiRes.data?.response?.promotions || []
                const checkInPromo = promotions.find((p: any) =>
                    p?.attributes?.offerid === 'Gamification_Sapphire_DailyCheckIn' ||
                    p?.attributes?.type === 'checkin'
                )

                if (checkInPromo) {
                    const attrs = checkInPromo.attributes || {}
                    const lastUpdated = attrs.last_updated ? new Date(attrs.last_updated) : null
                    const now = new Date()
                    const isClaimedDate = lastUpdated && !isNaN(lastUpdated.getTime()) && (
                        (lastUpdated.getUTCFullYear() === now.getUTCFullYear() &&
                         lastUpdated.getUTCMonth() === now.getUTCMonth() &&
                         lastUpdated.getUTCDate() === now.getUTCDate()) ||
                        (lastUpdated.getFullYear() === now.getFullYear() &&
                         lastUpdated.getMonth() === now.getMonth() &&
                         lastUpdated.getDate() === now.getDate())
                    )
                    const isComplete = attrs.complete === 'true' || attrs.complete === true

                    const progress = parseInt(attrs.progress ?? '0')
                    const checkInDay = (progress % 7) + 1
                    const nextDayKey = `day_${checkInDay}_points`
                    expectedPoints = parseInt(attrs[nextDayKey] ?? '10') || 10

                    if (isClaimedDate || isComplete) {
                        alreadyClaimedToday = true
                    }
                }
            } catch {
                try {
                    const appEarnable = await this.bot.browser.func.getAppEarnablePoints()
                    if (appEarnable) {
                        if (appEarnable.checkIn > 0) {
                            expectedPoints = appEarnable.checkIn
                        } else {
                            alreadyClaimedToday = true
                        }
                    }
                } catch {}
            }

            if (alreadyClaimedToday) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    '[DAILY-CHECK-IN] Daily Check-In untuk hari ini sudah selesai diklaim. Melewati.',
                    'green'
                )
                return
            }

            // Try type 101 first
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', 'Attempting Daily Check-In | type=101')

            let response = await this.submitDaily(101)
            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Received Daily Check-In response | type=101 | status=${response?.status ?? 'unknown'}`
            )

            let isSuccess = response?.status === 200
            let alreadyClaimed = isAlreadyClaimed(response)

            if (!isSuccess && !alreadyClaimed) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Type 101 did not return success status | retryingWithType=103`
                )

                // Fallback to type 103
                response = await this.submitDaily(103)
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Received Daily Check-In response | type=103 | status=${response?.status ?? 'unknown'}`
                )

                isSuccess = response?.status === 200
                alreadyClaimed = isAlreadyClaimed(response)
            }

            if (isSuccess) {
                const rawServerBalance = Number(response?.data?.response?.balance ?? 0)
                let gained = 0

                // Cegah kalkulasi delta balance jika oldBalance === 0:
                // Jika saldo awal 0, perbarui nilai oldBalance dengan respon saldo resmi dari DAPI agar tidak mencatat penambahan poin abnormal
                if (this.oldBalance === 0) {
                    if (rawServerBalance > 0) {
                        gained = expectedPoints > 0 ? expectedPoints : 10
                        this.oldBalance = rawServerBalance
                        if (!this.bot.userData.initialPoints || this.bot.userData.initialPoints <= 0) {
                            this.bot.userData.initialPoints = Math.max(0, rawServerBalance - gained)
                        }
                    } else {
                        gained = expectedPoints > 0 ? expectedPoints : 10
                    }
                } else {
                    gained = rawServerBalance > this.oldBalance
                        ? (rawServerBalance - this.oldBalance)
                        : 0
                }

                if (gained > 0) {
                    const newBal = rawServerBalance > 0 ? rawServerBalance : (this.oldBalance + gained)
                    this.oldBalance = newBal
                    this.bot.userData.currentPoints = newBal
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained

                    void Database.getInstance().recordActivity(
                        this.bot.activeAccount?.email || '',
                        'DAILY_CHECK_IN',
                        gained
                    )

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-CHECK-IN',
                        `Completed Daily Check-In | gainedPoints=+${gained} | oldBalance=${this.oldBalance - gained} | newBalance=${newBal}`,
                        'green'
                    )
                } else {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-CHECK-IN',
                        `[DAILY-CHECK-IN] Daily Check-In terkonfirmasi selesai di server (balance=${this.oldBalance}). Tidak ada penambahan poin baru (sudah diklaim hari ini).`,
                        'green'
                    )
                }
            } else if (alreadyClaimed) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    '[DAILY-CHECK-IN] Daily Check-In untuk hari ini sudah selesai diklaim. Melewati.',
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Daily Check-In finished with status=${response?.status ?? 'unknown'} | currentBalance=${this.oldBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Error during Daily Check-In | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async submitDaily(type: number) {
        try {
            const jsonData = {
                id: randomUUID(),
                amount: 1,
                type: type,
                attributes: {
                    offerid: 'Gamification_Sapphire_DailyCheckIn'
                },
                country: this.bot.userData.geoLocale
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Preparing Daily Check-In payload | type=${type} | id=${jsonData.id} | amount=${jsonData.amount} | country=${jsonData.country}`
            )

            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                    'x-rewards-appid': 'SAAndroid/32.5.431027001',
                    'Content-Type': 'application/json',
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': 'en',
                    'X-Rewards-ismobile': 'true'
                },
                data: JSON.stringify(jsonData),
                validateStatus: () => true
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Sending Daily Check-In request | type=${type} | url=${request.url}`
            )

            return this.bot.axios.request(request)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Error in submitDaily | type=${type} | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}

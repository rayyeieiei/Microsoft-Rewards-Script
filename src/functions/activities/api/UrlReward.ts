import type { BasePromotion, PunchCard } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'
import { Page } from 'patchright'

export class UrlReward extends Workers {
    private cookieHeader: string = ''
    private gainedPoints: number = 0
    private oldBalance: number = 0

    public async doUrlReward(promotion: BasePromotion, page: Page, punchCard?: PunchCard) {
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        
        // LOGIKA BYPASS MODERN UI (HYBRID MODE)
        if (!this.bot.requestToken || this.bot.rewardsVersion === 'modern') {
            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Processing Activity: ${promotion.title} (Hybrid Mode)`)
            
            const temp_page = await page.context().newPage()
            
            // JURUS ANTI-FREEZE 1: Auto-dismiss pop-up dialog yang bikin thread ngebeku
            temp_page.on('dialog', async dialog => {
                this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `Dismissed pop-up dialog: "${dialog.message()}"`);
                await dialog.dismiss().catch(() => {});
            });

            try {
                // FIX RPL: Tambahkan <void> setelah Promise.race biar TypeScript gak bingung nyatuin tipe data
                await Promise.race<void>([
                    (async () => {
                        // 1. NAVIGASI DINAMIS
                        let targetUrl = promotion.offerId.includes('DailySet') ? 'https://rewards.bing.com/dashboard' : 'https://rewards.bing.com/earn'
                        if (punchCard && punchCard.parentPromotion?.destinationUrl) {
                            targetUrl = punchCard.parentPromotion.destinationUrl
                            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Navigating to Punch Card: ${promotion.title}`)
                        }

                        await temp_page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                        
                        // 2. UI PREPARATION (Scroll & Expand)
                        for (let i = 0; i < 2; i++) {
                            await temp_page.mouse.wheel(0, 400).catch(() => {})
                            await this.bot.utils.wait(1000)
                        }

                        await temp_page.evaluate(() => {
                            const buttons = Array.from(document.querySelectorAll('button[aria-expanded="false"], .expansion-button, [data-bi-id*="expand"]'))
                            buttons.forEach((btn: any) => (btn as HTMLElement).click())
                        }).catch(() => {})

                        await this.bot.utils.wait(1500)

                        // 3. PREDATOR SELECTOR
                        const selectors = [
                            `[data-bi-id*="${promotion.offerId}"]`,
                            `a[href*="${promotion.offerId}"]`,
                            `button:has-text("Try creating an image")`,
                            `button:has-text("Define any word in seconds")`,
                            `button:has-text("Find a recipe instantly")`,
                            `button:has-text("Discover your next destination")`,
                            `button:has-text("Explore the latest")`,
                            `button:has-text("Follow the action")`,
                            `div[role="button"]:has-text("${promotion.title.split('?')[0]}")`,
                            `a:has-text("${promotion.title.split('?')[0]}")`,
                            `.p-card button`, 
                            `.promo-tile button`
                        ]

                        let clicked = false
                        for (const sel of selectors) {
                            const el = temp_page.locator(sel).first()
                            if (await el.count() > 0 && await el.isVisible()) {
                                
                                const isTrash = await el.evaluate((node: HTMLElement) => {
                                    const txt = node.innerText.toLowerCase();
                                    return txt.includes('feedback') || txt.includes('suggest') || node.closest('#footer') !== null;
                                }).catch(() => false);

                                if (isTrash) continue; 

                                await el.scrollIntoViewIfNeeded().catch(() => {})
                                await el.evaluate((node: HTMLElement) => {
                                    node.click()
                                    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                                })
                                
                                clicked = true
                                this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Target Hit: ${promotion.title}`, 'green');

                                // 4. DETEKSI KUIS & POLL (RPL AUTO-SCANNER)
                                await this.bot.utils.wait(2000)
                                const hasQuizElements = await temp_page.evaluate(() => {
                                    return document.querySelector('#rqStartQuiz, #rqStartQuizToken, .btOption, #btoption0, .rqOptions') !== null;
                                }).catch(() => false);

                                const isRealQuiz = promotion.pointProgressMax > 5 || hasQuizElements;

                                if (isRealQuiz) {
                                    if (promotion.pointProgressMax <= 5) {
                                        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Detected Poll (+5). Clicking option...`);
                                        await temp_page.evaluate(() => {
                                            const option = document.querySelector('.btOption, #btoption0, .bt_option');
                                            if (option) (option as HTMLElement).click();
                                        }).catch(() => {});
                                        await this.bot.utils.wait(3000);
                                    } else {
                                        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Detected Real Quiz (+${promotion.pointProgressMax}). Solving...`);
                                        await this.bot.activities.doQuiz(promotion, temp_page);
                                    }
                                } else {
                                    this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Standard link. Simulating safe scroll...`);
                                    await temp_page.mouse.wheel(0, 300).catch(() => {});
                                    await this.bot.utils.wait(3000);
                                }
                                break
                            }
                        }

                        if (!clicked) {
                            this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `Selector failed, using direct visit for ${promotion.offerId}`)
                            await temp_page.goto(promotion.destinationUrl, { waitUntil: 'domcontentloaded', referer: targetUrl }).catch(() => {})
                        }
                        
                        const syncTime = promotion.pointProgressMax >= 50 ? 12000 : 6000
                        await this.bot.utils.wait(syncTime)
                    })(),
                    // FIX TIMEOUT VALUE: Set eksplisit tipe data <void> pada instansiasi Promise baru
                    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('WATCHDOG_TIMEOUT')), 60000))
                ]);

                const newBalance = await this.bot.browser.func.getCurrentPoints()
                this.updatePoints(newBalance, promotion.offerId)

            } catch (err: any) {
                if (err?.message === 'WATCHDOG_TIMEOUT') {
                    this.bot.logger.error(this.bot.isMobile, 'URL-REWARD', `Quest stuck detected! Watchdog forced tab closure to save thread execution.`, 'yellow')
                } else {
                    this.bot.logger.error(this.bot.isMobile, 'URL-REWARD', `Process failed | offerId=${promotion.offerId}`)
                }
            } finally {
                await temp_page.close().catch(() => {})
            }
            return
        }

        // LOGIKA STANDAR API (Gak usah diubah)
        try {
            this.cookieHeader = this.bot.browser.func.buildCookieHeader(this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop, ['bing.com', 'live.com', 'microsoftonline.com'])
            const formData = new URLSearchParams({ id: promotion.offerId, hash: promotion.hash, timeZone: '60', activityAmount: '1', __RequestVerificationToken: this.bot.requestToken })
            await this.bot.axios.request({ url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest', method: 'POST', headers: { ...(this.bot.fingerprint?.headers ?? {}), Cookie: this.cookieHeader, Referer: 'https://rewards.bing.com/' }, data: formData })
            const newBalance = await this.bot.browser.func.getCurrentPoints()
            this.updatePoints(newBalance, promotion.offerId)
        } catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'URL-REWARD', `API Error | offerId=${promotion.offerId}`)
        }
    }

    // FIX UTAMA: Menambahkan kembali fungsi updatePoints yang hilang dari deklarasi class
    private updatePoints(newBalance: number, offerId: string) {
        this.gainedPoints = newBalance - this.oldBalance
        if (this.gainedPoints > 0) {
            this.bot.userData.currentPoints = newBalance
            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints
            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Completed | offerId=${offerId} | +${this.gainedPoints} points`, 'green')
        }
    }
}
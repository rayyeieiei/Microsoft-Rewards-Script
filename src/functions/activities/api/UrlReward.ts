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
                // FIX RPL: Tambahkan <void> setelah Promise.race biar TypeScript gak bingung
                await Promise.race<void>([
                    (async () => {
                        // 1. NAVIGASI DINAMIS
                        let targetUrl = 'https://rewards.bing.com/dashboard'
                        const destUrl = (promotion.destinationUrl || '').trim()
                        const offerIdLower = (promotion.offerId || '').toLowerCase()

                        if (punchCard && punchCard.parentPromotion?.destinationUrl) {
                            targetUrl = punchCard.parentPromotion.destinationUrl
                            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Navigating to Punch Card: ${promotion.title}`)
                        } else if (offerIdLower.includes('dailyset')) {
                            // WAJIB: Daily Set selalu dikerjakan di Dashboard Rewards agar Kuis & Poll terselesaikan!
                            targetUrl = 'https://rewards.bing.com/dashboard'
                            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Navigating to Daily Set: "${promotion.title}"`)
                        } else if (destUrl.includes('rewards.bing.com')) {
                            targetUrl = destUrl
                            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Navigating to Rewards URL: "${promotion.title}"`)
                        } else {
                            targetUrl = 'https://rewards.bing.com/dashboard'
                        }

                        await temp_page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                        
                        let clicked = false
                        let isOnCooldown = false

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

                        // 3. PREDATOR SELECTOR DENGAN SCANNER COOLDOWN & PUNCHCARD TARGETING
                        const cleanWords = (promotion.title || '').replace(/[^\w\s]/gi, ' ').split(/\s+/).filter(Boolean)
                        const firstKeywords = cleanWords.slice(0, 4).join(' ')
                        const firstWord = cleanWords[0] || ''

                        const selectors = [
                            `[data-bi-id*="${promotion.offerId}"]`,
                            `a[href*="${promotion.offerId}"]`,
                            `[id*="${promotion.offerId}"]`,
                            `[data-bi-id*="pcchild"]`,
                            `button[id*="pcchild"]`,
                            `a[href*="pcchild"]`,
                            `[id*="pcchild"]`,
                            `div[role="button"]:has-text("${firstKeywords}")`,
                            `button:has-text("${firstKeywords}")`,
                            `a:has-text("${firstKeywords}")`,
                            `div[role="button"]:has-text("${firstWord}")`,
                            `button:has-text("${firstWord}")`,
                            `a:has-text("${firstWord}")`,
                            `.p-card:has-text("${firstWord}") button`,
                            `.p-card:has-text("${firstWord}") a`,
                            `.punchcard:has-text("${firstWord}") button`,
                            `.punchcard:has-text("${firstWord}") a`,
                            `button:has-text("Claim")`,
                            `button:has-text("Klaim")`,
                            `button:has-text("Complete")`,
                            `.p-card button`, 
                            `.promo-tile button`,
                            `.punchcard button`,
                            `.punchcard a`
                        ]

                        for (const sel of selectors) {
                            const elements = temp_page.locator(sel)
                            const count = await elements.count().catch(() => 0)
                            
                            for (let i = 0; i < count; i++) {
                                const el = elements.nth(i)
                                if (await el.isVisible().catch(() => false)) {
                                    
                                    // MATA BATIN: SCAN STATUS TOMBOL (Trash, Cooldown, Completed)
                                    const statusInfo = await el.evaluate((node: HTMLElement) => {
                                        const txt = (node.innerText || '').toLowerCase();
                                        const isTrash = txt.includes('feedback') || txt.includes('suggest') || txt.includes('terms') || node.closest('#footer') !== null;
                                        
                                        // Deteksi 24h Cooldown (Text & Class, BUKAN substring liar di outerHTML)
                                        const isCooldown = txt.includes('come back') || 
                                                           txt.includes('check back') || 
                                                           txt.includes('locked') || 
                                                           node.hasAttribute('disabled') || 
                                                           node.classList.contains('locked') || 
                                                           node.classList.contains('disabled');
                                        
                                        // Deteksi kalau task udah selesai (Checkmark icon / class / aria)
                                        const hasCheckmark = node.querySelector('.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"]') !== null;
                                        const isCompleted = hasCheckmark || 
                                                            node.getAttribute('aria-checked') === 'true' || 
                                                            node.classList.contains('completed') || 
                                                            node.classList.contains('complete') ||
                                                            txt.includes('completed') || 
                                                            txt.includes('selesai');
                                        
                                        return { isTrash, isCooldown, isCompleted };
                                    }).catch(() => ({ isTrash: false, isCooldown: false, isCompleted: false }));

                                    if (statusInfo.isTrash) continue;
                                    if (statusInfo.isCompleted) continue; 
                                    
                                    if (statusInfo.isCooldown) {
                                        isOnCooldown = true;
                                        continue; 
                                    }

                                    await el.scrollIntoViewIfNeeded().catch(() => {})

                                    // Dengarkan jika ada tab baru / popup yang terbuka setelah kartu diklik
                                    const newPagePromise = temp_page.context().waitForEvent('page', { timeout: 3500 }).catch(() => null);

                                    await el.evaluate((node: HTMLElement) => {
                                        node.click()
                                        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                                    }).catch(() => {})
                                    
                                    clicked = true
                                    this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Target Hit: ${promotion.title}`, 'green');

                                    const popupPage = await newPagePromise;
                                    const activeTab = popupPage || temp_page;

                                    await activeTab.waitForLoadState('domcontentloaded').catch(() => {});
                                    await this.bot.utils.wait(2000);

                                    // 4. DETEKSI & SELESAIKAN KUIS / POLL INTERAKTIF
                                    const hasQuizElements = await activeTab.evaluate(() => {
                                        return document.querySelector('#rqStartQuiz, #rqStartQuizToken, .btOption, #btoption0, .rqOptions, .wk_Option, input[value*="Start"]') !== null;
                                    }).catch(() => false);

                                    // Jika ada tombol Start Quiz, klik!
                                    const startQuizBtn = activeTab.locator('#rqStartQuiz, #rqStartQuizToken, input[type="button"][value*="Start"]').first();
                                    if (await startQuizBtn.isVisible().catch(() => false)) {
                                        await startQuizBtn.click({ force: true }).catch(() => {});
                                        await this.bot.utils.wait(2000);
                                    }

                                    // Jika ada opsi jawaban / poll, klik salah satu opsi!
                                    const quizOption = activeTab.locator('.btOption, #btoption0, .rqOptions, .wk_Option, [role="radio"]').first();
                                    if (await quizOption.isVisible().catch(() => false)) {
                                        await quizOption.click({ force: true }).catch(() => {});
                                        await this.bot.utils.wait(2500);
                                    }

                                    const isDailySetOrQuiz = (promotion.offerId ?? '').toLowerCase().includes('dailyset') || (promotion.offerId ?? '').toLowerCase().includes('quiz') || hasQuizElements;

                                    if (isDailySetOrQuiz && promotion.pointProgressMax > 0) {
                                        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Solving Quiz / Daily Set Activity (+${promotion.pointProgressMax})...`);
                                        await this.bot.activities.doQuiz(promotion);
                                    } else {
                                        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Standard link. Simulating safe scroll...`);
                                        await activeTab.mouse.wheel(0, 300).catch(() => {});
                                        await this.bot.utils.wait(3000);
                                    }

                                    if (popupPage && popupPage !== temp_page) {
                                        await popupPage.close().catch(() => {});
                                    }
                                    break // Keluar dari loop pencarian iterasi
                                }
                            }
                            if (clicked) break // Keluar dari loop selector
                        }

                        // JIKA TERNYATA SEMUA TOMBOL LAGI COOLDOWN
                        if (isOnCooldown && !clicked) {
                            this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `Punch Card [${promotion.title}] is on 24h cooldown. Safely skipped.`, 'yellow')
                        } 
                        // JIKA GAGAL NEMU TOMBOL SAMA SEKALI
                        else if (!clicked) {
                            this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `Selector failed, using direct visit for ${promotion.offerId}`)
                            await temp_page.goto(promotion.destinationUrl, { waitUntil: 'domcontentloaded', referer: targetUrl }).catch(() => {})
                            await this.bot.utils.wait(2000)
                            await temp_page.mouse.wheel(0, 400).catch(() => {})
                            await this.bot.utils.wait(2000)
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
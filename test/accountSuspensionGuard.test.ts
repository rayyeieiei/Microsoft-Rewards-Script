import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { AccountSuspendedError } from '../src/interface/Errors'
import {
    checkPageSuspension,
    isSuspensionContent,
    SUSPENSION_PATTERNS,
    SUSPENSION_URL_ROUTES
} from '../src/browser/auth/SuspensionDetector'
import { AccountSessionStore } from '../src/runtime/session/AccountSessionStore'
import { SessionPathResolver } from '../src/runtime/session/SessionPathResolver'
import { MicrosoftRewardsBot } from '../src/index'
import { Workers } from '../src/functions/Workers'
import type { Account } from '../src/interface/Account'

export async function runAccountSuspensionGuardTests() {
    console.log('--- Running Account Suspension & Auto-Quarantine Guard Test Suite ---')

    const testDir = path.resolve(process.cwd(), 'test_sessions_quarantine')
    if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true })
    }
    fs.mkdirSync(testDir, { recursive: true })

    try {
        // Test 1: AccountSuspendedError class structure & properties
        {
            const testEmail = 'marvensdaryan562@outlook.com'
            const error = new AccountSuspendedError(testEmail)
            assert.strictEqual(error.name, 'AccountSuspendedError')
            assert.strictEqual(error.email, testEmail)
            assert.ok(error.message.includes('ACCOUNT-SUSPENDED'))
            assert.ok(error.message.includes(testEmail))
            assert.ok(error instanceof Error)
            assert.ok(error instanceof AccountSuspendedError)
            console.log('✅ Test 1 Passed: AccountSuspendedError structure and inheritance verified')
        }

        // Test 2: Suspension detector identifies suspended URL routes
        {
            for (const route of SUSPENSION_URL_ROUTES) {
                const fullUrl = `https://rewards.bing.com${route}`
                assert.strictEqual(
                    isSuspensionContent('normal text content', fullUrl),
                    true,
                    `Route ${route} must be recognized as suspended URL`
                )
            }
            assert.strictEqual(
                isSuspensionContent('normal text', 'https://rewards.bing.com/dashboard'),
                false,
                'Normal dashboard URL must not be flagged as suspended'
            )
            console.log('✅ Test 2 Passed: Suspended URL route detection verified')
        }

        // Test 3: Suspension detector identifies suspension phrases in DOM text
        {
            const testPhrases = [
                'Your account has been suspended due to violations',
                'Perhatian: Akun Anda telah ditangguhkan oleh sistem',
                'Notice: Account restricted from participating in Microsoft Rewards',
                'Your activity was violating the terms of service agreement'
            ]

            for (const phrase of testPhrases) {
                assert.strictEqual(
                    isSuspensionContent(phrase, 'https://rewards.bing.com/dashboard'),
                    true,
                    `Phrase "${phrase}" must be recognized as suspension text`
                )
            }

            assert.strictEqual(
                isSuspensionContent('Welcome back to Microsoft Rewards! Available points: 1500', 'https://rewards.bing.com/dashboard'),
                false,
                'Normal reward dashboard text must not be flagged as suspended'
            )
            assert.ok(SUSPENSION_PATTERNS.length >= 4, 'Must have at least 4 suspension patterns')
            console.log('✅ Test 3 Passed: Multi-language suspension phrase detection verified')
        }

        // Test 4: Workers suspension checks and DAPI 401/403 correlation
        {
            const mockBot = {
                activeAccount: { email: 'marvensdaryan562@outlook.com' },
                isMobile: true,
                logger: {
                    error: () => {},
                    warn: () => {},
                    info: () => {},
                    debug: () => {}
                }
            } as any
            const workers = new Workers(mockBot)

            // Synthetic page with suspension banner
            const mockSuspendedPage = {
                isClosed: () => false,
                url: () => 'https://rewards.bing.com/error?code=100',
                content: async () => '<html><body>Your account has been suspended</body></html>',
                evaluate: async () => 'Your account has been suspended'
            } as any

            const directCheck = await checkPageSuspension(mockSuspendedPage)
            assert.strictEqual(directCheck.isSuspended, true, 'checkPageSuspension must report suspended')

            let caughtSuspension = false
            try {
                await workers.checkAccountSuspended(mockSuspendedPage, 'marvensdaryan562@outlook.com')
            } catch (err: any) {
                if (err instanceof AccountSuspendedError) {
                    caughtSuspension = true
                }
            }
            assert.strictEqual(caughtSuspension, true, 'Workers.checkAccountSuspended must throw AccountSuspendedError')

            // DAPI 403 error verification with page content check
            let caughtDapiSuspension = false
            try {
                await workers.verifyDapiSuspension(
                    { response: { status: 403 } },
                    mockSuspendedPage,
                    'marvensdaryan562@outlook.com'
                )
            } catch (err: any) {
                if (err instanceof AccountSuspendedError) {
                    caughtDapiSuspension = true
                }
            }
            assert.strictEqual(caughtDapiSuspension, true, 'Workers.verifyDapiSuspension must throw AccountSuspendedError on 403 with suspended page')
            console.log('✅ Test 4 Passed: Workers checkAccountSuspended & DAPI 403 inspection verified')
        }

        // Test 5: Auto-Quarantine moves session files and writes banned-marker.json
        {
            AccountSessionStore.clearSuspendedAccountsCache()
            const accountEmail = 'suspended_user_test@outlook.com'
            const storageKey = SessionPathResolver.getStorageKey(accountEmail)

            const mobileFile = path.join(testDir, `${storageKey}.mobile.storageState.json`)
            const desktopFile = path.join(testDir, `${storageKey}.desktop.storageState.json`)
            const deviceFile = path.join(testDir, `${storageKey}.deviceProfile.json`)

            fs.writeFileSync(mobileFile, JSON.stringify({ cookies: ['mobile_cookie'] }))
            fs.writeFileSync(desktopFile, JSON.stringify({ cookies: ['desktop_cookie'] }))
            fs.writeFileSync(deviceFile, JSON.stringify({ device: 'Pixel 7' }))

            assert.strictEqual(fs.existsSync(mobileFile), true)
            assert.strictEqual(fs.existsSync(desktopFile), true)
            assert.strictEqual(fs.existsSync(deviceFile), true)

            // Trigger auto-quarantine
            const quarantineResult = await AccountSessionStore.quarantineSuspendedAccount(
                testDir,
                accountEmail,
                'Account banned by Microsoft terms of service violation'
            )
            assert.strictEqual(quarantineResult.movedFiles.length, 3, 'Must have moved 3 session files')

            // Verify files were MOVED (no longer in testDir root)
            assert.strictEqual(fs.existsSync(mobileFile), false, 'mobile.storageState.json must be removed from sessionDir')
            assert.strictEqual(fs.existsSync(desktopFile), false, 'desktop.storageState.json must be removed from sessionDir')
            assert.strictEqual(fs.existsSync(deviceFile), false, 'deviceProfile.json must be removed from sessionDir')

            // Verify files are inside quarantine subdirectory
            const quarantineDir = path.join(testDir, 'quarantine')
            assert.strictEqual(fs.existsSync(path.join(quarantineDir, `${storageKey}.mobile.storageState.json`)), true)
            assert.strictEqual(fs.existsSync(path.join(quarantineDir, `${storageKey}.desktop.storageState.json`)), true)
            assert.strictEqual(fs.existsSync(path.join(quarantineDir, `${storageKey}.deviceProfile.json`)), true)

            // Verify banned-marker.json
            const markerPath = path.join(quarantineDir, 'banned-marker.json')
            assert.strictEqual(fs.existsSync(markerPath), true, 'banned-marker.json must exist in quarantineDir')
            const markerRaw = fs.readFileSync(markerPath, 'utf-8')
            const markerJson = JSON.parse(markerRaw)
            const targetEntry = Array.isArray(markerJson)
                ? markerJson.find(m => m.accountId === accountEmail)
                : markerJson
            assert.ok(targetEntry, 'banned-marker.json must contain target account entry')
            assert.strictEqual(targetEntry.status, 'SUSPENDED')
            assert.strictEqual(targetEntry.accountId, accountEmail)
            assert.ok(targetEntry.date)
            assert.ok(targetEntry.reason.includes('violation'))

            // Verify isAccountSuspended check
            assert.strictEqual(
                AccountSessionStore.isAccountSuspended(testDir, accountEmail),
                true,
                'AccountSessionStore.isAccountSuspended must return true'
            )
            console.log('✅ Test 5 Passed: Auto-quarantine session file relocation & banned marker verified')
        }

        // Test 6: Fast-Fail Bailout and instant skip in executeAccountScopeWorkflow
        {
            AccountSessionStore.clearSuspendedAccountsCache()
            const bot = new MicrosoftRewardsBot()
            bot.config.sessionPath = testDir

            const suspendedAccount: Account = {
                email: 'banned_fastfail@outlook.com',
                password: 'password123',
                recoveryEmail: 'rec@outlook.com',
                geoLocale: 'auto',
                langCode: 'en',
                proxy: { proxyAxios: false, url: '', port: 0, password: '', username: '' },
                saveFingerprint: { mobile: true, desktop: true }
            }

            // Pre-quarantine this account
            await AccountSessionStore.quarantineSuspendedAccount(
                testDir,
                suspendedAccount.email,
                'Pre-quarantined banned account'
            )

            // Verify executeAccountScopeWorkflow exits immediately without launching browser
            const startTime = Date.now()
            const result = await bot.executeAccountScopeWorkflow(suspendedAccount)
            const elapsed = Date.now() - startTime

            assert.ok(elapsed < 1000, `Fast-fail execution must finish in < 1000ms (took ${elapsed}ms)`)
            assert.ok(result !== null)
            assert.strictEqual(result?.success, false)
            assert.strictEqual(result?.error, 'Account Suspended')
            console.log('✅ Test 6 Passed: Instant fast-fail bailout for quarantined accounts verified')
        }

        console.log('🎉 ALL 6 ACCOUNT SUSPENSION & AUTO-QUARANTINE TESTS PASSED SUCCESSFULLY!')
    } finally {
        AccountSessionStore.clearSuspendedAccountsCache()
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true })
        }
    }
}

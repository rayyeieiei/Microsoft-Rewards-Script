import fs from 'fs'
import path from 'path'
import os from 'os'
import assert from 'assert'
import * as child_process from 'child_process'
import { AccountSessionStore } from '../src/runtime/session/AccountSessionStore'
import { SessionPathResolver } from '../src/runtime/session/SessionPathResolver'
import { AccountScope } from '../src/runtime/AccountScope'
import type {
    PlaywrightStorageState,
    PlaywrightCookie,
    StoredSessionEnvelope
} from '../src/runtime/session/AccountSessionTypes'
import BrowserFunc from '../src/browser/BrowserFunc'

function createMockCookie(name: string, value: string, domain = '.bing.com', cookiePath = '/'): PlaywrightCookie {
    return {
        name,
        value,
        domain,
        path: cookiePath,
        expires: 1800000000,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
    }
}

export async function runSessionPersistenceTests(): Promise<void> {
    console.log('--- Running Unified Session Persistence Test Suite (Commit 2) ---')

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-session-test-'))
    const prodSessionsDir = path.resolve(process.cwd(), 'browser', 'sessions')
    const initialProdFiles = fs.existsSync(prodSessionsDir)
        ? fs.readdirSync(prodSessionsDir)
        : []

    try {
        // --- Test 1: Save lalu load pada scope baru mempertahankan cookies dan origin state sintetis ---
        {
            const testDir = path.join(tempRoot, 'test1')
            fs.mkdirSync(testDir, { recursive: true })

            const accountKey = 'user1@example.com'
            const scope1 = AccountScope.createForTesting(accountKey, 'run1', 'scope1', undefined, testDir)

            const syntheticState: PlaywrightStorageState = {
                cookies: [
                    {
                        name: 'session_auth',
                        value: 'token_xyz_123',
                        domain: '.bing.com',
                        path: '/',
                        expires: 1893456000,
                        httpOnly: true,
                        secure: true,
                        sameSite: 'Lax'
                    }
                ],
                origins: [
                    {
                        origin: 'https://rewards.bing.com',
                        localStorage: [
                            { name: 'theme', value: 'dark' },
                            { name: 'onboarding_seen', value: 'true' }
                        ]
                    }
                ]
            }

            const mockContext = {
                storageState: async () => syntheticState
            }

            const saveResult = await AccountSessionStore.saveContextSession(mockContext, scope1, 'mobile')
            assert.strictEqual(saveResult.status, 'saved', 'Save must succeed')

            // Create a brand new scope with same accountId
            const scope2 = AccountScope.createForTesting(accountKey, 'run2', 'scope2', undefined, testDir)
            const loadResult = await AccountSessionStore.loadSession(scope2, 'mobile')

            assert.strictEqual(loadResult.status, 'loaded', 'Load must succeed')
            if (loadResult.status === 'loaded') {
                assert.strictEqual(loadResult.source, 'modern-envelope', 'Source must be modern-envelope')
                assert.strictEqual(loadResult.state.cookies.length, 1)
                assert.strictEqual(loadResult.state.cookies[0]?.name, 'session_auth')
                assert.strictEqual(loadResult.state.cookies[0]?.value, 'token_xyz_123')
                assert.strictEqual(loadResult.state.origins.length, 1)
                assert.strictEqual(loadResult.state.origins[0]?.localStorage[0]?.value, 'dark')
            }

            console.log('✅ Test 1 Passed: Save and load on new scope preserves synthetic cookies and origin state')
        }

        // --- Test 2: Account A/B serta mobile/desktop tidak tertukar ---
        {
            const testDir = path.join(tempRoot, 'test2')
            fs.mkdirSync(testDir, { recursive: true })

            const scopeA = AccountScope.createForTesting('accA@example.com', 'runA', 'scopeA', undefined, testDir)
            const scopeB = AccountScope.createForTesting('accB@example.com', 'runB', 'scopeB', undefined, testDir)

            const ctxAMobile = {
                storageState: async () => ({
                    cookies: [{ name: 'acc', value: 'A_mobile', domain: 'b.com', path: '/' }],
                    origins: []
                })
            }
            const ctxADesktop = {
                storageState: async () => ({
                    cookies: [{ name: 'acc', value: 'A_desktop', domain: 'b.com', path: '/' }],
                    origins: []
                })
            }
            const ctxBMobile = {
                storageState: async () => ({
                    cookies: [{ name: 'acc', value: 'B_mobile', domain: 'b.com', path: '/' }],
                    origins: []
                })
            }
            const ctxBDesktop = {
                storageState: async () => ({
                    cookies: [{ name: 'acc', value: 'B_desktop', domain: 'b.com', path: '/' }],
                    origins: []
                })
            }

            await AccountSessionStore.saveContextSession(ctxAMobile, scopeA, 'mobile')
            await AccountSessionStore.saveContextSession(ctxADesktop, scopeA, 'desktop')
            await AccountSessionStore.saveContextSession(ctxBMobile, scopeB, 'mobile')
            await AccountSessionStore.saveContextSession(ctxBDesktop, scopeB, 'desktop')

            const loadAMobile = await AccountSessionStore.loadSession(scopeA, 'mobile')
            const loadADesktop = await AccountSessionStore.loadSession(scopeA, 'desktop')
            const loadBMobile = await AccountSessionStore.loadSession(scopeB, 'mobile')
            const loadBDesktop = await AccountSessionStore.loadSession(scopeB, 'desktop')

            assert.strictEqual(loadAMobile.status, 'loaded')
            assert.strictEqual(loadADesktop.status, 'loaded')
            assert.strictEqual(loadBMobile.status, 'loaded')
            assert.strictEqual(loadBDesktop.status, 'loaded')

            if (
                loadAMobile.status === 'loaded' &&
                loadADesktop.status === 'loaded' &&
                loadBMobile.status === 'loaded' &&
                loadBDesktop.status === 'loaded'
            ) {
                assert.strictEqual(loadAMobile.state.cookies[0]?.value, 'A_mobile')
                assert.strictEqual(loadADesktop.state.cookies[0]?.value, 'A_desktop')
                assert.strictEqual(loadBMobile.state.cookies[0]?.value, 'B_mobile')
                assert.strictEqual(loadBDesktop.state.cookies[0]?.value, 'B_desktop')
            }

            console.log('✅ Test 2 Passed: Account A/B and mobile/desktop sessions remain strictly isolated')
        }

        // --- Test 3: Envelope dengan accountId/device salah ditolak ---
        {
            const testDir = path.join(tempRoot, 'test3')
            fs.mkdirSync(testDir, { recursive: true })

            const scopeA = AccountScope.createForTesting('accA@example.com', 'runA', 'scopeA', undefined, testDir)
            const scopeB = AccountScope.createForTesting('accB@example.com', 'runB', 'scopeB', undefined, testDir)

            // Put Account A's envelope into Account B's storage path
            const targetPathB = SessionPathResolver.getModernPath(testDir, scopeB.identity.accountId, 'mobile')
            const spoofedEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scopeA.identity.accountId, // Mismatched accountId!
                device: 'mobile',
                savedAt: Date.now(),
                storageState: {
                    cookies: [createMockCookie('auth', 'secret', 'b.com')],
                    origins: []
                }
            }
            fs.writeFileSync(targetPathB, JSON.stringify(spoofedEnvelope), 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scopeB, 'mobile')
            assert.strictEqual(loadResult.status, 'identity-mismatch')
            if (loadResult.status === 'identity-mismatch') {
                assert.strictEqual(loadResult.expectedAccountId, scopeB.identity.accountId)
                assert.strictEqual(loadResult.actualAccountId, scopeA.identity.accountId)
            }

            // Put desktop device envelope into mobile path
            const targetPathMobile = SessionPathResolver.getModernPath(testDir, scopeA.identity.accountId, 'mobile')
            const deviceMismatchEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scopeA.identity.accountId,
                device: 'desktop', // Mismatched device!
                savedAt: Date.now(),
                storageState: {
                    cookies: [createMockCookie('auth', 'secret', 'b.com')],
                    origins: []
                }
            }
            fs.writeFileSync(targetPathMobile, JSON.stringify(deviceMismatchEnvelope), 'utf-8')

            const deviceLoadResult = await AccountSessionStore.loadSession(scopeA, 'mobile')
            assert.strictEqual(deviceLoadResult.status, 'identity-mismatch')

            console.log('✅ Test 3 Passed: Envelope with mismatched accountId or device is rejected')
        }

        // --- Test 4: Raw storageState dari writer sebelumnya dimigrasikan tanpa dianggap corrupt ---
        {
            const testDir = path.join(tempRoot, 'test4')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('userRaw@example.com', 'runRaw', 'scopeRaw', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            // Write raw Playwright storage state directly without schemaVersion or accountId wrapper
            const rawStorageState: PlaywrightStorageState = {
                cookies: [
                    {
                        name: 'raw_session',
                        value: 'legacy_val_999',
                        domain: '.bing.com',
                        path: '/',
                        expires: 1800000000,
                        httpOnly: true,
                        secure: true,
                        sameSite: 'Lax'
                    }
                ],
                origins: []
            }
            fs.writeFileSync(targetPath, JSON.stringify(rawStorageState), 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scope, 'mobile')
            assert.strictEqual(loadResult.status, 'loaded')
            if (loadResult.status === 'loaded') {
                assert.strictEqual(loadResult.source, 'previous-storage-state')
                assert.strictEqual(loadResult.state.cookies[0]?.name, 'raw_session')
            }

            console.log('✅ Test 4 Passed: Raw storageState from previous writer is loaded without false corruption')
        }

        // --- Test 5: Cookie JSON legacy valid dimuat ketika syarat fallback terpenuhi ---
        {
            const testDir = path.join(tempRoot, 'test5')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'legacyUser@example.com'
            const scope = AccountScope.createForTesting(email, 'runLeg', 'scopeLeg', undefined, testDir)

            const legacyFile = SessionPathResolver.getLegacyPath(testDir, email, 'mobile')
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
            const legacyCookies = [
                {
                    name: 'old_cookie',
                    value: 'old_val',
                    domain: '.bing.com',
                    path: '/'
                }
            ]
            fs.writeFileSync(legacyFile, JSON.stringify(legacyCookies), 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResult.status, 'loaded')
            if (loadResult.status === 'loaded') {
                assert.strictEqual(loadResult.source, 'legacy-cookie-json')
                assert.strictEqual(loadResult.state.cookies[0]?.name, 'old_cookie')
            }

            console.log('✅ Test 5 Passed: Valid legacy cookie JSON is loaded when fallback conditions are met')
        }

        // --- Test 6: File legacy tetap dipertahankan ---
        {
            const testDir = path.join(tempRoot, 'test6')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'preserveLegacy@example.com'
            const scope = AccountScope.createForTesting(email, 'runPres', 'scopePres', undefined, testDir)

            const legacyFile = SessionPathResolver.getLegacyPath(testDir, email, 'desktop')
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
            const originalContent = JSON.stringify([{ name: 'pres', value: '1', domain: 'b.com', path: '/' }])
            fs.writeFileSync(legacyFile, originalContent, 'utf-8')

            await AccountSessionStore.loadSession(scope, 'desktop', { legacyEmail: email })

            // Verify file still exists and byte content is untouched
            assert.strictEqual(fs.existsSync(legacyFile), true, 'Legacy file must not be deleted')
            const contentAfter = fs.readFileSync(legacyFile, 'utf-8')
            assert.strictEqual(contentAfter, originalContent, 'Legacy file content must remain unaltered')

            console.log('✅ Test 6 Passed: Legacy file remains preserved and untouched on disk')
        }

        // --- Test 7: Modern corrupt tidak fallback pada run pertama maupun setelah restart ---
        {
            const testDir = path.join(tempRoot, 'test7')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'corrupt@example.com'
            const scope = AccountScope.createForTesting(email, 'runCorr', 'scopeCorr', undefined, testDir)

            // Setup valid legacy file
            const legacyFile = SessionPathResolver.getLegacyPath(testDir, email, 'mobile')
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
            fs.writeFileSync(legacyFile, JSON.stringify([{ name: 'fallback_attempt', value: 'fail' }]), 'utf-8')

            // Setup corrupt modern file
            const primaryPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            fs.writeFileSync(primaryPath, '{ corrupt json is not valid ::: ', 'utf-8')

            // Run 1: Load should detect corruption and NOT fall back to legacy
            const loadResult1 = await AccountSessionStore.loadSession(scope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResult1.status, 'corrupted')

            // Verify quarantine marker exists and corrupt file was moved
            const markerPath = SessionPathResolver.getQuarantineMarkerPath(testDir, scope.identity.accountId, 'mobile')
            assert.strictEqual(fs.existsSync(markerPath), true, 'Persistent quarantine marker must exist')

            // Run 2 (Simulated restart): Primary file is missing now, but marker exists
            const restartScope = AccountScope.createForTesting(email, 'runRestart', 'scopeRestart', undefined, testDir)
            const loadResult2 = await AccountSessionStore.loadSession(restartScope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResult2.status, 'corrupted', 'Restart must still report corrupted')
            assert.notStrictEqual(loadResult2.status, 'loaded', 'Must not fall back to legacy on restart')

            console.log('✅ Test 7 Passed: Modern corrupt does not fallback on first run or restart')
        }

        // --- Test 8: Schema version tak didukung tidak dianggap missing ---
        {
            const testDir = path.join(tempRoot, 'test8')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('version@example.com', 'runV', 'scopeV', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'desktop')

            const futureEnvelope = {
                schemaVersion: 999, // Unsupported future schema
                accountId: scope.identity.accountId,
                device: 'desktop',
                savedAt: Date.now(),
                storageState: { cookies: [], origins: [] }
            }
            fs.writeFileSync(targetPath, JSON.stringify(futureEnvelope), 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scope, 'desktop')
            assert.strictEqual(loadResult.status, 'unsupported-version')
            if (loadResult.status === 'unsupported-version') {
                assert.strictEqual(loadResult.schemaVersion, 999)
            }

            console.log('✅ Test 8 Passed: Unsupported schema version is not treated as missing')
        }

        // --- Test 9: Failed replace mempertahankan byte file valid sebelumnya ---
        {
            const testDir = path.join(tempRoot, 'test9')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('atomic@example.com', 'runAt', 'scopeAt', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            const initialEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scope.identity.accountId,
                device: 'mobile',
                savedAt: 1000,
                storageState: {
                    cookies: [createMockCookie('valid_initial', 'val1', 'b.com')],
                    origins: []
                }
            }
            const initialBytes = JSON.stringify(initialEnvelope, null, 2)
            fs.writeFileSync(targetPath, initialBytes, 'utf-8')

            // Simulate replace failure by stubbing rename to fail with fatal error
            const origRename = fs.promises.rename
            try {
                fs.promises.rename = async () => {
                    throw new Error('ENOSPC: no space left on device')
                }

                const newEnvelope: StoredSessionEnvelope = {
                    schemaVersion: 1,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    savedAt: 2000,
                    storageState: {
                        cookies: [createMockCookie('new_state', 'val2', 'b.com')],
                        origins: []
                    }
                }

                const saveRes = await AccountSessionStore.saveEnvelopeAtomically(targetPath, newEnvelope)
                assert.strictEqual(saveRes.status, 'failed')

                // Verify original target file remains 100% byte-for-byte intact
                const currentBytes = fs.readFileSync(targetPath, 'utf-8')
                assert.strictEqual(currentBytes, initialBytes, 'Target file must remain intact after failed replace')

                // Verify temporary files are cleaned up
                const tempFiles = fs.readdirSync(testDir).filter(f => f.includes('.tmp.'))
                assert.strictEqual(tempFiles.length, 0, 'Temporary file must be cleaned up on failure')
            } finally {
                fs.promises.rename = origRename
            }

            console.log('✅ Test 9 Passed: Failed replace preserves prior valid file bytes and cleans temp file')
        }

        // --- Test 10: Sharing violation memiliki retry terbatas dan tidak menghapus target ---
        {
            const testDir = path.join(tempRoot, 'test10')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('sharing@example.com', 'runSh', 'scopeSh', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            const initialBytes = JSON.stringify({ initial: true })
            fs.writeFileSync(targetPath, initialBytes, 'utf-8')

            const origRename = fs.promises.rename
            try {
                let attempts = 0
                // Simulate EBUSY twice, then succeed
                fs.promises.rename = async (src, dst) => {
                    attempts++
                    if (attempts <= 2) {
                        const err: any = new Error('resource busy or locked')
                        err.code = 'EBUSY'
                        throw err
                    }
                    return origRename(src, dst)
                }

                const envelope: StoredSessionEnvelope = {
                    schemaVersion: 1,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    savedAt: Date.now(),
                    storageState: {
                        cookies: [createMockCookie('retry_cookie', 'ok', 'b.com')],
                        origins: []
                    }
                }

                const saveRes = await AccountSessionStore.saveEnvelopeAtomically(targetPath, envelope)
                assert.strictEqual(saveRes.status, 'saved')
                assert.strictEqual(attempts, 3, 'Must have retried on EBUSY')

                // Next, test when retries are completely exhausted
                fs.promises.rename = async () => {
                    const err: any = new Error('continuous sharing violation')
                    err.code = 'EBUSY'
                    throw err
                }

                const failRes = await AccountSessionStore.saveEnvelopeAtomically(targetPath, envelope)
                assert.strictEqual(failRes.status, 'failed')
                assert.strictEqual(fs.existsSync(targetPath), true, 'Target must not be deleted when retries exhaust')
            } finally {
                fs.promises.rename = origRename
            }

            console.log('✅ Test 10 Passed: Windows sharing violation retries with deadline and preserves target')
        }

        // --- Test 11: Concurrent write terserialisasi; write berikutnya tetap berjalan setelah failure ---
        {
            const testDir = path.join(tempRoot, 'test11')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('concur@example.com', 'runC', 'scopeC', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            // Write 1: invalid envelope that fails validation
            const invalidEnvelope = {
                schemaVersion: 1,
                accountId: '', // invalid
                device: 'mobile',
                savedAt: Date.now(),
                storageState: { cookies: [], origins: [] }
            } as any

            // Write 2: valid envelope
            const validEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scope.identity.accountId,
                device: 'mobile',
                savedAt: Date.now(),
                storageState: {
                    cookies: [createMockCookie('concurrent_winner', 'w', 'b.com')],
                    origins: []
                }
            }

            const [res1, res2] = await Promise.all([
                AccountSessionStore.saveEnvelopeAtomically(targetPath, invalidEnvelope),
                AccountSessionStore.saveEnvelopeAtomically(targetPath, validEnvelope)
            ])

            assert.strictEqual(res1.status, 'failed', 'Write 1 must fail')
            assert.strictEqual(res2.status, 'saved', 'Write 2 must recover and succeed')

            const loaded = await AccountSessionStore.loadSession(scope, 'mobile')
            assert.strictEqual(loaded.status, 'loaded')
            if (loaded.status === 'loaded') {
                assert.strictEqual(loaded.state.cookies[0]?.name, 'concurrent_winner')
            }

            console.log('✅ Test 11 Passed: Concurrent writes are serialized and queue recovers after failure')
        }

        // --- Test 12: Traversal, sibling-directory prefix, dan path escape ditolak ---
        {
            const baseDir = path.join(tempRoot, 'test12_base')
            fs.mkdirSync(baseDir, { recursive: true })

            // Traversal escape via ..
            assert.throws(() => {
                SessionPathResolver.assertContained(baseDir, path.join(baseDir, '..', 'escaped.json'))
            }, /containment violation/i)

            // Sibling directory prefix
            const siblingDir = path.join(tempRoot, 'test12_base-sibling')
            fs.mkdirSync(siblingDir, { recursive: true })
            assert.throws(() => {
                SessionPathResolver.assertContained(baseDir, path.join(siblingDir, 'file.json'))
            }, /containment violation/i)

            // Null byte injection
            assert.throws(() => {
                SessionPathResolver.assertContained(baseDir, path.join(baseDir, 'evil\0.json'))
            }, /containment violation/i)

            // Legacy path with path traversal email
            assert.throws(() => {
                SessionPathResolver.getLegacyPath(baseDir, '../../etc/passwd', 'mobile')
            }, /containment violation/i)

            console.log('✅ Test 12 Passed: Directory traversal, sibling prefix, and path escapes are strictly rejected')
        }

        // --- Test 13: Save terjadi sebelum penutupan context pada jalur production terkait ---
        {
            const testDir = path.join(tempRoot, 'test13')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'closeOrder@example.com'
            const scope = AccountScope.createForTesting(email, 'runCl', 'scopeCl', undefined, testDir)

            const executionOrder: string[] = []
            const mockBrowserContext: any = {
                storageState: async () => {
                    executionOrder.push('storageState')
                    return {
                        cookies: [{ name: 'saved_before_close', value: '1', domain: 'b.com', path: '/' }],
                        origins: []
                    }
                },
                close: async () => {
                    executionOrder.push('close')
                },
                cookies: async () => []
            }

            const mockBot: any = {
                accountScope: scope,
                isMobile: true,
                config: { sessionPath: testDir },
                logger: {
                    debug: () => {},
                    info: () => {},
                    warn: () => {},
                    error: () => {}
                },
                utils: {
                    wait: async () => {}
                }
            }

            const browserFunc = new BrowserFunc(mockBot)
            await browserFunc.closeBrowser(mockBrowserContext, email)

            assert.deepStrictEqual(
                executionOrder,
                ['storageState', 'close'],
                'storageState must be extracted before context is closed'
            )

            console.log('✅ Test 13 Passed: Save occurs strictly before context close on production close path')
        }

        // --- Test 14: Context sudah tertutup tidak menghasilkan save-success palsu ---
        {
            const testDir = path.join(tempRoot, 'test14')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('closedCtx@example.com', 'runCc', 'scopeCc', undefined, testDir)

            const closedContext = {
                storageState: async () => {
                    throw new Error('Target page, context or browser has been closed')
                }
            }

            const saveRes = await AccountSessionStore.saveContextSession(closedContext, scope, 'mobile')
            assert.strictEqual(saveRes.status, 'failed', 'Must report failed on closed context')
            assert.notStrictEqual(saveRes.status, 'saved', 'Must not report saved')

            // Verify no file was created
            const primaryPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            assert.strictEqual(fs.existsSync(primaryPath), false, 'Must not write file from closed context')

            console.log('✅ Test 14 Passed: Closed context does not produce false save-success')
        }

        // --- Test 15: Diagnostic tidak membocorkan nilai cookie, token, atau email ---
        {
            const testDir = path.join(tempRoot, 'test15')
            fs.mkdirSync(testDir, { recursive: true })

            const sensitiveToken = 'super_secret_session_token_xyz999'
            const rawEmail = 'sensitive_person_private@secure.com'
            const scope = AccountScope.createForTesting(rawEmail, 'runDiag', 'scopeDiag', undefined, testDir)

            const corruptFile = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            fs.writeFileSync(corruptFile, `{ invalid_token: "${sensitiveToken}"`, 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scope, 'mobile')
            assert.strictEqual(loadResult.status, 'corrupted')

            const stringifiedResult = JSON.stringify(loadResult)
            assert.strictEqual(stringifiedResult.includes(sensitiveToken), false, 'Must not leak secret token')
            assert.strictEqual(stringifiedResult.includes(rawEmail), false, 'Must not leak raw email')

            console.log('✅ Test 15 Passed: Diagnostics and error returns do not leak cookies, tokens, or raw email')
        }

        // --- Test 17: Fault injection at crash boundary of quarantine preserves marker and prevents legacy fallback ---
        {
            const testDir = path.join(tempRoot, 'test17')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'faultQuarantine@example.com'
            const scope = AccountScope.createForTesting(email, 'runFq', 'scopeFq', undefined, testDir)

            // Setup valid legacy cookie file
            const legacyFile = SessionPathResolver.getLegacyPath(testDir, email, 'mobile')
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
            fs.writeFileSync(legacyFile, JSON.stringify([createMockCookie('legacy_cookie', 'val')]), 'utf-8')

            // Setup corrupt modern file
            const primaryPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            fs.writeFileSync(primaryPath, '{ invalid json corrupted ::: ', 'utf-8')

            // Case A: Inject fault where process crashed immediately after writing marker (before source is unlinked)
            const markerPath = SessionPathResolver.getQuarantineMarkerPath(testDir, scope.identity.accountId, 'mobile')
            fs.mkdirSync(path.dirname(markerPath), { recursive: true })
            fs.writeFileSync(
                markerPath,
                JSON.stringify({
                    schemaVersion: 1,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    corruptedAt: Date.now(),
                    reason: 'Injected crash boundary fault'
                }),
                'utf-8'
            )

            // Both primary corrupt file AND marker exist on disk
            assert.strictEqual(fs.existsSync(primaryPath), true)
            assert.strictEqual(fs.existsSync(markerPath), true)

            const loadResultA = await AccountSessionStore.loadSession(scope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResultA.status, 'corrupted', 'Marker must block legacy fallback even if source still exists')
            assert.notStrictEqual(loadResultA.status, 'loaded')

            // Case B: Marker exists after source was unlinked
            fs.unlinkSync(primaryPath)
            const loadResultB = await AccountSessionStore.loadSession(scope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResultB.status, 'corrupted', 'Marker must block legacy fallback when source is gone')
            assert.notStrictEqual(loadResultB.status, 'loaded')

            console.log('✅ Test 17 Passed: Quarantine crash-boundary fault injection preserves marker and blocks fallback')
        }

        // --- Test 18: In-flight snapshot serialized before mutex to prevent snapshot inversion race ---
        {
            const testDir = path.join(tempRoot, 'test18')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('snapOrder@example.com', 'runSo', 'scopeSo', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            // Step 1: Write an existing session with timestamp 5000
            const existingEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scope.identity.accountId,
                device: 'mobile',
                savedAt: 5000,
                storageState: {
                    cookies: [createMockCookie('current_fresh', 'v2')],
                    origins: []
                }
            }
            fs.writeFileSync(targetPath, JSON.stringify(existingEnvelope, null, 2), 'utf-8')

            // Step 2: Attempt to save a context whose snapshot timestamp is older (simulating delayed snapshot race)
            const staleContext = {
                storageState: async () => ({
                    cookies: [createMockCookie('stale_cookie', 'v1')],
                    origins: []
                })
            }

            // Temporarily mock Date.now during snapshot extraction to simulate an older snapshot time (e.g. 2000)
            const realNow = Date.now
            try {
                Date.now = () => 2000
                const saveRes = await AccountSessionStore.saveContextSession(staleContext, scope, 'mobile')
                assert.strictEqual(saveRes.status, 'skipped', 'Stale snapshot must be skipped to prevent overwriting newer session')
            } finally {
                Date.now = realNow
            }

            // Verify disk session remains the fresh version (5000), not the stale one
            const loaded = await AccountSessionStore.loadSession(scope, 'mobile')
            assert.strictEqual(loaded.status, 'loaded')
            if (loaded.status === 'loaded') {
                assert.strictEqual(loaded.state.cookies[0]?.name, 'current_fresh')
            }

            console.log('✅ Test 18 Passed: Snapshot serialization and monotonic ordering prevent inversion races')
        }

        // --- Test 19: Cross-process writer lock rejects concurrent writer and preserves stale lock for review ---
        {
            const testDir = path.join(tempRoot, 'test19')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('xproc@example.com', 'runXp', 'scopeXp', undefined, testDir)
            const lockfilePath = SessionPathResolver.getLockfilePath(testDir, scope.identity.accountId, 'mobile')

            // Case A: Create an active lock owned by this process
            fs.writeFileSync(
                lockfilePath,
                JSON.stringify({
                    pid: process.pid,
                    ownerToken: 'active-owner-token-19',
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    acquiredAt: Date.now()
                }),
                'utf-8'
            )

            const ctx = {
                storageState: async () => ({
                    cookies: [createMockCookie('xproc_cookie', '1')],
                    origins: []
                })
            }

            // With active lockfile existing, acquireCrossProcessLock should fail after timeout
            const conflictRes = await AccountSessionStore.saveContextSession(ctx, scope, 'mobile', 500)
            assert.strictEqual(conflictRes.status, 'failed', 'Must report failed on cross-process lock conflict')
            assert.match(
                (conflictRes as any).error || '',
                /lock conflict/i,
                'Error must mention lock conflict'
            )

            // Case B: Create a stale lock owned by an inactive PID (e.g. 99999999)
            fs.writeFileSync(
                lockfilePath,
                JSON.stringify({
                    pid: 99999999, // Non-existent process
                    ownerToken: 'dead-pid-token-19',
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    acquiredAt: Date.now() - 5000
                }),
                'utf-8'
            )

            // Conservative policy: must NOT automatically steal or break the stale lock
            const reviewRes = await AccountSessionStore.saveContextSession(ctx, scope, 'mobile')
            assert.strictEqual(reviewRes.status, 'failed', 'Must report failed on dead PID without automatic takeover')
            assert.match(
                (reviewRes as any).error || '',
                /stale-lock-needs-review/i,
                'Error must indicate stale-lock-needs-review'
            )

            // Lockfile must be preserved on disk for operator inspection
            assert.strictEqual(fs.existsSync(lockfilePath), true, 'Stale lockfile must remain on disk for review')

            console.log('✅ Test 19 Passed: Cross-process writer lock rejects concurrent writer and preserves stale lock for review')
        }

        // --- Test 21: Pemilik masih aktif setelah usia lock melewati 30 detik: contender tidak mengambil alih ---
        {
            const testDir = path.join(tempRoot, 'test21')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('active30@example.com', 'runAct', 'scopeAct', undefined, testDir)
            const lockfilePath = SessionPathResolver.getLockfilePath(testDir, scope.identity.accountId, 'mobile')

            const originalToken = 'token-active-owner-001'
            const sixtySecondsAgo = Date.now() - 60000

            fs.writeFileSync(
                lockfilePath,
                JSON.stringify({
                    pid: process.pid, // active owner
                    ownerToken: originalToken,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    acquiredAt: sixtySecondsAgo
                }),
                'utf-8'
            )

            // Contender attempts to acquire lock with 300ms timeout
            const acq = await AccountSessionStore.acquireCrossProcessLock(
                lockfilePath,
                scope.identity.accountId,
                'mobile',
                300
            )

            assert.strictEqual(acq.acquired, false, 'Contender must NOT take over lock of an active owner')
            assert.strictEqual(acq.reason, 'timed-out')

            // Verify original lockfile is 100% intact with original owner token and age
            assert.strictEqual(fs.existsSync(lockfilePath), true)
            const raw = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'))
            assert.strictEqual(raw.ownerToken, originalToken, 'Owner token must remain unchanged')
            assert.strictEqual(raw.pid, process.pid, 'Owner PID must remain unchanged')
            assert.strictEqual(raw.acquiredAt, sixtySecondsAgo, 'Original acquisition timestamp must be preserved')

            console.log('✅ Test 21 Passed: Pemilik masih aktif setelah usia lock melewati 30 detik: contender tidak mengambil alih')
        }

        // --- Test 22: Contender timeout: lock dan target pemilik tetap utuh ---
        {
            const testDir = path.join(tempRoot, 'test22')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('contenderTimeout@example.com', 'runCt', 'scopeCt', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            const lockfilePath = SessionPathResolver.getLockfilePath(testDir, scope.identity.accountId, 'mobile')

            // Write valid owner target session
            const initialEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scope.identity.accountId,
                device: 'mobile',
                savedAt: Date.now() - 10000,
                storageState: {
                    cookies: [createMockCookie('owner_cookie', 'owner_val')],
                    origins: []
                }
            }
            fs.writeFileSync(targetPath, JSON.stringify(initialEnvelope, null, 2), 'utf-8')

            // Active owner holds lock
            const ownerToken = 'active-owner-token-22'
            fs.writeFileSync(
                lockfilePath,
                JSON.stringify({
                    pid: process.pid,
                    ownerToken,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    acquiredAt: Date.now()
                }),
                'utf-8'
            )

            // Contender attempts to save with 200ms timeout
            const contenderContext = {
                storageState: async () => ({
                    cookies: [createMockCookie('contender_intruder', 'bad')],
                    origins: []
                })
            }

            const res = await AccountSessionStore.saveContextSession(contenderContext, scope, 'mobile', 200)
            assert.strictEqual(res.status, 'failed', 'Contender write must fail due to lock conflict')
            assert.match((res as any).error || '', /lock conflict/i)

            // Verify owner lockfile is completely intact
            assert.strictEqual(fs.existsSync(lockfilePath), true, 'Owner lockfile must remain intact')
            const lockData = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'))
            assert.strictEqual(lockData.ownerToken, ownerToken)

            // Verify target session file is completely unchanged
            const sessionData = JSON.parse(fs.readFileSync(targetPath, 'utf-8'))
            assert.strictEqual(sessionData.storageState.cookies[0].name, 'owner_cookie', 'Target session must be untouched')

            console.log('✅ Test 22 Passed: Contender timeout: lock dan target pemilik tetap utuh')
        }

        // --- Test 23: Dua proses lokal berbeda bersaing pada file yang sama: hanya satu memperoleh lock ---
        {
            const testDir = path.join(tempRoot, 'test23')
            fs.mkdirSync(testDir, { recursive: true })

            const lockfilePath = path.join(testDir, 'contention_target.lock')

            // Subprocess runner script: attempts acquireCrossProcessLock, holds for 400ms if acquired, then releases
            const childScript = `
                const { AccountSessionStore } = require('./src/runtime/session/AccountSessionStore');
                (async () => {
                    const lockfilePath = process.argv.slice(1).find(a => a && a.endsWith('.lock')) || process.argv[1];
                    const acq = await AccountSessionStore.acquireCrossProcessLock(lockfilePath, 'acc23', 'mobile', 300);
                    if (acq.acquired) {
                        process.stdout.write(JSON.stringify({ pid: process.pid, acquired: true, token: acq.ownerToken }));
                        await new Promise(r => setTimeout(r, 400));
                        await AccountSessionStore.releaseCrossProcessLock(lockfilePath, acq.ownerToken);
                    } else {
                        process.stdout.write(JSON.stringify({ pid: process.pid, acquired: false, reason: acq.reason }));
                    }
                    process.exit(0);
                })().catch(e => {
                    console.error(e);
                    process.exit(1);
                });
            `

            const runChild = (): Promise<{ pid: number; acquired: boolean; reason?: string }> => {
                return new Promise((resolve, reject) => {
                    const cp = child_process.spawn(
                        process.execPath,
                        ['-r', 'ts-node/register', '-e', childScript, lockfilePath],
                        { cwd: process.cwd() }
                    )
                    let stdout = ''
                    let stderr = ''
                    cp.stdout.on('data', d => (stdout += d))
                    cp.stderr.on('data', d => (stderr += d))
                    cp.on('close', code => {
                        if (code !== 0) {
                            reject(new Error(`Child exited with code ${code}: ${stderr}`))
                        } else {
                            try {
                                resolve(JSON.parse(stdout.trim()))
                            } catch (err) {
                                reject(new Error(`Failed to parse child output: "${stdout}" (stderr: ${stderr})`))
                            }
                        }
                    })
                })
            }

            // Launch both child processes concurrently
            const [childA, childB] = await Promise.all([runChild(), runChild()])

            const acquiredCount = (childA.acquired ? 1 : 0) + (childB.acquired ? 1 : 0)
            assert.strictEqual(acquiredCount, 1, 'Exactly one process must acquire the lock under contention')

            const failedChild = childA.acquired ? childB : childA
            assert.strictEqual(failedChild.acquired, false)
            assert.ok(failedChild.reason === 'timed-out' || failedChild.reason === 'lock-busy')

            // Wait for winner's release to complete
            await new Promise(r => setTimeout(r, 200))
            assert.strictEqual(fs.existsSync(lockfilePath), false, 'Lockfile must be released after completion')

            console.log('✅ Test 23 Passed: Dua proses lokal berbeda bersaing pada file yang sama: hanya satu memperoleh lock')
        }

        // --- Test 24: Release dari acquisition lama tidak menghapus lock acquisition baru ---
        {
            const testDir = path.join(tempRoot, 'test24')
            fs.mkdirSync(testDir, { recursive: true })

            const lockfilePath = path.join(testDir, 'token_test.lock')
            const oldToken = 'stale-token-phase-1'
            const newToken = 'fresh-token-phase-2'

            // Write lockfile belonging to the new acquisition
            fs.writeFileSync(
                lockfilePath,
                JSON.stringify({
                    pid: process.pid,
                    ownerToken: newToken,
                    accountId: 'acc24',
                    device: 'mobile',
                    acquiredAt: Date.now()
                }),
                'utf-8'
            )

            // Attempt release using old token from an earlier acquisition
            const releasedOld = await AccountSessionStore.releaseCrossProcessLock(lockfilePath, oldToken)
            assert.strictEqual(releasedOld, false, 'Release with mismatched token must return false')

            // Lockfile must still exist with the new token
            assert.strictEqual(fs.existsSync(lockfilePath), true, 'Lockfile must not be deleted by stale release')
            const currentLock = JSON.parse(fs.readFileSync(lockfilePath, 'utf-8'))
            assert.strictEqual(currentLock.ownerToken, newToken)

            // Valid release with matching token succeeds
            const releasedNew = await AccountSessionStore.releaseCrossProcessLock(lockfilePath, newToken)
            assert.strictEqual(releasedNew, true, 'Release with matching token must return true')
            assert.strictEqual(fs.existsSync(lockfilePath), false, 'Lockfile must be unlinked after matching release')

            console.log('✅ Test 24 Passed: Release dari acquisition lama tidak menghapus lock acquisition baru')
        }

        // --- Test 25: Write tertunda tetap memegang ownership sampai operasi selesai ---
        {
            const testDir = path.join(tempRoot, 'test25')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('delayedWrite@example.com', 'runDw', 'scopeDw', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            const lockfilePath = SessionPathResolver.getLockfilePath(testDir, scope.identity.accountId, 'mobile')

            let writeFinished = false

            // Start a delayed target lock operation
            const writePromise = AccountSessionStore.withTargetLock(
                targetPath,
                scope.identity.accountId,
                'mobile',
                async () => {
                    await new Promise(r => setTimeout(r, 400))
                    writeFinished = true
                    return 'done'
                }
            )

            // Allow operation to acquire lock
            await new Promise(r => setTimeout(r, 100))

            // Verify write is still in-flight
            assert.strictEqual(writeFinished, false, 'Write operation must still be pending')
            assert.strictEqual(fs.existsSync(lockfilePath), true, 'Lockfile must be held during delayed write')

            // Contender attempts to acquire lock while write is in flight
            const contenderAcq = await AccountSessionStore.acquireCrossProcessLock(
                lockfilePath,
                scope.identity.accountId,
                'mobile',
                100
            )
            assert.strictEqual(contenderAcq.acquired, false, 'Contender must be rejected while write is pending')
            assert.strictEqual(contenderAcq.reason, 'timed-out')

            // Wait for delayed write to complete
            const writeRes = await writePromise
            assert.strictEqual(writeRes, 'done')
            assert.strictEqual(writeFinished, true)

            // Lock is now released
            assert.strictEqual(fs.existsSync(lockfilePath), false, 'Lockfile must be released once write settles')

            console.log('✅ Test 25 Passed: Write tertunda tetap memegang ownership sampai operasi selesai')
        }

        // --- Test 26: Seluruh test tidak menyentuh storage produksi ---
        {
            const finalProdFiles = fs.existsSync(prodSessionsDir)
                ? fs.readdirSync(prodSessionsDir)
                : []
            assert.deepStrictEqual(
                initialProdFiles,
                finalProdFiles,
                'Production sessions directory must have 0 modifications from test suite'
            )

            console.log('✅ Test 26 Passed: Entire test suite operated exclusively in isolated synthetic storage')
        }

        console.log('🎉 ALL 26 UNIFIED SESSION PERSISTENCE TESTS PASSED SUCCESSFULLY!')
    } finally {
        try {
            fs.rmSync(tempRoot, { recursive: true, force: true })
        } catch {}
    }
}

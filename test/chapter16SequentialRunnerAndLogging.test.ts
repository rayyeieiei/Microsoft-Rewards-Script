import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { ConfigSchema } from '../src/util/Validator'
import { chunkArrayBySize, waitForManualIpConfirmation, manualIpConfirmResolver, MicrosoftRewardsBot } from '../src/index'
import { Logger } from '../src/logging/Logger'

export async function runChapter16SequentialRunnerAndLoggingTests(): Promise<void> {
    console.log('--- Running Chapter 16 Sequential Runner & Windows Alignment Test Suite ---')

    // Test 1: Validator & ConfigSchema default executionMode is locked to 'sequential'
    {
        const parsed = ConfigSchema.partial().parse({})
        assert.strictEqual(
            parsed.executionMode,
            'sequential',
            "ConfigSchema must default executionMode to 'sequential'"
        )

        const exampleConfigPath = path.resolve(process.cwd(), 'src/config.example.json')
        const exampleConfig = JSON.parse(fs.readFileSync(exampleConfigPath, 'utf-8'))
        assert.strictEqual(
            exampleConfig.executionMode,
            'sequential',
            "src/config.example.json must define executionMode = 'sequential'"
        )

        const configPath = path.resolve(process.cwd(), 'config.json')
        if (fs.existsSync(configPath)) {
            const runtimeConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            assert.strictEqual(
                runtimeConfig.executionMode,
                'sequential',
                "config.json must define executionMode = 'sequential'"
            )
        }

        console.log("✅ Test 1 Passed: Configuration schemas lock executionMode default to 'sequential'")
    }

    // Test 2: chunkArrayBySize partitions accounts in batches of at most 2
    {
        const accounts5 = [
            { email: 'acc1@test.com' },
            { email: 'acc2@test.com' },
            { email: 'acc3@test.com' },
            { email: 'acc4@test.com' },
            { email: 'acc5@test.com' }
        ] as any[]

        const chunks = chunkArrayBySize(accounts5, 2)
        assert.strictEqual(chunks.length, 3, '5 accounts must be divided into 3 batches')
        assert.strictEqual(chunks[0]?.length, 2, 'Batch 1 must contain 2 accounts')
        assert.strictEqual(chunks[1]?.length, 2, 'Batch 2 must contain 2 accounts')
        assert.strictEqual(chunks[2]?.length, 1, 'Batch 3 must contain 1 account')
        assert.strictEqual(chunks[0]?.[0]?.email, 'acc1@test.com')
        assert.strictEqual(chunks[0]?.[1]?.email, 'acc2@test.com')
        assert.strictEqual(chunks[1]?.[0]?.email, 'acc3@test.com')
        assert.strictEqual(chunks[2]?.[0]?.email, 'acc5@test.com')

        // Empty and single edge cases
        assert.deepStrictEqual(chunkArrayBySize([], 2), [])
        const singleChunk = chunkArrayBySize([{ email: 'acc1@test.com' }] as any[], 2)
        assert.strictEqual(singleChunk.length, 1)
        assert.strictEqual(singleChunk[0]?.length, 1)

        console.log('✅ Test 2 Passed: chunkArrayBySize cleanly partitions accounts into batches of 2')
    }

    // Test 3: Logger header tag formatting: [MAIN] on idle vs [username] on active account
    {
        // 1. Idle state -> header is [MAIN]
        const idleBot = {
            userData: { userName: '' },
            activeAccount: null,
            config: { debugLogs: false, webhook: {} },
            utils: { getEmailUsername: (e: string) => e.split('@')[0] }
        } as any

        const idleLogger = new Logger(idleBot)
        let capturedConsole = ''
        const originalConsoleLog = console.log
        console.log = (msg: string) => {
            capturedConsole = msg
        }

        try {
            idleLogger.info('main', 'TEST-IDLE', 'Bot standby waiting for commands')
            assert.ok(capturedConsole.includes('[MAIN]'), 'Idle logger must display [MAIN] in console header tag')
            assert.ok(capturedConsole.includes('Bot standby waiting for commands'))

            // 2. Active account state -> header is [miliani9714121991]
            const activeBot = {
                userData: { userName: 'miliani9714121991' },
                activeAccount: { email: 'miliani9714121991@outlook.com' },
                config: { debugLogs: false, webhook: {} },
                utils: { getEmailUsername: (e: string) => e.split('@')[0] }
            } as any

            const activeLogger = new Logger(activeBot)
            capturedConsole = ''
            activeLogger.info(
                'main',
                'TEST-ACTIVE',
                'Starting workflow for miliani9714121991@outlook.com with code=secret_auth_code_123'
            )

            // Header tag must be username (not [MAIN] and not full email)
            assert.ok(
                capturedConsole.includes('[miliani9714121991]'),
                'Active logger must display [miliani9714121991] in header tag'
            )
            assert.strictEqual(
                capturedConsole.includes('[MAIN]'),
                false,
                'Active logger must not fall back to [MAIN] tag'
            )

            // Email in body remains unmasked without asterisks
            assert.ok(
                capturedConsole.includes('miliani9714121991@outlook.com'),
                'Console message body must keep email unmasked'
            )

            // Sensitive OAuth token must be redacted
            assert.strictEqual(
                capturedConsole.includes('secret_auth_code_123'),
                false,
                'OAuth code must be strictly redacted in console output'
            )
            assert.ok(capturedConsole.includes('code=[REDACTED]'))

            // 3. Active account fallback derived from email if userName empty
            const fallbackBot = {
                userData: { userName: '' },
                activeAccount: { email: 'fynleyhershell799@outlook.com' },
                config: { debugLogs: false, webhook: {} },
                utils: { getEmailUsername: (e: string) => e.split('@')[0] }
            } as any
            const fallbackLogger = new Logger(fallbackBot)
            capturedConsole = ''
            fallbackLogger.info('main', 'TEST-FALLBACK', 'Searching Bing queries')
            assert.ok(
                capturedConsole.includes('[fynleyhershell799]'),
                'Active account without explicit userName must derive tag [fynleyhershell799] from email'
            )
        } finally {
            console.log = originalConsoleLog
        }

        console.log('✅ Test 3 Passed: Logger console header tag precisely binds active username and [MAIN]')
    }

    // Test 4: WorkerBot instantiates distinct Logger instance bound to itself
    {
        const parentBot = new MicrosoftRewardsBot()
        parentBot.userData.userName = ''
        parentBot.activeAccount = null

        const workerBot = new MicrosoftRewardsBot(parentBot)
        workerBot.userData.userName = 'canttakeaway36'
        workerBot.activeAccount = { email: 'canttakeaway36@outlook.com' } as any

        assert.notStrictEqual(
            parentBot.logger,
            workerBot.logger,
            'WorkerBot must instantiate its own Logger instance independent of parentBot'
        )

        let parentCaptured = ''
        let workerCaptured = ''
        const originalConsoleLog = console.log
        try {
            console.log = (msg: string) => {
                if (msg.includes('PARENT_LOG')) parentCaptured = msg
                if (msg.includes('WORKER_LOG')) workerCaptured = msg
            }

            parentBot.logger.info('main', 'TEST', 'PARENT_LOG')
            workerBot.logger.info('main', 'TEST', 'WORKER_LOG')

            assert.ok(parentCaptured.includes('[MAIN]'), 'ParentBot logger must emit [MAIN]')
            assert.ok(workerCaptured.includes('[canttakeaway36]'), 'WorkerBot logger must emit [canttakeaway36]')
        } finally {
            console.log = originalConsoleLog
        }

        console.log('✅ Test 4 Passed: WorkerBot Logger isolation successfully separates worker tags from parent')
    }

    // Test 5: waitForManualIpConfirmation resolves cleanly on dashboard/operator confirmation
    {
        let resolved = false
        const confirmPromise = waitForManualIpConfirmation().then(() => {
            resolved = true
        })

        assert.ok(manualIpConfirmResolver, 'manualIpConfirmResolver must be registered while waiting')

        // Simulate operator clicking "Confirm IP Rotated" on Dashboard
        manualIpConfirmResolver()

        await confirmPromise
        assert.strictEqual(resolved, true, 'waitForManualIpConfirmation must resolve upon operator confirmation')
        assert.strictEqual(manualIpConfirmResolver, null, 'manualIpConfirmResolver must be cleared after resolution')

        console.log('✅ Test 5 Passed: waitForManualIpConfirmation resolves cleanly without looping timeouts')
    }

    // Test 6: Circuit Breaker isolation for sequential mode & actualProcessedCount in onBatchComplete
    {
        const parentBot = new MicrosoftRewardsBot()
        parentBot.config.executionMode = 'sequential'
        parentBot.searchCooldownActive = true
        parentBot.batchCircuitBreakerTriggered = true

        // 1. In sequential mode, resetAccountState must clear searchCooldownActive and batchCircuitBreakerTriggered
        parentBot.resetAccountState()
        assert.strictEqual(parentBot.searchCooldownActive, false, 'searchCooldownActive must be reset to false')
        assert.strictEqual(parentBot.batchCircuitBreakerTriggered, false, 'batchCircuitBreakerTriggered must be reset to false in sequential mode')

        // 2. In dual mode, batchCircuitBreakerTriggered is preserved across account resets
        const dualBot = new MicrosoftRewardsBot()
        dualBot.config.executionMode = 'dual'
        dualBot.batchCircuitBreakerTriggered = true
        dualBot.resetAccountState()
        assert.strictEqual(dualBot.batchCircuitBreakerTriggered, true, 'dual mode preserves circuit breaker across account reset')

        // 3. onBatchComplete logs actualProcessedCount instead of static batch.length
        let capturedLog = ''
        const origWarn = parentBot.logger.warn.bind(parentBot.logger)
        parentBot.logger.warn = ((isMobile: any, header: string, msg: string, color?: any) => {
            if (typeof msg === 'string' && msg.includes('SELESAI')) capturedLog = msg
        }) as any

        ;(parentBot as any).getCurrentIP = async () => '1.2.3.4'
        const resolverTimer = setInterval(() => {
            if (typeof manualIpConfirmResolver === 'function') {
                (manualIpConfirmResolver as () => void)()
            }
        }, 20)

        try {
            await (parentBot as any).onBatchComplete(
                0,
                [{ email: 'acc1@test.com' }, { email: 'acc2@test.com' }],
                2,
                1
            )
        } finally {
            clearInterval(resolverTimer)
            parentBot.logger.warn = origWarn
        }

        assert.ok(
            capturedLog.includes('(1 akun diproses)'),
            `Expected log to contain "(1 akun diproses)", got: "${capturedLog}"`
        )

        console.log('✅ Test 6 Passed: Circuit breaker isolated in sequential mode & onBatchComplete logs actual count')
    }

    console.log('🎉 ALL 6 CHAPTER 16 SEQUENTIAL RUNNER & WINDOWS ALIGNMENT TESTS PASSED SUCCESSFULLY!')
}
